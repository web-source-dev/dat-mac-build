'use strict';

/**
 * This Mac's own signing key (ECDSA P-256) — macOS build of the Windows TPM key.
 *
 * - Created on first launch with Node's crypto. The private key is saved in the app's data
 *   folder encrypted by Electron safeStorage, whose secret lives in the macOS Keychain of the
 *   signed-in Mac user. A copy of the file on another Mac (or another user) cannot be opened.
 * - Same wire format as Windows: SPKI public key, IEEE-P1363 signature over sha256(text),
 *   reported to the backend as storage 'software' (there is no TPM on this path).
 * - Used only to prove this Mac: at sign-in and when the app re-binds its in-memory session key.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KEY_NAME = 'DatDesk-DeviceKey-v1';
const KEY_FILE = 'device-key.bin';

let privateKey = null;
let info = null;
let failures = 0;

function electronParts() {
  const { app, safeStorage } = require('electron');
  return { app, safeStorage };
}

function keyPath() {
  return path.join(electronParts().app.getPath('userData'), KEY_FILE);
}

function loadOrCreate() {
  const { safeStorage } = electronParts();
  if (!safeStorage.isEncryptionAvailable()) throw new Error('device key: Keychain not available');
  const file = keyPath();
  if (fs.existsSync(file)) {
    try {
      const pem = safeStorage.decryptString(fs.readFileSync(file));
      return crypto.createPrivateKey(pem);
    } catch (err) {
      // Keychain entry gone or file damaged: start over with a new key (the backend re-enrolls it).
      console.warn('[DEVICE] Saved device key unreadable, creating a new one:', err.message);
    }
  }
  const { privateKey: key } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = key.export({ type: 'pkcs8', format: 'pem' });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, safeStorage.encryptString(pem), { mode: 0o600 });
  return key;
}

/** Open (or create on first launch) this Mac's key. → { publicKey (SPKI b64), kid, storage } */
let initPromise = null;

function ready() {
  if (info) return Promise.resolve(info);
  if (!initPromise) {
    // safeStorage needs the app to be ready (deviceSession asks at module load).
    initPromise = electronParts()
      .app.whenReady()
      .then(() => {
        privateKey = loadOrCreate();
        const der = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
        info = {
          publicKey: der.toString('base64'),
          kid: crypto.createHash('sha256').update(der).digest('hex'),
          storage: 'software'
        };
        failures = 0;
        return info;
      })
      .catch((err) => {
        failures += 1;
        privateKey = null;
        initPromise = null;
        throw err;
      });
  }
  return initPromise;
}

/** Sign `text` (UTF-8) with the device key → IEEE-P1363 signature, base64url. */
async function sign(text) {
  await ready();
  const sig = crypto.sign('sha256', Buffer.from(String(text), 'utf8'), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363'
  });
  return sig.toString('base64url');
}

function available() {
  return failures < 5;
}

function stop() {
  // Nothing to shut down: no helper process on macOS.
}

module.exports = { ready, sign, available, stop, KEY_NAME };
