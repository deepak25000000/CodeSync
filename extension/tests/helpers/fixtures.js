import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function fixtureHtml(relativePath) {
  return readFileSync(path.join(extensionRoot, 'fixtures', relativePath), 'utf8');
}

export function fixtureDoc(relativePath) {
  return new JSDOM(fixtureHtml(relativePath)).window.document;
}

export function makeSubmission(overrides = {}) {
  return {
    platform: 'leetcode',
    title: 'Two Sum',
    problem_id: 'two-sum',
    url: 'https://leetcode.com/problems/two-sum/',
    language: 'Python3',
    code: 'class Solution:\n    def twoSum(self, nums, target):\n        return []',
    external_id: '123456789',
    verdict: 'accepted',
    submitted_at: '2026-01-02T10:00:00.000Z',
    metadata: null,
    fingerprint: 'a'.repeat(64),
    ...overrides,
  };
}
