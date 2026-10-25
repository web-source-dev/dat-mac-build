const {
  app,
  BrowserWindow,
  ipcMain,
  session,
  screen,
  shell,
  globalShortcut,
  dialog,
  Tray,
  Menu,
  nativeImage
} = require('electron');
const path = require('path');
const { createApi, setSessionReplacedHandler, setDeviceHandlers } = require('./apiClient');
const deviceSync = require('./deviceSync');
const deviceSession = require('./deviceSession');
const deviceKey = require('./deviceKey');
const {
  setCustomServerUrl,
  setCustomServerEnabled,
  clearCustomServer,
  applyCustomServerState,
  getCustomServerStatus,
  getCustomServerUrl,
  getCandidateUrls
} = require('./config');
const { TabManager, isDatLoginUrl } = require('./tabManager');
const {
  sendScreenReport,
  startRemoteCapture,
  syncRemoteCapture,
  stopRemoteCapture
} = require('./screenReport');
const { startSuspicionWatch, stopSuspicionWatch } = require('./suspicionWatch');
const {
  startActivityLog,
  reportActivity,
  markDatOpened,
  markDatClosed,
  noteDatSurface
} = require('./activityLog');
const {
  buildPermissionCss,
  DAT_ADD_BUTTON_ENHANCE_SCRIPT
} = require('./datTabEnforce');
const {
  loadManagedExtensionsIntoSession,
  prefetchManagedExtensions,
  getStatus: getExtensionsStatus
} = require('./extensionLoader');
const { initAutoUpdater, checkNow: checkForUpdateNow } = require('./updateManager');
const {
  isTokenExpired,
  classifyAuthError,
  decodeJwtPayload,
  getClockOffsetMs,
  SOFT_AUTH_FAILURE_LIMIT
} = require('./authUtils');
const { fetchActiveCookie, readSessionStamp, writeSessionStamp, clearCookieCache } = require('./cookieCache');
const { isGoogleOAuthUrl, openGoogleOAuthPopup } = require('./googleOAuthPopup');
const { verifySmtp, sendSmtp } = require('./smtpClient');
const { checkDatNetwork, invalidateNetworkCheck } = require('./networkCheck');
const {
  MAX_FAILOVERS,
  proxyAddress,
  effectiveProxy,
  rememberBackup,
  forgetBackup,
  requestBackupProxy,
  confirmBackupProxy
} = require('./proxyFailover');
const { chromeUserAgent, setAccountUserAgent } = require('./userAgent');
const { applySessionNetworkHooks, getBlockedCount } = require('./trackerBlock');
const { startDatKeepAlive } = require('./datKeepAlive');

let Store;
try {
  Store = require('electron-store');
} catch {
  Store = null;
}

let store;
async function getStore() {
  if (store) return store;
  if (typeof Store === 'function' && Store.prototype?.get) {
    store = new Store();
    return store;
  }
  const mod = await import('electron-store');
  const StoreClass = mod.default || mod;
  store = new StoreClass();
  return store;
}

let mainWindow = null;
let datWindow = null;
let tray = null;
/** Set right before an intentional, real destroy of the DAT window (vs. hide-to-tray). */
let datForceClose = false;
/** Set right before destroying the dashboard on purpose (Open DAT), vs. hide-to-tray. */
let dashboardForceClose = false;
/** Window to bring back when the app is reopened from the tray or a second launch. */
let lastSurface = 'dashboard';
/** Passed by the Windows login entry so a boot launch stays in the tray. */
const START_HIDDEN_ARG = '--started-hidden';
/** True once the dashboard renderer has mounted and asked for queued messages. */
let dashboardReady = false;
/** Messages for a dashboard that is closed or still loading (delivered on 'dashboard:ready'). */
const dashboardQueue = [];
let appQuitting = false;
const DAT_PARTITION = 'persist:datdesk-cookie';
/** The account's device fingerprint for the open session; handed to preload/datTab.js. */
let currentDeviceProfile = null;

/**
 * Partition for an account's DAT session. Each account (server cookie) gets its own
 * persistent partition so one account's cookies, storage and HTTP cache never mix with
 * another's, and a renewed session survives app restarts. Falls back to the shared
 * partition when the account is unknown (e.g. a warm-up before any account is chosen).
 */
function datPartitionFor(cookieId) {
  const id = String(cookieId || '').trim();
  return id ? `persist:datdesk-acct-${id}` : DAT_PARTITION;
}

/**
 * Rewrite the Sec-CH-UA request headers so they agree with a replayed user agent.
 * Electron's setUserAgent only changes the UA header; the client hints still reflect the
 * bundled Chromium. A UA that says Chrome 125 with hints that say 130 is itself a bot
 * signal, so we set the hints to match the account's user agent.
 */
function applyClientHints(ses, profile) {
  const major = Number(profile?.chromeMajor) || 0;
  if (!ses?.webRequest || !major) return;
  const brands = Array.isArray(profile.uaBrands) && profile.uaBrands.length
    ? profile.uaBrands
    : [
        { brand: 'Chromium', version: String(major) },
        { brand: 'Google Chrome', version: String(major) },
        { brand: 'Not.A/Brand', version: '24' }
      ];
  const secChUa = brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', ');
  const platform = `"${profile.uaPlatform || 'Windows'}"`;
  const mobile = profile.uaMobile ? '?1' : '?0';

  clientHintsBySession.set(ses, { secChUa, platform, mobile });
  installDatHeaderHook(ses);
}

/** Sec-CH-UA values per DAT session, set by applyClientHints and read by the header hook. */
const clientHintsBySession = new WeakMap();
const headerHookedSessions = new WeakSet();

/**
 * Electron keeps one onBeforeSendHeaders listener per session, so every request-header
 * rewrite for the DAT session lives here:
 * - client hints that match the account's user agent (applyClientHints);
 * - the email extension's Origin. Its service worker sends GETs with no Origin header, and
 *   the backend only lets the in-app extension through on a chrome-extension:// Origin. The
 *   extension names itself in X-Desk-Extension; if that id is loaded in this session we
 *   send its real origin.
 */
function installDatHeaderHook(ses) {
  if (!ses?.webRequest || headerHookedSessions.has(ses)) return;
  headerHookedSessions.add(ses);
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders || {};
    const hints = clientHintsBySession.get(ses);
    let extensionId = '';
    let hasOrigin = false;
    for (const key of Object.keys(headers)) {
      const lower = key.toLowerCase();
      if (lower === 'x-desk-extension') {
        extensionId = String(headers[key] || '').trim();
        delete headers[key];
      } else if (lower === 'origin') hasOrigin = true;
      else if (!hints) continue;
      else if (lower === 'sec-ch-ua' || lower === 'sec-ch-ua-full-version-list') headers[key] = hints.secChUa;
      else if (lower === 'sec-ch-ua-platform') headers[key] = hints.platform;
      else if (lower === 'sec-ch-ua-mobile') headers[key] = hints.mobile;
    }
    if (extensionId && !hasOrigin && /^[a-p]{32}$/.test(extensionId) && ses.extensions?.getExtension?.(extensionId)) {
      headers.Origin = `chrome-extension://${extensionId}`;
    }
    callback({ requestHeaders: headers });
  });
}
/** Background cache warm-up of DAT's code (see prewarmDatCache). */
let prewarm = null;
let prewarmTimer = null;
let prewarmRan = false;
let tabManager = null;
let opening = false;
let currentPartition = 'persist:datdesk-cookie';
let currentPermissions = {};
let currentDomain = 'https://one.dat.com/search-loads';
let currentUsingProxy = false;
/**
 * Saved DAT localStorage/sessionStorage per session, handed to preload/datTab.js
 * before DAT's scripts run. Seeded once per origin (local) / per tab+origin (session).
 */
const storageSeeds = new Map();
/** Stable key per partition (persist: partitions each have their own storage path). */
const seedKey = (ses) => ses?.storagePath || ses;
/** In-flight DAT session recovery (dedupes login redirects from several tabs). */
let datRecovery = null;
/** When the last recovery ran for the current DAT window (0 = not yet). */
let datRecoveredAt = 0;
/** Stops the DAT connection keep-alive (set while a DAT window is open). */
let stopDatKeepAlive = null;
/** A second DAT login redirect within this window of a recovery → give up. */
const DAT_RECOVERY_WINDOW_MS = 2 * 60 * 1000;
/** Recovery that failed only because the server was unreachable is retried this often… */
const DAT_RECOVERY_RETRY_MS = 15 * 1000;
/** …this many times before giving up. */
const DAT_RECOVERY_MAX_RETRIES = 4;
let datRecoveryRetries = 0;
/**
 * Once DAT is open only a ban closes it. Any other end of the desk session (signed in on
 * another device, token expired…) is remembered here and applied when DAT is closed.
 */
let pendingSignOut = null;
/** True once this death episode has been reported to the backend; reset when a session works. */
let datDeadReported = false;
/** Fingerprint of the last server session put into the partition (a retry needs a new one). */
let lastAppliedSessionFp = '';
/** A running DAT sends its renewed session to the server this often (POST /cookie/sync). */
const DAT_SYNC_MS = 10 * 60 * 1000;
let datSyncTimer = null;
let lastSyncedFp = '';
/** Session stamp of the open DAT window ({ userId, applied, cookieId }); recovery updates it. */
let currentSessionStamp = null;
/** Warn when the PC clock is off by more than this (DAT cookies expire by the PC clock). */
const CLOCK_SKEW_WARN_MS = 5 * 60 * 1000;

/**
 * Is the PC on a US time zone? DAT only works from the US and a foreign zone both looks
 * wrong and skews cookie expiry. Accepts the US IANA zones (America/* covers the mainland;
 * Alaska/Hawaii/territories are listed explicitly).
 */
function usTimezoneCheck() {
  let timezone = '';
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    timezone = '';
  }
  const tz = String(timezone);
  const US_EXTRA = new Set([
    'Pacific/Honolulu',
    'Pacific/Pago_Pago',
    'Pacific/Guam',
    'Pacific/Saipan',
    'America/Anchorage',
    'America/Adak'
  ]);
  // America/* covers the US mainland (plus Canada/Mexico/LatAm, which we accept as "Americas"
  // rather than block legitimate US users on edge zones). The intent is to block clearly
  // foreign zones such as Asia/*, Europe/*, etc.
  const ok = /^America\//.test(tz) || US_EXTRA.has(tz);
  return { ok, timezone: tz || 'unknown' };
}
/** Track custom BrowserWindows so logout/quit can close them and free partitions. */
const customWindows = new Set();
/** webContents → last insertCSS key (prevents stylesheet accumulation). */
const injectedCssKeys = new WeakMap();
/** Main-process session watchdog while DAT window is open (DATGO-style). */
let datSessionWatchdog = null;
const DAT_SESSION_CHECK_MS = 10 * 60 * 1000; // 10 minutes
/** Session checks in a row that failed with an unclear 401 (reset by any success). */
let softAuthFailures = 0;
/** DAT window page (tab bar + loading screen) has loaded; resolves once per window. */
let datShellReady = null;
let datShellLoaded = false;
/** Current line on the DAT window's loading screen. */
let datLoadingMessage = '';

const loginHandlers = new Map();

app.on('login', (event, _webContents, _request, authInfo, callback) => {
  const { host } = authInfo;
  if (loginHandlers.has(host)) {
    const { username, password } = loginHandlers.get(host);
    event.preventDefault();
    callback(username, password);
    return;
  }
  event.preventDefault();
});

function parseProxy(proxy) {
  const raw = String(proxy || '').trim();
  if (!raw) return null;
  const parts = raw.split(':');
  if (parts.length < 2) return null;
  const host = parts[0].trim();
  const port = String(parts[1]).trim();
  const username = parts[2] !== undefined ? parts[2] : '';
  const password = parts.length > 3 ? parts.slice(3).join(':') : '';
  if (!host || !port || !/^\d+$/.test(port)) return null;
  return { host, port, username, password, raw };
}

/**
 * Deliver a message to the dashboard. The dashboard is closed while DAT is open
 * (saves memory), so recreate it when needed and queue until its renderer is ready.
 */
function sendToDashboard(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
  } else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  if (dashboardReady) mainWindow.webContents.send(channel, payload);
  else dashboardQueue.push({ channel, payload });
}

ipcMain.handle('dashboard:ready', () => {
  dashboardReady = true;
  return dashboardQueue.splice(0);
});

