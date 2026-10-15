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

// Problem-title elements only. A bare `h1` is deliberately NOT trusted:
// CodeChef problem pages have no h1 of their own, so any h1 we find is a
// promo/onboarding heading (e.g. "Welcome to the CodeChef AI Tutor").
const TITLE_SELECTORS = [
  '.problem-title',
  '[class*="problem-title"]',
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
    // "Two Sum Practice Problem in Linked Lists" → "Two Sum"
    const stripMarker = (t) => t.replace(/\s+Practice Problem in\s+.+$/i, '').trim() || t;

    // CodeChef renders a per-problem server <title> carrying the "Practice
    // Problem in <course>" marker, but the SPA keeps a STALE document.title
    // after client-side navigation (a leaked welcome-page title once caused a
    // different problem's file to be overwritten). So <title> is trusted ONLY
    // with that marker; otherwise fall back to problem-title elements and
    // finally to the URL slug, which is always the problem actually open.
    let title = '';
    const tagTitle = cleanTitle(doc.title, suffixes);
    if (tagTitle && /practice problem in\s+/i.test(tagTitle)) title = stripMarker(tagTitle);
    if (!title) {
      const fromElements = cleanTitle(firstText(doc, TITLE_SELECTORS), suffixes);
      if (fromElements) title = stripMarker(fromElements);
    }
    if (!title && slug) title = slug;
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
