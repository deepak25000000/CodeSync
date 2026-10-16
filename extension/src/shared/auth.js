// One-click GitHub sign-in for the extension.
//
// chrome.identity.launchWebAuthFlow walks the backend's OAuth flow in a real
// browser window; on success the backend redirects to the per-extension
// https://<id>.chromiumapp.org/ callback with the freshly minted API token in
// the query string. The token lands straight in the extension — the user never
// sees, copies or pastes it.
//
// The backend validates the redirect target against the same
// <32-char-id>.chromiumapp.org shape before agreeing to it, so a stolen or
// forged start-URL cannot redirect tokens anywhere else.
import { API_PREFIX } from './config.js';

export const CHROMIUM_REDIRECT_RE = /^https:\/\/[a-z0-9]{32}\.chromiumapp\.org\/?$/i;

export function defaultRedirectUrl() {
  try {
    return chrome.identity?.getRedirectURL?.() || null;
  } catch {
    return null;
  }
}

export function tokenFromAuthRedirect(url) {
  if (!url) return null;
  try {
    const token = new URL(url).searchParams.get('token');
    return typeof token === 'string' && token.startsWith('cs_') ? token : null;
  } catch {
    return null;
  }
}

export function buildAuthStartUrl(baseUrl, redirectUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return `${base}${API_PREFIX}/auth/github/start?client=extension&redirect_uri=${encodeURIComponent(
    redirectUrl,
  )}`;
}

function defaultLaunch(url) {
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url, interactive: true }, (redirectedToUrl) => {
      const err = chrome.runtime && chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else if (!redirectedToUrl) reject(new Error('sign-in was cancelled'));
      else resolve(redirectedToUrl);
    });
  });
}

// Returns the new API token (cs_…) or throws. `launch`/`redirectUrl` are
// injectable for tests.
export async function connectWithGitHub(baseUrl, { launch, redirectUrl } = {}) {
  const launchFlow = launch || defaultLaunch;
  const redirect = redirectUrl || defaultRedirectUrl();
  if (!CHROMIUM_REDIRECT_RE.test(redirect || '')) {
    throw new Error('chrome.identity redirect URL is unavailable');
  }
  const redirectedTo = await launchFlow(buildAuthStartUrl(baseUrl, redirect));
  const token = tokenFromAuthRedirect(redirectedTo);
  if (!token) throw new Error('GitHub sign-in finished without an API token');
  return token;
}
