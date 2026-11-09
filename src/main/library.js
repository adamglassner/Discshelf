'use strict';
// The music library: watched folders + tracks, stored as JSON in the app's data folder.
// Scanning walks folders, reads tags for new or changed files, caches cover art and drops missing files.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { readTags, isAudioFile } = require('./tags');

const LIBRARY_VERSION = 1;
const COVER_NAMES = ['cover', 'folder', 'front', 'album', 'albumart', 'albumartsmall', 'albumartlarge'];
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp'];
const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information', 'node_modules', '.git']);
const SCAN_CONCURRENCY = 4;
// Song details people can change in Get Info. Edits are kept in the library (on top of the file's tags),
// so they survive rescans; the music files themselves aren't changed.
const EDITABLE = {
  title: 'text', artist: 'text', albumArtist: 'text', album: 'text', genre: 'text',
  year: 'int', trackNo: 'int', trackOf: 'int', discNo: 'int', discOf: 'int',
};

function cleanEdits(fields) {
  const out = {};
  for (const [k, kind] of Object.entries(EDITABLE)) {
    if (!(k in fields)) continue;
    if (kind === 'int') {
      const v = parseInt(fields[k], 10);
      out[k] = Number.isFinite(v) && v > 0 && v < 100000 ? v : 0;
    } else {
      out[k] = String(fields[k] ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 500);
    }
  }
  return out;
}

function applyEdits(t) {
  if (!t.edits) return t;
  for (const k of Object.keys(EDITABLE)) if (k in t.edits) t[k] = t.edits[k];
  if ('art' in t.edits) t.art = t.edits.art;
  if (!t.title) t.title = path.basename(t.path, path.extname(t.path));
  return t;
}

function trackId(filePath) {
  return crypto.createHash('sha1').update(path.resolve(filePath).toLowerCase()).digest('hex').slice(0, 16);
}

function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

