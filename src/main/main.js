'use strict';
// Discshelf main process: window, menus, the discshelf:// protocol for audio and artwork, and IPC.
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, protocol, nativeTheme, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { Library } = require('./library');
const { AUDIO_EXTENSIONS } = require('./tags');

const SMOKE_TEST = process.argv.includes('--smoke-test');
const APP_ID = 'com.bytehawkstudio.discshelf';

app.setName('Discshelf');
// --data-dir=<folder> keeps the library somewhere else (used by tests and the release smoke test).
const dataDirArg = process.argv.find((a) => a.startsWith('--data-dir='));
if (dataDirArg) app.setPath('userData', path.resolve(dataDirArg.slice('--data-dir='.length)));
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

protocol.registerSchemesAsPrivileged([
  { scheme: 'discshelf', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

if (!SMOKE_TEST && !app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;
let library = null;
let settings = {};
let settingsFile = '';

// ------------------------------------------------------------------ settings

const DEFAULT_SETTINGS = {
  theme: 'system', // system | light | dark | classic
  volume: 0.8,
  muted: false,
  shuffle: false,
  repeat: 'off', // off | all | one
  showFilters: true,
  showArtPane: true,
  sidebarWidth: 220,
  artPaneWidth: 260,
  filterHeight: 190,
  sort: { key: 'artist', dir: 1 },
  lastTrackId: null,
  lastPosition: 0,
  bounds: null,
  maximized: false,
};

function loadSettings() {
  settingsFile = path.join(app.getPath('userData'), 'settings.json');
  try {
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) };
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
}

let settingsTimer = null;
function saveSettings(now = false) {
  clearTimeout(settingsTimer);
  const write = () => {
    try { fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2)); } catch (err) { console.error(err); }
  };
  if (now) write(); else settingsTimer = setTimeout(write, 500);
}

// ------------------------------------------------------------------ protocol

const MIME = {
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.m4b': 'audio/mp4', '.mp4': 'audio/mp4', '.aac': 'audio/aac',
  '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
};

/** Serves a file with HTTP range support so the audio element can seek. */
async function serveFile(file, request) {
  let st;
  try { st = await fs.promises.stat(file); } catch { return new Response('Not found', { status: 404 }); }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = request.headers.get('range');
  const m = range && /bytes=(\d*)-(\d*)/.exec(range);
  if (m && (m[1] || m[2])) {
    let start = m[1] ? parseInt(m[1], 10) : st.size - parseInt(m[2], 10);
    let end = m[1] && m[2] ? parseInt(m[2], 10) : st.size - 1;
    start = Math.max(0, start);
    end = Math.min(end, st.size - 1);
    if (start > end || start >= st.size) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${st.size}` } });
    }
    const stream = fs.createReadStream(file, { start, end });
    return new Response(Readable.toWeb(stream), {
      status: 206,
      headers: {
        'Content-Type': type,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${st.size}`,
        'Accept-Ranges': 'bytes',
      },
    });
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)), {
    status: 200,
    headers: { 'Content-Type': type, 'Content-Length': String(st.size), 'Accept-Ranges': 'bytes', 'Cache-Control': 'max-age=31536000' },
  });
}

function registerProtocol() {
  protocol.handle('discshelf', async (request) => {
    const url = new URL(request.url);
    const name = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    if (url.host === 'media') {
      const track = library.get(name);
      if (!track) return new Response('Not in library', { status: 404 });
      return serveFile(track.path, request);
    }
    if (url.host === 'art') {
      const file = library.artPath(name);
      if (!file) return new Response('Not found', { status: 404 });
      return serveFile(file, request);
    }
    return new Response('Not found', { status: 404 });
  });
}

// ------------------------------------------------------------------ window

function themeIsDark() {
  if (settings.theme === 'dark' || settings.theme === 'classic') return true;
  if (settings.theme === 'light') return false;
  return nativeTheme.shouldUseDarkColors;
}

function initialBounds() {
  const b = settings.bounds;
  if (b && Number.isFinite(b.width) && Number.isFinite(b.height)) {
    // Only reuse saved bounds if they're still on a screen.
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return b.x < a.x + a.width - 80 && b.x + b.width > a.x + 80 && b.y >= a.y - 10 && b.y < a.y + a.height - 60;
    });
    if (visible) return b;
  }
  return { width: 1280, height: 800 };
}

