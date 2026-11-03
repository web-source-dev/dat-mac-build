'use strict';

/**
 * Desktop presence + remote-command channel.
 *
 * While the user is signed in, the app beats its current state
 * (dashboard / dat / offline) to the backend so admins can see who is where.
 * The heartbeat response carries any commands the admin queued for this
 * device (e.g. "pull fresh cookies"), which are handed to `onCommands`.
 */

const { createApi } = require('./apiClient');

const HEARTBEAT_MS = 30 * 1000;

let timer = null;
let getToken = null;
let getState = null;
let onCommands = null;
let onBanned = null;
let appVersion = '';
let platform = '';
let beating = false;

async function beat() {
  if (beating) return;
  if (typeof getToken !== 'function') return;
  beating = true;
  try {
    const token = await getToken();
    if (!token) return;

    const state = typeof getState === 'function' ? getState() : { state: 'dashboard' };
    const api = createApi(token);
    const { data } = await api.post('/presence/heartbeat', {
      state: state.state,
      datOpen: Boolean(state.datOpen),
      datVisible: Boolean(state.datVisible),
      cookieId: state.cookieId || null,
      // DAT connection speed + health (datHealth.js), shown live in admin.
      net: state.net || null,
      appVersion,
      platform
    });

    // Run commands in the background: Open DAT can take a minute, and the
    // heartbeat must keep going meanwhile or the device looks offline.
    if (Array.isArray(data?.commands) && data.commands.length && typeof onCommands === 'function') {
      Promise.resolve()
        .then(() => onCommands(data.commands, api))
        .catch((err) => console.warn('[PRESENCE] command handler failed:', err.message));
    }
  } catch (err) {
    // A ban is the one answer that must act at once (closes DAT within one beat).
    if (err.response?.status === 403 && (err.response.data?.isBanned || err.response.data?.code === 'BANNED')) {
      if (typeof onBanned === 'function') onBanned(err.response.data?.message);
      return;
    }
    // Network hiccups are non-fatal — the next beat retries.
    const status = err.response?.status;
    if (status && status !== 401 && status !== 403) {
      console.warn('[PRESENCE] heartbeat failed:', status, err.message);
    }
  } finally {
    beating = false;
  }
}

function start(options = {}) {
  getToken = options.getToken;
  getState = options.getState;
  onCommands = options.onCommands;
  onBanned = options.onBanned || null;
  appVersion = String(options.appVersion || '');
  platform = String(options.platform || process.platform || '');
  stop();
  timer = setInterval(() => {
    beat().catch(() => {});
  }, HEARTBEAT_MS);
  // Fire one immediately so presence shows up without waiting a full cycle.
  beat().catch(() => {});
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Trigger an out-of-band beat (e.g. right after open/close DAT). */
async function beatNow() {
  return beat();
}

/** Report that this device's DAT session was kicked to the login page (a logout). */
async function reportDead(cookieId) {
  if (typeof getToken !== 'function' || !cookieId) return;
  try {
    const token = await getToken();
    if (!token) return;
    await createApi(token).post('/presence/report-dead', { cookieId: String(cookieId) });
  } catch {
    // best-effort; the next death report retries
  }
}

/** Best-effort one-shot "offline" beat, used on logout before stopping. */
async function sendOffline() {
  if (typeof getToken !== 'function') return;
  try {
    const token = await getToken();
    if (!token) return;
    const api = createApi(token);
    await api.post('/presence/heartbeat', {
      state: 'offline',
      datOpen: false,
      datVisible: false,
      appVersion,
      platform
    });
  } catch {
    // ignore
  }
}

module.exports = { start, stop, beatNow, sendOffline, reportDead };
