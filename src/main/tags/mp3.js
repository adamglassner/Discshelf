'use strict';
// ID3v2.2/2.3/2.4 and ID3v1 tags, plus MP3 duration (Xing/Info/VBRI headers, or a CBR estimate).
const { decodeUtf16, cleanText, stripNulls, parseNumberPair, parseYear, imageMimeFromData } = require('./reader');
const { normalizeId3Genre, genreFromIndex, ratingFromPopm, ratingFromFraction, applyReplayGain } = require('./common');

const MAX_ID3_SIZE = 64 * 1024 * 1024;

function synchsafe(buf, o) {
  return ((buf[o] & 0x7F) << 21) | ((buf[o + 1] & 0x7F) << 14) | ((buf[o + 2] & 0x7F) << 7) | (buf[o + 3] & 0x7F);
}

function removeUnsync(buf) {
  const out = Buffer.alloc(buf.length);
  let j = 0;
  for (let i = 0; i < buf.length; i++) {
    out[j++] = buf[i];
    if (buf[i] === 0xFF && buf[i + 1] === 0x00) i++;
  }
  return out.subarray(0, j);
}

function decodeText(enc, buf) {
  switch (enc) {
    case 1: return decodeUtf16(buf, false);
    case 2: return decodeUtf16(buf, true);
    case 3: return buf.toString('utf8');
    default: return buf.toString('latin1');
  }
}

/** Index of the string terminator for this encoding at or after `start` (or -1). */
function findTerminator(buf, start, enc) {
  if (enc === 1 || enc === 2) {
    for (let i = start; i + 1 < buf.length; i += 2) if (buf[i] === 0 && buf[i + 1] === 0) return i;
    return -1;
  }
  return buf.indexOf(0, start);
}

function textFrame(data) {
  if (data.length < 1) return '';
  const enc = data[0];
  const s = decodeText(enc, data.subarray(1));
  // v2.4 allows several null-separated values; keep the first.
  return cleanText(s.split('\u0000')[0]);
}

function pictureFrame(data, v22) {
  try {
    const enc = data[0];
    let o = 1;
    let mime;
    if (v22) {
      const fmt = data.toString('latin1', 1, 4).toUpperCase();
      mime = fmt === 'PNG' ? 'image/png' : 'image/jpeg';
      o = 4;
    } else {
      const end = data.indexOf(0, o);
      if (end < 0) return null;
      mime = data.toString('latin1', o, end);
      o = end + 1;
    }
    const type = data[o]; o += 1;
    const descEnd = findTerminator(data, o, enc);
    if (descEnd < 0) return null;
    o = descEnd + (enc === 1 || enc === 2 ? 2 : 1);
    const pic = data.subarray(o);
    return { type, mime: imageMimeFromData(pic, mime), data: pic };
  } catch {
    return null;
  }
}

/** TXXX: user text, used for "ALBUM ARTIST" by some taggers. */
function userTextFrame(data) {
  const enc = data[0];
  const end = findTerminator(data, 1, enc);
  if (end < 0) return null;
  const key = cleanText(decodeText(enc, data.subarray(1, end))).toUpperCase();
  const value = cleanText(decodeText(enc, data.subarray(end + (enc === 1 || enc === 2 ? 2 : 1))).split('\u0000')[0]);
  return { key, value };
}

