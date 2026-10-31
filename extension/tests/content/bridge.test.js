// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { editorText, getBridgeLang, getBridgeText, setBridgeText } from '../../src/adapters/shared.js';
import { requestBridge } from '../../src/content/bridge.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const bridgeMainSource = readFileSync(path.join(root, 'src/content/bridge-main.js'), 'utf8');

const EMPTY = { monaco: null, ace: null, at: 0 };
let realPostMessage;

beforeEach(() => {
  setBridgeText(EMPTY);
  realPostMessage = window.postMessage;
});

afterEach(() => {
  setBridgeText(EMPTY);
  window.postMessage = realPostMessage;
  document.body.innerHTML = '';
  // Each window.eval(bridgeMainSource) leaves a permanent message listener
  // that reads these globals; clear them so a later test never sees a prior
  // test's editors (jsdom delete can leave the property visible to handlers).
  window.monaco = null;
  window.ace = null;
});

describe('bridge text cache (isolated side)', () => {
  it('prefers full Monaco text over viewport lines', () => {
    document.body.innerHTML =
      '<div class="monaco-editor"><div class="view-lines">' +
      '<div class="view-line">def solve():</div></div></div>';
    const el = document.querySelector('.monaco-editor');
    // Without the bridge: DOM extraction (what the page happens to render).
    expect(editorText(el)).toBe('def solve():');
    // With the bridge: complete model text, even for off-screen lines.
    setBridgeText({ monaco: 'def solve():\n    return 1\n# tail', at: Date.now() });
    expect(editorText(el)).toBe('def solve():\n    return 1\n# tail');
  });

  it('prefers full ACE text over rendered ace_line rows', () => {
    document.body.innerHTML =
      '<div class="ace_editor"><div class="ace_content"><div class="ace_line">x = 1</div></div></div>';
    const el = document.querySelector('.ace_editor');
    expect(editorText(el)).toBe('x = 1');
    setBridgeText({ ace: 'x = 1\ny = 2\nz = 3', at: Date.now() });
    expect(editorText(el)).toBe('x = 1\ny = 2\nz = 3');
  });

  it('does not touch textareas or non-editor elements', () => {
    document.body.innerHTML = '<textarea id="paste">while True: pass</textarea><div id="other">plain</div>';
    setBridgeText({ monaco: 'ignored', ace: 'ignored', at: Date.now() });
    expect(editorText(document.querySelector('#paste'))).toBe('while True: pass');
    expect(editorText(document.querySelector('#other'))).toBe('plain');
  });

  it('stores empty bridge results as null (falls back to DOM)', () => {
    setBridgeText({ monaco: '', ace: '', monacoLang: '', aceLang: '', at: Date.now() });
    expect(getBridgeText().monaco).toBeNull();
    expect(getBridgeText().ace).toBeNull();
    expect(getBridgeText().monacoLang).toBeNull();
    expect(getBridgeLang()).toBeNull();
    setBridgeText({ monaco: null, ace: null });
    expect(getBridgeText().monaco).toBeNull();
  });
});

describe('requestBridge protocol', () => {
  it('resolves true and stores text on a matching response', async () => {
    const posted = [];
    window.postMessage = (data) => posted.push(data);
    const promise = requestBridge(1000);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ source: 'codesync-bridge', type: 'request' });
    expect(typeof posted[0].id).toBe('number');
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          source: 'codesync-bridge',
          type: 'response',
          id: posted[0].id,
          monaco: 'full monaco',
          ace: null,
          monacoLang: 'python3',
          aceLang: null,
        },
        source: window,
      }),
    );
    await expect(promise).resolves.toBe(true);
    expect(getBridgeText().monaco).toBe('full monaco');
    expect(getBridgeText().monacoLang).toBe('python3');
    expect(getBridgeLang()).toBe('Python3');
  });

  it('ignores responses with a foreign id', async () => {
    const posted = [];
    window.postMessage = (data) => posted.push(data);
    const promise = requestBridge(30);
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { source: 'codesync-bridge', type: 'response', id: posted[0].id + 999, monaco: 'stale' },
        source: window,
      }),
    );
    await expect(promise).resolves.toBe(false);
    expect(getBridgeText().monaco).toBeNull();
  });

  it('resolves false when the page-world bridge is unavailable', async () => {
    window.postMessage = () => {};
    await expect(requestBridge(20)).resolves.toBe(false);
  });
});

