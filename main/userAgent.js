'use strict';

/**
 * Chrome user agent used for the DAT session.
 *
 * By default it matches the Chromium actually bundled with Electron: a hard-coded version
 * disagrees with the Sec-CH-UA client hints and navigator.userAgentData, which bot checks
 * notice. When a session is imported from FreightDesk we instead replay the exact user
 * agent the session was captured with (set via setAccountUserAgent), and the client hints
 * are rewritten to match it (see applyClientHints in index.js), so the account always
 * looks like the same browser everywhere it is opened.
 */

let override = '';

/** Default UA matching the bundled Chromium. */
function defaultChromeUserAgent() {
  const major = String(process.versions.chrome || '').split('.')[0] || '130';
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/** Pin the user agent to the account's captured one. Pass '' to clear back to default. */
function setAccountUserAgent(ua) {
  override = String(ua || '').trim();
}

/** The user agent to use now: the account's captured UA if pinned, else the default. */
function chromeUserAgent() {
  return override || defaultChromeUserAgent();
}

module.exports = { chromeUserAgent, defaultChromeUserAgent, setAccountUserAgent };
