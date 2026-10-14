import { describe, expect, it } from 'vitest';
import {
  contentHash,
  normalizeCode,
  stableFingerprint,
  validateMessage,
  validateSubmission,
} from '../src/shared/schema.js';
import { makeSubmission } from './helpers/fixtures.js';

describe('normalizeCode', () => {
  it('normalizes line endings and trailing whitespace', () => {
    expect(normalizeCode('a  \r\nb\t\r\n')).toBe('a\nb');
    expect(normalizeCode(null)).toBe('');
    expect(normalizeCode('   ')).toBe('');
  });
});

describe('stableFingerprint', () => {
  it('prefers platform + external id identity', () => {
    const fp = stableFingerprint(
      'leetcode',
      '123456789',
      'https://leetcode.com/problems/two-sum/',
      'Python3',
      'class Solution:\n    pass',
    );
    expect(fp).toBe('24ba7319950cd776ec83b99870d66641e227e76cdc2ed383974ffc9d7224801e');
  });

  it('falls back to url + language + content hash', () => {
    const fp = stableFingerprint(
      'geeksforgeeks',
      null,
      'https://www.geeksforgeeks.org/problems/two-sum/114/',
      'Python3',
      'def solve():\n  return 1\n',
    );
    expect(fp).toBe('5961a79949915916faf6388d6e55b750498952f4da3cfa793ccfcc747a19c18c');
  });

  it('is stable across code whitespace differences', () => {
    const a = stableFingerprint('codechef', null, 'https://codechef.com/problems/TEST', 'C', 'x=1  ');
    const b = stableFingerprint('codechef', null, 'https://codechef.com/problems/TEST', 'C', 'x=1');
    expect(a).toBe(b);
  });

  it('normalizes platform and language casing', () => {
    const a = stableFingerprint('LeetCode', ' 42 ', 'https://leetcode.com/x', 'python3', 'x');
    const b = stableFingerprint('leetcode', '42', 'https://other.example/x', 'Python3', 'y');
    expect(a).toBe(b);
  });

  it('hashes empty code deterministically', () => {
    expect(stableFingerprint('neetcode', null, 'https://neetcode.io/practice', 'unknown', '')).toBe(
      '3a146e62ad5f985ba32c772e0474f23543de857a8410646767f8fde7175d9cb1',
    );
  });
});

