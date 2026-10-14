import { BACKOFF, JOB_POLL, MAX_ATTEMPTS } from './config.js';

export function computeBackoff(attempt, { base = BACKOFF.base, factor = BACKOFF.factor, cap = BACKOFF.cap, jitter = true, rng = Math.random } = {}) {
  let n = attempt < 1 ? 1 : attempt;
  let delay = Math.min(cap, base * factor ** (n - 1));
  if (jitter) {
    delay = delay / 2 + rng() * (delay / 2);
  }
  return Math.max(0, Math.min(cap, delay));
}

export function shouldRetry(attemptsMade, maxAttempts = MAX_ATTEMPTS) {
  return attemptsMade < maxAttempts;
}

export function computePollDelay(attempt) {
  const n = attempt < 1 ? 1 : attempt;
  return Math.min(JOB_POLL.max, JOB_POLL.min * 2 ** (n - 1));
}

export function nextAttemptAt(attempts, now, opts) {
  return now + Math.round(computeBackoff(attempts, opts) * 1000);
}

export function enqueueItem(queue, submission, { now = Date.now() } = {}) {
  const list = Array.isArray(queue) ? queue : [];
  const fingerprint = submission.fingerprint;
  const existing = list.find((item) => item.fingerprint === fingerprint);
  if (existing) {
    if (existing.state === 'done') {
      return {
        queue: list.filter((item) => item.fingerprint !== fingerprint),
        deduped: true,
        dropped: existing,
        added: null,
      };
    }
    return { queue: list, deduped: true, dropped: null, added: null };
  }
  const item = {
    fingerprint,
    submission,
    state: 'pending',
    attempts: 0,
    next_attempt_at: now,
    last_error: null,
    job_id: null,
    created_at: now,
  };
  return { queue: [...list, item], deduped: false, dropped: null, added: item };
}

export function removeItem(queue, fingerprint) {
  const list = Array.isArray(queue) ? queue : [];
  const removed = list.find((item) => item.fingerprint === fingerprint) || null;
  return {
    queue: removed ? list.filter((item) => item.fingerprint !== fingerprint) : list,
    removed,
  };
}

export function updateItem(queue, fingerprint, patch) {
  return (Array.isArray(queue) ? queue : []).map((item) =>
    item.fingerprint === fingerprint ? { ...item, ...patch } : item,
  );
}

export function selectDue(queue, now = Date.now()) {
  return (Array.isArray(queue) ? queue : []).filter(
    (item) => item.state === 'pending' && item.next_attempt_at <= now,
  );
}

export function selectPolls(queue, now = Date.now()) {
  return (Array.isArray(queue) ? queue : []).filter(
    (item) => item.state === 'syncing' && item.job_id != null && item.next_attempt_at <= now,
  );
}

export function gateDue(items, paused) {
  return paused ? [] : items;
}

export function summarize(queue) {
  const list = Array.isArray(queue) ? queue : [];
  const counts = { pending: 0, syncing: 0, done: 0, failed: 0 };
  for (const item of list) {
    if (counts[item.state] !== undefined) counts[item.state] += 1;
  }
  return {
    ...counts,
    queueLength: list.length,
    pendingTotal: counts.pending + counts.syncing,
  };
}

export function clearFailed(queue) {
  const list = Array.isArray(queue) ? queue : [];
  const removed = list.filter((item) => item.state === 'failed');
  return { queue: list.filter((item) => item.state !== 'failed'), removed };
}

export function markPendingRetry(item, now = Date.now()) {
  return {
    ...item,
    state: 'pending',
    attempts: 0,
    polls: 0,
    next_attempt_at: now,
    last_error: null,
  };
}
