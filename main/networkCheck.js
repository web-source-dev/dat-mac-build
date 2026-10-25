'use strict';

/**
 * Pre-flight network check for the DAT session, run after the proxy is applied
 * and before the DAT window opens. Uses the DAT partition itself, so it tests
 * exactly the path DAT will use (proxy, or direct / system VPN).
 *
 *  - DAT reachable?  A dead / unpaid proxy fails here instead of a white screen.
 *  - US location?    DAT needs a US IP; tells the user what was detected.
 */

const { net } = require('electron');

const DAT_TIMEOUT_MS = 15000;
const GEO_TIMEOUT_MS = 6000;
/** A passed proxy check is reused this long (same proxy → same exit IP). */
const PASS_CACHE_MS = 10 * 60 * 1000;
/**
 * Direct mode (own connection / system VPN) is reused only briefly, since a VPN can
 * drop at any moment. A tab that then fails to load shows the error page and clears
 * this cache (invalidateNetworkCheck).
 */
const DIRECT_PASS_CACHE_MS = 90 * 1000;
/** cacheKey → { at, result } */
const passCache = new Map();

const GEO_SERVICES = [
  {
    url: 'https://ipinfo.io/json',
    parse: (data) => ({ country: data?.country, ip: data?.ip })
  },
  {
    url: 'https://api.country.is/',
    parse: (data) => ({ country: data?.country, ip: data?.ip })
  }
];

/**
 * GET through the given session. Any HTTP response (including redirects) counts
 * as reachable. Rejects with the Chromium net error (e.g. net::ERR_TUNNEL_CONNECTION_FAILED).
 */
function sessionGet(ses, url, { timeoutMs, auth } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    const request = net.request({
      url,
      session: ses,
      redirect: 'manual',
      useSessionCookies: false
    });

    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err || value?.aborted) {
        try {
          request.abort();
        } catch {
          // ignore
        }
      }
      if (err) reject(err);
      else resolve(value);
    };

    const timer = setTimeout(
      () => finish(new Error('net::ERR_TIMED_OUT')),
      timeoutMs || DAT_TIMEOUT_MS
    );

    request.on('login', (authInfo, callback) => {
      if (authInfo.isProxy && auth?.username) {
        callback(auth.username, auth.password || '');
      } else {
        callback(); // cancel → reported as an auth error
      }
    });

    request.on('redirect', (statusCode) => {
      finish(null, { status: statusCode, body: '', aborted: true });
    });

    request.on('response', (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        if (size < 65536) {
          chunks.push(chunk);
          size += chunk.length;
        }
      });
      response.on('end', () =>
        finish(null, {
          status: response.statusCode,
          body: Buffer.concat(chunks).toString('utf8')
        })
      );
      response.on('error', (err) => finish(err));
    });

    request.on('error', (err) => finish(err));
    request.end();
  });
}

function netErrorCode(err) {
  const match = String(err?.message || err || '').match(/ERR_[A-Z_]+/);
  return match ? match[0] : 'ERR_FAILED';
}

/**
 * Errors that often clear up on an immediate retry — e.g. the first CONNECT through
 * a cold proxy fails with ERR_TUNNEL_CONNECTION_FAILED, the next one works.
 * Timeouts are not retried (they already waited DAT_TIMEOUT_MS).
 */
const RETRYABLE_CODES = new Set([
  'ERR_TUNNEL_CONNECTION_FAILED',
  'ERR_PROXY_CONNECTION_FAILED',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_ABORTED',
  'ERR_EMPTY_RESPONSE',
  'ERR_SOCKET_NOT_CONNECTED',
  'ERR_NETWORK_CHANGED'
]);
/** The PC's own connection is down — switching proxy will not help. */
const LOCAL_NETWORK_CODES = new Set([
  'ERR_INTERNET_DISCONNECTED',
  'ERR_NETWORK_CHANGED',
  'ERR_ADDRESS_UNREACHABLE',
  'ERR_NETWORK_ACCESS_DENIED'
]);
/** Wait before each retry of the DAT probe. */
const DAT_RETRY_DELAYS_MS = [600, 1500];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** GET DAT, retrying transient connection errors. */
async function probeDat(ses, url, auth, timeoutMs = DAT_TIMEOUT_MS) {
  let code = 'ERR_FAILED';
  for (let attempt = 0; attempt <= DAT_RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) await sleep(DAT_RETRY_DELAYS_MS[attempt - 1]);
    try {
      const res = await sessionGet(ses, url, { timeoutMs, auth });
      return { ok: true, status: res.status, attempts: attempt + 1 };
    } catch (err) {
      code = netErrorCode(err);
      if (!RETRYABLE_CODES.has(code)) break;
      console.warn(`[NETWORK_CHECK] DAT probe attempt ${attempt + 1} failed: ${code}`);
    }
  }
  return { ok: false, code };
}

