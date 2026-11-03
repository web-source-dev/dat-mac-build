'use strict';

/**
 * Per-session network hooks for DAT partitions:
 *  - blocks DAT's analytics / session-recording / onboarding / support-chat scripts
 *    (none are needed to search loads; measured: -68% bytes on reopen, ~19% less
 *    main-thread work on slow CPUs, ~10 MB less memory)
 *  - records network activity per webContents, so a slow-but-progressing load is
 *    not mistaken for a stuck one. Electron has no per-chunk event, so a response
 *    that has started but not finished counts as "still downloading".
 *
 *  - records requests sent but not answered yet, so a stuck connection can be seen
 *  - records how long DAT's own requests wait for their answer, so the connection speed
 *    shown in the toolbar is measured without sending any extra request
 *
 * Electron allows one listener per webRequest event per session; this module owns
 * onBeforeRequest, onSendHeaders, onResponseStarted, onCompleted and onErrorOccurred
 * for the sessions it is applied to.
 */

const DAT_TRACKER_PATTERNS = [
  '*://*.hotjar.com/*',
  '*://*.hotjar.io/*',
  '*://*.appcues.com/*',
  '*://*.appcues.net/*',
  '*://*.niceincontact.com/*',
  '*://*.nice-incontact.com/*',
  '*://*.segment.com/*',
  '*://*.segment.io/*',
  '*://*.sumo.com/*',
  '*://static.cloudflareinsights.com/*'
];

/**
 * webContentsId → { last: time of last response start/finish, streaming: Set<requestId>,
 *                   origins: Map<DAT origin, last response time> }
 */
const activity = new Map();

function entryFor(webContentsId) {
  let entry = activity.get(webContentsId);
  if (!entry) {
    entry = { last: 0, streaming: new Set(), origins: new Map(), samples: [], failures: [] };
    activity.set(webContentsId, entry);
  }
  return entry;
}

/** The DAT server a URL goes to, or null. */
function datUrl(url) {
  try {
    const parsed = new URL(url);
    return /(^|\.)dat\.com$/i.test(parsed.hostname) ? parsed : null;
  } catch {
    return null;
  }
}

/** Remember which DAT servers a tab talks to (for keeping their connections warm). */
function noteOrigin(entry, url, now) {
  const dat = datUrl(url);
  if (dat) entry.origins.set(dat.origin, now);
}

/** Answer times kept per tab (newest last) and how long they count. */
const MAX_SAMPLES = 60;
const SAMPLE_KEEP_MS = 2 * 60 * 1000;
/** Faster than this came from memory or a service worker, not over the network. */
const MIN_NETWORK_MS = 15;
/** Network failures that mean the connection or proxy did not work (not a cancelled request). */
const CONNECTION_ERRORS =
  /ERR_(TIMED_OUT|CONNECTION_(RESET|CLOSED|REFUSED|FAILED|TIMED_OUT|ABORTED)|PROXY_|TUNNEL_CONNECTION_FAILED|EMPTY_RESPONSE|NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|INTERNET_DISCONNECTED|NETWORK_CHANGED|ADDRESS_UNREACHABLE|SOCKS_)/;

function trimOld(list, now) {
  while (list.length && (list.length > MAX_SAMPLES || now - list[0].at > SAMPLE_KEEP_MS)) list.shift();
}
const blockedCounts = new WeakMap();

/** requestId → { wc: webContentsId, at } — sent, no response yet. */
const waiting = new Map();
/** A request waiting this long is forgotten (its end event was missed). */
const WAITING_FORGET_MS = 5 * 60 * 1000;

