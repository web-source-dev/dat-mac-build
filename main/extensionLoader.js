'use strict';

/**
 * Download enabled Chromium extensions from the backend and load them into an
 * Electron session via session.loadExtension().
 *
 * Emits status events so the renderer can show progress (esp. in development).
 */

const fs = require('fs');
const path = require('path');
const electron = require('electron');
const AdmZip = require('adm-zip');
const { getPrimaryUrl, getBaseUrl } = require('./config');

const EXTENSION_ENDPOINTS = {
  FOR_ME: '/extension/for-me',
  DOWNLOAD: (id) => `/extension/${id}/download`
};

const MAX_LOG = 80;
/** Last enabled-extension list is reused this long by Open DAT (then refreshed in background). */
const LIST_MAX_AGE_MS = 10 * 60 * 1000;
/** @type {{ token: string, at: number, list: Array } | null} */
let listCache = null;

/** @type {{
 *  phase: string,
 *  message: string,
 *  apiBase: string,
 *  available: Array,
 *  cached: Array,
 *  loadedInSession: Array,
 *  errors: Array,
 *  log: Array<{ ts: string, level: string, message: string }>,
 *  lastUpdated: string|null
 * }} */
let status = createEmptyStatus();

/** @type {Set<(s: typeof status) => void>} */
const listeners = new Set();

function createEmptyStatus() {
  return {
    phase: 'idle',
    message: 'Not started',
    apiBase: '',
    available: [],
    cached: [],
    loadedInSession: [],
    errors: [],
    log: [],
    lastUpdated: null,
  };
}

function snapshot() {
  return JSON.parse(JSON.stringify(status));
}

function emit() {
  status.lastUpdated = new Date().toISOString();
  const snap = snapshot();
  for (const fn of listeners) {
    try { fn(snap); } catch (_) { /* ignore */ }
  }
  try {
    const { BrowserWindow } = electron;
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('extensions-status', snap);
      }
    }
  } catch (_) { /* ignore */ }
}

function pushLog(level, message) {
  const entry = { ts: new Date().toISOString(), level, message: String(message) };
  status.log.push(entry);
  if (status.log.length > MAX_LOG) status.log.splice(0, status.log.length - MAX_LOG);
  const prefix = `[EXTENSIONS]`;
  if (level === 'error') console.error(prefix, message);
  else if (level === 'warn') console.warn(prefix, message);
  else console.log(prefix, message);
}

function setPhase(phase, message) {
  status.phase = phase;
  status.message = message || phase;
  pushLog('info', message || phase);
  emit();
}

function addError(message, detail) {
  status.errors.push({ message, detail: detail || null, ts: new Date().toISOString() });
  if (status.errors.length > MAX_LOG) {
    status.errors.splice(0, status.errors.length - MAX_LOG);
  }
  pushLog('error', detail ? `${message}: ${detail}` : message);
  emit();
}

