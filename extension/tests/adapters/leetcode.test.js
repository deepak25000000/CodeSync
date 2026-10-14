// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import leetcode from '../../src/adapters/leetcode.js';
import { normalize_submission } from '../../src/adapters/index.js';
import { stableFingerprint } from '../../src/shared/schema.js';
import { fixtureDoc } from '../helpers/fixtures.js';

const ACCEPTED_URL = 'https://leetcode.com/problems/two-sum/submissions/123456789/';
const PROBLEM_URL = 'https://leetcode.com/problems/two-sum/';

describe('leetcode adapter', () => {
  it('handles leetcode hosts only', () => {
    expect(leetcode.canHandle('https://leetcode.com/problems/two-sum/')).toBe(true);
    expect(leetcode.canHandle('https://www.leetcode.com/contest/')).toBe(true);
    expect(leetcode.canHandle('https://leetcode.cn/problems/two-sum/')).toBe(false);
    expect(leetcode.canHandle('https://example.com/problems/two-sum/')).toBe(false);
  });

  it('detects submission-capable pages', () => {
    expect(leetcode.detectPage(ACCEPTED_URL, fixtureDoc('leetcode/accepted.html'))).toBe(true);
    expect(leetcode.detectPage(PROBLEM_URL, fixtureDoc('leetcode/logged-out.html'))).toBe(true);
    expect(leetcode.detectPage('https://leetcode.com/', fixtureDoc('leetcode/unsupported.html'))).toBe(
      false,
    );
    expect(leetcode.detectPage('not a url', fixtureDoc('leetcode/accepted.html'))).toBe(false);
  });

  it('extracts an accepted submission end to end', () => {
    const doc = fixtureDoc('leetcode/accepted.html');
    const metadata = leetcode.extractProblemMetadata(doc, ACCEPTED_URL);
    expect(metadata).toEqual({
      title: 'Two Sum',
      problem_id: 'two-sum',
      url: ACCEPTED_URL,
      platform: 'leetcode',
    });
    expect(leetcode.extractSubmissionStatus(doc)).toBe('accepted');
    expect(leetcode.extractSubmissionId(doc, ACCEPTED_URL)).toBe('123456789');
    expect(leetcode.extractSubmittedAt(doc, ACCEPTED_URL)).toBe(Date.parse('2026-01-02T10:00:00Z'));

    const code = leetcode.extractSolutionCode(doc);
    expect(code).toContain('def twoSum(self, nums, target)');
    expect(code.split('\n')).toHaveLength(7);
    expect(code).toContain('            if target - n in seen:');

    const raw = leetcode.detect_submission(doc, ACCEPTED_URL);
    expect(raw).toBeTruthy();
    expect(raw.verdict).toBe('accepted');
    expect(raw.language).toBe('Python3');
    expect(raw.external_id).toBe('123456789');

    const submission = normalize_submission(leetcode, raw);
    expect(submission).toMatchObject({
      platform: 'leetcode',
      title: 'Two Sum',
      problem_id: 'two-sum',
      url: ACCEPTED_URL,
      language: 'Python3',
      verdict: 'accepted',
      submitted_at: '2026-01-02T10:00:00.000Z',
      external_id: '123456789',
      metadata: null,
    });
    expect(submission.fingerprint).toBe(
      '24ba7319950cd776ec83b99870d66641e227e76cdc2ed383974ffc9d7224801e',
    );
  });

  it('extracts a rejected submission', () => {
    const doc = fixtureDoc('leetcode/rejected.html');
    expect(leetcode.extractSubmissionStatus(doc)).toBe('rejected');
    const code = leetcode.extractSolutionCode(doc);
    expect(code).toContain('vector<int>');
    const raw = leetcode.detect_submission(doc, PROBLEM_URL);
    expect(raw.verdict).toBe('rejected');
    expect(raw.language).toBe('C++');
    const submission = normalize_submission(leetcode, raw);
    expect(submission.verdict).toBe('rejected');
    expect(submission.external_id).toBeNull();
    expect(submission.fingerprint).toBe(
      stableFingerprint('leetcode', null, PROBLEM_URL, 'C++', code),
    );
  });

  it('extracts a pending submission', () => {
    const doc = fixtureDoc('leetcode/pending.html');
    expect(leetcode.extractSubmissionStatus(doc)).toBe('pending');
    const raw = leetcode.detect_submission(doc, PROBLEM_URL);
    expect(raw.verdict).toBe('pending');
    expect(normalize_submission(leetcode, raw).verdict).toBe('pending');
  });

  it('returns no submission for a logged-out problem page', () => {
    const doc = fixtureDoc('leetcode/logged-out.html');
    const metadata = leetcode.extractProblemMetadata(doc, PROBLEM_URL);
    expect(metadata.title).toBe('Two Sum');
    expect(leetcode.extractSubmissionStatus(doc)).toBe('unknown');
    expect(leetcode.extractSolutionCode(doc)).toBeNull();
    expect(leetcode.extractSubmissionId(doc, PROBLEM_URL)).toBeNull();
    expect(leetcode.detect_submission(doc, PROBLEM_URL)).toBeNull();
  });

  it('returns null metadata without throwing when selectors are missing', () => {
    const doc = fixtureDoc('leetcode/missing.html');
    expect(leetcode.extractProblemMetadata(doc, PROBLEM_URL)).toBeNull();
    expect(leetcode.extractSubmissionStatus(doc)).toBe('unknown');
    expect(leetcode.detect_submission(doc, PROBLEM_URL)).toBeNull();
    expect(() => leetcode.extractSolutionCode(doc)).not.toThrow();
  });

  it('ignores unsupported pages', () => {
    const doc = fixtureDoc('leetcode/unsupported.html');
    expect(leetcode.detectPage('https://leetcode.com/', doc)).toBe(false);
    expect(leetcode.detect_submission(doc, 'https://leetcode.com/')).toBeNull();
  });
});
