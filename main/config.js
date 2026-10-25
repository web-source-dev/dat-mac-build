'use strict';

const path = require('path');
const fs = require('fs');

/** Production defaults — used when .env is missing (packaged installs). */
const DEFAULT_MAIN_API_URL = 'https://api.datdesk.apexskillzone.com';
const DEFAULT_BASE_API_URL = 'https://datdesk.apexskillzone.com';
const DEFAULT_BACKUP_API_URL = 'https://datdeskbackup.apexskillzone.com';

function getElectronApp() {
  try {
    return require('electron').app;
  } catch {
    return null;
  }
}

function loadEnv() {
  const candidates = [
    path.join(__dirname, '../../.env'),
    path.join(process.cwd(), '.env')
  ];
  const electronApp = getElectronApp();
  try {
    if (electronApp) {
      candidates.push(path.join(path.dirname(electronApp.getPath('exe')), '.env'));
      if (process.resourcesPath) {
        candidates.push(path.join(process.resourcesPath, '.env'));
      }
    }
  } catch {
    // app path may be unavailable very early — cwd / relative still tried
  }
  for (const file of candidates) {
    if (!file || !fs.existsSync(file)) continue;
    try {
      require('dotenv').config({ path: file });
      console.log('[API] Loaded env from', file);
      return;
    } catch {
      // ignore
    }
  }
}

loadEnv();

function clean(url) {
  return String(url || '')
    .trim()
    .replace(/\/+$/, '');
}

function uniqueUrls(urls) {
  return urls.filter((url, idx, arr) => url && arr.indexOf(url) === idx);
}

function isValidHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Raw VPS IP on port 80/443 (no explicit API port) hits nginx default site,
 * which returns 405 Method Not Allowed on POST — not the Dat Desk API.
 */
function isBareHostWithoutApiPort(url) {
  try {
    const parsed = new URL(url);
    const hostIsIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(parsed.hostname);
    if (!hostIsIp) return false;
    // Explicit API ports (e.g. :7020) are allowed for local/VPS debugging.
    if (parsed.port && parsed.port !== '80' && parsed.port !== '443') return false;
    return true;
  } catch {
    return false;
  }
}

// Failover order: main → primary (base) → backup
const MAIN_API_URL = clean(
  process.env.API_MAIN_URL || process.env.VITE_API_MAIN_URL || DEFAULT_MAIN_API_URL
);
const BASE_API_URL = clean(
  process.env.API_BASE_URL || process.env.VITE_API_BASE_URL || DEFAULT_BASE_API_URL
);
const BACKUP_API_URL = clean(
  process.env.API_BACKUP_URL || process.env.VITE_API_BACKUP_URL || DEFAULT_BACKUP_API_URL
);

const API_URLS = uniqueUrls([MAIN_API_URL, BASE_API_URL, BACKUP_API_URL]);
const PRIMARY_API_URL = API_URLS[0] || BASE_API_URL;

// App updates: primary (base) → backup ONLY — never API_MAIN_URL (e.g. Render).
const UPDATE_API_URLS = uniqueUrls([BASE_API_URL, BACKUP_API_URL]);

const APP_SLUG = 'datdesk-mac';

/** Saved custom URL (persists even when disabled). */
let customServerUrl = '';
/** When true and URL is set, app uses ONLY this URL. */
let customServerEnabled = false;

let activeBaseUrl = PRIMARY_API_URL;
let activeUpdateBaseUrl = UPDATE_API_URLS[0] || PRIMARY_API_URL;

function syncActiveFromCustom() {
  if (customServerEnabled && customServerUrl) {
    activeBaseUrl = customServerUrl;
    activeUpdateBaseUrl = customServerUrl;
  } else {
    activeBaseUrl = PRIMARY_API_URL;
    activeUpdateBaseUrl = UPDATE_API_URLS[0] || BASE_API_URL || PRIMARY_API_URL;
  }
}

function getCustomServerUrl() {
  return customServerUrl;
}

function isCustomServerEnabled() {
  return Boolean(customServerEnabled && customServerUrl);
}

function hasSavedCustomServer() {
  return Boolean(customServerUrl);
}

/** Status for UI — never includes the URL itself. */
function getCustomServerStatus() {
  return {
    hasSaved: Boolean(customServerUrl),
    enabled: Boolean(customServerEnabled && customServerUrl)
  };
}

/**
 * Restore from electron-store on app launch.
 */
function applyCustomServerState({ url, enabled } = {}) {
  const cleaned = clean(url);
  // Drop a previously saved bare-IP override that breaks login with HTTP 405.
  if (cleaned && isBareHostWithoutApiPort(cleaned)) {
    console.warn('[API] Ignoring saved custom server (bare IP hits nginx 405 on POST)');
    customServerUrl = '';
    customServerEnabled = false;
    syncActiveFromCustom();
    return { ...getCustomServerStatus(), clearedInvalid: true };
  }
  customServerUrl = cleaned && isValidHttpUrl(cleaned) ? cleaned : '';
  customServerEnabled = Boolean(enabled) && Boolean(customServerUrl);
  syncActiveFromCustom();
  if (customServerEnabled) {
    console.log('[API] Custom server override active (persisted)');
  } else if (customServerUrl) {
    console.log('[API] Custom server saved but disabled — using failover chain');
  }
  return getCustomServerStatus();
}

