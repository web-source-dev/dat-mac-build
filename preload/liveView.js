'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('liveView', {
  onBegin: (callback) => ipcRenderer.on('live-begin', (_event, payload) => callback(payload)),
  onAnswer: (callback) => ipcRenderer.on('live-answer', (_event, sdp) => callback(sdp)),
  onSwitch: (callback) => ipcRenderer.on('live-switch', (_event, payload) => callback(payload)),
  onStop: (callback) => ipcRenderer.on('live-stop', () => callback()),
  sendOffer: (sdp) => ipcRenderer.send('live-offer', sdp),
  sendFailed: (message) => ipcRenderer.send('live-failed', message)
});