function createWindow() {
  const dark = themeIsDark();
  win = new BrowserWindow({
    ...initialBounds(),
    minWidth: 860,
    minHeight: 540,
    title: 'Discshelf',
    show: false,
    backgroundColor: dark ? '#1b1c1f' : '#f4f4f2',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: dark ? '#1b1c1f' : '#f4f4f2', symbolColor: dark ? '#e8e8e8' : '#1d1d1f', height: 34 },
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  if (settings.maximized && !SMOKE_TEST) win.maximize();

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => { if (!SMOKE_TEST) win.show(); });

  // Links never open inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  const rememberBounds = () => {
    if (!win || win.isDestroyed()) return;
    settings.maximized = win.isMaximized();
    if (!settings.maximized && !win.isMinimized()) settings.bounds = win.getBounds();
    saveSettings();
  };
  win.on('resize', rememberBounds);
  win.on('move', rememberBounds);
  win.on('close', () => { rememberBounds(); saveSettings(true); });
  win.on('closed', () => { win = null; });

  if (SMOKE_TEST) runSmokeTest();
}

/** Used by the release workflow: the window must load and the UI must render, then the app exits. */
function runSmokeTest() {
  const fail = (why) => { console.error('SMOKE TEST FAILED:', why); app.exit(1); };
  const timeout = setTimeout(() => fail('timed out'), 30000);
  win.webContents.on('render-process-gone', (_e, d) => fail(`renderer gone: ${d.reason}`));
  win.webContents.on('did-fail-load', (_e, code, desc) => fail(`load failed: ${code} ${desc}`));
  win.webContents.on('did-finish-load', async () => {
    try {
      await new Promise((r) => setTimeout(r, 1500));
      const ok = await win.webContents.executeJavaScript(
        "!!(window.__discshelfReady && document.querySelector('#tracklist') && document.querySelector('#player'))",
      );
      clearTimeout(timeout);
      if (!ok) return fail('UI did not render');
      console.log('SMOKE TEST OK');
      app.exit(0);
    } catch (err) {
      fail(err.message);
    }
  });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ------------------------------------------------------------------ menus

function command(name, arg) {
  send('command', { name, arg });
}

function buildMenu(name) {
  const t = settings.theme;
  const themeItem = (id, label) => ({
    label, type: 'radio', checked: t === id,
    click: () => { settings.theme = id; saveSettings(); command('theme', id); },
  });
  const themes = [themeItem('system', 'Follow Windows'), themeItem('light', 'Light'), themeItem('dark', 'Dark'), themeItem('classic', 'Classic (Songbird colors)')];
  const menus = {
    theme: themes,
    file: [
      { label: 'Add Folder to Library…', accelerator: 'CmdOrCtrl+O', click: () => addFolderDialog() },
      { label: 'Add Files to Library…', accelerator: 'CmdOrCtrl+Shift+O', click: () => addFilesDialog() },
      { label: 'Rescan Library', accelerator: 'F5', click: () => library.scan() },
      { label: 'Manage Music Folders…', click: () => command('manageFolders') },
      { type: 'separator' },
      { label: 'Exit', click: () => app.quit() },
    ],
    view: [
      { label: 'Theme', submenu: themes },
      { type: 'separator' },
      { label: 'Filter Panes (Genre, Artist, Album)', type: 'checkbox', checked: settings.showFilters, click: (i) => command('showFilters', i.checked) },
      { label: 'Album Art Pane', type: 'checkbox', checked: settings.showArtPane, click: (i) => command('showArtPane', i.checked) },
      { type: 'separator' },
      { label: 'Find in Library', accelerator: 'CmdOrCtrl+F', click: () => command('focusSearch') },
      { label: 'Go to Now Playing', accelerator: 'CmdOrCtrl+L', click: () => command('revealPlaying') },
    ],
    playback: [
      { label: 'Play / Pause', click: () => command('playPause') },
      { label: 'Next Track', click: () => command('next') },
      { label: 'Previous Track', click: () => command('prev') },
      { type: 'separator' },
      { label: 'Shuffle', type: 'checkbox', checked: settings.shuffle, click: () => command('toggleShuffle') },
      {
        label: 'Repeat',
        submenu: [
          { label: 'Off', type: 'radio', checked: settings.repeat === 'off', click: () => command('repeat', 'off') },
          { label: 'All', type: 'radio', checked: settings.repeat === 'all', click: () => command('repeat', 'all') },
          { label: 'One', type: 'radio', checked: settings.repeat === 'one', click: () => command('repeat', 'one') },
        ],
      },
    ],
    help: [
      { label: 'Keyboard Shortcuts', click: () => command('shortcuts') },
      { label: 'Open Data Folder', click: () => shell.openPath(app.getPath('userData')) },
      { type: 'separator' },
      { label: 'About Discshelf', click: () => command('about') },
    ],
  };
  return Menu.buildFromTemplate(menus[name] || []);
}

async function addFolderDialog() {
  const r = await dialog.showOpenDialog(win, { title: 'Add a music folder', properties: ['openDirectory', 'multiSelections'] });
  if (r.canceled || !r.filePaths.length) return null;
  return library.scan(r.filePaths);
}

async function addFilesDialog() {
  const extensions = [...AUDIO_EXTENSIONS].map((e) => e.slice(1));
  const r = await dialog.showOpenDialog(win, {
    title: 'Add music files',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Music', extensions }, { name: 'All files', extensions: ['*'] }],
  });
  if (r.canceled || !r.filePaths.length) return null;
  return library.scan(r.filePaths);
}

// ------------------------------------------------------------------ IPC

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    dataDir: app.getPath('userData'),
    musicDir: (() => { try { const d = app.getPath('music'); return fs.existsSync(d) ? d : null; } catch { return null; } })(),
    electron: process.versions.electron,
  }));
  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:set', (_e, patch) => {
    if (patch && typeof patch === 'object') {
      for (const [k, v] of Object.entries(patch)) if (k in DEFAULT_SETTINGS) settings[k] = v;
      saveSettings();
    }
    return settings;
  });
  ipcMain.handle('theme:system', () => nativeTheme.shouldUseDarkColors);
  ipcMain.handle('window:titlebar', (_e, colors) => {
    if (!win || process.platform === 'darwin') return;
    try { win.setTitleBarOverlay({ color: colors.color, symbolColor: colors.symbolColor, height: 34 }); } catch { /* unsupported */ }
    win.setBackgroundColor(colors.color);
  });

  ipcMain.handle('library:get', () => library.snapshot());
  ipcMain.handle('library:addFolder', () => addFolderDialog());
  ipcMain.handle('library:addFiles', () => addFilesDialog());
  ipcMain.handle('library:addMusicDir', () => library.scan([app.getPath('music')]));
  ipcMain.handle('library:addPaths', (_e, paths) => (Array.isArray(paths) && paths.length ? library.scan(paths.filter((p) => typeof p === 'string')) : null));
  ipcMain.handle('library:rescan', () => library.scan());
  ipcMain.handle('library:cancelScan', () => library.cancelScan());
  ipcMain.handle('library:removeFolder', (_e, folder) => library.removeFolder(String(folder)));
  ipcMain.handle('library:removeTracks', (_e, ids) => library.removeTracks(Array.isArray(ids) ? ids : []));
  ipcMain.handle('track:played', (_e, id) => library.markPlayed(id));
  ipcMain.handle('track:showInFolder', (_e, id) => {
    const t = library.get(id);
    if (t) shell.showItemInFolder(t.path);
  });

  ipcMain.handle('menu:popup', (_e, { name, x, y }) => {
    if (!win) return;
    buildMenu(name).popup({ window: win, x: Math.round(x), y: Math.round(y) });
  });
  ipcMain.handle('menu:trackContext', (_e, { ids, x, y }) => {
    if (!win || !Array.isArray(ids) || !ids.length) return;
    const one = ids.length === 1;
    const m = Menu.buildFromTemplate([
      { label: one ? 'Play' : `Play ${ids.length} Songs`, click: () => command('playIds', ids) },
      { type: 'separator' },
      { label: 'Show in Explorer', enabled: one, click: () => { const t = library.get(ids[0]); if (t) shell.showItemInFolder(t.path); } },
      { label: one ? 'Remove from Library' : `Remove ${ids.length} Songs from Library`, click: () => command('confirmRemove', ids) },
    ]);
    m.popup({ window: win, x: Math.round(x), y: Math.round(y) });
  });
}

// ------------------------------------------------------------------ startup

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(() => {
  loadSettings();
  library = new Library(app.getPath('userData'));
  library.load();
  library.on('progress', (p) => send('scan:progress', p));
  library.on('changed', (c) => send('library:changed', c));
  nativeTheme.on('updated', () => send('theme:system', nativeTheme.shouldUseDarkColors));

  Menu.setApplicationMenu(null);
  registerProtocol();
  registerIpc();
  createWindow();
});

app.on('before-quit', () => {
  if (library) { library.cancelScan(); library.saveNow(); }
  saveSettings(true);
});

app.on('window-all-closed', () => app.quit());
