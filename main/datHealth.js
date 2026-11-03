'use strict';

/**
 * DAT connection health: the "● Stable · 520 ms" next to the zoom buttons, the
 * stuck-connection self-repair, and the numbers the heartbeat sends to admin.
 *
 *  - the speed comes from DAT's own requests (trackerBlock.js times each one), so it costs
 *    no extra traffic. The number is the lower quartile of the last minute: steady, and not
 *    thrown off by one slow search. Only when DAT has been quiet for QUIET_MS while on
 *    screen does it send one tiny HEAD request (at most every PROBE_IDLE_MS, never while
 *    DAT is hidden — the keep-alive requests are timed then).
 *    That request runs in an isolated world of the page, so it uses DAT's own proxy and
 *    connections without passing through DAT's fetch wrappers.
 *  - the level shown changes only when two checks in a row agree, so it does not flicker.
 *  - "stuck": probes failing twice in a row, DAT's own requests failing with no answer in
 *    between, or several requests waiting STUCK_MS. Then the session's connections are
 *    closed (dead proxy sockets go away and DAT reconnects); at most once per
 *    AUTO_FIX_COOLDOWN_MS.
 *  - a DAT tab using very much memory is reloaded once the PC has been idle a while.
 */

const { app, powerMonitor } = require('electron');
const { getDatOrigins, countWaitingRequests, getNetSamples } = require('./trackerBlock');

/** How often the numbers are looked at (no network involved). */
const CHECK_MS = 10 * 1000;
const CHECK_HIDDEN_MS = 30 * 1000;
/** Answer times from this far back make up the number shown. */
const WINDOW_MS = 60 * 1000;
/** No answer from DAT for this long → DAT is quiet; a probe checks the connection is still there. */
const QUIET_MS = 20 * 1000;
/** Answers slower than this are long-polls / big searches, not the connection. */
const SAMPLE_MAX_MS = 15 * 1000;
/** A quiet DAT on screen gets at most one probe per this long. */
const PROBE_IDLE_MS = 30 * 1000;
const PROBE_TIMEOUT_MS = 6000;
/** Right after a Reset the tabs are reloading: give them this long before judging. */
const AFTER_RESET_MS = 8000;
const ORIGIN_RECENT_MS = 5 * 60 * 1000;
/** DAT's own requests failing this often, with no answer since the last failure, = no answer. */
const FAILURES_DOWN = 2;
const FAILURES_STUCK = 4;

/**
 * One HTTP round trip through the proxy to DAT's server, including DAT's own answer time
 * (measured ~150–400 ms of it), so a healthy proxied connection reads ~400–700 ms.
 */
const GOOD_MS = 700;
const OK_MS = 1500;

/** A request with no answer for this long counts as hanging… */
const STUCK_MS = 25 * 1000;
/** …and this many hanging at once means the connection is stuck (one can be a long poll). */
const STUCK_REQUESTS = 3;
const AUTO_FIX_COOLDOWN_MS = 90 * 1000;

const MEMORY_RELOAD_MB = 2500;
const MEMORY_RELOAD_IDLE_S = 5 * 60;
const MEMORY_RELOAD_COOLDOWN_MS = 60 * 60 * 1000;

const ISOLATED_WORLD_ID = 1207;

function probeScript(origin) {
  return `(async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ${PROBE_TIMEOUT_MS});
    const t0 = performance.now();
    try {
      await fetch(${JSON.stringify(origin)} + '/favicon.ico?dd_ping=' + Date.now(), {
        method: 'HEAD', mode: 'no-cors', cache: 'no-store', credentials: 'include', signal: ctrl.signal
      });
      return Math.round(performance.now() - t0);
    } catch (e) {
      return -1;
    } finally {
      clearTimeout(timer);
    }
  })()`;
}

/** Lower quartile: the connection's own speed, not DAT's slowest answers. */
function lowerQuartile(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 4)];
}

function levelFor(ms) {
  if (ms < 0) return 'down';
  if (ms < GOOD_MS) return 'good';
  if (ms < OK_MS) return 'ok';
  return 'slow';
}

/**
 * @param {{
 *   win: Electron.BrowserWindow,
 *   getActiveWebContents: () => Electron.WebContents|null,
 *   getWebContentsIds: () => number[],
 *   getSession: () => Electron.Session|null,
 *   reloadTabs: () => void,
 *   onLevelChange?: (level: string) => void
 * }} opts
 */
