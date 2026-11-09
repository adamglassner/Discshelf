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
  }

  load() {
    fs.mkdirSync(this.artDir, { recursive: true });
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.folders = Array.isArray(data.folders) ? data.folders.filter((f) => typeof f === 'string') : [];
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
  }

  snapshot() {
    return { folders: [...this.folders], tracks: [...this.tracks.values()] };
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
    const data = JSON.stringify({ version: LIBRARY_VERSION, folders: this.folders, tracks: [...this.tracks.values()] });
    const tmp = this.file + '.tmp';
    try {
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('Could not save library:', err.message);
    }
  }

  // ------------------------------------------------------------------ edits

  removeTracks(ids) {
    let n = 0;
    for (const id of ids) if (this.tracks.delete(id)) n++;
    if (n) { this.scheduleSave(); this.emit('changed', { removed: ids }); }
    return n;
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
    if (changed.length) { this.scheduleSave(); this.emit('changed', { updated: changed }); }
    return changed.length;
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

  markPlayed(id) {
    const t = this.tracks.get(id);
    if (!t) return null;
    t.playCount = (t.playCount || 0) + 1;
    t.lastPlayed = Date.now();
    this.scheduleSave();
    return { id, playCount: t.playCount, lastPlayed: t.lastPlayed };
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
          }
        }
      } else {
        roots.push(...this.folders);
      }

      for (const root of roots) {
        if (state.cancelled) break;
        await this._walk(root, files, state);
      }
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
