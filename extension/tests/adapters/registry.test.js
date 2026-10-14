// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  ADAPTERS,
  buildManualSubmission,
  capabilitiesOf,
  getAdapter,
  matchHost,
  normalize_submission,
} from '../../src/adapters/index.js';
import { PLATFORM_HOSTS } from '../../src/shared/hostallow.js';
import { fixtureDoc } from '../helpers/fixtures.js';

const CAPABILITY_KEYS = [
  'submission_detection',
  'verdict_extraction',
  'solution_code_extraction',
  'problem_metadata',
  'manual_sync',
];

describe('adapter registry', () => {
  it('registers exactly the four platforms', () => {
    expect(ADAPTERS.map((adapter) => adapter.id)).toEqual([
      'leetcode',
      'geeksforgeeks',
      'codechef',
      'neetcode',
    ]);
    expect(getAdapter('leetcode')).toBe(ADAPTERS[0]);
    expect(getAdapter('unknown')).toBeNull();
  });

  it('matches hosts from the platform matrix', () => {
    const cases = [
      ['https://leetcode.com/problems/two-sum/', 'leetcode'],
      ['https://www.leetcode.com/submissions/', 'leetcode'],
      ['https://www.geeksforgeeks.org/problems/two-sum/', 'geeksforgeeks'],
      ['https://geeksforgeeks.org/user/x/submissions', 'geeksforgeeks'],
      ['https://www.codechef.com/problems/TEST', 'codechef'],
      ['https://codechef.com/viewsubmission/1/', 'codechef'],
      ['https://neetcode.io/practice', 'neetcode'],
      ['https://www.neetcode.io/roadmap', 'neetcode'],
      ['https://github.com/', null],
      ['https://leetcode.com.evil.example/', null],
      ['not-a-url', null],
      ['', null],
    ];
    for (const [url, expected] of cases) {
      const adapter = matchHost(url);
      expect(adapter ? adapter.id : null, url).toBe(expected);
    }
  });

  it('derives adapter hosts from the shared allowlist', () => {
    for (const adapter of ADAPTERS) {
      expect(adapter.hosts).toEqual(PLATFORM_HOSTS[adapter.id]);
    }
  });

  it('keeps the capability matrix internally consistent', () => {
    for (const adapter of ADAPTERS) {
      expect(Object.keys(adapter.capabilities).sort()).toEqual([...CAPABILITY_KEYS].sort());
      for (const key of CAPABILITY_KEYS) {
        expect(typeof adapter.capabilities[key], `${adapter.id}.${key}`).toBe('boolean');
      }
      if (!adapter.capabilities.submission_detection) {
        expect(adapter.capabilities.verdict_extraction).toBe(false);
        expect(adapter.capabilities.solution_code_extraction).toBe(false);
      }
      expect(adapter.capabilities.problem_metadata).toBe(true);
      expect(adapter.capabilities.manual_sync).toBe(true);
      expect(capabilitiesOf(adapter.id)).toEqual(adapter.capabilities);
    }
    const neetcode = getAdapter('neetcode');
    expect(neetcode.capabilities).toEqual({
      submission_detection: false,
      verdict_extraction: false,
      solution_code_extraction: false,
      problem_metadata: true,
      manual_sync: true,
    });
  });

  it('requires the full adapter interface', () => {
    for (const adapter of ADAPTERS) {
      for (const method of [
        'canHandle',
        'detectPage',
        'extractProblemMetadata',
        'extractSubmissionStatus',
        'extractSolutionCode',
        'extractSubmissionId',
        'extractSubmittedAt',
        'detect_submission',
      ]) {
        expect(typeof adapter[method], `${adapter.id}.${method}`).toBe('function');
      }
    }
  });

  it('normalizes only complete raw submissions', () => {
    expect(normalize_submission(null, {})).toBeNull();
    expect(normalize_submission(ADAPTERS[0], null)).toBeNull();
    expect(normalize_submission(ADAPTERS[0], { verdict: 'accepted' })).toBeNull();
    expect(
      normalize_submission(ADAPTERS[0], {
        metadata: { title: '   ', problem_id: null, url: null, platform: 'leetcode' },
        verdict: 'accepted',
        code: 'x=1',
        language: 'Python3',
        external_id: null,
        submitted_at: null,
      }),
    ).toBeNull();
    expect(
      normalize_submission(ADAPTERS[0], {
        metadata: { title: 'Valid', problem_id: 'p', url: 'https://leetcode.com/problems/p/', platform: 'leetcode' },
        verdict: 'unknown',
        code: 'x=1',
        language: 'Python3',
        external_id: null,
        submitted_at: null,
      }),
    ).toMatchObject({ platform: 'leetcode', verdict: 'unknown', title: 'Valid' });
  });

  it('does not auto-detect submissions for metadata-only platforms', () => {
    const neetcode = getAdapter('neetcode');
    const doc = fixtureDoc('neetcode/practice.html');
    expect(neetcode.detect_submission(doc, 'https://neetcode.io/practice')).toBeNull();
    expect(buildManualSubmission(neetcode, doc, 'https://neetcode.io/practice')).toMatchObject({
      verdict: 'manual',
      platform: 'neetcode',
    });
  });
});