class Library extends EventEmitter {
  constructor(dataDir) {
    super();
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'library.json');
    this.artDir = path.join(dataDir, 'artwork');
    this.folders = [];
    this.tracks = new Map();
    this.scanning = null; // {cancelled, ...progress}
    this._saveTimer = null;
    this._folderArt = new Map();
    this.artists = {}; // artist name (lower case) -> {art, checked}
    // Saving changes into the music files themselves (set up by the main process).
    this.tagWriter = null; // async (path, fields, art) => …
    this.shouldWriteFiles = () => false;
    this.playlists = []; // [{id, name, ids, created, updated}]
    this.ignored = new Set(); // lower-case paths removed from the library: rescans don't bring them back
    this.playsFile = path.join(dataDir, 'plays.json');
    this.plays = []; // [[trackId, timestamp, seconds]] — listening history for Statistics
    this._playsTimer = null;
    this._bg = new Map(); // id -> {fields} waiting to be written into files (ratings, loved)
    this._bgTimer = null;
    this._bgRunning = false;
  }

  load() {
    fs.mkdirSync(this.artDir, { recursive: true });
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.folders = Array.isArray(data.folders) ? data.folders.filter((f) => typeof f === 'string') : [];
      if (data.artists && typeof data.artists === 'object') this.artists = data.artists;
      if (Array.isArray(data.playlists)) this.playlists = data.playlists.filter((pl) => pl && pl.id && Array.isArray(pl.ids));
      if (Array.isArray(data.ignored)) this.ignored = new Set(data.ignored);
      for (const t of Array.isArray(data.tracks) ? data.tracks : []) {
        if (t && t.id && t.path) this.tracks.set(t.id, t);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Keep the damaged file for inspection and start empty rather than refusing to open.
        try { fs.copyFileSync(this.file, this.file + '.bad'); } catch { /* ignore */ }
        console.error('library.json could not be read:', err.message);
      }
    }
    try {
      const plays = JSON.parse(fs.readFileSync(this.playsFile, 'utf8'));
      if (Array.isArray(plays)) this.plays = plays;
    } catch { /* no history yet */ }
  }

  snapshot() {
    return { folders: [...this.folders], tracks: [...this.tracks.values()], artists: this.artists, playlists: this.playlists };
  }

  get(id) {
    return this.tracks.get(id) || null;
  }

  /** Path of a cached artwork file by its file name, or null if it isn't one of ours. */
  artPath(name) {
    if (!/^[a-f0-9]{16,40}\.(jpg|png|gif|webp|bmp)$/.test(name)) return null;
    return path.join(this.artDir, name);
  }

  // ------------------------------------------------------------------ saving

  scheduleSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.saveNow(), 800);
  }

  saveNow() {
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    const data = JSON.stringify({
      version: LIBRARY_VERSION, folders: this.folders, artists: this.artists, playlists: this.playlists,
      ignored: [...this.ignored], tracks: [...this.tracks.values()],
    });
    const tmp = this.file + '.tmp';
    try {
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('Could not save library:', err.message);
    }
  }

  // ------------------------------------------------------------------ edits

  /** Removes songs from the library (not from disk). Rescans won't add them back unless you add them again. */
  removeTracks(ids) {
    let n = 0;
    const gone = new Set();
    for (const id of ids) {
      const t = this.tracks.get(id);
      if (!t) continue;
      this.ignored.add(t.path.toLowerCase());
      this.tracks.delete(id);
      gone.add(id);
      n++;
    }
    for (const pl of this.playlists) pl.ids = pl.ids.filter((id) => !gone.has(id));
    if (n) { this.scheduleSave(); this.emit('changed', { removed: ids }); }
    return n;
  }

  // ------------------------------------------------------------------ playlists

  _playlist(id) {
    const pl = this.playlists.find((x) => x.id === id);
    if (!pl) throw new Error('That playlist no longer exists');
    return pl;
  }

  createPlaylist(name, ids = []) {
    const pl = {
      id: crypto.randomBytes(6).toString('hex'),
      name: String(name || '').trim().slice(0, 200) || 'Untitled Playlist',
      ids: [...new Set(ids.filter((id) => this.tracks.has(id)))],
      created: Date.now(),
      updated: Date.now(),
    };
    this.playlists.push(pl);
    this.scheduleSave();
    this.emit('changed', { playlists: true });
    return pl;
  }

  renamePlaylist(id, name) {
    const pl = this._playlist(id);
    pl.name = String(name || '').trim().slice(0, 200) || pl.name;
    pl.updated = Date.now();
    this.scheduleSave();
    this.emit('changed', { playlists: true });
    return pl;
  }

  deletePlaylist(id) {
    this.playlists = this.playlists.filter((x) => x.id !== id);
    this.scheduleSave();
    this.emit('changed', { playlists: true });
  }

  /** Adds songs (skipping ones already there). Returns {added, already}. */
  addToPlaylist(id, ids, position = null) {
    const pl = this._playlist(id);
    const have = new Set(pl.ids);
    const add = [...new Set(ids)].filter((x) => this.tracks.has(x) && !have.has(x));
    const at = position === null || position < 0 || position > pl.ids.length ? pl.ids.length : position;
    pl.ids.splice(at, 0, ...add);
    pl.updated = Date.now();
    this.scheduleSave();
    this.emit('changed', { playlists: true });
    return { added: add.length, already: ids.length - add.length };
  }

  /** Replaces a playlist's order (used for reordering and removing songs from it). */
  setPlaylistIds(id, ids) {
    const pl = this._playlist(id);
    pl.ids = [...new Set(ids)].filter((x) => this.tracks.has(x));
    pl.updated = Date.now();
    this.scheduleSave();
    this.emit('changed', { playlists: true });
    return pl;
  }

  /**
   * Reads an .m3u / .m3u8 playlist. Songs not in the library yet are added; missing files are counted.
   * Returns {playlist, added, missing}.
   */
  async importM3u(file) {
    const raw = await fs.promises.readFile(file);
    const text = file.toLowerCase().endsWith('.m3u8') || raw.subarray(0, 3).equals(Buffer.from([0xEF, 0xBB, 0xBF]))
      ? raw.toString('utf8').replace(/^\uFEFF/, '') : raw.toString('latin1');
    const base = path.dirname(file);
    const entries = [];
    let missing = 0;
    for (let line of text.split(/\r?\n/)) {
      line = line.trim();
      if (!line || line.startsWith('#')) continue;
      if (/^[a-z]+:\/\//i.test(line) && !/^file:\/\//i.test(line)) { missing++; continue; } // web addresses
      let p = line;
      if (/^file:\/\//i.test(p)) { try { p = require('url').fileURLToPath(p); } catch { missing++; continue; } }
      p = path.resolve(base, p.replace(/[\\/]/g, path.sep));
      try { await fs.promises.access(p); entries.push(p); } catch { missing++; }
    }
    const notInLibrary = entries.filter((p) => !this.tracks.has(trackId(p)) && isAudioFile(p));
    if (notInLibrary.length) {
      for (const p of notInLibrary) this.ignored.delete(p.toLowerCase());
      await this.scan(notInLibrary);
    }
    const ids = entries.map((p) => trackId(p)).filter((id) => this.tracks.has(id));
    const name = path.basename(file).replace(/\.m3u8?$/i, '');
    const playlist = this.createPlaylist(name, ids);
    return { playlist, added: notInLibrary.length, missing };
  }

  /** Writes a playlist as an extended .m3u / .m3u8 file. */
  async exportM3u(id, file) {
    const pl = this._playlist(id);
    const lines = ['#EXTM3U', `#PLAYLIST:${pl.name}`];
    for (const tid of pl.ids) {
      const t = this.tracks.get(tid);
      if (!t) continue;
      lines.push(`#EXTINF:${Math.round(t.duration || -1)},${t.artist ? `${t.artist} - ` : ''}${t.title}`);
      lines.push(t.path);
    }
    const utf8 = file.toLowerCase().endsWith('.m3u8');
    const body = lines.join('\r\n') + '\r\n';
    await fs.promises.writeFile(file, utf8 ? Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(body, 'utf8')]) : Buffer.from(body, 'latin1'));
    return { count: pl.ids.length };
  }

  // ------------------------------------------------------------------ ratings, loved

  /** Sets star ratings (0–5) and/or loved; saved into the files in the background when that's on. */
  setRatingLoved(ids, { rating, loved }) {
    const changed = [];
    for (const id of ids) {
      const t = this.tracks.get(id);
      if (!t) continue;
      const fields = {};
      if (rating !== undefined) { t.rating = Math.max(0, Math.min(5, Math.round(rating))); fields.rating = t.rating; }
      if (loved !== undefined) { t.loved = !!loved; fields.loved = t.loved; }
      changed.push(id);
      const job = this._bg.get(id) || {};
      this._bg.set(id, { ...job, ...fields });
    }
    if (changed.length) {
      this.scheduleSave();
      this.emit('changed', { updated: changed, quiet: true });
      clearTimeout(this._bgTimer);
      this._bgTimer = setTimeout(() => this._runBackgroundWrites(), 2000);
    }
    return changed.length;
  }

  async _runBackgroundWrites() {
    if (this._bgRunning) return;
    this._bgRunning = true;
    try {
      while (this._bg.size) {
        const [id, fields] = this._bg.entries().next().value;
        this._bg.delete(id);
        const r = await this._writeFiles([{ id, fields }]);
        if (r.failed.length) this.emit('writeFailed', r.failed[0]);
      }
    } finally {
      this._bgRunning = false;
    }
  }

  // ------------------------------------------------------------------ duplicates

  /**
   * Keeps one copy of a song and removes the others from the library, adding their plays, best rating
   * and loved to the copy that's kept, and pointing playlists at it. `trash(path)` moves a file to the
   * Recycle Bin when given.
   */
  async mergeDuplicates(keepId, removeIds, trash = null) {
    const keep = this.tracks.get(keepId);
    if (!keep) throw new Error('The song to keep is no longer in the library');
    const removed = [];
    const trashFailed = [];
    for (const id of removeIds) {
      const t = this.tracks.get(id);
      if (!t || id === keepId) continue;
      keep.playCount = (keep.playCount || 0) + (t.playCount || 0);
      keep.lastPlayed = Math.max(keep.lastPlayed || 0, t.lastPlayed || 0);
      keep.rating = Math.max(keep.rating || 0, t.rating || 0);
      keep.loved = !!(keep.loved || t.loved);
      for (const pl of this.playlists) {
        const i = pl.ids.indexOf(id);
        if (i >= 0) { if (pl.ids.includes(keepId)) pl.ids.splice(i, 1); else pl.ids[i] = keepId; }
      }
      for (const play of this.plays) if (play[0] === id) play[0] = keepId;
      if (trash) {
        try { await trash(t.path); } catch (err) { trashFailed.push(t.title); }
      }
      this.ignored.add(t.path.toLowerCase());
      this.tracks.delete(id);
      removed.push(id);
    }
    this.scheduleSave();
    this._savePlays();
    this.emit('changed', { removed });
    return { removed: removed.length, trashFailed };
  }

  removeFolder(folder) {
    const before = this.folders.length;
    this.folders = this.folders.filter((f) => !samePath(f, folder));
    if (this.folders.length === before) return 0;
    // Remove tracks from that folder unless another watched folder still covers them.
    const gone = [];
    for (const t of this.tracks.values()) {
      if (isInside(t.path, folder) && !this.folders.some((f) => isInside(t.path, f))) gone.push(t.id);
    }
    for (const id of gone) this.tracks.delete(id);
    this.scheduleSave();
    this.emit('changed', { removed: gone, folders: true });
    return gone.length;
  }

  /**
   * Saves Get Info changes for one or more songs. `fields` holds only the details that changed;
   * `art` is {mime, data} for new artwork, null to remove it, or undefined to leave it alone.
   */
  async updateTracks(ids, fields, art) {
    const edits = cleanEdits(fields || {});
    let artName;
    if (art && art.data) {
      artName = await this._saveArt(art);
      if (!artName) throw new Error('The artwork couldn\'t be saved');
    } else if (art === null) {
      artName = null;
    }
    const changed = [];
    for (const id of ids) {
      const t = this.tracks.get(id);
      if (!t) continue;
      t.edits = { ...(t.edits || {}), ...edits };
      if (artName !== undefined) t.edits.art = artName;
      applyEdits(t);
      changed.push(id);
    }
    if (changed.length) this.scheduleSave();
    const files = await this._writeFiles(changed.map((id) => ({ id, fields: edits, art: art === undefined ? undefined : art && art.data ? art : null })));
    if (changed.length) this.emit('changed', { updated: changed });
    return { count: changed.length, ...files };
  }

  /**
   * Saves changes into the music files (when that's turned on). The library already has the changes;
   * once a file has them too, they're dropped from the library's own list of edits.
   * Returns {written, failed: [{id, title, message}]}.
   */
  async _writeFiles(jobs, onProgress) {
    const result = { written: 0, failed: [] };
    if (!this.tagWriter || !this.shouldWriteFiles()) return result;
    let done = 0;
    for (const job of jobs) {
      const t = this.tracks.get(job.id);
      if (!t || (!Object.keys(job.fields || {}).length && job.art === undefined)) { done++; continue; }
      try {
        await this.tagWriter(t.path, job.fields || {}, job.art);
        const st = await fs.promises.stat(t.path);
        t.size = st.size;
        t.mtime = Math.round(st.mtimeMs);
        if (t.edits) {
          for (const k of Object.keys(job.fields || {})) delete t.edits[k];
          if (job.art !== undefined) delete t.edits.art;
          if (!Object.keys(t.edits).length) delete t.edits;
        }
        result.written++;
      } catch (err) {
        result.failed.push({ id: t.id, title: t.title, message: err.message });
      }
      done++;
      if (onProgress) onProgress({ done, total: jobs.length, written: result.written, failed: result.failed.length, current: t.title });
    }
    this.scheduleSave();
    return result;
  }

  /** Songs whose changes are only in the library so far (e.g. edited before saving into files was on). */
  pendingEdits() {
    return [...this.tracks.values()].filter((t) => t.edits && Object.keys(t.edits).length);
  }

  /** Saves every library-only change into the music files. */
  async writePendingEdits(onProgress) {
    const jobs = [];
    for (const t of this.pendingEdits()) {
      const fields = { ...t.edits };
      delete fields.art;
      let art;
      if ('art' in t.edits) {
        if (!t.edits.art) art = null;
        else {
          const file = this.artPath(t.edits.art);
          try {
            const data = await fs.promises.readFile(file);
            const ext = path.extname(file).slice(1);
            art = { mime: ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg', data };
          } catch { art = undefined; }
        }
      }
      jobs.push({ id: t.id, fields, art });
    }
    const r = await this._writeFiles(jobs, onProgress);
    this.emit('changed', { updated: jobs.map((j) => j.id) });
    return { total: jobs.length, ...r };
  }

  /** Different details for each song (e.g. titles + track numbers from an album's track list). */
  async updateEach(entries) {
    const changed = [];
    const jobs = [];
    for (const { id, fields } of entries || []) {
      const t = this.tracks.get(id);
      if (!t) continue;
      const e = cleanEdits(fields || {});
      t.edits = { ...(t.edits || {}), ...e };
      applyEdits(t);
      changed.push(id);
      jobs.push({ id, fields: e });
    }
    if (changed.length) this.scheduleSave();
    const files = await this._writeFiles(jobs);
    if (changed.length) this.emit('changed', { updated: changed });
    return { count: changed.length, ...files };
  }

  /** Remembers an artist's photo (or that none was found). */
  async setArtistImage(name, picture) {
    const key = String(name || '').toLowerCase();
    if (!key) return null;
    const art = picture ? await this._saveArt(picture) : null;
    this.artists[key] = { art, checked: Date.now() };
    this.scheduleSave();
    return art;
  }

  /** Saves artwork for songs without emitting per-call saves (used by the missing-artwork finder). */
  async setArtwork(ids, picture) {
    return this.updateTracks(ids, {}, picture);
  }

  /** Albums with no artwork: [{key, artist, album, ids}] (songs without an album name are skipped). */
  albumsMissingArt() {
    const groups = new Map();
    for (const t of this.tracks.values()) {
      if (t.art || !t.album) continue;
      const artist = t.albumArtist || t.artist || '';
      const key = `${artist.toLowerCase()}|${t.album.toLowerCase()}`;
      if (!groups.has(key)) groups.set(key, { key, artist, album: t.album, ids: [] });
      groups.get(key).ids.push(t.id);
    }
    return [...groups.values()];
  }

  markPlayed(id, seconds) {
    const t = this.tracks.get(id);
    if (!t) return null;
    t.playCount = (t.playCount || 0) + 1;
    t.lastPlayed = Date.now();
    this.plays.push([id, t.lastPlayed, Math.round(Number.isFinite(seconds) && seconds > 0 ? seconds : t.duration || 0)]);
    this.scheduleSave();
    this._savePlays();
    return { id, playCount: t.playCount, lastPlayed: t.lastPlayed };
  }

  _savePlays() {
    clearTimeout(this._playsTimer);
    this._playsTimer = setTimeout(() => {
      try {
        fs.writeFileSync(this.playsFile + '.tmp', JSON.stringify(this.plays));
        fs.renameSync(this.playsFile + '.tmp', this.playsFile);
      } catch (err) { console.error('Could not save play history:', err.message); }
    }, 1000);
  }

  // ------------------------------------------------------------------ scanning

  /**
   * Adds folders and/or files and scans them. With no paths, rescans every watched folder and
   * also drops tracks whose files are gone.
   */
  async scan(paths = null) {
    if (this.scanning) return { busy: true };
    const state = { cancelled: false, phase: 'finding', found: 0, processed: 0, added: 0, updated: 0, removed: 0, errors: 0, current: '' };
    this.scanning = state;
    const report = () => this.emit('progress', { ...state, scanning: true });
    const timer = setInterval(report, 150);
    report();

    try {
      const roots = [];
      const files = [];
      if (paths && paths.length) {
        for (const p of paths) {
          let st;
          try { st = await fs.promises.stat(p); } catch { continue; }
          if (st.isDirectory()) {
            const abs = path.resolve(p);
            // A new folder inside an existing watched folder doesn't need its own entry.
            if (!this.folders.some((f) => isInside(abs, f))) {
              this.folders = this.folders.filter((f) => !isInside(f, abs));
              this.folders.push(abs);
            }
            roots.push(abs);
          } else if (st.isFile() && isAudioFile(p)) {
            files.push(path.resolve(p));
            this.ignored.delete(path.resolve(p).toLowerCase()); // added on purpose: no longer ignored
          }
        }
      } else {
        roots.push(...this.folders);
      }

      for (const root of roots) {
        if (state.cancelled) break;
        await this._walk(root, files, state);
      }
      // Songs removed from the library stay out, unless they were added again on purpose (above).
      for (let i = files.length - 1; i >= 0; i--) if (this.ignored.has(files[i].toLowerCase())) files.splice(i, 1);
      state.found = files.length;
      state.phase = 'reading';

      // Read tags with a little concurrency.
      let next = 0;
      const seen = new Set();
      const worker = async () => {
        while (!state.cancelled && next < files.length) {
          const file = files[next++];
          state.current = file;
          seen.add(trackId(file));
          await this._addFile(file, state);
          state.processed++;
        }
      };
      await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));

      // A full rescan drops tracks whose files no longer exist.
      if (!paths && !state.cancelled) {
        state.phase = 'cleaning';
        for (const t of [...this.tracks.values()]) {
          if (seen.has(t.id)) continue;
          try { await fs.promises.access(t.path); } catch { this.tracks.delete(t.id); state.removed++; }
        }
      }
    } finally {
      clearInterval(timer);
      this.scanning = null;
      this.scheduleSave();
      this._folderArt.clear();
    }
    const result = { ...state, scanning: false };
    this.emit('progress', result);
    this.emit('changed', { scanned: true, folders: true });
    return result;
  }

  cancelScan() {
    if (this.scanning) this.scanning.cancelled = true;
  }

  async _walk(dir, out, state) {
    const stack = [dir];
    while (stack.length && !state.cancelled) {
      const d = stack.pop();
      let entries;
      try { entries = await fs.promises.readdir(d, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          if (e.name.startsWith('.') || SKIP_DIRS.has(e.name.toLowerCase())) continue;
          stack.push(full);
        } else if (e.isFile() && isAudioFile(e.name)) {
          out.push(full);
          state.found = out.length;
        }
      }
    }
  }

  async _addFile(file, state) {
    const id = trackId(file);
    let st;
    try { st = await fs.promises.stat(file); } catch { state.errors++; return; }
    const existing = this.tracks.get(id);
    const mtime = Math.round(st.mtimeMs);
    if (existing && existing.size === st.size && existing.mtime === mtime) return; // unchanged

    let tags;
    try {
      tags = await readTags(file);
    } catch (err) {
      state.errors++;
      tags = null;
    }
    // Files we can't read tags from are still added (named after the file) if they look like audio.
    if (!tags) tags = { duration: 0, codec: path.extname(file).slice(1).toUpperCase(), picture: null };

    let art = null;
    if (tags.picture) art = await this._saveArt(tags.picture);
    if (!art) art = await this._folderCover(path.dirname(file));

    const t = {
      id,
      path: file,
      size: st.size,
      mtime,
      title: tags.title || path.basename(file, path.extname(file)),
      artist: tags.artist || '',
      albumArtist: tags.albumArtist || '',
      album: tags.album || '',
      genre: tags.genre || '',
      year: tags.year || 0,
      trackNo: tags.trackNo || 0,
      trackOf: tags.trackOf || 0,
      discNo: tags.discNo || 0,
      discOf: tags.discOf || 0,
      duration: Math.round((tags.duration || 0) * 1000) / 1000,
      codec: tags.codec || '',
      bitrate: tags.bitrate || 0,
      sampleRate: tags.sampleRate || 0,
      bitsPerSample: tags.bitsPerSample || 0,
      channels: tags.channels || 0,
      art,
      added: existing ? existing.added : Date.now(),
      playCount: existing ? existing.playCount || 0 : 0,
      lastPlayed: existing ? existing.lastPlayed || 0 : 0,
      rating: tags.rating || (existing ? existing.rating || 0 : 0),
      loved: !!(tags.loved || (existing && existing.loved)),
    };
    if (existing && existing.edits) { t.edits = existing.edits; applyEdits(t); }
    this.tracks.set(id, t);
    if (existing) state.updated++; else state.added++;
  }

  async _saveArt(picture) {
    try {
      const ext = { 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp' }[picture.mime] || 'jpg';
      const name = crypto.createHash('sha1').update(picture.data).digest('hex').slice(0, 20) + '.' + ext;
      const file = path.join(this.artDir, name);
      try { await fs.promises.access(file); } catch { await fs.promises.writeFile(file, picture.data); }
      return name;
    } catch {
      return null;
    }
  }

  /** cover.jpg / folder.jpg / front.png ... next to the music, copied into the artwork cache. */
  async _folderCover(dir) {
    if (this._folderArt.has(dir)) return this._folderArt.get(dir);
    const job = (async () => {
      let entries;
      try { entries = await fs.promises.readdir(dir); } catch { return null; }
      const images = entries.filter((n) => IMAGE_EXT.includes(path.extname(n).toLowerCase()));
      if (!images.length) return null;
      const byName = (n) => COVER_NAMES.indexOf(path.basename(n, path.extname(n)).toLowerCase().replace(/[^a-z]/g, ''));
      let pick = images.filter((n) => byName(n) >= 0).sort((a, b) => byName(a) - byName(b))[0];
      if (!pick && images.length === 1) pick = images[0];
      if (!pick) return null;
      try {
        const data = await fs.promises.readFile(path.join(dir, pick));
        if (data.length > 20 * 1024 * 1024) return null;
        const ext = path.extname(pick).toLowerCase();
        const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
        return await this._saveArt({ mime, data });
      } catch {
        return null;
      }
    })();
    this._folderArt.set(dir, job);
    return job;
  }
}

module.exports = { Library, trackId, EDITABLE };
