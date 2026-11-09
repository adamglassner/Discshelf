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
  albumMenu: (ids, title, x, y) => ipcRenderer.invoke('menu:albumContext', { ids, title, x, y }),

  saveTracks: (ids, fields, art) => ipcRenderer.invoke('track:save', { ids, fields, art }),
  saveEach: (entries, art, artIds) => ipcRenderer.invoke('track:saveEach', { entries, art, artIds }),
  albumTracks: (ref, ids) => ipcRenderer.invoke('online:albumTracks', { ref, ids }),
  artistImage: (name) => ipcRenderer.invoke('online:artistImage', name),
  openArtFile: () => ipcRenderer.invoke('art:openFile'),
  pasteArt: () => ipcRenderer.invoke('art:paste'),
  searchOnline: (term, kind) => ipcRenderer.invoke('online:search', { term, kind }),
  fetchOnlineImage: (url) => ipcRenderer.invoke('online:image', url),
  findMissingArt: () => ipcRenderer.invoke('art:findMissing'),
  cancelFindArt: () => ipcRenderer.invoke('art:cancelFind'),
  openDataFolder: () => ipcRenderer.invoke('app:openData'),
  lastfmStatus: () => ipcRenderer.invoke('lastfm:status'),
  lastfmConnect: () => ipcRenderer.invoke('lastfm:connect'),
  lastfmCancel: () => ipcRenderer.invoke('lastfm:cancel'),
  lastfmDisconnect: () => ipcRenderer.invoke('lastfm:disconnect'),
  lastfmSetKeys: (keys) => ipcRenderer.invoke('lastfm:setKeys', keys),
  artistInfo: (name) => ipcRenderer.invoke('lastfm:artistInfo', name),
  lastfmNowPlaying: (id) => ipcRenderer.invoke('lastfm:nowPlaying', id),
  lastfmScrobble: (id, startedAt) => ipcRenderer.invoke('lastfm:scrobble', { id, startedAt }),
  radioSearch: (q) => ipcRenderer.invoke('radio:search', q),
  radioCountries: () => ipcRenderer.invoke('radio:countries'),
  radioClick: (id) => ipcRenderer.invoke('radio:click', id),
  radioStop: () => ipcRenderer.invoke('radio:stop'),
  onRadioTitle: on('radio:title'),
  onRadioError: on('radio:error'),
  onLastfmStatus: on('lastfm:status'),
  onLastfmError: on('lastfm:error'),
  onArtProgress: (fn) => { const h = (_e, p) => fn(p); ipcRenderer.on('art:progress', h); return () => ipcRenderer.removeListener('art:progress', h); },

  onCommand: on('command'),
  onScanProgress: on('scan:progress'),
  onLibraryChanged: on('library:changed'),
  onSystemTheme: on('theme:system'),
});
