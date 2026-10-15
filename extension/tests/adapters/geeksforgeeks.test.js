// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import geeksforgeeks from '../../src/adapters/geeksforgeeks.js';
import { buildManualSubmission, normalize_submission } from '../../src/adapters/index.js';
import { stableFingerprint } from '../../src/shared/schema.js';
import { fixtureDoc } from '../helpers/fixtures.js';

const PROBLEM_URL = 'https://www.geeksforgeeks.org/problems/two-sum/114/';
const ACE_URL = 'https://www.geeksforgeeks.org/problems/bubble-sort/1';

describe('geeksforgeeks adapter', () => {
  it('handles geeksforgeeks hosts only', () => {
    expect(geeksforgeeks.canHandle('https://www.geeksforgeeks.org/problems/two-sum/')).toBe(true);
    expect(geeksforgeeks.canHandle('https://geeksforgeeks.org/problems/two-sum/')).toBe(true);
    expect(geeksforgeeks.canHandle('https://geeksforgeeks.com/problems/two-sum/')).toBe(false);
  });

  it('detects submission-capable pages', () => {
    expect(geeksforgeeks.detectPage(PROBLEM_URL, fixtureDoc('geeksforgeeks/accepted.html'))).toBe(true);
    expect(
      geeksforgeeks.detectPage('https://www.geeksforgeeks.org/user/alice/submissions', fixtureDoc('geeksforgeeks/accepted.html')),
    ).toBe(true);
    expect(geeksforgeeks.detectPage('https://www.geeksforgeeks.org/', fixtureDoc('geeksforgeeks/missing.html'))).toBe(
      false,
    );
  });

  it('extracts an accepted submission end to end', () => {
    const doc = fixtureDoc('geeksforgeeks/accepted.html');
    const metadata = geeksforgeeks.extractProblemMetadata(doc, PROBLEM_URL);
    expect(metadata).toEqual({
      title: 'Two Sum',
      problem_id: '114',
      url: PROBLEM_URL,
      platform: 'geeksforgeeks',
    });
    expect(geeksforgeeks.extractSubmissionStatus(doc)).toBe('accepted');
    expect(geeksforgeeks.extractSubmissionId(doc, PROBLEM_URL)).toBeNull();
    expect(geeksforgeeks.extractSubmittedAt(doc, PROBLEM_URL)).toBe(
      Date.parse('2026-01-03T08:30:00Z'),
    );

    const code = geeksforgeeks.extractSolutionCode(doc);
    expect(code).toContain('def twoSum(self, arr, target)');
    expect(code).toContain('seen[v] = i');

    const raw = geeksforgeeks.detect_submission(doc, PROBLEM_URL);
    expect(raw.verdict).toBe('accepted');
    expect(raw.language).toBe('Python3');
    expect(raw.external_id).toBeNull();

    const submission = normalize_submission(geeksforgeeks, raw);
    expect(submission).toMatchObject({
      platform: 'geeksforgeeks',
      title: 'Two Sum',
      problem_id: '114',
      verdict: 'accepted',
      language: 'Python3',
      external_id: null,
      submitted_at: '2026-01-03T08:30:00.000Z',
    });
    expect(submission.fingerprint).toBe(
      stableFingerprint('geeksforgeeks', null, PROBLEM_URL, 'Python3', code),
    );
  });

  it('extracts an accepted submission from the live ACE editor DOM', () => {
    const doc = fixtureDoc('geeksforgeeks/ace.html');
    const metadata = geeksforgeeks.extractProblemMetadata(doc, ACE_URL);
    expect(metadata).toEqual({
      title: 'Bubble Sort',
      problem_id: 'bubble-sort',
      url: ACE_URL,
      platform: 'geeksforgeeks',
    });
    expect(geeksforgeeks.extractSubmissionStatus(doc)).toBe('accepted');

    const code = geeksforgeeks.extractSolutionCode(doc);
    expect(code).toContain('void bubbleSort(int *arr, int n)');
    expect(code).toContain('}');

    const raw = geeksforgeeks.detect_submission(doc, ACE_URL);
    expect(raw.verdict).toBe('accepted');
    expect(raw.language).toBe('C');
    const submission = normalize_submission(geeksforgeeks, raw);
    expect(submission).toMatchObject({
      title: 'Bubble Sort',
      verdict: 'accepted',
      language: 'C',
    });
  });

  it('builds a manual submission with code and a detected language', () => {
    const doc = fixtureDoc('geeksforgeeks/ace.html');
    const submission = buildManualSubmission(geeksforgeeks, doc, ACE_URL, {
      now: Date.parse('2026-02-11T10:00:00Z'),
    });
    expect(submission).not.toBeNull();
    expect(submission.verdict).toBe('manual');
    expect(submission.language).toBe('C');
    expect(submission.code).toContain('bubbleSort');
  });

  it('extracts a rejected submission', () => {
    const doc = fixtureDoc('geeksforgeeks/rejected.html');
    expect(geeksforgeeks.extractSubmissionStatus(doc)).toBe('rejected');
    const raw = geeksforgeeks.detect_submission(doc, PROBLEM_URL);
    expect(raw.verdict).toBe('rejected');
    expect(normalize_submission(geeksforgeeks, raw).verdict).toBe('rejected');
  });

  it('extracts a pending submission', () => {
    const doc = fixtureDoc('geeksforgeeks/pending.html');
    expect(geeksforgeeks.extractSubmissionStatus(doc)).toBe('pending');
    const raw = geeksforgeeks.detect_submission(doc, PROBLEM_URL);
    expect(raw.verdict).toBe('pending');
  });

  it('returns no submission on a logged-out problem page', () => {
    const doc = fixtureDoc('geeksforgeeks/logged-out.html');
    expect(geeksforgeeks.extractProblemMetadata(doc, PROBLEM_URL).title).toBe('Two Sum');
    expect(geeksforgeeks.extractSolutionCode(doc)).toBeNull();
    expect(geeksforgeeks.extractSubmissionStatus(doc)).toBe('unknown');
    expect(geeksforgeeks.detect_submission(doc, PROBLEM_URL)).toBeNull();
  });

  it('returns nulls instead of throwing when selectors are missing', () => {
    const doc = fixtureDoc('geeksforgeeks/missing.html');
    expect(geeksforgeeks.extractProblemMetadata(doc, PROBLEM_URL)).toBeNull();
    expect(geeksforgeeks.extractSolutionCode(doc)).toBeNull();
    expect(geeksforgeeks.extractSubmittedAt(doc, PROBLEM_URL)).toBeNull();
    expect(geeksforgeeks.detect_submission(doc, PROBLEM_URL)).toBeNull();
  });
});
