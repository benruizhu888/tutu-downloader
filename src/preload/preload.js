'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** 只暴露必要通道，渲染层拿不到 Node / ipcRenderer 原件 */
const EVENTS = ['parse:progress', 'detail:progress', 'download:event', 'platform:ready', 'view:parse-request'];

contextBridge.exposeInMainWorld('tutu', {
  info: () => ipcRenderer.invoke('app:info'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  pickDir: () => ipcRenderer.invoke('dialog:pick-dir'),

  selectPlatform: (id) => ipcRenderer.invoke('platform:select', id),
  setBounds: (rect) => ipcRenderer.invoke('platform:bounds', rect),
  hideView: () => ipcRenderer.invoke('platform:hide'),
  showView: () => ipcRenderer.invoke('platform:show'),
  reloadPage: (id) => ipcRenderer.invoke('platform:reload', id),
  goHome: (id) => ipcRenderer.invoke('platform:home', id),
  loginState: (id) => ipcRenderer.invoke('platform:login-state', id),
  previewItem: (platformId, url, itemId) => ipcRenderer.invoke('platform:preview', { platformId, url, itemId }),

  parse: (platformId, url) => ipcRenderer.invoke('platform:parse', { platformId, url }),
  stopParse: (platformId) => ipcRenderer.invoke('platform:stop', platformId),
  resolveDetails: (platformId, items, opts) => ipcRenderer.invoke('platform:details', { platformId, items, ...(opts || {}) }),

  download: (platformId, items, dir) => ipcRenderer.invoke('download:start', { platformId, items, dir }),
  cancelDownload: () => ipcRenderer.invoke('download:cancel'),

  openPath: (p) => ipcRenderer.invoke('shell:open-path', p),
  openUrl: (u) => ipcRenderer.invoke('shell:open-url', u),

  windowControl: (action) => ipcRenderer.invoke('window:control', action),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),

  on: (channel, cb) => {
    if (!EVENTS.includes(channel)) return () => {};
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
