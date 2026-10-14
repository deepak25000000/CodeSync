import { fail, ok } from './schema.js';

function runtime() {
  return typeof chrome !== 'undefined' && chrome.runtime ? chrome.runtime : null;
}

export function sendRuntimeMessage(message) {
  const rt = runtime();
  if (!rt) return Promise.resolve(fail('NO_RUNTIME', 'chrome.runtime is unavailable'));
  try {
    const result = rt.sendMessage(message);
    if (result && typeof result.then === 'function') return result;
    return new Promise((resolve, reject) => {
      try {
        rt.sendMessage(message, (response) => {
          const err = rt.lastError;
          if (err) reject(new Error(err.message));
          else resolve(response);
        });
      } catch (err) {
        reject(err);
      }
    });
  } catch (err) {
    return Promise.resolve(fail('RUNTIME_ERROR', err && err.message ? err.message : 'sendMessage failed'));
  }
}

export function sendTabMessage(tabId, message) {
  if (typeof chrome === 'undefined' || !chrome.tabs) {
    return Promise.resolve(fail('NO_TABS', 'chrome.tabs is unavailable'));
  }
  try {
    const result = chrome.tabs.sendMessage(tabId, message);
    if (result && typeof result.then === 'function') return result;
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(response);
      });
    });
  } catch (err) {
    return Promise.reject(err);
  }
}

export async function getActiveTabId() {
  if (typeof chrome === 'undefined' || !chrome.tabs) return null;
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs.length ? tabs[0].id : null;
}

export async function request(type, payload = {}) {
  const response = await sendRuntimeMessage({ type, payload });
  if (!response || response.ok !== true) {
    const error = (response && response.error) || { code: 'NO_RESPONSE', message: 'no response from background' };
    const err = new Error(error.message || 'request failed');
    err.code = error.code || 'NO_RESPONSE';
    throw err;
  }
  return response;
}

export function messageResponse(payload) {
  return ok(payload);
}

export function messageError(code, message) {
  return fail(code, message);
}
