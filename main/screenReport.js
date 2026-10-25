'use strict';

const path = require('path');
const os = require('os');
const axios = require('axios');
const { app, BrowserWindow, desktopCapturer, ipcMain, screen, session } = require('electron');
const { getTrackingEyeConfig } = require('./config');
const { getDeviceInfo } = require('./clientIdentity');

const CAPTURE_EDGE = 1920;
/** Shown in TrackingEye next to the computer name. */
const APP_NAME = 'Dat Desk';

let captureLock = Promise.resolve();
let loopTimer = null;
let loopRunning = false;
let loopStopped = false;
let loopAgain = false;
let lastRequestId = '';
let lastPresenceWarn = 0;
let liveToken = 0;
let liveActiveGeneration = 0;
let liveFailedGeneration = -1;
let liveStarting = false;
let liveWin = null;
let sourceQueue = [];
let liveScreens = [];
let liveScreenIndex = 0;
const liveHandlers = { onOffer: null };
let readProfile = async () => ({ email: '', userId: '', allowRemote: true, allowLive: true });
let onCommand = null;
let lastCommandId = '';

ipcMain.on('live-offer', (_event, sdp) => {
  if (liveHandlers.onOffer) liveHandlers.onOffer(sdp);
});
ipcMain.on('live-failed', (_event, message) => {
  console.warn('[REPORT] Live view failed:', message || 'unknown');
  liveFailedGeneration = liveActiveGeneration;
  stopLive();
});

