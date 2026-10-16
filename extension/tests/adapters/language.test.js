// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  LANG_TOKENS,
  canonicalLanguage,
  detectLanguage,
  getBridgeLang,
  setBridgeText,
  sniffLanguage,
} from '../../src/adapters/shared.js';

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

describe('language fallbacks when the DOM hides the control', () => {
  afterEach(() => {
    setBridgeText({ monaco: null, ace: null });
    document.body.innerHTML = '';
  });

  it('uses the editor language reported by the page-world bridge', () => {
    // LeetCode renders the language control in obfuscated React markup, but
    // the Monaco model (reachable only via the MAIN-world bridge) knows it.
    setBridgeText({ monaco: 'x = 1', monacoLang: 'python3', at: Date.now() });
    expect(getBridgeLang()).toBe('Python3');
    document.body.innerHTML = '<div class="no-lang-here">Python3 hidden</div>';
    expect(detectLanguage(document, ['#missing'])).toBe('Python3');

    setBridgeText({ ace: 'x = 1', aceLang: 'cpp', at: Date.now() });
    expect(detectLanguage(document, ['#missing'])).toBe('C++');
  });

  it('canonicalises bridge language ids and ignores unmapped ones', () => {
    // 'plaintext' maps to a real backend language (txt files)…
    setBridgeText({ monaco: 'x = 1', monacoLang: 'plaintext', at: Date.now() });
    expect(getBridgeLang()).toBe('Plain Text');
    // …while ids with no canonical mapping fall through instead of guessing.
    setBridgeText({ monaco: 'x = 1', monacoLang: 'pandas', at: Date.now() });
    expect(getBridgeLang()).toBeNull();
    document.body.innerHTML = '';
    expect(detectLanguage(document, ['#missing'])).toBeNull();
  });

  it('sniffs every supported language from the code itself', () => {
    const cases = [
      ['class Solution:\n    def f(self):\n        return 1', 'Python3'],
      ['public class Main {\n  public static void main(String[] a) {\n    System.out.println(1);\n  }\n}', 'Java'],
      ['#include <vector>\nusing namespace std;', 'C++'],
      ['using System;\nclass P { static void Main() { Console.WriteLine(1); } }', 'C#'],
      ['#include <stdio.h>\nint main() { printf("hi"); return 0; }', 'C'],
      ['package main\nimport "fmt"\nfunc main() { fmt.Println(1) }', 'Go'],
      ['fn main() { println!("hi"); }', 'Rust'],
      ['fun main() { println("hi") }', 'Kotlin'],
      ['func greet() { print("hi") }', 'Swift'],
      ['interface Node { value: number }', 'TypeScript'],
      ['const x = 1;\nconsole.log(x);', 'JavaScript'],
      ['puts "hi"\n', 'Ruby'],
      ['defmodule Foo do\nend', 'Elixir'],
      ['-module(foo).\n-export([bar/0]).', 'Erlang'],
      ['object Main extends App', 'Scala'],
      ["import 'package:flutter/material.dart';", 'Dart'],
      ['#!/bin/bash\necho hi', 'Bash'],
      ['SELECT id FROM users WHERE active = 1;', 'MySQL'],
      ['<?php echo 1;', 'PHP'],
    ];
    for (const [code, expected] of cases) {
      expect(sniffLanguage(code), code).toBe(expected);
      // Sniffed names must round-trip canonicalisation (backend contract).
      expect(canonicalLanguage(expected), expected).toBe(expected);
    }
  });

  it('returns null for empty or unrecognisable code', () => {
    expect(sniffLanguage('')).toBeNull();
    expect(sniffLanguage('   \n  ')).toBeNull();
    expect(sniffLanguage(null)).toBeNull();
    expect(sniffLanguage(undefined)).toBeNull();
    expect(sniffLanguage('12345 + 67890')).toBeNull();
  });
});
