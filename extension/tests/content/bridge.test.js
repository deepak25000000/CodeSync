// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { editorText, getBridgeText, setBridgeText } from '../../src/adapters/shared.js';
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
    setBridgeText({ monaco: '', ace: '', at: Date.now() });
    expect(getBridgeText().monaco).toBeNull();
    expect(getBridgeText().ace).toBeNull();
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
        },
        source: window,
      }),
    );
    await expect(promise).resolves.toBe(true);
    expect(getBridgeText().monaco).toBe('full monaco');
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
  it('answers requests with full Monaco model and ACE editor text', async () => {
    // Stub the page's editor globals exactly as LeetCode/GFG would expose them.
    window.monaco = {
      editor: {
        getModels: () => [
          { getValue: () => '' },
          { getValue: () => 'def solve():\n    return 42\n# lines past the viewport' },
        ],
      },
    };
    document.body.innerHTML =
      '<div class="ace_editor" id="editor"><div class="ace_content"></div></div>';
    document.querySelector('#editor').env = { editor: { getValue: () => 'print(1)\nprint(2)' } };

    const responsePromise = new Promise((resolve) => {
      window.addEventListener('message', function onMessage(event) {
        const data = event.data;
        if (data && data.source === 'codesync-bridge' && data.type === 'response') {
          window.removeEventListener('message', onMessage);
          resolve(data);
        }
      });
    });

    window.eval(bridgeMainSource);
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { source: 'codesync-bridge', type: 'request', id: 42 },
        source: window,
      }),
    );

    const response = await responsePromise;
    expect(response.id).toBe(42);
    expect(response.monaco).toBe('def solve():\n    return 42\n# lines past the viewport');
    expect(response.ace).toBe('print(1)\nprint(2)');
    delete window.monaco;
  });

  it('returns nulls instead of throwing when editors are missing', async () => {
    window.eval(bridgeMainSource);
    const responsePromise = new Promise((resolve) => {
      window.addEventListener('message', function onMessage(event) {
        const data = event.data;
        if (data && data.source === 'codesync-bridge' && data.type === 'response') {
          window.removeEventListener('message', onMessage);
          resolve(data);
        }
      });
    });
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { source: 'codesync-bridge', type: 'request', id: 43 },
        source: window,
      }),
    );
    const response = await responsePromise;
    expect(response.monaco).toBeNull();
    expect(response.ace).toBeNull();
  });
});
