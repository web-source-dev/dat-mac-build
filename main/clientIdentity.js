'use strict';

/**
 * Who is calling the backend.
 *
 * 1. A hardware ID for this physical PC (Windows MachineGuid + motherboard/BIOS/system
 *    serials + CPU; on a Mac the platform UUID + serial number + CPU), so the backend can tell two real computers apart even when they share
 *    a PC name, and see one account used on two PCs at once.
 * 2. A signature on every API request, so the backend can tell this app from a script or
 *    Postman replaying the user's token.
 *
 * The signing key ships inside the app: it stops casual scripts and copied tokens, not
 * someone who unpacks the app. The backend alerts on both cases anyway.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const APP_NAME = 'Dat Desk';
/** Update-feed slug: the backend compares X-Client-Version with this channel's latest release. */
const APP_CHANNEL = 'datdesk-mac';
// Must match the backend's CLIENT_SIGNING_KEY.
const SIGNING_KEY = ['2a5fce01d8e6aea1d865b5', 'bc1bc886994799e46ace00', 'cb3ab33c1bc43c366a60'].join('');
const IDENTITY_FILE = 'device-identity.json';
const IDENTITY_VERSION = 1;
const READY_WAIT_MS = 12000;
/** Requests that also carry the full hardware details (the rest carry only the ID). */
const DETAIL_PATHS = ['/auth/login', '/presence/heartbeat'];

let identity = null;
let readyPromise = null;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function run(file, args, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    // execFile's own timeout kills the process, but on Windows a hung WMI child can keep the
    // pipe open so the callback never fires — this timer always settles.
    const timer = setTimeout(() => finish(''), timeoutMs + 1000);
    try {
      const child = execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        finish(err ? '' : String(stdout || ''));
      });
      // PowerShell -Command waits for stdin to close before it exits.
      child.stdin?.end();
    } catch {
      finish('');
    }
  });
}

/** OEM placeholders ("To be filled by O.E.M.", all-F UUIDs…) say nothing about the machine. */
function cleanSerial(value) {
  const text = String(value || '').trim();
  if (!text || text.length < 3) return '';
  if (/^(to be filled|default string|none|n\/a|not applicable|not specified|system serial|system product|chassis serial|base board serial|0123456789|123456789|oem)/i.test(text)) {
    return '';
  }
  if (/^[0f-]+$/i.test(text) || /^(.)\1+$/.test(text.replace(/-/g, ''))) return '';
  if (/^03000200-0400-0500-0006-000700080009$/i.test(text)) return '';
  return text.slice(0, 80);
}

async function readMachineGuid() {
  if (process.platform === 'win32') {
    const out = await run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], 5000);
    return out.match(/MachineGuid\s+REG_SZ\s+([\w-]+)/i)?.[1] || '';
  }
  if (process.platform === 'darwin') {
    const out = await run('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], 5000);
    return out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1] || '';
  }
  for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      const id = fs.readFileSync(file, 'utf8').trim();
      if (id) return id;
    } catch {
      // try the next one
    }
  }
  return '';
}

async function readWindowsSerials() {
  if (process.platform !== 'win32') return {};
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    '$p=Get-CimInstance Win32_ComputerSystemProduct',
    '$b=Get-CimInstance Win32_BaseBoard',
    '$s=Get-CimInstance Win32_BIOS',
    '$c=Get-CimInstance Win32_ComputerSystem',
    '$d=Get-CimInstance Win32_DiskDrive | Where-Object { $_.MediaType -notmatch "Removable" } | Select-Object -First 1',
    '[pscustomobject]@{uuid=$p.UUID;board=$b.SerialNumber;bios=$s.SerialNumber;disk=$d.SerialNumber;maker=$c.Manufacturer;model=$c.Model} | ConvertTo-Json -Compress'
  ].join(';');
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], 10000);
  try {
    const data = JSON.parse(out.trim() || '{}');
    return {
      systemUuid: cleanSerial(data.uuid),
      boardSerial: cleanSerial(data.board),
      biosSerial: cleanSerial(data.bios),
      diskSerial: cleanSerial(data.disk),
      maker: String(data.maker || '').trim().slice(0, 60),
      model: String(data.model || '').trim().slice(0, 60)
    };
  } catch {
    return {};
  }
}

