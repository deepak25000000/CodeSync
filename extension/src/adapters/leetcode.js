import { hostsForPlatform } from '../shared/hostallow.js';
import {
  attrText,
  canonicalUrl,
  cleanTitle,
  detectSubmission,
  extractCode,
  extractStatus,
  findText,
  firstText,
  parseWhen,
  slugFromUrl,
} from './shared.js';

const HOSTS = hostsForPlatform('leetcode');

const STATUS_SELECTORS = [
  '[data-e2e-locator="submission-status"]',
  '.submission-status',
  '[class*="verdict"]',
  '[class*="judge-result"]',
  '.submission-result',
  '#result-panel [class*="status"]',
];

const CODE_SELECTORS = [
  '.cm-content',
  '.CodeMirror-code',
  '.monaco-editor',
  'textarea[name="code"]',
  '#codeEditor',
  '.editor textarea',
];

const LANGUAGE_SELECTORS = [
  '[data-cy="lang-select"]',
  '.lang-select',
  'select[name="language"]',
  '[class*="lang-select"]',
  '[class*="language-select"]',
  // Live LeetCode UI: React-rendered control without legacy class names.
  '[data-e2e-locator*="lang" i]',
  '#lang-select',
  '[aria-label*="language" i]',
];

const TITLE_SELECTORS = [
  '[data-cy="question-title"]',
  '.question-title',
  '[class*="question-title"]',
  'h1[data-cy="question-title"]',
];

const leetcode = {
  id: 'leetcode',
  hosts: HOSTS,
  capabilities: {
    submission_detection: true,
    verdict_extraction: true,
    solution_code_extraction: true,
    problem_metadata: true,
    manual_sync: true,
  },
  languageSelectors: LANGUAGE_SELECTORS,

  canHandle(url) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
    } catch {
      return false;
    }
  },

  detectPage(url) {
    if (!leetcode.canHandle(url)) return false;
    let pathname = '';
    try {
      pathname = new URL(url).pathname;
    } catch {
      return false;
    }
    return /\/problems\/[^/]+/.test(pathname) || /\/submissions/.test(pathname);
  },

  extractProblemMetadata(doc, url) {
    const slug = slugFromUrl(url, /\/problems\/([^/]+)/);
    const rawTitle = firstText(doc, TITLE_SELECTORS) || cleanTitle(doc.title, [' - LeetCode', ' - LeetCode.cn']);
    const title = cleanTitle(rawTitle, [' - LeetCode']);
    if (!title) return null;
    const numericId = attrText(doc, ['[data-question-id]'], 'data-question-id');
    return {
      title,
      problem_id: slug || numericId || null,
      url: canonicalUrl(url),
      platform: 'leetcode',
    };
  },

  extractSubmissionStatus(doc) {
    return extractStatus(doc, STATUS_SELECTORS);
  },

  extractSolutionCode(doc) {
    return extractCode(doc, CODE_SELECTORS);
  },

  extractSubmissionId(doc, url) {
    const fromUrl = slugFromUrl(url, /\/submissions\/(\d+)/);
    if (fromUrl) return fromUrl;
    const text = findText(
      doc,
      ['[data-e2e-locator="submission-id"]', '#submission-id', '.submission-id'],
      /submission id|#?\d{3,}/i,
    );
    const match = text && /(\d{3,})/.exec(text);
    return match ? match[1] : null;
  },

  extractSubmittedAt(doc, url, now) {
    const iso = attrText(doc, ['time[datetime]', '[datetime]'], 'datetime');
    if (iso) {
      const parsed = Date.parse(iso);
      if (!Number.isNaN(parsed)) return parsed;
    }
    const text = firstText(doc, [
      '[data-e2e-locator="submission-date"]',
      '.submission-time',
      '.submission-date',
      '[class*="submitted-time"]',
    ]);
    return parseWhen(text, now);
  },

  detect_submission(doc, url, now) {
    return detectSubmission(leetcode, doc, url, now);
  },
};

export default leetcode;
