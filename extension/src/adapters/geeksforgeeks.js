import { hostsForPlatform } from '../shared/hostallow.js';
import {
  attrText,
  canonicalUrl,
  cleanTitle,
  detectSubmission,
  extractCode,
  extractStatus,
  firstText,
  parseWhen,
  slugFromUrl,
} from './shared.js';

const HOSTS = hostsForPlatform('geeksforgeeks');

const STATUS_SELECTORS = [
  '.gfg-result',
  '#submission-result',
  '.submission-result',
  '.result-row',
  '[class*="verdict"]',
  '.result',
];

const CODE_SELECTORS = [
  // Live GFG problem pages render an ACE editor (#ace-editor), not CodeMirror.
  '#ace-editor',
  '.ace_editor:not(.ace_autocomplete)',
  '.ace_content',
  '.CodeMirror-code',
  '.cm-content',
  '.monaco-editor',
  'textarea#SolutionInput',
  'textarea[name="solution"]',
  '.editor textarea',
];

const LANGUAGE_SELECTORS = [
  // Semantic-UI dropdown: selected value lives in .divider.text ("C (gcc 5.4)").
  '[class*="language_dropdown"] .divider.text',
  '[class*="language_dropdown"]',
  'select#language',
  'select#lang',
  '#language-select',
  'select[name="language"]',
  '.language-dropdown',
];

const TITLE_SELECTORS = [
  '.problem-title',
  'h3.problem-title',
  '[itemprop="name"]',
  '[class*="problems_header_content"] h3',
  'h1',
];

const geeksforgeeks = {
  id: 'geeksforgeeks',
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
    if (!geeksforgeeks.canHandle(url)) return false;
    let pathname = '';
    try {
      pathname = new URL(url).pathname;
    } catch {
      return false;
    }
    return /\/problems\/[^/]+/.test(pathname) || /\/user\/[^/]+\/submissions/.test(pathname);
  },

  extractProblemMetadata(doc, url) {
    const slug = slugFromUrl(url, /\/problems\/([^/]+)/);
    const suffixes = [' | GeeksforGeeks', ' - GeeksforGeeks', ' | Practice'];
    const rawTitle = firstText(doc, TITLE_SELECTORS) || cleanTitle(doc.title, suffixes);
    const title = cleanTitle(rawTitle, suffixes);
    if (!title) return null;
    const codeText = firstText(doc, ['.problem-code', '#problemCode', '[class*="problem-code"]']);
    return {
      title,
      problem_id: codeText || slug || null,
      url: canonicalUrl(url),
      platform: 'geeksforgeeks',
    };
  },

  extractSubmissionStatus(doc) {
    return extractStatus(doc, STATUS_SELECTORS);
  },

  extractSolutionCode(doc) {
    return extractCode(doc, CODE_SELECTORS);
  },

  extractSubmissionId() {
    return null;
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
    return detectSubmission(geeksforgeeks, doc, url, now);
  },
};

export default geeksforgeeks;
