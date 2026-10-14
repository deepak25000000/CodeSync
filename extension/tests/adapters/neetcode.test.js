// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import neetcode from '../../src/adapters/neetcode.js';
import { buildManualSubmission, normalize_submission } from '../../src/adapters/index.js';
import { validateSubmission } from '../../src/shared/schema.js';
import { fixtureDoc } from '../helpers/fixtures.js';

const PRACTICE_URL = 'https://neetcode.io/practice';

describe('neetcode adapter', () => {
  it('exposes exactly the capability matrix limits', () => {
    expect(neetcode.capabilities).toEqual({
      submission_detection: false,
      verdict_extraction: false,
      solution_code_extraction: false,
      problem_metadata: true,
      manual_sync: true,
    });
  });

  it('handles neetcode hosts only', () => {
    expect(neetcode.canHandle('https://neetcode.io/practice')).toBe(true);
    expect(neetcode.canHandle('https://www.neetcode.io/roadmap')).toBe(true);
    expect(neetcode.canHandle('https://neetcode.org/practice')).toBe(false);
  });

  it('detects practice pages but not the home page', () => {
    expect(neetcode.detectPage(PRACTICE_URL, fixtureDoc('neetcode/practice.html'))).toBe(true);
    expect(neetcode.detectPage('https://neetcode.io/', fixtureDoc('neetcode/home.html'))).toBe(false);
  });

  it('never detects or extracts submissions', () => {
    const doc = fixtureDoc('neetcode/practice.html');
    expect(neetcode.detect_submission(doc, PRACTICE_URL)).toBeNull();
    expect(neetcode.extractSubmissionStatus(doc)).toBe('unknown');
    expect(neetcode.extractSolutionCode(doc)).toBeNull();
    expect(neetcode.extractSubmissionId(doc, PRACTICE_URL)).toBeNull();
    expect(neetcode.extractSubmittedAt(doc, PRACTICE_URL)).toBeNull();
    expect(normalize_submission(neetcode, neetcode.detect_submission(doc, PRACTICE_URL))).toBeNull();
  });

  it('provides problem metadata', () => {
    const doc = fixtureDoc('neetcode/practice.html');
    expect(neetcode.extractProblemMetadata(doc, PRACTICE_URL)).toEqual({
      title: 'Two Sum',
      problem_id: null,
      url: PRACTICE_URL,
      platform: 'neetcode',
    });
  });

  it('supports a manual submission built from page metadata', () => {
    const doc = fixtureDoc('neetcode/practice.html');
    const submission = buildManualSubmission(neetcode, doc, PRACTICE_URL, {
      now: Date.parse('2026-01-07T09:00:00Z'),
    });
    expect(submission).toBeTruthy();
    expect(validateSubmission(submission).ok).toBe(true);
    expect(submission).toMatchObject({
      platform: 'neetcode',
      title: 'Two Sum',
      verdict: 'manual',
      code: null,
      language: 'unknown',
      external_id: null,
      submitted_at: '2026-01-07T09:00:00.000Z',
    });
    expect(submission.fingerprint).toBe(
      '3a146e62ad5f985ba32c772e0474f23543de857a8410646767f8fde7175d9cb1',
    );
  });

  it('returns null metadata on pages without a problem title', () => {
    const doc = fixtureDoc('neetcode/home.html');
    expect(neetcode.extractProblemMetadata(doc, 'https://neetcode.io/')).toBeNull();
    expect(buildManualSubmission(neetcode, doc, 'https://neetcode.io/')).toBeNull();
  });
});
