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

const HOSTS = hostsForPlatform('codechef');

const STATUS_SELECTORS = [
  '.cc-verdict',
  '.verdict',
  '#submission-result',
  '.submission-result',
  '.result-panel',
  '.result',
];

const CODE_SELECTORS = [
  // Live CodeChef practice pages render an ACE editor (#submit-ide-v2).
  '#submit-ide-v2',
  '.ace_editor:not(.ace_autocomplete)',
  '.ace_content',
  '.CodeMirror-code',
  '.cm-content',
  '.monaco-editor',
  'textarea#solution',
  'textarea#editor',
  '.editor textarea',
];

const LANGUAGE_SELECTORS = [
  'select#language',
  '#language-select',
  'select[name="language"]',
  '.language-dropdown',
  '.lang-dropdown',
];

const TITLE_SELECTORS = [
  '.problem-title',
  '[class*="problem-title"]',
  'h1',
];

const codechef = {
  id: 'codechef',
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
    if (!codechef.canHandle(url)) return false;
    let pathname = '';
    try {
      pathname = new URL(url).pathname;
    } catch {
      return false;
    }
    return (
      /\/problems\/[^/]+/.test(pathname) ||
      /\/submissions\/[^/]+/.test(pathname) ||
      /\/(?:viewsubmission|viewsolution)\/\d+/.test(pathname) ||
      /\/practice\/problems\//.test(pathname) ||
      /\/practice\/course\/[^/]+\/[^/]+\/problems\/[^/]+/.test(pathname)
    );
  },

  extractProblemMetadata(doc, url) {
    const slug = slugFromUrl(url, /\/problems\/([^/]+)/);
    const suffixes = [' | CodeChef', ' - CodeChef'];
    const rawTitle = firstText(doc, TITLE_SELECTORS) || cleanTitle(doc.title, suffixes);
    let title = cleanTitle(rawTitle, suffixes);
    // <title> format: "Two Sum Practice Problem in Linked Lists" → "Two Sum"
    if (title) title = title.replace(/\s+Practice Problem in .+$/i, '').trim() || title;
    if (!title) return null;
    return {
      title,
      problem_id: slug || null,
      url: canonicalUrl(url),
      platform: 'codechef',
    };
  },

  extractSubmissionStatus(doc) {
    return extractStatus(doc, STATUS_SELECTORS);
  },

  extractSolutionCode(doc) {
    return extractCode(doc, CODE_SELECTORS);
  },

  extractSubmissionId(doc, url) {
    const fromUrl = slugFromUrl(url, /\/(?:submissions|viewsubmission|viewsolution)\/([^/]+)/);
    if (fromUrl) return fromUrl;
    const text = findText(doc, ['#submission-id', '.submission-id', '[class*="submission-id"]'], /#?\d{3,}/);
    const match = text && /(\d{3,})/.exec(text);
    return match ? match[1] : null;
  },

  extractSubmittedAt(doc, url, now) {
    const iso = attrText(doc, ['time[datetime]', '[datetime]'], 'datetime');
    if (iso) {
      const parsed = Date.parse(iso);
      if (!Number.isNaN(parsed)) return parsed;
    }
    const text = firstText(doc, ['.submission-time', '.timeago', '[class*="submitted"]', '.time']);
    return parseWhen(text, now);
  },

  detect_submission(doc, url, now) {
    return detectSubmission(codechef, doc, url, now);
  },
};

export default codechef;
