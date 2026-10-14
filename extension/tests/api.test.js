import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiRequest, createApi, normalizeError } from '../src/shared/api.js';

function jsonResponse(data, { status = 200, statusText = 'OK' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: async () => JSON.stringify(data),
  };
}

function rawResponse(body, { status = 200, statusText = 'OK' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: async () => body,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('apiRequest', () => {
  it('builds the api url and sets bearer + json headers', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ status: 'ok' }));
    const result = await apiRequest('/health', {
      baseUrl: 'http://127.0.0.1:8000',
      token: 'secret-token',
      fetchImpl,
    });
    expect(result).toEqual({ status: 'ok' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8000/api/v1/health');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer secret-token');
    expect(init.headers.Accept).toBe('application/json');
    expect(init.body).toBeUndefined();
  });

  it('normalizes trailing slashes on the base url', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    await apiRequest('/settings', { baseUrl: 'http://localhost:8000//', fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe('http://localhost:8000/api/v1/settings');
  });

  it('serializes json bodies with content type', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 1 }));
    await apiRequest('/submissions', {
      baseUrl: 'http://127.0.0.1:8000',
      token: 't',
      method: 'POST',
      body: { platform: 'leetcode' },
      fetchImpl,
    });
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ platform: 'leetcode' }));
  });

  it('maps {detail:{code,message}} errors', async () => {
    const fetchImpl = vi.fn(async () =>
      rawResponse(JSON.stringify({ detail: { code: 'NO_GITHUB', message: 'connect github first' } }), {
        status: 409,
        statusText: 'Conflict',
      }),
    );
    await expect(apiRequest('/submissions', { baseUrl: 'http://x', fetchImpl })).rejects.toMatchObject({
      code: 'NO_GITHUB',
      message: 'connect github first',
      status: 409,
    });
  });

  it('tolerates plain string detail', async () => {
    const fetchImpl = vi.fn(async () =>
      rawResponse(JSON.stringify({ detail: 'repo_full_name must look like owner/repo' }), {
        status: 422,
        statusText: 'Unprocessable Entity',
      }),
    );
    await expect(apiRequest('/settings', { baseUrl: 'http://x', fetchImpl })).rejects.toMatchObject({
      code: 'HTTP_422',
      message: 'repo_full_name must look like owner/repo',
    });
  });

  it('falls back to HTTP_<status> without a usable detail', async () => {
    const fetchImpl = vi.fn(async () => rawResponse('not json', { status: 500, statusText: 'Server Error' }));
    await expect(apiRequest('/stats', { baseUrl: 'http://x', fetchImpl })).rejects.toMatchObject({
      code: 'HTTP_500',
      status: 500,
    });
  });

  it('rejects invalid success payloads', async () => {
    const fetchImpl = vi.fn(async () => rawResponse('<html>', { status: 200, statusText: 'OK' }));
    await expect(apiRequest('/health', { baseUrl: 'http://x', fetchImpl })).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
    });
  });

  it('normalizes network failures', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(apiRequest('/health', { baseUrl: 'http://x', fetchImpl })).rejects.toMatchObject({
      code: 'NETWORK',
      message: 'Failed to fetch',
    });
  });

  it('aborts requests that exceed the timeout', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const error = new Error('The operation was aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    );
    const pending = apiRequest('/health', {
      baseUrl: 'http://127.0.0.1:8000',
      timeoutMs: 1000,
      fetchImpl,
    });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it('returns null for empty successful responses', async () => {
    const fetchImpl = vi.fn(async () => rawResponse('', { status: 204, statusText: 'No Content' }));
    await expect(apiRequest('/account', { baseUrl: 'http://x', method: 'DELETE', fetchImpl })).resolves.toBeNull();
  });
});

describe('normalizeError', () => {
  it('prefers detail code and message', () => {
    expect(normalizeError({ detail: { code: 'X', message: 'y' } }, 400)).toEqual({
      code: 'X',
      message: 'y',
    });
  });

  it('uses HTTP_<status> when detail lacks a code', () => {
    expect(normalizeError({ detail: { message: 'nope' } }, 403)).toEqual({
      code: 'HTTP_403',
      message: 'nope',
    });
  });

  it('falls back for missing bodies', () => {
    expect(normalizeError(null, 502, 'Bad Gateway').code).toBe('HTTP_502');
  });
});

describe('createApi', () => {
  it('exposes the documented endpoints', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ items: [], meta: {} }));
    const api = createApi({ baseUrl: 'http://127.0.0.1:8000/', token: 'abc', fetchImpl });

    await api.authMe();
    expect(fetchImpl.mock.calls.at(-1)[0]).toBe('http://127.0.0.1:8000/api/v1/auth/me');

    await api.listSubmissions({ page: 2, per_page: 20, platform: 'leetcode' });
    expect(fetchImpl.mock.calls.at(-1)[0]).toBe(
      'http://127.0.0.1:8000/api/v1/submissions?page=2&per_page=20&platform=leetcode',
    );

    await api.getSync(5);
    expect(fetchImpl.mock.calls.at(-1)[0]).toBe('http://127.0.0.1:8000/api/v1/sync/5');

    await api.retrySync(5);
    expect(fetchImpl.mock.calls.at(-1)[0]).toBe('http://127.0.0.1:8000/api/v1/sync/5/retry');
    expect(fetchImpl.mock.calls.at(-1)[1].method).toBe('POST');

    await api.setPlatform('codechef', false);
    expect(fetchImpl.mock.calls.at(-1)[0]).toBe('http://127.0.0.1:8000/api/v1/platforms/codechef');
    expect(fetchImpl.mock.calls.at(-1)[1].body).toBe(JSON.stringify({ enabled: false }));

    await api.updateSettings({ auto_sync: false });
    expect(fetchImpl.mock.calls.at(-1)[0]).toBe('http://127.0.0.1:8000/api/v1/settings');
    expect(fetchImpl.mock.calls.at(-1)[1].method).toBe('PATCH');

    await api.deleteAccount();
    expect(fetchImpl.mock.calls.at(-1)[1].method).toBe('DELETE');

    for (const [, init] of fetchImpl.mock.calls) {
      expect(init.headers.Authorization).toBe('Bearer abc');
    }
  });

  it('fails clearly without a base url', async () => {
    await expect(apiRequest('/health', { baseUrl: '', fetchImpl: vi.fn() })).rejects.toBeInstanceOf(
      ApiError,
    );
  });
});