function describeNetError(code, usingProxy) {
  if (
    /^ERR_(PROXY_|TUNNEL_CONNECTION_FAILED|NO_SUPPORTED_PROXIES|MANDATORY_PROXY)/.test(code)
  ) {
    return 'The proxy assigned to your account is not working (it may be expired or disabled by the provider). Please contact an administrator.';
  }
  if (code === 'ERR_TIMED_OUT' || code === 'ERR_CONNECTION_TIMED_OUT') {
    return usingProxy
      ? 'The proxy assigned to your account is not responding. Please contact an administrator.'
      : 'DAT is not responding. Check your internet / VPN connection and try again.';
  }
  if (code === 'ERR_INTERNET_DISCONNECTED' || code === 'ERR_NAME_NOT_RESOLVED') {
    return 'No internet connection. Check your network / VPN and try again.';
  }
  if (code === 'ERR_NETWORK_CHANGED') {
    return 'Your network changed (VPN connected or disconnected). Please try again.';
  }
  return usingProxy
    ? `Could not reach DAT through the proxy (${code}). Please contact an administrator.`
    : `Could not reach DAT (${code}). Check your internet / VPN connection and try again.`;
}

/** Ask all geo services at once; the first valid answer wins. */
function lookupCountry(ses, auth) {
  return new Promise((resolve) => {
    let pending = GEO_SERVICES.length;
    let done = false;
    const miss = () => {
      pending -= 1;
      if (!pending && !done) resolve({ country: null, ip: null }); // unknown → don't block on geo
    };
    for (const service of GEO_SERVICES) {
      sessionGet(ses, service.url, { timeoutMs: GEO_TIMEOUT_MS, auth })
        .then((res) => {
          if (done) return;
          if (res.status !== 200) return miss();
          const { country, ip } = service.parse(JSON.parse(res.body));
          if (!country) return miss();
          done = true;
          resolve({ country: String(country).toUpperCase(), ip: ip || null });
        })
        .catch(() => { if (!done) miss(); });
    }
  });
}

function cacheKeyFor(proxy) {
  return proxy ? `proxy|${proxy.raw || `${proxy.host}:${proxy.port}`}` : 'direct';
}

/** Forget cached passes (e.g. a DAT tab just failed with a network error). */
function invalidateNetworkCheck() {
  passCache.clear();
}

/**
 * @param {Electron.Session} ses  DAT partition session (proxy already applied)
 * @param {{ proxy: object|null, datUrl: string, datTimeoutMs?: number }} opts  proxy = parseProxy() result or null
 * @returns {Promise<{ ok: boolean, message?: string, code?: string, country?: string|null, ip?: string|null }>}
 */
async function checkDatNetwork(ses, { proxy, datUrl, datTimeoutMs = DAT_TIMEOUT_MS }) {
  const usingProxy = Boolean(proxy);
  const key = cacheKeyFor(proxy);
  const cached = passCache.get(key);
  const maxAge = usingProxy ? PASS_CACHE_MS : DIRECT_PASS_CACHE_MS;
  if (cached && Date.now() - cached.at < maxAge) {
    return { ...cached.result, cached: true };
  }

  const auth = proxy?.username ? { username: proxy.username, password: proxy.password } : null;

  let origin = 'https://one.dat.com';
  try {
    origin = new URL(datUrl).origin;
  } catch {
    // keep default
  }

  const t0 = Date.now();
  const timings = {};
  const [dat, geo] = await Promise.all([
    probeDat(ses, `${origin}/`, auth, datTimeoutMs)
      .finally(() => { timings.datMs = Date.now() - t0; }),
    lookupCountry(ses, auth).finally(() => { timings.geoMs = Date.now() - t0; })
  ]);

  if (!dat.ok) {
    // The geo lookup went through the same proxy: if it worked, the proxy is fine
    // and it is DAT itself that is unreachable.
    const proxyWorks = usingProxy && Boolean(geo.country);
    return {
      ok: false,
      code: dat.code,
      // The proxy is the problem (not DAT, not the PC's own internet) → another proxy may work
      proxyFault: usingProxy && !proxyWorks && !LOCAL_NETWORK_CODES.has(dat.code),
      timings,
      message: proxyWorks
        ? `DAT is not reachable right now (${dat.code}). The site may be down — please try again in a few minutes.`
        : describeNetError(dat.code, usingProxy),
      country: geo.country,
      ip: geo.ip
    };
  }

  if (geo.country && geo.country !== 'US') {
    const detected = `${geo.country}${geo.ip ? `, IP ${geo.ip}` : ''}`;
    return {
      ok: false,
      code: 'NOT_US',
      proxyFault: usingProxy,
      timings,
      country: geo.country,
      ip: geo.ip,
      message: usingProxy
        ? `The proxy assigned to your account is not in the US (detected: ${detected}). DAT only works from a US location. Please contact an administrator.`
        : `Your connection is not in the US (detected: ${detected}). DAT only works from a US location — connect a US VPN and try again.`
    };
  }

  const result = { ok: true, country: geo.country, ip: geo.ip, timings };
  passCache.set(key, { at: Date.now(), result });
  return result;
}

module.exports = { checkDatNetwork, invalidateNetworkCheck };
