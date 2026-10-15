import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

beforeAll(() => {
  execFileSync(process.execPath, [path.join(root, 'build.mjs')], {
    cwd: root,
    stdio: 'pipe',
    timeout: 120000,
  });
}, 120000);

function readDist(relative) {
  return readFileSync(path.join(dist, relative), 'utf8');
}

describe('build output', () => {
  it('produces every bundle entry point', () => {
    for (const file of [
      'background.js',
      'content/content.js',
      'popup/popup.js',
      'options/options.js',
    ]) {
      expect(existsSync(path.join(dist, file)), `${file} missing`).toBe(true);
    }
  });

  it('copies static assets to dist', () => {
    for (const file of [
      'manifest.json',
      'popup/popup.html',
      'popup/popup.css',
      'options/options.html',
      'options/options.css',
    ]) {
      expect(existsSync(path.join(dist, file)), `${file} missing`).toBe(true);
    }
  });

  it('keeps every manifest target present in dist', () => {
    const manifest = JSON.parse(readDist('manifest.json'));
    const targets = [
      manifest.background.service_worker,
      ...manifest.content_scripts.flatMap((entry) => entry.js),
      manifest.action.default_popup,
      manifest.action.default_popup.replace('.html', '.css'),
      manifest.options_page,
      manifest.options_page.replace('.html', '.css'),
    ];
    for (const target of targets) {
      expect(existsSync(path.join(dist, target)), `${target} missing`).toBe(true);
    }
  });

  it('emits classic-script bundles without static module syntax or eval', () => {
    for (const file of [
      'background.js',
      'content/content.js',
      'content/bridge-main.js',
      'popup/popup.js',
      'options/options.js',
    ]) {
      const code = readDist(file);
      expect(code.length).toBeGreaterThan(200);
      expect(code).not.toMatch(/(^|\n)\s*import\s[\s*{]/);
      expect(code).not.toMatch(/(^|\n)\s*export\s/);
      expect(code).not.toContain('eval(');
      expect(code).not.toMatch(/src=["']https?:\/\//);
    }
  });

  it('does not inline scripts in the copied html pages', () => {
    for (const file of ['popup/popup.html', 'options/options.html']) {
      const html = readDist(file);
      const inlineScripts = html.match(/<script(?![^>]*\bsrc=)[^>]*>/gi) || [];
      expect(inlineScripts).toHaveLength(0);
    }
  });

  it('writes a metafile describing the build', () => {
    expect(existsSync(path.join(dist, 'meta.json'))).toBe(true);
    const meta = JSON.parse(readDist('meta.json'));
    expect(Object.keys(meta.outputs).length).toBeGreaterThan(0);
  });
});
