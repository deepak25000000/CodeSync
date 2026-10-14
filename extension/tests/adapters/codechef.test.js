// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import codechef from '../../src/adapters/codechef.js';
import { normalize_submission } from '../../src/adapters/index.js';
import { fixtureDoc } from '../helpers/fixtures.js';

const PROBLEM_URL = 'https://www.codechef.com/problems/TEST';

describe('codechef adapter', () => {
  it('handles codechef hosts only', () => {
    expect(codechef.canHandle('https://www.codechef.com/problems/TEST')).toBe(true);
    expect(codechef.canHandle('https://codechef.com/problems/TEST')).toBe(true);
    expect(codechef.canHandle('https://codechef.dev/problems/TEST')).toBe(false);
  });

  it('detects submission-capable pages', () => {
    expect(codechef.detectPage(PROBLEM_URL, fixtureDoc('codechef/accepted.html'))).toBe(true);
    expect(
      codechef.detectPage('https://www.codechef.com/submissions/987654321', fixtureDoc('codechef/accepted.html')),
    ).toBe(true);
    expect(codechef.detectPage('https://www.codechef.com/', fixtureDoc('codechef/unsupported.html'))).toBe(false);
    expect(codechef.detectPage('https://www.codechef.com/contests', fixtureDoc('codechef/unsupported.html'))).toBe(
      false,
    );
  });

  it('extracts an accepted submission end to end', () => {
    const doc = fixtureDoc('codechef/accepted.html');
    const metadata = codechef.extractProblemMetadata(doc, PROBLEM_URL);
    expect(metadata).toEqual({
      title: 'Find Remainder',
      problem_id: 'TEST',
      url: PROBLEM_URL,
      platform: 'codechef',
    });
    expect(codechef.extractSubmissionStatus(doc)).toBe('accepted');
    expect(codechef.extractSubmissionId(doc, PROBLEM_URL)).toBe('987654321');
    expect(codechef.extractSubmittedAt(doc, PROBLEM_URL)).toBe(Date.parse('2026-01-05T12:45:00Z'));

    const code = codechef.extractSolutionCode(doc);
    expect(code).toContain('a = int(input())');
    expect(code).toContain('print(a % 10)');

    const raw = codechef.detect_submission(doc, PROBLEM_URL);
    expect(raw.verdict).toBe('accepted');
    expect(raw.language).toBe('C++');
    expect(raw.external_id).toBe('987654321');

    const submission = normalize_submission(codechef, raw);
    expect(submission).toMatchObject({
      platform: 'codechef',
      title: 'Find Remainder',
      problem_id: 'TEST',
      language: 'C++',
      verdict: 'accepted',
      external_id: '987654321',
      submitted_at: '2026-01-05T12:45:00.000Z',
    });
    expect(submission.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('extracts a rejected submission', () => {
    const doc = fixtureDoc('codechef/rejected.html');
    expect(codechef.extractSubmissionStatus(doc)).toBe('rejected');
    const code = codechef.extractSolutionCode(doc);
    expect(code).toContain('int *p');
    const raw = codechef.detect_submission(doc, PROBLEM_URL);
    expect(raw.verdict).toBe('rejected');
    expect(normalize_submission(codechef, raw).verdict).toBe('rejected');
  });

  it('extracts a pending submission with a relative timestamp', () => {
    const doc = fixtureDoc('codechef/pending.html');
    const now = Date.parse('2026-01-06T12:00:00Z');
    expect(codechef.extractSubmissionStatus(doc)).toBe('pending');
    expect(codechef.extractSubmittedAt(doc, PROBLEM_URL, now)).toBe(now - 3 * 3600 * 1000);
    const raw = codechef.detect_submission(doc, PROBLEM_URL, now);
    expect(raw.verdict).toBe('pending');
    expect(normalize_submission(codechef, raw).submitted_at).toBe(
      new Date(now - 3 * 3600 * 1000).toISOString(),
    );
  });

  it('returns nulls instead of throwing when selectors are missing', () => {
    const doc = fixtureDoc('codechef/missing.html');
    expect(codechef.extractProblemMetadata(doc, PROBLEM_URL)).toBeNull();
    expect(codechef.extractSubmissionStatus(doc)).toBe('unknown');
    expect(codechef.extractSolutionCode(doc)).toBeNull();
    expect(codechef.detect_submission(doc, PROBLEM_URL)).toBeNull();
  });

  it('ignores unsupported pages', () => {
    const doc = fixtureDoc('codechef/unsupported.html');
    expect(codechef.detectPage('https://www.codechef.com/', doc)).toBe(false);
    expect(codechef.detect_submission(doc, 'https://www.codechef.com/')).toBeNull();
  });
});
