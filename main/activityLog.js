'use strict';

const os = require('os');
const axios = require('axios');
const { app } = require('electron');
const { getTrackingEyeConfig } = require('./config');

let readProfile = async () => ({ email: '', userId: '', deviceId: '' });
let datStay = null;
let openingStay = null;
let closingStay = false;

function startActivityLog(getProfile) {
  readProfile = getProfile;
}

async function reportActivity(event, detail = {}, profileOverride) {
  try {
    const { url, ingestKey } = getTrackingEyeConfig();
    if (!url || !ingestKey) return;
    const base = await readProfile();
    const profile = profileOverride
      ? {
          ...base,
          ...profileOverride,
          deviceId: profileOverride.deviceId || base.deviceId || '',
          email: profileOverride.email || base.email || '',
          userId: profileOverride.userId || base.userId || ''
        }
      : base;
    if (!profile?.deviceId && !profile?.email) return;
    await axios.post(
      `${url}/api/activity`,
      {
        deviceId: profile.deviceId || '',
        email: profile.email || '',
        userId: profile.userId || '',
        event,
        at: new Date().toISOString(),
        hostname: os.hostname(),
        platform: `${os.platform()} ${os.release()}`,
        appVersion: app.getVersion?.() || '',
        detail: detail || {}
      },
      {
        headers: { 'x-ingest-key': ingestKey },
        timeout: 8000,
        maxBodyLength: 64 * 1024,
        maxContentLength: 64 * 1024
      }
    );
  } catch (err) {
    console.warn('[ACTIVITY]', event, err.message);
  }
}

function noteDatSurface(visible) {
  if (!datStay || openingStay) return;
  reportActivity(visible ? 'dat_shown' : 'dat_hidden', {}, datStay);
}

function markDatOpened() {
  if (datStay || openingStay) return;
  const openedAt = Date.now();
  openingStay = readProfile()
    .then((profile) => {
      datStay = {
        email: profile?.email || '',
        userId: profile?.userId || '',
        deviceId: profile?.deviceId || '',
        openedAt
      };
      openingStay = null;
      return reportActivity('dat_opened', { openedAt: new Date(openedAt).toISOString() }, datStay);
    })
    .catch(() => {
      openingStay = null;
    });
}

async function markDatClosed(reason) {
  if (closingStay) return;
  closingStay = true;
  try {
    if (openingStay) {
      try {
        await openingStay;
      } catch {
        // The open record is best-effort.
      }
    }
    if (!datStay) return;
    const stay = datStay;
    datStay = null;
    await reportActivity(
      'dat_closed',
      {
        openedAt: new Date(stay.openedAt).toISOString(),
        durationMs: Math.max(0, Date.now() - stay.openedAt),
        reason: reason || 'closed'
      },
      stay
    );
  } finally {
    closingStay = false;
  }
}

module.exports = {
  startActivityLog,
  reportActivity,
  markDatOpened,
  markDatClosed,
  noteDatSurface
};
