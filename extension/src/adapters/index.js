import { VERDICTS } from '../shared/config.js';
import { stableFingerprint, validateSubmission } from '../shared/schema.js';
import leetcode from './leetcode.js';
import geeksforgeeks from './geeksforgeeks.js';
import codechef from './codechef.js';
import neetcode from './neetcode.js';

export const ADAPTERS = [leetcode, geeksforgeeks, codechef, neetcode];

export const ADAPTER_BY_ID = Object.fromEntries(ADAPTERS.map((adapter) => [adapter.id, adapter]));

export function getAdapter(id) {
  return ADAPTER_BY_ID[id] || null;
}

export function matchHost(url) {
  if (!url) return null;
  for (const adapter of ADAPTERS) {
    if (adapter.canHandle(url)) return adapter;
  }
  return null;
}

export function capabilitiesOf(id) {
  const adapter = getAdapter(id);
  return adapter ? { ...adapter.capabilities } : null;
}

function toIso(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

function nullableString(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

export function normalize_submission(adapter, raw) {
  if (!adapter || !raw || typeof raw !== 'object') return null;
  const meta = raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : null;
  if (!meta) return null;
  const title = typeof meta.title === 'string' ? meta.title.trim() : '';
  if (!title) return null;

  const platform = adapter.id;
  const url = typeof meta.url === 'string' && meta.url ? meta.url : null;
  const language = typeof raw.language === 'string' && raw.language.trim() ? raw.language.trim() : 'unknown';
  const code = typeof raw.code === 'string' ? raw.code : null;
  const verdict = VERDICTS.includes(raw.verdict) ? raw.verdict : 'unknown';
  const external_id = nullableString(raw.external_id, 120);
  const problem_id = nullableString(meta.problem_id, 120);
  const { title: _title, problem_id: _problemId, url: _url, platform: _platform, ...extras } = meta;

  const submission = {
    platform,
    title,
    problem_id,
    url,
    language,
    code,
    external_id,
    verdict,
    submitted_at: toIso(raw.submitted_at),
    metadata: Object.keys(extras).length ? extras : null,
    fingerprint: stableFingerprint(platform, external_id, url, language, code),
  };

  const validation = validateSubmission(submission);
  return validation.ok ? submission : null;
}

export function buildManualSubmission(adapter, doc, url, { now = Date.now(), code = null, language = null } = {}) {
  if (!adapter || !adapter.capabilities.manual_sync) return null;
  const metadata = adapter.extractProblemMetadata(doc, url);
  if (!metadata) return null;
  return normalize_submission(adapter, {
    metadata,
    verdict: 'manual',
    code,
    language: language || 'unknown',
    external_id: null,
    submitted_at: now,
  });
}
