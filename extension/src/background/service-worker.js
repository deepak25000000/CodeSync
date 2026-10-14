import {
  ALARM,
  BADGE_COLORS,
  HISTORY_LIMIT,
  JOB_POLL,
  MAX_ATTEMPTS,
  STORAGE_KEYS,
  defaultSettings,
} from '../shared/config.js';
import { ApiError, createApi, toSubmissionPayload } from '../shared/api.js';
import { fail, ok, validateMessage } from '../shared/schema.js';
import {
  computePollDelay,
  enqueueItem,
  markPendingRetry,
  nextAttemptAt,
  removeItem,
  selectDue,
  selectPolls,
  shouldRetry,
  summarize,
  updateItem,
} from '../shared/queue.js';
import { isPlatformUrl } from '../shared/hostallow.js';

let running = false;

async function storageGet(key, fallback) {
  try {
    const result = await chrome.storage.local.get(key);
    if (result && Object.prototype.hasOwnProperty.call(result, key)) return result[key];
    return fallback;
  } catch {
    return fallback;
  }
}

async function storageSet(key, value) {
  try {
    await chrome.storage.local.set({ [key]: value });
  } catch (err) {
    console.error('[codesync] storage write failed', err);
  }
}

async function loadQueue() {
  const queue = await storageGet(STORAGE_KEYS.QUEUE, []);
  return Array.isArray(queue) ? queue : [];
}

async function saveQueue(queue) {
  await storageSet(STORAGE_KEYS.QUEUE, queue);
}

async function loadSettings() {
  const stored = await storageGet(STORAGE_KEYS.SETTINGS, null);
  return { ...defaultSettings(), ...(stored && typeof stored === 'object' ? stored : {}) };
}

async function loadPaused() {
  return (await storageGet(STORAGE_KEYS.PAUSED, false)) === true;
}

async function loadConnection() {
  const conn = await storageGet(STORAGE_KEYS.CONNECTION, null);
  return conn && typeof conn === 'object'
    ? conn
    : { connected: false, github_login: null, lastError: null, checked_at: null };
}

async function loadHistory() {
  const history = await storageGet(STORAGE_KEYS.HISTORY, []);
  return Array.isArray(history) ? history : [];
}

async function loadLastSync() {
  const value = await storageGet(STORAGE_KEYS.LAST_SYNC, null);
  return value && typeof value === 'object' ? value : null;
}

async function loadPlatformsCache() {
  const value = await storageGet(STORAGE_KEYS.PLATFORMS, null);
  return value && typeof value === 'object' && value.platforms ? value : null;
}

async function setConnection(patch) {
  const conn = await loadConnection();
  await storageSet(STORAGE_KEYS.CONNECTION, { ...conn, ...patch, checked_at: Date.now() });
}

async function pushHistory(entry) {
  const history = await loadHistory();
  const next = [entry, ...history].slice(0, HISTORY_LIMIT);
  await storageSet(STORAGE_KEYS.HISTORY, next);
}

function normalizeApiError(err) {
  if (err instanceof ApiError) return { code: err.code, message: err.message };
  return {
    code: 'UNKNOWN',
    message: (err && err.message) || String(err),
  };
}

function isRetryable(error) {
  if (['NETWORK', 'TIMEOUT', 'ABORTED'].includes(error.code)) return true;
  if (error.code === 'HTTP_429') return true;
  return /^HTTP_5\d\d$/.test(error.code);
}

async function refreshPlatformsCache(api, force = false) {
  const cache = await loadPlatformsCache();
  const fresh = cache && Date.now() - cache.at < 5 * 60 * 1000;
  if (fresh && !force) return cache;
  try {
    const response = await api.getPlatforms();
    const list = (response && response.platforms) || [];
    const platforms = {};
    for (const item of list) platforms[item.id] = item.enabled !== false;
    const next = { platforms, at: Date.now() };
    await storageSet(STORAGE_KEYS.PLATFORMS, next);
    return next;
  } catch {
    return cache;
  }
}

async function updateBadge() {
  if (typeof chrome === 'undefined' || !chrome.action) return;
  try {
    const [queue, settings, paused] = await Promise.all([
      loadQueue(),
      loadSettings(),
      loadPaused(),
    ]);
    const counts = summarize(queue);
    let text = counts.pendingTotal > 0 ? String(counts.pendingTotal) : '';
    let color = BADGE_COLORS.ok;
    if (!settings.apiToken) {
      text = '!';
      color = BADGE_COLORS.noToken;
    } else if (paused) {
      color = BADGE_COLORS.paused;
    } else if (counts.failed > 0) {
      color = BADGE_COLORS.failed;
    }
    chrome.action.setBadgeText({ text: text.slice(0, 4) });
    chrome.action.setBadgeBackgroundColor({ color });
  } catch {
    // badge updates are best effort
  }
}

