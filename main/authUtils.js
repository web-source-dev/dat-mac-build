/**
 * Lightweight JWT helpers (no jsonwebtoken dependency).
 * Used by the main-process DAT session watchdog — same idea as DATGO authUtils.
 */

function decodeJwtPayload(token) {
  if (!token || typeof token !== 'string') return null;
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/** Server clock minus this PC's clock, from the last backend reply that carried it. */
let clockOffsetMs = 0;

/** Record the backend's time (ms since epoch, or a Date header string). Returns the offset. */
function noteServerTime(serverTime) {
  const ms = typeof serverTime === 'number' ? serverTime : Date.parse(serverTime || '');
  if (!Number.isFinite(ms) || ms <= 0) return clockOffsetMs;
  clockOffsetMs = ms - Date.now();
  return clockOffsetMs;
}

/** Date.now() corrected to the backend's clock, so a wrong PC clock cannot expire tokens early. */
function serverNow() {
  return Date.now() + clockOffsetMs;
}

function getClockOffsetMs() {
  return clockOffsetMs;
}

/** True when token is missing, malformed, or expired (with 5-minute buffer). */
function isTokenExpired(token) {
  if (!token) return true;
  const decoded = decodeJwtPayload(token);
  if (!decoded || !decoded.exp) return true;
  const currentTime = Math.floor(serverNow() / 1000);
  const bufferTime = 300;
  return decoded.exp - bufferTime < currentTime;
}

function getTokenExpiration(token) {
  const decoded = decodeJwtPayload(token);
  if (!decoded?.exp) return null;
  return new Date(decoded.exp * 1000);
}

/** Backend codes that always mean the desk session is over. */
const FATAL_AUTH_CODES = new Set([
  'SESSION_REPLACED',
  'TOKEN_EXPIRED',
  'BANNED',
  'USER_NOT_FOUND',
  // Device keys: the login was copied to another computer, or this one sent no device key.
  'SESSION_BOUND_ELSEWHERE',
  'DEVICE_KEY_REQUIRED'
]);

/**
 * Sort a failed session check:
 *  - 'fatal'     the backend definitely rejected this session → sign out now
 *  - 'soft'      a 401 without a definite reason (e.g. INVALID_TOKEN when the
 *                verifying hop timed out) → sign out only if it repeats
 *  - 'transient' network error, timeout, 5xx, a 403 from a proxy/CDN… → keep the session
 */
function classifyAuthError(err) {
  const res = err?.response;
  if (!res) return 'transient';
  const code = res.data?.code;
  if (FATAL_AUTH_CODES.has(code) || res.data?.isBanned) return 'fatal';
  if (res.status === 401) return 'soft';
  return 'transient';
}

/** Consecutive 'soft' failures needed before signing out. */
const SOFT_AUTH_FAILURE_LIMIT = 2;

module.exports = {
  decodeJwtPayload,
  noteServerTime,
  serverNow,
  getClockOffsetMs,
  isTokenExpired,
  getTokenExpiration,
  classifyAuthError,
  SOFT_AUTH_FAILURE_LIMIT
};
