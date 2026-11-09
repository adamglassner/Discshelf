'use strict';
// Lyrics for a song: a .lrc file next to it, lyrics saved in the file's tags, or LRCLIB (lrclib.net,
// free, no key) online. Synced lyrics ("[01:23.45] line") scroll along with the song.
const fs = require('fs');
const path = require('path');
const { readTags } = require('./tags');

const LRCLIB = 'https://lrclib.net/api';

/** "[mm:ss.xx]text" lines → [{t, text}] sorted by time, or null when there are no timestamps. */
function parseLrc(text) {
  const out = [];
  let offset = 0;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const off = /^\[offset:\s*([+-]?\d+)\]/i.exec(raw);
    if (off) { offset = parseInt(off[1], 10) / 1000; continue; }
    const stamps = [];
    let rest = raw;
    let m;
    while ((m = /^\s*\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/.exec(rest))) {
      stamps.push(parseInt(m[1], 10) * 60 + parseFloat(m[2].replace(':', '.')));
      rest = rest.slice(m[0].length);
    }
    if (!stamps.length) continue;
    // Word-level timing ("<00:12.34>") isn't used: strip it.
    const line = rest.replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '').trim();
    for (const t of stamps) out.push({ t: Math.max(0, t - offset), text: line });
  }
  if (out.length < 2) return null;
  out.sort((a, b) => a.t - b.t);
  return out;
}

/** Plain text from LRC (timestamps and [ar:] style headers removed). */
function plainFromLrc(text) {
  return String(text || '').split(/\r?\n/)
    .filter((l) => !/^\s*\[[a-z]+:.*\]\s*$/i.test(l))
    .map((l) => l.replace(/\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/g, '').replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '').trim())
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function fromText(text, source) {
  const synced = parseLrc(text);
  return { source, synced, plain: synced ? plainFromLrc(text) : String(text).trim() };
}

class Lyrics {
  /**
   * @param {object} o
   * @param {Function} o.fetch     fetch-compatible
   * @param {string}   o.dataDir   where online results are cached
   * @param {string}   o.userAgent
   */
  constructor(o) {
    this.fetch = o.fetch;
    this.userAgent = o.userAgent;
    this.cacheFile = path.join(o.dataDir, 'lyrics-cache.json');
    try { this.cache = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8')); } catch { this.cache = {}; }
    this.saveTimer = null;
  }

  _save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try { fs.writeFileSync(this.cacheFile, JSON.stringify(this.cache)); } catch { /* ignore */ }
    }, 1000);
  }

  _key(t) { return `${(t.artist || '').toLowerCase()}|${(t.title || '').toLowerCase()}|${Math.round(t.duration || 0)}`; }

  /** Lyrics for a library track: {source, synced, plain} or {source: null} when none were found. */
  async get(t, { online = true } = {}) {
    // 1. song.lrc next to song.mp3
    const lrc = t.path.replace(/\.[^.\\/]+$/, '.lrc');
    try {
      const text = await fs.promises.readFile(lrc, 'utf8');
      if (text.trim()) return fromText(text.replace(/^﻿/, ''), 'lrc');
    } catch { /* none */ }
    // 2. in the file's tags
    try {
      const tags = await readTags(t.path);
      if (tags.lyrics) return fromText(tags.lyrics, 'file');
    } catch { /* unreadable */ }
    // 3. online
    if (!online || !t.artist || !t.title) return { source: null };
    const key = this._key(t);
    const cached = this.cache[key];
    if (cached && (cached.found || Date.now() - cached.at < 7 * 86400000)) {
      return cached.found ? fromText(cached.synced || cached.plain, 'lrclib') : { source: null, instrumental: !!cached.instrumental };
    }
    const r = await this._lookup(t);
    this.cache[key] = { at: Date.now(), found: !!r && !r.instrumental && !!(r.syncedLyrics || r.plainLyrics), synced: r && r.syncedLyrics, plain: r && r.plainLyrics, instrumental: !!(r && r.instrumental) };
    this._save();
    const c = this.cache[key];
    return c.found ? fromText(c.synced || c.plain, 'lrclib') : { source: null, instrumental: c.instrumental };
  }

  async _lookup(t) {
    const headers = { 'User-Agent': this.userAgent };
    const q = new URLSearchParams({ artist_name: t.artist, track_name: t.title });
    if (t.album) q.set('album_name', t.album);
    if (t.duration) q.set('duration', String(Math.round(t.duration)));
    let res = await this.fetch(`${LRCLIB}/get?${q}`, { headers });
    if (res.ok) return res.json();
    if (res.status !== 404) throw new Error(`LRCLIB answered ${res.status}`);
    // No exact match (album or length differ): search and take the closest length.
    res = await this.fetch(`${LRCLIB}/search?${new URLSearchParams({ artist_name: t.artist, track_name: t.title })}`, { headers });
    if (!res.ok) throw new Error(`LRCLIB answered ${res.status}`);
    const list = await res.json();
    if (!Array.isArray(list) || !list.length) return null;
    const fit = list
      .filter((x) => !t.duration || !x.duration || Math.abs(x.duration - t.duration) <= 8)
      .sort((a, b) => (b.syncedLyrics ? 1 : 0) - (a.syncedLyrics ? 1 : 0) || Math.abs((a.duration || 0) - t.duration) - Math.abs((b.duration || 0) - t.duration));
    return fit[0] || null;
  }
}

module.exports = { Lyrics, parseLrc, plainFromLrc };