function notifySessionReplaced(message, info) {
  reportActivity('signed_out', { reason: 'other_device' });
  const text =
    message ||
    'You were signed out because your account signed in on another device.';

  if (datWindowAlive()) {
    if (!info?.closeDat) {
      // DAT stays open; the sign-out happens when the user closes it (see the 'closed' handler).
      if (!pendingSignOut) console.warn('[SESSION] Desk session ended — DAT stays open until closed:', text);
      pendingSignOut = text;
      return;
    }
    // One account, one computer: the server says another PC took this account, so DAT
    // must not stay in use here (backend SINGLE_DEVICE_CLOSE_DAT, on by default).
    console.warn('[SESSION] Account signed in on another computer — closing DAT');
    markDatClosed('other_device');
  }
  pendingSignOut = null;

  stopDatSessionWatchdog();
  setToken(null).catch(() => {});
  loginHandlers.clear();
  closeAllCustomWindows();
  destroyDatWindow();

  sendToDashboard('session-replaced', { message: text });
  deviceSync.beatNow().catch(() => {});
}

function isBanError(err) {
  const res = err?.response;
  return res?.status === 403 && Boolean(res.data?.isBanned || res.data?.code === 'BANNED');
}

/** The account was banned: the only case that closes a running DAT. */
function closeForBan(message) {
  const text = message && message !== 'Account is banned' ? message : 'Your account has been banned.';
  markDatClosed('banned');
  reportActivity('signed_out', { reason: 'banned' });
  console.warn('[SESSION] Account banned — closing DAT');
  pendingSignOut = null;
  stopDatSessionWatchdog();
  setToken(null).catch(() => {});
  loginHandlers.clear();
  closeAllCustomWindows();
  destroyDatWindow();
  sendToDashboard('session-replaced', { message: text, banned: true });
}

/**
 * A session check failed: should the desk session end? Only a definite rejection
 * signs out at once; an unclear 401 must repeat; network errors / 5xx never do.
 */
function shouldSignOutAfter(err) {
  const kind = classifyAuthError(err);
  if (kind === 'fatal') return true;
  if (kind === 'soft') {
    softAuthFailures += 1;
    return softAuthFailures >= SOFT_AUTH_FAILURE_LIMIT;
  }
  return false;
}

function stopDatSessionWatchdog() {
  if (datSessionWatchdog) {
    clearInterval(datSessionWatchdog);
    datSessionWatchdog = null;
  }
}

/**
 * DATGO-style reliability: while DAT is open, verify app session from the main
 * process every 10 minutes (banned / replaced / expired token). Renderer poll
 * alone is not enough if the UI is idle.
 */
function startDatSessionWatchdog() {
  stopDatSessionWatchdog();
  datSessionWatchdog = setInterval(async () => {
    try {
      if (!datWindow || datWindow.isDestroyed()) {
        stopDatSessionWatchdog();
        return;
      }

      // Only a ban closes DAT. Everything else below just records a sign-out for later.
      const token = await getToken();
      if (!token) return;
      if (isTokenExpired(token)) {
        notifySessionReplaced('Your session expired. Please sign in again.');
        return;
      }

      const api = createApi(token);
      const { data } = await api.post('/auth/check-session');
      softAuthFailures = 0;

      if (data?.isBanned) {
        closeForBan();
        return;
      }
      if (data?.sessionInvalid || data?.__sessionReplaced) {
        notifySessionReplaced();
        return;
      }
      if (data?.permissions?.openDat === false) {
        // Applies to the next Open DAT; the running one stays.
        console.warn('[SESSION_WATCHDOG] Open DAT was disabled for this account — DAT stays open');
      }
    } catch (err) {
      if (isBanError(err)) {
        closeForBan(err.response.data?.message);
        return;
      }
      if (err.response?.data?.code === 'SESSION_REPLACED') {
        // interceptor already notified
        return;
      }
      if (shouldSignOutAfter(err)) {
        notifySessionReplaced(
          err.response?.data?.message || 'Your session is no longer valid. Please sign in again.'
        );
      } else {
        // Server hiccup / network blip: keep DAT open, the next check will tell.
        console.warn(
          '[SESSION_WATCHDOG] Check failed, keeping session:',
          err.response?.status || err.message || err
        );
      }
    }
  }, DAT_SESSION_CHECK_MS);
}

setSessionReplacedHandler(notifySessionReplaced);

/** The backend says this app version is out of date: fetch the update, and tell the user when refused. */
let outdatedNotified = 0;
function notifyOutdated(data) {
  checkForUpdateNow().catch(() => {});
  if (data?.soft || Date.now() - outdatedNotified < 60 * 1000) return;
  outdatedNotified = Date.now();
  console.warn('[UPDATE] Backend refused this version — update required:', data?.latestVersion || '');
  sendToDashboard('app-outdated', { message: data?.message, latestVersion: data?.latestVersion || '' });
}

setDeviceHandlers({ beat: () => deviceSync.beatNow(), outdated: notifyOutdated });
deviceSession.configure({ getToken: () => getToken() });

// Production builds: no developer tools in any window — they would expose the login token and
// let someone drive the app's signed API calls by hand.
if (app.isPackaged) {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('devtools-opened', () => contents.closeDevTools());
  });
}

async function getToken() {
  const s = await getStore();
  return s.get('token') || null;
}

async function setToken(token) {
  const s = await getStore();
  softAuthFailures = 0;
  if (token) s.set('token', token);
  else s.delete('token');
}

async function ensureReportDeviceId(store) {
  const current = String(store.get('reportDeviceId') || '').trim();
  if (/^[a-zA-Z0-9_-]{8,80}$/.test(current)) return current;
  const next = require('crypto').randomBytes(12).toString('hex');
  store.set('reportDeviceId', next);
  return next;
}

function captureAllowed(store) {
  if (store.get('remoteCaptureSet') === true) return store.get('remoteCaptureAllowed') === true;
  return true;
}

function liveAllowed(store) {
  if (store.get('liveViewSet') === true) return store.get('liveViewAllowed') === true;
  return true;
}

/** Remember who this Dat Desk belongs to. A different email starts with capture and live on. */
async function rememberReportEmail(email) {
  const next = String(email || '').trim().slice(0, 200);
  if (!next) return false;
  const s = await getStore();
  const previous = String(s.get('reportEmail') || '').trim();
  const changed = Boolean(previous) && previous.toLowerCase() !== next.toLowerCase();
  if (changed) {
    s.set('remoteCaptureSet', false);
    s.delete('remoteCaptureAllowed');
    s.set('liveViewSet', false);
    s.delete('liveViewAllowed');
  }
  s.set('reportEmail', next);
  return changed;
}

async function readReportProfile() {
  const s = await getStore();
  const deviceId = await ensureReportDeviceId(s);
  const token = s.get('token') || null;
  const claims = decodeJwtPayload(token) || {};
  const loggedIn = Boolean(token);
  const remembered = String(s.get('reportEmail') || '').trim();
  const sessionEmail = String(claims.email || claims.userEmail || '').trim();
  return {
    deviceId,
    loggedIn,
    email: loggedIn ? sessionEmail || remembered : remembered,
    userId: loggedIn ? String(claims.userId || claims.id || claims.sub || '').trim() : '',
    role: loggedIn ? String(claims.role || '').trim().toLowerCase() : '',
    allowRemote: captureAllowed(s),
    allowLive: liveAllowed(s)
  };
}

function getAppIconPath() {
  const candidates = [
    path.join(__dirname, '../../resources/icon.png'),
    path.join(__dirname, '../../resources/icon.ico'),
    path.join(__dirname, '../../resources/datdesk-icon.png'),
    path.join(__dirname, '../../resources/datdesk-icon.png'),
    path.join(process.cwd(), 'resources/icon.png'),
    path.join(process.cwd(), 'resources/icon.ico')
  ];
  for (const candidate of candidates) {
    try {
      if (require('fs').existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  return undefined;
}

function createMainWindow() {
  const icon = getAppIconPath();
  mainWindow = new BrowserWindow({
    width: 960,
    height: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f8fafc',
    title: 'Dat Desk',
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  dashboardReady = false;
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // The dashboard × hides to the tray. The window is only destroyed when DAT
  // opens (to free memory) or when the tray Quit item exits the app.
  mainWindow.on('close', (event) => {
    if (appQuitting || dashboardForceClose) {
      dashboardForceClose = false;
      return;
    }
    event.preventDefault();
    hideDashboardToTray();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    dashboardReady = false;
  });
}

/**
 * Close (not hide) the dashboard while DAT runs: a hidden window still keeps its
 * renderer process in memory (~50-80 MB). It is recreated when DAT closes.
 */
function closeDashboardForDat() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    dashboardForceClose = true;
    mainWindow.close();
  }
}

/** Bring dashboard back when DAT closes. Recreate if it was destroyed. */
function showDashboardFromStart() {
  lastSurface = 'dashboard';
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }
  try {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } catch {
    createMainWindow();
  }
}

function hideDashboardToTray() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  lastSurface = 'dashboard';
  try {
    mainWindow.hide();
  } catch {
    // ignore
  }
  refreshTray();
}

function hideDatToTray() {
  if (!datWindowAlive()) return;
  lastSurface = 'dat';
  try {
    datWindow.hide();
  } catch {
    // ignore
  }
  refreshTray();
  deviceSync.beatNow().catch(() => {});
}

/** Reopen whichever window was on screen when the app was sent to the tray. */
function restoreLastSurface() {
  if (lastSurface === 'dat' && datWindowAlive()) {
    showDatWindow();
    return;
  }
  showDashboardFromStart();
}

function datWindowAlive() {
  return Boolean(datWindow && !datWindow.isDestroyed());
}

/** Really tear down the DAT window (vs. the default hide-to-tray on close). */
function destroyDatWindow() {
  if (!datWindowAlive()) return;
  datForceClose = true;
  try {
    datWindow.close();
  } catch {
    // ignore
  }
}

/* ------------------------------ System tray ------------------------------ */

function trayImage() {
  const fs = require('fs');
  const roots = [path.join(__dirname, '../../resources'), path.join(process.cwd(), 'resources')];
  const names = ['icon16.png', 'icon24.png', 'icon32.png', 'icon.png', 'datdesk-icon.png'];
  for (const root of roots) {
    for (const name of names) {
      const candidate = path.join(root, name);
      try {
        if (!fs.existsSync(candidate)) continue;
        let img = nativeImage.createFromPath(candidate);
        if (img.isEmpty()) continue;
        const { width } = img.getSize();
        if (width > 32) img = img.resize({ width: 16, height: 16 });
        return img;
      } catch {
        // ignore
      }
    }
  }
  const fallback = getAppIconPath();
  if (fallback) {
    try {
      const img = nativeImage.createFromPath(fallback);
      if (!img.isEmpty()) return img;
    } catch {
      // ignore
    }
  }
  return undefined;
}

/** Show the DAT window (restoring it from the tray) or open it if closed. */
function showDatWindow() {
  if (datWindowAlive()) {
    lastSurface = 'dat';
    if (datWindow.isMinimized()) datWindow.restore();
    datWindow.show();
    datWindow.focus();
    deviceSync.beatNow().catch(() => {});
    refreshTray();
    return;
  }
  openDatFlow().catch((err) => console.warn('[TRAY] open DAT failed:', err.message));
}

function showMainWindowFromTray() {
  showDashboardFromStart();
  refreshTray();
}

function buildTrayMenu() {
  const datOpen = datWindowAlive();
  return Menu.buildFromTemplate([
    {
      label: datOpen ? 'Show DAT window' : 'Open DAT',
      click: () => showDatWindow()
    },
    {
      label: 'Open dashboard',
      click: () => showMainWindowFromTray()
    },
    { type: 'separator' },
    {
      label: 'Quit Dat Desk',
      click: () => quitApp()
    }
  ]);
}

function refreshTray() {
  if (!tray || tray.isDestroyed?.()) return;
  try {
    tray.setContextMenu(buildTrayMenu());
    tray.setToolTip(datWindowAlive() ? 'Dat Desk — DAT running' : 'Dat Desk');
  } catch {
    // ignore
  }
}

/**
 * No tray icon by default: the app keeps running in the background (DAT, presence, remote
 * actions) and opening it again from the Start menu / desktop shortcut brings the window back.
 * SHOW_TRAY_ICON=1 in .env shows the icon again (support / testing).
 */
function trayIconEnabled() {
  return /^(1|true|yes)$/i.test(String(process.env.SHOW_TRAY_ICON || ''));
}

function createTray() {
  if (!trayIconEnabled()) return;
  if (tray && !tray.isDestroyed?.()) return;
  try {
    const img = trayImage();
    tray = img ? new Tray(img) : new Tray(nativeImage.createEmpty());
    tray.setToolTip('Dat Desk');
    refreshTray();
    tray.on('click', () => restoreLastSurface());
    tray.on('double-click', () => restoreLastSurface());
  } catch (err) {
    console.warn('[TRAY] create failed:', err.message);
    tray = null;
  }
}

/**
 * Start with Windows (current user). The login entry passes --started-hidden so
 * boot does not open a window. Only the installed app is registered — a dev
 * Electron process must not be added to the Run key.
 */
function registerOpenAtLogin() {
  if (!app.isPackaged) return;
  try {
    app.setLoginItemSettings({
      openAtLogin: true,
      path: process.execPath,
      args: [START_HIDDEN_ARG]
    });
  } catch (err) {
    console.warn('[STARTUP] Could not enable start with Windows:', err.message);
  }
}

function launchedHiddenAtStartup() {
  if (process.argv.includes(START_HIDDEN_ARG)) return true;
  try {
    return Boolean(app.getLoginItemSettings({ args: [START_HIDDEN_ARG] }).wasOpenedAtLogin);
  } catch {
    return false;
  }
}

function quitApp() {
  appQuitting = true;
  stopDatSessionWatchdog();
  deviceSync.sendOffline().finally(() => {
    deviceSync.stop();
    destroyDatWindow();
    app.quit();
  });
}

/* --------------------------- Presence heartbeat --------------------------- */

function currentPresenceState() {
  if (datWindowAlive()) {
    return {
      state: 'dat',
      datOpen: true,
      // The account this device currently has open, so admins see users-per-cookie.
      cookieId: currentSessionStamp?.cookieId || null,
      datVisible: (() => {
        try {
          return datWindow.isVisible() && !datWindow.isMinimized();
        } catch {
          return false;
        }
      })()
    };
  }
  return { state: 'dashboard', datOpen: false, datVisible: false, cookieId: null };
}

function startPresence() {
  deviceSync.start({
    getToken,
    getState: currentPresenceState,
    onCommands: handleDeviceCommands,
    onBanned: (message) => {
      if (datWindowAlive()) closeForBan(message);
    },
    appVersion: app.getVersion?.() || '',
    platform: process.platform
  });
}

/**
 * Collect the live DAT session from this device's persistent partition:
 * cookies via the session API (works even when DAT is hidden to the tray),
 * plus localStorage / sessionStorage from a live DAT tab when one exists.
 */
async function collectDatSession() {
  // Read from the account's partition (the one the open DAT window uses).
  const ses = session.fromPartition(currentPartition);
  const raw = await ses.cookies.get({});
  const cookies = raw
    .filter((c) => {
      const d = String(c.domain || '').replace(/^\./, '').toLowerCase();
      return d === 'dat.com' || d.endsWith('.dat.com');
    })
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      secure: Boolean(c.secure),
      httpOnly: Boolean(c.httpOnly),
      sameSite: c.sameSite || 'unspecified',
      ...(c.expirationDate ? { expirationDate: c.expirationDate } : {}),
      session: Boolean(c.session)
    }));

  let localStorageData = {};
  let sessionStorageData = {};
  try {
    const wc =
      tabManager?.getDatWebContents?.() || tabManager?.getActiveWebContents?.() || null;
    if (wc && !wc.isDestroyed()) {
      const dumped = await wc.executeJavaScript(
        `(() => {
           const out = { local: {}, session: {} };
           try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); out.local[k] = localStorage.getItem(k); } } catch {}
           try { for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); out.session[k] = sessionStorage.getItem(k); } } catch {}
           return out;
         })();`,
        true
      );
      localStorageData = dumped?.local || {};
      sessionStorageData = dumped?.session || {};
    }
  } catch (err) {
    console.warn('[PRESENCE] storage dump failed:', err.message);
  }

  return {
    'dat.com': {
      cookies,
      localStorage: localStorageData,
      sessionStorage: sessionStorageData
    }
  };
}

