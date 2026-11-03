'use strict';

const os = require('os');
const axios = require('axios');
const { app } = require('electron');
const { getTrackingEyeConfig } = require('./config');
const { getDeviceInfo } = require('./clientIdentity');

/** Shown in TrackingEye next to the computer name. */
const APP_NAME = 'Dat Desk';

let loopTimer = null;
let loopRunning = false;
let loopStopped = false;
let loopAgain = false;
let lastPresenceWarn = 0;
/** Hardware details go to TrackingEye on the first beat, then once per HARDWARE_RESEND_MS. */
const HARDWARE_RESEND_MS = 10 * 60 * 1000;
let hardwareSentAt = 0;
let readProfile = async () => ({ email: '', userId: '' });
let onCommand = null;
let lastCommandId = '';
/**
 * What this build can do, sent to TrackingEye. The Mac app has no screenshots, live view or
 * support terminal (allowRemote is always false, so TrackingEye shows "Capture off" and never
 * asks for one); remote actions still work.
 */
const FEATURES = [];

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function announcePresence(profile) {
  const { url, ingestKey } = getTrackingEyeConfig();
  if (!url || !ingestKey || !profile?.deviceId) return null;
  // Hardware ID + specs let TrackingEye tell two real PCs apart (a PC name can be copied).
  // They do not change, and TrackingEye keeps the last ones: send them now and then, not
  // on every beat (most of each beat's size).
  const sendHardware = Date.now() - hardwareSentAt >= HARDWARE_RESEND_MS;
  const hardware = sendHardware ? await getDeviceInfo().catch(() => null) : null;
  const { data } = await axios.post(
    `${url}/api/presence`,
    {
      deviceId: profile.deviceId,
      email: profile.email || '',
      loggedIn: profile.loggedIn === true,
      userId: profile.userId || '',
      role: profile.role || '',
      allowRemote: false,
      allowLive: false,
      appName: APP_NAME,
          appVersion: app.getVersion?.() || '',
      platform: `${os.platform()} ${os.release()}`,
      hostname: os.hostname(),
      features: FEATURES,
      ...(hardware ? { hardware } : {})
    },
    {
      headers: { 'x-ingest-key': ingestKey },
      timeout: 8000,
      maxBodyLength: 1024 * 1024,
      maxContentLength: 1024 * 1024
    }
  );
  if (hardware) hardwareSentAt = Date.now();
  return {
    command: data?.command?.id ? data.command : null
  };
}

async function ackRemoteCommand(profile, command, status, error) {
  const { url, ingestKey } = getTrackingEyeConfig();
  if (!url || !ingestKey || !profile?.deviceId || !command?.id) return;
  await axios.post(
    `${url}/api/command-result`,
    {
      deviceId: profile.deviceId,
      id: command.id,
      status,
      error: error || ''
    },
    {
      headers: { 'x-ingest-key': ingestKey },
      timeout: 8000,
      maxBodyLength: 64 * 1024,
      maxContentLength: 64 * 1024
    }
  );
}

function scheduleLoop(delay) {
  if (loopStopped) return;
  clearTimeout(loopTimer);
  loopTimer = setTimeout(runLoop, delay);
}

async function runLoop() {
  if (loopStopped) return;
  if (loopRunning) {
    loopAgain = true;
    return;
  }
  loopRunning = true;
  let delay = 15000;
  try {
    const profile = await readProfile();
    if (profile?.deviceId) {
      // A remote action waits at most 6 s.
      delay = 6000;
      const presence = await announcePresence(profile);

      const command = presence?.command || null;
      const commandHere = !command?.deviceId || command.deviceId === profile.deviceId;
      if (command?.id && command.type && command.id !== lastCommandId && commandHere) {
        lastCommandId = command.id;
        // Run it beside the loop so presence keeps beating while DAT opens/closes.
        runCommand(profile, command).catch((err) => {
          console.warn('[REPORT] Remote action failed:', err.message);
        });
      }
    }
  } catch (err) {
    hardwareSentAt = 0; // TrackingEye may have forgotten this PC meanwhile
    const now = Date.now();
    if (now - lastPresenceWarn > 60000) {
      lastPresenceWarn = now;
      console.warn('[REPORT] Presence failed:', err.message);
    }
  } finally {
    loopRunning = false;
    if (loopStopped) return;
    if (loopAgain) {
      loopAgain = false;
      scheduleLoop(0);
    } else {
      scheduleLoop(delay);
    }
  }
}

/** Ack with a few retries: a lost ack leaves the admin page waiting. Resolves true once sent. */
async function ackWithRetry(profile, command, status, error) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await ackRemoteCommand(profile, command, status, error);
      return true;
    } catch (err) {
      if (attempt === 2) console.warn('[REPORT] Could not confirm remote action:', err.message);
      else await wait(1500);
    }
  }
  return false;
}

async function runCommand(profile, command) {
  if (command.type === 'quit-app' || command.type === 'restart-app') {
    const acked = await ackWithRetry(profile, command, 'done', '');
    // An unconfirmed restart would be handed out again after relaunch and loop; skip it.
    if (!acked && command.type === 'restart-app') {
      lastCommandId = '';
      return;
    }
    if (typeof onCommand === 'function') {
      try {
        await onCommand(command);
      } catch (err) {
        console.warn('[REPORT] Quit failed:', err.message);
      }
    }
  } else if (typeof onCommand !== 'function') {
    await ackWithRetry(profile, command, 'error', 'This Dat Desk cannot run remote actions yet.');
  } else {
    let status = 'done';
    let error = '';
    try {
      const result = await onCommand(command);
      if (result && result.ok === false) {
        status = 'error';
        error = result.error || 'Could not run that action.';
      }
    } catch (err) {
      status = 'error';
      error = err.message || 'Could not run that action.';
    }
    await ackWithRetry(profile, command, status, error);
  }
}

function startRemoteCapture(getProfile, handleCommand) {
  if (typeof getProfile === 'function') readProfile = getProfile;
  if (typeof handleCommand === 'function') onCommand = handleCommand;
  if (loopTimer || loopRunning) return;
  loopStopped = false;
  scheduleLoop(1000);
}

function syncRemoteCapture() {
  if (loopStopped) return;
  clearTimeout(loopTimer);
  loopTimer = null;
  if (loopRunning) {
    loopAgain = true;
    return;
  }
  scheduleLoop(0);
}

function stopRemoteCapture() {
  loopStopped = true;
  loopAgain = false;
  clearTimeout(loopTimer);
  loopTimer = null;
}

module.exports = {
  startRemoteCapture,
  syncRemoteCapture,
  stopRemoteCapture
};
