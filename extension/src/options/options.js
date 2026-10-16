import { createApi } from '../shared/api.js';
import { connectWithGitHub } from '../shared/auth.js';
import { DEFAULT_API_BASE_URL, PLATFORM_IDS, PLATFORM_LABELS } from '../shared/config.js';
import { request } from '../shared/messaging.js';
import { stableFingerprint, validateSubmission } from '../shared/schema.js';
import { ADAPTERS } from '../adapters/index.js';

const $ = (id) => document.getElementById(id);

const CAPABILITY_BADGES = [
  ['submission_detection', 'auto-detect'],
  ['verdict_extraction', 'verdicts'],
  ['solution_code_extraction', 'code'],
  ['problem_metadata', 'metadata'],
  ['submission_id', 'submission id'],
  ['timestamp', 'timestamp'],
];

let localSettings = { apiBaseUrl: DEFAULT_API_BASE_URL, apiToken: '' };
let remoteSettings = null;
let api = null;
let toastTimer = null;
let pollTimer = null;

function toast(message, isError = false) {
  const node = $('toast');
  node.textContent = message;
  node.classList.toggle('toast-error', isError);
  node.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 3200);
}

function shortFingerprint(fingerprint) {
  return `${fingerprint.slice(0, 8)}…${fingerprint.slice(-4)}`;
}

function setConnected(connected, githubLogin = null) {
  const chip = $('conn');
  chip.textContent = connected ? 'connected' : 'not connected';
  chip.classList.toggle('chip-ok', connected);
  chip.classList.toggle('chip-off', !connected);
  const link = $('repo-link');
  if (connected && githubLogin) {
    link.href = `https://github.com/${githubLogin}`;
    link.textContent = `@${githubLogin}`;
    link.hidden = false;
  } else if (!connected) {
    link.hidden = true;
  }
}

function isLocalOrigin(baseUrl) {
  try {
    const { hostname } = new URL(baseUrl);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
  } catch {
    return false;
  }
}

async function ensurePermission(baseUrl) {
  if (isLocalOrigin(baseUrl)) return true;
  let origin;
  try {
    origin = `${new URL(baseUrl).origin}/*`;
  } catch {
    return false;
  }
  if (typeof chrome === 'undefined' || !chrome.permissions) return true;
  const descriptor = { origins: [origin] };
  try {
    if (await chrome.permissions.contains(descriptor)) return true;
    return await chrome.permissions.request(descriptor);
  } catch {
    return false;
  }
}

function apiFromSettings() {
  if (!localSettings.apiToken) return null;
  return createApi({ baseUrl: localSettings.apiBaseUrl, token: localSettings.apiToken });
}

function readForm() {
  return {
    apiBaseUrl: $('api-base-url').value.trim() || DEFAULT_API_BASE_URL,
    apiToken: $('api-token').value,
  };
}

function fillForm() {
  $('api-base-url').value = localSettings.apiBaseUrl;
  $('api-token').value = localSettings.apiToken;
}

function renderRemoteSettings(settings) {
  remoteSettings = settings;
  if (!settings) {
    $('branch').value = '';
    $('root-folder').value = '';
    $('auto-sync').checked = true;
    return;
  }
  $('branch').value = settings.branch || '';
  $('root-folder').value = settings.root_folder || '';
  $('auto-sync').checked = settings.auto_sync !== false;
  const link = $('repo-link');
  if (settings.repo_full_name) {
    link.href = `https://github.com/${settings.repo_full_name}`;
    link.textContent = settings.repo_full_name;
    link.title = `Open ${settings.repo_full_name} on GitHub`;
    link.hidden = false;
    const select = $('repo-select');
    const existing = Array.from(select.options).find((o) => o.value === settings.repo_full_name);
    if (existing) select.value = settings.repo_full_name;
  }
}

async function loadLocal() {
  const response = await request('GET_SETTINGS');
  localSettings = response.settings;
  fillForm();
  api = apiFromSettings();
}

async function probeConnection() {
  if (!api) {
    setConnected(false);
    $('test-result').textContent = 'No API token configured.';
    return;
  }
  try {
    const me = await api.authMe();
    setConnected(true, me.github_login || (me.user && me.user.github_login) || null);
    $('test-result').className = 'hint hint-ok';
    $('test-result').textContent = `Authenticated${
      me.github_login ? ` as ${me.github_login}` : ''
    }.`;
  } catch {
    setConnected(false);
  }
}

