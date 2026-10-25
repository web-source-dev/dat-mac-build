'use strict';

/**
 * Proof that API calls come from THIS computer, with the login it was given.
 *
 *  - Session key: a P-256 key pair made in memory for each app run (never written to disk).
 *    Every backend request is signed with it over method, path, body hash, login token, time
 *    and a single-use nonce. A copied token, a captured request or a script gets refused.
 *  - Device key (deviceKey.js, TPM / Windows key store): binds the session key to the login,
 *    at sign-in and again every ~30 min ("rebind"), each time with a brand-new session key.
 *
 * The backend answers with codes this module and apiClient react to (see backend
 * services/deviceTrust.js): DEVICE_REBIND, DEVICE_UNKNOWN, SESSION_BOUND_ELSEWHERE, APP_NOT_LIVE…
 * Every computer is accepted automatically; there is no admin approval step.
 */

const crypto = require('crypto');
const axios = require('axios');
const deviceKey = require('./deviceKey');
const { getIdentity } = require('./clientIdentity');
const { serverNow } = require('./authUtils');

let session = null;
let bound = null;
let bindPromise = null;
let rebindTimer = null;
let lastStatus = null;

function sha256hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function newSessionKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return { privateKey, pub: der.toString('base64'), kid: sha256hex(der) };
}

function currentSession() {
  if (!session) session = newSessionKey();
  return session;
}

function nonce() {
  return crypto.randomBytes(18).toString('base64url');
}

/**
 * Proof for POST /auth/login: the device key vouches for this run's session key and the email.
 * Returns null when the device key cannot be used (non-Windows, key store broken) — the server
 * then decides whether a sign-in without a device key is allowed.
 */
async function loginProof(email) {
  if (!deviceKey.available()) return null;
  try {
    const dev = await deviceKey.ready();
    const id = await getIdentity();
    session = newSessionKey();
    const ts = String(Math.round(serverNow()));
    const n = nonce();
    const data = ['enroll-v2', dev.kid, session.kid, String(email || '').trim().toLowerCase(), id.hwId, ts, n].join('\n');
    return {
      publicKey: dev.publicKey,
      storage: dev.storage,
      sessionPub: session.pub,
      ts,
      nonce: n,
      sig: await deviceKey.sign(data)
    };
  } catch (err) {
    console.warn('[DEVICE] sign-in proof failed:', err.message);
    return null;
  }
}

/** The login response carried { device: { bindExpiresAt, rebindInMs, … } }. */
function noteBound(device) {
  if (!device) return;
  bound = { ...device, at: Date.now() };
  lastStatus = device.status || 'bound';
  scheduleRebind(device.rebindInMs);
}

function scheduleRebind(ms) {
  clearTimeout(rebindTimer);
  const wait = Math.max(60 * 1000, Number(ms) || 25 * 60 * 1000);
  rebindTimer = setTimeout(() => {
    if (tokenProvider) {
      tokenProvider()
        .then((token) => (token ? bind(token).catch(() => {}) : null))
        .catch(() => {});
    }
  }, wait);
  rebindTimer.unref?.();
}

let tokenProvider = null;
let baseUrlProvider = null;

/** index.js wires these: the saved login token and the backend URL in use. */
function configure({ getToken, getBaseUrl }) {
  tokenProvider = getToken || tokenProvider;
  baseUrlProvider = getBaseUrl || baseUrlProvider;
}

/**
 * POST /device/bind with a fresh session key. Resolves with the server answer; rejects with the
 * axios error (its response.data.code says why: DEVICE_KEY_REQUIRED, SESSION_BOUND_ELSEWHERE…).
 * Concurrent callers share one bind.
 */