describe('page-world bridge (bridge-main.js)', () => {
  // Eval the page-world script exactly once for this suite. Each eval registers
  // another permanent message listener, so re-evaling per test makes earlier
  // handlers answer later requests with stale editor globals.
  let evalDone = false;
  function ensureBridgeEvaluated() {
    if (evalDone) return;
    window.eval(bridgeMainSource);
    evalDone = true;
  }

  function requestOnce(id) {
    return new Promise((resolve) => {
      const onMessage = (event) => {
        const data = event.data;
        if (
          data &&
          data.source === 'codesync-bridge' &&
          data.type === 'response' &&
          data.id === id
        ) {
          window.removeEventListener('message', onMessage);
          resolve(data);
        }
      };
      window.addEventListener('message', onMessage);
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { source: 'codesync-bridge', type: 'request', id },
          source: window,
        }),
      );
    });
  }

  it('answers requests with full Monaco model and ACE editor text', async () => {
    // Stub the page's editor globals exactly as LeetCode/GFG would expose them.
    window.monaco = {
      editor: {
        getModels: () => [
          { getValue: () => '', getLanguage: () => 'java' },
          {
            getValue: () => 'def solve():\n    return 42\n# lines past the viewport',
            getLanguage: () => 'python3',
          },
        ],
      },
    };
    document.body.innerHTML =
      '<div class="ace_editor" id="editor"><div class="ace_content"></div></div>';
    document.querySelector('#editor').env = {
      editor: {
        getValue: () => 'print(1)\nprint(2)',
        getSession: () => ({ getMode: () => ({ $id: 'ace/mode/python' }) }),
      },
    };

    ensureBridgeEvaluated();
    const response = await requestOnce(42);
    expect(response.id).toBe(42);
    expect(response.monaco).toBe('def solve():\n    return 42\n# lines past the viewport');
    expect(response.ace).toBe('print(1)\nprint(2)');
    // Language rides along with the chosen (highest-scoring code) model, and
    // the ACE mode id is reduced to its bare segment.
    expect(response.monacoLang).toBe('python3');
    expect(response.aceLang).toBe('python');
  });

  it('prefers the solution model over a longer test-case input model', async () => {
    // LeetCode registers a second Monaco model for the *test-case input*
    // (plaintext/json). It can be longer than a short solution; scoring must
    // still pick the real code model so we never push `[123,45]\n1` to GitHub.
    window.monaco = {
      editor: {
        getModels: () => [
          {
            getValue: () =>
              '[123,45]\n1\n[102,90,14]\n2\n[999,999]\n3\n[1,2,3,4,5,6,7,8,9,10]\n10\n[50,60]\n4',
            getLanguage: () => 'plaintext',
          },
          {
            getValue: () => 'class Solution:\n    def minSum(self, nums, k):\n        return sum(nums)',
            getLanguage: () => 'python3',
          },
        ],
      },
    };
    document.body.innerHTML = '';

    ensureBridgeEvaluated();
    const response = await requestOnce(44);
    expect(response.monaco).toContain('class Solution:');
    expect(response.monaco).not.toContain('[123,45]');
    expect(response.monacoLang).toBe('python3');
  });

  it('returns nulls instead of throwing when editors are missing', async () => {
    window.monaco = null;
    window.ace = null;
    ensureBridgeEvaluated();
    const response = await requestOnce(43);
    expect(response.monaco).toBeNull();
    expect(response.ace).toBeNull();
    expect(response.monacoLang).toBeNull();
    expect(response.aceLang).toBeNull();
  });
});
