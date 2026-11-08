'use strict';
// The renderer's only door into the main process.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (fn) => {
  const handler = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('discshelf', {
  info: () => ipcRenderer.invoke('app:info'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  systemDark: () => ipcRenderer.invoke('theme:system'),
  setTitleBar: (colors) => ipcRenderer.invoke('window:titlebar', colors),

  getLibrary: () => ipcRenderer.invoke('library:get'),
  addFolder: () => ipcRenderer.invoke('library:addFolder'),
  addFiles: () => ipcRenderer.invoke('library:addFiles'),
  addMusicDir: () => ipcRenderer.invoke('library:addMusicDir'),
  addDropped: (files) => ipcRenderer.invoke('library:addPaths', [...files].map((f) => webUtils.getPathForFile(f)).filter(Boolean)),
  rescan: () => ipcRenderer.invoke('library:rescan'),
  cancelScan: () => ipcRenderer.invoke('library:cancelScan'),
  removeFolder: (folder) => ipcRenderer.invoke('library:removeFolder', folder),
  removeTracks: (ids) => ipcRenderer.invoke('library:removeTracks', ids),
  markPlayed: (id) => ipcRenderer.invoke('track:played', id),
  showInFolder: (id) => ipcRenderer.invoke('track:showInFolder', id),

  popupMenu: (name, x, y) => ipcRenderer.invoke('menu:popup', { name, x, y }),
  trackMenu: (ids, x, y) => ipcRenderer.invoke('menu:trackContext', { ids, x, y }),

  onCommand: on('command'),
  onScanProgress: on('scan:progress'),
  onLibraryChanged: on('library:changed'),
  onSystemTheme: on('theme:system'),
});
