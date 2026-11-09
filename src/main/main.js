'use strict';
// Discshelf main process: window, menus, the discshelf:// protocol for audio and artwork, and IPC.
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, protocol, nativeTheme, screen, net, clipboard, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { Library } = require('./library');
const { AUDIO_EXTENSIONS } = require('./tags');
const { Online, sniffImage } = require('./online');
const { Lastfm } = require('./lastfm');

const SMOKE_TEST = process.argv.includes('--smoke-test');
const APP_ID = 'com.bytehawkstudio.discshelf';

app.setName('Discshelf');
// --data-dir=<folder> keeps the library somewhere else (used by tests and the release smoke test).
const dataDirArg = process.argv.find((a) => a.startsWith('--data-dir='));
if (dataDirArg) app.setPath('userData', path.resolve(dataDirArg.slice('--data-dir='.length)));
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

protocol.registerSchemesAsPrivileged([
  { scheme: 'discshelf', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

if (!SMOKE_TEST && !app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;
let library = null;
let settings = {};
let settingsFile = '';
const online = new Online((url, opts) => net.fetch(url, opts));
let lastfm = null;

// ------------------------------------------------------------------ Last.fm keys + session

/** The app's Last.fm API key: built in by the release workflow (lastfm-key.json), from the environment,
 *  or entered in Settings. */
const builtInLastfmKeys = (() => {
  try {
    const k = JSON.parse(fs.readFileSync(path.join(__dirname, 'lastfm-key.json'), 'utf8'));
    if (k.apiKey && k.secret) return k;
  } catch { /* not built in */ }
  if (process.env.DISCSHELF_LASTFM_KEY && process.env.DISCSHELF_LASTFM_SECRET) {
    return { apiKey: process.env.DISCSHELF_LASTFM_KEY, secret: process.env.DISCSHELF_LASTFM_SECRET };
  }
  return null;
})();

function lastfmKeys() {
  const own = settings.lastfmOwnKeys;
  if (own && own.apiKey && own.secret) return own;
  return builtInLastfmKeys;
}

function getLastfmSession() {
  const s = settings.lastfmSession;
  if (!s || !s.name || !s.key) return null;
  if (!s.enc) return { name: s.name, key: s.key };
  try { return { name: s.name, key: safeStorage.decryptString(Buffer.from(s.key, 'base64')) }; } catch { return null; }
}

function setLastfmSession(session) {
  if (!session) settings.lastfmSession = null;
  else if (safeStorage.isEncryptionAvailable()) {
    settings.lastfmSession = { name: session.name, key: safeStorage.encryptString(session.key).toString('base64'), enc: true };
  } else {
    settings.lastfmSession = { name: session.name, key: session.key, enc: false };
  }
  saveSettings(true);
}

// ------------------------------------------------------------------ settings

const EQ_BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const DEFAULT_SETTINGS = {
  style: 'modern', // modern | classic (Songbird)
  theme: 'system', // system | light | dark  (light/dark mode)
  eq: { enabled: false, preset: 'Flat', preamp: 0, bands: EQ_BANDS.map(() => 0) },
  rescanOnStart: true,
  resumeOnStart: true,
  onlineLookup: true,
  albumSort: 'artist',
  scrobble: true,
  lastfmSession: null, // {name, key, enc}
  lastfmOwnKeys: null, // {apiKey, secret} entered in Settings when this build has no key
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
  // 0.1.0 had a single "classic" theme (dark): it's now the Classic style in dark mode.
  if (settings.theme === 'classic') { settings.style = 'classic'; settings.theme = 'dark'; }
  if (!['modern', 'classic'].includes(settings.style)) settings.style = 'modern';
  if (!['system', 'light', 'dark'].includes(settings.theme)) settings.theme = 'system';
  const eq = settings.eq || {};
  settings.eq = {
    enabled: !!eq.enabled,
    preset: typeof eq.preset === 'string' ? eq.preset : 'Flat',
    preamp: Number.isFinite(eq.preamp) ? eq.preamp : 0,
    bands: EQ_BANDS.map((_, i) => (Array.isArray(eq.bands) && Number.isFinite(eq.bands[i]) ? eq.bands[i] : 0)),
  };
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
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)), {
    status: 200,
    headers: { 'Content-Type': type, 'Content-Length': String(st.size), 'Accept-Ranges': 'bytes', 'Cache-Control': 'max-age=31536000', 'Access-Control-Allow-Origin': '*' },
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
  if (settings.theme === 'dark') return true;
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
  const radio = (key, id, label) => ({
    label, type: 'radio', checked: settings[key] === id,
    click: () => { settings[key] = id; saveSettings(); command('appearance', { style: settings.style, theme: settings.theme }); },
  });
  const styles = [radio('style', 'modern', 'Modern'), radio('style', 'classic', 'Classic (Songbird)')];
  const modes = [radio('theme', 'system', 'Follow Windows'), radio('theme', 'light', 'Light'), radio('theme', 'dark', 'Dark')];
  const menus = {
    appearance: [...styles, { type: 'separator' }, ...modes],
    file: [
      { label: 'Add Folder to Library…', accelerator: 'CmdOrCtrl+O', click: () => addFolderDialog() },
      { label: 'Add Files to Library…', accelerator: 'CmdOrCtrl+Shift+O', click: () => addFilesDialog() },
      { label: 'Rescan Library', accelerator: 'F5', click: () => library.scan() },
      { label: 'Find Missing Album Artwork…', click: () => command('findMissingArt') },
      { type: 'separator' },
      { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => command('settings') },
      { type: 'separator' },
      { label: 'Exit', click: () => app.quit() },
    ],
    view: [
      { label: 'Songs', click: () => command('view', 'music') },
      { label: 'Albums', click: () => command('view', 'albums') },
      { type: 'separator' },
      { label: 'Style', submenu: styles },
      { label: 'Light / Dark', submenu: modes },
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
      { type: 'separator' },
      { label: 'Equalizer…', click: () => command('equalizer') },
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
      { label: one ? 'Get Info' : `Get Info (${ids.length} Songs)`, accelerator: 'CmdOrCtrl+I', click: () => command('getInfo', ids) },
      { label: 'Go to Album', enabled: one, click: () => command('goToAlbum', ids[0]) },
      { label: 'Show in Explorer', enabled: one, click: () => { const t = library.get(ids[0]); if (t) shell.showItemInFolder(t.path); } },
      { type: 'separator' },
      { label: one ? 'Remove from Library' : `Remove ${ids.length} Songs from Library`, click: () => command('confirmRemove', ids) },
    ]);
    m.popup({ window: win, x: Math.round(x), y: Math.round(y) });
  });
  ipcMain.handle('menu:albumContext', (_e, { ids, title, x, y }) => {
    if (!win || !Array.isArray(ids) || !ids.length) return;
    const m = Menu.buildFromTemplate([
      { label: 'Play Album', click: () => command('playIds', ids) },
      { label: 'Shuffle Album', click: () => command('shuffleIds', ids) },
      { type: 'separator' },
      { label: 'Get Info', click: () => command('getInfo', ids) },
      { label: 'Show in Explorer', click: () => { const t = library.get(ids[0]); if (t) shell.showItemInFolder(t.path); } },
      { type: 'separator' },
      { label: `Remove “${String(title || 'Album').slice(0, 40)}” from Library`, click: () => command('confirmRemove', ids) },
    ]);
    m.popup({ window: win, x: Math.round(x), y: Math.round(y) });
  });

  // ---- Get Info: details + artwork
  const toWire = (img) => (img ? { mime: img.mime, base64: img.data.toString('base64') } : null);
  const fromWire = (img) => {
    if (img === null) return null; // remove artwork
    if (!img || typeof img.base64 !== 'string') return undefined; // unchanged
    const data = Buffer.from(img.base64, 'base64');
    const mime = sniffImage(data);
    if (!mime) throw new Error('That isn\'t a supported image (JPEG, PNG, GIF or WebP)');
    return { mime, data };
  };
  ipcMain.handle('track:save', async (_e, { ids, fields, art }) => {
    if (!Array.isArray(ids) || !ids.length) return 0;
    return library.updateTracks(ids, fields || {}, fromWire(art));
  });
  ipcMain.handle('art:openFile', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose artwork', properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] }],
    });
    if (r.canceled || !r.filePaths.length) return null;
    const data = await fs.promises.readFile(r.filePaths[0]);
    if (data.length > 20 * 1024 * 1024) throw new Error('That image is too large (over 20 MB)');
    const mime = sniffImage(data);
    if (!mime) throw new Error('That isn\'t a supported image (JPEG, PNG, GIF or WebP)');
    return toWire({ mime, data });
  });
  ipcMain.handle('art:paste', () => {
    const img = clipboard.readImage();
    if (img.isEmpty()) return null;
    return toWire({ mime: 'image/png', data: img.toPNG() });
  });
  ipcMain.handle('online:search', async (_e, { term, kind }) => {
    if (!settings.onlineLookup) throw new Error('Online lookups are turned off in Settings');
    return online.search(term, kind);
  });
  ipcMain.handle('online:image', async (_e, url) => {
    if (!settings.onlineLookup) throw new Error('Online lookups are turned off in Settings');
    return toWire(await online.downloadImage(url));
  });
  ipcMain.handle('art:findMissing', () => findMissingArt());
  ipcMain.handle('app:openData', () => shell.openPath(app.getPath('userData')));

  // ---- Last.fm
  const lfStatus = () => ({ ...lastfm.status(), builtInKey: !!builtInLastfmKeys, scrobble: settings.scrobble });
  ipcMain.handle('lastfm:status', () => lfStatus());
  ipcMain.handle('lastfm:connect', async () => {
    const url = await lastfm.beginAuth();
    shell.openExternal(url);
    return lfStatus();
  });
  ipcMain.handle('lastfm:cancel', () => { lastfm.cancelAuth(); return lfStatus(); });
  ipcMain.handle('lastfm:disconnect', () => { lastfm.disconnect(); return lfStatus(); });
  ipcMain.handle('lastfm:setKeys', (_e, keys) => {
    const apiKey = String(keys?.apiKey || '').trim();
    const secret = String(keys?.secret || '').trim();
    settings.lastfmOwnKeys = apiKey && secret ? { apiKey, secret } : null;
    saveSettings(true);
    return lfStatus();
  });
  ipcMain.handle('lastfm:nowPlaying', (_e, id) => {
    const t = library.get(id);
    if (t && settings.scrobble) lastfm.nowPlaying(t);
  });
  ipcMain.handle('lastfm:scrobble', (_e, { id, startedAt }) => {
    const t = library.get(id);
    if (!t || !settings.scrobble || !Number.isFinite(startedAt)) return false;
    return lastfm.scrobble(t, startedAt);
  });
  ipcMain.handle('art:cancelFind', () => { if (artJob) artJob.cancelled = true; });
}

