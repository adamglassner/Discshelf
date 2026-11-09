'use strict';
// Discshelf main process: window, menus, the discshelf:// protocol for audio and artwork, and IPC.
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, protocol, nativeTheme, screen, net, clipboard, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { Library } = require('./library');
const { AUDIO_EXTENSIONS } = require('./tags');
const { writeTags } = require('./tags/writer');
const { Online, sniffImage, matchTracks } = require('./online');
const { Lastfm } = require('./lastfm');
const { RadioBrowser, icyStripper, firstPlaylistUrl } = require('./radio');
const { Lyrics } = require('./lyrics');

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
let radio = null;
let lyrics = null;
let radioStream = null; // AbortController of the station being played (one at a time)
const userAgent = () => `Discshelf/${app.getVersion()} (Bytehawk Studio; https://github.com/adamglassner/discshelf)`;

/** Relays a radio station to the player: follows playlists, strips ICY metadata, reports song titles. */
async function serveRadio(url) {
  let target = url.searchParams.get('u') || '';
  const id = url.searchParams.get('s') || '';
  if (!/^https?:\/\//i.test(target)) return new Response('Bad station address', { status: 400 });
  if (radioStream) radioStream.abort();
  const ctl = new AbortController();
  radioStream = ctl;
  try {
    let res = null;
    for (let hop = 0; hop < 3; hop++) {
      res = await net.fetch(target, { headers: { 'Icy-MetaData': '1', 'User-Agent': userAgent() }, signal: ctl.signal });
      const type = (res.headers.get('content-type') || '').toLowerCase();
      // Some stations hand out a playlist (.pls/.m3u) instead of the stream itself.
      if (res.ok && /mpegurl|scpls|x-pls|text\/plain|text\/html/.test(type) && !/audio\/(mpeg|aac|ogg)/.test(type)) {
        const next = firstPlaylistUrl(await res.text());
        if (!next) break;
        target = next;
        continue;
      }
      break;
    }
    if (!res.ok) { send('radio:error', { id, message: `The station answered with an error (HTTP ${res.status}).` }); return new Response('Station error', { status: 502 }); }
    const type = res.headers.get('content-type') || 'audio/mpeg';
    const metaint = parseInt(res.headers.get('icy-metaint') || '0', 10);
    const name = res.headers.get('icy-name');
    if (name) send('radio:title', { id, title: null, stationName: name });
    const body = metaint > 0 ? res.body.pipeThrough(icyStripper(metaint, (title) => send('radio:title', { id, title }))) : res.body;
    return new Response(body, { status: 200, headers: { 'Content-Type': type.split(';')[0], 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
  } catch (err) {
    if (ctl.signal.aborted) return new Response('Stopped', { status: 499 });
    send('radio:error', { id, message: 'The station isn’t responding.' });
    return new Response('Station unreachable', { status: 502 });
  }
}

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
  writeTags: true, // save Get Info changes into the music files
  radioCountry: '',
  radioFavorites: [],
  radioRecent: [],
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
  upNext: [], // song ids lined up with Play Next / Add to Up Next
  queueSource: '',
  dupesIgnored: [], // duplicate groups marked "Not duplicates"
  albumColors: false, // tint the player with the colors of the album that's playing
  accent: '', // '' = the theme's own accent color
  lastSeenVersion: '', // shows What's New once after an update
  checkUpdates: true,
  crossfade: 0, // seconds; 0 = gapless, no crossfade
  leveling: 'off', // off | track | album
  levelPreamp: 0,
  lyricsOnline: true,
  visualizer: 'bars', // bars | wave | circle
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
  if (!['modern', 'classic', 'itunes'].includes(settings.style)) settings.style = 'modern';
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
    if (url.host === 'radio' && url.pathname === '/stream') return serveRadio(url);
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
  const styles = [radio('style', 'modern', 'Modern'), radio('style', 'classic', 'Classic (Songbird)'), radio('style', 'itunes', 'iTunes')];
  const modes = [radio('theme', 'system', 'Follow Windows'), radio('theme', 'light', 'Light'), radio('theme', 'dark', 'Dark')];
  const menus = {
    appearance: [...styles, { type: 'separator' }, ...modes],
    file: [
      { label: 'Add Folder to Library…', accelerator: 'CmdOrCtrl+O', click: () => addFolderDialog() },
      { label: 'Add Files to Library…', accelerator: 'CmdOrCtrl+Shift+O', click: () => addFilesDialog() },
      { label: 'Rescan Library', accelerator: 'F5', click: () => library.scan() },
      { label: 'Find Missing Album Artwork…', click: () => command('findMissingArt') },
      { type: 'separator' },
      { label: 'New Playlist…', accelerator: 'CmdOrCtrl+N', click: () => command('newPlaylist', []) },
      { label: 'Import Playlist (.m3u)…', click: () => importPlaylist() },
      { type: 'separator' },
      { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => command('settings') },
      { type: 'separator' },
      { label: 'Exit', click: () => app.quit() },
    ],
    view: [
      { label: 'Songs', click: () => command('view', 'music') },
      { label: 'Artists', click: () => command('view', 'artists') },
      { label: 'Albums', click: () => command('view', 'albums') },
      { label: 'Statistics', click: () => command('view', 'stats') },
      { label: 'Duplicates', click: () => command('view', 'dupes') },
      { label: 'Missing Info', click: () => command('view', 'missing') },
      { label: 'Radio', click: () => command('view', 'radio') },
      { type: 'separator' },
      { label: 'Style', submenu: styles },
      { label: 'Light / Dark', submenu: modes },
      { type: 'separator' },
      { label: 'Filter Panes (Genre, Artist, Album)', type: 'checkbox', checked: settings.showFilters, click: (i) => command('showFilters', i.checked) },
      { label: 'Album Art Pane', type: 'checkbox', checked: settings.showArtPane, click: (i) => command('showArtPane', i.checked) },
      { label: 'Lyrics', accelerator: 'CmdOrCtrl+Shift+L', click: () => command('showLyrics') },
      { label: 'Visualizer', accelerator: 'CmdOrCtrl+Shift+V', click: () => command('visualizer') },
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
      { label: 'Up Next', accelerator: 'CmdOrCtrl+U', click: () => command('toggleQueue') },
      {
        label: 'Sleep Timer',
        submenu: [
          ['off', 'Off'], ['15', '15 minutes'], ['30', '30 minutes'], ['45', '45 minutes'], ['60', '1 hour'], ['90', '1½ hours'],
          ['song', 'End of this song'], ['album', 'End of this album'],
        ].map(([v, label]) => ({ label, type: 'radio', checked: (sleepMode || 'off') === v, click: () => command('sleep', v) })),
      },
      { label: 'Equalizer…', click: () => command('equalizer') },
      { label: 'Crossfade & Volume Leveling…', click: () => command('settings', 'playback') },
    ],
    help: [
      { label: 'What’s New in Discshelf', click: () => command('whatsNew') },
      { label: 'Check for Updates…', click: () => command('checkUpdates') },
      { type: 'separator' },
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
  ipcMain.handle('track:played', (_e, { id, seconds }) => library.markPlayed(id, Number(seconds) || 0));
  ipcMain.handle('track:setLoudness', (_e, { id, lufs }) => library.setLoudness(id, lufs));
  ipcMain.handle('lyrics:get', async (_e, id) => {
    const t = library.get(id);
    if (!t) return { source: null };
    return lyrics.get(t, { online: settings.lyricsOnline !== false && settings.onlineLookup !== false });
  });
  ipcMain.handle('app:changelog', async () => {
    try { return await fs.promises.readFile(path.join(app.getAppPath(), 'CHANGELOG.md'), 'utf8'); } catch { return ''; }
  });
  ipcMain.handle('app:checkUpdate', async () => {
    const res = await net.fetch('https://api.github.com/repos/adamglassner/discshelf/releases/latest', {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': userAgent() },
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const r = await res.json();
    const asset = (r.assets || []).find((a) => /Setup\.exe$/i.test(a.name));
    return { version: String(r.tag_name || '').replace(/^v/, ''), url: r.html_url, download: asset ? asset.browser_download_url : null, notes: r.body || '' };
  });
  ipcMain.handle('app:openUrl', (_e, url) => { if (/^https:\/\//.test(String(url))) shell.openExternal(String(url)); });
  ipcMain.handle('track:showInFolder', (_e, id) => {
    const t = library.get(id);
    if (t) shell.showItemInFolder(t.path);
  });

  ipcMain.handle('menu:popup', (_e, { name, x, y }) => {
    if (!win) return;
    buildMenu(name).popup({ window: win, x: Math.round(x), y: Math.round(y) });
  });
  /** "Add to Playlist" submenu: every playlist, plus a new one made from these songs. */
  const playlistSubmenu = (ids, exceptId) => [
    { label: 'New Playlist…', click: () => command('newPlaylist', ids) },
    ...(library.playlists.length ? [{ type: 'separator' }] : []),
    ...library.playlists.filter((pl) => pl.id !== exceptId).map((pl) => ({ label: pl.name.slice(0, 60), click: () => command('addToPlaylist', { id: pl.id, ids }) })),
  ];
  const ratingSubmenu = (ids) => {
    const tracks = ids.map((id) => library.get(id)).filter(Boolean);
    const cur = tracks.length && tracks.every((t) => (t.rating || 0) === (tracks[0].rating || 0)) ? tracks[0].rating || 0 : -1;
    return [0, 1, 2, 3, 4, 5].map((r) => ({
      label: r ? '★'.repeat(r) + '☆'.repeat(5 - r) : 'None', type: 'radio', checked: cur === r,
      click: () => command('rate', { ids, rating: r }),
    }));
  };
  const loveItem = (ids) => {
    const allLoved = ids.every((id) => library.get(id)?.loved);
    return { label: allLoved ? 'Unlove' : 'Love', click: () => command('love', { ids, loved: !allLoved }) };
  };

  ipcMain.handle('menu:trackContext', (_e, { ids, x, y, playlistId }) => {
    if (!win || !Array.isArray(ids) || !ids.length) return;
    const one = ids.length === 1;
    const m = Menu.buildFromTemplate([
      { label: one ? 'Play' : `Play ${ids.length} Songs`, click: () => command('playIds', ids) },
      { label: 'Play Next', click: () => command('playNext', ids) },
      { label: 'Add to Up Next', click: () => command('addUpNext', ids) },
      { label: 'Add to Playlist', submenu: playlistSubmenu(ids, playlistId) },
      { type: 'separator' },
      loveItem(ids),
      { label: 'Rating', submenu: ratingSubmenu(ids) },
      { type: 'separator' },
      { label: one ? 'Get Info' : `Get Info (${ids.length} Songs)`, accelerator: 'CmdOrCtrl+I', click: () => command('getInfo', ids) },
      { label: 'Go to Album', enabled: one, click: () => command('goToAlbum', ids[0]) },
      { label: 'Go to Artist', enabled: one, click: () => command('goToArtist', ids[0]) },
      { label: 'Show in Explorer', enabled: one, click: () => { const t = library.get(ids[0]); if (t) shell.showItemInFolder(t.path); } },
      { type: 'separator' },
      ...(playlistId ? [{ label: one ? 'Remove from Playlist' : `Remove ${ids.length} Songs from Playlist`, click: () => command('removeFromPlaylist', { id: playlistId, ids }) }] : []),
      { label: one ? 'Remove from Library' : `Remove ${ids.length} Songs from Library`, click: () => command('confirmRemove', ids) },
    ]);
    m.popup({ window: win, x: Math.round(x), y: Math.round(y) });
  });
  ipcMain.handle('menu:albumContext', (_e, { ids, title, x, y }) => {
    if (!win || !Array.isArray(ids) || !ids.length) return;
    const m = Menu.buildFromTemplate([
      { label: 'Play', click: () => command('playIds', ids) },
      { label: 'Shuffle', click: () => command('shuffleIds', ids) },
      { label: 'Play Next', click: () => command('playNext', ids) },
      { label: 'Add to Up Next', click: () => command('addUpNext', ids) },
      { label: 'Add to Playlist', submenu: playlistSubmenu(ids) },
      { type: 'separator' },
      loveItem(ids),
      { label: 'Rating', submenu: ratingSubmenu(ids) },
      { type: 'separator' },
      { label: 'Get Info', click: () => command('getInfo', ids) },
      { label: 'Show in Explorer', click: () => { const t = library.get(ids[0]); if (t) shell.showItemInFolder(t.path); } },
      { type: 'separator' },
      { label: `Remove “${String(title || 'Album').slice(0, 40)}” from Library`, click: () => command('confirmRemove', ids) },
    ]);
    m.popup({ window: win, x: Math.round(x), y: Math.round(y) });
  });
  ipcMain.handle('menu:playlistContext', (_e, { id, x, y }) => {
    const pl = library.playlists.find((p) => p.id === id);
    if (!win || !pl) return;
    const m = Menu.buildFromTemplate([
      { label: 'Play', enabled: pl.ids.length > 0, click: () => command('playIds', pl.ids) },
      { label: 'Shuffle', enabled: pl.ids.length > 0, click: () => command('shuffleIds', pl.ids) },
      { label: 'Add to Up Next', enabled: pl.ids.length > 0, click: () => command('addUpNext', pl.ids) },
      { type: 'separator' },
      { label: 'Rename…', click: () => command('renamePlaylist', id) },
      { label: 'Duplicate', click: () => { library.createPlaylist(`${pl.name} copy`, pl.ids); } },
      { label: 'Export as .m3u…', click: () => exportPlaylist(id) },
      { type: 'separator' },
      { label: 'Delete Playlist…', click: () => command('deletePlaylist', id) },
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

  // ---- playlists
  ipcMain.handle('playlist:create', (_e, { name, ids }) => library.createPlaylist(name, Array.isArray(ids) ? ids : []));
  ipcMain.handle('playlist:rename', (_e, { id, name }) => library.renamePlaylist(id, name));
  ipcMain.handle('playlist:delete', (_e, id) => library.deletePlaylist(id));
  ipcMain.handle('playlist:add', (_e, { id, ids, position }) => library.addToPlaylist(id, Array.isArray(ids) ? ids : [], position ?? null));
  ipcMain.handle('playlist:set', (_e, { id, ids }) => library.setPlaylistIds(id, Array.isArray(ids) ? ids : []));
  ipcMain.handle('playlist:import', () => importPlaylist());
  ipcMain.handle('playlist:export', (_e, id) => exportPlaylist(id));
  ipcMain.handle('menu:sleepState', (_e, mode) => { sleepMode = mode; });

  // ---- ratings, loved, play history
  ipcMain.handle('track:rate', (_e, { ids, rating }) => library.setRatingLoved(ids || [], { rating }));
  ipcMain.handle('track:love', async (_e, { ids, loved }) => {
    const n = library.setRatingLoved(ids || [], { loved: !!loved });
    // Love on Last.fm too (a handful at a time is plenty).
    if (lastfm.getSession && lastfm.status().connected) {
      for (const id of (ids || []).slice(0, 25)) { const t = library.get(id); if (t) lastfm.love(t, !!loved); }
    }
    return n;
  });
  ipcMain.handle('library:plays', () => library.plays);

  // ---- library tools
  ipcMain.handle('library:mergeDuplicates', (_e, { keep, remove, trash }) =>
    library.mergeDuplicates(keep, Array.isArray(remove) ? remove : [], trash ? (p) => shell.trashItem(p) : null));
  ipcMain.handle('fix:albumInfo', (_e, ids) => fixAlbumInfo(Array.isArray(ids) ? ids : []));
  ipcMain.handle('art:findForAlbum', async (_e, ids) => {
    if (!settings.onlineLookup) throw new Error('Online lookups are turned off in Settings');
    const tracks = (ids || []).map((id) => library.get(id)).filter(Boolean);
    if (!tracks.length || !tracks[0].album) return { found: false };
    const artist = tracks.find((t) => t.albumArtist)?.albumArtist || tracks[0].artist || '';
    const match = await online.findAlbumCover(artist, tracks[0].album);
    if (!match) return { found: false };
    const r = await library.setArtwork(tracks.map((t) => t.id), await online.downloadImage(match.artwork));
    return { found: true, ...r };
  });
  ipcMain.handle('track:saveEach', async (_e, { entries, art, artIds }) => {
    const r = await library.updateEach(Array.isArray(entries) ? entries : []);
    const a = fromWire(art);
    if (a !== undefined && Array.isArray(artIds) && artIds.length) {
      const r2 = await library.updateTracks(artIds, {}, a);
      r.written += r2.written;
      r.failed.push(...r2.failed);
    }
    return r;
  });
  ipcMain.handle('library:pendingEdits', () => library.pendingEdits().length);
  ipcMain.handle('library:writePending', () => library.writePendingEdits((p) => send('tags:progress', p)));
  ipcMain.handle('online:albumTracks', async (_e, { ref, ids }) => {
    if (!settings.onlineLookup) throw new Error('Online lookups are turned off in Settings');
    const album = await online.albumTracks(ref);
    const local = (ids || []).map((id) => library.get(id)).filter(Boolean)
      .map((t) => ({ id: t.id, title: t.title, trackNo: t.trackNo, discNo: t.discNo, duration: t.duration, path: t.path }));
    return { ...album, matches: matchTracks(local, album.tracks) };
  });
  // Artist photos for the Artists view, fetched once per artist and cached.
  const artistJobs = new Map();
  ipcMain.handle('online:artistImage', async (_e, name) => {
    const key = String(name || '').toLowerCase();
    const known = library.artists[key];
    if (known && (known.art || Date.now() - known.checked < 14 * 86400000)) return known.art;
    if (!settings.onlineLookup || !key || key === 'various artists' || key === 'unknown artist') return null;
    if (!artistJobs.has(key)) {
      artistJobs.set(key, (async () => {
        try {
          const url = await online.artistImage(name);
          const img = url ? await online.downloadImage(url) : null;
          return await library.setArtistImage(name, img);
        } catch {
          return null; // offline: try again another time
        } finally {
          artistJobs.delete(key);
        }
      })());
    }
    return artistJobs.get(key);
  });
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
  // ---- radio
  ipcMain.handle('radio:search', (_e, q) => radio.search(q || {}));
  ipcMain.handle('radio:countries', () => radio.countries());
  ipcMain.handle('radio:click', (_e, id) => { radio.click(id); });
  ipcMain.handle('radio:stop', () => { if (radioStream) { radioStream.abort(); radioStream = null; } });

  ipcMain.handle('lastfm:artistInfo', async (_e, name) => {
    if (!settings.onlineLookup) return null;
    try { return await lastfm.artistInfo(String(name || '')); } catch { return null; }
  });
  // Radio songs come from the station's "Artist - Title" metadata, not the library.
  const radioSong = (song) => ({
    artist: String(song?.artist || '').slice(0, 300), title: String(song?.title || '').slice(0, 300), fromRadio: true,
  });
  ipcMain.handle('lastfm:radioNowPlaying', async (_e, song) => {
    const s = radioSong(song);
    if (!settings.scrobble || !s.artist || !s.title) return 0;
    lastfm.nowPlaying(s);
    return lastfm.trackDuration(s.artist, s.title);
  });
  ipcMain.handle('lastfm:radioScrobble', (_e, { song, startedAt }) => {
    const s = radioSong(song);
    if (!settings.scrobble || !s.artist || !s.title || !Number.isFinite(startedAt)) return false;
    return lastfm.scrobble(s, startedAt);
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

// ------------------------------------------------------------------ playlists (files)

let sleepMode = 'off';

async function importPlaylist() {
  const r = await dialog.showOpenDialog(win, {
    title: 'Import a playlist', properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Playlists', extensions: ['m3u', 'm3u8'] }],
  });
  if (r.canceled || !r.filePaths.length) return null;
  const results = [];
  for (const f of r.filePaths) {
    try { results.push(await library.importM3u(f)); } catch (err) { results.push({ error: `${path.basename(f)}: ${err.message}` }); }
  }
  send('playlist:imported', results.map((x) => (x.error ? x : { id: x.playlist.id, name: x.playlist.name, count: x.playlist.ids.length, added: x.added, missing: x.missing })));
  return results.length;
}

async function exportPlaylist(id) {
  const pl = library.playlists.find((p) => p.id === id);
  if (!pl) return null;
  const r = await dialog.showSaveDialog(win, {
    title: 'Export playlist',
    defaultPath: path.join(app.getPath('music'), `${pl.name.replace(/[<>:"/\\|?*]+/g, '_')}.m3u8`),
    filters: [{ name: 'Playlist (UTF-8)', extensions: ['m3u8'] }, { name: 'Playlist (older players)', extensions: ['m3u'] }],
  });
  if (r.canceled || !r.filePath) return null;
  const res = await library.exportM3u(id, r.filePath);
  send('toast', `Exported “${pl.name}” (${res.count} songs).`);
  return res;
}

// ------------------------------------------------------------------ fixing missing album info

/**
 * Looks an album up online and fills in only what's missing (genre, year, track and disc numbers).
 * Returns {ok, changed, album} or {ok: false, reason}.
 */
async function fixAlbumInfo(ids) {
  if (!settings.onlineLookup) return { ok: false, reason: 'Online lookups are turned off in Settings' };
  const tracks = ids.map((id) => library.get(id)).filter(Boolean);
  if (!tracks.length || !tracks[0].album) return { ok: false, reason: 'These songs have no album name to look up' };
  const artist = tracks.find((t) => t.albumArtist)?.albumArtist || tracks[0].artist || '';
  const { norm } = require('./online');
  const { results } = await online.search(`${artist} ${tracks[0].album}`.trim(), 'album');
  const a = norm(tracks[0].album);
  const ar = norm(artist);
  const pick = results.find((r) => {
    const ra = norm(r.album);
    const rr = norm(r.albumArtist || r.artist);
    return r.albumRef && (ra === a || (a.length > 3 && (ra.startsWith(a) || a.startsWith(ra)))) && (!ar || rr === ar || rr.includes(ar) || ar.includes(rr));
  });
  if (!pick) return { ok: false, reason: 'No matching album found online' };
  const al = await online.albumTracks(pick.albumRef);
  const local = tracks.map((t) => ({ id: t.id, title: t.title, trackNo: t.trackNo, discNo: t.discNo, duration: t.duration, path: t.path }));
  const matches = matchTracks(local, al.tracks);
  const entries = [];
  for (const t of tracks) {
    const fields = {};
    if (!t.genre && al.genre) fields.genre = al.genre;
    if (!t.year && al.year) fields.year = al.year;
    const m = matches.find((x) => x.id === t.id);
    const at = m && m.index >= 0 ? al.tracks[m.index] : null;
    if (at) {
      if (!t.trackNo && at.trackNo) fields.trackNo = at.trackNo;
      if (!t.trackOf && at.trackOf) fields.trackOf = at.trackOf;
      if (!t.discNo && at.discNo && (at.discOf || 1) > 1) fields.discNo = at.discNo;
      if (!t.discOf && at.discOf > 1) fields.discOf = at.discOf;
    }
    if (Object.keys(fields).length) entries.push({ id: t.id, fields });
  }
  if (entries.length) await library.updateEach(entries);
  return { ok: true, changed: entries.length, album: al.album };
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
  library.tagWriter = writeTags;
  library.shouldWriteFiles = () => settings.writeTags !== false;
  library.on('progress', (p) => send('scan:progress', p));
  radio = new RadioBrowser((url, opts) => net.fetch(url, opts), userAgent());
  lyrics = new Lyrics({ fetch: (url, opts) => net.fetch(url, opts), dataDir: app.getPath('userData'), userAgent: userAgent() });
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
  library.on('writeFailed', (f) => send('toast', { error: true, text: `Couldn’t save into “${f.title}”: ${f.message}.` }));
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
