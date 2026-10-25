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
 * Electron allows one listener per webRequest event per session; this module owns
 * onBeforeRequest, onResponseStarted, onCompleted and onErrorOccurred for the
 * sessions it is applied to.
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
    entry = { last: 0, streaming: new Set(), origins: new Map() };
    activity.set(webContentsId, entry);
  }
  return entry;
}

/** Remember which DAT servers a tab talks to (for keeping their connections warm). */
function noteOrigin(entry, url, now) {
  try {
    const { origin, hostname } = new URL(url);
    if (/(^|\.)dat\.com$/i.test(hostname)) entry.origins.set(origin, now);
  } catch {
    // ignore
  }
}
const blockedCounts = new WeakMap();

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

  ses.webRequest.onResponseStarted((details) => {
    if (!details.webContentsId) return;
    const entry = entryFor(details.webContentsId);
    entry.last = Date.now();
    entry.streaming.add(details.id);
    noteOrigin(entry, details.url, entry.last);
  });
  const finished = (details) => {
    const entry = details.webContentsId && activity.get(details.webContentsId);
    if (!entry) return;
    entry.last = Date.now();
    entry.streaming.delete(details.id);
    if (!details.error) noteOrigin(entry, details.url, entry.last);
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

function forgetActivity(webContentsId) {
  activity.delete(webContentsId);
}

function getBlockedCount(ses) {
  return blockedCounts.get(ses) || 0;
}

module.exports = {
  DAT_TRACKER_PATTERNS,
  applySessionNetworkHooks,
  isReceivingData,
  getDatOrigins,
  forgetActivity,
  getBlockedCount
};