async function loadRemoteSettings() {
  if (!api) {
    renderRemoteSettings(null);
    return;
  }
  try {
    const settings = await api.getSettings();
    renderRemoteSettings(settings);
  } catch (err) {
    renderRemoteSettings(null);
    if (err && err.code && err.code !== 'NO_TOKEN') {
      toast(`Repository settings unavailable: ${err.message}`, true);
    }
  }
}

async function loadRepos() {
  const select = $('repo-select');
  select.replaceChildren();
  if (!api) {
    select.append(new Option('Configure an API token first', ''));
    return;
  }
  try {
    const response = await api.listRepos({ page: 1, per_page: 100 });
    const items = (response && response.items) || [];
    select.append(new Option('Select a repository…', ''));
    for (const repo of items) {
      select.append(new Option(repo.full_name, repo.full_name));
    }
    if (remoteSettings && remoteSettings.repo_full_name) {
      select.value = remoteSettings.repo_full_name;
    }
    if (items.length === 0) toast('No repositories found for this account');
  } catch (err) {
    select.append(new Option('Failed to load repositories', ''));
    toast(`Repositories: ${err.message}`, true);
  }
}

async function createRepo() {
  const name = $('repo-name').value.trim();
  if (!name) {
    toast('Enter a repository name', true);
    return;
  }
  if (!api) {
    toast('Configure an API token first', true);
    return;
  }
  try {
    const repo = await api.createRepo({
      name,
      description: $('repo-desc').value.trim() || undefined,
      private: $('repo-private').checked,
    });
    const select = $('repo-select');
    select.append(new Option(repo.full_name, repo.full_name));
    select.value = repo.full_name;
    toast(`Created ${repo.full_name}`);
    if (remoteSettings) {
      try {
        const updated = await api.updateSettings({ repo_full_name: repo.full_name });
        renderRemoteSettings(updated);
      } catch {
        // saved on next explicit save
      }
    }
  } catch (err) {
    toast(`Create repo failed: ${err.message}`, true);
  }
}

function capabilityBadges(capabilities) {
  const wrap = document.createElement('div');
  wrap.className = 'badges';
  if (!capabilities) {
    const badge = document.createElement('span');
    badge.className = 'badge badge-muted';
    badge.textContent = 'unknown';
    wrap.append(badge);
    return wrap;
  }
  let added = 0;
  for (const [key, label] of CAPABILITY_BADGES) {
    if (!capabilities[key]) continue;
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = label;
    wrap.append(badge);
    added += 1;
  }
  if (added === 0) {
    const badge = document.createElement('span');
    badge.className = 'badge badge-muted';
    badge.textContent = 'metadata only';
    wrap.append(badge);
  }
  if (capabilities.requires_login) {
    const badge = document.createElement('span');
    badge.className = 'badge badge-muted';
    badge.textContent = 'login required';
    wrap.append(badge);
  }
  return wrap;
}

function localMatrix() {
  return ADAPTERS.map((adapter) => ({
    id: adapter.id,
    name: PLATFORM_LABELS[adapter.id] || adapter.id,
    enabled: true,
    capabilities: { ...adapter.capabilities },
    local: true,
  }));
}

async function loadPlatforms() {
  let rows;
  let remote = true;
  if (api) {
    try {
      const response = await api.getPlatforms();
      rows = (response && response.platforms) || [];
    } catch {
      rows = localMatrix();
      remote = false;
    }
  } else {
    rows = localMatrix();
    remote = false;
  }
  renderPlatforms(rows, remote);
}

function renderPlatforms(rows, remote) {
  const container = $('platforms');
  container.replaceChildren();
  if (!rows.length) {
    container.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: 'No platforms available.' }));
    return;
  }
  if (!remote) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'Connect the API to enable or disable platforms. Showing the local capability matrix.';
    container.append(hint);
  }
  for (const row of rows) {
    const item = document.createElement('div');
    item.className = 'platform-row';

    const info = document.createElement('div');
    info.className = 'platform-info';
    const name = document.createElement('span');
    name.className = 'platform-name';
    name.textContent = row.name || PLATFORM_LABELS[row.id] || row.id;
    info.append(name, capabilityBadges(row.capabilities));

    const label = document.createElement('label');
    label.className = 'switch';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = row.enabled !== false;
    input.disabled = !remote;
    input.addEventListener('change', async () => {
      input.disabled = true;
      try {
        const response = await api.setPlatform(row.id, input.checked);
        const updated = (response.platforms || []).find((p) => p.id === row.id);
        renderPlatforms(
          (response.platforms || []).map((p) => ({
            ...p,
            enabled: updated ? updated.enabled : p.enabled,
          })),
          true,
        );
        await request('SET_SETTINGS', { apiBaseUrl: localSettings.apiBaseUrl }).catch(() => {});
        toast(`${name.textContent} ${input.checked ? 'enabled' : 'disabled'}`);
      } catch (err) {
        toast(err.message, true);
        input.disabled = false;
      }
    });
    const slider = document.createElement('span');
    slider.className = 'slider';
    label.append(input, slider);
    item.append(info, label);
    container.append(item);
  }
}