/**
 * Save a new custom URL and turn it on.
 */
function setCustomServerUrl(url) {
  const cleaned = clean(url);
  if (!cleaned) {
    return { ok: false, message: 'Enter a server URL' };
  }
  if (!isValidHttpUrl(cleaned)) {
    return { ok: false, message: 'Enter a valid http(s) URL' };
  }
  if (isBareHostWithoutApiPort(cleaned)) {
    return {
      ok: false,
      message:
        'Do not use the raw VPS IP. Use https://datdesk.apexskillzone.com (IP on port 80 returns 405 on login).'
    };
  }
  customServerUrl = cleaned;
  customServerEnabled = true;
  syncActiveFromCustom();
  console.log('[API] Custom server saved and enabled');
  return { ok: true, ...getCustomServerStatus() };
}

/**
 * Toggle custom server on/off without deleting the saved URL.
 */
function setCustomServerEnabled(enabled) {
  if (enabled) {
    if (!customServerUrl) {
      return { ok: false, message: 'Save a server URL first' };
    }
    if (isBareHostWithoutApiPort(customServerUrl)) {
      return {
        ok: false,
        message: 'Saved URL is a bare VPS IP and cannot be used. Clear it and use the domain.'
      };
    }
    customServerEnabled = true;
    syncActiveFromCustom();
    console.log('[API] Custom server enabled');
  } else {
    customServerEnabled = false;
    syncActiveFromCustom();
    console.log('[API] Custom server disabled — using failover chain:', API_URLS.join(' → '));
  }
  return { ok: true, ...getCustomServerStatus() };
}

/**
 * Remove saved URL and disable.
 */
function clearCustomServer() {
  customServerUrl = '';
  customServerEnabled = false;
  syncActiveFromCustom();
  console.log('[API] Custom server cleared — using failover chain:', API_URLS.join(' → '));
  return { ok: true, ...getCustomServerStatus() };
}

/**
 * @param {{ ignoreCustom?: boolean }} [opts]
 */
function getCandidateUrls(opts = {}) {
  if (!opts.ignoreCustom && isCustomServerEnabled()) return [customServerUrl];
  return [...API_URLS];
}

/**
 * @param {{ ignoreCustom?: boolean }} [opts]
 */
function getUpdateCandidateUrls(opts = {}) {
  if (!opts.ignoreCustom && isCustomServerEnabled()) return [customServerUrl];
  return [...UPDATE_API_URLS];
}

function getPrimaryUrl(opts = {}) {
  if (!opts.ignoreCustom && isCustomServerEnabled()) return customServerUrl;
  return PRIMARY_API_URL;
}

function getBaseUrl() {
  return activeBaseUrl;
}

function getTrackingEyeConfig() {
  const url = clean(process.env.TRACKINGEYE_URL || '');
  const ingestKey = String(process.env.TRACKINGEYE_INGEST_KEY || '').trim();
  return {
    url: isValidHttpUrl(url) ? url : '',
    ingestKey
  };
}

function setActiveBaseUrl(url) {
  const cleaned = clean(url);
  if (isCustomServerEnabled()) {
    if (cleaned === customServerUrl) activeBaseUrl = cleaned;
    return activeBaseUrl;
  }
  if (API_URLS.includes(cleaned)) activeBaseUrl = cleaned;
  return activeBaseUrl;
}

function setActiveUpdateBaseUrl(url) {
  const cleaned = clean(url);
  if (isCustomServerEnabled()) {
    if (cleaned === customServerUrl) activeUpdateBaseUrl = cleaned;
    return activeUpdateBaseUrl;
  }
  if (UPDATE_API_URLS.includes(cleaned)) activeUpdateBaseUrl = cleaned;
  return activeUpdateBaseUrl;
}

console.log('[API] Failover chain (main → primary → backup):', API_URLS.join(' → ') || PRIMARY_API_URL);
console.log('[API] Update feeds (primary → backup only):', UPDATE_API_URLS.join(' → ') || '(none)');

module.exports = {
  APP_SLUG,
  API_BASE_URL: PRIMARY_API_URL,
  API_BACKUP_URL: BACKUP_API_URL,
  MAIN_API_URL,
  BASE_API_URL,
  BACKUP_API_URL,
  PRIMARY_API_URL,
  API_URLS,
  UPDATE_API_URLS,
  clean,
  isValidHttpUrl,
  isBareHostWithoutApiPort,
  getCandidateUrls,
  getUpdateCandidateUrls,
  getPrimaryUrl,
  getBaseUrl,
  getTrackingEyeConfig,
  setActiveBaseUrl,
  setActiveUpdateBaseUrl,
  getCustomServerUrl,
  getCustomServerStatus,
  hasSavedCustomServer,
  isCustomServerEnabled,
  applyCustomServerState,
  setCustomServerUrl,
  setCustomServerEnabled,
  clearCustomServer,
  /** @deprecated use isCustomServerEnabled */
  hasCustomServer: isCustomServerEnabled
};