function applySessionNetworkHooks(ses, { blockTrackers = true } = {}) {
  if (!ses?.webRequest) return;

  if (blockTrackers) {
    blockedCounts.set(ses, 0);
    ses.webRequest.onBeforeRequest({ urls: DAT_TRACKER_PATTERNS }, (_details, callback) => {
      blockedCounts.set(ses, (blockedCounts.get(ses) || 0) + 1);
      callback({ cancel: true });
    });
  } else {
    ses.webRequest.onBeforeRequest(null);
  }

  ses.webRequest.onSendHeaders((details) => {
    // WebSockets stay open by design; they are not "waiting".
    if (!details.webContentsId || details.resourceType === 'webSocket') return;
    waiting.set(details.id, { wc: details.webContentsId, at: Date.now() });
  });

  ses.webRequest.onResponseStarted((details) => {
    const sent = waiting.get(details.id);
    waiting.delete(details.id);
    if (!details.webContentsId) return;
    const entry = entryFor(details.webContentsId);
    const now = Date.now();
    entry.last = now;
    entry.streaming.add(details.id);
    noteOrigin(entry, details.url, now);
    // Time from sending the request to the first answer byte = what the user waits for.
    const dat = sent && !details.fromCache && datUrl(details.url);
    const ms = sent ? now - sent.at : 0;
    if (dat && ms >= MIN_NETWORK_MS) {
      entry.samples.push({ at: now, ms, host: dat.hostname });
      trimOld(entry.samples, now);
    }
  });
  const finished = (details) => {
    waiting.delete(details.id);
    const entry = details.webContentsId && activity.get(details.webContentsId);
    if (!entry) return;
    const now = Date.now();
    entry.last = now;
    entry.streaming.delete(details.id);
    if (!details.error) noteOrigin(entry, details.url, now);
    else if (CONNECTION_ERRORS.test(details.error) && datUrl(details.url)) {
      entry.failures.push({ at: now, error: details.error });
      trimOld(entry.failures, now);
    }
  };
  ses.webRequest.onCompleted(finished);
  ses.webRequest.onErrorOccurred(finished);
}

/** Is this webContents still receiving data (recent activity or a download in progress)? */
function isReceivingData(webContentsId, graceMs) {
  const entry = activity.get(webContentsId);
  if (!entry) return false;
  return entry.streaming.size > 0 || Date.now() - entry.last < graceMs;
}

/**
 * DAT origins these tabs used within `recentMs`, optionally only those with no
 * traffic for at least `quietMs` (their connection may be about to go cold).
 */
function getDatOrigins(webContentsIds, { recentMs, quietMs = 0 }) {
  const now = Date.now();
  const lastByOrigin = new Map();
  for (const id of webContentsIds) {
    for (const [origin, at] of activity.get(id)?.origins || []) {
      lastByOrigin.set(origin, Math.max(at, lastByOrigin.get(origin) || 0));
    }
  }
  return [...lastByOrigin]
    .filter(([, at]) => now - at <= recentMs && now - at >= quietMs)
    .map(([origin]) => origin);
}

/** Requests from these tabs sent at least `olderThanMs` ago that have had no answer. */
function countWaitingRequests(webContentsIds, olderThanMs) {
  const ids = new Set(webContentsIds);
  const now = Date.now();
  let count = 0;
  for (const [id, req] of waiting) {
    const age = now - req.at;
    if (age > WAITING_FORGET_MS) waiting.delete(id);
    else if (age >= olderThanMs && ids.has(req.wc)) count += 1;
  }
  return count;
}

/**
 * DAT answer times (ms, oldest first) and connection failures from these tabs within
 * the last `sinceMs`. `lastOkAt` is when DAT last answered at all.
 */
function getNetSamples(webContentsIds, sinceMs) {
  const from = Date.now() - sinceMs;
  const samples = [];
  let failures = 0;
  let lastOkAt = 0;
  let lastFailAt = 0;
  for (const id of webContentsIds) {
    const entry = activity.get(id);
    if (!entry) continue;
    for (const s of entry.samples) {
      if (s.at >= from) samples.push(s);
      if (s.at > lastOkAt) lastOkAt = s.at;
    }
    for (const f of entry.failures) {
      if (f.at >= from) failures += 1;
      if (f.at > lastFailAt) lastFailAt = f.at;
    }
  }
  samples.sort((a, b) => a.at - b.at);
  return { samples, failures, lastOkAt, lastFailAt };
}

function forgetActivity(webContentsId) {
  activity.delete(webContentsId);
  for (const [id, req] of waiting) {
    if (req.wc === webContentsId) waiting.delete(id);
  }
}

function getBlockedCount(ses) {
  return blockedCounts.get(ses) || 0;
}

module.exports = {
  DAT_TRACKER_PATTERNS,
  applySessionNetworkHooks,
  isReceivingData,
  getDatOrigins,
  countWaitingRequests,
  getNetSamples,
  forgetActivity,
  getBlockedCount
};