function statTile(value, label, breakdown) {
  const tile = document.createElement('div');
  tile.className = 'stat-tile';
  const val = document.createElement('span');
  val.className = 'value';
  val.textContent = String(value);
  const lab = document.createElement('span');
  lab.className = 'label';
  lab.textContent = label;
  tile.append(val, lab);
  if (breakdown) {
    const extra = document.createElement('div');
    extra.className = 'stat-breakdown';
    extra.textContent = breakdown;
    tile.append(extra);
  }
  return tile;
}

function formatBreakdown(map) {
  if (!map) return '';
  const entries = Object.entries(map).filter(([, value]) => value > 0);
  if (!entries.length) return '';
  return entries.map(([key, value]) => `${key}: ${value}`).join(' · ');
}

async function loadStats() {
  const container = $('stats');
  if (!api) {
    container.replaceChildren();
    container.append(
      Object.assign(document.createElement('p'), {
        className: 'hint',
        textContent: 'Configure an API token to see sync statistics.',
      }),
    );
    return;
  }
  try {
    const stats = await api.getStats();
    container.replaceChildren(
      statTile(stats.submissions_total ?? 0, 'submissions'),
      statTile(stats.accepted_total ?? 0, 'accepted'),
      statTile(formatBreakdown(stats.jobs_by_state) || '—', 'jobs by state'),
      statTile(formatBreakdown(stats.submissions_by_platform) || '—', 'submissions by platform'),
      statTile(formatBreakdown(stats.synced_by_platform) || '—', 'synced by platform'),
    );
  } catch {
    container.replaceChildren();
    container.append(
      Object.assign(document.createElement('p'), {
        className: 'hint',
        textContent: 'Stats unavailable until the API is reachable.',
      }),
    );
  }
}

function queueRow(item) {
  const li = document.createElement('li');

  const fp = document.createElement('span');
  fp.className = 'fp';
  fp.textContent = shortFingerprint(item.fingerprint);

  const body = document.createElement('div');
  body.className = 'body';
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = `${item.title} · ${item.language || ''}`.trim();
  const meta = document.createElement('div');
  meta.className = 'meta';
  if (item.last_error) {
    meta.textContent = `${item.last_error.code}: ${item.last_error.message}`;
  } else if (item.job_id != null) {
    meta.textContent = `job #${item.job_id} · attempt ${item.attempts}`;
  } else {
    meta.textContent = `${item.platform} · attempt ${item.attempts}`;
  }
  body.append(title, meta);

  const chip = document.createElement('span');
  chip.className = `state state-${item.state}`;
  chip.textContent = item.state === 'done' ? 'synced' : item.state;

  const cell = document.createElement('div');
  cell.className = 'actions-cell';
  const retry = document.createElement('button');
  retry.className = 'btn btn-sm';
  retry.type = 'button';
  retry.textContent = 'Retry';
  retry.disabled = item.state === 'syncing' || item.state === 'done';
  retry.addEventListener('click', async () => {
    retry.disabled = true;
    try {
      await request('RETRY_ITEM', { fingerprint: item.fingerprint });
      toast('Retry scheduled');
      await refreshQueue();
    } catch (err) {
      toast(err.message, true);
      retry.disabled = false;
    }
  });
  const remove = document.createElement('button');
  remove.className = 'btn btn-sm btn-ghost';
  remove.type = 'button';
  remove.textContent = 'Remove';
  remove.addEventListener('click', async () => {
    try {
      await request('REMOVE_ITEM', { fingerprint: item.fingerprint });
      await refreshQueue();
    } catch (err) {
      toast(err.message, true);
    }
  });
  cell.append(retry, remove);

  li.append(fp, body, chip, cell);
  return li;
}

