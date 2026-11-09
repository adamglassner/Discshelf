'use strict';
// MP4 / M4A: walks the box tree (never reads mdat), mvhd for duration, stsd for the codec, ilst for tags.
const { cleanText, parseYear, imageMimeFromData } = require('./reader');
const { genreFromIndex, ratingFromPercent, applyReplayGain } = require('./common');

const MAX_MOOV = 128 * 1024 * 1024;
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'ilst', 'edts', 'dinf']);

/** Iterates boxes in buf[start, end). */
function* boxes(buf, start, end) {
  let o = start;
  while (o + 8 <= end) {
    let size = buf.readUInt32BE(o);
    const type = buf.toString('latin1', o + 4, o + 8);
    let header = 8;
    if (size === 1) {
      if (o + 16 > end) return;
      size = Number(buf.readBigUInt64BE(o + 8));
      header = 16;
    } else if (size === 0) {
      size = end - o;
    }
    if (size < header || o + size > end) return;
    yield { type, start: o + header, end: o + size };
    o += size;
  }
}

function parseIlst(buf, start, end, tags) {
  for (const item of boxes(buf, start, end)) {
    if (item.type === '----') {
      // Freeform: mean / name / data (Discshelf keeps RATING and LOVED here).
      let name = '';
      let value = '';
      for (const c of boxes(buf, item.start, item.end)) {
        if (c.type === 'name') name = buf.toString('utf8', c.start + 4, c.end);
        if (c.type === 'data') value = buf.toString('utf8', c.start + 8, c.end);
      }
      const key = name.toUpperCase();
      if (key === 'RATING') tags.rating = ratingFromPercent(value) || tags.rating;
      if (key === 'LOVED' && /^(1|true|yes)$/i.test(value.trim())) tags.loved = true;
      if (key.startsWith('REPLAYGAIN_')) applyReplayGain((k) => (k === key ? value : null), tags);
      continue;
    }
    for (const d of boxes(buf, item.start, item.end)) {
      if (d.type !== 'data' || d.end - d.start < 8) continue;
      const dataType = buf.readUInt32BE(d.start) & 0xFFFFFF;
      const value = buf.subarray(d.start + 8, d.end);
      const text = () => cleanText(value.toString('utf8'));
      switch (item.type) {
        case '\xA9nam': tags.title = text() || tags.title; break;
        case '\xA9ART': tags.artist = text() || tags.artist; break;
        case 'aART': tags.albumArtist = text() || tags.albumArtist; break;
        case '\xA9alb': tags.album = text() || tags.album; break;
        case '\xA9gen': tags.genre = text() || tags.genre; break;
        case '\xA9lyr': tags.lyrics = value.toString('utf8').replace(/\r\n?/g, '\n').trim() || tags.lyrics; break;
        case 'gnre': if (value.length >= 2) tags.genre = tags.genre || genreFromIndex(value.readUInt16BE(0) - 1); break;
        case '\xA9day': tags.year = parseYear(text()) || tags.year; break;
        case 'trkn':
          if (value.length >= 6) { tags.trackNo = value.readUInt16BE(2); tags.trackOf = value.readUInt16BE(4); }
          break;
        case 'disk':
          if (value.length >= 6) { tags.discNo = value.readUInt16BE(2); tags.discOf = value.readUInt16BE(4); }
          break;
        case 'covr': {
          const fallback = dataType === 14 ? 'image/png' : 'image/jpeg';
          tags.pictures.push({ type: 3, mime: imageMimeFromData(value, fallback), data: Buffer.from(value) });
          break;
        }
        default: break;
      }
      break; // first data box only
    }
  }
}

function parseMoov(buf, start, end, tags, state) {
  for (const b of boxes(buf, start, end)) {
    if (b.type === 'mvhd') {
      const version = buf[b.start];
      if (version === 1) {
        const timescale = buf.readUInt32BE(b.start + 20);
        const duration = Number(buf.readBigUInt64BE(b.start + 24));
        if (timescale) state.duration = duration / timescale;
      } else {
        const timescale = buf.readUInt32BE(b.start + 12);
        const duration = buf.readUInt32BE(b.start + 16);
        if (timescale) state.duration = duration / timescale;
      }
    } else if (b.type === 'hdlr') {
      state.handler = buf.toString('latin1', b.start + 8, b.start + 12);
    } else if (b.type === 'stsd') {
      if (state.handler !== 'soun' || state.codec) continue;
      const entry = b.start + 8; // version/flags + entry count
      if (entry + 36 > b.end) continue;
      const format = buf.toString('latin1', entry + 4, entry + 8);
      state.codec = format;
      state.channels = buf.readUInt16BE(entry + 8 + 16);
      state.bitsPerSample = buf.readUInt16BE(entry + 8 + 18);
      state.sampleRate = buf.readUInt32BE(entry + 8 + 24) >>> 16;
    } else if (b.type === 'meta') {
      // ISO meta is a full box (4 bytes of version/flags); QuickTime meta isn't.
      let s = b.start;
      if (buf.toString('latin1', b.start + 4, b.start + 8) !== 'hdlr') s += 4;
      for (const m of boxes(buf, s, b.end)) if (m.type === 'ilst') parseIlst(buf, m.start, m.end, tags);
    } else if (b.type === 'trak') {
      state.handler = ''; // each track has its own handler (sound, video, text...)
      parseMoov(buf, b.start, b.end, tags, state);
    } else if (CONTAINERS.has(b.type)) {
      parseMoov(buf, b.start, b.end, tags, state);
    }
  }
}

async function parseMp4(src, tags) {
  let o = 0;
  let moov = null;
  let sawFtyp = false;
  while (o + 8 <= src.size) {
    const h = await src.read(o, 16);
    if (h.length < 8) break;
    let size = h.readUInt32BE(0);
    const type = h.toString('latin1', 4, 8);
    if (size === 1) size = Number(h.readBigUInt64BE(8));
    else if (size === 0) size = src.size - o;
    if (size < 8) break;
    if (type === 'ftyp') sawFtyp = true;
    if (type === 'moov') {
      if (size > MAX_MOOV) throw new Error('moov box too large');
      moov = await src.read(o, size);
      break;
    }
    o += size;
  }
  if (!sawFtyp && !moov) throw new Error('Not an MP4 file');
  if (!moov) return tags;

  const state = { duration: 0, codec: '', channels: 0, sampleRate: 0, bitsPerSample: 0, handler: '' };
  const headerLen = moov.readUInt32BE(0) === 1 ? 16 : 8;
  parseMoov(moov, headerLen, moov.length, tags, state);

  tags.duration = state.duration;
  tags.channels = state.channels;
  tags.sampleRate = state.sampleRate;
  if (state.codec === 'alac') { tags.codec = 'ALAC'; tags.bitsPerSample = state.bitsPerSample; }
  else if (state.codec === 'mp4a') tags.codec = 'AAC';
  else if (state.codec) tags.codec = state.codec.trim().toUpperCase();
  if (tags.duration > 0) tags.bitrate = Math.round((src.size * 8) / tags.duration);
  return tags;
}

module.exports = { parseMp4 };