/** Reads an ID3v2 tag at `offset`. Returns {size} (total bytes incl. header) or null. */
async function readId3v2(src, offset, tags) {
  const header = await src.read(offset, 10);
  if (header.length < 10 || header.toString('latin1', 0, 3) !== 'ID3') return null;
  const major = header[3];
  const flags = header[5];
  const size = synchsafe(header, 6);
  const total = 10 + size + (flags & 0x10 ? 10 : 0);
  if (major < 2 || major > 4 || size > MAX_ID3_SIZE) return { size: total };

  let body = await src.read(offset + 10, size);
  if (flags & 0x80 && major < 4) body = removeUnsync(body);
  let o = 0;
  if (flags & 0x40 && major >= 3) {
    // extended header
    o = major === 4 ? synchsafe(body, 0) : body.readUInt32BE(0) + 4;
  }

  const v22 = major === 2;
  const idLen = v22 ? 3 : 4;
  const headLen = v22 ? 6 : 10;
  const frames = {};
  const userText = {};
  while (o + headLen <= body.length) {
    const id = body.toString('latin1', o, o + idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break; // padding
    let fsize;
    if (v22) fsize = (body[o + 3] << 16) | (body[o + 4] << 8) | body[o + 5];
    else if (major === 4) fsize = synchsafe(body, o + 4);
    else fsize = body.readUInt32BE(o + 4);
    const fflags = v22 ? 0 : body[o + 9];
    o += headLen;
    if (fsize <= 0 || o + fsize > body.length) break;
    let data = body.subarray(o, o + fsize);
    o += fsize;

    if (major === 4) {
      if (fflags & 0x0C) continue; // compressed or encrypted: skip
      if (fflags & 0x01) data = data.subarray(4); // data length indicator
      if (fflags & 0x02 || flags & 0x80) data = removeUnsync(data);
    } else if (major === 3 && fflags & 0xC0) {
      continue; // compressed or encrypted
    }

    if (id === 'APIC' || id === 'PIC') {
      const pic = pictureFrame(data, v22);
      if (pic) tags.pictures.push(pic);
    } else if ((id === 'POPM' || id === 'POP') && !tags.rating) {
      const end = data.indexOf(0);
      if (end >= 0 && end + 1 < data.length) tags.rating = ratingFromPopm(data[end + 1]);
    } else if ((id === 'USLT' || id === 'ULT') && !tags.lyrics && data.length > 4) {
      // encoding, language (3), description, text
      const enc = data[0];
      const end = findTerminator(data, 4, enc);
      if (end >= 0) {
        const text = decodeText(enc, data.subarray(end + (enc === 1 || enc === 2 ? 2 : 1)));
        tags.lyrics = stripNulls(text).replace(/\r\n?/g, '\n').trim();
      }
    } else if (id === 'TXXX' || id === 'TXX') {
      const t = userTextFrame(data);
      if (t) userText[t.key] = t.value;
    } else if (id[0] === 'T' && !(id in frames)) {
      frames[id] = textFrame(data);
    }
  }

  const f = (...ids) => { for (const id of ids) if (frames[id]) return frames[id]; return ''; };
  if (/^(1|true|yes)$/i.test(userText.LOVED || '')) tags.loved = true;
  applyReplayGain((k) => userText[k], tags);
  if (!tags.lyrics) tags.lyrics = (userText.LYRICS || userText.UNSYNCEDLYRICS || userText.USLT || '').replace(/\\n/g, '\n').trim();
  if (!tags.rating && userText.FMPS_RATING) tags.rating = ratingFromFraction(userText.FMPS_RATING);
  tags.title = f('TIT2', 'TT2') || tags.title;
  tags.artist = f('TPE1', 'TP1') || tags.artist;
  tags.albumArtist = f('TPE2', 'TP2') || userText['ALBUM ARTIST'] || userText.ALBUMARTIST || tags.albumArtist;
  tags.album = f('TALB', 'TAL') || tags.album;
  tags.genre = normalizeId3Genre(f('TCON', 'TCO')) || tags.genre;
  tags.year = parseYear(f('TDRC', 'TYER', 'TYE', 'TDOR', 'TORY')) || tags.year;
  const track = parseNumberPair(f('TRCK', 'TRK'));
  const disc = parseNumberPair(f('TPOS', 'TPA'));
  if (track.no) { tags.trackNo = track.no; tags.trackOf = track.of || tags.trackOf; }
  if (disc.no) { tags.discNo = disc.no; tags.discOf = disc.of || tags.discOf; }
  return { size: total };
}

async function readId3v1(src, tags) {
  if (src.size < 128) return false;
  const b = await src.read(src.size - 128, 128);
  if (b.toString('latin1', 0, 3) !== 'TAG') return false;
  const s = (a, z) => cleanText(b.toString('latin1', a, z).split('\u0000')[0]);
  tags.title = tags.title || s(3, 33);
  tags.artist = tags.artist || s(33, 63);
  tags.album = tags.album || s(63, 93);
  tags.year = tags.year || parseYear(s(93, 97));
  if (b[125] === 0 && b[126] !== 0 && !tags.trackNo) tags.trackNo = b[126];
  if (!tags.genre) tags.genre = genreFromIndex(b[127]);
  return true;
}

// ------------------------------------------------------------------ MPEG audio frames

const BITRATES = {
  // [version1][layer] and [version2][layer] in kbps; index 0 = free, 15 = bad
  1: {
    1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  },
  2: {
    1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  },
};
const SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

function parseFrameHeader(b, o) {
  if (b[o] !== 0xFF || (b[o + 1] & 0xE0) !== 0xE0) return null;
  const versionBits = (b[o + 1] >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
  const layerBits = (b[o + 1] >> 1) & 3; // 3 = L1, 2 = L2, 1 = L3
  const bitrateIdx = (b[o + 2] >> 4) & 0xF;
  const srIdx = (b[o + 2] >> 2) & 3;
  if (versionBits === 1 || layerBits === 0 || bitrateIdx === 0 || bitrateIdx === 15 || srIdx === 3) return null;
  const layer = 4 - layerBits;
  const v = versionBits === 3 ? 1 : 2;
  const bitrate = BITRATES[v][layer][bitrateIdx] * 1000;
  const sampleRate = SAMPLE_RATES[versionBits][srIdx];
  const padding = (b[o + 2] >> 1) & 1;
  const channelMode = (b[o + 3] >> 6) & 3;
  const samplesPerFrame = layer === 1 ? 384 : layer === 2 ? 1152 : v === 1 ? 1152 : 576;
  const frameLength = layer === 1
    ? Math.floor((12 * bitrate) / sampleRate + padding) * 4
    : Math.floor(((samplesPerFrame / 8) * bitrate) / sampleRate) + padding;
  return { v, layer, bitrate, sampleRate, channels: channelMode === 3 ? 1 : 2, samplesPerFrame, frameLength };
}

async function readMpegAudio(src, audioStart, audioEnd, tags) {
  const scan = await src.read(audioStart, 256 * 1024);
  let o = -1;
  let h = null;
  for (let i = 0; i + 4 < scan.length; i++) {
    if (scan[i] !== 0xFF) continue;
    const cand = parseFrameHeader(scan, i);
    if (!cand || cand.frameLength < 21) continue;
    // Confirm with the next frame header when we can see it, to skip false syncs.
    const next = i + cand.frameLength;
    if (next + 4 <= scan.length && !parseFrameHeader(scan, next)) continue;
    o = i; h = cand;
    break;
  }
  if (!h) return;

  tags.codec = `MP3`;
  if (h.layer !== 3) tags.codec = `MPEG Layer ${h.layer}`;
  tags.sampleRate = h.sampleRate;
  tags.channels = h.channels;

  const sideInfo = h.v === 1 ? (h.channels === 1 ? 17 : 32) : (h.channels === 1 ? 9 : 17);
  const xingAt = o + 4 + sideInfo;
  const marker = scan.toString('latin1', xingAt, xingAt + 4);
  let frames = 0;
  let bytes = 0;
  if (marker === 'Xing' || marker === 'Info') {
    const flags = scan.readUInt32BE(xingAt + 4);
    let p = xingAt + 8;
    if (flags & 1) { frames = scan.readUInt32BE(p); p += 4; }
    if (flags & 2) { bytes = scan.readUInt32BE(p); }
  } else if (scan.toString('latin1', o + 36, o + 40) === 'VBRI') {
    bytes = scan.readUInt32BE(o + 36 + 10);
    frames = scan.readUInt32BE(o + 36 + 14);
  }

  const audioBytes = Math.max(0, audioEnd - (audioStart + o));
  if (frames > 0) {
    tags.duration = (frames * h.samplesPerFrame) / h.sampleRate;
    tags.bitrate = tags.duration > 0 ? Math.round(((bytes || audioBytes) * 8) / tags.duration) : h.bitrate;
  } else {
    tags.bitrate = h.bitrate;
    tags.duration = h.bitrate > 0 ? (audioBytes * 8) / h.bitrate : 0;
  }
}

async function parseMp3(src, tags) {
  let offset = 0;
  // Some files carry more than one ID3v2 tag back to back.
  for (let i = 0; i < 3; i++) {
    const r = await readId3v2(src, offset, tags);
    if (!r) break;
    offset += r.size;
  }
  const hasV1 = await readId3v1(src, tags);
  await readMpegAudio(src, offset, src.size - (hasV1 ? 128 : 0), tags);
  return tags;
}

module.exports = { parseMp3, readId3v2 };
