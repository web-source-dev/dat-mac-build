'use strict';

/**
 * Disk cache for GET /cookie/active so Dat Desk can honor 304 Not Modified
 * and skip re-downloading the same DAT session JSON.
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function cacheFilePath() {
  return path.join(app.getPath('userData'), 'cookie-active-cache.json');
}

function sessionStampPath() {
  return path.join(app.getPath('userData'), 'dat-session-push.json');
}

/**
 * What the DAT partition holds now: whose session (userId), which server cookie it
 * came from (cookieId) and the session-push counter it reflects (applied). The
 * partition is shared by every desk user on this PC, so the stamp says who owns it.
 * Old stamps have no userId → treated as another user's (profile replaced once).
 */
function readSessionStamp() {
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionStampPath(), 'utf8'));
    const applied = Number(parsed?.applied);
    const appliedExp = Number(parsed?.appliedExp);
    return {
      userId: parsed?.userId ? String(parsed.userId) : '',
      applied: Number.isFinite(applied) ? applied : 0,
      cookieId: parsed?.cookieId ? String(parsed.cookieId) : '',
      // Auth0 expiry (ms epoch) of the session this device currently runs — used to auto-
      // adopt a backend copy only when it is genuinely newer than what we already have.
      appliedExp: Number.isFinite(appliedExp) ? appliedExp : 0
    };
  } catch {
    return { userId: '', applied: 0, cookieId: '', appliedExp: 0 };
  }
}

function writeSessionStamp({ userId, applied, cookieId, appliedExp }) {
  const target = sessionStampPath();
  try {
    fs.writeFileSync(
      target,
      JSON.stringify({
        userId: userId ? String(userId) : '',
        applied: Number(applied) || 0,
        cookieId: cookieId ? String(cookieId) : '',
        appliedExp: Number(appliedExp) || 0,
        savedAt: new Date().toISOString()
      })
    );
  } catch (err) {
    console.warn('[DAT_SESSION] could not record profile refresh:', err.message);
  }
}

function normalizeEtag(value) {
  return String(value || '')
    .trim()
    .replace(/^W\//i, '')
    .trim()
    .replace(/^"/, '')
    .replace(/"$/, '');
}

function quoteEtag(value) {
  const token = normalizeEtag(value);
  if (!token) return '';
  return `"${token}"`;
}

function isUsablePayload(payload) {
  return Array.isArray(payload?.['dat.com']?.cookies) && payload['dat.com'].cookies.length > 0;
}

/** The cached payload, only if it was fetched for this desk user. */
function readCookieCache(userId = '') {
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFilePath(), 'utf8'));
    const etag = quoteEtag(parsed?.etag);
    if (!etag || !isUsablePayload(parsed?.payload)) return null;
    if (String(parsed?.userId || '') !== String(userId || '')) return null;
    return {
      etag,
      payload: parsed.payload
    };
  } catch {
    return null;
  }
}

function writeCookieCache(etag, payload, userId = '') {
  const quoted = quoteEtag(etag);
  if (!quoted || !isUsablePayload(payload)) return;
  const target = cacheFilePath();
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(
      tmp,
      JSON.stringify({
        userId: userId ? String(userId) : '',
        etag: quoted,
        cookieId: payload.cookieId || null,
        payload,
        savedAt: new Date().toISOString()
      })
    );
    try {
      if (fs.existsSync(target)) fs.unlinkSync(target);
    } catch {
      // Windows: replace below may still succeed
    }
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.writeFileSync(
        target,
        JSON.stringify({
          userId: userId ? String(userId) : '',
          etag: quoted,
          cookieId: payload.cookieId || null,
          payload,
          savedAt: new Date().toISOString()
        })
      );
    } catch (writeErr) {
      console.warn('[COOKIE] cache write failed:', writeErr.message || err.message);
    }
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
  }
}

function responseEtag(headers) {
  if (!headers) return '';
  return quoteEtag(headers.etag || headers.ETag || '');
}

function cookieRequestHeaders(extra = {}) {
  return {
    Accept: 'application/json',
    'Accept-Encoding': 'gzip, deflate',
    ...extra
  };
}

async function getCookieActive(api, extraHeaders = {}) {
  return api.get('/cookie/active', {
    headers: cookieRequestHeaders(extraHeaders),
    timeout: 120000,
    decompress: true,
    validateStatus: (status) => status === 304 || (status >= 200 && status < 300)
  });
}

/**
 * @param {{ bypassCache?: boolean, userId?: string }} [options] bypassCache skips If-None-Match so
 *   the server always returns the full current payload (used when recovering a dead DAT session).
 *   userId keys the disk cache, so another desk user on this PC never gets this user's copy.
 */
async function fetchActiveCookie(api, { bypassCache = false, userId = '' } = {}) {
  const cached = bypassCache ? null : readCookieCache(userId);
  const extra = {};
  if (cached?.etag) extra['If-None-Match'] = cached.etag;

  const res = await getCookieActive(api, extra);

  if (res.status === 304) {
    if (cached && isUsablePayload(cached.payload)) {
      console.log('[COOKIE] 304 Not Modified — using disk cache');
      return cached.payload;
    }
    console.warn('[COOKIE] 304 without a usable local cache — refetching full payload');
    const retry = await getCookieActive(api);
    const etag = responseEtag(retry.headers);
    if (etag) writeCookieCache(etag, retry.data, userId);
    return retry.data;
  }

  if (!isUsablePayload(res.data)) {
    return res.data;
  }

  const etag = responseEtag(res.headers);
  if (etag) writeCookieCache(etag, res.data, userId);
  else console.warn('[COOKIE] /cookie/active response had no ETag — cache not stored');

  return res.data;
}

/** Drop the saved DAT session file so the next Open DAT downloads a fresh copy. */
function clearCookieCache() {
  for (const target of [cacheFilePath(), sessionStampPath()]) {
    try {
      fs.unlinkSync(target);
    } catch {
      // already gone
    }
  }
}

module.exports = {
  fetchActiveCookie,
  readCookieCache,
  writeCookieCache,
  readSessionStamp,
  writeSessionStamp,
  clearCookieCache
};