const REMOTE_ACTIONS = new Set([
  'open-dat',
  'close-dat',
  'hide-dat',
  'reload-dat',
  'refresh-session',
  'clear-cache',
  'sign-out',
  'restart-app',
  'quit-app',
  'sign-in'
]);
/** Actions that end this process: the result is reported before they run. */
const EXITING_ACTIONS = new Set(['quit-app', 'restart-app']);
let remoteChain = Promise.resolve();

function failRemote(type, error) {
  reportActivity('remote', { action: type, ok: false, error });
  return { ok: false, error };
}

/** Close DAT for real and wait until the window is gone (max a few seconds). */
function closeDatAndWait(timeoutMs = 8000) {
  if (!datWindowAlive()) return Promise.resolve();
  const win = datWindow;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // DAT did not close in time: destroy it so the action can go on.
      try {
        if (!win.isDestroyed()) win.destroy();
      } catch {
        // ignore
      }
      resolve();
    }, timeoutMs);
    win.once('closed', () => {
      clearTimeout(timer);
      resolve();
    });
    destroyDatWindow();
  });
}

/** Wipe this PC's DAT site data and the saved session file. The desk login stays. */
async function clearRemoteCache() {
  await cancelPrewarm();
  if (datWindowAlive()) await closeDatAndWait();
  showDashboardFromStart();

  const names = new Set([currentPartition, DAT_PARTITION]);
  try {
    const stamp = readSessionStamp();
    if (stamp?.cookieId) names.add(datPartitionFor(stamp.cookieId));
  } catch {
    // The stamp is optional; the partitions above still get cleared.
  }

  for (const name of names) {
    try {
      const ses = session.fromPartition(name);
      await ses.clearCache();
      await ses.clearStorageData();
    } catch (err) {
      console.warn('[REMOTE] cache clear failed:', name, err.message);
    }
  }

  clearCookieCache();
  invalidateNetworkCheck();
  storageSeeds.clear();
  currentSessionStamp = null;
}

/** Sign this desk out from support: close DAT, drop the login, show the sign-in screen. */
async function remoteSignOut() {
  await markDatClosed('logout');
  await reportActivity('signed_out', { reason: 'support' });
  pendingSignOut = null;
  stopDatSessionWatchdog();
  if (datWindowAlive()) await closeDatAndWait();
  await deviceSync.sendOffline();
  deviceSync.stop();
  await cancelPrewarm();
  await setToken(null);
  loginHandlers.clear();
  closeAllCustomWindows();
  showDashboardFromStart();
  sendToDashboard('session-replaced', { message: 'Support signed you out of Dat Desk. Sign in again to continue.' });
  refreshTray();
}

/** Quit and start again. Login and DAT session survive; the app comes back on the dashboard. */
function restartApp() {
  const args = process.argv.slice(1).filter((arg) => arg !== START_HIDDEN_ARG);
  app.relaunch({ args });
  quitApp();
}

/**
 * Run one support action on this Dat Desk.
 * open-dat opens or shows DAT. close-dat tears DAT down and shows the dashboard.
 * hide-dat tucks the DAT window into the tray. clear-cache wipes DAT data.
 * quit-app closes DAT and exits, so the tray icon goes away.
 */
function runRemoteAction(type, payload) {
  const job = remoteChain.then(() => executeRemoteAction(type, payload));
  remoteChain = job.then(
    () => {},
    () => {}
  );
  return job;
}

async function executeRemoteAction(type, payload) {
  if (type === 'sign-in') {
    // Support types the person's email and password in TrackingEye; never log them.
    const email = String(payload?.email || '').trim();
    const password = String(payload?.password || '');
    if (!email || !password) return failRemote(type, 'An email and a password are needed.');
    if (await getToken()) return failRemote(type, 'This Dat Desk is already signed in. Sign it out first.');
    const result = await loginWithPassword(email, password);
    if (!result?.success) return failRemote(type, result?.message || 'Sign-in failed.');
    showDashboardFromStart();
    refreshTray();
    reportActivity('remote', { action: type, ok: true });
    return { ok: true };
  }

  if (type === 'hide-dat') {
    // Nothing to hide when DAT is closed: tuck the dashboard into the tray instead.
    if (datWindowAlive()) hideDatToTray();
    else hideDashboardToTray();
    reportActivity('remote', { action: type, ok: true });
    return { ok: true };
  }

  if (type === 'open-dat') {
    const token = await getToken();
    if (!token) return failRemote(type, 'This Dat Desk is not signed in.');
    const result = await openDatFlow();
    const already = result?.message === 'DAT already open' || result?.message === 'Already opening DAT';
    if (!result?.success && !already) {
      return failRemote(type, result?.message || 'DAT did not open.');
    }
    reportActivity('remote', { action: type, ok: true });
    return { ok: true };
  }

  if (type === 'close-dat') {
    if (datWindowAlive()) await closeDatAndWait();
    showDashboardFromStart();
    reportActivity('remote', { action: type, ok: true });
    return { ok: true };
  }

  if (type === 'clear-cache') {
    await clearRemoteCache();
    reportActivity('remote', { action: type, ok: true });
    return { ok: true };
  }

  if (type === 'reload-dat') {
    // DAT closed: there is nothing to reload, so open it fresh instead.
    if (!datWindowAlive() || !tabManager) return executeRemoteAction('open-dat');
    tabManager.reloadAllTabs();
    reportActivity('remote', { action: type, ok: true });
    return { ok: true };
  }

  if (type === 'refresh-session') {
    const token = await getToken();
    if (!token) return failRemote(type, 'This Dat Desk is not signed in.');
    // Same wipe as Clear cache, then open DAT so it downloads a fresh session.
    await clearRemoteCache();
    const result = await openDatFlow();
    if (!result?.success) {
      return failRemote(type, result?.message || 'The cache was cleared, but DAT did not open again.');
    }
    reportActivity('remote', { action: type, ok: true });
    return { ok: true };
  }

  if (type === 'sign-out') {
    const token = await getToken();
    if (!token) {
      reportActivity('remote', { action: type, ok: true });
      return { ok: true };
    }
    await remoteSignOut();
    reportActivity('remote', { action: type, ok: true });
    return { ok: true };
  }

  if (type === 'restart-app') {
    await reportActivity('remote', { action: type, ok: true });
    restartApp();
    return { ok: true };
  }

  if (type === 'quit-app') {
    await reportActivity('remote', { action: type, ok: true });
    quitApp();
    return { ok: true };
  }

  return failRemote(type, 'Unknown remote action.');
}

async function handleDeviceCommands(commands, api) {
  for (const cmd of commands) {
    if (!cmd?.id) continue;
    if (REMOTE_ACTIONS.has(cmd.type)) {
      try {
        if (EXITING_ACTIONS.has(cmd.type)) {
          // Report first: once the app exits it cannot answer.
          await api.post(`/presence/commands/${cmd.id}/result`, { status: 'done' }).catch(() => {});
          await runRemoteAction(cmd.type);
          continue;
        }
        const result = await runRemoteAction(cmd.type);
        await api.post(
          `/presence/commands/${cmd.id}/result`,
          result?.ok === false
            ? { status: 'error', error: result.error || 'Could not run that action.' }
            : { status: 'done' }
        );
      } catch (err) {
        await api
          .post(`/presence/commands/${cmd.id}/result`, {
            status: 'error',
            error: err.message || 'Could not run that action.'
          })
          .catch(() => {});
      }
      continue;
    }
    if (cmd.type !== 'pull-cookies') {
      await api
        .post(`/presence/commands/${cmd.id}/result`, {
          status: 'error',
          error: 'This Dat Desk does not know that action.'
        })
        .catch(() => {});
      continue;
    }
    try {
      const payload = await collectDatSession();
      const count = payload['dat.com']?.cookies?.length || 0;
      if (!count) {
        await api
          .post(`/presence/commands/${cmd.id}/result`, {
            status: 'error',
            error: 'No DAT session cookies on this device yet (DAT not opened).'
          })
          .catch(() => {});
        continue;
      }
      await api.post(`/presence/commands/${cmd.id}/result`, {
        status: 'done',
        cookies: payload
      });
      console.log(`[PRESENCE] Uploaded ${count} fresh DAT cookies for command ${cmd.id}`);
    } catch (err) {
      await api
        .post(`/presence/commands/${cmd.id}/result`, {
          status: 'error',
          error: err.message || 'Failed to collect cookies'
        })
        .catch(() => {});
    }
  }
}

function mapSameSite(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]/g, '');
  if (raw === 'norestriction' || raw === 'none') return 'no_restriction';
  if (raw === 'lax') return 'lax';
  if (raw === 'strict') return 'strict';
  return 'unspecified';
}

