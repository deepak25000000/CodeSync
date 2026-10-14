export const DEFAULT_API_BASE_URL = 'http://127.0.0.1:8000';

export const API_PREFIX = '/api/v1';

export const STORAGE_KEYS = {
  QUEUE: 'codesync.queue',
  SETTINGS: 'codesync.settings',
  PAUSED: 'codesync.paused',
  CONNECTION: 'codesync.connection',
  HISTORY: 'codesync.history',
  LAST_SYNC: 'codesync.lastSync',
  PLATFORMS: 'codesync.platforms',
};

export const PLATFORM_IDS = ['leetcode', 'geeksforgeeks', 'codechef', 'neetcode'];

export const PLATFORM_LABELS = {
  leetcode: 'LeetCode',
  geeksforgeeks: 'GeeksforGeeks',
  codechef: 'CodeChef',
  neetcode: 'NeetCode',
};

export const VERDICTS = ['accepted', 'rejected', 'pending', 'manual', 'unknown'];

export const QUEUE_STATES = ['pending', 'syncing', 'done', 'failed'];

export const MAX_ATTEMPTS = 5;

export const BACKOFF = { base: 2, factor: 2, cap: 300 };

export const JOB_POLL = { min: 3, max: 30, limit: 10 };

export const ALARM = { name: 'codesync.tick', periodMinutes: 0.5 };

export const REQUEST_TIMEOUT_MS = 15000;

export const HISTORY_LIMIT = 200;

export const BADGE_COLORS = {
  ok: '#16a34a',
  failed: '#dc2626',
  paused: '#6b7280',
  noToken: '#f59e0b',
};

export function defaultSettings() {
  return { apiBaseUrl: DEFAULT_API_BASE_URL, apiToken: '' };
}