function fitThumbnail(display, edge) {
  const width = Math.max(1, Math.round((display.size?.width || 1280) * (display.scaleFactor || 1)));
  const height = Math.max(1, Math.round((display.size?.height || 720) * (display.scaleFactor || 1)));
  const scale = Math.min(1, edge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

async function captureScreens(edge = CAPTURE_EDGE, quality = 72) {
  const displays = screen.getAllDisplays();
  const largest = displays.reduce((best, display) => {
    const size = fitThumbnail(display, edge);
    const area = size.width * size.height;
    return area > best.area ? { area, size } : best;
  }, { area: 0, size: { width: 1280, height: 720 } });

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: largest.size,
    fetchWindowIcons: false
  });

  return sources
    .map((source, index) => {
      const image = source.thumbnail;
      if (!image || image.isEmpty()) return null;
      const size = image.getSize();
      const scale = Math.min(1, edge / Math.max(size.width, size.height, 1));
      const shot = scale < 1
        ? image.resize({
            width: Math.max(1, Math.round(size.width * scale)),
            height: Math.max(1, Math.round(size.height * scale))
          })
        : image;
      return {
        name: source.name || `Screen ${index + 1}`,
        data: shot.toJPEG(quality).toString('base64')
      };
    })
    .filter(Boolean);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withCaptureLock(task) {
  const run = captureLock.then(task, task);
  captureLock = run.then(
    () => {},
    () => {}
  );
  return run;
}

function trackingEyeError(err) {
  const status = err.response?.status;
  const serverMessage = err.response?.data?.message;
  console.warn('[REPORT] Upload failed:', status || err.message);
  if (status === 401) return { ok: false, message: 'TrackingEye rejected the report.' };
  if (serverMessage) return { ok: false, message: serverMessage };
  return { ok: false, message: 'Could not reach TrackingEye. Check that it is running, then try again.' };
}

/**
 * Capture every display, then post it to the TrackingEye inbox.
 */
async function sendScreenReport({ message, user, source = 'user', requestId = '' }) {
  let note = String(message || '').trim();
  const fromAdmin = source === 'admin';
  if (!note) note = 'Screenshot';
  if (note.length > 2000) note = note.slice(0, 2000);

  const { url, ingestKey } = getTrackingEyeConfig();
  if (!url || !ingestKey) {
    return { ok: false, message: 'Screenshot reporting is not set up on this computer.' };
  }

  return withCaptureLock(async () => {
    let screenshots = [];
    try {
      screenshots = await captureScreens();
    } catch (err) {
      console.warn('[REPORT] Capture failed:', err.message);
      return { ok: false, message: 'Could not capture the screen. Try again.' };
    }
    if (!screenshots.length) {
      return { ok: false, message: 'Could not capture the screen. Try again.' };
    }

    try {
      const { data } = await axios.post(
        `${url}/api/reports`,
        {
          message: note,
          email: user?.email || '',
          userId: user?.userId || '',
          appName: APP_NAME,
          appVersion: app.getVersion?.() || '',
          platform: `${os.platform()} ${os.release()}`,
          hostname: os.hostname(),
          source: source === 'admin' ? 'admin' : source === 'alert' ? 'alert' : 'user',
          requestId: requestId || '',
          deviceId: user?.deviceId || '',
          screenshots
        },
        {
          headers: { 'x-ingest-key': ingestKey },
          timeout: 30000,
          maxBodyLength: 25 * 1024 * 1024,
          maxContentLength: 2 * 1024 * 1024
        }
      );
      if (!data?.ok) {
        return { ok: false, message: data?.message || 'TrackingEye did not accept the screenshot.' };
      }
      const { reportActivity } = require('./activityLog');
      reportActivity('screenshot', { source: fromAdmin ? 'admin' : 'user' }, {
        email: user?.email || '',
        userId: user?.userId || ''
      });
      return {
        ok: true,
        message: fromAdmin
          ? 'Screenshot sent to support.'
          : 'Screenshot sent successfully. Support can see it now.'
      };
    } catch (err) {
      return trackingEyeError(err);
    }
  });
}

async function announcePresence(profile) {
  const { url, ingestKey } = getTrackingEyeConfig();
  if (!url || !ingestKey || !profile?.deviceId) return null;
  // Hardware ID + specs let TrackingEye tell two real PCs apart (a PC name can be copied).
  const hardware = await getDeviceInfo().catch(() => null);
  const { data } = await axios.post(
    `${url}/api/presence`,
    {
      deviceId: profile.deviceId,
      email: profile.email || '',
      loggedIn: profile.loggedIn === true,
      userId: profile.userId || '',
      role: profile.role || '',
      allowRemote: profile.allowRemote === true,
      allowLive: profile.allowLive === true,
      appName: APP_NAME,
          appVersion: app.getVersion?.() || '',
      platform: `${os.platform()} ${os.release()}`,
      hostname: os.hostname(),
      hardware
    },
    {
      headers: { 'x-ingest-key': ingestKey },
      timeout: 8000,
      maxBodyLength: 1024 * 1024,
      maxContentLength: 1024 * 1024
    }
  );
  return {
    request: data?.request || null,
    watch: data?.watch === true,
    liveGeneration: Number(data?.liveGeneration) || 0,
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

function stopLive() {
  liveToken += 1;
  liveActiveGeneration = 0;
  liveStarting = false;
  liveHandlers.onOffer = null;
  sourceQueue = [];
  liveScreens = [];
  liveScreenIndex = 0;
  if (liveWin && !liveWin.isDestroyed()) {
    try {
      liveWin.webContents.send('live-stop');
    } catch {
      // The window is already closing.
    }
    liveWin.destroy();
  }
  liveWin = null;
}

function fitLiveSize(width, height) {
  const w = Math.max(2, Math.round(width || 1920));
  const h = Math.max(2, Math.round(height || 1080));
  const edge = Math.max(w, h);
  const cap = 1920;
  if (edge <= cap) return { width: w - (w % 2), height: h - (h % 2) };
  const scale = cap / edge;
  return {
    width: Math.max(2, Math.round((w * scale) / 2) * 2),
    height: Math.max(2, Math.round((h * scale) / 2) * 2)
  };
}

function queueScreen(index) {
  const item = liveScreens[index] || liveScreens[0];
  sourceQueue = item ? [item] : [];
  return item || null;
}

function installDisplayHandler() {
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const next = sourceQueue.shift();
    if (!next) {
      callback({});
      return;
    }
    callback({ video: { id: next.source.id, name: next.source.name } });
  }, { useSystemPicker: false });
}

async function runLive(profile, generation, token) {
  const { url, ingestKey } = getTrackingEyeConfig();
  if (!url || !ingestKey) return;
  installDisplayHandler();
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1, height: 1 },
    fetchWindowIcons: false
  });
  if (token !== liveToken) return;
  const displays = screen.getAllDisplays();
  const planned = sources.map((source, index) => {
    const display = displays.find((item) => String(item.id) === String(source.display_id)) || displays[0];
    const size = fitLiveSize(display?.size?.width, display?.size?.height);
    return {
      source,
      name: String(source.name || `Screen ${index + 1}`).slice(0, 80),
      width: size.width,
      height: size.height
    };
  });
  if (!planned.length) return;
  liveScreens = planned;
  liveScreenIndex = 0;
  queueScreen(0);
  liveWin = new BrowserWindow({
    show: false,
    x: -32000,
    y: -32000,
    width: 480,
    height: 270,
    skipTaskbar: true,
    focusable: false,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      preload: path.join(__dirname, '../preload/liveView.js')
    }
  });
  liveWin.webContents.setBackgroundThrottling(false);
  liveWin.showInactive();
  liveWin.on('closed', () => {
    if (liveWin && liveWin.isDestroyed()) liveWin = null;
  });
  await liveWin.loadFile(path.join(__dirname, 'liveView.html'));
  if (token !== liveToken || !liveWin || liveWin.isDestroyed()) return;

  const answerWait = new Promise((resolve) => {
    liveHandlers.onOffer = async (sdp) => {
      if (token !== liveToken) return;
      try {
        await axios.post(
          `${url}/api/live-signal`,
          {
            deviceId: profile.deviceId,
            generation,
            offer: sdp,
            screens: planned.map((item, index) => ({ index, name: item.name }))
          },
          { headers: { 'x-ingest-key': ingestKey }, timeout: 8000 }
        );
      } catch (err) {
        console.warn('[REPORT] Live offer failed:', err.message);
        return;
      }
      const started = Date.now();
      while (token === liveToken && Date.now() - started < 20000) {
        try {
          const { data } = await axios.get(`${url}/api/live-signal`, {
            params: { deviceId: profile.deviceId, generation },
            headers: { 'x-ingest-key': ingestKey },
            timeout: 8000
          });
          if (!data?.wanted) {
            stopLive();
            resolve();
            return;
          }
          if (data.answer && liveWin && !liveWin.isDestroyed()) {
            liveWin.webContents.send('live-answer', data.answer);
            resolve();
            return;
          }
        } catch (err) {
          console.warn('[REPORT] Live answer check failed:', err.message);
        }
        await wait(300);
      }
      resolve();
    };
  });

  liveWin.webContents.send('live-begin', {
    screen: { width: planned[0].width, height: planned[0].height }
  });
  await answerWait;
  while (token === liveToken) {
    try {
      const { data } = await axios.get(`${url}/api/live-signal`, {
        params: { deviceId: profile.deviceId, generation },
        headers: { 'x-ingest-key': ingestKey },
        timeout: 8000
      });
      if (!data?.wanted) {
        stopLive();
        return;
      }
      const nextIndex = Number(data.screenIndex) || 0;
      if (nextIndex !== liveScreenIndex && liveScreens[nextIndex] && liveWin && !liveWin.isDestroyed()) {
        liveScreenIndex = nextIndex;
        const item = queueScreen(nextIndex);
        if (item) {
          liveWin.webContents.send('live-switch', { width: item.width, height: item.height });
        }
      }
    } catch {
      // The next check will stop the view if the admin has closed it.
    }
    await wait(400);
  }
}

