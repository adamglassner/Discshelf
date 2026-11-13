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

// ------------------------------------------------------------------ stations added by address

/** Stream addresses for station pages of hosts whose page isn't the stream (Live365, Zeno, ...). */
function knownStream(u) {
  let m = /live365\.com\/(?:station\/[^?#]*?-|station\/)?(a\d{4,6})\b/i.exec(u);
  return m ? `https://streaming.live365.com/${m[1].toLowerCase()}` : null;
}

/** Stream-looking addresses in a web page (players, playlists, Live365 widgets). */
function streamsInPage(html, base) {
  const found = [];
  const add = (u) => {
    try {
      const abs = new URL(u.replace(/&amp;/g, '&'), base).href;
      if (!found.includes(abs)) found.push(abs);
    } catch { /* not a URL */ }
  };
  const text = String(html);
  for (const m of text.matchAll(/(?:live365\.com\/(?:station\/[^"'\s<>]*?-|embeds\/[^"'\s<>]*?)|streaming\.live365\.com\/)(a\d{4,6})\b/gi)) add(`https://streaming.live365.com/${m[1].toLowerCase()}`);
  for (const m of text.matchAll(/https?:\/\/[^"'\s<>()]+?(?:\.(?:mp3|aac|m3u8?|pls|ogg|opus)|\/(?:stream|live|listen|;)|:\d{4,5}\/?)(?:\?[^"'\s<>()]*)?(?=["'\s<>()])/gi)) add(m[0]);
  for (const m of text.matchAll(/https?:\/\/(?:[a-z0-9-]+\.)*(?:streamtheworld\.com|securenetsystems\.net|zeno\.fm|radio\.co|streamguys1?\.com|radiojar\.com|shoutcast\.com|icecast[^"'\s<>]*)[^"'\s<>()]*/gi)) add(m[0]);
  // Drop things that are plainly pages or images.
  return found.filter((u) => !/\.(?:png|jpe?g|gif|svg|webp|css|js|html?)(?:\?|$)/i.test(u));
}

function pageInfo(html, base) {
  const get = (re) => { const m = re.exec(html); return m ? m[1].replace(/&amp;/g, '&').replace(/&#0?39;/g, "'").replace(/&quot;/g, '"').trim() : ''; };
  const name = get(/<meta[^>]+property=["']og:site_name["'][^>]*content=["']([^"']+)/i) || get(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)/i) || get(/<title[^>]*>([^<]+)/i);
  const icon = get(/<link[^>]+rel=["'][^"']*apple-touch-icon[^"']*["'][^>]*href=["']([^"']+)/i)
    || get(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)/i)
    || get(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*href=["']([^"']+)/i);
  let favicon = '';
  try { favicon = icon ? new URL(icon, base).href : ''; } catch { /* ignore */ }
  return { name: name.split(/\s+[–|-]\s+/)[0].trim(), favicon: /^https?:/i.test(favicon) ? favicon : '' };
}

const CODECS = { 'audio/mpeg': 'MP3', 'audio/mp3': 'MP3', 'audio/aac': 'AAC', 'audio/aacp': 'AAC+', 'audio/x-aac': 'AAC', 'audio/ogg': 'OGG', 'application/ogg': 'OGG', 'audio/opus': 'OPUS', 'audio/flac': 'FLAC' };

/**
 * Works out a playable stream from what someone pastes: a stream address, a .pls/.m3u playlist,
 * or a station's web page (searched for its player's stream). Returns
 * {url, name, favicon, homepage, codec, bitrate, genre} or throws an Error with a readable message.
 */
async function resolveStation(input, fetchFn, ua, { timeoutMs = 10000 } = {}) {
  let start = String(input || '').trim();
  if (!start) throw new Error('Paste the address of the station’s stream or web page.');
  if (!/^[a-z]+:\/\//i.test(start)) start = `https://${start}`;
  if (!/^https?:\/\//i.test(start)) throw new Error('That isn’t a web address.');
  try { start = new URL(start).href; } catch { throw new Error('That isn’t a web address.'); }
  const headers = { 'Icy-MetaData': '1', 'User-Agent': ua };
  const page = { name: '', favicon: '', homepage: '' };
  const candidates = [];
  const known = knownStream(start);
  if (known) candidates.push(known);
  candidates.push(start);
  const tried = new Set();
  let lastProblem = '';

  async function probe(url, depth) {
    if (tried.has(url) || tried.size > 12) return null;
    tried.add(url);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchFn(url, { headers, signal: ctl.signal, redirect: 'follow' });
      const type = (res.headers.get('content-type') || '').toLowerCase().split(';')[0].trim();
      if (!res.ok) { lastProblem = `the address answered with an error (HTTP ${res.status})`; ctl.abort(); return null; }
      const icy = (k) => res.headers.get(`icy-${k}`) || '';
      if (/^audio\/|application\/ogg/.test(type) && !/mpegurl|scpls|x-pls/.test(type)) {
        ctl.abort();
        const br = parseInt(icy('br') || (res.headers.get('ice-audio-info') || '').replace(/.*bitrate=(\d+).*/, '$1'), 10) || 0;
        return { url: res.url || url, name: icy('name'), genre: icy('genre'), homepage: /^https?:/.test(icy('url')) ? icy('url') : '', codec: CODECS[type] || type.replace('audio/', '').toUpperCase(), bitrate: br };
      }
      if (depth >= 2) { ctl.abort(); return null; }
      const body = (await res.text()).slice(0, 2_000_000);
      if (/mpegurl|scpls|x-pls/.test(type) || /^#EXTM3U|^\[playlist\]/im.test(body.slice(0, 200)) || /\.(?:m3u|pls)(?:\?|$)/i.test(url)) {
        const next = firstPlaylistUrl(body);
        return next ? probe(new URL(next, url).href, depth + 1) : null;
      }
      if (/html/.test(type) || /<html|<!doctype/i.test(body.slice(0, 500))) {
        if (depth === 0) { Object.assign(page, pageInfo(body, res.url || url)); page.homepage = res.url || url; }
        const found = streamsInPage(body, res.url || url);
        for (const f of found.slice(0, 8)) {
          const r = await probe(f, depth + 1);
          if (r) return r;
        }
        // A "Listen live" / player page linked from here.
        if (depth === 0) {
          for (const m of body.matchAll(/href=["']([^"']*(?:listen|player|stream|live)[^"']*)["']/gi)) {
            let link; try { link = new URL(m[1], res.url || url).href; } catch { continue; }
            if (!/^https?:/.test(link) || tried.has(link)) continue;
            const r = await probe(link, depth + 1);
            if (r) return r;
            if (tried.size > 10) break;
          }
        }
        lastProblem = lastProblem || 'no stream was found on that page';
        return null;
      }
      lastProblem = `that address isn’t an audio stream (${type || 'unknown type'})`;
      return null;
    } catch (err) {
      lastProblem = ctl.signal.aborted ? 'the station didn’t answer in time' : 'the address couldn’t be reached';
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  for (const c of candidates) {
    const r = await probe(c, 0);
    if (r) {
      return {
        url: r.url,
        name: (r.name && !/^(unspecified|no name|stream)$/i.test(r.name) ? r.name : '') || page.name || '',
        favicon: page.favicon || '',
        homepage: page.homepage || r.homepage || '',
        codec: r.codec || '',
        bitrate: r.bitrate || 0,
        genre: r.genre || '',
      };
    }
  }
  throw new Error(`Couldn’t find a stream there: ${lastProblem || 'nothing playable'}. Try the station’s “Listen live” link, or the stream address itself.`);
}

module.exports = { RadioBrowser, icyStripper, firstPlaylistUrl, mapStation, resolveStation, streamsInPage, knownStream };