// ------------------------------------------------------------------ missing artwork finder

let artJob = null;
async function findMissingArt() {
  if (artJob) return { busy: true };
  if (!settings.onlineLookup) throw new Error('Online lookups are turned off in Settings');
  const albums = library.albumsMissingArt();
  const job = { cancelled: false, total: albums.length, done: 0, found: 0, current: '' };
  artJob = job;
  const report = (finished = false) => send('art:progress', { ...job, finished });
  report();
  try {
    for (const a of albums) {
      if (job.cancelled) break;
      job.current = `${a.album}${a.artist ? ` — ${a.artist}` : ''}`;
      report();
      try {
        const match = await online.findAlbumCover(a.artist, a.album);
        if (match) {
          const img = await online.downloadImage(match.artwork);
          await library.setArtwork(a.ids, img);
          job.found++;
        }
      } catch (err) {
        console.error('artwork lookup failed for', job.current, err.message);
      }
      job.done++;
      // Be gentle with the free search services (iTunes allows about 20 searches a minute).
      if (!job.cancelled && job.done < albums.length) await new Promise((r) => setTimeout(r, 3000));
    }
  } finally {
    artJob = null;
    report(true);
  }
  return { ...job };
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
  lastfm = new Lastfm({
    fetch: (url, opts) => net.fetch(url, opts),
    dataDir: app.getPath('userData'),
    getKeys: lastfmKeys,
    getSession: getLastfmSession,
    setSession: setLastfmSession,
  });
  lastfm.on('status', (st) => send('lastfm:status', { ...st, builtInKey: !!builtInLastfmKeys, scrobble: settings.scrobble }));
  lastfm.on('authError', (msg) => send('lastfm:error', msg));
  if (!SMOKE_TEST) {
    setTimeout(() => lastfm.flush(), 8000);
    setInterval(() => lastfm.flush(), 10 * 60 * 1000);
  }
  library.on('changed', (c) => send('library:changed', c));
  nativeTheme.on('updated', () => send('theme:system', nativeTheme.shouldUseDarkColors));

  Menu.setApplicationMenu(null);
  registerProtocol();
  registerIpc();
  createWindow();
  // Pick up music added to the watched folders while Discshelf was closed.
  if (settings.rescanOnStart && library.folders.length && !SMOKE_TEST) {
    win.webContents.once('did-finish-load', () => setTimeout(() => library.scan(), 1500));
  }
});

app.on('before-quit', () => {
  if (library) { library.cancelScan(); library.saveNow(); }
  saveSettings(true);
});

app.on('window-all-closed', () => app.quit());
