import { PLATFORM_IDS } from './config.js';

export const PLATFORM_HOSTS = {
  leetcode: ['leetcode.com'],
  geeksforgeeks: ['geeksforgeeks.org'],
  codechef: ['codechef.com'],
  neetcode: ['neetcode.io'],
};

export function hostsForPlatform(platformId) {
  return PLATFORM_HOSTS[platformId] || [];
}

export function allowedHostnames() {
  return PLATFORM_IDS.flatMap((id) => hostsForPlatform(id));
}

export function isAllowedHostname(hostname) {
  if (!hostname) return false;
  const host = String(hostname).toLowerCase().replace(/\.$/, '');
  return allowedHostnames().some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

export function isAllowedUrl(url) {
  try {
    return isAllowedHostname(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function platformForUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
    const match = PLATFORM_IDS.find((id) =>
      hostsForPlatform(id).some((allowed) => host === allowed || host.endsWith(`.${allowed}`)),
    );
    return match || null;
  } catch {
    return null;
  }
}

export function isPlatformUrl(platform, url) {
  if (!PLATFORM_IDS.includes(platform)) return false;
  if (!url) return true;
  return platformForUrl(url) === platform;
}

export function contentScriptMatches() {
  return PLATFORM_IDS.map((id) => {
    const host = hostsForPlatform(id)[0];
    return `https://*.${host}/*`;
  });
}