async function stampNoToken(queue) {
  let changed = false;
  const next = queue.map((item) => {
    if (item.state === 'pending' && (!item.last_error || item.last_error.code !== 'NO_TOKEN')) {
      changed = true;
      return {
        ...item,
        last_error: { code: 'NO_TOKEN', message: 'API token not configured' },
      };
    }
    return item;
  });
  if (changed) await saveQueue(next);
  return next;
}

async function handlePostFailure(queue, item, err) {
  const error = normalizeApiError(err);
  await setConnection(
    error.code === 'HTTP_401' || error.code === 'HTTP_403'
      ? { connected: false, lastError: error }
      : { lastError: error },
  );
  const attempts = item.attempts + 1;
  if (isRetryable(error) && shouldRetry(attempts, MAX_ATTEMPTS)) {
    return updateItem(queue, item.fingerprint, {
      state: 'pending',
      attempts,
      last_error: error,
      next_attempt_at: nextAttemptAt(attempts, Date.now()),
    });
  }
  return updateItem(queue, item.fingerprint, {
    state: 'failed',
    attempts,
    last_error: error,
  });
}

async function processDueItem(api, queue0, item) {
  let queue = updateItem(queue0, item.fingerprint, {
    state: 'syncing',
    next_attempt_at: Date.now() + 120000,
  });
  await saveQueue(queue);
  try {
    const response = await api.createSubmission(toSubmissionPayload(item.submission));
    await setConnection({ connected: true, lastError: null });
    const jobId = response && response.sync_job_id != null ? response.sync_job_id : null;
    if (jobId) {
      queue = updateItem(queue, item.fingerprint, {
        state: 'syncing',
        job_id: jobId,
        polls: 0,
        last_error: null,
        next_attempt_at: Date.now() + computePollDelay(1) * 1000,
      });
    } else {
      queue = removeItem(queue, item.fingerprint).queue;
      await pushHistory({
        fingerprint: item.fingerprint,
        platform: item.submission.platform,
        title: item.submission.title,
        state: response && response.duplicate ? 'duplicate' : 'submitted',
        path: null,
        commit_sha: null,
        repo: null,
        at: Date.now(),
      });
    }
    await saveQueue(queue);
    return queue;
  } catch (err) {
    queue = await handlePostFailure(queue, item, err);
    await saveQueue(queue);
    return queue;
  }
}

async function completeJob(queue, item, job) {
  queue = removeItem(queue, item.fingerprint).queue;
  await saveQueue(queue);
  const lastSync = {
    at: Date.now(),
    path: job.file_path || null,
    commit_sha: job.commit_sha || null,
    repo: job.repo_full_name || null,
  };
  await storageSet(STORAGE_KEYS.LAST_SYNC, lastSync);
  await pushHistory({
    fingerprint: item.fingerprint,
    platform: item.submission.platform,
    title: item.submission.title,
    state: 'synced',
    path: lastSync.path,
    commit_sha: lastSync.commit_sha,
    repo: lastSync.repo,
    at: lastSync.at,
  });
  return queue;
}

async function processPollItem(api, queue0, item) {
  let queue = queue0;
  try {
    const job = await api.getSync(item.job_id);
    await setConnection({ connected: true, lastError: null });
    if (job && job.state === 'SYNCED') {
      return await completeJob(queue, item, job);
    }
    if (job && job.state === 'FAILED') {
      queue = updateItem(queue, item.fingerprint, {
        state: 'failed',
        last_error: {
          code: job.error_code || 'SYNC_FAILED',
          message: job.last_error || 'sync job failed',
        },
      });
      await saveQueue(queue);
      return queue;
    }
    const polls = (item.polls || 0) + 1;
    if (polls >= JOB_POLL.limit) {
      queue = updateItem(queue, item.fingerprint, {
        state: 'failed',
        polls,
        last_error: {
          code: 'POLL_TIMEOUT',
          message: `sync job did not finish after ${JOB_POLL.limit} polls`,
        },
      });
    } else {
      queue = updateItem(queue, item.fingerprint, {
        polls,
        next_attempt_at: Date.now() + computePollDelay(polls) * 1000,
      });
    }
    await saveQueue(queue);
    return queue;
  } catch (err) {
    const error = normalizeApiError(err);
    await setConnection(
      error.code === 'HTTP_401' || error.code === 'HTTP_403'
        ? { connected: false, lastError: error }
        : { lastError: error },
    );
    const attempts = item.attempts + 1;
    if (isRetryable(error) && shouldRetry(attempts, MAX_ATTEMPTS)) {
      queue = updateItem(queue, item.fingerprint, {
        attempts,
        last_error: error,
        next_attempt_at: nextAttemptAt(attempts, Date.now()),
      });
    } else {
      queue = updateItem(queue, item.fingerprint, {
        state: 'failed',
        attempts,
        last_error: error,
      });
    }
    await saveQueue(queue);
    return queue;
  }
}