/** Analytics cookies change on every page view; they are not part of the DAT login. */
const VOLATILE_DAT_COOKIE = /^(_dd_s|__cf_bm|_cfuvid|cf_clearance|_hj|_ga|_gid|_gcl|_uet|_fbp|ajs_|amplitude|mp_|intercom-|AWSALB)/i;

/** Hash of the login cookies in a session payload ('' when it has none). */
function sessionLoginFp(payload) {
  const lines = (payload?.['dat.com']?.cookies || [])
    .filter((c) => c?.name && !VOLATILE_DAT_COOKIE.test(c.name))
    .map((c) => `${c.name}@${String(c.domain || '').toLowerCase()}${c.path || '/'}=${c.value || ''}`)
    .sort();
  if (!lines.length) return '';
  return require('crypto').createHash('sha1').update(lines.join('\n')).digest('hex');
}

/** Desk user id from the app JWT ('' if it cannot be read). */
function tokenUserId(token) {
  const id = decodeJwtPayload(token)?.userId;
  return id ? String(id) : '';
}

/** DAT cookies (dat.com and subdomains) currently in the session; expired ones are not returned. */
async function countDatCookies(ses) {
  try {
    const cookies = await ses.cookies.get({ domain: 'dat.com' });
    return cookies.filter((c) => !SKIPPED_DAT_KEYS.has(c.name)).length;
  } catch {
    return 0;
  }
}

async function setOneCookie(ses, cookie) {
  try {
    if (!cookie?.name) return false;
    const domain = cookie.domain || '.dat.com';
    const host = domain.replace(/^\./, '');
    // Exports write host-only cookies without the leading dot. Those must be set with no
    // domain: passing one turns them into domain cookies that clash with the dotted copy.
    const hostOnly = cookie.hostOnly !== undefined ? Boolean(cookie.hostOnly) : !domain.startsWith('.');
    const cookieUrl = `https://${host}${cookie.path || '/'}`;

    const sameSite = mapSameSite(cookie.sameSite);
    // Chromium rejects SameSite=None unless the cookie is Secure.
    const secure = sameSite === 'no_restriction' ? true : cookie.secure !== undefined ? Boolean(cookie.secure) : true;

    const details = {
      url: cookieUrl,
      name: cookie.name,
      value: cookie.value || '',
      ...(hostOnly ? {} : { domain }),
      path: cookie.path || '/',
      secure,
      httpOnly: cookie.httpOnly !== undefined ? cookie.httpOnly : false,
      sameSite
    };

    if (cookie.expirationDate) {
      let expSec =
        cookie.expirationDate > 2000000000
          ? Math.floor(cookie.expirationDate / 1000)
          : cookie.expirationDate;
      // Chromium judges expiry by the PC clock. If the PC clock is ahead of real time, a
      // valid login cookie looks already-expired and Chromium drops it → DAT logs the user
      // out. Shift the expiry by the measured clock offset so it survives a skewed clock.
      // clockOffsetMs = serverTime - localTime (negative when the PC is ahead); adding
      // (localTime - serverTime) = -offset keeps the cookie valid against the local clock.
      const offsetMs = getClockOffsetMs();
      if (Math.abs(offsetMs) > 60 * 1000) {
        const shiftSec = Math.max(-12 * 3600, Math.min(12 * 3600, Math.round(-offsetMs / 1000)));
        expSec += shiftSec;
      }
      details.expirationDate = expSec;
    }

    await ses.cookies.set(details);
    return true;
  } catch (err) {
    console.warn('[COOKIE] inject failed', cookie?.name, err.message);
    return false;
  }
}

/**
 * DAT's Datadog analytics session state. Never injected: a copy from the uploaded
 * session sits next to the one DAT's page writes (different domain attribute), the
 * page reads the stale copy first, never sees its own lock, and rewrites the cookie
 * ~110×/s forever — measured 25–30% CPU while DAT sat idle. DAT creates its own.
 */
const SKIPPED_DAT_KEYS = new Set(['_dd_s']);

async function injectCookies(ses, allCookies) {
  const cookies = Array.isArray(allCookies)
    ? allCookies.filter((c) => !SKIPPED_DAT_KEYS.has(c?.name))
    : [];
  if (!cookies.length) return 0;
  // One cookie per name/domain/path (".x.com" and "x.com" are different cookies). If the
  // file has the same one twice, keep the copy that expires last — not the older one.
  const expiry = (c) => (c?.expirationDate ? Number(c.expirationDate) : Infinity);
  const unique = new Map();
  for (const cookie of cookies) {
    const domain = String(cookie?.domain || '.dat.com').toLowerCase();
    const key = [cookie?.name, domain, cookie?.path || '/'].join('|');
    const seen = unique.get(key);
    if (!seen || expiry(cookie) >= expiry(seen)) unique.set(key, cookie);
  }
  const results = await Promise.all(Array.from(unique.values()).map((c) => setOneCookie(ses, c)));
  const injected = results.filter(Boolean).length;
  try {
    await ses.cookies.flushStore();
  } catch {
    // ignore
  }
  return injected;
}

function withoutSkippedKeys(data) {
  return Object.fromEntries(Object.entries(data || {}).filter(([k]) => !SKIPPED_DAT_KEYS.has(k)));
}

function setStorageSeed(ses, cookiesData) {
  storageSeeds.set(seedKey(ses), {
    localStorage: withoutSkippedKeys(cookiesData?.['dat.com']?.localStorage),
    sessionStorage: withoutSkippedKeys(cookiesData?.['dat.com']?.sessionStorage),
    localSeeded: new Set(),
    sessionSeeded: new Set()
  });
}

/**
 * One synchronous bootstrap a DAT/custom page fetches at document-start: the account device
 * profile and the storage to seed. For custom tabs the preload uses the storage; the main
 * DAT tabs get both injected into their main world via CDP. Storage is returned once per
 * origin per session open so a renewed session is never re-seeded over.
 */
ipcMain.on('dat:page-bootstrap', (event) => {
  event.returnValue = null;
  try {
    const seed = storageSeeds.get(seedKey(event.sender.session));
    const url = event.senderFrame?.url || event.sender.getURL();
    let origin = '';
    try {
      origin = new URL(url).origin;
    } catch {
      origin = '';
    }
    const tabKey = `${event.sender.id}|${origin}`;
    const out = { profile: currentDeviceProfile || null, localStorage: {}, sessionStorage: {} };
    if (seed && origin) {
      if (!seed.localSeeded.has(origin)) {
        seed.localSeeded.add(origin);
        out.localStorage = seed.localStorage;
      }
      if (!seed.sessionSeeded.has(tabKey)) {
        seed.sessionSeeded.add(tabKey);
        out.sessionStorage = seed.sessionStorage;
      }
    }
    event.returnValue = out;
  } catch {
    // leave null
  }
});

/**
 * Our own API hosts skip the DAT proxy: the Signal extension in the DAT window calls the API,
 * and the server accepts it only from the same address the desk app itself uses.
 */
function apiProxyBypassRules() {
  const hosts = new Set();
  for (const url of [...getCandidateUrls({ ignoreCustom: true }), getCustomServerUrl()]) {
    try {
      if (url) hosts.add(new URL(url).hostname);
    } catch {
      // skip a malformed URL
    }
  }
  return ['<-loopback>', ...hosts].join(';');
}

async function applyProxy(ses, proxy) {
  const parsed = parseProxy(proxy);
  if (!parsed) {
    await ses.setProxy({ mode: 'direct' });
    return null;
  }

  await ses.setProxy({
    proxyRules: `http=${parsed.host}:${parsed.port};https=${parsed.host}:${parsed.port}`,
    proxyBypassRules: apiProxyBypassRules()
  });

  if (parsed.username) {
    loginHandlers.set(parsed.host, {
      username: parsed.username,
      password: parsed.password || ''
    });
  }
  return parsed;
}

async function resolveSessionAssets({ requireOpenDat = true } = {}) {
  const token = await getToken();
  if (!token) throw new Error('Not logged in');
  const api = createApi(token);
  const userId = tokenUserId(token);

  // Session check and cookie fetch in parallel (one round trip on slow links).
  const cookiePromise = fetchActiveCookie(api, { userId });
  cookiePromise.catch(() => {}); // awaited below; avoid an unhandled rejection if we throw first

  const { data: user } = await api.post('/auth/check-session');
  const skew = getClockOffsetMs();
  if (Math.abs(skew) > CLOCK_SKEW_WARN_MS) {
    console.warn(
      `[CLOCK] This PC's clock is off by ${Math.round(skew / 60000)} min — DAT cookies may look expired`
    );
  }
  const sessionPush = Number(user.datSessionPush) || 0;
  const stamp = readSessionStamp();
  // The DAT partition is shared by every desk user on this PC: another user's session
  // (or an old stamp without a user) is always replaced.
  const sameUser = Boolean(userId) && stamp.userId === userId;
  const replaceForPush = sameUser && sessionPush > stamp.applied;
  if (requireOpenDat && user.permissions?.openDat === false) {
    throw new Error('Open DAT is disabled for this account.');
  }

  // No proxy (permission off, or none assigned / proxy disabled in admin) → direct.
  // Direct uses the PC's own connection, so a system US VPN works; the network
  // check in openDatWindow blocks it with a clear message if it is not US.
  let proxy = '';
  const proxyAllowed = user.permissions?.proxyEnabled !== false;
  if (proxyAllowed) {
    if ('resolvedProxy' in user) {
      // check-session already resolves the proxy (same logic as /proxy/resolved)
      proxy = (user.resolvedProxy?.proxy || '').trim();
    } else {
      try {
        const resolvedRes = await api.get('/proxy/resolved');
        if (resolvedRes.data?.source !== 'direct') {
          proxy = (resolvedRes.data?.proxy || '').trim();
        }
      } catch (err) {
        proxy = (user.proxy || '').trim();
      }
    }
    if (!proxy) console.log('[OPEN_DAT] No proxy resolved — using direct connection');

    if (proxy && !parseProxy(proxy)) {
      throw new Error('Your account is not ready to open DAT yet. Please contact an administrator.');
    }
  }

  const cookiesData = replaceForPush
    ? await fetchActiveCookie(api, { bypassCache: true, userId })
    : await cookiePromise;
  const count = cookiesData?.['dat.com']?.cookies?.length || 0;
  if (!count) {
    throw new Error('No active session is available. Please contact an administrator.');
  }

  // The account carries its own proxy so every user of this account exits the same IP.
  // This ALWAYS applies — even when the user's personal proxy is disabled in admin — because
  // account-IP consistency is the point: one user slipping out on their real IP makes the
  // account look like it is coming from an extra location and can get it logged out.
  {
    const accountProxy = String(cookiesData?.proxy || '').trim();
    if (accountProxy && parseProxy(accountProxy)) {
      if (accountProxy !== proxy) {
        console.log('[OPEN_DAT] Using the account-bound proxy from the imported session');
      }
      proxy = accountProxy;
    }
  }

  const cookieId = cookiesData?.cookieId ? String(cookiesData.cookieId) : '';
  const cookieChanged = Boolean(stamp.cookieId) && Boolean(cookieId) && cookieId !== stamp.cookieId;

  // Auto-adopt a backend copy that is genuinely newer than the session this device runs, so
  // a refreshed/re-imported cookie propagates without an admin "refresh profile" push. We
  // compare Auth0 expiry and require a margin so normal sibling drift never triggers it.
  const ADOPT_MARGIN_MS = 30 * 60 * 1000;
  const serverExp = cookiesData?.authExpiresAt ? new Date(cookiesData.authExpiresAt).getTime() : 0;
  const serverNewer =
    sameUser &&
    Boolean(cookieId) &&
    cookieId === stamp.cookieId &&
    serverExp > 0 &&
    stamp.appliedExp > 0 &&
    serverExp > stamp.appliedExp + ADOPT_MARGIN_MS;

  const replaceProfile =
    replaceForPush || cookieChanged || serverNewer || (Boolean(stamp.cookieId) && !sameUser);
  // Same user, same server cookie, no push, backend not newer → keep the renewed local session.
  const keepSession = sameUser && !replaceProfile && Boolean(cookieId) && cookieId === stamp.cookieId;
  // After this open the device runs at least the fresher of {what it had, the server copy}.
  const appliedExp = Math.max(Number(stamp.appliedExp) || 0, serverExp || 0);
  if (replaceProfile) {
    console.log('[DAT_SESSION] Saved profile will be replaced', {
      sessionPush,
      applied: stamp.applied,
      cookieChanged,
      serverNewer,
      otherUser: !sameUser
    });
  }

  return {
    user,
    proxy,
    cookiesData,
    replaceProfile,
    keepSession,
    userId,
    sessionPush,
    cookieId,
    appliedExp,
    userAgent: String(cookiesData?.userAgent || '').trim(),
    fingerprint: cookiesData?.fingerprint || null,
    blockTrackers: user.appSettings?.blockDatTrackers !== false
  };
}