/**
 * Mac hardware from the IOPlatformExpertDevice registry entry (no permission prompt needed):
 * the platform UUID, the serial number and the model (e.g. "MacBookPro18,3"). Macs have no
 * separate BIOS/board serials or a disk serial readable without admin rights.
 */
async function readMacSerials() {
  if (process.platform !== 'darwin') return {};
  const out = await run('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], 5000);
  const field = (re) => out.match(re)?.[1] || '';
  return {
    systemUuid: cleanSerial(field(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)),
    boardSerial: cleanSerial(field(/"IOPlatformSerialNumber"\s*=\s*"([^"]+)"/)),
    maker: field(/"manufacturer"\s*=\s*<?"([^"]+)"/).trim().slice(0, 60) || 'Apple Inc.',
    model: field(/"model"\s*=\s*<?"([^"]+)"/).trim().slice(0, 60)
  };
}

/** Board/system serials for this OS (Windows WMI, Mac registry); {} elsewhere. */
function readHardwareSerials() {
  if (process.platform === 'darwin') return readMacSerials();
  return readWindowsSerials();
}

function macAddresses() {
  const macs = new Set();
  for (const list of Object.values(os.networkInterfaces() || {})) {
    for (const item of list || []) {
      if (item.internal || !item.mac || item.mac === '00:00:00:00:00:00') continue;
      macs.add(item.mac.toLowerCase());
    }
  }
  return [...macs].sort().slice(0, 6);
}

/** This PC's own network addresses (e.g. 192.168.1.20), to tell PCs behind one router apart. */
function localIps() {
  const ips = new Set();
  for (const list of Object.values(os.networkInterfaces() || {})) {
    for (const item of list || []) {
      if (item.internal || item.family !== 'IPv4' || item.address.startsWith('169.254.')) continue;
      ips.add(item.address);
    }
  }
  return [...ips].slice(0, 6);
}

function cpuInfo() {
  const cpus = os.cpus() || [];
  return {
    cpuModel: String(cpus[0]?.model || '').replace(/\s+/g, ' ').trim().slice(0, 100),
    cpuCores: cpus.length
  };
}

/** Values that can change while the PC stays the same machine (renames, RAM, adapters). */
function liveDetails() {
  let username = '';
  try {
    username = os.userInfo().username || '';
  } catch {
    username = '';
  }
  return {
    hostname: os.hostname(),
    username: String(username).slice(0, 60),
    platform: process.platform,
    osRelease: os.release(),
    arch: os.arch(),
    ramGB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    macs: macAddresses(),
    localIps: localIps(),
    ...cpuInfo()
  };
}

function computeHwId(guid, serials, cpu, macs) {
  const anchors = [guid, serials.systemUuid, serials.boardSerial, serials.biosSerial].filter(Boolean);
  const base = anchors.length ? anchors : macs.length ? macs : [os.hostname()];
  return sha256(['v1', ...base, cpu.cpuModel, cpu.cpuCores].join('|')).slice(0, 32);
}

function identityPath() {
  try {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), IDENTITY_FILE);
  } catch {
    return '';
  }
}

function readCache() {
  const file = identityPath();
  if (!file) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data?.version === IDENTITY_VERSION && data.hwId ? data : null;
  } catch {
    return null;
  }
}

function writeCache(data) {
  const file = identityPath();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
  } catch {
    // the ID is recomputed next start
  }
}

async function collect() {
  const guid = await readMachineGuid();
  const guidTag = guid ? sha256(guid).slice(0, 16) : '';
  const cached = readCache();
  // Same Windows install as last time: reuse the stored ID so it never flips between runs
  // (e.g. when PowerShell is slow or blocked on one start but not the next).
  if (cached && (!guidTag || cached.machineId === guidTag)) {
    // Macs set up before the serial/model were read: add them, keeping the same hwId.
    if (process.platform === 'darwin' && !cached.model) {
      const serials = await readMacSerials();
      if (serials.model || serials.boardSerial) {
        Object.assign(cached, serials);
        writeCache(cached);
      }
    }
    recheckBoard(guid, guidTag, cached);
    return { ...cached, ...liveDetails() };
  }
  return build(guid, guidTag, await readHardwareSerials());
}

function build(guid, guidTag, serials) {
  const details = liveDetails();
  const stored = {
    version: IDENTITY_VERSION,
    hwId: computeHwId(guid, serials, details, details.macs),
    machineId: guidTag,
    systemUuid: serials.systemUuid || '',
    boardSerial: serials.boardSerial || '',
    biosSerial: serials.biosSerial || '',
    diskSerial: serials.diskSerial || '',
    maker: serials.maker || '',
    model: serials.model || ''
  };
  writeCache(stored);
  return { ...stored, ...details };
}

