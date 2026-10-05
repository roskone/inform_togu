'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  fetchPage: (url) => ipcRenderer.invoke('page:fetch', url),
  renderPage: (url) => ipcRenderer.invoke('page:render', url),
  loadState: () => ipcRenderer.invoke('state:load'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  saveCache: (cache) => ipcRenderer.invoke('cache:save', cache),
  setTheme: (theme) => ipcRenderer.invoke('theme:set', theme),
  exportDebug: (payload) => ipcRenderer.invoke('debug:export', payload),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, action) => cb(action)),
});
