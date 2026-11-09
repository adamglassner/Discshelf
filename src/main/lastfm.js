'use strict';
// Last.fm scrobbling: desktop sign-in (auth.getToken → browser → auth.getSession), "Now playing",
// and scrobbles with an on-disk queue so plays made offline are sent later.
// https://www.last.fm/api/desktopauth  https://www.last.fm/api/scrobbling
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const API = 'https://ws.audioscrobbler.com/2.0/';
const AUTH_URL = 'https://www.last.fm/api/auth/';
const BATCH = 50;
const MAX_QUEUE = 5000;

class LastfmError extends Error {
  constructor(code, message) {
    super(message || `Last.fm error ${code}`);
    this.code = code;
  }
}

/** Last.fm's rule: songs longer than 30 s count once you've heard half of them or 4 minutes. */
function scrobbleThreshold(durationSec) {
  if (!(durationSec > 30)) return null;
  return Math.min(durationSec / 2, 240);
}

class Lastfm extends EventEmitter {
  /**
   * @param {object} o
   * @param {Function} o.fetch      fetch-compatible function
   * @param {string}   o.dataDir    where the scrobble queue is kept
   * @param {Function} o.getKeys    () => {apiKey, secret} | null
   * @param {Function} o.getSession () => {name, key} | null
   * @param {Function} o.setSession (session|null) => void
   */
  constructor(o) {
    super();
    this.fetch = o.fetch;
    this.getKeys = o.getKeys;
    this.getSession = o.getSession;
    this.setSession = o.setSession;
    this.queueFile = path.join(o.dataDir, 'lastfm-queue.json');
    this.queue = [];
    this.flushing = null;
    this.pendingAuth = null;
    try { this.queue = JSON.parse(fs.readFileSync(this.queueFile, 'utf8')); } catch { this.queue = []; }
    if (!Array.isArray(this.queue)) this.queue = [];
  }

  hasKeys() {
    const k = this.getKeys();
    return !!(k && k.apiKey && k.secret);
  }

  status() {
    const s = this.getSession();
    return { hasKeys: this.hasKeys(), connected: !!s, user: s ? s.name : null, queued: this.queue.length, authorizing: !!this.pendingAuth };
  }

  sign(params) {
    const { secret } = this.getKeys();
    const keys = Object.keys(params).filter((k) => k !== 'format' && k !== 'callback').sort();
    const str = keys.map((k) => k + params[k]).join('') + secret;
    return crypto.createHash('md5').update(str, 'utf8').digest('hex');
  }

