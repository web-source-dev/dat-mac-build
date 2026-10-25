'use strict';

/**
 * Axios client with main → primary → backup failover for Dat Desk.
 * Cookies come from MongoDB on whichever backend answers (shared DB).
 * Update packages are tunnelled to the VPS when a backup is used.
 */

const axios = require('axios');
const {
  getCandidateUrls,
  getPrimaryUrl,
  setActiveBaseUrl,
  isCustomServerEnabled
} = require('./config');
const { signRequest } = require('./clientIdentity');
const deviceSession = require('./deviceSession');
const { noteServerTime } = require('./authUtils');
const { agent: pinnedAgent } = require('./tlsPin');

let onSessionReplaced = null;
let onOutdated = null;
let beatNow = null;

function setSessionReplacedHandler(fn) {
  onSessionReplaced = typeof fn === 'function' ? fn : null;
}

/** index.js: send a heartbeat on demand (APP_NOT_LIVE), update (APP_OUTDATED). */
function setDeviceHandlers({ beat, outdated } = {}) {
  if (typeof beat === 'function') beatNow = beat;
  if (typeof outdated === 'function') onOutdated = outdated;
}

/** Device-key answers that one bind / beat / clock fix and a retry can cure. */
const DEVICE_REBIND_CODES = new Set(['DEVICE_REBIND', 'DEVICE_UNKNOWN', 'DEVICE_BAD_SIGNATURE', 'DEVICE_REPLAY']);
/** This computer may not use the account: end the desk session. */
const DEVICE_FATAL_CODES = new Set(['SESSION_BOUND_ELSEWHERE', 'DEVICE_KEY_REQUIRED']);

function deviceActionFrom(response) {
  return String(response?.headers?.['x-device-action'] || '');
}

/** Monitor mode: the server only hints (X-Device-Action) — act on it in the background. */
function followDeviceHint(response) {
  // A newer release exists (report mode): let the updater fetch it now.
  if (response?.headers?.['x-latest-version'] && onOutdated) onOutdated({ soft: true, latestVersion: response.headers['x-latest-version'] });
  const action = deviceActionFrom(response);
  if (!action) return;
  const token = response.config?.headers?.Authorization || response.config?.headers?.authorization;
  if (!token || response.config?._isBind) return;
  if (DEVICE_REBIND_CODES.has(action)) deviceSession.bind(String(token)).catch(() => {});
  else if (action === 'APP_NOT_LIVE' && beatNow) Promise.resolve(beatNow()).catch(() => {});
}

function isSuccessStatus(status) {
  return status === 304 || (status >= 200 && status < 300);
}

function shouldFailover(error) {
  if (!error.response) return true;
  const status = error.response.status;
  if (isSuccessStatus(status)) return false;
  // 404/405 often mean wrong host (nginx default / static site) — try next backend.
  return [404, 405, 408, 502, 503, 504, 521, 522, 524].includes(status);
}

function formatApiError(error) {
  const status = error.response?.status;
  const serverMsg = error.response?.data?.message;
  if (serverMsg) return serverMsg;
  if (status === 405) {
    return isCustomServerEnabled()
      ? 'Your server is not reachable at the custom URL.'
      : 'Server returned 405 Method Not Allowed. Check the API URL (do not use the raw VPS IP).';
  }
  if (status === 404) {
    return isCustomServerEnabled()
      ? 'Your server is not reachable at the custom URL.'
      : error.message || 'API route not found';
  }
  return error.message || 'Request failed';
}

/**
 * @param {string} [token]
 * @param {{ ignoreCustom?: boolean }} [opts] — staff unlock uses ignoreCustom so a bad
 *   custom URL cannot lock you out of the server panel.
 */
