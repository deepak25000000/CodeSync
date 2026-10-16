import { describe, expect, it } from 'vitest';
import {
  CHROMIUM_REDIRECT_RE,
  buildAuthStartUrl,
  connectWithGitHub,
  tokenFromAuthRedirect,
} from '../src/shared/auth.js';

const REDIRECT = `https://${'b'.repeat(32)}.chromiumapp.org/`;

describe('one-click GitHub sign-in', () => {
  it('accepts only chrome-extension chromiumapp redirect URLs', () => {
    expect(CHROMIUM_REDIRECT_RE.test(REDIRECT)).toBe(true);
    expect(CHROMIUM_REDIRECT_RE.test(`https://${'B'.repeat(32)}.chromiumapp.org`)).toBe(true);
    expect(CHROMIUM_REDIRECT_RE.test('https://evil.example/')).toBe(false);
    expect(CHROMIUM_REDIRECT_RE.test('https://short.chromiumapp.org/')).toBe(false);
    expect(CHROMIUM_REDIRECT_RE.test('')).toBe(false);
  });

  it('builds the backend start URL with the strict redirect', () => {
    expect(buildAuthStartUrl('http://127.0.0.1:8000/', REDIRECT)).toBe(
      `http://127.0.0.1:8000/api/v1/auth/github/start?client=extension&redirect_uri=${encodeURIComponent(
        REDIRECT,
      )}`,
    );
  });

  it('extracts the API token from the browser redirect', () => {
    expect(tokenFromAuthRedirect(`${REDIRECT}?token=cs_abc123`)).toBe('cs_abc123');
    expect(tokenFromAuthRedirect(REDIRECT)).toBeNull();
    expect(tokenFromAuthRedirect(`${REDIRECT}?token=other`)).toBeNull();
    expect(tokenFromAuthRedirect('not a url')).toBeNull();
    expect(tokenFromAuthRedirect(null)).toBeNull();
  });

  it('connects end-to-end with an injected flow', async () => {
    const launched = [];
    const token = await connectWithGitHub('http://127.0.0.1:8000', {
      redirectUrl: REDIRECT,
      launch: async (url) => {
        launched.push(url);
        return `${REDIRECT}?token=cs_live_token`;
      },
    });
    expect(token).toBe('cs_live_token');
    expect(launched).toHaveLength(1);
    expect(launched[0]).toContain('client=extension');
    expect(launched[0]).toContain(encodeURIComponent(REDIRECT));
  });

  it('fails when the flow returns no token or the redirect is unavailable', async () => {
    await expect(
      connectWithGitHub('http://127.0.0.1:8000', { redirectUrl: REDIRECT, launch: async () => REDIRECT }),
    ).rejects.toThrow(/without an API token/);
    await expect(
      connectWithGitHub('http://127.0.0.1:8000', { redirectUrl: 'https://evil.example/', launch: async () => '' }),
    ).rejects.toThrow(/redirect URL is unavailable/);
  });
});