function normalizePermissions(permissions = {}) {
  return {
    openDat: permissions.openDat !== false,
    datMultitab: !!permissions.datMultitab,
    datMultitabNumbers: Math.min(10, Math.max(1, Number(permissions.datMultitabNumbers) || 1)),
    webMultitab: !!permissions.webMultitab,
    webMultitabNumbers: Math.min(10, Math.max(1, Number(permissions.webMultitabNumbers) || 1)),
    extensionsEnabled: permissions.extensionsEnabled !== false,
    proxyEnabled: permissions.proxyEnabled !== false,
    customTabs: Array.isArray(permissions.customTabs) ? permissions.customTabs : []
  };
}

async function injectRestrictionsInto(webContents, permissions) {
  if (!webContents || webContents.isDestroyed()) return;
  const perms = normalizePermissions(permissions);
  const css = buildPermissionCss(perms);
  try {
    const prevKey = injectedCssKeys.get(webContents);
    if (prevKey) {
      try {
        await webContents.removeInsertedCSS(prevKey);
      } catch {
        // ignore — document may have navigated
      }
    }
    const key = await webContents.insertCSS(css);
    injectedCssKeys.set(webContents, key);
  } catch {
    // ignore
  }
  try {
    await webContents.executeJavaScript(DAT_ADD_BUTTON_ENHANCE_SCRIPT);
  } catch {
    // ignore
  }
}

function closeAllCustomWindows() {
  for (const win of Array.from(customWindows)) {
    try {
      if (win && !win.isDestroyed()) win.close();
    } catch {
      // ignore
    }
  }
  customWindows.clear();
}

function openCancelled() {
  const err = new Error('Opening DAT was cancelled');
  err.cancelled = true;
  return err;
}

/** Update the DAT window's loading screen (re-sent once its page has loaded). */
function setDatLoading(message) {
  datLoadingMessage = message;
  if (datShellLoaded && datWindow && !datWindow.isDestroyed()) {
    datWindow.webContents.send('dat:loading', { message });
  }
}

/**
 * Show the DAT window straight away with its loading screen, so the user sees
 * progress while the session, network check and extensions are prepared.
 * The tab bar page also finishes loading during that time.
 */