function createApi(token, opts = {}) {
  const ignoreCustom = Boolean(opts.ignoreCustom);
  const api = axios.create({
    baseURL: getPrimaryUrl({ ignoreCustom }),
    headers: token ? { Authorization: token } : {},
    timeout: 30000,
    decompress: true,
    // Refuses servers whose certificate chain is not rooted in the app's built-in public roots.
    httpsAgent: pinnedAgent,
    validateStatus: isSuccessStatus
  });

  api.interceptors.request.use((config) => {
    const urls = getCandidateUrls({ ignoreCustom });
    if (config._failoverIndex == null) config._failoverIndex = 0;
    config.baseURL = urls[config._failoverIndex] || urls[0] || getPrimaryUrl({ ignoreCustom });
    if (token) {
      config.headers = config.headers || {};
      if (!config.headers.Authorization) config.headers.Authorization = token;
    }
    // Device ID + signature: lets the backend tell this app from a script reusing the token.
    // Then the per-run session-key signature that ties the request to this computer.
    return signRequest(config).then((signed) => deviceSession.signRequest(signed));
  });

  api.interceptors.response.use(
    (response) => {
      // Track the backend clock: check-session/login send serverTime; any reply has a Date header.
      const serverTime = response.data?.serverTime ?? response.headers?.date;
      if (serverTime) noteServerTime(serverTime);
      if (!ignoreCustom && response.config?.baseURL) {
        setActiveBaseUrl(response.config.baseURL);
      }
      followDeviceHint(response);
      return response;
    },
    async (error) => {
      const status = error.response?.status;
      if (status === 304 && error.response) {
        return error.response;
      }
      const code = error.response?.data?.code;
      if (error.response?.data?.serverTime) noteServerTime(error.response.data.serverTime);
      else if (error.response?.headers?.date) noteServerTime(error.response.headers.date);
      if (status === 401 && code === 'SESSION_REPLACED') {
        if (onSessionReplaced) onSessionReplaced(error.response?.data?.message, error.response?.data);
        return Promise.reject(error);
      }
      if (code === 'APP_OUTDATED') {
        // This version is too old: the backend refuses it until the app updates.
        if (onOutdated) onOutdated(error.response.data);
        error.friendlyMessage = error.response.data?.message || 'Please update the app.';
        return Promise.reject(error);
      }

      const failed = error.config || {};
      if (status === 403 && code && !failed._deviceRetry) {
        const auth = String(failed.headers?.Authorization || failed.headers?.authorization || token || '');
        try {
          if (DEVICE_REBIND_CODES.has(code) && auth) {
            await deviceSession.bind(auth);
            return await api.request({ ...failed, _deviceRetry: true });
          }
          if (code === 'DEVICE_CLOCK') {
            return await api.request({ ...failed, _deviceRetry: true });
          }
          if (code === 'APP_NOT_LIVE' && beatNow) {
            await beatNow();
            return await api.request({ ...failed, _deviceRetry: true });
          }
        } catch (retryError) {
          error = retryError;
        }
      }
      const finalCode = error.response?.data?.code;
      if (failed._isLogin) {
        // The sign-in screen shows these itself.
      } else if (DEVICE_FATAL_CODES.has(finalCode) && onSessionReplaced) {
        deviceSession.forget();
        onSessionReplaced(error.response.data.message, { closeDat: true, device: finalCode });
      }
      if (/^(DEVICE_|APP_NOT_LIVE$|SESSION_BOUND_ELSEWHERE$)/.test(String(finalCode || ''))) {
        error.friendlyMessage = error.response?.data?.message || formatApiError(error);
        return Promise.reject(error);
      }

      const originalRequest = error.config || {};
      if (originalRequest._isFailoverRetry) {
        error.friendlyMessage = formatApiError(error);
        return Promise.reject(error);
      }
      if (!shouldFailover(error)) {
        error.friendlyMessage = formatApiError(error);
        return Promise.reject(error);
      }

      const urls = getCandidateUrls({ ignoreCustom });
      let index = originalRequest._failoverIndex ?? 0;

      while (index < urls.length - 1) {
        const failedUrl = urls[index];
        index += 1;
        const nextUrl = urls[index];
        console.warn(`[API] Failed on ${failedUrl}. Retrying on ${nextUrl}`);

        try {
          const response = await api.request({
            ...originalRequest,
            baseURL: nextUrl,
            _failoverIndex: index,
            _isFailoverRetry: true
          });
          if (!ignoreCustom) setActiveBaseUrl(nextUrl);
          console.log(`[API] Failover succeeded on ${nextUrl}`);
          return response;
        } catch (retryError) {
          if (!shouldFailover(retryError)) {
            retryError.friendlyMessage = formatApiError(retryError);
            return Promise.reject(retryError);
          }
          error = retryError;
        }
      }

      console.error('[API] All backends failed:', urls.join(' → '));
      error.friendlyMessage = formatApiError(error);
      return Promise.reject(error);
    }
  );

  return api;
}

module.exports = {
  createApi,
  formatApiError,
  setSessionReplacedHandler,
  setDeviceHandlers,
  isSuccessStatus
};
