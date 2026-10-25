/**
 * Preload for in-app custom tabs (and any DAT window that still sets a preload).
 *
 * The main DAT tabs no longer use a preload — their fingerprint and storage are injected
 * into the page's main world via CDP (see main/tabManager.js installInjection). This preload
 * remains for custom in-app windows, where it seeds the saved localStorage/sessionStorage.
 * localStorage/sessionStorage are per-origin and shared across JS worlds, so seeding from
 * this (isolated, sandboxed) preload still lands in the store the page reads. Keys that
 * already exist are never overwritten, so a renewed session is never clobbered.
 *
 * Sandbox-safe: it only requires `electron`, never a local module.
 */
const { ipcRenderer } = require('electron');

(() => {
  try {
    const host = String(window.location.hostname || '').toLowerCase();
    if (host !== 'dat.com' && !host.endsWith('.dat.com')) return;

    const boot = ipcRenderer.sendSync('dat:page-bootstrap');
    if (!boot || typeof boot !== 'object') return;

    const fill = (store, data) => {
      for (const [key, value] of Object.entries(data || {})) {
        try {
          if (store.getItem(key) === null) store.setItem(key, value);
        } catch {
          // ignore quota / access errors per key
        }
      }
    };

    fill(window.localStorage, boot.localStorage);
    fill(window.sessionStorage, boot.sessionStorage);
  } catch {
    // never break the page because of seeding
  }
})();
