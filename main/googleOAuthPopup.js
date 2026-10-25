'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { shell, screen } = require('electron');

function existingFile(filePath) {
  try {
    return filePath && fs.existsSync(filePath) ? filePath : null;
  } catch {
    return null;
  }
}

function findSystemChromium() {
  const local = process.env.LOCALAPPDATA || '';
  const pf = process.env.PROGRAMFILES || 'C:\\Program Files';
  const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  const candidates = [];

  if (process.platform === 'win32') {
    candidates.push(
      path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(local, 'Google', 'Chrome Beta', 'Application', 'chrome.exe'),
      path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(local, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      path.join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/microsoft-edge',
      '/usr/bin/microsoft-edge-stable',
      '/usr/bin/brave-browser',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium'
    );
  }

  for (const candidate of candidates) {
    const found = existingFile(candidate);
    if (found) return found;
  }
  return null;
}

function isGoogleOAuthUrl(raw) {
  try {
    const u = new URL(String(raw || ''));
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    const pathName = u.pathname || '';
    if (host !== 'accounts.google.com') return false;
    return (
      pathName.startsWith('/o/oauth2/') ||
      pathName.startsWith('/signin/oauth') ||
      (pathName.toLowerCase().includes('oauth') && u.searchParams.has('client_id'))
    );
  } catch {
    return false;
  }
}

function popupPosition(width, height) {
  try {
    const area = screen.getPrimaryDisplay().workArea;
    return {
      left: Math.max(0, Math.round(area.x + (area.width - width) / 2)),
      top: Math.max(0, Math.round(area.y + (area.height - height) / 2))
    };
  } catch {
    return { left: 240, top: 80 };
  }
}

let lastLaunchAt = 0;

/**
 * Open Google's real account-picker in installed Chrome/Edge.
 * Returns as soon as Chrome is launched — do not wait for the window to close
 * (Chrome often hands off to an existing process and the child exits immediately).
 */
async function openGoogleOAuthPopup(url) {
  const target = String(url || '').trim();
  if (!isGoogleOAuthUrl(target)) {
    return { ok: false, message: 'Not a Google OAuth URL' };
  }

  const now = Date.now();
  // Same click can hit IPC + window.open intercept, or two OAuth URLs a few ms apart.
  if (now - lastLaunchAt < 2500) {
    return { ok: true, mode: 'deduped' };
  }
  lastLaunchAt = now;

  const exe = findSystemChromium();
  const width = 520;
  const height = 720;
  const { left, top } = popupPosition(width, height);

  if (exe) {
    try {
      const child = spawn(
        exe,
        [
          `--app=${target}`,
          `--window-size=${width},${height}`,
          `--window-position=${left},${top}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-session-crashed-bubble'
        ],
        { detached: true, stdio: 'ignore', windowsHide: false }
      );
      child.unref();
      console.log('[OAUTH] Opened Google sign-in popup via', exe);
      return { ok: true, mode: 'app-popup', launched: true };
    } catch (err) {
      console.warn('[OAUTH] App-mode popup failed:', err.message);
    }
  }

  await shell.openExternal(target);
  console.log('[OAUTH] Opened Google sign-in in the system browser');
  return { ok: true, mode: 'external', launched: true };
}

module.exports = {
  isGoogleOAuthUrl,
  openGoogleOAuthPopup,
  findSystemChromium
};
