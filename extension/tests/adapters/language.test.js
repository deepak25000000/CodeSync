// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { LANG_TOKENS, canonicalLanguage, detectLanguage } from '../../src/adapters/shared.js';

describe('language canonicalisation contract', () => {
  it('is idempotent for every LANG_TOKENS name', () => {
    // Every canonical name the extension can emit must round-trip through
    // canonicalLanguage unchanged — otherwise detection drifts (e.g. a name
    // the backend cannot map would fail the sync with INVALID_FILE).
    expect(LANG_TOKENS.length).toBeGreaterThan(0);
    for (const token of LANG_TOKENS) {
      expect(canonicalLanguage(token.name), token.name).toBe(token.name);
    }
  });

  it('maps platform-specific labels to canonical names', () => {
    const cases = [
      ['PyPy 3', 'Python3'],
      ['PyPy3', 'Python3'],
      ['Python 3.11', 'Python3'],
      ['Python3 (Pandas)', 'Python3'],
      ['C++ (gcc 13.2)', 'C++'],
      ['C (gcc 5.4)', 'C'],
      ['Java 14', 'Java'],
      ['JavaScript (Node.js)', 'JavaScript'],
      ['MS SQL Server', 'MS SQL'],
      ['Postgres', 'PostgreSQL'],
      ['SQL (PostgreSQL)', 'PostgreSQL'],
      ['Bash', 'Bash'],
      ['Elixir', 'Elixir'],
      ['Erlang', 'Erlang'],
      ['brainfuck', null],
      ['', null],
      [null, null],
    ];
    for (const [raw, expected] of cases) {
      expect(canonicalLanguage(raw), String(raw)).toBe(expected);
    }
  });

  it('prefers the selected entry of a custom dropdown over hidden options', () => {
    // Closed custom dropdowns often keep every option in the DOM; the selected
    // entry must win even when another language (TypeScript is first in
    // LANG_TOKENS) also appears in the concatenated container text.
    document.body.innerHTML = `
      <div id="lang-select">
        <span class="current" aria-selected="true">Python3</span>
        <div class="menu" hidden>TypeScript JavaScript Java Python3 C++</div>
      </div>`;
    expect(detectLanguage(document, ['#lang-select'])).toBe('Python3');
  });

  it('still reads plain leaf dropdowns', () => {
    document.body.innerHTML = `<div id="lang-leaf">C++ (gcc 13.2)</div>`;
    expect(detectLanguage(document, ['#lang-leaf'])).toBe('C++');
    document.body.innerHTML = `<div id="lang-leaf">Go</div>`;
    expect(detectLanguage(document, ['#lang-leaf'])).toBe('Go');
  });

  it('reads SELECT dropdowns from the selected option', () => {
    document.body.innerHTML = `
      <select id="lang-sel">
        <option value="cpp">C++</option>
        <option value="python3" selected>Python3</option>
        <option value="java">Java</option>
      </select>`;
    expect(detectLanguage(document, ['#lang-sel'])).toBe('Python3');
  });
});