function bind(token) {
  if (bindPromise) return bindPromise;
  bindPromise = (async () => {
    if (!deviceKey.available()) throw new Error('device key unavailable');
    const dev = await deviceKey.ready();
    const id = await getIdentity();
    const next = newSessionKey();
    const ts = String(Math.round(serverNow()));
    const n = nonce();
    const auth = String(token || '');
    const data = ['bind-v2', dev.kid, next.kid, auth ? sha256hex(auth) : '', id.hwId, ts, n].join('\n');
    const body = { publicKey: dev.publicKey, storage: dev.storage, sessionPub: next.pub, ts, nonce: n, sig: await deviceKey.sign(data) };
    // Lazy: apiClient requires this module.
    const { createApi } = require('./apiClient');
    try {
      const { data: res } = await createApi(token).post('/device/bind', body, { _deviceRetry: true, _isBind: true });
      session = next;
      noteBound(res);
      return res;
    } catch (err) {
      const code = err.response?.data?.code;
      // A refused bind keeps the old session key: nothing changed on the server.
      throw err;
    }
  })().finally(() => {
    bindPromise = null;
  });
  return bindPromise;
}

/** Wait for a bind in progress, so requests are not signed with a key about to be replaced. */
async function settled() {
  if (bindPromise) await bindPromise.catch(() => {});
}

function bodyBytes(config) {
  const data = config.data;
  if (data == null || data === '') return Buffer.alloc(0);
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (data instanceof URLSearchParams) {
    const text = data.toString();
    config.data = text;
    config.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    return Buffer.from(text, 'utf8');
  }
  if (typeof data === 'object' && (Object.getPrototypeOf(data) === Object.prototype || Array.isArray(data))) {
    // Serialize here, so the bytes we hash are exactly the bytes axios sends.
    const text = JSON.stringify(data);
    config.data = text;
    config.headers['Content-Type'] = 'application/json';
    return Buffer.from(text, 'utf8');
  }
  return null;
}

/** Add X-Dev-* headers (session-key signature) to an axios request config. */
async function signRequest(config) {
  if (!config._isBind) await settled();
  if (!deviceKey.available()) return config;
  let dev;
  try {
    dev = await deviceKey.ready();
  } catch {
    return config;
  }
  config.headers = config.headers || {};
  const body = bodyBytes(config);
  if (!body) return config; // streams/FormData: not signable — the server decides
  const key = currentSession();
  let path;
  try {
    const full = new URL(axios.getUri(config));
    path = full.pathname + full.search;
  } catch {
    return config;
  }
  const auth = String(config.headers.Authorization || config.headers.authorization || '');
  const ts = String(Math.round(serverNow()));
  const n = nonce();
  const base = ['v2', ts, n, String(config.method || 'get').toUpperCase(), path, sha256hex(body), auth ? sha256hex(auth) : '', dev.kid].join('\n');
  const sig = crypto.sign('sha256', Buffer.from(base, 'utf8'), { key: key.privateKey, dsaEncoding: 'ieee-p1363' });
  config.headers['X-Dev-Kid'] = dev.kid;
  config.headers['X-Dev-Ts'] = ts;
  config.headers['X-Dev-Nonce'] = n;
  config.headers['X-Dev-Path'] = path;
  config.headers['X-Dev-Sig'] = sig.toString('base64url');
  return config;
}

/** Short code for this computer's device key (same code the admin sees in the device list). */
async function deviceCode() {
  try {
    const dev = await deviceKey.ready();
    const s = dev.kid.slice(0, 8).toUpperCase();
    return { code: `${s.slice(0, 4)}-${s.slice(4)}`, storage: dev.storage };
  } catch {
    return { code: '', storage: '' };
  }
}

function forget() {
  clearTimeout(rebindTimer);
  bound = null;
  lastStatus = null;
  session = null;
}

function status() {
  return { bound, lastStatus };
}

// Open/create the key at start so the first sign-in does not wait for the TPM.
if (deviceKey.available()) deviceKey.ready().catch((err) => console.warn('[DEVICE] key not ready:', err.message));

module.exports = { loginProof, noteBound, bind, signRequest, configure, deviceCode, forget, status, settled };
