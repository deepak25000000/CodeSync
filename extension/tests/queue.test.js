import { describe, expect, it } from 'vitest';
import {
  clearFailed,
  computeBackoff,
  computePollDelay,
  enqueueItem,
  gateDue,
  markPendingRetry,
  nextAttemptAt,
  removeItem,
  selectDue,
  selectPolls,
  shouldRetry,
  summarize,
  updateItem,
} from '../src/shared/queue.js';
import { makeSubmission } from './helpers/fixtures.js';

const NOW = 1767350000000;

describe('computeBackoff', () => {
  it('is exponential without jitter', () => {
    expect(computeBackoff(1, { jitter: false })).toBe(2);
    expect(computeBackoff(2, { jitter: false })).toBe(4);
    expect(computeBackoff(3, { jitter: false })).toBe(8);
    expect(computeBackoff(5, { jitter: false })).toBe(32);
  });

  it('is capped at 300 seconds', () => {
    for (const attempt of [10, 20, 100]) {
      expect(computeBackoff(attempt, { jitter: false })).toBe(300);
    }
    expect(computeBackoff(100, { jitter: true, rng: () => 0.999999 })).toBeLessThanOrEqual(300);
  });

  it('treats attempts below 1 as the first attempt', () => {
    expect(computeBackoff(0, { jitter: false })).toBe(2);
    expect(computeBackoff(-5, { jitter: false })).toBe(2);
  });

  it('applies equal jitter within [delay/2, delay]', () => {
    const samples = [0, 0.25, 0.5, 0.75, 0.999999];
    for (const attempt of [1, 2, 4, 8]) {
      const delay = computeBackoff(attempt, { jitter: false });
      for (const sample of samples) {
        const value = computeBackoff(attempt, { rng: () => sample });
        expect(value).toBeGreaterThanOrEqual(delay / 2 - 1e-9);
        expect(value).toBeLessThanOrEqual(delay + 1e-9);
      }
      expect(computeBackoff(attempt, { rng: () => 0 })).toBeCloseTo(delay / 2, 10);
      expect(computeBackoff(attempt, { rng: () => 1 })).toBeCloseTo(delay, 10);
    }
  });

  it('produces a monotonic schedule before the cap', () => {
    let previous = 0;
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const value = computeBackoff(attempt, { jitter: false });
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it('computes bounded poll delays from 3s to 30s', () => {
    expect(computePollDelay(1)).toBe(3);
    expect(computePollDelay(2)).toBe(6);
    expect(computePollDelay(3)).toBe(12);
    expect(computePollDelay(4)).toBe(24);
    expect(computePollDelay(5)).toBe(30);
    expect(computePollDelay(12)).toBe(30);
  });

  it('schedules the next attempt in the future', () => {
    const at = nextAttemptAt(1, NOW, { jitter: false });
    expect(at).toBe(NOW + 2000);
  });
});

describe('shouldRetry', () => {
  it('retries below the max attempts', () => {
    expect(shouldRetry(0, 5)).toBe(true);
    expect(shouldRetry(4, 5)).toBe(true);
  });

  it('stops at the max attempts', () => {
    expect(shouldRetry(5, 5)).toBe(false);
    expect(shouldRetry(6, 5)).toBe(false);
  });
});

describe('enqueueItem', () => {
  it('adds a pending item with defaults', () => {
    const submission = makeSubmission();
    const result = enqueueItem([], submission, { now: NOW });
    expect(result.deduped).toBe(false);
    expect(result.queue).toHaveLength(1);
    expect(result.added).toMatchObject({
      fingerprint: submission.fingerprint,
      state: 'pending',
      attempts: 0,
      next_attempt_at: NOW,
      last_error: null,
      job_id: null,
      created_at: NOW,
    });
  });

  it('dedupes by fingerprint', () => {
    const submission = makeSubmission();
    const first = enqueueItem([], submission, { now: NOW });
    const second = enqueueItem(first.queue, submission, { now: NOW + 1000 });
    expect(second.deduped).toBe(true);
    expect(second.queue).toHaveLength(1);
    expect(second.added).toBeNull();
  });

  it('drops a done item with the same fingerprint and reports a dedupe', () => {
    const submission = makeSubmission();
    const base = enqueueItem([], submission, { now: NOW });
    const doneQueue = updateItem(base.queue, submission.fingerprint, { state: 'done' });
    const result = enqueueItem(doneQueue, submission, { now: NOW + 5000 });
    expect(result.deduped).toBe(true);
    expect(result.dropped).toBeTruthy();
    expect(result.dropped.state).toBe('done');
    expect(result.queue).toHaveLength(0);
  });

  it('does not dedupe distinct fingerprints', () => {
    const a = enqueueItem([], makeSubmission({ fingerprint: 'a'.repeat(64) }), { now: NOW });
    const b = enqueueItem(a.queue, makeSubmission({ fingerprint: 'b'.repeat(64) }), { now: NOW });
    expect(b.deduped).toBe(false);
    expect(b.queue).toHaveLength(2);
  });
});

describe('queue selectors', () => {
  function seed() {
    const items = [
      { fingerprint: '1'.repeat(64), state: 'pending', next_attempt_at: NOW - 10, job_id: null },
      { fingerprint: '2'.repeat(64), state: 'pending', next_attempt_at: NOW + 60000, job_id: null },
      { fingerprint: '3'.repeat(64), state: 'failed', next_attempt_at: NOW - 10, job_id: null },
      { fingerprint: '4'.repeat(64), state: 'syncing', next_attempt_at: NOW + 5000, job_id: 7 },
    ];
    return items;
  }

  it('selects only due pending items', () => {
    const due = selectDue(seed(), NOW);
    expect(due).toHaveLength(1);
    expect(due[0].fingerprint).toBe('1'.repeat(64));
  });

  it('selects due job polls', () => {
    const items = seed();
    items[3].next_attempt_at = NOW - 1;
    const polls = selectPolls(items, NOW);
    expect(polls).toHaveLength(1);
    expect(polls[0].job_id).toBe(7);
  });

  it('is not affected by pause state on its own', () => {
    const items = seed();
    expect(selectDue(items, NOW)).toHaveLength(1);
    expect(gateDue(selectDue(items, NOW), false)).toHaveLength(1);
    expect(gateDue(selectDue(items, NOW), true)).toHaveLength(0);
    expect(selectDue(items, NOW)).toHaveLength(1);
  });
});

describe('queue mutations', () => {
  it('removes by fingerprint', () => {
    const submission = makeSubmission();
    const { queue } = enqueueItem([], submission, { now: NOW });
    const result = removeItem(queue, submission.fingerprint);
    expect(result.queue).toHaveLength(1 - 1);
    expect(result.removed.fingerprint).toBe(submission.fingerprint);
    expect(removeItem(result.queue, submission.fingerprint).removed).toBeNull();
  });

  it('updates an item without mutating the original', () => {
    const submission = makeSubmission();
    const { queue } = enqueueItem([], submission, { now: NOW });
    const next = updateItem(queue, submission.fingerprint, { state: 'failed' });
    expect(queue[0].state).toBe('pending');
    expect(next[0].state).toBe('failed');
  });

  it('clears failed items only', () => {
    const a = enqueueItem([], makeSubmission({ fingerprint: 'a'.repeat(64) }), { now: NOW }).queue;
    const b = enqueueItem(a, makeSubmission({ fingerprint: 'b'.repeat(64) }), { now: NOW }).queue;
    const mixed = updateItem(b, 'a'.repeat(64), { state: 'failed' });
    const result = clearFailed(mixed);
    expect(result.queue).toHaveLength(1);
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0].fingerprint).toBe('a'.repeat(64));
  });

  it('resets an item for a manual retry', () => {
    const item = {
      fingerprint: 'c'.repeat(64),
      state: 'failed',
      attempts: 5,
      polls: 9,
      next_attempt_at: NOW + 90000,
      last_error: { code: 'HTTP_500', message: 'boom' },
      job_id: 3,
    };
    const reset = markPendingRetry(item, NOW);
    expect(reset).toMatchObject({
      state: 'pending',
      attempts: 0,
      polls: 0,
      next_attempt_at: NOW,
      last_error: null,
    });
    expect(reset.job_id).toBe(3);
  });

  it('summarizes counts', () => {
    const a = enqueueItem([], makeSubmission({ fingerprint: 'a'.repeat(64) }), { now: NOW }).queue;
    const b = enqueueItem(a, makeSubmission({ fingerprint: 'b'.repeat(64) }), { now: NOW }).queue;
    let queue = updateItem(b, 'a'.repeat(64), { state: 'failed' });
    queue = updateItem(queue, 'b'.repeat(64), { state: 'syncing' });
    expect(summarize(queue)).toEqual({
      pending: 0,
      syncing: 1,
      done: 0,
      failed: 1,
      queueLength: 2,
      pendingTotal: 1,
    });
    expect(summarize(null).queueLength).toBe(0);
  });
});