async function refreshQueue() {
  try {
    const state = await request('GET_STATE');
    setConnected(state.connected);
    const items = Array.isArray(state.queue) ? state.queue : [];
    const list = $('queue-list');
    list.replaceChildren(...items.map(queueRow));
    $('queue-empty').hidden = items.length > 0;
    const parts = [
      `${items.length} item${items.length === 1 ? '' : 's'}`,
      `${state.pending} pending`,
      `${state.failed} failed`,
    ];
    if (state.paused) parts.push('paused');
    $('queue-summary').textContent = parts.join(' · ');
    if (state.lastError && state.lastError.code === 'NO_TOKEN') {
      $('test-result').className = 'hint hint-error';
      $('test-result').textContent = 'No API token configured.';
    }
  } catch (err) {
    toast(err.message, true);
  }
}

async function saveSettings() {
  const form = readForm();
  if (!(await ensurePermission(form.apiBaseUrl))) {
    toast('Host permission denied for that API origin', true);
    return;
  }
  try {
    const response = await request('SET_SETTINGS', form);
    localSettings = response.settings;
    api = apiFromSettings();
  } catch (err) {
    toast(err.message, true);
    return;
  }
  if (api) {
    const patch = { repo_full_name: $('repo-select').value || null, auto_sync: $('auto-sync').checked };
    const branch = $('branch').value.trim();
    const root = $('root-folder').value.trim();
    if (branch) patch.branch = branch;
    if (root) patch.root_folder = root;
    try {
      const updated = await api.updateSettings(patch);
      renderRemoteSettings(updated);
    } catch (err) {
      toast(`Repository settings: ${err.message}`, true);
      return;
    }
  }
  toast('Settings saved');
  await probeConnection();
  await loadPlatforms();
}

async function finishConnect(baseUrl, token, label) {
  if (!(await ensurePermission(baseUrl))) {
    toast('Host permission denied for that API origin', true);
    return;
  }
  const response = await request('SET_SETTINGS', { apiBaseUrl: baseUrl, apiToken: token });
  localSettings = response.settings;
  api = apiFromSettings();
  $('api-token').value = token;
  toast(label);
  await probeConnection();
  await loadRemoteSettings();
  await loadRepos();
  await loadPlatforms();
  await loadStats();
  await refreshQueue();
}

async function oauthSignIn() {
  const baseUrl = $('api-base-url').value.trim() || DEFAULT_API_BASE_URL;
  $('test-result').className = 'hint';
  $('test-result').textContent = 'Waiting for GitHub…';
  try {
    const token = await connectWithGitHub(baseUrl);
    await finishConnect(baseUrl, token, 'Signed in with GitHub');
    $('test-result').className = 'hint hint-ok';
    $('test-result').textContent = 'Signed in — token stored automatically.';
  } catch (err) {
    setConnected(false);
    $('test-result').className = 'hint hint-error';
    $('test-result').textContent = `GitHub sign-in failed: ${err.message}. If the backend has no OAuth app, use the PAT option below.`;
    $('pat-details').open = true;
  }
}

async function patSignIn() {
  const baseUrl = $('api-base-url').value.trim() || DEFAULT_API_BASE_URL;
  const pat = $('github-pat').value.trim();
  if (!pat) {
    toast('Enter a GitHub personal access token first', true);
    return;
  }
  if (!(await ensurePermission(baseUrl))) {
    toast('Host permission denied for that API origin', true);
    return;
  }
  try {
    const out = await createApi({ baseUrl }).connectWithPat(pat);
    $('github-pat').value = '';
    await finishConnect(baseUrl, out.api_token, `Connected as ${out.github_login}`);
  } catch (err) {
    toast(`Connect failed: ${err.code ? `${err.code}: ` : ''}${err.message}`, true);
  }
}

async function testConnection() {
  const form = readForm();
  $('test-result').className = 'hint';
  $('test-result').textContent = 'Testing…';
  if (!(await ensurePermission(form.apiBaseUrl))) {
    $('test-result').className = 'hint hint-error';
    $('test-result').textContent = 'Host permission denied for that API origin.';
    return;
  }
  try {
    const settingsResponse = await request('SET_SETTINGS', form);
    localSettings = settingsResponse.settings;
    api = apiFromSettings();
    const result = await request('TEST_CONNECTION');
    setConnected(true, result.github_login || null);
    $('test-result').className = 'hint hint-ok';
    $('test-result').textContent = `Connected${
      result.github_login ? ` as ${result.github_login}` : ''
    }.`;
    await loadRepos();
    await loadPlatforms();
    await loadStats();
    await loadRemoteSettings();
  } catch (err) {
    setConnected(false);
    $('test-result').className = 'hint hint-error';
    $('test-result').textContent = `${err.code || 'ERROR'}: ${err.message}`;
  }
}