function onStatus(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function getStatus() {
  return snapshot();
}

function resetStatus() {
  status = createEmptyStatus();
  emit();
}

function getExtensionsRoot() {
  return path.join(electron.app.getPath('userData'), 'managed-extensions');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function findManifestRoot(extractDir) {
  const rootManifest = path.join(extractDir, 'manifest.json');
  if (fs.existsSync(rootManifest)) return extractDir;

  const entries = fs.readdirSync(extractDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    const candidate = path.join(extractDir, entry.name);
    if (fs.existsSync(path.join(candidate, 'manifest.json'))) {
      return candidate;
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const sub = path.join(extractDir, entry.name);
    try {
      const kids = fs.readdirSync(sub, { withFileTypes: true });
      for (const kid of kids) {
        if (!kid.isDirectory()) continue;
        const deep = path.join(sub, kid.name);
        if (fs.existsSync(path.join(deep, 'manifest.json'))) return deep;
      }
    } catch (_) { /* ignore */ }
  }

  return null;
}

function readStreamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function cacheStamp(ext) {
  const hash = String(ext.contentHash || '').replace(/[^a-fA-F0-9]/g, '');
  if (hash.length >= 8) return hash.slice(0, 16);
  const updated = String(ext.updatedAt || '').replace(/[^0-9A-Za-z]/g, '').slice(0, 16);
  return updated || 'latest';
}

function isZipBuffer(buffer) {
  return Boolean(buffer && buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b);
}

function parseDownloadError(err) {
  let detail = err?.friendlyMessage || err?.message || 'Download failed';
  if (err?.response?.data) {
    try {
      const parsed = JSON.parse(Buffer.from(err.response.data).toString());
      if (parsed?.message) detail = parsed.message;
    } catch {
      // ignore
    }
  }
  return detail;
}

async function downloadExtensionZip(api, ext) {
  const downloadUrl = EXTENSION_ENDPOINTS.DOWNLOAD(ext.id);
  const response = await api.get(downloadUrl, {
    responseType: 'arraybuffer',
    timeout: 600000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity
  });
  const buffer = Buffer.from(response.data || []);
  if (!isZipBuffer(buffer)) {
    throw new Error('Downloaded file is not a ZIP package');
  }
  return buffer;
}

function resolveApiBase(api) {
  try {
    return api?.defaults?.baseURL || getPrimaryUrl() || '';
  } catch {
    return '';
  }
}

async function fetchEnabledExtensions(api) {
  status.apiBase = resolveApiBase(api);
  setPhase('fetching', `Fetching enabled extensions from ${status.apiBase || 'API'}…`);

  let response;
  try {
    response = await api.get(EXTENSION_ENDPOINTS.FOR_ME, { timeout: 30000 });
  } catch (err) {
    const code = err.response?.status;
    if (code === 404) {
      throw new Error(
        `GET /extension/for-me returned 404 — backend may not have the extension routes deployed on ${status.apiBase}`
      );
    }
    if (code === 401) {
      throw new Error('Not authenticated (401) when fetching extensions');
    }
    const msg =
      err.response?.data?.message ||
      err.friendlyMessage ||
      err.message ||
      `HTTP ${code || 'error'}`;
    throw new Error(`Failed to list extensions: ${msg}`);
  }

  const list = response.data?.data || [];
  listCache = { token: String(extractApiToken(api) || ''), at: Date.now(), list };
  status.available = list.map((e) => ({
    id: e.id,
    name: e.name,
    slug: e.slug,
    version: e.version,
    fileSize: e.fileSize,
    updatedAt: e.updatedAt,
    contentHash: e.contentHash
  }));
  pushLog('info', `Server returned ${list.length} enabled extension(s)`);
  emit();
  return list;
}

async function ensureExtensionUnpacked(api, ext) {
  const root = getExtensionsRoot();
  const stamp = cacheStamp(ext);
  const versionDir = path.join(root, ext.slug, `${ext.version}-${stamp}`);
  const marker = path.join(versionDir, '.ready');

  if (fs.existsSync(marker)) {
    const manifestRoot = findManifestRoot(versionDir);
    if (manifestRoot) {
      pushLog('info', `Cache hit: ${ext.slug}@${ext.version} (${stamp})`);
      return manifestRoot;
    }
  }

  setPhase('downloading', `Downloading ${ext.name || ext.slug} (${ext.version})…`);

  if (fs.existsSync(versionDir)) {
    fs.rmSync(versionDir, { recursive: true, force: true });
  }
  ensureDir(versionDir);

  const zipPath = path.join(root, `${ext.slug}-${ext.version}-${stamp}.zip`);

  let buffer;
  try {
    buffer = await downloadExtensionZip(api, ext);
  } catch (err) {
    const detail = parseDownloadError(err);
    if (err.response?.status === 404) {
      throw new Error(
        `${detail}. Upload may be on a different server than Dat Desk is calling (${status.apiBase}).`
      );
    }
    throw new Error(detail);
  }

  pushLog('info', `Downloaded ${ext.slug}: ${(buffer.length / 1024).toFixed(1)} KB`);
  fs.writeFileSync(zipPath, buffer);

  setPhase('extracting', `Extracting ${ext.slug}…`);
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(versionDir, true);
  try { fs.unlinkSync(zipPath); } catch (_) { /* ignore */ }

  const manifestRoot = findManifestRoot(versionDir);
  if (!manifestRoot) {
    throw new Error(`No manifest.json found after extracting ${ext.slug}`);
  }

  fs.writeFileSync(marker, JSON.stringify({
    id: ext.id,
    slug: ext.slug,
    version: ext.version,
    contentHash: ext.contentHash || null,
    unpackedAt: new Date().toISOString(),
    path: manifestRoot,
  }));

  if (!status.cached.find((c) => c.slug === ext.slug && c.version === ext.version && c.stamp === stamp)) {
    status.cached.push({
      id: ext.id,
      slug: ext.slug,
      name: ext.name,
      version: ext.version,
      stamp,
      path: manifestRoot,
    });
  }
  emit();
  return manifestRoot;
}

async function prefetchManagedExtensions(api) {
  status.errors = [];
  try {
    const list = await fetchEnabledExtensions(api);
    if (!list.length) {
      setPhase('idle', 'No enabled extensions on server');
      return [];
    }

    setPhase('caching', `Caching ${list.length} extension(s)…`);
    const results = [];
    for (const ext of list) {
      try {
        const unpacked = await ensureExtensionUnpacked(api, ext);
        results.push({ ...ext, path: unpacked });
        pushLog('info', `Cached ${ext.slug}@${ext.version}`);
        emit();
      } catch (err) {
        addError(`Failed to cache ${ext.slug}`, err.message);
      }
    }
    setPhase(
      results.length ? 'cached' : 'error',
      results.length
        ? `Cached ${results.length}/${list.length} extension(s)`
        : 'Failed to cache any extensions'
    );
    return results;
  } catch (err) {
    addError('Prefetch failed', err.message);
    setPhase('error', err.message);
    return [];
  }
}

/**
 * Extension API for a session: `session.extensions` (Electron 36+);
 * the session itself on older builds (those methods are deprecated there).
 */
function extensionsApi(session) {
  return session?.extensions && typeof session.extensions.loadExtension === 'function'
    ? session.extensions
    : session;
}

/** Ids of extensions loaded in the session (getAllExtensions returns Extension[]). */
function loadedExtensionIds(session) {
  const exts = extensionsApi(session);
  if (!exts || typeof exts.getAllExtensions !== 'function') return [];
  const all = exts.getAllExtensions() || [];
  return (Array.isArray(all) ? all : Object.values(all)).map((e) => e?.id).filter(Boolean);
}

/**
 * Remove every extension currently loaded in this session.
 * Needed because persist: partitions keep extensions across opens.
 */
function unloadAllSessionExtensions(session) {
  const exts = extensionsApi(session);
  if (!exts || typeof exts.removeExtension !== 'function') return [];
  const removed = [];
  try {
    for (const id of loadedExtensionIds(session)) {
      try {
        exts.removeExtension(id);
        removed.push(id);
        pushLog('info', `Removed previously loaded extension ${id}`);
      } catch (err) {
        pushLog('warn', `Failed to remove extension ${id}: ${err.message}`);
      }
    }
  } catch (err) {
    pushLog('warn', `getAllExtensions during unload failed: ${err.message}`);
  }
  return removed;
}

function extractApiToken(api) {
  const headers = api?.defaults?.headers || {};
  return (
    headers.Authorization ||
    headers.authorization ||
    headers.common?.Authorization ||
    headers.common?.authorization ||
    ''
  );
}

function decodeJwtEmail(token) {
  try {
    const raw = String(token || '')
      .replace(/^Bearer\s+/i, '')
      .trim();
    const part = raw.split('.')[1];
    if (!part) return null;
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const payload = JSON.parse(json);
    const email = payload.email || payload.userEmail || null;
    return email && String(email).includes('@') ? String(email).trim() : null;
  } catch {
    return null;
  }
}

function isEmailExtension(unpackedPath, ext) {
  try {
    const manifestPath = path.join(unpackedPath, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest.datdesk_email === true) return true;
      if (/email/i.test(String(manifest.name || ''))) return true;
    }
  } catch {
    // ignore
  }
  const slug = String(ext?.slug || '').toLowerCase();
  const name = String(ext?.name || '').toLowerCase();
  return slug.includes('email') || name.includes('email');
}

function shouldInjectDeskSession(unpackedPath, ext) {
  if (isEmailExtension(unpackedPath, ext)) return true;
  try {
    return fs.existsSync(path.join(unpackedPath, 'desk_session.json'));
  } catch {
    return false;
  }
}

/**
 * Inject current desk API session into the DAT Email extension so users do not
 * need a second login (which would kick the desktop session).
 */
function injectDeskEmailSession(unpackedPath, api, ext) {
  if (!shouldInjectDeskSession(unpackedPath, ext)) return false;
  const token = String(extractApiToken(api) || '').trim();
  if (!token) {
    pushLog('warn', `Skip email session inject for ${ext?.slug || 'extension'}: no token`);
    return false;
  }
  const payload = {
    apiBase: String(api?.defaults?.baseURL || getBaseUrl() || getPrimaryUrl() || '').replace(
      /\/+$/,
      ''
    ),
    token,
    userEmail: decodeJwtEmail(token),
    source: 'desk',
    injectedAt: new Date().toISOString(),
    slug: ext?.slug || null
  };
  if (!payload.apiBase) {
    pushLog('warn', `Skip email session inject for ${ext?.slug || 'extension'}: no apiBase`);
    return false;
  }
  fs.writeFileSync(
    path.join(unpackedPath, 'desk_session.json'),
    JSON.stringify(payload, null, 2)
  );
  pushLog(
    'info',
    `Injected desk session into ${ext?.slug || 'email extension'} (${payload.userEmail || 'token only'})`
  );
  return true;
}

/**
 * What is loaded per session in this app run: { signature, records }.
 * Extensions stay loaded in a session until the app quits, so a later open
 * with the same list (and same desk token) reuses them instead of reloading.
 */
const sessionLoads = new Map();

function sessionKey(session) {
  return session?.storagePath || session;
}

/** Same extensions, versions and desk token → nothing to reload. */
function loadSignature(list, api) {
  const exts = list.map((ext) => `${ext.id}@${ext.version}-${cacheStamp(ext)}`).sort();
  return JSON.stringify({ exts, token: String(extractApiToken(api) || '') });
}

function stillLoaded(session, records) {
  try {
    const ids = new Set(loadedExtensionIds(session));
    return records.every((r) => r.extensionId && ids.has(r.extensionId));
  } catch {
    return false;
  }
}

/**
 * Enabled list for Open DAT without waiting on the server: a recent list (same desk
 * login) is used right away and refreshed in the background, so a change made by an
 * admin applies on the next open.
 */
async function getEnabledExtensionsFast(api) {
  const token = String(extractApiToken(api) || '');
  if (listCache && listCache.token === token && Date.now() - listCache.at < LIST_MAX_AGE_MS) {
    const { list } = listCache;
    pushLog('info', `Using extension list from ${Math.round((Date.now() - listCache.at) / 1000)}s ago`);
    fetchEnabledExtensions(api).catch((err) => {
      pushLog('warn', `Background extension list refresh failed: ${err.message}`);
    });
    return list;
  }
  return fetchEnabledExtensions(api);
}

/**
 * Load all enabled managed extensions into the given Electron session.
 * Reuses what is already loaded when the enabled list is unchanged; otherwise
 * clears previously loaded extensions first so disable takes effect.
 */
async function loadManagedExtensionsIntoSession(session, api) {
  status.errors = [];

  const exts = extensionsApi(session);
  if (!exts || typeof exts.loadExtension !== 'function') {
    addError('session.loadExtension is not available in this Electron build');
    setPhase('error', 'loadExtension unavailable');
    return [];
  }

  const key = sessionKey(session);
  const previous = sessionLoads.get(key);

  let list;
  try {
    list = await getEnabledExtensionsFast(api);
  } catch (err) {
    addError('Could not fetch extension list', err.message);
    if (previous && stillLoaded(session, previous.records)) {
      setPhase('loaded', 'Could not refresh extension list — keeping loaded extensions');
      return previous.records;
    }
    setPhase('error', err.message);
    return [];
  }

  const signature = loadSignature(list, api);
  if (previous && previous.signature === signature && stillLoaded(session, previous.records)) {
    status.loadedInSession = [...previous.records];
    setPhase(
      list.length ? 'loaded' : 'idle',
      list.length
        ? `Reusing ${previous.records.length} extension(s) already loaded in DAT session`
        : 'No enabled extensions to load'
    );
    return previous.records;
  }

  // List changed (or first open this run): drop what this persist: partition has loaded
  status.loadedInSession = [];
  sessionLoads.delete(key);
  const removed = unloadAllSessionExtensions(session);
  if (removed.length) {
    pushLog('info', `Cleared ${removed.length} previously loaded extension(s) from session`);
    emit();
  }

  if (!list.length) {
    sessionLoads.set(key, { signature, records: [] });
    setPhase('idle', 'No enabled extensions to load');
    emit();
    return [];
  }

  setPhase('loading', `Loading ${list.length} extension(s) into DAT session…`);
  const loaded = [];

  for (const ext of list) {
    try {
      const unpackedPath = await ensureExtensionUnpacked(api, ext);
      try {
        injectDeskEmailSession(unpackedPath, api, ext);
      } catch (err) {
        pushLog('warn', `Email session inject failed for ${ext.slug}: ${err.message}`);
      }
      pushLog('info', `Calling loadExtension(${unpackedPath})`);
      const info = await exts.loadExtension(unpackedPath, { allowFileAccess: true });
      const record = {
        id: ext.id,
        slug: ext.slug,
        version: ext.version,
        name: info?.name || ext.name,
        extensionId: info?.id || null,
        path: unpackedPath,
      };
      loaded.push(record);
      status.loadedInSession = [...loaded];
      pushLog('info', `Loaded ${ext.slug}@${ext.version} → id=${info?.id}`);
      emit();
    } catch (err) {
      addError(`Failed to load ${ext.slug}`, err.message);
    }
  }

  // Cross-check Chromium's view of loaded extensions
  try {
    const ids = loadedExtensionIds(session);
    pushLog('info', `session.getAllExtensions(): ${ids.length ? ids.join(', ') : '(none)'}`);
  } catch (err) {
    pushLog('warn', `getAllExtensions failed: ${err.message}`);
  }

  // Remember only a complete load; a partial one retries on the next open.
  if (loaded.length === list.length) {
    sessionLoads.set(key, { signature, records: loaded });
  }

  setPhase(
    loaded.length ? 'loaded' : 'error',
    loaded.length
      ? `Loaded ${loaded.length}/${list.length} into DAT session`
      : 'No extensions loaded into session'
  );
  return loaded;
}

module.exports = {
  prefetchManagedExtensions,
  loadManagedExtensionsIntoSession,
  fetchEnabledExtensions,
  getExtensionsRoot,
  getStatus,
  onStatus,
  resetStatus,
  decodeJwtEmail
};
