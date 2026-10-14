import { sha256 } from './sha256.js';
import { PLATFORM_IDS, VERDICTS } from './config.js';

export const SUBMISSION_FIELDS = [
  'platform',
  'title',
  'problem_id',
  'url',
  'language',
  'code',
  'external_id',
  'verdict',
  'submitted_at',
  'metadata',
  'fingerprint',
];

export const SUBMISSION_ID_REQUIRED = false;

const FINGERPRINT_RE = /^[0-9a-f]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

export function isPlainObject(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function normalizeCode(code) {
  if (!code) return '';
  const text = String(code).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = text.split('\n').map((line) => line.replace(/[ \t]+$/g, ''));
  return lines.join('\n').trim();
}

export function contentHash(code) {
  return sha256(normalizeCode(code));
}

export function stableFingerprint(platform, external_id, url, language, code) {
  const plat = (platform || '').trim().toLowerCase();
  const ext = (external_id || '').trim();
  let basis;
  if (plat && ext) {
    basis = `id|${plat}|${ext}`;
  } else {
    basis = `content|${plat}|${(url || '').trim()}|${(language || '').trim().toLowerCase()}|${contentHash(code)}`;
  }
  return sha256(basis);
}

function checkType(errors, field, value, type, { nullable = false, min, max } = {}) {
  if (value === null || value === undefined) {
    if (nullable) return;
    errors.push(`${field} is required`);
    return;
  }
  if (typeof value !== type) {
    errors.push(`${field} must be a ${type}`);
    return;
  }
  if (min !== undefined && value.length < min) errors.push(`${field} is too short`);
  if (max !== undefined && value.length > max) errors.push(`${field} is too long`);
}

export function validateSubmission(submission) {
  if (!isPlainObject(submission)) {
    return { ok: false, error: { code: 'INVALID_SUBMISSION', message: 'submission must be an object' } };
  }
  const keys = Object.keys(submission).sort();
  const expected = [...SUBMISSION_FIELDS].sort();
  if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) {
    const missing = expected.filter((k) => !(k in submission));
    const extra = keys.filter((k) => !expected.includes(k));
    const parts = [];
    if (missing.length) parts.push(`missing: ${missing.join(', ')}`);
    if (extra.length) parts.push(`unexpected: ${extra.join(', ')}`);
    return {
      ok: false,
      error: { code: 'INVALID_SUBMISSION', message: `submission fields mismatch (${parts.join('; ')})` },
    };
  }
  const errors = [];
  if (!PLATFORM_IDS.includes(submission.platform)) errors.push('platform is not supported');
  checkType(errors, 'title', submission.title, 'string', { min: 1, max: 500 });
  checkType(errors, 'language', submission.language, 'string', { min: 1, max: 64 });
  checkType(errors, 'code', submission.code, 'string', { nullable: true, max: 500000 });
  checkType(errors, 'problem_id', submission.problem_id, 'string', { nullable: true, max: 120 });
  checkType(errors, 'external_id', submission.external_id, 'string', { nullable: true, max: 120 });
  checkType(errors, 'url', submission.url, 'string', { nullable: true, max: 1000 });
  if (typeof submission.url === 'string' && !/^https?:\/\//.test(submission.url)) {
    errors.push('url must be http(s)');
  }
  if (!VERDICTS.includes(submission.verdict)) errors.push('verdict is not allowed');
  if (submission.submitted_at !== null) {
    if (typeof submission.submitted_at !== 'string' || !ISO_RE.test(submission.submitted_at) || Number.isNaN(Date.parse(submission.submitted_at))) {
      errors.push('submitted_at must be an ISO8601 string or null');
    }
  }
  if (submission.metadata !== null && !isPlainObject(submission.metadata)) {
    errors.push('metadata must be an object or null');
  }
  if (typeof submission.fingerprint !== 'string' || !FINGERPRINT_RE.test(submission.fingerprint)) {
    errors.push('fingerprint must be a 64-char lowercase hex sha256');
  }
  if (errors.length) {
    return { ok: false, error: { code: 'INVALID_SUBMISSION', message: errors[0] } };
  }
  return { ok: true };
}

