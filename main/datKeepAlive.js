'use strict';

/**
 * Keeps DAT fast after the app has sat idle.
 *
 * Measured: after ~15–20 idle minutes every DAT server connection through the proxy
 * had gone cold, so the first click had to rebuild each one (proxy tunnel + TLS,
 * 1.5–3.6 s per server, one after another) and the app felt frozen.
 *
 *  - every KEEPALIVE_INTERVAL_MS, a tiny HEAD request to each DAT server the tabs
 *    used recently but that has been quiet — keeps its connection open
 *  - when the user comes back (window restored / focused / shown, PC resumed or
 *    unlocked) after AWAY_MS, all recent DAT servers are warmed at once, before
 *    the first click
 *
 * The requests run inside the DAT page, so they use the page's own connections
 * (same partition, same site): a request from the main process would open separate
 * ones and keep nothing warm. Both credential modes are sent because Chromium keeps
 * cookie and cookie-less connections apart (DAT uses both).
 */

const { powerMonitor } = require('electron');
const { getDatOrigins } = require('./trackerBlock');

const KEEPALIVE_INTERVAL_MS = 50 * 1000;
/** Only servers with no traffic for this long get a keep-alive request. */
const HOST_QUIET_MS = 40 * 1000;
/** Servers not used for this long are left alone (DAT no longer needs them). */
const HOST_RECENT_MS = 30 * 60 * 1000;
/** Away at least this long → warm everything on return. */
const AWAY_MS = 60 * 1000;

function pingScript(origins) {
  return `(() => {
    for (const origin of ${JSON.stringify(origins)}) {
      for (const credentials of ['include', 'omit']) {
        fetch(origin + '/?dd_keepalive=' + Date.now(), {
          method: 'HEAD', mode: 'no-cors', cache: 'no-store', credentials
        }).catch(() => {});
      }
    }
    return true;
  })()`;
}

/**
 * @param {Electron.BrowserWindow} win  the DAT window
 * @param {{ getActiveWebContents: () => Electron.WebContents|null,
 *           getWebContentsIds: () => number[] }} tabs
 * @returns {() => void} stop
 */
function startDatKeepAlive(win, { getActiveWebContents, getWebContentsIds }) {
  let awaySince = 0;
  let stopped = false;

  const ping = (quietMs) => {
    if (stopped || !win || win.isDestroyed()) return;
    const wc = getActiveWebContents();
    if (!wc || wc.isDestroyed() || !/^https:\/\/([^/]+\.)?dat\.com\//i.test(wc.getURL())) return;
    const origins = getDatOrigins(getWebContentsIds(), { recentMs: HOST_RECENT_MS, quietMs });
    if (!origins.length) return;
    wc.executeJavaScript(pingScript(origins), true).catch(() => {});
  };

  const timer = setInterval(() => ping(HOST_QUIET_MS), KEEPALIVE_INTERVAL_MS);

  const markAway = () => {
    if (!awaySince) awaySince = Date.now();
  };
  const markBack = () => {
    const away = awaySince ? Date.now() - awaySince : 0;
    awaySince = 0;
    if (away >= AWAY_MS) ping(0);
  };

  win.on('blur', markAway);
  win.on('minimize', markAway);
  win.on('hide', markAway);
  win.on('focus', markBack);
  win.on('restore', markBack);
  win.on('show', markBack);
  powerMonitor.on('suspend', markAway);
  powerMonitor.on('lock-screen', markAway);
  powerMonitor.on('resume', markBack);
  powerMonitor.on('unlock-screen', markBack);

  return function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    powerMonitor.removeListener('suspend', markAway);
    powerMonitor.removeListener('lock-screen', markAway);
    powerMonitor.removeListener('resume', markBack);
    powerMonitor.removeListener('unlock-screen', markBack);
    if (win && !win.isDestroyed()) {
      win.removeListener('blur', markAway);
      win.removeListener('minimize', markAway);
      win.removeListener('hide', markAway);
      win.removeListener('focus', markBack);
      win.removeListener('restore', markBack);
      win.removeListener('show', markBack);
    }
  };
}

module.exports = { startDatKeepAlive };
