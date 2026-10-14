export const LANG_TOKENS = [
  { re: /\btypescript\b/i, name: 'TypeScript' },
  { re: /\bpython\s*(?:3|3\.\d+|\d+)\b/i, name: 'Python3' },
  { re: /\bpython\d*\b/i, name: 'Python' },
  { re: /\bjavascript\b/i, name: 'JavaScript' },
  { re: /\bnode\.?js\b/i, name: 'Node.js' },
  { re: /\bkotlin\b/i, name: 'Kotlin' },
  { re: /\bswift\b/i, name: 'Swift' },
  { re: /\brust\b/i, name: 'Rust' },
  { re: /\bruby\b/i, name: 'Ruby' },
  { re: /\bscala\b/i, name: 'Scala' },
  { re: /\bdart\b/i, name: 'Dart' },
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
    re: /wrong answer|time limit exceeded|memory limit exceeded|runtime error|compilation error|compile error|output limit exceeded|internal error|judging error|presentation error|accepted with warnings|segfault/i,
  },
  {
    verdict: 'accepted',
    re: /correct answer|\baccepted\b/i,
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
  return [el.getAttribute && el.getAttribute('value'), el.value, textOf(el)].filter(Boolean);
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

function cleanEditorText(text) {
  if (text === null || text === undefined) return null;
  const cleaned = String(text).replace(/[\u200b\u200c\u200d\ufeff]/g, '');
  return cleaned.trim() ? cleaned : null;
}

export function editorText(el) {
  if (!el) return null;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    return cleanEditorText(el.value);
  }
  const lines = queryAll(el, '.cm-line, .CodeMirror-line, .view-line');
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