function emptyPayload(payload) {
  if (!isPlainObject(payload)) return 'payload must be an object';
  if (Object.keys(payload).length !== 0) return 'payload must be an empty object';
  return null;
}

function submissionPayload(payload) {
  const result = validateSubmission(payload);
  return result.ok ? null : result.error.message;
}

function manualPayload(payload) {
  const base = submissionPayload(payload);
  if (base) return base;
  if (payload.verdict !== 'manual') return 'verdict must be "manual"';
  return null;
}

function pausedPayload(payload) {
  if (!isPlainObject(payload)) return 'payload must be an object';
  const keys = Object.keys(payload).sort();
  if (keys.length !== 1 || keys[0] !== 'paused') return 'payload must be exactly {paused}';
  if (typeof payload.paused !== 'boolean') return 'paused must be a boolean';
  return null;
}

function fingerprintPayload(payload) {
  if (!isPlainObject(payload)) return 'payload must be an object';
  const keys = Object.keys(payload).sort();
  if (keys.length !== 1 || keys[0] !== 'fingerprint') return 'payload must be exactly {fingerprint}';
  if (typeof payload.fingerprint !== 'string' || !FINGERPRINT_RE.test(payload.fingerprint)) {
    return 'fingerprint must be a 64-char lowercase hex sha256';
  }
  return null;
}

function settingsPayload(payload) {
  if (!isPlainObject(payload)) return 'payload must be an object';
  const keys = Object.keys(payload);
  if (keys.length === 0) return 'settings must include at least one field';
  const allowed = ['apiBaseUrl', 'apiToken'];
  const unknown = keys.filter((k) => !allowed.includes(k));
  if (unknown.length) return `unexpected settings field: ${unknown[0]}`;
  if ('apiBaseUrl' in payload) {
    if (typeof payload.apiBaseUrl !== 'string' || !/^https?:\/\/[^\s]+$/.test(payload.apiBaseUrl)) {
      return 'apiBaseUrl must be an http(s) url';
    }
  }
  if ('apiToken' in payload) {
    if (typeof payload.apiToken !== 'string' || payload.apiToken.length > 500) {
      return 'apiToken must be a string of at most 500 chars';
    }
  }
  return null;
}

export const MESSAGE_SPECS = {
  PING: { validate: emptyPayload },
  GET_STATE: { validate: emptyPayload },
  ENQUEUE: { validate: submissionPayload },
  SET_PAUSED: { validate: pausedPayload },
  CLEAR_QUEUE: { validate: emptyPayload },
  SYNC_NOW: { validate: emptyPayload },
  SUBMIT_MANUAL: { validate: manualPayload },
  GET_SETTINGS: { validate: emptyPayload },
  SET_SETTINGS: { validate: settingsPayload },
  TEST_CONNECTION: { validate: emptyPayload },
  REMOVE_ITEM: { validate: fingerprintPayload },
  RETRY_ITEM: { validate: fingerprintPayload },
};

export const CONTENT_MESSAGE_SPECS = {
  SYNC_PAGE: { validate: emptyPayload },
};

function validateAgainst(specs, message) {
  if (!isPlainObject(message)) {
    return { ok: false, error: { code: 'INVALID_MESSAGE', message: 'message must be an object' } };
  }
  const keys = Object.keys(message).sort();
  if (keys.length !== 2 || keys[0] !== 'payload' || keys[1] !== 'type') {
    return {
      ok: false,
      error: { code: 'INVALID_MESSAGE', message: 'message must be exactly {type, payload}' },
    };
  }
  const spec = specs[message.type];
  if (!spec) {
    return { ok: false, error: { code: 'UNKNOWN_MESSAGE', message: `unknown message type: ${message.type}` } };
  }
  const payloadError = spec.validate(message.payload);
  if (payloadError) {
    return { ok: false, error: { code: 'INVALID_PAYLOAD', message: payloadError } };
  }
  return { ok: true, type: message.type, payload: message.payload };
}

export function validateMessage(message) {
  return validateAgainst(MESSAGE_SPECS, message);
}

export function validateContentMessage(message) {
  return validateAgainst(CONTENT_MESSAGE_SPECS, message);
}

export function ok(data = {}) {
  return { ok: true, ...data };
}

export function fail(code, message) {
  return { ok: false, error: { code, message } };
}
