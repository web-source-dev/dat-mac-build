'use strict';

/**
 * Dat Desk for macOS — update check.
 *
 * The Mac build is not signed with an Apple Developer ID, and macOS only lets electron-updater
 * install signed apps. So this checks the backend feed (/update/feed?platform=darwin&app=datdesk-mac,
 * folder updates/datdesk-mac/darwin/latest.yml) and, when a newer version is there, tells the user
 * and opens the .dmg download in the browser once per version.
 */

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const axios = require('axios');
const { APP_SLUG, getUpdateCandidateUrls, getPrimaryUrl } = require('./config');

const platform = process.platform;
const arch = process.arch;

let lastUpdateMsg = null;
let openedFor = '';

function buildUpdateFeedUrl(base) {
  return `${base}/update/feed?platform=${platform}&arch=${arch}&app=${APP_SLUG}`;
}

function sendUpdateMsg(data) {
  lastUpdateMsg = data;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      try {
        win.webContents.send('update-msg', data);
      } catch {
        // ignore
      }
    }
  }
}

function compareVersions(a, b) {
  const pa = String(a || '0').replace(/-.*$/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').replace(/-.*$/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** latest.yml → { version, urls[] } (only the fields this needs). */
function parseFeed(text) {
  const yml = String(text || '');
  const version = yml.match(/^version:\s*['"]?([^\s'"]+)/m)?.[1] || '';
  const urls = [...yml.matchAll(/^\s*-\s*url:\s*['"]?([^\s'"]+)/gm)].map((m) => m[1]);
  const single = yml.match(/^path:\s*['"]?([^\s'"]+)/m)?.[1];
  if (single) urls.push(single);
  return { version, urls };
}

/** Pick the .dmg for this Mac's chip, else any .dmg, else the first file. */
function pickDownload(urls, base) {
  const abs = urls.map((u) => (/^https?:\/\//i.test(u) ? u : `${base}/update/download/${APP_SLUG}/darwin/${encodeURIComponent(u)}`));
  const dmgs = abs.filter((u) => /\.dmg(\?|$)/i.test(u));
  return dmgs.find((u) => decodeURIComponent(u).includes(arch)) || dmgs[0] || abs[0] || '';
}

async function fetchFeed() {
  const candidates = getUpdateCandidateUrls();
  if (!candidates.length) candidates.push(getPrimaryUrl());
  let lastErr = null;
  for (const base of candidates) {
    try {
      const res = await axios.get(buildUpdateFeedUrl(base), {
        timeout: 10000,
        responseType: 'text',
        validateStatus: (s) => s >= 200 && s < 500
      });
      if (res.status === 404) return null; // no Mac release published yet
      if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
      return { base, ...parseFeed(res.data) };
    } catch (err) {
      lastErr = err;
      console.warn('[UPDATE] Feed failed:', base, err.message);
    }
  }
  throw lastErr || new Error('no update server');
}

async function runCheck({ openBrowser = true } = {}) {
  sendUpdateMsg({ status: 'checking', message: 'Checking for updates…' });
  const feed = await fetchFeed();
  if (!feed || !feed.version || compareVersions(feed.version, app.getVersion()) <= 0) {
    sendUpdateMsg({ status: 'not-available', message: 'You are on the latest version.' });
    return false;
  }
  const url = pickDownload(feed.urls, feed.base);
  sendUpdateMsg({
    status: 'available',
    message: `Dat Desk ${feed.version} is available. The download opened in your browser — open it and drag Dat Desk to Applications.`,
    version: feed.version
  });
  if (openBrowser && url && openedFor !== feed.version) {
    openedFor = feed.version;
    shell.openExternal(url).catch(() => {});
  }
  return true;
}

function registerUpdateIpc() {
  ipcMain.handle('check-update', async () => {
    if (!app.isPackaged) {
      return { success: false, message: 'Updates only run in the installed app.' };
    }
    try {
      await runCheck();
      return { success: true };
    } catch (err) {
      sendUpdateMsg({ status: 'error', message: 'Update check failed. You can keep using the app.' });
      return { success: false, message: err.message || 'Update check failed' };
    }
  });

  ipcMain.handle('get-update-msg', async () => lastUpdateMsg);
}

let lastCheckAt = 0;

/** Check now (throttled). No-op in development. */
async function checkNow() {
  if (!app.isPackaged) return false;
  if (Date.now() - lastCheckAt < 5 * 60 * 1000) return false;
  lastCheckAt = Date.now();
  try {
    return await runCheck();
  } catch (err) {
    console.warn('[UPDATE] check failed:', err.message);
    return false;
  }
}

async function initAutoUpdater() {
  registerUpdateIpc();

  if (!app.isPackaged) {
    console.log('[UPDATE] Skipping update check in development');
    return;
  }

  setTimeout(() => {
    checkNow().catch(() => {});
  }, 5000);
  // The app runs in the background for days: look for a new release every hour too.
  setInterval(() => {
    lastCheckAt = 0;
    checkNow().catch(() => {});
  }, 60 * 60 * 1000).unref?.();
}

module.exports = {
  initAutoUpdater,
  checkNow,
  buildUpdateFeedUrl
};