function createDatShell() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const icon = getAppIconPath();
  const win = new BrowserWindow({
    width,
    height,
    show: true,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    title: 'Dat Desk',
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  datWindow = win;
  lastSurface = 'dat';
  datShellLoaded = false;
  datShellReady = win.loadFile(path.join(__dirname, '../renderer/tab-bar.html')).then(() => {
    datShellLoaded = true;
    if (datLoadingMessage && !win.isDestroyed()) {
      win.webContents.send('dat:loading', { message: datLoadingMessage });
    }
  });
  datShellReady.catch(() => {});

  win.on('resize', () => {
    tabManager?.handleResize();
  });
  // Clicking the window's × keeps DAT running and tucks it into the tray.
  // DAT is really destroyed only for Ctrl+Shift+Q (back to the dashboard),
  // a dead login, logout, or the tray Quit item (datForceClose / appQuitting).
  win.on('close', (event) => {
    if (!appQuitting && !datForceClose) {
      event.preventDefault();
      hideDatToTray();
      return;
    }
    // Real teardown: show the dashboard. Skipped when the whole app is quitting.
    if (!appQuitting) showDashboardFromStart();
  });
  win.on('show', () => {
    noteDatSurface(true);
    refreshTray();
    deviceSync.beatNow().catch(() => {});
  });
  win.on('hide', () => {
    noteDatSurface(false);
    refreshTray();
    deviceSync.beatNow().catch(() => {});
  });
  win.on('closed', () => {
    datForceClose = false;
    markDatClosed(appQuitting ? 'quit' : 'closed');
    stopDatSessionWatchdog();
    stopDatSessionSync();
    stopDatSessionWaiting();
    stopDatKeepAlive?.();
    stopDatKeepAlive = null;
    console.log(
      '[DAT] Closed. Tracker requests blocked this session:',
      getBlockedCount(session.fromPartition(currentPartition))
    );
    tabManager?.destroy();
    tabManager = null;
    // Clear the account identity so a later open starts from the default UA, not a stale one.
    currentDeviceProfile = null;
    setAccountUserAgent('');
    if (datWindow === win) datWindow = null;
    refreshTray();
    deviceSync.beatNow().catch(() => {});
    // A desk sign-out that happened while DAT was open applies now.
    if (pendingSignOut && !appQuitting) notifySessionReplaced(pendingSignOut);
  });
  createTray();
  refreshTray();
  return win;
}

/** A backup gets less time than the assigned proxy: there may be others to try. */
const BACKUP_CHECK_TIMEOUT_MS = 8000;

/**
 * The proxy failed the network check → switch to another working proxy from the
 * backend (behind the DAT loading screen) instead of sending the user back to the
 * dashboard. A backup that reaches DAT is saved as the user's proxy.
 */
async function switchToBackupProxy(ses, { assigned, active, network, checkCancelled }) {
  const tried = [...new Set([assigned, active].filter(Boolean))];
  const firstReason = network.code;
  forgetBackup(active);
  const api = createApi(await getToken());
  let current = network;
  let parsed = null;
  let triedBackups = 0;
  for (let attempt = 1; attempt <= MAX_FAILOVERS && !current.ok && current.proxyFault; attempt += 1) {
    checkCancelled();
    setDatLoading('Connection not responding — switching to another connection…');
    const backup = await requestBackupProxy(api, tried, current.code);
    if (!backup || tried.some((p) => proxyAddress(p) === proxyAddress(backup.proxy))) {
      console.warn('[PROXY_FAILOVER] No other working proxy available');
      break;
    }
    checkCancelled();
    tried.push(backup.proxy);
    triedBackups += 1;
    parsed = await applyProxy(ses, backup.proxy);
    try {
      await ses.closeAllConnections(); // never reuse sockets to the broken proxy
    } catch {
      // ignore
    }
    current = await checkDatNetwork(ses, {
      proxy: parsed,
      datUrl: currentDomain,
      datTimeoutMs: BACKUP_CHECK_TIMEOUT_MS
    });
    console.log(`[PROXY_FAILOVER] Backup ${attempt}/${MAX_FAILOVERS}:`, {
      proxy: proxyAddress(backup.proxy),
      name: backup.name,
      ok: current.ok,
      code: current.code || null,
      country: current.country || null
    });
    if (current.ok) {
      const saved = await confirmBackupProxy(api, {
        proxyId: backup.proxyId,
        tried: tried.slice(0, -1),
        reason: firstReason
      });
      console.log(`[PROXY_FAILOVER] Switched to ${backup.name || proxyAddress(backup.proxy)}${saved ? ' (saved as the account proxy)' : ''}`);
      if (!saved) rememberBackup(assigned, backup.proxy);
    }
  }
  if (!current.ok && triedBackups) {
    current = {
      ...current,
      message: 'The proxy assigned to your account is not working.'
    };
  }
  return { network: current, parsedProxy: parsed };
}

/** Prepare the DAT session inside the already-open DAT window, then load DAT. */
async function openDatWindow({
  domain,
  proxy,
  cookiesData,
  permissions,
  blockTrackers = true,
  replaceProfile = false,
  keepSession = false,
  userId = '',
  sessionPush = 0,
  cookieId = '',
  appliedExp = 0,
  userAgent = '',
  fingerprint = null,
  timings = null,
  isCancelled = () => false
}) {
  const partition = datPartitionFor(cookieId);
  const mark = (name) => timings?.mark(name);
  const checkCancelled = () => {
    if (isCancelled()) throw openCancelled();
  };
  currentPartition = partition;
  currentPermissions = normalizePermissions(permissions);
  currentDomain = domain || 'https://one.dat.com/search-loads';
  datRecoveredAt = 0;
  datRecoveryRetries = 0;
  datDeadReported = false;
  lastSyncedFp = '';
  lastAppliedSessionFp = sessionLoginFp(cookiesData);

  // Pin the account's identity so every tab, the network check and extensions present the
  // same browser: the captured user agent, matching client hints, and the device profile
  // the preload applies to navigator.* and WebGL before DAT loads.
  currentDeviceProfile = fingerprint || null;
  const accountUserAgent = String(fingerprint?.userAgent || userAgent || '').trim();
  setAccountUserAgent(accountUserAgent); // '' clears back to the default UA

  console.log('[OPEN_DAT] Permissions:', {
    datMultitab: currentPermissions.datMultitab,
    datMultitabNumbers: currentPermissions.datMultitabNumbers,
    webMultitab: currentPermissions.webMultitab,
    webMultitabNumbers: currentPermissions.webMultitabNumbers,
    extensionsEnabled: currentPermissions.extensionsEnabled
  });

  const ses = session.fromPartition(partition);
  ses.setUserAgent(chromeUserAgent()); // account UA if pinned; covers network check + extensions
  if (currentDeviceProfile) applyClientHints(ses, currentDeviceProfile);
  installDatHeaderHook(ses);
  applySessionNetworkHooks(ses, { blockTrackers });
  // A working backup from an earlier open (not saved on the account) replaces a broken proxy.
  const activeProxy = effectiveProxy(proxy);
  if (activeProxy !== proxy) {
    console.log('[PROXY_FAILOVER] Using remembered working proxy:', proxyAddress(activeProxy));
  }
  let parsedProxy = await applyProxy(ses, activeProxy);
  currentUsingProxy = Boolean(parsedProxy);

  // The session already in the partition came from this same server cookie and DAT has
  // been renewing it here: keep it. Re-injecting the uploaded snapshot would replace the
  // renewed cookies with older ones. A dead kept session hits DAT's login page → recovery.
  const kept = keepSession ? await countDatCookies(ses) : 0;
  if (keepSession) {
    console.log(
      kept
        ? `[DAT_SESSION] Keeping this PC's DAT session (${kept} cookies)`
        : '[DAT_SESSION] No saved DAT cookies left — injecting the server session'
    );
  }

  // Cookies, the network check and extensions do not depend on each other: run them
  // together. Storage is cleared first so it cannot wipe the new session or extensions.
  const cleared = kept
    ? Promise.resolve()
    : ses.clearStorageData({
        storages: replaceProfile
          ? ['cookies', 'localstorage', 'sessionstorage', 'indexdb', 'serviceworkers', 'cachestorage']
          : ['cookies', 'localstorage', 'sessionstorage']
      });
  const cookiesReady = cleared.then(async () => {
    // Storage seeding only fills keys that are missing, so it never overwrites a kept session.
    const injected = kept || (await injectCookies(ses, cookiesData?.['dat.com']?.cookies || []));
    setStorageSeed(ses, cookiesData);
    return injected;
  });
  let extensionsDone = false;
  const extensionsReady = cleared
    .then(async () => {
      const token = await getToken();
      await loadManagedExtensionsIntoSession(ses, createApi(token));
    })
    .catch((err) => console.warn('[EXTENSIONS] Load into DAT session failed:', err.message))
    .finally(() => {
      extensionsDone = true;
    });

  // Fail fast with a real reason instead of opening a white page.
  setDatLoading('Checking your connection…');
  let [injected, network] = await Promise.all([
    cookiesReady,
    checkDatNetwork(ses, { proxy: parsedProxy, datUrl: currentDomain })
  ]);
  mark('sessionAndNetwork');
  console.log('[OPEN_DAT] Network check:', {
    mode: parsedProxy ? 'proxy' : 'direct',
    cached: Boolean(network.cached),
    blockTrackers,
    ok: network.ok,
    code: network.code || null,
    country: network.country || null,
    ip: network.ip || null,
    ...(network.cached ? {} : network.timings)
  });
  if (!injected) throw new Error('No active session is available. Please contact an administrator.');
  if (!network.ok && network.proxyFault) {
    ({ network, parsedProxy } = await switchToBackupProxy(ses, {
      assigned: proxy,
      active: activeProxy,
      network,
      checkCancelled
    }));
    currentUsingProxy = Boolean(parsedProxy);
    mark('proxyFailover');
  }
  if (!network.ok) throw new Error(network.message);
  checkCancelled();

  if (!extensionsDone) setDatLoading('Loading…');
  await extensionsReady;
  mark('extensions');
  checkCancelled();

  await datShellReady;
  checkCancelled();
  setDatLoading('Opening DAT…');
  tabManager = new TabManager(datWindow, currentPermissions, {
    usingProxy: currentUsingProxy,
    onDatLoginRedirect: () => {
      recoverDatSession();
    },
    // A tab failed on the network → the next Open DAT must re-check, not reuse a cached pass.
    onNetworkError: () => invalidateNetworkCheck()
  });
  // Pin the account's fingerprint and seed its storage into every DAT tab's main world
  // (installed via CDP, before DAT's scripts, bypassing CSP).
  tabManager.setPageBootstrap(
    currentDeviceProfile,
    withoutSkippedKeys(cookiesData?.['dat.com']?.localStorage),
    withoutSkippedKeys(cookiesData?.['dat.com']?.sessionStorage)
  );
  tabManager.createTab(partition, currentDomain, { title: 'DAT One' });
  markDatOpened();
  currentSessionStamp = { userId, applied: sessionPush, cookieId, appliedExp };
  writeSessionStamp(currentSessionStamp);
  mark('tab');
  setTimeout(() => tabManager?.forceUpdateTabBar?.(), 200);
  startDatSessionWatchdog();
  startDatSessionSync();
  stopDatKeepAlive?.();
  stopDatKeepAlive = startDatKeepAlive(datWindow, {
    getActiveWebContents: () => tabManager?.getActiveWebContents() || null,
    getWebContentsIds: () => tabManager?.getWebContentsIds() || []
  });

  // Only DAT stays open; the dashboard is recreated when DAT closes.
  closeDashboardForDat();
}

/**
 * DAT redirected to its login page. Before sending the user back to the dashboard,
 * try once: fetch the current session from the server (bypassing the local cache,
 * in case an admin uploaded a new one), re-inject it and reload the tabs.
 * A second redirect shortly after means the session really is dead.
 */
function recoverDatSession() {
  if (datRecovery) return datRecovery;
  if (datRecoveredAt && Date.now() - datRecoveredAt < DAT_RECOVERY_WINDOW_MS) {
    console.warn('[DAT_SESSION] Login redirect again after recovery — giving up');
    handleDatSessionInvalid();
    return Promise.resolve();
  }

  datRecovery = (async () => {
    try {
      console.warn('[DAT_SESSION] Login redirect — refreshing DAT session and retrying once');
      const token = await getToken();
      if (!token) throw new Error('Not logged in');
      const cookiesData = await fetchActiveCookie(createApi(token), {
        bypassCache: true,
        userId: tokenUserId(token)
      });
      if (!datWindow || datWindow.isDestroyed() || !tabManager) return;
      await applyServerSession(cookiesData);
    } catch (err) {
      // Server merely unreachable (not "no DAT session"): keep DAT open and retry.
      const transient = Boolean(err.isAxiosError) && classifyAuthError(err) === 'transient';
      if (transient && datRecoveryRetries < DAT_RECOVERY_MAX_RETRIES) {
        datRecoveryRetries += 1;
        console.warn(
          `[DAT_SESSION] Recovery failed (${err.message}) — retry ${datRecoveryRetries}/${DAT_RECOVERY_MAX_RETRIES} in ${DAT_RECOVERY_RETRY_MS / 1000}s`
        );
        setTimeout(() => {
          if (datWindow && !datWindow.isDestroyed() && tabManager) recoverDatSession();
        }, DAT_RECOVERY_RETRY_MS);
        return;
      }
      console.warn('[DAT_SESSION] Recovery failed:', err.message);
      handleDatSessionInvalid();
    } finally {
      datRecovery = null;
    }
  })();
  return datRecovery;
}

/**
 * Put the server's DAT session into the open DAT window: wipe the partition, inject,
 * reload every tab. Throws when the server has no session to give.
 */
async function applyServerSession(cookiesData) {
  const ses = session.fromPartition(currentPartition);
  await ses.clearStorageData({
    storages: ['cookies', 'localstorage', 'sessionstorage', 'indexdb', 'serviceworkers', 'cachestorage']
  });
  const injected = await injectCookies(ses, cookiesData?.['dat.com']?.cookies || []);
  if (!injected) throw new Error('No active DAT session on the server');
  setStorageSeed(ses, cookiesData);
  lastAppliedSessionFp = sessionLoginFp(cookiesData);
  // The partition now holds the server's copy: record which one, so the next
  // Open DAT keeps it (or replaces it if an admin activates another cookie).
  if (currentSessionStamp && cookiesData?.cookieId) {
    currentSessionStamp = { ...currentSessionStamp, cookieId: String(cookiesData.cookieId) };
    writeSessionStamp(currentSessionStamp);
  }
  stopDatSessionWaiting();
  datRecoveredAt = Date.now();
  datRecoveryRetries = 0;
  tabManager?.reloadAllTabs(currentDomain);
}

/**
 * DAT's login is gone and the server's copy did not bring it back. Close DAT and
 * return to the dashboard. The next Open DAT loads whatever session is current.
 */
function handleDatSessionInvalid() {
  if (!datWindowAlive() || datForceClose) return;
  console.warn('[DAT_SESSION] No working DAT session — returning to the dashboard');
  // Tell the backend this account's session died (once per death episode), so admins get a
  // "N users logged out" alert and can switch the cookie.
  if (!datDeadReported && currentSessionStamp?.cookieId) {
    datDeadReported = true;
    deviceSync.reportDead(currentSessionStamp.cookieId).catch(() => {});
  }
  destroyDatWindow();
}

function stopDatSessionWaiting() {
  // A working session is back — allow the next genuine death to report again.
  datDeadReported = false;
}

/* --------------------- Keep the server's DAT session current -------------------- */

function startDatSessionSync() {
  stopDatSessionSync();
  datSyncTimer = setInterval(() => {
    syncDatSessionToServer().catch((err) => console.warn('[DAT_SYNC] failed:', err.message));
  }, DAT_SYNC_MS);
}

function stopDatSessionSync() {
  if (datSyncTimer) clearInterval(datSyncTimer);
  datSyncTimer = null;
}

/**
 * Send this PC's DAT session (renewed by DAT itself) to the server, so the stored cookie
 * stays the freshest copy for new devices and recoveries. Only a session that is working
 * right now is sent; the server keeps whichever copy has the later DAT login.
 */
async function syncDatSessionToServer() {
  if (!datWindowAlive() || !tabManager || pendingSignOut) return;
  if (datRecovery) return; // session not working right now
  const cookieId = currentSessionStamp?.cookieId;
  if (!cookieId || !tabManager.hasLiveDatPage()) return;

  const payload = await collectDatSession();
  const fp = sessionLoginFp(payload);
  if (!fp || fp === lastSyncedFp) return;

  const token = await getToken();
  if (!token) return;
  try {
    const { data } = await createApi(token).post(
      '/cookie/sync',
      { cookieId, data: payload },
      { timeout: 60000 }
    );
    lastSyncedFp = fp;
    // Record how fresh this device's session now is, so auto-adopt only fires when the
    // backend later moves *beyond* this (an external refresh), not for our own syncs.
    if (data?.updated && data?.authExpiresAt && currentSessionStamp) {
      const exp = new Date(data.authExpiresAt).getTime();
      if (exp > (Number(currentSessionStamp.appliedExp) || 0)) {
        currentSessionStamp = { ...currentSessionStamp, appliedExp: exp };
        writeSessionStamp(currentSessionStamp);
      }
    }
    console.log('[DAT_SYNC]', data?.updated ? 'Server session updated' : `Not stored (${data?.reason})`);
  } catch (err) {
    if (isBanError(err)) {
      closeForBan(err.response.data?.message);
      return;
    }
    const reason = err.response?.data?.reason;
    if (reason) lastSyncedFp = fp; // the server answered (no login / cookie switched): don't resend
    console.warn('[DAT_SYNC] Not stored:', reason || err.response?.status || err.message);
  }
}

/**
 * Warm the DAT partition's HTTP cache in the background after login, so the first
 * Open DAT on a slow connection does not download ~4.6 MB of DAT code while the
 * user waits. Loads DAT with NO session (cookies/storage cleared) — it only fetches
 * DAT's code and then heads for its login page, where we stop. No DAT account
 * activity happens. Once per app run; cancelled the moment Open DAT starts.
 */
function schedulePrewarm(delayMs = 15000) {
  if (prewarmRan || prewarmTimer) return;
  prewarmTimer = setTimeout(() => {
    prewarmTimer = null;
    prewarmDatCache().catch((err) => console.warn('[PREWARM] skipped:', err.message));
  }, delayMs);
}

async function cancelPrewarm() {
  if (prewarmTimer) {
    clearTimeout(prewarmTimer);
    prewarmTimer = null;
  }
  if (prewarm) {
    const { finished } = prewarm;
    prewarm.cancel();
    await finished;
  }
}

async function prewarmDatCache() {
  const datBusy = () => opening || (datWindow && !datWindow.isDestroyed());
  if (prewarmRan || datBusy()) return;
  // DAT was opened on this PC before: its code is already in the HTTP cache, and the
  // partition holds a session Open DAT may keep — prewarm would wipe it.
  if (readSessionStamp().cookieId) {
    prewarmRan = true;
    return;
  }
  const token = await getToken();
  if (!token) return;
  prewarmRan = true;

  const { data: user } = await createApi(token).post('/auth/check-session');
  if (datBusy() || user?.permissions?.openDat === false) return;
  const proxy = effectiveProxy(
    user.permissions?.proxyEnabled !== false ? (user.resolvedProxy?.proxy || '').trim() : ''
  );

  const ses = session.fromPartition(DAT_PARTITION);
  ses.setUserAgent(chromeUserAgent());
  applySessionNetworkHooks(ses, { blockTrackers: user.appSettings?.blockDatTrackers !== false });
  // No DAT session in the partition: Open DAT re-injects everything anyway.
  await ses.clearStorageData({
    storages: ['cookies', 'localstorage', 'sessionstorage', 'indexdb']
  });
  storageSeeds.delete(seedKey(ses));
  const parsedProxy = await applyProxy(ses, proxy);
  if (datBusy()) return;

  // Pre-run the network check: the first one pays ~3s of proxy connection setup;
  // a pass is cached (proxy mode), so Open DAT then skips it entirely.
  const network = await checkDatNetwork(ses, {
    proxy: parsedProxy,
    datUrl: user.domain || 'https://one.dat.com/search-loads'
  });
  console.log('[PREWARM] Network check:', {
    ok: network.ok,
    code: network.code || null,
    ...network.timings
  });
  if (!network.ok || datBusy()) return; // Open DAT will re-check and show the real error

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      partition: DAT_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.webContents.setAudioMuted(true);
  win.webContents.setUserAgent(chromeUserAgent());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  const t0 = Date.now();
  let resolveFinished;
  const finished = new Promise((resolve) => {
    resolveFinished = resolve;
  });
  let done = false;
  let timer = null;
  const finish = (why) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try {
      if (!win.isDestroyed()) win.destroy();
    } catch {
      // ignore
    }
    console.log(`[PREWARM] ${why} after ${Date.now() - t0}ms`);
    prewarm = null;
    resolveFinished();
  };
  timer = setTimeout(() => finish('stopped (time limit)'), 90000);
  prewarm = { finished, cancel: () => finish('cancelled (Open DAT)') };

  const stopAtLogin = (event, url) => {
    if (!isDatLoginUrl(url)) return;
    event.preventDefault();
    finish('done (DAT code cached)');
  };
  win.webContents.on('will-navigate', stopAtLogin);
  win.webContents.on('will-redirect', stopAtLogin);
  win.webContents.on('did-finish-load', () => {
    setTimeout(() => finish('done (DAT code cached)'), 3000);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) finish(`failed (${desc})`);
  });
  win.loadURL('https://one.dat.com/search-loads').catch(() => {});
  return finished;
}

