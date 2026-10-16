import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const rawManifest = readFileSync(manifestPath, 'utf8');

const EXPECTED_MATCHES = [
  'https://*.leetcode.com/*',
  'https://*.geeksforgeeks.org/*',
  'https://*.codechef.com/*',
  'https://*.neetcode.io/*',
];

describe('manifest.json', () => {
  it('is a valid MV3 manifest with a minimal permission set', () => {
    expect(manifest.manifest_version).toBe(3);
    // `identity` powers the one-click GitHub sign-in (launchWebAuthFlow); the
    // rest stay as narrow as possible.
    expect(manifest.permissions).toEqual(['storage', 'alarms', 'identity']);
    expect(manifest.host_permissions).toEqual(['http://127.0.0.1/*', 'http://localhost/*']);
    expect(manifest.optional_host_permissions).toEqual(['https://*/*', 'http://*/*']);
    for (const forbidden of ['tabs', 'webRequest', 'scripting', 'downloads']) {
      expect(manifest.permissions ?? []).not.toContain(forbidden);
    }
  });

  it('declares exactly the four platform content script hosts', () => {
    expect(manifest.content_scripts).toHaveLength(2);
    const [contentScript, bridge] = manifest.content_scripts;
    expect(contentScript.matches).toEqual(EXPECTED_MATCHES);
    expect(contentScript.run_at).toBe('document_idle');
    expect(contentScript.all_frames).toBe(false);
    expect(contentScript.js).toEqual(['content/content.js']);
    // Page-world bridge: reads full Monaco/ACE text (viewport-virtualized in
    // the DOM) and answers the isolated content script over postMessage.
    expect(bridge.matches).toEqual(EXPECTED_MATCHES);
    expect(bridge.world).toBe('MAIN');
    expect(bridge.run_at).toBe('document_idle');
    expect(bridge.all_frames).toBe(false);
    expect(bridge.js).toEqual(['content/bridge-main.js']);
  });

  it('uses a classic background service worker', () => {
    expect(manifest.background.service_worker).toBe('background.js');
    expect(manifest.background.type ?? 'classic').toBe('classic');
  });

  it('has no web accessible resources and no remote code', () => {
    expect(manifest.web_accessible_resources ?? []).toHaveLength(0);
    expect(rawManifest).not.toContain('unsafe-eval');
    expect(rawManifest).not.toMatch(/<script[^>]+src=["']https?:/);
    for (const entry of manifest.content_scripts) {
      for (const file of entry.js || []) {
        expect(file).not.toMatch(/^https?:/);
        expect(file).not.toContain('..');
      }
    }
    expect(manifest.background.service_worker).not.toMatch(/^https?:/);
  });

  it('declares local icon assets', () => {
    expect(manifest.icons).toEqual({
      '16': 'icons/icon-16.png',
      '32': 'icons/icon-32.png',
      '48': 'icons/icon-48.png',
      '128': 'icons/icon-128.png',
    });
    expect(manifest.action.default_icon).toEqual({
      '16': 'icons/icon-16.png',
      '32': 'icons/icon-32.png',
      '48': 'icons/icon-48.png',
    });
    for (const icon of [...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)]) {
      expect(icon).toMatch(/^icons\/icon-\d+\.png$/);
    }
  });

  it('points at local popup and options pages', () => {
    expect(manifest.action.default_popup).toBe('popup/popup.html');
    expect(manifest.options_page).toBe('options/options.html');
  });

  it('does not include inline scripts in html entry points', () => {
    for (const file of ['src/popup/popup.html', 'src/options/options.html']) {
      const html = readFileSync(path.join(root, file), 'utf8');
      const scriptTags = html.match(/<script\b[^>]*>/gi) || [];
      expect(scriptTags.length).toBeGreaterThan(0);
      for (const tag of scriptTags) {
        expect(tag).toMatch(/src=["'][^"']+["']/i);
        expect(tag).not.toMatch(/src=["']https?:/i);
      }
      expect(html).not.toContain('onclick=');
      expect(html).not.toContain('javascript:');
    }
  });
});
