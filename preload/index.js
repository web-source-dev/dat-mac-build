const { contextBridge, ipcRenderer, shell } = require('electron');
const { electronAPI } = require('@electron-toolkit/preload');

const api = {
  login: (payload) => ipcRenderer.invoke('login', payload),
  getCurrentUser: () => ipcRenderer.invoke('get-current-user'),
  logout: () => ipcRenderer.invoke('logout'),
  openDat: () => ipcRenderer.invoke('open-dat'),
  sendScreenReport: (payload) => ipcRenderer.invoke('send-screen-report', payload),
  getReportSettings: () => ipcRenderer.invoke('get-report-settings'),
  setReportSettings: (payload) => ipcRenderer.invoke('set-report-settings', payload),
  openCustomTab: (tab) => ipcRenderer.invoke('open-custom-tab', tab),
  getUserProxy: () => ipcRenderer.invoke('get-user-proxy'),
  setUserProxy: (payload) => ipcRenderer.invoke('set-user-proxy', payload),
  clearUserProxy: () => ipcRenderer.invoke('clear-user-proxy'),
  verifyProxyPanelPassword: (password) =>
    ipcRenderer.invoke('verify-proxy-panel-password', password),
  verifyServerPanelPassword: (password) =>
    ipcRenderer.invoke('verify-server-panel-password', password),
  getCustomServerStatus: () => ipcRenderer.invoke('get-custom-server-status'),
  setCustomServer: (url) => ipcRenderer.invoke('set-custom-server', url),
  setCustomServerEnabled: (enabled) =>
    ipcRenderer.invoke('set-custom-server-enabled', enabled),
  clearCustomServer: () => ipcRenderer.invoke('clear-custom-server'),
  getExtensionsStatus: () => ipcRenderer.invoke('get-extensions-status'),
  prefetchExtensions: () => ipcRenderer.invoke('prefetch-extensions'),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  getUpdateMsg: () => ipcRenderer.invoke('get-update-msg'),
  onUpdateMsg: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('update-msg', listener);
    return () => ipcRenderer.removeListener('update-msg', listener);
  },
  onToggleProxyPanel: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('toggle-proxy-panel', listener);
    return () => ipcRenderer.removeListener('toggle-proxy-panel', listener);
  },
  onToggleServerPanel: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('toggle-server-panel', listener);
    return () => ipcRenderer.removeListener('toggle-server-panel', listener);
  }
};

const dslbSession = {
  newTab: () => ipcRenderer.invoke('tab:new'),
  switchTab: (tabId) => ipcRenderer.invoke('tab:switch', tabId),
  closeTab: (tabId) => ipcRenderer.invoke('tab:close', tabId),
  getAllTabs: () => ipcRenderer.invoke('tab:get-all'),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  setReportChrome: (open) => ipcRenderer.invoke('report-chrome', Boolean(open)),
  onTabsUpdate: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('tab:update', listener);
    return () => ipcRenderer.removeListener('tab:update', listener);
  },
  onLoading: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('dat:loading', listener);
    return () => ipcRenderer.removeListener('dat:loading', listener);
  }
};

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('electron', {
    ...electronAPI,
    shell: { openExternal: (url) => shell.openExternal(url) },
    openGoogleOAuth: (url) => ipcRenderer.invoke('open-google-oauth', url),
    openExternalUrl: (url) => ipcRenderer.invoke('open-external-url', url),
    verifySmtp: (config) => ipcRenderer.invoke('verify-smtp', config),
    sendSmtp: (config) => ipcRenderer.invoke('send-smtp', config),
    ipcRenderer: {
      invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
      on: (channel, listener) => {
        const subscription = (_event, ...payload) => listener(_event, ...payload);
        ipcRenderer.on(channel, subscription);
        return () => ipcRenderer.removeListener(channel, subscription);
      }
    }
  });
  contextBridge.exposeInMainWorld('api', api);
  contextBridge.exposeInMainWorld('dslbSession', dslbSession);
} else {
  window.electron = {
    ...electronAPI,
    shell: { openExternal: (url) => shell.openExternal(url) },
    openGoogleOAuth: (url) => ipcRenderer.invoke('open-google-oauth', url),
    openExternalUrl: (url) => ipcRenderer.invoke('open-external-url', url),
    verifySmtp: (config) => ipcRenderer.invoke('verify-smtp', config),
    sendSmtp: (config) => ipcRenderer.invoke('send-smtp', config),
    ipcRenderer: {
      invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
      on: (channel, listener) => ipcRenderer.on(channel, listener)
    }
  };
  window.api = api;
  window.dslbSession = dslbSession;
}