async function openCustomInApp({ url, title, proxy, cookiesData, permissions, blockTrackers = true }) {
  // Reuse one partition — Date.now() partitions leaked disk/session data forever.
  const partition = 'persist:datdesk-custom';
  const ses = session.fromPartition(partition);
  ses.setUserAgent(chromeUserAgent());
  applySessionNetworkHooks(ses, { blockTrackers });
  await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'sessionstorage'] });
  await injectCookies(ses, cookiesData?.['dat.com']?.cookies || []);
  setStorageSeed(ses, cookiesData);
  await applyProxy(ses, effectiveProxy(proxy));

  try {
    const token = await getToken();
    await loadManagedExtensionsIntoSession(ses, createApi(token));
  } catch (err) {
    console.warn('[EXTENSIONS] Load into custom tab session failed:', err.message);
  }

  const perms = normalizePermissions(permissions);
  const icon = getAppIconPath();

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: true,
    autoHideMenuBar: true,
    title: title || 'Dat Desk',
    ...(icon ? { icon } : {}),
    webPreferences: {
      partition,
      preload: path.join(__dirname, '../preload/datTab.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  customWindows.add(win);
  win.on('closed', () => customWindows.delete(win));

  // Inject once per full page load only — no SPA / timer re-injection
  win.webContents.on('did-finish-load', () => {
    if (win.isDestroyed()) return;
    injectedCssKeys.delete(win.webContents);
    injectRestrictionsInto(win.webContents, perms);
  });

  await win.loadURL(url);
}

ipcMain.handle('login', async (_event, { email, password }) => loginWithPassword(email, password));

async function loginWithPassword(email, password) {
  try {
    const api = createApi();
    // This computer's device key vouches for the sign-in (every computer is accepted automatically).
    const device = await deviceSession.loginProof(email);
    const { data } = await api.post('/auth/login', device ? { email, password, device } : { email, password }, { _isLogin: true });
    if (!data?.token) {
      return { success: false, message: data?.message || 'Login failed' };
    }
    deviceSession.noteBound(data.device);
    await setToken(data.token);
    if (email) await rememberReportEmail(email);
    reportActivity('login');
    syncRemoteCapture();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('check-session', data);
    }
    startPresence();
    try {
      await prefetchManagedExtensions(createApi(data.token));
    } catch (err) {
      console.warn('[EXTENSIONS] Prefetch after login failed:', err.message);
    }
    schedulePrewarm();
    return { success: true, ...data };
  } catch (err) {
    const { formatApiError } = require('./apiClient');
    const code = err.response?.data?.code;
    if (code === 'APP_OUTDATED') {
      return { success: false, outdated: true, code, message: err.response.data.message, latestVersion: err.response.data.latestVersion || '' };
    }
    return {
      success: false,
      code: code || '',
      message:
        err.response?.data?.message ||
        err.friendlyMessage ||
        formatApiError(err) ||
        err.message ||
        'Login failed',
      isBanned: Boolean(err.response?.data?.isBanned)
    };
  }
}

ipcMain.handle('report-chrome', async (_event, open) => {
  if (!tabManager) return false;
  tabManager.tabBarHeight = open ? 208 : 40;
  tabManager.handleResize();
  return true;
});

ipcMain.handle('send-screen-report', async (_event, payload) => {
  try {
    const token = await getToken();
    const claims = decodeJwtPayload(token) || {};
    const s = await getStore();
    let email = '';
    if (typeof payload?.email === 'string') {
      email = payload.email.trim();
      if (email) {
        await rememberReportEmail(email);
        syncRemoteCapture();
      }
    } else {
      email = String(claims.email || claims.userEmail || s.get('reportEmail') || '').trim();
    }
    return await sendScreenReport({
      message: payload?.message,
      user: {
        email,
        userId: String(claims.userId || claims.id || claims.sub || '').trim()
      }
    });
  } catch (err) {
    console.warn('[REPORT]', err.message);
    return { ok: false, message: 'Could not send the screenshot.' };
  }
});

ipcMain.handle('get-report-settings', async () => {
  const s = await getStore();
  return {
    allowRemote: captureAllowed(s),
    allowLive: liveAllowed(s),
    email: String(s.get('reportEmail') || '').trim()
  };
});

ipcMain.handle('set-report-settings', async (_event, payload) => {
  const s = await getStore();
  let emailChanged = false;
  if (typeof payload?.email === 'string' && payload.email.trim()) {
    emailChanged = await rememberReportEmail(payload.email);
  }
  if (!emailChanged) {
    const beforeRemote = captureAllowed(s);
    const beforeLive = liveAllowed(s);
    if (typeof payload?.allowRemote === 'boolean') {
      s.set('remoteCaptureSet', true);
      s.set('remoteCaptureAllowed', payload.allowRemote);
    }
    if (typeof payload?.allowLive === 'boolean') {
      s.set('liveViewSet', true);
      s.set('liveViewAllowed', payload.allowLive);
    }
    const afterRemote = captureAllowed(s);
    const afterLive = liveAllowed(s);
    if (afterRemote !== beforeRemote || afterLive !== beforeLive) {
      reportActivity('settings', { allowRemote: afterRemote, allowLive: afterLive });
    }
  }
  syncRemoteCapture();
  return {
    allowRemote: captureAllowed(s),
    allowLive: liveAllowed(s),
    email: String(s.get('reportEmail') || '').trim()
  };
});

ipcMain.handle('get-current-user', async () => {
  const token = await getToken();
  if (!token) return null;
  try {
    const api = createApi(token);
    const { data } = await api.post('/auth/check-session');
    softAuthFailures = 0;
    return data;
  } catch (err) {
    if (err.response?.data?.code === 'SESSION_REPLACED') {
      // notifySessionReplaced already fired via axios interceptor
      await setToken(null);
      return { __sessionReplaced: true };
    }
    if (err.response?.data?.code === 'APP_OUTDATED') {
      // Keep the login: once the update is installed the app continues signed in.
      return { __outdated: true, message: err.response.data.message, latestVersion: err.response.data.latestVersion || '' };
    }
    if (shouldSignOutAfter(err)) {
      await setToken(null);
      return null;
    }
    // Server unreachable / hiccup: keep the saved login, the dashboard retries.
    console.warn('[SESSION] Check failed, keeping login:', err.response?.status || err.message);
    return {
      __unreachable: true,
      message: 'Cannot reach the Dat Desk server right now. Check your internet connection.'
    };
  }
});

ipcMain.handle('logout', async () => {
  proxyUnlockToken = '';
  deviceSession.forget();
  await markDatClosed('logout');
  await reportActivity('logout');
  stopDatSessionWatchdog();
  await deviceSync.sendOffline();
  deviceSync.stop();
  await cancelPrewarm();
  await setToken(null);
  loginHandlers.clear();
  closeAllCustomWindows();
  destroyDatWindow();
  refreshTray();
  return true;
});

ipcMain.handle('open-dat', async () => {
  reportActivity('open_dat', { source: 'button' });
  const result = await openDatFlow();
  if (result?.message === 'DAT already open') {
    reportActivity('open_dat', { source: 'button', result: 'already_open' });
  } else if (!result?.success && result?.message !== 'Already opening DAT') {
    reportActivity('open_dat', {
      source: 'button',
      result: result?.cancelled ? 'cancelled' : result?.code === 'NON_US_TIMEZONE' ? 'timezone' : 'failed'
    });
  }
  deviceSync.beatNow().catch(() => {});
  return result;
});

/** Shared Open-DAT flow used by the renderer button and the tray menu. */
async function openDatFlow() {
  if (opening) {
    if (datWindow && !datWindow.isDestroyed()) datWindow.focus();
    return { success: false, message: 'Already opening DAT' };
  }
  if (datWindow && !datWindow.isDestroyed()) {
    lastSurface = 'dat';
    if (datWindow.isMinimized()) datWindow.restore();
    datWindow.show();
    datWindow.focus();
    refreshTray();
    return { success: true, message: 'DAT already open' };
  }

  // Gate: the PC must be on a US time zone before opening DAT. DAT only works from the US,
  // and a non-US PC clock/zone makes login cookies look expired (skew logouts). Tell the
  // user to switch their Windows time zone to a US one and try again.
  const tzCheck = usTimezoneCheck();
  if (!tzCheck.ok) {
    return {
      success: false,
      code: 'NON_US_TIMEZONE',
      message:
        `Your PC time zone is "${tzCheck.timezone}", which is not a US time zone. ` +
        'Open Windows Settings → Time & language → Date & time, set the time zone to a US ' +
        'zone (e.g. Eastern/Central/Mountain/Pacific), turn on "Set time automatically", ' +
        'then press Open DAT again.'
    };
  }

  opening = true;
  // Step durations, logged on every open — shows where a slow open spends its time.
  const timings = {
    last: Date.now(),
    start: Date.now(),
    steps: {},
    mark(name) {
      const now = Date.now();
      this.steps[name] = now - this.last;
      this.last = now;
    }
  };
  let win = null;
  try {
    // Window first: everything below runs behind its loading screen.
    datLoadingMessage = 'Checking your account…';
    win = createDatShell();
    const isCancelled = () => win.isDestroyed() || datWindow !== win;
    timings.mark('window');
    await cancelPrewarm(); // never share the partition with a warm-up in progress
    timings.mark('prewarmCancel');
    const {
      user,
      proxy,
      cookiesData,
      blockTrackers,
      replaceProfile,
      keepSession,
      userId,
      sessionPush,
      cookieId,
      appliedExp,
      userAgent,
      fingerprint
    } = await resolveSessionAssets();
    timings.mark('backend');
    if (isCancelled()) throw openCancelled();
    await openDatWindow({
      domain: user.domain || 'https://one.dat.com/search-loads',
      proxy,
      cookiesData,
      permissions: user.permissions || {},
      blockTrackers,
      replaceProfile,
      keepSession,
      userId,
      sessionPush,
      cookieId,
      appliedExp,
      userAgent,
      fingerprint,
      timings,
      isCancelled
    });
    console.log('[OPEN_DAT] Timings ms:', { ...timings.steps, total: Date.now() - timings.start });
    return { success: true };
  } catch (err) {
    if (err.cancelled || (win && win.isDestroyed())) {
      console.log('[OPEN_DAT] Cancelled — DAT window closed while opening');
      return { success: false, cancelled: true };
    }
    console.error('[OPEN_DAT]', err);
    // Open failed → really close the shell (not hide to tray) and go back to
    // the dashboard, which shows the reason.
    try {
      if (win && !win.isDestroyed()) {
        datForceClose = true;
        win.close();
      }
    } catch {
      // ignore
    }
    return { success: false, message: err.message || 'Failed to open DAT' };
  } finally {
    opening = false;
  }
}

ipcMain.handle('open-custom-tab', async (_event, tab) => {
  try {
    if (!tab?.url) return { success: false, message: 'Missing tab URL' };

    if (tab.openMode === 'external') {
      await shell.openExternal(tab.url);
      return { success: true };
    }

    const { user, proxy, cookiesData, blockTrackers } = await resolveSessionAssets({
      requireOpenDat: false
    });
    const listed = (user.permissions?.customTabs || []).find(
      (t) => (tab.id && t.id === tab.id) || t.url === tab.url
    );
    if (!listed || listed.enabled === false) {
      return { success: false, message: 'This custom tab is not enabled for your account.' };
    }

    // If DAT window exists and web multitab allows, open as another Electron tab
    if (
      datWindow &&
      !datWindow.isDestroyed() &&
      tabManager &&
      currentPermissions.webMultitab
    ) {
      try {
        tabManager.createTab(currentPartition, tab.url, { title: tab.title || listed.title || 'Tab' });
        datWindow.focus();
        return { success: true };
      } catch (err) {
        console.warn('[CUSTOM_TAB] Could not add to DAT window:', err.message);
      }
    }

    await openCustomInApp({
      url: tab.url || listed.url,
      title: tab.title || listed.title,
      proxy,
      cookiesData,
      permissions: user.permissions || {},
      blockTrackers
    });
    return { success: true };
  } catch (err) {
    console.error('[CUSTOM_TAB]', err);
    return { success: false, message: err.message || 'Failed to open tab' };
  }
});

ipcMain.handle('tab:new', async () => {
  try {
    if (!tabManager || !datWindow || datWindow.isDestroyed()) {
      return { success: false, message: 'DAT window is not open' };
    }
    const canCreate = tabManager.canCreateTab();
    if (!canCreate.allowed) {
      dialog.showErrorBox(
        'Tab Limit Reached',
        canCreate.reason || 'Maximum number of tabs reached'
      );
      return { success: false, message: canCreate.reason || 'Maximum tabs reached' };
    }
    tabManager.createTab(currentPartition, currentDomain, { title: 'DAT One' });
    return { success: true };
  } catch (err) {
    dialog.showErrorBox('Tab Creation Failed', err.message || 'Cannot create new tab');
    return { success: false, message: err.message };
  }
});

