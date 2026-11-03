const { WebContentsView } = require('electron');
const path = require('path');
const {
  buildPermissionCss,
  DAT_ADD_BUTTON_ENHANCE_SCRIPT
} = require('./datTabEnforce');
const { isGoogleOAuthUrl, openGoogleOAuthPopup } = require('./googleOAuthPopup');
const { chromeUserAgent } = require('./userAgent');
const { isReceivingData, forgetActivity } = require('./trackerBlock');
const { buildInjection } = require('./datPageInit');
const { loadZoom, saveZoom, stepZoom, clampZoom } = require('./datZoom');

/** A tab that is still loading after this long gets stopped and shows the error page… */
const TAB_LOAD_TIMEOUT_MS = 45000;
/** …unless data is still arriving (a download in progress, or activity this recent). */
const TAB_LOAD_ACTIVITY_GRACE_MS = 20000;
const TAB_LOAD_EXTEND_MS = 15000;
/** Hard cap for a still-progressing load. */
const TAB_LOAD_MAX_MS = 180000;
/**
 * Extra wait after Chromium reports 'unresponsive' (it already waited ~35s of
 * unanswered input) → kill the renderer so render-process-gone reloads the tab.
 */
const TAB_HANG_TIMEOUT_MS = 10000;
/** Only one automatic reload per tab in this window; a second crash shows the error page. */
const TAB_CRASH_RELOAD_WINDOW_MS = 60000;
/** Chromium net::ERR_ABORTED — our own preventDefault / superseded navigations. */
const ERR_ABORTED = -3;

const ERROR_PAGE_PATH = path.join(__dirname, '../renderer/dat-error.html');

function isDatLoginUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ''));
    const hostname = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    const search = parsed.search.toLowerCase();
    if (hostname === 'login.dat.com') return true;
    if (hostname.endsWith('.dat.com') && pathname.includes('/login')) return true;
    if (hostname.includes('login') && hostname.endsWith('.dat.com')) return true;
    if (search.includes('login') && hostname.endsWith('.dat.com') && pathname.includes('auth')) {
      return true;
    }
    return false;
  } catch {
    const lower = String(rawUrl || '').toLowerCase();
    return lower.includes('login.dat.com') || lower.includes('://login.');
  }
}

class TabManager {
  constructor(window, permissions = null, options = {}) {
    this.window = window;
    this.tabs = new Map();
    this.activeTabId = null;
    this.tabCounter = 0;
    this.tabBarHeight = 40;
    this.rightInset = 0;
    this.permissions = permissions || {};
    this.usingProxy = Boolean(options.usingProxy);
    this.onNetworkError = options.onNetworkError || null;
    this.onDatLoginRedirect = options.onDatLoginRedirect || null;
    this.onTabSwitched = options.onTabSwitched || null;
    this._loginHandled = false;
    this.css = buildPermissionCss(this.permissions);
    this._tabBarTimer = null;
    this._lastTabBarPayload = '';
    /** Main-world injection source (fingerprint + storage seed) applied to every DAT tab. */
    this._injection = null;
    /** Page zoom for every DAT tab (toolbar − / + , Ctrl +/-/0, Ctrl+wheel); saved per PC. */
    this.zoomFactor = loadZoom();
    this._onBarKeys = (event, input) => this.handleZoomKeys(event, input);
    this.window.webContents.on('before-input-event', this._onBarKeys);
  }

  /** Apply the current zoom to one tab (Chromium resets zoom when the page's origin changes). */
  applyZoom(webContents) {
    if (!webContents || webContents.isDestroyed()) return;
    if (Math.abs(webContents.getZoomFactor() - this.zoomFactor) > 0.001) {
      webContents.setZoomFactor(this.zoomFactor);
    }
  }

  setZoom(factor) {
    this.zoomFactor = clampZoom(factor);
    saveZoom(this.zoomFactor);
    this.tabs.forEach((t) => this.applyZoom(t.view?.webContents));
    this.updateTabBar();
    return this.zoomFactor;
  }

  /** direction: 1 zoom in, -1 zoom out, 0 reset to 100%. */
  zoom(direction) {
    return this.setZoom(direction ? stepZoom(this.zoomFactor, direction) : 1);
  }