function ensureLive(profile, generation) {
  if (liveFailedGeneration === generation && !liveStarting && (!liveWin || liveWin.isDestroyed())) return;
  if (liveActiveGeneration === generation && (liveStarting || (liveWin && !liveWin.isDestroyed()))) return;
  stopLive();
  liveActiveGeneration = generation;
  liveStarting = true;
  const token = liveToken;
  runLive(profile, generation, token).catch((err) => {
    if (token !== liveToken) return;
    liveFailedGeneration = generation;
    stopLive();
    console.warn('[REPORT] Live view failed:', err.message);
  }).finally(() => {
    if (token === liveToken) liveStarting = false;
  });
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
      delay = profile.allowLive ? 800 : profile.allowRemote ? 4000 : 8000;
      const presence = await announcePresence(profile);
      const request = presence?.request || null;
      if (profile.allowLive && presence?.watch) {
        ensureLive(profile, presence.liveGeneration || 0);
      } else {
        stopLive();
      }
      const sameDevice = !request?.deviceId || request.deviceId === profile.deviceId;
      if (profile.allowRemote && request?.id && request.id !== lastRequestId && sameDevice) {
        lastRequestId = request.id;
        const result = await sendScreenReport({
          message: 'Screenshot requested by support.',
          user: { email: profile.email, userId: profile.userId || '' },
          source: 'admin',
          requestId: request.id
        });
        if (!result?.ok) {
          lastRequestId = '';
          console.warn('[REPORT] Admin capture was not sent:', result?.message || 'unknown');
        }
      }

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
  stopLive();
  clearTimeout(loopTimer);
  loopTimer = null;
}

module.exports = {
  sendScreenReport,
  startRemoteCapture,
  syncRemoteCapture,
  stopRemoteCapture
};