/**
 * A cloned Windows image keeps the MachineGuid, so the cached ID could follow it onto another
 * PC. Re-read the board serials in the background and rebuild only when a real (non-empty)
 * serial disagrees — an empty read (PowerShell blocked/slow) never changes the ID.
 */
function recheckBoard(guid, guidTag, cached) {
  readHardwareSerials()
    .then((serials) => {
      const differs = ['systemUuid', 'boardSerial', 'biosSerial'].some(
        (key) => serials[key] && cached[key] && serials[key] !== cached[key]
      );
      if (differs) identity = build(guid, guidTag, serials);
    })
    .catch(() => {});
}

function fallbackIdentity() {
  const details = liveDetails();
  return { version: IDENTITY_VERSION, hwId: computeHwId('', {}, details, details.macs), machineId: '', ...details };
}

function ready() {
  if (!readyPromise) {
    readyPromise = collect()
      .then((data) => {
        identity = data;
        return data;
      })
      .catch(() => {
        identity = fallbackIdentity();
        return identity;
      });
  }
  return readyPromise;
}

async function getIdentity() {
  if (identity) return identity;
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), READY_WAIT_MS));
  return (await Promise.race([ready(), timeout])) || fallbackIdentity();
}

function appVersion() {
  try {
    return require('electron').app.getVersion() || '';
  } catch {
    return '';
  }
}

function serverTimeNow() {
  try {
    const { serverNow } = require('./authUtils');
    if (typeof serverNow === 'function') return serverNow();
  } catch {
    // older authUtils without clock correction
  }
  return Date.now();
}

/** Full hardware details, for the backend device list and TrackingEye. */
async function getDeviceInfo() {
  const id = await getIdentity();
  return {
    hwId: id.hwId,
    hostname: id.hostname,
    username: id.username,
    platform: id.platform,
    osRelease: id.osRelease,
    arch: id.arch,
    cpuModel: id.cpuModel,
    cpuCores: id.cpuCores,
    ramGB: id.ramGB,
    machineId: id.machineId || '',
    systemUuid: id.systemUuid || '',
    boardSerial: id.boardSerial || '',
    biosSerial: id.biosSerial || '',
    diskSerial: id.diskSerial || '',
    maker: id.maker || '',
    model: id.model || '',
    macs: id.macs || [],
    localIps: id.localIps || [],
    appName: APP_NAME,
    appVersion: appVersion()
  };
}

function headerValue(value, max = 200) {
  return encodeURIComponent(String(value || '')).slice(0, max);
}

/** Add the device ID + request signature headers to an axios request config. */
async function signRequest(config) {
  const id = await getIdentity();
  config.headers = config.headers || {};
  const token = String(config.headers.Authorization || config.headers.authorization || '');
  const method = String(config.method || 'get').toUpperCase();
  const ts = String(Math.round(serverTimeNow()));
  const nonce = crypto.randomBytes(12).toString('hex');
  const tokenTag = token ? sha256(token).slice(0, 16) : '';
  const base = ['v1', ts, nonce, method, id.hwId, APP_NAME, tokenTag].join('\n');
  const signature = crypto.createHmac('sha256', SIGNING_KEY).update(base).digest('hex');

  config.headers['X-Client-App'] = headerValue(APP_NAME, 40);
  config.headers['X-Client-Version'] = headerValue(appVersion(), 40);
  config.headers['X-Client-Channel'] = APP_CHANNEL;
  config.headers['X-Client-Ts'] = ts;
  config.headers['X-Client-Nonce'] = nonce;
  config.headers['X-Client-Sig'] = signature;
  config.headers['X-Device-Hw'] = id.hwId;
  config.headers['X-Device-Name'] = headerValue(id.hostname, 120);

  const url = String(config.url || '');
  if (DETAIL_PATHS.some((p) => url.includes(p))) {
    const info = await getDeviceInfo();
    config.headers['X-Device-Info'] = Buffer.from(JSON.stringify(info), 'utf8').toString('base64');
  }
  return config;
}

// Start collecting at load so the first request does not wait.
ready();

module.exports = { signRequest, getDeviceInfo, getIdentity, APP_NAME };