async function submitManual() {
  const platform = $('manual-platform').value;
  const title = $('manual-title').value.trim();
  const language = $('manual-language').value.trim();
  const url = $('manual-url').value.trim() || null;
  const code = $('manual-code').value;

  if (!title || !language || !code.trim()) {
    toast('Title, language and code are required', true);
    return;
  }
  const submission = {
    platform,
    title,
    problem_id: null,
    url,
    language,
    code,
    external_id: null,
    verdict: 'manual',
    submitted_at: new Date().toISOString(),
    metadata: null,
    fingerprint: stableFingerprint(platform, null, url, language, code),
  };
  const validation = validateSubmission(submission);
  if (!validation.ok) {
    toast(validation.error.message, true);
    return;
  }
  try {
    const result = await request('SUBMIT_MANUAL', submission);
    toast(result.deduped ? 'Already queued' : 'Manual submission queued');
    $('manual-code').value = '';
    await refreshQueue();
  } catch (err) {
    toast(err.message, true);
  }
}

async function deleteAccount() {
  const confirmed = window.confirm(
    'Delete the CodeSync account and ALL stored submissions, sync jobs and settings? This cannot be undone.',
  );
  if (!confirmed) return;
  if (!api) {
    toast('Configure an API token first', true);
    return;
  }
  try {
    await api.deleteAccount();
    await request('SET_SETTINGS', { apiBaseUrl: localSettings.apiBaseUrl, apiToken: '' });
    localSettings.apiToken = '';
    api = null;
    remoteSettings = null;
    renderRemoteSettings(null);
    setConnected(false);
    $('test-result').className = 'hint';
    $('test-result').textContent = 'Account deleted.';
    toast('Account deleted');
    await loadRepos();
    await loadPlatforms();
    await loadStats();
    await refreshQueue();
  } catch (err) {
    toast(`Delete failed: ${err.message}`, true);
  }
}

async function clearQueue() {
  try {
    await request('CLEAR_QUEUE');
    toast('Queue cleared');
    await refreshQueue();
  } catch (err) {
    toast(err.message, true);
  }
}

function bind() {
  $('btn-save').addEventListener('click', () => {
    saveSettings().catch((err) => toast(err.message, true));
  });
  $('btn-oauth').addEventListener('click', () => {
    oauthSignIn().catch((err) => toast(err.message, true));
  });
  $('btn-pat').addEventListener('click', () => {
    patSignIn().catch((err) => toast(err.message, true));
  });
  $('btn-test').addEventListener('click', () => {
    testConnection().catch((err) => toast(err.message, true));
  });
  $('btn-reload-repos').addEventListener('click', () => {
    loadRepos().catch((err) => toast(err.message, true));
  });
  $('btn-create-repo').addEventListener('click', () => {
    createRepo().catch((err) => toast(err.message, true));
  });
  $('btn-manual').addEventListener('click', () => {
    submitManual().catch((err) => toast(err.message, true));
  });
  $('btn-delete').addEventListener('click', () => {
    deleteAccount().catch((err) => toast(err.message, true));
  });
  $('btn-clear-queue').addEventListener('click', () => {
    clearQueue().catch((err) => toast(err.message, true));
  });
}

async function init() {
  const platformSelect = $('manual-platform');
  for (const id of PLATFORM_IDS) {
    platformSelect.append(new Option(PLATFORM_LABELS[id] || id, id));
  }
  bind();
  try {
    await loadLocal();
    await probeConnection();
    await loadRemoteSettings();
    await loadRepos();
    await loadPlatforms();
    await loadStats();
    await refreshQueue();
  } catch (err) {
    toast(err.message, true);
  }
  pollTimer = setInterval(() => {
    refreshQueue().catch(() => {});
    loadStats().catch(() => {});
  }, 5000);
  window.addEventListener('unload', () => {
    if (pollTimer) clearInterval(pollTimer);
  });
}

init();
