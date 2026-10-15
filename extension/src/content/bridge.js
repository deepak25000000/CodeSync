// Isolated-world side of the editor bridge: requests full editor text from
// bridge-main.js (page world) and caches the result where the adapters can
// read it synchronously. Every call resolves; when the page-world script is
// unavailable (CSP-blocked or not yet installed) it resolves `false` after a
// short timeout and callers fall back to DOM extraction.
import { setBridgeText } from '../adapters/shared.js';

const SOURCE = 'codesync-bridge';
let seq = 0;
const pending = new Map();

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== SOURCE) return;
  if (data.type === 'ready') {
    // Page-world script just installed: refresh immediately so scans that run
    // before its first response still get full text soon after.
    requestBridge().then(() => {});
    return;
  }
  if (data.type === 'response') {
    const done = pending.get(data.id);
    if (done) {
      // Only correlate text with requests this script actually issued.
      setBridgeText({ monaco: data.monaco, ace: data.ace, at: Date.now() });
      pending.delete(data.id);
      done(true);
    }
  }
});

export function requestBridge(timeoutMs = 400) {
  return new Promise((resolve) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(false);
    }, timeoutMs);
    pending.set(id, (fresh) => {
      clearTimeout(timer);
      resolve(fresh);
    });
    window.postMessage({ source: SOURCE, type: 'request', id }, '*');
  });
}
