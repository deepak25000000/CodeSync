// CodeSync page-world editor bridge (runs in the PAGE's own JS context).
//
// Declared in manifest.json as a content script with `"world": "MAIN"` because
// Monaco (LeetCode) and ACE (GeeksforGeeks, CodeChef) virtualize long
// documents: only the lines visible in the viewport exist in the DOM, so
// reading `.view-line` / `.ace_line` from the isolated content script silently
// truncates solutions that are taller than the editor. The editor instances
// are only reachable where the page's own JavaScript lives, so this script
// reads the full model text and answers requests over window.postMessage.
//
// Failure modes degrade safely: if the page's CSP blocks MAIN-world scripts
// (page CSP applies to this world), this file never runs and the content
// script simply keeps using DOM extraction.
const SOURCE = 'codesync-bridge';

function longestText(values) {
  let best = null;
  for (const text of values) {
    if (typeof text === 'string' && text.trim() && (!best || text.length > best.length)) {
      best = text;
    }
  }
  return best;
}

function readMonaco() {
  const models = (window.monaco && window.monaco.editor && window.monaco.editor.getModels) || null;
  if (typeof models !== 'function') return null;
  try {
    return longestText(models().map((model) => (model && model.getValue && model.getValue()) || ''));
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

function readAce() {
  const roots = document.querySelectorAll('.ace_editor');
  const texts = [];
  for (const root of roots) {
    const editor = aceInstance(root);
    if (editor) {
      try {
        texts.push(editor.getValue());
      } catch (_err) {
        /* ignore broken instance */
      }
    }
  }
  return longestText(texts);
}

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== SOURCE || data.type !== 'request') return;
  let monaco = null;
  let ace = null;
  try {
    monaco = readMonaco();
  } catch (_err) {
    monaco = null;
  }
  try {
    ace = readAce();
  } catch (_err) {
    ace = null;
  }
  window.postMessage({ source: SOURCE, type: 'response', id: data.id, monaco, ace }, '*');
});

window.postMessage({ source: SOURCE, type: 'ready' }, '*');
