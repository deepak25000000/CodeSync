import { createApi } from '../shared/api.js';
import { getActiveTabId, request, sendTabMessage } from '../shared/messaging.js';

const $ = (id) => document.getElementById(id);

let currentState = null;
let toastTimer = null;

function toast(message, isError = false) {
  const node = $('toast');
  node.textContent = message;
  node.classList.toggle('toast-error', isError);
  node.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 2600);
}

function shortFingerprint(fingerprint) {
  return `${fingerprint.slice(0, 8)}…${fingerprint.slice(-4)}`;
}

function stateLabel(state) {
  if (state === 'done') return 'synced';
  return state;
}

function render(state) {
  currentState = state;
  document.body.classList.toggle('is-paused', state.paused);

  const conn = $('conn');
  conn.textContent = state.connected ? 'connected' : 'not connected';
  conn.classList.toggle('chip-ok', state.connected);
  conn.classList.toggle('chip-off', !state.connected);
  conn.title = state.apiBaseUrl || '';

  $('stat-pending').textContent = String(state.pending ?? 0);
  $('stat-synced').textContent = String((state.stats && state.stats.synced) ?? 0);
  $('stat-failed').textContent = String(state.failed ?? 0);

  const items = Array.isArray(state.queue) ? state.queue : [];
  const visible = items.slice(0, 6);
  const list = $('queue');
  list.replaceChildren();
  for (const item of visible) {
    const li = document.createElement('li');

    const fp = document.createElement('span');
    fp.className = 'fp';
    fp.textContent = shortFingerprint(item.fingerprint);

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = item.title || '(untitled)';

    const chip = document.createElement('span');
    chip.className = `state state-${item.state}`;
    chip.textContent = stateLabel(item.state);
    if (item.last_error) {
      chip.title = `${item.last_error.code}: ${item.last_error.message}`;
    } else if (item.job_id != null) {
      chip.title = `sync job #${item.job_id}`;
    }

    li.append(fp, title, chip);
    list.append(li);
  }

  const empty = $('queue-empty');
  empty.hidden = items.length > 0;
  $('queue-meta').textContent = items.length
    ? `${items.length} item${items.length === 1 ? '' : 's'}`
    : '';

  const failedCount = state.failed ?? 0;
  $('btn-clear-failed').disabled = failedCount === 0;
  $('btn-pause').textContent = state.paused ? 'Resume' : 'Pause';

  const lastSync = $('last-sync');
  if (state.lastSync && (state.lastSync.path || state.lastSync.repo)) {
    const repo = state.lastSync.repo ? `${state.lastSync.repo}` : '';
    const path = state.lastSync.path || '';
    lastSync.textContent = `Last sync: ${path || 'done'}${repo ? ` · ${repo}` : ''}`;
    lastSync.hidden = false;
  } else {
    lastSync.hidden = true;
  }
}

async function refresh() {
  try {
    const state = await request('GET_STATE');
    render(state);
    return state;
  } catch (err) {
    toast(err.message, true);
    return null;
  }
}

async function syncThisPage() {
  try {
    const tabId = await getActiveTabId();
    if (tabId === null) throw new Error('No active tab');
    const response = await sendTabMessage(tabId, { type: 'SYNC_PAGE', payload: {} });
    if (!response || response.ok !== true) {
      throw new Error((response && response.error && response.error.message) || 'This page is not supported');
    }
    if (!response.submission) {
      const reasons = {
        unsupported_host: 'Open a supported platform page first',
        unsupported_page: 'This page cannot be synced',
        nothing_found: 'No solution code detected on this page',
      };
      toast(reasons[response.reason] || 'Nothing to sync on this page');
      return;
    }
    const submission = response.submission;
    let type = 'ENQUEUE';
    if (submission.verdict !== 'accepted') {
      submission.verdict = 'manual';
      type = 'SUBMIT_MANUAL';
    }
    const result = await request(type, submission);
    toast(result.deduped ? 'Already queued' : 'Queued for sync');
    await refresh();
  } catch (err) {
    toast(err.message, true);
  }
}

async function syncNow() {
  try {
    const result = await request('SYNC_NOW');
    if (result.processed === 0) {
      toast(currentState && currentState.pending ? 'Worker busy or paused' : 'Nothing pending');
    } else {
      toast(`Processing ${result.processed} item${result.processed === 1 ? '' : 's'}`);
    }
    await refresh();
  } catch (err) {
    toast(err.message, true);
  }
}

async function togglePause() {
  try {
    if (!currentState) return;
    const result = await request('SET_PAUSED', { paused: !currentState.paused });
    toast(result.paused ? 'Paused' : 'Resumed');
    await refresh();
  } catch (err) {
    toast(err.message, true);
  }
}

async function clearFailed() {
  try {
    if (!currentState || !Array.isArray(currentState.queue)) return;
    const failed = currentState.queue.filter((item) => item.state === 'failed');
    for (const item of failed) {
      await request('REMOVE_ITEM', { fingerprint: item.fingerprint });
    }
    toast(`Cleared ${failed.length} failed item${failed.length === 1 ? '' : 's'}`);
    await refresh();
  } catch (err) {
    toast(err.message, true);
  }
}

async function loadRepoLink() {
  try {
    const settingsResponse = await request('GET_SETTINGS');
    const settings = settingsResponse.settings;
    if (!settings || !settings.apiToken) return;
    const api = createApi({ baseUrl: settings.apiBaseUrl, token: settings.apiToken });
    const remote = await api.getSettings();
    if (remote && remote.repo_full_name) {
      const link = $('repo-link');
      link.href = `https://github.com/${remote.repo_full_name}`;
      link.textContent = remote.repo_full_name;
      link.title = `Open ${remote.repo_full_name} on GitHub`;
      link.hidden = false;
    }
  } catch {
    // repo link is optional
  }
}

function bind() {
  $('btn-sync-page').addEventListener('click', syncThisPage);
  $('btn-sync').addEventListener('click', syncNow);
  $('btn-pause').addEventListener('click', togglePause);
  $('btn-clear-failed').addEventListener('click', clearFailed);
  $('btn-options').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
}

async function init() {
  bind();
  await refresh();
  loadRepoLink();
}

init();
