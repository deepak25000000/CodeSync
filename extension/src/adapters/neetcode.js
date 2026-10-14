import { hostsForPlatform } from '../shared/hostallow.js';
import { canonicalUrl, cleanTitle, firstText, slugFromUrl } from './shared.js';

const HOSTS = hostsForPlatform('neetcode');

const TITLE_SELECTORS = [
  '.problem-title',
  '.nc-problem-title',
  '[class*="problem-title"]',
  'h1',
  'h2',
];

const neetcode = {
  id: 'neetcode',
  hosts: HOSTS,
  capabilities: {
    submission_detection: false,
    verdict_extraction: false,
    solution_code_extraction: false,
    problem_metadata: true,
    manual_sync: true,
  },
  languageSelectors: [],

  canHandle(url) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
    } catch {
      return false;
    }
  },

  detectPage(url, doc) {
    if (!neetcode.canHandle(url)) return false;
    let pathname = '';
    try {
      pathname = new URL(url).pathname;
    } catch {
      return false;
    }
    if (/\/(practice|roadmap|problems|problem)\b/.test(pathname)) return true;
    return Boolean(doc && neetcode.extractProblemMetadata(doc, url));
  },

  extractProblemMetadata(doc, url) {
    const slug = slugFromUrl(url, /\/problems\/([^/]+)/);
    const rawTitle = firstText(doc, TITLE_SELECTORS) || cleanTitle(doc.title, [' - NeetCode']);
    const title = cleanTitle(rawTitle, [' - NeetCode']);
    if (!title) return null;
    if (/^neetcode$/i.test(title)) return null;
    return {
      title,
      problem_id: slug || null,
      url: canonicalUrl(url),
      platform: 'neetcode',
    };
  },

  extractSubmissionStatus() {
    return 'unknown';
  },

  extractSolutionCode() {
    return null;
  },

  extractSubmissionId() {
    return null;
  },

  extractSubmittedAt() {
    return null;
  },

  detect_submission() {
    return null;
  },
};

export default neetcode;