function startDatHealth({ win, getActiveWebContents, getWebContentsIds, getSession, reloadTabs, onLevelChange }) {
  let stopped = false;
  let timer = null;
  let probing = false;
  let failedInRow = 0;
  let lastProbeAt = 0;
  let lastProbeFailAt = 0;
  /** A calmer level waits for a second check that agrees (so the toolbar does not flicker). */
  let pendingLevel = '';
  let lastAutoFixAt = 0;
  let lastMemoryReloadAt = 0;
  let lastLevel = '';
  const state = {
    ms: null,
    level: 'unknown',
    hosts: [],
    waiting: 0,
    memoryMb: null,
    autoFixes: 0,
    resets: 0,
    lastResetAt: null,
    resetting: false,
    at: null
  };

  const visible = () => {
    try {
      return win.isVisible() && !win.isMinimized();
    } catch {
      return false;
    }
  };

  const publish = () => {
    if (stopped || win.isDestroyed()) return;
    win.webContents.send('dat:health', { ...state });
    if (state.level !== lastLevel) {
      lastLevel = state.level;
      try {
        onLevelChange?.(state.level);
      } catch {
        // ignore
      }
    }
  };

  const closeConnections = async () => {
    const ses = getSession();
    if (!ses) return;
    try {
      await ses.closeAllConnections();
    } catch {
      // ignore
    }
  };

  /** Memory of the tab on screen, in MB (working set of its renderer process). */
  const readMemory = (wc) => {
    try {
      const pid = wc.getOSProcessId();
      const metric = app.getAppMetrics().find((m) => m.pid === pid);
      return metric?.memory?.workingSetSize ? Math.round(metric.memory.workingSetSize / 1024) : null;
    } catch {
      return null;
    }
  };

  const maybeReloadForMemory = () => {
    if (!state.memoryMb || state.memoryMb < MEMORY_RELOAD_MB || state.resetting) return;
    if (Date.now() - lastMemoryReloadAt < MEMORY_RELOAD_COOLDOWN_MS) return;
    let idle = 0;
    try {
      idle = powerMonitor.getSystemIdleTime();
    } catch {
      return;
    }
    if (idle < MEMORY_RELOAD_IDLE_S) return;
    lastMemoryReloadAt = Date.now();
    console.warn(`[DAT_HEALTH] DAT tab uses ${state.memoryMb} MB while the PC is idle — reloading it`);
    reloadTabs();
  };

  /** One tiny request, only when DAT itself has been quiet. Returns ms, or -1 when it failed. */
  const probeOnce = async (wc, ids) => {
    lastProbeAt = Date.now();
    const origin = getDatOrigins(ids, { recentMs: ORIGIN_RECENT_MS })[0] || new URL(wc.getURL()).origin;
    const ms = await wc
      .executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [{ code: probeScript(origin) }])
      .catch(() => null);
    if (typeof ms !== 'number') return null;
    if (ms < 0) {
      failedInRow += 1;
      lastProbeFailAt = Date.now();
    }
    return { ms, host: new URL(origin).hostname };
  };

  const check = async () => {
    if (stopped || probing || state.resetting) return;
    const wc = getActiveWebContents();
    if (!wc || wc.isDestroyed() || !/^https:\/\/([^/]+\.)?dat\.com\//i.test(wc.getURL())) return;
    if (state.lastResetAt && Date.now() - state.lastResetAt < AFTER_RESET_MS) return;
    probing = true;
    try {
      const ids = getWebContentsIds();
      // Nothing from before a Reset counts: that connection is gone.
      const windowMs = () => (state.lastResetAt ? Math.min(WINDOW_MS, Date.now() - state.lastResetAt) : WINDOW_MS);
      let net = getNetSamples(ids, windowMs());
      let samples = net.samples.filter((x) => x.ms <= SAMPLE_MAX_MS);
      let probed = null;
      const quiet = !net.lastOkAt || Date.now() - net.lastOkAt > QUIET_MS;
      if (quiet && visible() && Date.now() - lastProbeAt >= PROBE_IDLE_MS) {
        const resetsBefore = state.resets;
        probed = await probeOnce(wc, ids);
        // A Reset during the probe made its answer meaningless (the connections were closed).
        if (stopped || state.resetting || state.resets !== resetsBefore) return;
        // The probe went through DAT's own session, so it is now one of the timed answers.
        net = getNetSamples(ids, windowMs());
        samples = net.samples.filter((x) => x.ms <= SAMPLE_MAX_MS);
        if (!samples.length && probed && probed.ms >= 0) samples = [{ at: Date.now(), ms: probed.ms, host: probed.host }];
      }
      // A failed probe counts until DAT answers again; older answers do not make it fine.
      const noAnswer = lastProbeFailAt > 0 && net.lastOkAt <= lastProbeFailAt && !(probed && probed.ms >= 0);
      if (!noAnswer) failedInRow = 0;

      const byHost = new Map();
      for (const x of samples) {
        if (!byHost.has(x.host)) byHost.set(x.host, []);
        byHost.get(x.host).push(x.ms);
      }
      if (probed && probed.ms < 0) byHost.set(probed.host, [-1]);
      state.hosts = [...byHost].map(([host, list]) => ({ host, ms: lowerQuartile(list) }));
      state.waiting = countWaitingRequests(ids, STUCK_MS);
      state.memoryMb = readMemory(wc);
      state.at = Date.now();

      // DAT's own requests failing with nothing answered since the last failure.
      const failingNow = net.failures > 0 && net.lastFailAt > net.lastOkAt;
      const stuck =
        failedInRow >= 2 || state.waiting >= STUCK_REQUESTS || (failingNow && net.failures >= FAILURES_STUCK);
      const down = noAnswer || (failingNow && net.failures >= FAILURES_DOWN);

      if (samples.length) state.ms = lowerQuartile(samples.map((x) => x.ms));
      let level;
      if (stuck) level = 'stuck';
      else if (down) level = 'down';
      else if (samples.length) level = levelFor(state.ms);
      // Nothing new: keep what is shown, but not an old "stuck" the checks no longer see.
      else level = state.level === 'stuck' || state.level === 'down' ? 'unknown' : state.level;

      // Trouble shows at once; anything calmer must be seen on two checks in a row.
      const urgent = level === 'stuck' || level === 'down';
      const first = state.level === 'unknown';
      if (urgent || first || level === state.level || pendingLevel === level) {
        state.level = level;
        pendingLevel = '';
      } else {
        pendingLevel = level;
      }

      if (stuck && Date.now() - lastAutoFixAt > AUTO_FIX_COOLDOWN_MS) {
        lastAutoFixAt = Date.now();
        state.autoFixes += 1;
        console.warn('[DAT_HEALTH] Connection stuck — closing DAT connections', {
          failedInRow,
          waiting: state.waiting,
          failures: net.failures
        });
        await closeConnections();
      }
      publish();
      maybeReloadForMemory();
    } catch (err) {
      console.warn('[DAT_HEALTH] check failed:', err.message);
    } finally {
      probing = false;
    }
  };

  const schedule = (delay) => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      await check();
      schedule(visible() ? CHECK_MS : CHECK_HIDDEN_MS);
    }, delay);
  };

  // Coming back to DAT: measure at once instead of showing an old number.
  const onBack = () => {
    if (!state.at || Date.now() - state.at > 5000) schedule(300);
  };
  win.on('show', onBack);
  win.on('restore', onBack);
  win.on('focus', onBack);
  schedule(3000);

  return {
    snapshot: () => ({ ...state }),

    /**
     * The Reset button: drop every connection, let `beforeReload` fix the proxy if it is
     * dead, then reload the tabs. Cookies and storage stay, so DAT stays signed in.
     */
    async reset(beforeReload) {
      if (stopped || state.resetting) return { ok: false, busy: true };
      state.resetting = true;
      state.level = 'resetting';
      publish();
      let result = { ok: true };
      try {
        await closeConnections();
        try {
          await getSession()?.clearHostResolverCache();
        } catch {
          // ignore
        }
        if (typeof beforeReload === 'function') result = (await beforeReload()) || result;
        reloadTabs();
        state.resets += 1;
        state.lastResetAt = Date.now();
        failedInRow = 0;
        lastProbeFailAt = 0;
        pendingLevel = '';
        state.ms = null;
      } catch (err) {
        console.warn('[DAT_HEALTH] reset failed:', err.message);
        result = { ok: false, message: err.message };
      } finally {
        state.resetting = false;
        state.level = 'unknown';
        publish();
        schedule(AFTER_RESET_MS + 500); // measure again once the tabs have reloaded
      }
      return result;
    },

    stop() {
      stopped = true;
      clearTimeout(timer);
      if (!win.isDestroyed()) {
        win.removeListener('show', onBack);
        win.removeListener('restore', onBack);
        win.removeListener('focus', onBack);
      }
    }
  };
}

module.exports = { startDatHealth };