describe('contentHash', () => {
  it('matches sha256 of normalized code', () => {
    expect(contentHash('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('validateSubmission', () => {
  it('accepts a valid submission', () => {
    expect(validateSubmission(makeSubmission()).ok).toBe(true);
  });

  it('accepts nullable fields', () => {
    const submission = makeSubmission({
      problem_id: null,
      url: null,
      code: null,
      external_id: null,
      submitted_at: null,
      metadata: { difficulty: 'Easy' },
    });
    expect(validateSubmission(submission).ok).toBe(true);
  });

  it('rejects a missing field', () => {
    const submission = makeSubmission();
    delete submission.language;
    const result = validateSubmission(submission);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('INVALID_SUBMISSION');
    expect(result.error.message).toContain('language');
  });

  it('rejects an extra field', () => {
    const submission = makeSubmission({ sneaky: true });
    const result = validateSubmission(submission);
    expect(result.ok).toBe(false);
    expect(result.error.message).toContain('sneaky');
  });

  it('rejects an unsupported platform', () => {
    expect(validateSubmission(makeSubmission({ platform: 'hackerrank' })).ok).toBe(false);
  });

  it('rejects an invalid verdict', () => {
    expect(validateSubmission(makeSubmission({ verdict: 'maybe' })).ok).toBe(false);
  });

  it('rejects a non-http url', () => {
    expect(validateSubmission(makeSubmission({ url: 'javascript:alert(1)' })).ok).toBe(false);
  });

  it('rejects wrong field types', () => {
    expect(validateSubmission(makeSubmission({ code: 42 })).ok).toBe(false);
    expect(validateSubmission(makeSubmission({ submitted_at: 12345 })).ok).toBe(false);
    expect(validateSubmission(makeSubmission({ metadata: 'nope' })).ok).toBe(false);
    expect(validateSubmission(makeSubmission({ fingerprint: 'xyz' })).ok).toBe(false);
  });

  it('rejects a non-object', () => {
    expect(validateSubmission(null).ok).toBe(false);
    expect(validateSubmission([]).ok).toBe(false);
  });
});

function message(type, payload = {}) {
  return { type, payload };
}

describe('validateMessage', () => {
  it('accepts the documented requests', () => {
    expect(validateMessage(message('PING')).ok).toBe(true);
    expect(validateMessage(message('GET_STATE')).ok).toBe(true);
    expect(validateMessage(message('SYNC_NOW')).ok).toBe(true);
    expect(validateMessage(message('CLEAR_QUEUE')).ok).toBe(true);
    expect(validateMessage(message('TEST_CONNECTION')).ok).toBe(true);
    expect(validateMessage(message('GET_SETTINGS')).ok).toBe(true);
    expect(validateMessage(message('SET_PAUSED', { paused: true })).ok).toBe(true);
    expect(validateMessage(message('ENQUEUE', makeSubmission())).ok).toBe(true);
    expect(
      validateMessage(message('SUBMIT_MANUAL', makeSubmission({ verdict: 'manual' }))).ok,
    ).toBe(true);
    expect(validateMessage(message('REMOVE_ITEM', { fingerprint: 'a'.repeat(64) })).ok).toBe(true);
    expect(validateMessage(message('RETRY_ITEM', { fingerprint: 'b'.repeat(64) })).ok).toBe(true);
    expect(
      validateMessage(message('SET_SETTINGS', { apiBaseUrl: 'http://127.0.0.1:8000', apiToken: '' }))
        .ok,
    ).toBe(true);
  });

  it('rejects an unknown message type', () => {
    const result = validateMessage(message('NOPE'));
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('UNKNOWN_MESSAGE');
  });

  it('rejects structural problems', () => {
    expect(validateMessage('PING').error.code).toBe('INVALID_MESSAGE');
    expect(validateMessage({ type: 'PING' }).error.code).toBe('INVALID_MESSAGE');
    expect(validateMessage({ type: 'PING', payload: {}, extra: 1 }).error.code).toBe('INVALID_MESSAGE');
    expect(validateMessage({ payload: {}, type: 'PING' }).ok).toBe(true);
  });

  it('rejects wrong payload types', () => {
    expect(validateMessage(message('SET_PAUSED', { paused: 'yes' })).error.code).toBe(
      'INVALID_PAYLOAD',
    );
    expect(validateMessage(message('SET_PAUSED', { paused: true, other: 1 })).error.code).toBe(
      'INVALID_PAYLOAD',
    );
    expect(validateMessage(message('PING', { anything: 1 })).error.code).toBe('INVALID_PAYLOAD');
    expect(validateMessage(message('REMOVE_ITEM', { fingerprint: 'nope' })).error.code).toBe(
      'INVALID_PAYLOAD',
    );
    expect(validateMessage(message('ENQUEUE', makeSubmission({ title: '' }))).error.code).toBe(
      'INVALID_PAYLOAD',
    );
  });

  it('requires verdict manual for SUBMIT_MANUAL', () => {
    const result = validateMessage(message('SUBMIT_MANUAL', makeSubmission({ verdict: 'accepted' })));
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('INVALID_PAYLOAD');
    expect(result.error.message).toContain('manual');
  });

  it('rejects unknown settings fields and bad urls', () => {
    expect(validateMessage(message('SET_SETTINGS', { token: 'x' })).error.code).toBe('INVALID_PAYLOAD');
    expect(
      validateMessage(message('SET_SETTINGS', { apiBaseUrl: 'ftp://nope' })).error.code,
    ).toBe('INVALID_PAYLOAD');
    expect(validateMessage(message('SET_SETTINGS', {})).error.code).toBe('INVALID_PAYLOAD');
  });
});