  /** Ctrl + = / - / 0 (numpad too) in a DAT tab or on the tab bar. */
  handleZoomKeys(event, input) {
    if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return;
    const key = input.key;
    let dir = null;
    if (key === '=' || key === '+' || input.code === 'NumpadAdd') dir = 1;
    else if (key === '-' || key === '_' || input.code === 'NumpadSubtract') dir = -1;
    else if (key === '0' || input.code === 'Numpad0') dir = 0;
    if (dir === null) return;
    event.preventDefault();
    this.zoom(dir);
  }

  /**
   * Set the account's page bootstrap: the device profile and the storage to seed. It is
   * installed into every DAT tab's MAIN world at document-start via CDP, which bypasses
   * DAT's CSP and runs before DAT's own scripts.
   */
  setPageBootstrap(profile, localStorage, sessionStorage) {
    try {
      if (!profile && !localStorage && !sessionStorage) {
        this._injection = null;
        return;
      }
      this._injection = buildInjection(profile, localStorage, sessionStorage);
    } catch (err) {
      console.warn('[FINGERPRINT] build injection failed:', err.message);
      this._injection = null;
    }
  }

  /**
   * Install the main-world injection on a tab's webContents before its first navigation.
   * Returns a promise that resolves once the script is registered, so the caller can hold
   * the first load until the fingerprint/storage are guaranteed to apply to it.
   */
  installInjection(webContents) {
    if (!this._injection || !webContents || webContents.isDestroyed()) return Promise.resolve();
    try {
      const dbg = webContents.debugger;
      if (!dbg.isAttached()) dbg.attach('1.3');
      return dbg
        .sendCommand('Page.enable')
        .catch(() => {}) // some targets need it, some ignore it; either way continue
        .then(() =>
          dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: this._injection })
        )
        .then(() => console.log('[FINGERPRINT] Installed main-world injection on DAT tab'))
        .catch((err) => console.warn('[FINGERPRINT] addScript failed:', err.message));
    } catch (err) {
      console.warn('[FINGERPRINT] debugger attach failed:', err.message);
      return Promise.resolve();
    }
  }

  setRightInset(width) {
    this.rightInset = Math.max(0, Number(width) || 0);
    if (this.activeTabId) this.updateTabBounds(this.activeTabId);
  }

  handleDatLoginRedirect(url) {
    if (this._loginHandled) return;
    if (!isDatLoginUrl(url)) return;
    this._loginHandled = true;
    console.warn('[DAT_SESSION] Redirected to DAT login:', url);
    try {
      if (typeof this.onDatLoginRedirect === 'function') {
        this.onDatLoginRedirect(url);
      }
    } catch (err) {
      console.error('[DAT_SESSION] onDatLoginRedirect failed:', err.message);
    }
  }

  setPermissions(permissions) {
    this.permissions = permissions || {};
    this.css = buildPermissionCss(this.permissions);
    // Do not re-inject CSS into live tabs — next full page load picks up new CSS.
    this.updateTabBar();
  }

  /**
   * Electron insertCSS accumulates stylesheets unless removeInsertedCSS is called.
   * Always replace the previous key so prolonged DAT use cannot balloon memory.
   */
  async applyPermissionCss(tab) {
    if (!tab?.view?.webContents || tab.view.webContents.isDestroyed()) return;
    const wc = tab.view.webContents;
    if (tab.cssKey) {
      try {
        await wc.removeInsertedCSS(tab.cssKey);
      } catch {
        // ignore — key may already be gone after navigation
      }
      tab.cssKey = null;
    }
    try {
      tab.cssKey = await wc.insertCSS(this.css);
    } catch (err) {
      console.warn('[DAT_TABS] insertCSS failed:', err.message);
    }
  }

  getMaxTabs() {
    if (!this.permissions.webMultitab) return 1;
    return Math.max(1, Number(this.permissions.webMultitabNumbers) || 1);
  }

  canCreateTab() {
    const maxTabs = this.getMaxTabs();
    if (this.tabs.size >= maxTabs) {
      return {
        allowed: false,
        reason: `Maximum tabs reached (${maxTabs}). Close a tab first.`
      };
    }
    return { allowed: true };
  }

  /**
   * Inject CSS + scripts once per full page load (did-finish-load only).
   * No SPA / title / timer re-injection — keeps the app light.
   * Urgent-only continuous check: DAT login redirect detection.
   */
  setupTabInjection(tabId, partitionName, domain) {
    const tab = this.tabs.get(tabId);
    if (!tab?.view?.webContents) return;
    const tabView = tab.view;

    tabView.webContents.setWindowOpenHandler((details) => {
      // Google blocks OAuth inside this embedded Chromium. Open a real Chrome/Edge popup instead.
      if (isGoogleOAuthUrl(details.url)) {
        openGoogleOAuthPopup(details.url).catch((err) => {
          console.warn('[OAUTH] Failed to open Google popup:', err.message);
        });
        return { action: 'deny' };
      }
      const canCreate = this.canCreateTab();
      if (!canCreate.allowed) {
        try {
          const { dialog } = require('electron');
          dialog.showErrorBox(
            'Tab Limit Reached',
            canCreate.reason || 'Maximum number of tabs reached'
          );
        } catch {
          // ignore
        }
        return { action: 'deny' };
      }
      try {
        this.createTab(partitionName, details.url || domain, { title: 'DAT One' });
      } catch (err) {
        try {
          const { dialog } = require('electron');
          dialog.showErrorBox('Tab Creation Failed', err.message || 'Cannot create new tab');
        } catch {
          // ignore
        }
      }
      return { action: 'deny' };
    });

    tabView.webContents.on('did-finish-load', async () => {
      tab.cssKey = null; // new document — previous insertCSS key is invalid
      const currentUrl = tabView.webContents.getURL() || '';
      if (!/^https?:\/\//i.test(currentUrl)) return; // local error page
      if (isDatLoginUrl(currentUrl)) {
        this.handleDatLoginRedirect(currentUrl);
        return;
      }

      // First (and only) inject for this document load.
      // DAT storage is seeded by preload/datTab.js before page scripts run.
      await this.applyPermissionCss(tab);

      try {
        const parsedUrl = new URL(currentUrl);
        const hostname = parsedUrl.hostname.toLowerCase();
        const pathname = parsedUrl.pathname.toLowerCase();
        const shouldRedirect =
          (hostname === 'one.dat.com' &&
            (pathname === '/dashboard' ||
              pathname === '/company-profile' ||
              pathname === '/my-company-profile')) ||
          hostname === 'account.dat.com';
        if (shouldRedirect) {
          tabView.webContents.loadURL('https://one.dat.com/search-loads');
          return;
        }
      } catch {
        // ignore
      }

      try {
        await tabView.webContents.executeJavaScript(DAT_ADD_BUTTON_ENHANCE_SCRIPT);
      } catch (err) {
        console.warn('[DAT_TABS] enhance script failed:', err.message);
      }
    });

    tabView.webContents.on('will-navigate', (event, url) => {
      // Block non-web schemes (DATGO-style safety); allow http(s) only
      if (!url.startsWith('https://') && !url.startsWith('http://')) {
        event.preventDefault();
        try {
          const { dialog } = require('electron');
          dialog.showErrorBox('Navigation blocked', 'Blocked navigation to unsafe URL.');
        } catch {
          // ignore
        }
        return;
      }

      if (isDatLoginUrl(url)) {
        event.preventDefault();
        this.handleDatLoginRedirect(url);
        return;
      }

      try {
        const parsed = new URL(url);
        const hostname = parsed.hostname.toLowerCase();
        const pathname = parsed.pathname.toLowerCase();
        const shouldRedirect =
          (hostname === 'one.dat.com' &&
            (pathname === '/dashboard' ||
              pathname === '/company-profile' ||
              pathname === '/my-company-profile')) ||
          hostname === 'account.dat.com';
        if (shouldRedirect) {
          event.preventDefault();
          tabView.webContents.loadURL('https://one.dat.com/search-loads');
        }
      } catch {
        // ignore
      }
    });

    // Urgent only: detect DAT session expiry redirect (no CSS/script re-inject)
    tabView.webContents.on('did-navigate', (_event, url) => {
      if (isDatLoginUrl(url)) this.handleDatLoginRedirect(url);
    });

    tabView.webContents.on('did-navigate-in-page', (_event, url) => {
      if (isDatLoginUrl(url)) this.handleDatLoginRedirect(url);
      tabView.webContents.executeJavaScript(DAT_ADD_BUTTON_ENHANCE_SCRIPT).catch(() => {});
    });
  }

  createTab(partitionName, datUrl, options = {}) {
    const canCreate = this.canCreateTab();
    if (!canCreate.allowed) {
      throw new Error(canCreate.reason);
    }

    const tabId = `tab-${++this.tabCounter}`;
    const targetUrl = datUrl || 'https://one.dat.com/search-loads';

    const tabView = new WebContentsView({
      webPreferences: {
        // DAT pages get no preload bridge; the fingerprint + storage are injected into the
        // page's MAIN world via CDP (installInjection), which bypasses DAT's CSP and runs
        // before DAT's scripts. contextIsolation stays on for renderer security.
        contextIsolation: true,
        nodeIntegration: false,
        partition: partitionName,
        sandbox: true,
        // Measured: minimized / behind other windows, Chromium ran DAT's timers only
        // once a minute after ~10 min, so DAT's own session refresh and polling
        // stalled and all caught up on the first click back — a long freeze.
        // DAT is light while idle, so let it keep running normally.
        backgroundThrottling: false
      }
    });
    tabView.setBackgroundColor('#ffffff');
    tabView.setVisible(false); // switchToTab shows it
    this.window.contentView.addChildView(tabView);

    tabView.webContents.setUserAgent(chromeUserAgent());
    tabView.webContents.on('before-input-event', (event, input) => this.handleZoomKeys(event, input));
    // Ctrl+wheel: one notch can report more than once, so take one step per 150 ms.
    tabView.webContents.on('zoom-changed', (_e, dir) => {
      const now = Date.now();
      if (now - (this._lastWheelZoomAt || 0) < 150) return;
      this._lastWheelZoomAt = now;
      this.zoom(dir === 'in' ? 1 : -1);
    });
    tabView.webContents.on('did-navigate', () => this.applyZoom(tabView.webContents));
    // Pin the account fingerprint + seed storage in the page's MAIN world at document-start
    // via CDP (bypasses CSP). The first load waits on this so it applies to the first doc.
    const injectionReady = this.installInjection(tabView.webContents);

    const tabInfo = {
      id: tabId,
      view: tabView,
      title: options.title || 'DAT One',
      url: targetUrl,
      partitionName,
      isLoading: true,
      isReady: false,
      cssKey: null,
      lastGoodUrl: targetUrl,
      loadTimer: null,
      hangTimer: null,
      lastCrashAt: 0
    };

    this.tabs.set(tabId, tabInfo);
    this.setupTabInjection(tabId, partitionName, targetUrl);
    this.updateTabBounds(tabId);
    this.switchToTab(tabId);
    this.updateTabBar();

    tabView.webContents.on('page-title-updated', (_e, title) => {
      const next = title || options.title || 'DAT One';
      if (tabInfo.title === next && !tabInfo.isLoading) return;
      tabInfo.title = next;
      tabInfo.isLoading = false;
      tabInfo.isReady = true;
      this.updateTabBar();
    });

    tabView.webContents.on('did-start-loading', () => {
      this.startLoadTimer(tabInfo);
      if (tabInfo.isLoading) return;
      tabInfo.isLoading = true;
      this.updateTabBar();
    });

    // Document parsed (or loading finished) → not a stuck load, even if slow assets remain.
    tabView.webContents.on('dom-ready', () => this.clearLoadTimer(tabInfo));
    tabView.webContents.on('did-stop-loading', () => {
      this.clearLoadTimer(tabInfo);
      // Iframe loads also fire did-start-loading; without this the tab kept its "…" spinner.
      if (tabInfo.isLoading) {
        tabInfo.isLoading = false;
        this.updateTabBar();
      }
    });

    tabView.webContents.on('did-finish-load', () => {
      this.applyZoom(tabView.webContents);
      tabInfo.isLoading = false;
      tabInfo.isReady = true;
      tabInfo.url = tabView.webContents.getURL() || tabInfo.url;
      this.updateTabBar();
    });

    tabView.webContents.on('did-navigate', (_e, url) => {
      if (/^https?:\/\//i.test(url) && !isDatLoginUrl(url)) tabInfo.lastGoodUrl = url;
    });

    // Failed main-frame load (dead proxy, timeout, network change…) → error page, not white.
    tabView.webContents.on(
      'did-fail-load',
      (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame || errorCode === ERR_ABORTED) return;
        if (/^file:/i.test(validatedURL || '')) return; // never loop on the error page itself
        console.warn('[DAT_TABS] Load failed:', errorCode, errorDescription, validatedURL);
        try {
          if (typeof this.onNetworkError === 'function') this.onNetworkError(errorDescription);
        } catch {
          // ignore
        }
        this.showTabError(tabInfo, errorDescription || `ERR_${errorCode}`, validatedURL);
      }
    );

    tabView.webContents.on('render-process-gone', (_e, details) => {
      if (tabInfo.closing || !this.tabs.has(tabInfo.id) || details.reason === 'clean-exit') return;
      console.warn('[DAT_TABS] Renderer gone:', details.reason);
      this.clearHangTimer(tabInfo);
      const now = Date.now();
      if (now - tabInfo.lastCrashAt > TAB_CRASH_RELOAD_WINDOW_MS) {
        tabInfo.lastCrashAt = now;
        if (!tabView.webContents.isDestroyed()) {
          tabView.webContents.loadURL(tabInfo.lastGoodUrl || targetUrl).catch(() => {});
        }
      } else {
        this.showTabError(tabInfo, `RENDERER_${String(details.reason).toUpperCase()}`);
      }
    });

    tabView.webContents.on('unresponsive', () => {
      // Chromium re-emits 'unresponsive' every ~16s while hung; keep the first timer.
      if (tabInfo.hangTimer) return;
      tabInfo.hangTimer = setTimeout(() => {
        tabInfo.hangTimer = null;
        if (tabInfo.closing || tabView.webContents.isDestroyed()) return;
        console.warn('[DAT_TABS] Tab frozen — restarting renderer');
        try {
          tabView.webContents.forcefullyCrashRenderer(); // → render-process-gone → reload
        } catch {
          // ignore
        }
      }, TAB_HANG_TIMEOUT_MS);
    });

    tabView.webContents.on('responsive', () => this.clearHangTimer(tabInfo));

    // Start loading only after every listener is attached: Electron can emit
    // did-start-loading synchronously, which would skip the stuck-load timer.
    // Also wait for the main-world injection to be registered so it applies to this load.
    let loadStarted = false;
    const startLoad = () => {
      if (loadStarted || tabView.webContents.isDestroyed()) return;
      loadStarted = true;
      tabView.webContents.loadURL(targetUrl).catch(() => {
        tabInfo.isLoading = false;
        this.updateTabBar();
      });
    };
    // Wait for the injection to register, but never block the load more than 2s.
    Promise.resolve(injectionReady).then(startLoad, startLoad);
    setTimeout(startLoad, 2000);

    return tabId;
  }

  startLoadTimer(tabInfo) {
    this.clearLoadTimer(tabInfo);
    tabInfo.loadStartedAt = Date.now();
    this.armLoadTimer(tabInfo, TAB_LOAD_TIMEOUT_MS);
  }

  armLoadTimer(tabInfo, delayMs) {
    tabInfo.loadTimer = setTimeout(() => {
      tabInfo.loadTimer = null;
      const wc = tabInfo.view?.webContents;
      if (tabInfo.closing || !wc || wc.isDestroyed() || !wc.isLoading()) return;
      const stillReceiving = isReceivingData(wc.id, TAB_LOAD_ACTIVITY_GRACE_MS);
      if (stillReceiving && Date.now() - tabInfo.loadStartedAt < TAB_LOAD_MAX_MS) {
        this.armLoadTimer(tabInfo, TAB_LOAD_EXTEND_MS); // slow but still receiving data
        return;
      }
      console.warn('[DAT_TABS] Load timed out:', wc.getURL());
      try {
        wc.stop();
      } catch {
        // ignore
      }
      this.showTabError(tabInfo, 'ERR_LOAD_TIMEOUT');
    }, delayMs);
  }

  clearLoadTimer(tabInfo) {
    if (tabInfo.loadTimer) clearTimeout(tabInfo.loadTimer);
    tabInfo.loadTimer = null;
  }

  clearHangTimer(tabInfo) {
    if (tabInfo.hangTimer) clearTimeout(tabInfo.hangTimer);
    tabInfo.hangTimer = null;
  }

  showTabError(tabInfo, code, failedUrl, title = 'Connection problem') {
    const wc = tabInfo.view?.webContents;
    if (tabInfo.closing || !wc || wc.isDestroyed()) return;
    this.clearLoadTimer(tabInfo);
    const retryUrl = /^https?:\/\//i.test(failedUrl || '') ? failedUrl : tabInfo.lastGoodUrl;
    tabInfo.isLoading = false;
    tabInfo.title = title;
    this.updateTabBar();
    wc.loadFile(ERROR_PAGE_PATH, {
      query: {
        code: String(code || ''),
        url: retryUrl || '',
        proxy: this.usingProxy ? '1' : '0'
      }
    }).catch(() => {});
  }

  /** Show a notice page (dat-error.html with `code`) in every tab; the tabs stay open. */
  showNoticeInAllTabs(code, title) {
    this.tabs.forEach((tabInfo) => this.showTabError(tabInfo, code, tabInfo.lastGoodUrl, title));
  }

  /** True when some tab shows a DAT page that is not DAT's login page (the session works). */
  hasLiveDatPage() {
    for (const tabInfo of this.tabs.values()) {
      const wc = tabInfo.view?.webContents;
      if (!wc || wc.isDestroyed()) continue;
      const url = String(wc.getURL() || '');
      if (/^https:\/\/([a-z0-9-]+\.)*dat\.com\//i.test(url) && !isDatLoginUrl(url)) return true;
    }
    return false;
  }

  /** After a session refresh: reload every tab from scratch and re-arm login detection. */
  reloadAllTabs(url) {
    this._loginHandled = false;
    this.tabs.forEach((tabInfo) => {
      const wc = tabInfo.view?.webContents;
      if (!wc || wc.isDestroyed()) return;
      wc.loadURL(url || tabInfo.lastGoodUrl).catch(() => {});
    });
  }

  switchToTab(tabId) {
    if (!this.tabs.has(tabId) || !this.window || this.window.isDestroyed()) return;

    // All tab views stay attached; only the active one is visible (no detach/re-attach cost).
    const activeTab = this.tabs.get(tabId);
    this.activeTabId = tabId;
    this.updateTabBounds(tabId);
    this.tabs.forEach((tabInfo) => {
      if (tabInfo !== activeTab) tabInfo.view.setVisible(false);
    });
    activeTab.view.setVisible(true);
    try {
      activeTab.view.webContents.focus();
    } catch {
      // ignore
    }
    this.updateTabBar();

    try {
      if (typeof this.onTabSwitched === 'function') this.onTabSwitched(tabId);
    } catch {
      // ignore
    }
    // Do NOT re-insertCSS on focus — that leaked stylesheets every tab switch.
  }

  closeTab(tabId) {
    if (!this.tabs.has(tabId)) return false;
    const tabInfo = this.tabs.get(tabId);
    tabInfo.closing = true;
    this.clearLoadTimer(tabInfo);
    try {
      forgetActivity(tabInfo.view.webContents.id);
    } catch {
      // ignore
    }
    this.clearHangTimer(tabInfo);

    try {
      if (this.window && !this.window.isDestroyed()) {
        this.window.contentView.removeChildView(tabInfo.view);
      }
      // A WebContentsView's webContents is not freed with the view — close it explicitly.
      if (tabInfo.view?.webContents && !tabInfo.view.webContents.isDestroyed()) {
        tabInfo.view.webContents.close();
      }
    } catch {
      // ignore
    }

    this.tabs.delete(tabId);

    if (this.activeTabId === tabId) {
      const remaining = Array.from(this.tabs.keys());
      if (remaining.length) this.switchToTab(remaining[remaining.length - 1]);
      else this.activeTabId = null;
    }

    this.updateTabBar();
    return true;
  }

  updateTabBounds(tabId) {
    if (!this.tabs.has(tabId) || !this.window || this.window.isDestroyed()) return;
    const tabInfo = this.tabs.get(tabId);
    const bounds = this.window.getContentBounds();
    const inset = Math.max(0, this.rightInset || 0);
    tabInfo.view.setBounds({
      x: 0,
      y: this.tabBarHeight,
      width: Math.max(200, bounds.width - inset),
      height: Math.max(100, bounds.height - this.tabBarHeight)
    });
  }

  forceUpdateTabBar() {
    this._lastTabBarPayload = '';
    this.updateTabBar();
  }

  updateTabBar() {
    if (!this.window || this.window.isDestroyed()) return;
    if (this._tabBarTimer) clearTimeout(this._tabBarTimer);
    this._tabBarTimer = setTimeout(() => {
      this._tabBarTimer = null;
      this._flushTabBar();
    }, 80);
  }

  /** webContents of the tab on screen (null if none). */
  getActiveWebContents() {
    const wc = this.tabs.get(this.activeTabId)?.view?.webContents;
    return wc && !wc.isDestroyed() ? wc : null;
  }

  /**
   * webContents of a live DAT tab (prefer the active one), used to read the
   * page's localStorage / sessionStorage during a cookie pull.
   */
  getDatWebContents() {
    const pick = (tab) => {
      const wc = tab?.view?.webContents;
      if (!wc || wc.isDestroyed()) return null;
      return String(wc.getURL() || '').includes('dat.com') ? wc : null;
    };
    const active = this.activeTabId && this.tabs.get(this.activeTabId);
    if (active) {
      const wc = pick(active);
      if (wc) return wc;
    }
    for (const tab of this.tabs.values()) {
      const wc = pick(tab);
      if (wc) return wc;
    }
    return null;
  }

  /** ids of every open tab's webContents. */
  getWebContentsIds() {
    return Array.from(this.tabs.values())
      .map((t) => t.view?.webContents)
      .filter((wc) => wc && !wc.isDestroyed())
      .map((wc) => wc.id);
  }

  /** Tab list as shown in the tab bar (tab:get-all). */
  getAllTabs() {
    return Array.from(this.tabs.values()).map((t) => ({
      id: t.id,
      title: t.title,
      url: t.url,
      active: t.id === this.activeTabId,
      isLoading: !!t.isLoading
    }));
  }

  _flushTabBar() {
    if (!this.window || this.window.isDestroyed()) return;
    const tabs = this.getAllTabs();
    const canCreate = this.canCreateTab();
    const payload = {
      tabs,
      permissions: {
        maxTabs: this.getMaxTabs(),
        currentTabCount: this.tabs.size,
        canCreateNewTab: canCreate.allowed,
        reason: canCreate.reason || null
      },
      zoom: Math.round(this.zoomFactor * 100)
    };
    // Skip IPC when nothing meaningful changed (DAT titles can churn)
    const signature = JSON.stringify(payload);
    if (signature === this._lastTabBarPayload) return;
    this._lastTabBarPayload = signature;
    this.window.webContents.send('tab:update', payload);
  }

  handleResize() {
    if (this.activeTabId) this.updateTabBounds(this.activeTabId);
  }

  destroy() {
    if (!this.window.isDestroyed()) {
      this.window.webContents.removeListener('before-input-event', this._onBarKeys);
    }
    if (this._tabBarTimer) clearTimeout(this._tabBarTimer);
    this._tabBarTimer = null;
    Array.from(this.tabs.keys()).forEach((id) => this.closeTab(id));
    this.tabs.clear();
  }
}

module.exports = { TabManager, isDatLoginUrl };
