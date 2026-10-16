export const LANG_TOKENS = [
  { re: /\btypescript\b/i, name: 'TypeScript' },
  { re: /\bpython\s*(?:3|3\.\d+|\d+)\b/i, name: 'Python3' },
  { re: /\bpython\d*\b/i, name: 'Python' },
  { re: /\bpypy\s*\d*\b/i, name: 'Python3' },
  { re: /\bjavascript\b/i, name: 'JavaScript' },
  { re: /\bnode\.?js\b/i, name: 'Node.js' },
  { re: /\bkotlin\b/i, name: 'Kotlin' },
  { re: /\bswift\b/i, name: 'Swift' },
  { re: /\brust\b/i, name: 'Rust' },
  { re: /\bruby\b/i, name: 'Ruby' },
  { re: /\bscala\b/i, name: 'Scala' },
  { re: /\bdart\b/i, name: 'Dart' },
  { re: /\belixir\b/i, name: 'Elixir' },
  { re: /\berlang\b/i, name: 'Erlang' },
  { re: /\bc\+\+/i, name: 'C++' },
  { re: /\bcpp\b/i, name: 'C++' },
  { re: /\bc#|\bcsharp\b/i, name: 'C#' },
  { re: /\bgolang\b/i, name: 'Go' },
  { re: /\bgo\b/i, name: 'Go' },
  { re: /\bjava\b/i, name: 'Java' },
  { re: /\bphp\b/i, name: 'PHP' },
  { re: /\bbash\b|\bshell\b/i, name: 'Bash' },
  { re: /\bmysql\b/i, name: 'MySQL' },
  { re: /\bpostgres(?:ql)?\b/i, name: 'PostgreSQL' },
  { re: /\bmssql\b|\bms sql\b|\bsql server\b/i, name: 'MS SQL' },
  { re: /\boracle\b/i, name: 'Oracle' },
  { re: /\bplain ?text\b/i, name: 'Plain Text' },
  { re: /\br\b/i, name: 'R' },
  { re: /\bc\b/i, name: 'C' },
];

export const VERDICT_RULES = [
  {
    verdict: 'rejected',
    re: /wrong answer|partially correct|time limit exceeded|memory limit exceeded|runtime error|compilation error|compile error|output limit exceeded|internal error|judging error|presentation error|accepted with warnings|segfault/i,
  },
  {
    verdict: 'accepted',
    // GFG: "Problem Solved Successfully"; CodeChef: "Correct"/"Correct Answer";
    // LeetCode: "Accepted". Bare "correct" is anchored to avoid prose matches.
    re: /correct answer|problem solved successfully|^\s*correct\s*$|\baccepted\b/im,
  },
  {
    verdict: 'pending',
    re: /pending|judging|in queue|\brunning\b|compiling|under evaluation|processing|queued/i,
  },
];

export function safeQuery(selector) {
  try {
    return selector;
  } catch {
    return null;
  }
}

export function queryAll(doc, selector) {
  if (!doc || !doc.querySelectorAll || !selector) return [];
  try {
    return Array.from(doc.querySelectorAll(selector));
  } catch {
    return [];
  }
}

export function firstEl(doc, selectors) {
  for (const selector of Array.isArray(selectors) ? selectors : [selectors]) {
    const nodes = queryAll(doc, selector);
    if (nodes.length) return nodes[0];
  }
  return null;
}

export function textOf(el) {
  if (!el) return '';
  const raw = el.textContent || '';
  return raw.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

export function firstText(doc, selectors) {
  for (const selector of Array.isArray(selectors) ? selectors : [selectors]) {
    for (const el of queryAll(doc, selector)) {
      const text = textOf(el);
      if (text) return text;
    }
  }
  return null;
}

export function findText(doc, selectors, re) {
  for (const selector of Array.isArray(selectors) ? selectors : [selectors]) {
    for (const el of queryAll(doc, selector)) {
      const text = textOf(el);
      if (text && (!re || re.test(text))) return text;
    }
  }
  return null;
}

export function matchVerdict(text) {
  if (!text) return 'unknown';
  for (const rule of VERDICT_RULES) {
    if (rule.re.test(text)) return rule.verdict;
  }
  return 'unknown';
}

export function extractStatus(doc, selectors) {
  const text = firstText(doc, selectors);
  if (!text) return 'unknown';
  return matchVerdict(text);
}

export function canonicalLanguage(raw) {
  if (!raw) return null;
  const text = String(raw);
  for (const token of LANG_TOKENS) {
    if (token.re.test(text)) return token.name;
  }
  return null;
}

function languageCandidates(el) {
  if (!el) return [];
  if (el.tagName === 'SELECT') {
    const index = typeof el.selectedIndex === 'number' ? el.selectedIndex : -1;
    const option = index >= 0 ? el.options?.[index] : el.querySelector('option[selected]');
    return [option && option.value, option && option.textContent, el.value].filter(Boolean);
  }
  // Custom dropdowns (semantic-ui, MUI, LeetCode): the *selected* entry must win.
  // textOf(el) over the whole container would concatenate every hidden option,
  // letting the first matching LANG_TOKEN (e.g. TypeScript) shadow the real
  // selection (e.g. Python3) — so container text is only the last resort.
  const selected =
    el.querySelector &&
    el.querySelector(
      '[aria-selected="true"],[aria-checked="true"],[data-selected="true"],.divider.text,.selected,[class*="selected"]',
    );
  return [
    el.getAttribute && el.getAttribute('value'),
    el.value,
    selected && textOf(selected),
    el.getAttribute && el.getAttribute('aria-label'),
    textOf(el),
  ].filter(Boolean);
}

function detectOnElement(el) {
  for (const candidate of languageCandidates(el)) {
    const canon = canonicalLanguage(candidate);
    if (canon) return canon;
  }
  return null;
}

export function detectLanguage(doc, selectors = []) {
  for (const selector of selectors) {
    for (const el of queryAll(doc, selector)) {
      const canon = detectOnElement(el);
      if (canon) return canon;
    }
  }
  // The editor itself (via the page-world bridge) is the authoritative source
  // when the DOM hides the language control — e.g. LeetCode renders it in
  // obfuscated React markup that no selector reliably matches.
  const bridged = getBridgeLang();
  if (bridged) return bridged;
  const generic = queryAll(
    doc,
    '[class*="lang"],[class*="Lang"],[id*="lang"],[id*="Lang"],[class*="pill"],[class*="dropdown"],select',
  );
  for (const el of generic) {
    const canon = detectOnElement(el);
    if (canon) return canon;
  }
  return null;
}

// Last-resort language detection from the solution's own syntax, used when
// neither the DOM nor the editor bridge can report a language. The backend
// rejects `unknown` with INVALID_FILE, so any confident match here is strictly
// better than nothing. Every emitted name is a LANG_TOKENS canonical name.
const SNIFF_RULES = [
  ['PHP', /<\?php\b/],
  [
    'Python3',
    /(?:^|\n)[ \t]*(?:def\s+\w+\s*\([^)]*\)\s*(?:->[^\n]*)?:|class\s+\w+\s*:(?=\n|$)|from\s+[\w.]+\s+import\s+\w|import\s+(?:numpy|sys|collections|math|typing|re|heapq|itertools|functools)\b)/,
  ],
  ['Java', /\bSystem\.out\.print|\bpublic\s+(?:static|class)\b|\bnew\s+(?:ArrayList|HashMap|StringBuilder)</],
  [
    'C++',
    /\busing\s+namespace\s+std\s*;|\bstd::|#include\s*<(?:vector|string|iostream|map|algorithm|set|queue|stack|unordered_map)>/,
  ],
  ['C#', /\busing\s+System\s*;|Console\.WriteLine/],
  ['C', /#include\s*<stdio\.h>|\b(?:int|void)\s+main\s*\(|\bprintf\s*\(/],
  ['Go', /\bfmt\.(?:Print|Sprintf)|\bpackage\s+main\b/],
  ['Rust', /\bfn\s+main\s*\(|println!|\blet\s+mut\s+/],
  ['Kotlin', /(?:^|\n)[ \t]*fun\s+\w+/],
  ['Swift', /\bfunc\s+\w+\s*\(|import\s+Foundation/],
  ['TypeScript', /interface\s+\w+\s*\{|:\s*(?:string|number|boolean)\s*[;)=,]/],
  ['JavaScript', /console\.log\s*\(|=>|\b(?:const|let)\s+\w+\s*=|\bclass\s+\w+\s*\{/],
  ['Ruby', /(?:^|\n)[ \t]*(?:puts\s|require\s+['"])/],
  ['Elixir', /\bdefmodule\s+\w+\s+do\b|\bdefp\s+\w+/],
  ['Erlang', /-module\(|-export\(/],
  ['Scala', /\bobject\s+\w+\s+extends\b/],
  ['Dart', /import\s+['"]package:/],
  ['Bash', /#!\s*\/bin\/(?:ba)?sh|(?:^|\n)[ \t]*echo\s/],
  ['MySQL', /(?:^|\n)[ \t]*(?:select\b[\s\S]*?\bfrom\b|insert\s+into\b|create\s+table\b)/i],
];

export function sniffLanguage(code) {
  if (typeof code !== 'string' || !code.trim()) return null;
  for (const [name, re] of SNIFF_RULES) {
    if (re.test(code)) return name;
  }
  return null;
}

function cleanEditorText(text) {
  if (text === null || text === undefined) return null;
  const cleaned = String(text).replace(/[\u200b\u200c\u200d\ufeff]/g, '');
  return cleaned.trim() ? cleaned : null;
}

// Full text (and reported language) of virtualized editors (Monaco/ACE)
// captured by the page-world bridge (content/bridge.js). DOM extraction only
// sees the lines rendered in the viewport, so long solutions would otherwise
// be truncated silently — and some sites (LeetCode) hide the language control
// entirely, while the editor model still knows the language.
let bridgeText = { monaco: null, ace: null, monacoLang: null, aceLang: null, at: 0 };

function langOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function setBridgeText(next) {
  bridgeText = {
    monaco: next && next.monaco ? String(next.monaco) : null,
    ace: next && next.ace ? String(next.ace) : null,
    // Raw editor language ids ("python3", "ace/mode/python" basename …) —
    // canonicalised on read by getBridgeLang().
    monacoLang: langOrNull(next && next.monacoLang),
    aceLang: langOrNull(next && next.aceLang),
    at: (next && next.at) || Date.now(),
  };
}

export function getBridgeText() {
  return bridgeText;
}

export function getBridgeLang() {
  return canonicalLanguage(bridgeText.monacoLang) || canonicalLanguage(bridgeText.aceLang);
}

export function editorText(el) {
  if (!el) return null;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    return cleanEditorText(el.value);
  }
  const bridge = bridgeText;
  const classes = el.classList;
  if (classes && classes.contains('monaco-editor') && bridge.monaco) {
    return cleanEditorText(bridge.monaco);
  }
  if (bridge.ace && classes && (classes.contains('ace_editor') || (el.querySelector && el.querySelector('.ace_content')))) {
    return cleanEditorText(bridge.ace);
  }
  const lines = queryAll(el, '.cm-line, .CodeMirror-line, .view-line, .ace_line');
  if (lines.length) {
    return cleanEditorText(lines.map((line) => line.textContent).join('\n'));
  }
  if (el.classList && el.classList.contains('cm-content')) {
    const cmLines = queryAll(el, '.cm-line');
    if (cmLines.length) return cleanEditorText(cmLines.map((line) => line.textContent).join('\n'));
  }
  return cleanEditorText(el.value !== undefined && el.value !== '' ? el.value : el.textContent);
}

export function extractCode(doc, selectors) {
  for (const selector of Array.isArray(selectors) ? selectors : [selectors]) {
    for (const el of queryAll(doc, selector)) {
      const text = editorText(el);
      if (text) return text;
    }
  }
  return null;
}

export function cleanTitle(raw, suffixes = []) {
  if (!raw) return null;
  let title = String(raw).replace(/\s+/g, ' ').trim();
  for (const suffix of suffixes) {
    if (title.toLowerCase().endsWith(suffix.toLowerCase())) {
      title = title.slice(0, title.length - suffix.length).trim();
    }
  }
  title = title.replace(/\s*[|–—-]\s*$/, '').trim();
  return title || null;
}

export function parseWhen(text, now = Date.now()) {
  if (!text) return null;
  const value = String(text).trim();
  if (/\d{4}-\d{2}-\d{2}/.test(value)) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const relative = /(\d+)\s*(second|minute|hour|day|week|month)s?\s*ago/i.exec(value);
  if (relative) {
    const amount = Number(relative[1]);
    const units = {
      second: 1000,
      minute: 60000,
      hour: 3600000,
      day: 86400000,
      week: 604800000,
      month: 2592000000,
    };
    return now - amount * units[relative[2].toLowerCase()];
  }
  return null;
}

export function attrText(doc, selectors, attr) {
  const el = firstEl(doc, selectors);
  if (!el) return null;
  const value = el.getAttribute(attr);
  return value && value.trim() ? value.trim() : null;
}

export function slugFromUrl(url, pattern) {
  try {
    const parsed = new URL(url);
    const match = pattern.exec(parsed.pathname);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export function joinLines(nodes) {
  const lines = nodes.map((node) => node.textContent).join('\n');
  return cleanEditorText(lines);
}

export function canonicalUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return String(url);
  }
}

export function detectSubmission(adapter, doc, url, now = Date.now()) {
  if (!adapter || !adapter.capabilities || !adapter.capabilities.submission_detection) return null;
  const metadata = adapter.extractProblemMetadata(doc, url);
  if (!metadata || !metadata.title) return null;
  const verdict = adapter.capabilities.verdict_extraction
    ? adapter.extractSubmissionStatus(doc)
    : 'unknown';
  const code = adapter.capabilities.solution_code_extraction ? adapter.extractSolutionCode(doc) : null;
  const external_id = adapter.extractSubmissionId ? adapter.extractSubmissionId(doc, url) : null;
  const submitted_at = adapter.extractSubmittedAt ? adapter.extractSubmittedAt(doc, url, now) : null;
  const language = detectLanguage(doc, adapter.languageSelectors || []);
  const evidence = Boolean(code) || external_id !== null || verdict !== 'unknown';
  if (!evidence) return null;
  return { metadata, verdict, code, language, external_id, submitted_at };
}
