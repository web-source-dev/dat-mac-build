/**
 * Turn Electron/API/raw errors into short user-facing copy.
 * Avoid technical words like cookie / proxy / token in what the user sees.
 */
function extractMessage(raw) {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw?.message === 'string') return raw.message;
  if (raw?.message && typeof raw.message === 'object') {
    if (typeof raw.message.message === 'string') return raw.message.message;
    if (typeof raw.message.error === 'string') return raw.message.error;
  }
  if (typeof raw?.friendlyMessage === 'string') return raw.friendlyMessage;
  if (typeof raw?.error === 'string') return raw.error;
  return '';
}

export function friendlyMessage(raw, fallback = 'Something went wrong. Please try again.') {
  let msg = extractMessage(raw);
  if (!msg && raw != null && typeof raw === 'object') {
    msg = extractMessage(raw.response?.data) || extractMessage(raw.data);
  }
  if (!msg && typeof raw !== 'object') msg = String(raw);

  msg = String(msg || '').trim();
  if (!msg || msg === '[object Object]') return fallback || '';

  // Electron IPC wrappers
  msg = msg.replace(/^Error invoking remote method '[^']+':\s*/i, '');
  msg = msg.replace(/^Error:\s*/gi, '').trim();

  if (!msg) return fallback;

  const lower = msg.toLowerCase();

  if (lower.includes('account is banned') || lower === 'banned') {
    return 'Your account has been banned. Please contact an administrator.';
  }
  if (lower.includes('invalid email or password') || lower.includes('invalid credentials')) {
    return 'Incorrect email or password.';
  }
  if (
    lower.includes('session replaced') ||
    lower.includes('logged in elsewhere') ||
    lower.includes('another device') ||
    lower.includes('session_replaced')
  ) {
    return 'You were signed out because your account signed in on another device.';
  }
  if (
    lower.includes('no token') ||
    lower.includes('not logged in') ||
    lower.includes('unauthorized') ||
    lower.includes('invalid or expired') ||
    lower.includes('invalid session')
  ) {
    return 'Please sign in again.';
  }
  if (lower.includes('network error') || lower.includes('econnrefused') || lower.includes('enotfound')) {
    return 'Cannot reach the server. Check your connection and try again.';
  }
  if (lower.includes('timeout') || lower.includes('etimedout')) {
    return 'The request timed out. Please try again.';
  }
  if (lower.includes('open dat is disabled')) {
    return 'Open DAT is disabled for your account.';
  }
  if (lower.includes('no proxy') || lower.includes('no valid proxy')) {
    return 'Your account is not ready to open DAT yet. Please contact an administrator.';
  }
  if (
    lower.includes('no active cookie') ||
    lower.includes('failed to inject cookies') ||
    lower.includes('no active session') ||
    lower.includes('session not available')
  ) {
    return 'No active session is available. Please contact an administrator.';
  }
  if (
    lower.includes('cookie may be expired') ||
    lower.includes('dat session could not') ||
    lower.includes('session could not start') ||
    lower.includes('session may be expired') ||
    lower.includes('session is invalid')
  ) {
    return 'DAT session could not start. Please contact an administrator, then try Open DAT again.';
  }
  if (lower.includes('incorrect password')) {
    return 'Incorrect password.';
  }
  if (lower.includes('failed to open dat') || lower.includes('could not open dat')) {
    return 'Could not open DAT. Please try again.';
  }

  // Strip leftover technical words from any remaining message
  msg = msg
    .replace(/\bcookies?\b/gi, 'session')
    .replace(/\btokens?\b/gi, 'session')
    .replace(/\bprox(?:y|ies)\b/gi, 'connection');

  if (msg.length > 160) {
    msg = `${msg.slice(0, 157)}…`;
  }

  return msg || fallback;
}