async function worker({ force = false } = {}) {
  if (running) return 0;
  running = true;
  let processed = 0;
  try {
    const paused = await loadPaused();
    if (paused && !force) {
      await updateBadge();
      return 0;
    }
    const settings = await loadSettings();
    let queue = await loadQueue();
    if (!settings.apiToken) {
      queue = await stampNoToken(queue);
      await updateBadge();
      return 0;
    }
    const api = createApi({ baseUrl: settings.apiBaseUrl, token: settings.apiToken });
    await refreshPlatformsCache(api);
    const now = Date.now();
    const duePending = force ? queue.filter((i) => i.state === 'pending') : selectDue(queue, now);
    const duePolls = selectPolls(queue, now);

    for (const seed of duePending) {
      const item = queue.find((i) => i.fingerprint === seed.fingerprint);
      if (!item || item.state !== 'pending' || item.job_id != null) continue;
      processed += 1;
      queue = await processDueItem(api, queue, item);
    }
    for (const seed of duePolls) {
      const item = queue.find((i) => i.fingerprint === seed.fingerprint);
      if (!item || item.state !== 'syncing' || item.job_id == null) continue;
      if (item.next_attempt_at > Date.now()) continue;
      processed += 1;
      queue = await processPollItem(api, queue, item);
    }
    return processed;
  } catch (err) {
    console.error('[codesync] worker error', err);
    return processed;
  } finally {
    running = false;
    await updateBadge();
  }
}

function kick() {
  worker().catch((err) => console.error('[codesync] worker failed', err));
}

async function enqueueSubmission(submission) {
  if (!isPlatformUrl(submission.platform, submission.url)) {
    return fail('HOST_NOT_ALLOWED', 'submission url is outside the allowed platform hosts');
  }
  const cache = await loadPlatformsCache();
  if (cache && cache.platforms[submission.platform] === false) {
    return fail('PLATFORM_DISABLED', `${submission.platform} is disabled in platform settings`);
  }
  const queue = await loadQueue();
  const result = enqueueItem(queue, submission, { now: Date.now() });
  await saveQueue(result.queue);
  if (result.dropped) {
    await pushHistory({
      fingerprint: result.dropped.fingerprint,
      platform: result.dropped.submission.platform,
      title: result.dropped.submission.title,
      state: 'duplicate',
      path: null,
      commit_sha: null,
      repo: null,
      at: Date.now(),
    });
  }
  kick();
  return ok({ deduped: result.deduped, queueLength: result.queue.length });
}

async function getState() {
  const [queue, settings, paused, connection, history, lastSync] = await Promise.all([
    loadQueue(),
    loadSettings(),
    loadPaused(),
    loadConnection(),
    loadHistory(),
    loadLastSync(),
  ]);
  const counts = summarize(queue);
  const failedItem = queue.find((item) => item.state === 'failed' && item.last_error);
  const lastError =
    connection.lastError || (failedItem ? failedItem.last_error : null) || null;
  return ok({
    connected: Boolean(settings.apiToken) && connection.connected === true,
    paused,
    queueLength: counts.queueLength,
    pending: counts.pending + counts.syncing,
    failed: counts.failed,
    syncing: running,
    lastError,
    apiBaseUrl: settings.apiBaseUrl,
    stats: {
      pending: counts.pending,
      syncing: counts.syncing,
      failed: counts.failed,
      synced: history.filter((entry) => entry.state === 'synced').length,
      total: history.length,
    },
    queue: queue.map((item) => ({
      fingerprint: item.fingerprint,
      platform: item.submission.platform,
      title: item.submission.title,
      language: item.submission.language,
      state: item.state,
      attempts: item.attempts,
      next_attempt_at: item.next_attempt_at,
      created_at: item.created_at,
      job_id: item.job_id,
      last_error: item.last_error,
      submission: item.submission,
    })),
    lastSync,
    history: history.slice(0, 20),
  });
}

async function testConnection() {
  const settings = await loadSettings();
  if (!settings.apiToken) {
    return fail('NO_TOKEN', 'No API token configured');
  }
  const api = createApi({ baseUrl: settings.apiBaseUrl, token: settings.apiToken });
  try {
    const me = await api.authMe();
    const githubLogin = me && (me.github_login || (me.user && me.user.github_login)) || null;
    await setConnection({ connected: true, github_login: githubLogin, lastError: null });
    await refreshPlatformsCache(api, true);
    return ok({ connected: true, github_login: githubLogin });
  } catch (err) {
    const error = normalizeApiError(err);
    await setConnection({
      connected: false,
      github_login: null,
      lastError: error,
    });
    return fail(error.code, error.message);
  }
}

