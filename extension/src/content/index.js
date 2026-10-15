import { buildManualSubmission, matchHost, normalize_submission } from '../adapters/index.js';
import { isAllowedUrl } from '../shared/hostallow.js';
import { fail, ok, validateContentMessage } from '../shared/schema.js';
import { sendRuntimeMessage } from '../shared/messaging.js';

const emitted = new Set();
let lastHealth = null;
let debounceTimer = null;

function pageSubmission(adapter, doc, url, now) {
  const raw = adapter.detect_submission(doc, url, now);
  if (raw) {
    const submission = normalize_submission(adapter, raw);
    if (submission) {
      return { submission, mode: submission.verdict === 'accepted' ? 'auto' : 'manual' };
    }
  }
  if (adapter.capabilities.problem_metadata && adapter.capabilities.manual_sync) {
    const submission = buildManualSubmission(adapter, doc, url, { now });
    if (submission) return { submission, mode: 'manual' };
  }
  return { submission: null, mode: null };
}

function reportHealth(platform, verdict) {
  lastHealth = { platform, verdict, at: Date.now() };
  console.debug('[codesync] health', lastHealth);
}

function emit(submission) {
  sendRuntimeMessage({ type: 'ENQUEUE', payload: submission })
    .then((response) => {
      if (!response || response.ok !== true) {
        const message = (response && response.error && response.error.message) || 'enqueue failed';
        console.debug('[codesync] enqueue rejected:', message);
        emitted.delete(submission.fingerprint);
      }
    })
    .catch(() => {
      emitted.delete(submission.fingerprint);
    });
}

function scan(now = Date.now()) {
  const url = location.href;
  const adapter = matchHost(url);
  if (!adapter || !isAllowedUrl(url)) return;
  if (!adapter.detectPage(url, document)) return;
  if (!adapter.capabilities.submission_detection) return;
  const raw = adapter.detect_submission(document, url, now);
  if (!raw) return;
  if (raw.verdict === 'accepted') {
    const submission = normalize_submission(adapter, raw);
    if (!submission || !submission.code || !submission.code.trim()) return;
    if (emitted.has(submission.fingerprint)) return;
    emitted.add(submission.fingerprint);
    emit(submission);
    return;
  }
  if (raw.verdict === 'rejected' || raw.verdict === 'pending') {
    reportHealth(adapter.id, raw.verdict);
  }
}

function scheduleScan(delay = 400) {
  if (debounceTimer) return;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    scan();
  }, delay);
}

async function handleSyncPage() {
  const url = location.href;
  const adapter = matchHost(url);
  if (!adapter || !isAllowedUrl(url)) {
    return ok({ submission: null, reason: 'unsupported_host' });
  }
  if (!adapter.detectPage(url, document)) {
    return ok({ submission: null, reason: 'unsupported_page', platform: adapter.id });
  }
  const found = pageSubmission(adapter, document, url, Date.now());
  if (!found.submission) {
    return ok({ submission: null, reason: 'nothing_found', platform: adapter.id });
  }
  // The backend cannot sync an empty file (CODE_UNAVAILABLE). Refuse to enqueue
  // a doomed job: tell the user to open the editor/result view or paste code
  // in Options → Manual submission instead.
  if (!found.submission.code || !found.submission.code.trim()) {
    return ok({ submission: null, reason: 'nothing_found', platform: adapter.id });
  }
  if (found.mode !== 'auto' && found.submission.verdict !== 'accepted') {
    found.submission.verdict = 'manual';
  }
  return ok({
    submission: found.submission,
    mode: found.mode,
    platform: adapter.id,
    capabilities: adapter.capabilities,
  });
}

function bootstrap() {
  const url = location.href;
  const adapter = matchHost(url);
  if (!adapter || !isAllowedUrl(url)) return;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const validation = validateContentMessage(message);
    if (!validation.ok) {
      sendResponse(fail(validation.error.code, validation.error.message));
      return false;
    }
    if (validation.type === 'SYNC_PAGE') {
      handleSyncPage()
        .then(sendResponse)
        .catch((err) => sendResponse(fail('SYNC_PAGE_FAILED', err && err.message)));
      return true;
    }
    return false;
  });

  if (typeof MutationObserver !== 'undefined' && document.documentElement) {
    const observer = new MutationObserver(() => scheduleScan(400));
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  }

  scan();
  for (const delay of [1500, 4000, 10000]) {
    setTimeout(() => scan(), delay);
  }
}

bootstrap();
