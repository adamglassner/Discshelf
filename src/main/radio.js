'use strict';
// Internet radio: the Radio Browser directory (https://www.radio-browser.info — free, no key; it asks for
// a descriptive User-Agent and a "click" when a station is played), and a stream relay that strips
// SHOUTcast/Icecast "ICY" metadata so the player gets clean audio plus the current song title.

const FALLBACK_SERVERS = ['de1.api.radio-browser.info', 'nl1.api.radio-browser.info', 'at1.api.radio-browser.info', 'de2.api.radio-browser.info', 'fi1.api.radio-browser.info'];
const PLAYABLE = new Set(['MP3', 'AAC', 'AAC+', 'OGG', 'OPUS', 'FLAC', '']);

function mapStation(s) {
  return {
    id: s.stationuuid,
    name: String(s.name || '').trim() || 'Unnamed station',
    url: s.url_resolved || s.url || '',
    homepage: s.homepage || '',
    favicon: /^https?:\/\//i.test(s.favicon || '') ? s.favicon : '',
    country: s.country || '',
    countryCode: s.countrycode || '',
    state: s.state || '',
    tags: String(s.tags || '').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 4),
    codec: String(s.codec || '').toUpperCase(),
    bitrate: s.bitrate || 0,
    votes: s.votes || 0,
    clicks: s.clickcount || 0,
  };
}

class RadioBrowser {
  constructor(fetchFn, userAgent) {
    this.fetch = fetchFn;
    this.ua = userAgent;
    this.servers = null;
    this.good = null; // last server that answered
  }

  async _servers() {
    if (this.servers) return this.servers;
    let names = [];
    try {
      const res = await this.fetch('https://all.api.radio-browser.info/json/servers', { headers: { 'User-Agent': this.ua } });
      if (res.ok) names = (await res.json()).map((s) => s.name).filter((x) => /\.api\.radio-browser\.info$/.test(x));
    } catch { /* use the fallback list */ }
    names = [...new Set(names.length ? names : FALLBACK_SERVERS)];
    for (let i = names.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [names[i], names[j]] = [names[j], names[i]]; }
    this.servers = names;
    return names;
  }

  /** GET a JSON endpoint, trying servers until one answers. */
  async get(path, params = {}) {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
    const servers = await this._servers();
    const order = this.good ? [this.good, ...servers.filter((s) => s !== this.good)] : servers;
    let lastErr = null;
    for (const host of order.slice(0, 4)) {
      try {
        const res = await this.fetch(`https://${host}${path}${qs ? `?${qs}` : ''}`, { headers: { 'User-Agent': this.ua, Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        this.good = host;
        return data;
      } catch (err) {
        lastErr = err;
      }
    }
    throw new Error(`The radio directory isn't answering (${lastErr ? lastErr.message : 'no servers'})`);
  }

  /**
   * Searches stations. q: {name, countryCode, tag, order: 'clickcount'|'votes'|'trend', limit, offset}.
   * Only stations Discshelf can play are returned (no HLS; MP3/AAC/Ogg/Opus/FLAC).
   */
  async search(q = {}) {
    const order = q.order === 'trend' ? 'clicktrend' : q.order === 'votes' ? 'votes' : 'clickcount';
    const limit = Math.min(Math.max(parseInt(q.limit, 10) || 60, 1), 200);
    const data = await this.get('/json/stations/search', {
      name: q.name || undefined,
      countrycode: q.countryCode || undefined,
      tag: q.tag || undefined,
      tagExact: q.tag ? 'false' : undefined,
      order,
      reverse: 'true',
      hidebroken: 'true',
      limit: String(limit * 2), // some get filtered out below
      offset: String(q.offset || 0),
    });
    const seen = new Set();
    const out = [];
    for (const s of data) {
      if (s.hls === 1 || !PLAYABLE.has(String(s.codec || '').toUpperCase())) continue;
      const st = mapStation(s);
      const dupe = `${st.name.toLowerCase()}|${st.countryCode}`;
      if (!st.url || seen.has(dupe)) continue;
      seen.add(dupe);
      out.push(st);
      if (out.length >= limit) break;
    }
    return { stations: out, more: data.length >= limit * 2 };
  }

  async countries() {
    const data = await this.get('/json/countries', { order: 'stationcount', reverse: 'true' });
    return data.filter((c) => c.iso_3166_1 && c.stationcount >= 5)
      .map((c) => ({ code: c.iso_3166_1.toUpperCase(), name: c.name, count: c.stationcount }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Tells the directory a station was played (it uses this for its popularity ranking). */
  async click(id) {
    if (!/^[0-9a-f-]{36}$/i.test(String(id))) return;
    try { await this.get(`/json/url/${id}`); } catch { /* not important */ }
  }
}

/**
 * Removes ICY metadata blocks from a stream (one every `metaint` bytes) and reports StreamTitle changes.
 */
function icyStripper(metaint, onTitle) {
  let toAudio = metaint;
  let metaLeft = -1; // -1: next byte is the metadata length
  let meta = [];
  let lastTitle = null;
  return new TransformStream({
    transform(chunk, ctrl) {
      let i = 0;
      while (i < chunk.length) {
        if (toAudio > 0) {
          const n = Math.min(toAudio, chunk.length - i);
          ctrl.enqueue(chunk.slice(i, i + n));
          i += n;
          toAudio -= n;
        } else if (metaLeft < 0) {
          metaLeft = chunk[i] * 16;
          i += 1;
          meta = [];
          if (metaLeft === 0) { metaLeft = -1; toAudio = metaint; }
        } else {
          const n = Math.min(metaLeft, chunk.length - i);
          meta.push(chunk.slice(i, i + n));
          i += n;
          metaLeft -= n;
          if (metaLeft === 0) {
            const text = Buffer.concat(meta).toString('utf8').replace(/\0+$/, '');
            const m = /StreamTitle='(.*?)';/s.exec(text);
            if (m) {
              const title = m[1].trim();
              if (title !== lastTitle) { lastTitle = title; try { onTitle(title); } catch { /* ignore */ } }
            }
            metaLeft = -1;
            toAudio = metaint;
          }
        }
      }
    },
  });
}

/** First stream URL in a .pls / .m3u playlist. */
function firstPlaylistUrl(text) {
  const pls = /^File\d+=(https?:\/\/\S+)/mi.exec(text);
  if (pls) return pls[1];
  const line = String(text).split(/\r?\n/).map((l) => l.trim()).find((l) => /^https?:\/\//i.test(l));
  return line || null;
}

module.exports = { RadioBrowser, icyStripper, firstPlaylistUrl, mapStation };
