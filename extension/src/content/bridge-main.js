// CodeSync page-world editor bridge (runs in the PAGE's own JS context).
//
// Declared in manifest.json as a content script with `"world": "MAIN"` because
// Monaco (LeetCode) and ACE (GeeksforGeeks, CodeChef) virtualize long
// documents: only the lines visible in the viewport exist in the DOM, so
// reading `.view-line` / `.ace_line` from the isolated content script silently
// truncates solutions that are taller than the editor. The editor instances
// are only reachable where the page's own JavaScript lives, so this script
// reads the full model text — and the model's language id, which tracks the
// language dropdown even when the control itself is hidden behind obfuscated
// React markup — and answers requests over window.postMessage.
//
// Failure modes degrade safely: if the page's CSP blocks MAIN-world scripts
// (page CSP applies to this world), this file never runs and the content
// script simply keeps using DOM extraction.
const SOURCE = 'codesync-bridge';

// Monaco language ids that mean "this model is the solution editor", not the
// judge's test-case input box (which is usually plaintext/json/empty).
const CODE_LANG_RE =
  /^(python3?|pypy3?|javascript|typescript|java|csharp|cpp|c|golang|go|rust|kotlin|swift|ruby|scala|php|dart|elixir|erlang|r|bash|mysql|postgresql|mssql|oracle)$/i;
const NON_CODE_LANG_RE = /^(json|jsonc|markdown|log|text|plaintext|shellsession|xml|html|css|scss|yaml|ini)$/i;

function langIsCode(lang) {
  if (!lang) return false;
  const id = String(lang).split('/').pop().toLowerCase();
  if (NON_CODE_LANG_RE.test(id)) return false;
  return CODE_LANG_RE.test(id);
}

function looksLikeSource(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  // Real solutions almost always have keywords/structure; test-case input
  // is bare arrays/numbers like "[123,45]\n1".
  return /(?:^|\n)\s*(?:def |class |public |private |static |void |function |const |let |var |#include|using |package |fn |func |import |from |return |if |for |while )/.test(
    text,
  ) || /[{};]\s*$/m.test(text) || /\breturn\b/.test(text);
}

function modelScore(text, lang) {
  if (typeof text !== 'string' || !text.trim()) return -1;
  let score = 0;
  if (langIsCode(lang)) score += 100;
  if (looksLikeSource(text)) score += 50;
  score += Math.min(text.length / 200, 20);
  // Pure bracket/number blobs (test-case input) are never the solution.
  if (/^[\[\]{}()0-9,\s.\-eE+:"']+$/.test(text.trim()) && !looksLikeSource(text)) {
    score -= 80;
  }
  return score;
}

function keepBest(best, text, lang) {
  const score = modelScore(text, lang);
  if (score < 0) return best;
  if (!best || score > best.score) return { text, lang: lang || null, score };
  return best;
}

function readMonaco() {
  const models = (window.monaco && window.monaco.editor && window.monaco.editor.getModels) || null;
  if (typeof models !== 'function') return null;
  try {
    let best = null;
    for (const model of models()) {
      const text = (model && model.getValue && model.getValue()) || '';
      // e.g. "python3", "java", "cpp", "golang" — set from the dropdown.
      const lang = (model && model.getLanguage && model.getLanguage()) || null;
      best = keepBest(best, text, lang);
    }
    return best;
  } catch (_err) {
    return null;
  }
}

function aceInstance(root) {
  // Probe-only: never call ace.edit() here — that can re-initialize an
  // already-live editor and break the page.
  const nodes = [root];
  if (root && root.querySelector) nodes.push(root.querySelector('.ace_content'));
  if (root && root.parentElement) nodes.push(root.parentElement);
  for (const node of nodes) {
    const editor = node && node.env && node.env.editor;
    if (editor && typeof editor.getValue === 'function') return editor;
  }
  return null;
}

function aceModeLang(editor) {
  // Mode id looks like "ace/mode/python"; the last segment is enough.
  try {
    const session = editor.getSession && editor.getSession();
    const mode = session && session.getMode && session.getMode();
    const id = mode && mode.$id;
    return typeof id === 'string' && id ? id.split('/').pop() : null;
  } catch (_err) {
    return null;
  }
}

function readAce() {
  const roots = document.querySelectorAll('.ace_editor');
  let best = null;
  for (const root of roots) {
    const editor = aceInstance(root);
    if (!editor) continue;
    try {
      best = keepBest(best, editor.getValue(), aceModeLang(editor));
    } catch (_err) {
      /* ignore broken instance */
    }
  }
  return best;
}

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== SOURCE || data.type !== 'request') return;
  let monaco = null;
  let ace = null;
  let monacoLang = null;
  let aceLang = null;
  try {
    const m = readMonaco();
    monaco = m ? m.text : null;
    monacoLang = m ? m.lang : null;
  } catch (_err) {
    monaco = null;
    monacoLang = null;
  }
  try {
    const a = readAce();
    ace = a ? a.text : null;
    aceLang = a ? a.lang : null;
  } catch (_err) {
    ace = null;
    aceLang = null;
  }
  window.postMessage(
    { source: SOURCE, type: 'response', id: data.id, monaco, ace, monacoLang, aceLang },
    '*'
  );
});

window.postMessage({ source: SOURCE, type: 'ready' }, '*');