async function scheduleAuthCheck() {
  const settings = await loadSettings();
  if (!settings.apiToken) return;
  const api = createApi({ baseUrl: settings.apiBaseUrl, token: settings.apiToken });
  try {
    const me = await api.authMe();
    const githubLogin = me && (me.github_login || (me.user && me.user.github_login)) || null;
    await setConnection({ connected: true, github_login: githubLogin, lastError: null });
  } catch (err) {
    const error = normalizeApiError(err);
    await setConnection({ connected: false, github_login: null, lastError: error });
  }
  await refreshPlatformsCache(api, true);
  await updateBadge();
}

async function retryItem(fingerprint) {
  const queue = await loadQueue();
  const item = queue.find((entry) => entry.fingerprint === fingerprint);
  if (!item) return fail('NOT_FOUND', 'queue item not found');
  const settings = await loadSettings();

  if (item.job_id != null && item.state === 'failed' && settings.apiToken) {
    const api = createApi({ baseUrl: settings.apiBaseUrl, token: settings.apiToken });
    try {
      const response = await api.retrySync(item.job_id);
      const jobId = response && response.job ? response.job.id : item.job_id;
      const next = updateItem(queue, fingerprint, {
        state: 'syncing',
        job_id: jobId,
        polls: 0,
        attempts: 0,
        last_error: null,
        next_attempt_at: Date.now() + computePollDelay(1) * 1000,
      });
      await saveQueue(next);
      kick();
      return ok({ queueLength: next.length });
    } catch (err) {
      const error = normalizeApiError(err);
      return fail(error.code, error.message);
    }
  }

  const next = updateItem(queue, fingerprint, markPendingRetry(item, Date.now()));
  await saveQueue(next);
  kick();
  return ok({ queueLength: next.length });
}

async function handleMessage(message) {
  const validation = validateMessage(message);
  if (!validation.ok) {
    return fail(validation.error.code, validation.error.message);
  }
  const { type, payload } = validation;
  switch (type) {
    case 'PING':
      return ok();
    case 'GET_STATE':
      return getState();
    case 'ENQUEUE':
    case 'SUBMIT_MANUAL':
      return enqueueSubmission(payload);
    case 'SET_PAUSED': {
      await storageSet(STORAGE_KEYS.PAUSED, payload.paused);
      if (!payload.paused) kick();
      await updateBadge();
      return ok({ paused: payload.paused });
    }
    case 'CLEAR_QUEUE': {
      await saveQueue([]);
      await updateBadge();
      return ok({ queueLength: 0 });
    }
    case 'SYNC_NOW': {
      const queue = await loadQueue();
      const now = Date.now();
      const requeued = queue.map((item) =>
        item.state === 'pending' ? { ...item, next_attempt_at: now } : item,
      );
      await saveQueue(requeued);
      const processed = await worker({ force: true });
      return ok({ processed });
    }
    case 'GET_SETTINGS': {
      const settings = await loadSettings();
      return ok({ settings });
    }
    case 'SET_SETTINGS': {
      const current = await loadSettings();
      const settings = { ...current, ...payload };
      await storageSet(STORAGE_KEYS.SETTINGS, settings);
      if (payload.apiToken !== undefined || payload.apiBaseUrl !== undefined) {
        scheduleAuthCheck().catch(() => {});
      }
      await updateBadge();
      return ok({ settings });
    }
    case 'TEST_CONNECTION':
      return testConnection();
    case 'REMOVE_ITEM': {
      const queue = await loadQueue();
      const result = removeItem(queue, payload.fingerprint);
      await saveQueue(result.queue);
      await updateBadge();
      return ok({ queueLength: result.queue.length, removed: Boolean(result.removed) });
    }
    case 'RETRY_ITEM':
      return retryItem(payload.fingerprint);
    default:
      return fail('UNKNOWN_MESSAGE', `unknown message type: ${type}`);
  }
}

function ensureAlarm() {
  try {
    const result = chrome.alarms.create(ALARM.name, {
      periodInMinutes: ALARM.periodMinutes,
    });
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch {
    // alarms are best effort
  }
}

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    handleMessage(message)
      .then(sendResponse)
      .catch((err) => sendResponse(fail('INTERNAL', (err && err.message) || 'internal error')));
    return true;
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm && alarm.name === ALARM.name) kick();
  });

  if (chrome.runtime.onInstalled) {
    chrome.runtime.onInstalled.addListener(() => {
      ensureAlarm();
      kick();
    });
  }
  if (chrome.runtime.onStartup) {
    chrome.runtime.onStartup.addListener(() => {
      ensureAlarm();
      kick();
    });
  }

  ensureAlarm();
  kick();
}
