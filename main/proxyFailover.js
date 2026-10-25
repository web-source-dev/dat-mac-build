'use strict';

/**
 * Automatic proxy failover for Open DAT.
 *
 * When the user's proxy does not work (dead, expired, not US), the app asks the
 * backend for another *working* proxy (POST /proxy/failover — enabled + on the
 * working list), checks it, and once it reaches DAT confirms it
 * (POST /proxy/failover/confirm) so the backend assigns it to the user.
 *
 * If the backend could not save it (custom / global proxy), the working backup is
 * remembered here for a while so the next Open DAT goes straight to it.
 */

/** Backup proxies tried per Open DAT before giving up. */
const MAX_FAILOVERS = 3;
/** How long an unsaved working backup replaces the broken proxy. */
const REMEMBER_MS = 30 * 60 * 1000;

/** { primary, proxy, at } — primary = the broken proxy string */
let remembered = null;

function proxyAddress(value) {
  const parts = String(value || '').trim().split(':');
  if (parts.length < 2 || !parts[0] || !/^\d+$/.test(parts[1])) return '';
  return `${parts[0]}:${parts[1]}`.toLowerCase();
}

/** The proxy to start with: a remembered working backup, or the assigned one. */
function effectiveProxy(assigned) {
  if (!assigned || !remembered) return assigned;
  if (Date.now() - remembered.at > REMEMBER_MS) {
    remembered = null;
    return assigned;
  }
  return proxyAddress(assigned) === proxyAddress(remembered.primary) ? remembered.proxy : assigned;
}

function rememberBackup(primary, proxy) {
  if (!primary || !proxy || proxyAddress(primary) === proxyAddress(proxy)) return;
  remembered = { primary, proxy, at: Date.now() };
}

/** The remembered backup itself failed → forget it. */
function forgetBackup(proxy) {
  if (remembered && proxyAddress(remembered.proxy) === proxyAddress(proxy)) remembered = null;
}

/**
 * Ask the backend for another working proxy, skipping the ones already tried.
 * @returns {Promise<{ proxy: string, proxyId: string, name: string|null } | null>} null = none left
 */
async function requestBackupProxy(api, tried, reason) {
  try {
    const { data } = await api.post('/proxy/failover', {
      tried: tried.map(proxyAddress).filter(Boolean),
      reason
    });
    const proxy = String(data?.proxy || '').trim();
    if (!proxy || !proxyAddress(proxy)) return null;
    return { proxy, proxyId: data?.proxyId ? String(data.proxyId) : '', name: data?.name || null };
  } catch (err) {
    if (err.response?.status !== 404) {
      console.warn('[PROXY_FAILOVER] Backup request failed:', err.message);
    }
    return null;
  }
}

/**
 * Tell the backend the backup reached DAT, so it becomes the user's proxy.
 * @returns {Promise<boolean>} true = saved on the user
 */
async function confirmBackupProxy(api, { proxyId, tried, reason }) {
  if (!proxyId) return false;
  try {
    const { data } = await api.post('/proxy/failover/confirm', {
      proxyId,
      tried: tried.map(proxyAddress).filter(Boolean),
      reason
    });
    return data?.saved === true;
  } catch (err) {
    console.warn('[PROXY_FAILOVER] Could not save the new proxy:', err.message);
    return false;
  }
}

module.exports = {
  MAX_FAILOVERS,
  proxyAddress,
  effectiveProxy,
  rememberBackup,
  forgetBackup,
  requestBackupProxy,
  confirmBackupProxy
};
