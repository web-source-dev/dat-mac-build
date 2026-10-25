'use strict';

/**
 * Certificate pinning for backend calls.
 *
 * Traffic-inspection tools (Fiddler, Charles, mitmproxy) read HTTPS by installing their own
 * root certificate on the PC — in the Windows store, or via NODE_EXTRA_CA_CERTS — and pointing
 * the app at a proxy. This agent accepts a server only when its certificate chain ends in one of
 * the public roots BUILT INTO this app (Node's bundled Mozilla list), never a root added on the
 * PC, so such a proxy cannot decrypt or alter the API traffic.
 *
 * Pinning the public roots (not one CA) is deliberate: the backends sit behind Cloudflare, which
 * switches between Google Trust Services and Let's Encrypt on its own; a single-CA pin would one
 * day lock every user out. Auto-update uses its own connection, so a pin problem can always be
 * fixed by an update.
 */

const https = require('https');
const tls = require('tls');
const crypto = require('crypto');

function spkiHash(der) {
  try {
    const cert = new crypto.X509Certificate(der);
    return crypto.createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  } catch {
    return '';
  }
}

let bundled = null;
function bundledRoots() {
  if (bundled) return bundled;
  bundled = new Set();
  for (const pem of tls.rootCertificates || []) {
    const hash = spkiHash(pem);
    if (hash) bundled.add(hash);
  }
  return bundled;
}

/** Hosts we never pin (local development). */
function isLocal(host) {
  return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(String(host || '')) || host === '::1';
}

function checkServerIdentity(host, cert) {
  const err = tls.checkServerIdentity(host, cert);
  if (err) return err;
  if (isLocal(host)) return undefined;
  const roots = bundledRoots();
  if (!roots.size) return undefined;
  const seen = new Set();
  let c = cert;
  while (c && c.raw && !seen.has(c.fingerprint256)) {
    seen.add(c.fingerprint256);
    if (roots.has(spkiHash(c.raw))) return undefined;
    c = c.issuerCertificate;
  }
  const failure = new Error(
    `Untrusted certificate for ${host}: a program on this PC is intercepting secure connections (proxy / traffic inspector).`
  );
  failure.code = 'ERR_CERT_PINNING';
  console.warn('[TLS] pin check failed for', host);
  return failure;
}

const agent = new https.Agent({ keepAlive: true, maxSockets: 16, checkServerIdentity });

module.exports = { agent, checkServerIdentity };