ipcMain.handle('tab:switch', async (_e, tabId) => {
  tabManager?.switchToTab(tabId);
  return true;
});

ipcMain.handle('tab:close', async (_e, tabId) => {
  if (!tabManager) return false;
  const closed = tabManager.closeTab(tabId);
  if (tabManager.tabs.size === 0 && datWindowAlive()) {
    // No tabs left — fully close the DAT window (back to dashboard).
    destroyDatWindow();
  }
  return closed;
});

ipcMain.handle('tab:get-all', async () => tabManager?.getAllTabs?.() || []);

ipcMain.handle('get-user-proxy', async () => {
  try {
    const token = await getToken();
    if (!token) return { success: false, message: 'Not logged in' };
    const api = createApi(token);
    const { data } = await api.get('/user/proxy');
    return { success: true, proxy: data };
  } catch (error) {
    return {
      success: false,
      message: error.response?.data?.message || error.message || 'Failed to load proxy settings'
    };
  }
});

// Proof the staff proxy password was entered this session; the backend requires it to change the
// proxy, so a user cannot bypass proxy pinning by calling the API directly.
let proxyUnlockToken = '';

ipcMain.handle('set-user-proxy', async (_event, payload) => {
  try {
    const token = await getToken();
    if (!token) return { success: false, message: 'Not logged in' };
    if (!proxyUnlockToken) return { success: false, message: 'Enter the staff password first.' };
    const api = createApi(token);
    const { data } = await api.put('/user/proxy', payload || {}, { headers: { 'x-proxy-unlock': proxyUnlockToken } });
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        const { data: user } = await api.post('/auth/check-session');
        mainWindow.webContents.send('check-session', user);
      } catch {
        // ignore refresh failure
      }
    }
    return { success: true, proxy: data };
  } catch (error) {
    return {
      success: false,
      message: error.response?.data?.message || error.message || 'Failed to save proxy settings'
    };
  }
});

ipcMain.handle('clear-user-proxy', async () => {
  try {
    const token = await getToken();
    if (!token) return { success: false, message: 'Not logged in' };
    if (!proxyUnlockToken) return { success: false, message: 'Enter the staff password first.' };
    const api = createApi(token);
    const { data } = await api.delete('/user/proxy', { headers: { 'x-proxy-unlock': proxyUnlockToken } });
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        const { data: user } = await api.post('/auth/check-session');
        mainWindow.webContents.send('check-session', user);
      } catch {
        // ignore
      }
    }
    return { success: true, proxy: data };
  } catch (error) {
    return {
      success: false,
      message: error.response?.data?.message || error.message || 'Failed to clear proxy'
    };
  }
});

ipcMain.handle('verify-proxy-panel-password', async (_event, password) => {
  // Unlock the proxy panel AND get a short-lived token the backend requires to change the proxy.
  try {
    const api = createApi(await getToken(), { ignoreCustom: true });
    const { data } = await api.post('/user/proxy/unlock', { password: String(password || '') });
    if (data?.success && data.token) {
      proxyUnlockToken = data.token;
      return { success: true };
    }
    return { success: false, message: data?.message || 'Incorrect password' };
  } catch (error) {
    const { formatApiError } = require('./apiClient');
    return {
      success: false,
      message: error.response?.data?.message || error.friendlyMessage || formatApiError(error) || 'Unable to verify password'
    };
  }
});

ipcMain.handle('verify-server-panel-password', async (_event, password) => {
  return verifyStaffPanelViaBackend(password);
});

/**
 * Always verify staff panel password against the built-in API failover chain —
 * never the custom server override. That way a bad custom URL (e.g. bare VPS IP
 * returning HTTP 405) cannot lock you out of the panel used to fix it.
 */
async function verifyStaffPanelViaBackend(password) {
  try {
    const api = createApi(await getToken(), { ignoreCustom: true });
    const { data } = await api.post('/auth/staff-unlock', {
      password: String(password || '')
    });
    if (data?.success) return { success: true };
    return { success: false, message: data?.message || 'Incorrect password' };
  } catch (error) {
    const { formatApiError } = require('./apiClient');
    return {
      success: false,
      message:
        error.response?.data?.message ||
        error.friendlyMessage ||
        formatApiError(error) ||
        error.message ||
        'Unable to verify password'
    };
  }
}

/** Never returns the actual URL — only saved/enabled flags. */
ipcMain.handle('get-custom-server-status', async () => ({
  success: true,
  ...getCustomServerStatus()
}));

ipcMain.handle('set-custom-server', async (_event, url) => {
  try {
    const result = setCustomServerUrl(url);
    if (!result.ok) return { success: false, message: result.message };
    const s = await getStore();
    s.set('customServerUrl', getCustomServerUrl());
    s.set('customServerEnabled', true);
    return { success: true, hasSaved: result.hasSaved, enabled: result.enabled };
  } catch (error) {
    return { success: false, message: error.message || 'Failed to save server' };
  }
});

ipcMain.handle('set-custom-server-enabled', async (_event, enabled) => {
  try {
    const result = setCustomServerEnabled(Boolean(enabled));
    if (!result.ok) return { success: false, message: result.message };
    const s = await getStore();
    s.set('customServerEnabled', Boolean(result.enabled));
    return { success: true, hasSaved: result.hasSaved, enabled: result.enabled };
  } catch (error) {
    return { success: false, message: error.message || 'Failed to update server' };
  }
});

ipcMain.handle('clear-custom-server', async () => {
  try {
    clearCustomServer();
    const s = await getStore();
    s.delete('customServerUrl');
    s.delete('customServerEnabled');
    return { success: true, hasSaved: false, enabled: false };
  } catch (error) {
    return { success: false, message: error.message || 'Failed to clear server' };
  }
});

ipcMain.handle('get-extensions-status', async () => getExtensionsStatus());

ipcMain.handle('prefetch-extensions', async () => {
  try {
    const token = await getToken();
    if (!token) return { success: false, message: 'Not logged in' };
    const api = createApi(token);
    const cached = await prefetchManagedExtensions(api);
    return { success: true, cached };
  } catch (error) {
    return {
      success: false,
      message: error.message || 'Failed to prefetch extensions'
    };
  }
});

ipcMain.handle('window:minimize', async () => {
  if (datWindow && !datWindow.isDestroyed()) datWindow.minimize();
});

ipcMain.handle('window:maximize', async () => {
  if (!datWindow || datWindow.isDestroyed()) return;
  if (datWindow.isMaximized()) datWindow.unmaximize();
  else datWindow.maximize();
});

ipcMain.handle('window:close', async () => {
  // The DAT window's × hides to the system tray; DAT keeps running.
  // Ctrl+Shift+Q closes DAT and returns to the dashboard.
  // Only the tray Quit item exits the app.
  hideDatToTray();
});

ipcMain.handle('open-google-oauth', async (_event, url) => {
  try {
    if (!isGoogleOAuthUrl(url)) {
      return { success: false, message: 'Invalid Google OAuth URL' };
    }
    const result = await openGoogleOAuthPopup(url);
    return { success: Boolean(result?.ok), ...result };
  } catch (err) {
    return { success: false, message: err.message || 'Failed to open Google sign-in' };
  }
});

ipcMain.handle('open-external-url', async (_event, rawUrl) => {
  try {
    const url = String(rawUrl || '');
    if (!/^https:\/\//i.test(url)) {
      return { success: false, message: 'Invalid URL' };
    }
    await shell.openExternal(url);
    return { success: true };
  } catch (err) {
    return { success: false, message: err.message || 'Failed to open browser' };
  }
});

ipcMain.handle('verify-smtp', async (_event, config) => {
  try {
    return await verifySmtp(config || {});
  } catch (err) {
    return { ok: false, message: err.message || 'SMTP verify failed' };
  }
});

ipcMain.handle('send-smtp', async (_event, config) => {
  try {
    return await sendSmtp(config || {});
  } catch (err) {
    return { ok: false, message: err.message || 'SMTP send failed' };
  }
});

function isAppShellWindow(win) {
  if (!win || win.isDestroyed()) return false;
  if (win === datWindow || win === mainWindow) return true;
  return customWindows.has(win);
}

app.on('web-contents-created', (_event, contents) => {
  const interceptOAuth = (rawUrl, event) => {
    if (!isGoogleOAuthUrl(rawUrl)) return false;
    if (event?.preventDefault) event.preventDefault();
    openGoogleOAuthPopup(rawUrl).catch((err) => {
      console.warn('[OAUTH] Failed to open Google popup:', err.message);
    });
    return true;
  };

  contents.on('will-navigate', (event, url) => {
    if (!interceptOAuth(url, event)) return;
    try {
      const win = BrowserWindow.fromWebContents(contents);
      if (win && !isAppShellWindow(win)) {
        queueMicrotask(() => {
          try {
            if (!win.isDestroyed()) win.close();
          } catch {
            // ignore
          }
        });
      }
    } catch {
      // ignore
    }
  });
});


// Keep a single running instance — relaunching focuses the backgrounded app.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    restoreLastSurface();
  });
}

app.whenReady().then(async () => {
  if (typeof app.setName === 'function') app.setName('Dat Desk');
  registerOpenAtLogin();
  const startInTray = launchedHiddenAtStartup();
  if (startInTray) console.log('[STARTUP] PC login — staying in the tray');

  try {
    const s = await getStore();
    const saved = s.get('customServerUrl') || '';
    // Legacy: URL saved before enabled flag existed → treat as on
    const enabledFlag = s.get('customServerEnabled');
    const enabled = saved ? (enabledFlag === undefined ? true : Boolean(enabledFlag)) : false;
    const status = applyCustomServerState({ url: saved, enabled });
    // Drop bare-IP overrides that cause HTTP 405 on login
    if (status?.clearedInvalid) {
      s.delete('customServerUrl');
      s.delete('customServerEnabled');
      console.warn('[API] Cleared invalid custom server from store (bare VPS IP)');
    }
  } catch (err) {
    console.warn('[API] Failed to load custom server:', err.message);
  }

  if (!startInTray) createMainWindow();
  createTray();
  startRemoteCapture(readReportProfile, (command) => runRemoteAction(command?.type, command));
  startSuspicionWatch(readReportProfile);
  startActivityLog(readReportProfile);

  try {
    await initAutoUpdater({ isBusy: () => datWindowAlive() || opening });
  } catch (err) {
    console.warn('[UPDATE] init failed:', err.message);
  }

  globalShortcut.register('Control+Shift+P', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('toggle-proxy-panel');
    }
  });

  globalShortcut.register('Control+Shift+S', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('toggle-server-panel');
    }
  });

  // Closes the DAT window and returns to the dashboard. Does not exit the app.
  const quitRegistered = globalShortcut.register('Control+Shift+Q', () => {
    if (!datWindowAlive()) return;
    destroyDatWindow();
  });
  if (!quitRegistered) console.warn('[APP] Could not register Ctrl+Shift+Q');

  try {
    const token = await getToken();
    if (token) {
      // Already signed in from a previous run → start reporting presence now.
      startPresence();
      await prefetchManagedExtensions(createApi(token));
    }
  } catch (err) {
    console.warn('[EXTENSIONS] Prefetch on ready failed:', err.message);
  }

  if (await getToken()) schedulePrewarm();

  app.on('activate', () => {
    restoreLastSurface();
  });

  // Dev-only: automated login + Open DAT for end-to-end verification without the GUI.
  // Strictly gated on AUTO_OPEN_DAT; never runs in a normal/production launch.
  if (process.env.AUTO_OPEN_DAT === '1') {
    (async () => {
      try {
        const email = process.env.AUTO_EMAIL || '';
        const password = process.env.AUTO_PASSWORD || '';
        console.log('[AUTO] Dev auto-open starting for', email);
        const api = createApi();
        const { data } = await api.post('/auth/login', { email, password });
        if (!data?.token) throw new Error(data?.message || 'login failed');
        await setToken(data.token);
        startPresence();
        console.log('[AUTO] Logged in; opening DAT…');
        const result = await openDatFlow();
        console.log('[AUTO] openDatFlow result:', JSON.stringify(result));
      } catch (err) {
        console.error('[AUTO] Failed:', err.message);
      }
    })();
  }
});

app.on('before-quit', () => {
  appQuitting = true;
});

app.on('will-quit', () => {
  markDatClosed('quit');
  stopSuspicionWatch();
  stopRemoteCapture();
  stopDatSessionWatchdog();
  deviceSync.stop();
  deviceKey.stop();
  closeAllCustomWindows();
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  // Keep running in the tray. The app exits only from the tray Quit item.
});
