import { API_PREFIX, REQUEST_TIMEOUT_MS } from './config.js';

export class ApiError extends Error {
  constructor(code, message, { status = null, cause = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    if (cause) this.cause = cause;
  }
}

export function normalizeError(body, status, statusText = '') {
  const fallbackCode = `HTTP_${status}`;
  const detail = body && typeof body === 'object' ? body.detail : undefined;
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
    const code = typeof detail.code === 'string' && detail.code ? detail.code : fallbackCode;
    const message =
      typeof detail.message === 'string' && detail.message ? detail.message : `Request failed with status ${status}`;
    return { code, message };
  }
  if (typeof detail === 'string' && detail) {
    return { code: fallbackCode, message: detail };
  }
  const message = statusText ? `${status} ${statusText}` : `Request failed with status ${status}`;
  return { code: fallbackCode, message };
}

function buildUrl(baseUrl, path) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new ApiError('NO_BASE_URL', 'api base url is not configured');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${API_PREFIX}${suffix}`;
}

function isAbortError(err) {
  return (
    err &&
    (err.name === 'AbortError' || err.name === 'TimeoutError' || err.code === 20 || err.code === 'ABORT_ERR')
  );
}

export async function apiRequest(path, {
  method = 'GET',
  baseUrl,
  token = null,
  body,
  headers = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
  fetchImpl,
  signal,
} = {}) {
  const url = buildUrl(baseUrl, path);
  const doFetch = fetchImpl || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  if (!doFetch) throw new ApiError('NO_FETCH', 'fetch is unavailable');

  const controller = new AbortController();
  let timedOut = false;
  let externallyAborted = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onExternalAbort = () => {
    externallyAborted = true;
    controller.abort();
  };
  if (signal) {
    if (signal.aborted) onExternalAbort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const finalHeaders = { Accept: 'application/json', ...headers };
  if (token) finalHeaders.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    finalHeaders['Content-Type'] = 'application/json';
  }

  let response;
  try {
    response = await doFetch(url, {
      method,
      headers: finalHeaders,
      body: payload,
      signal: controller.signal,
    });
  } catch (err) {
    if (timedOut) throw new ApiError('TIMEOUT', `request timed out after ${timeoutMs}ms`, { cause: err });
    if (externallyAborted) throw new ApiError('ABORTED', 'request aborted', { cause: err });
    if (isAbortError(err)) throw new ApiError('ABORTED', 'request aborted', { cause: err });
    throw new ApiError('NETWORK', err && err.message ? err.message : 'network request failed', { cause: err });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  }

  if (!response.ok) {
    let parsed = null;
    const text = await response.text().catch(() => '');
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    const { code, message } = normalizeError(parsed, response.status, response.statusText);
    throw new ApiError(code, message, { status: response.status });
  }

  const text = await response.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ApiError('BAD_RESPONSE', 'response body was not valid JSON', { status: response.status, cause: err });
  }
}

function qs(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const str = search.toString();
  return str ? `?${str}` : '';
}

export function createApi({ baseUrl, token = null, fetchImpl, timeoutMs } = {}) {
  const call = (path, opts = {}) =>
    apiRequest(path, { baseUrl, token, fetchImpl, timeoutMs, ...opts });

  return {
    health: () => call('/health'),
    authMe: () => call('/auth/me'),
    // Validate a GitHub PAT server-side; returns { api_token, github_login }.
    connectWithPat: (gitHubToken) => call('/auth/pat', { method: 'POST', body: { token: gitHubToken } }),
    createSubmission: (submission) => call('/submissions', { method: 'POST', body: submission }),
    listSubmissions: (params = {}) => call(`/submissions${qs(params)}`),
    createSync: (submissionId) => call('/sync', { method: 'POST', body: { submission_id: submissionId } }),
    listSync: (params = {}) => call(`/sync${qs(params)}`),
    getSync: (id) => call(`/sync/${id}`),
    retrySync: (id) => call(`/sync/${id}/retry`, { method: 'POST' }),
    getSettings: () => call('/settings'),
    updateSettings: (patch) => call('/settings', { method: 'PATCH', body: patch }),
    getPlatforms: () => call('/platforms'),
    setPlatform: (id, enabled) => call(`/platforms/${encodeURIComponent(id)}`, { method: 'PUT', body: { enabled } }),
    listRepos: (params = {}) => call(`/repos${qs(params)}`),
    createRepo: (payload) => call('/repos', { method: 'POST', body: payload }),
    getStats: () => call('/stats'),
    deleteAccount: () => call('/account', { method: 'DELETE' }),
  };
}

export function toSubmissionPayload(submission) {
  return {
    platform: submission.platform,
    title: submission.title,
    language: submission.language,
    code: submission.code,
    external_id: submission.external_id,
    problem_id: submission.problem_id,
    url: submission.url,
    verdict: submission.verdict,
    submitted_at: submission.submitted_at,
    metadata: submission.metadata,
  };
}