  async call(method, params = {}, { post = false, session = false } = {}) {
    const keys = this.getKeys();
    if (!keys || !keys.apiKey || !keys.secret) throw new LastfmError(-1, 'Last.fm isn’t set up in this copy of Discshelf (no API key).');
    const p = { ...params, method, api_key: keys.apiKey };
    if (session) {
      const s = this.getSession();
      if (!s) throw new LastfmError(9, 'Not connected to Last.fm');
      p.sk = s.key;
    }
    for (const k of Object.keys(p)) if (p[k] === undefined || p[k] === null || p[k] === '') delete p[k];
    p.api_sig = this.sign(p);
    p.format = 'json';
    const body = new URLSearchParams(p).toString();
    const res = post
      ? await this.fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })
      : await this.fetch(`${API}?${body}`);
    let data;
    try { data = await res.json(); } catch { throw new LastfmError(res.status >= 500 ? 16 : -2, `Last.fm sent an unexpected reply (HTTP ${res.status})`); }
    if (data && data.error) throw new LastfmError(data.error, data.message);
    if (!res.ok) throw new LastfmError(res.status >= 500 ? 16 : -2, `HTTP ${res.status}`);
    return data;
  }

  // ---------------------------------------------------------------- sign-in

  /** Starts sign-in. Returns the URL to open in the browser; resolves `connect` events when approved. */
  async beginAuth() {
    this.cancelAuth();
    const { token } = await this.call('auth.getToken');
    const keys = this.getKeys();
    const url = `${AUTH_URL}?api_key=${encodeURIComponent(keys.apiKey)}&token=${encodeURIComponent(token)}`;
    const job = { token, cancelled: false, started: Date.now() };
    this.pendingAuth = job;
    this._pollAuth(job);
    return url;
  }

  async _pollAuth(job) {
    // The person approves in the browser; until then auth.getSession answers "unauthorized token" (14).
    while (!job.cancelled && Date.now() - job.started < 10 * 60 * 1000) {
      await new Promise((r) => setTimeout(r, 3000));
      if (job.cancelled) return;
      try {
        const { session } = await this.call('auth.getSession', { token: job.token });
        this.setSession({ name: session.name, key: session.key });
        this.pendingAuth = null;
        this.emit('status', this.status());
        this.flush();
        return;
      } catch (err) {
        if (err.code === 14) continue; // not approved yet
        if (err.code === 15 || err.code === 4) { // token expired / invalid
          this.pendingAuth = null;
          this.emit('authError', 'The Last.fm sign-in link expired. Try connecting again.');
          this.emit('status', this.status());
          return;
        }
        // network blips: keep waiting
      }
    }
    if (!job.cancelled) {
      this.pendingAuth = null;
      this.emit('authError', 'Last.fm sign-in timed out. Try connecting again.');
      this.emit('status', this.status());
    }
  }

  cancelAuth() {
    if (this.pendingAuth) this.pendingAuth.cancelled = true;
    this.pendingAuth = null;
  }

  disconnect() {
    this.cancelAuth();
    this.setSession(null);
    this.emit('status', this.status());
  }

  // ---------------------------------------------------------------- scrobbling

  static params(track) {
    return {
      artist: track.artist,
      track: track.title,
      album: track.album || undefined,
      albumArtist: track.albumArtist && track.albumArtist !== track.artist ? track.albumArtist : undefined,
      duration: track.duration ? Math.round(track.duration) : undefined,
      trackNumber: track.trackNo || undefined,
    };
  }

  async nowPlaying(track) {
    if (!this.getSession() || !track.artist || !track.title) return false;
    try {
      await this.call('track.updateNowPlaying', Lastfm.params(track), { post: true, session: true });
      return true;
    } catch (err) {
      this._handleSessionError(err);
      return false;
    }
  }

  /** Queues a scrobble (startedAt = ms timestamp when the song started) and tries to send the queue. */
  scrobble(track, startedAt) {
    if (!this.getSession() || !track.artist || !track.title) return false;
    this.queue.push({ ...Lastfm.params(track), timestamp: Math.floor(startedAt / 1000) });
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
    this._saveQueue();
    this.flush();
    return true;
  }

  _saveQueue() {
    try { fs.writeFileSync(this.queueFile, JSON.stringify(this.queue)); } catch (err) { console.error('lastfm queue:', err.message); }
  }

  /** Sends queued scrobbles in batches of 50. Safe to call any time; concurrent calls share one run. */
  flush() {
    if (this.flushing) return this.flushing;
    // .finally runs after this.flushing is assigned, even when there's nothing to send.
    const run = this._flush().finally(() => {
      if (this.flushing === run) this.flushing = null;
      this.emit('status', this.status());
    });
    this.flushing = run;
    return run;
  }

  async _flush() {
    let sent = 0;
    while (this.queue.length && this.getSession()) {
      const batch = this.queue.slice(0, BATCH);
      const p = {};
      batch.forEach((s, i) => { for (const [k, v] of Object.entries(s)) if (v !== undefined) p[`${k}[${i}]`] = v; });
      try {
        await this.call('track.scrobble', p, { post: true, session: true });
      } catch (err) {
        // 11/16/29: Last.fm is down or busy; network errors have no code. Keep the queue for later.
        if (this._handleSessionError(err)) break;
        if (err.code === 11 || err.code === 16 || err.code === 29 || !err.code || err.code < 0) break;
        // Anything else means these scrobbles were rejected: drop them so the queue doesn't get stuck.
        console.error('Last.fm rejected scrobbles:', err.message);
      }
      this.queue.splice(0, batch.length);
      sent += batch.length;
      this._saveQueue();
    }
    return sent;
  }

  _handleSessionError(err) {
    if (err && err.code === 9) { // invalid session key: the person revoked access on last.fm
      this.setSession(null);
      this.emit('authError', 'Discshelf was disconnected from Last.fm. Connect again in Settings to keep scrobbling.');
      this.emit('status', this.status());
      return true;
    }
    return false;
  }
}

module.exports = { Lastfm, LastfmError, scrobbleThreshold };
