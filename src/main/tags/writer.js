'use strict';
// Writes song details and cover art into music files: MP3 (ID3v2.3 / v2.4, plus ID3v1 when present),
// FLAC, MP4/M4A (iTunes atoms), Ogg Vorbis / Opus and WAV.
//
// Safety: the new file is written next to the original under a temporary name, read back and checked
// (the details must read back as written and the length must match), and only then swapped in for the
// original. The audio itself is copied byte for byte; only the tag area is rebuilt.

const fs = require('fs');
const path = require('path');
const { FileSource } = require('./reader');
const { readTags } = require('./index');
const { ID3V1_GENRES } = require('./common');

const FIELD_KEYS = ['title', 'artist', 'albumArtist', 'album', 'genre', 'year', 'trackNo', 'trackOf', 'discNo', 'discOf'];
const MAX_PICTURE = 16 * 1024 * 1024 - 1024;

class TagWriteError extends Error {}

// ------------------------------------------------------------------ small helpers

const u32be = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const synchsafe = (n) => Buffer.from([(n >> 21) & 0x7F, (n >> 14) & 0x7F, (n >> 7) & 0x7F, n & 0x7F]);
const readSynchsafe = (b, o) => ((b[o] & 0x7F) << 21) | ((b[o + 1] & 0x7F) << 14) | ((b[o + 2] & 0x7F) << 7) | (b[o + 3] & 0x7F);
const isEmpty = (v) => v === undefined || v === null || v === '' || v === 0;

/** Pixel size of a JPEG or PNG (0 × 0 if unknown). */
function imageSize(data) {
  try {
    if (data[0] === 0x89 && data.toString('latin1', 1, 4) === 'PNG') return { w: data.readUInt32BE(16), h: data.readUInt32BE(20), depth: 24 };
    if (data[0] === 0xFF && data[1] === 0xD8) {
      let o = 2;
      while (o + 9 < data.length) {
        if (data[o] !== 0xFF) { o++; continue; }
        const marker = data[o + 1];
        const len = data.readUInt16BE(o + 2);
        if (marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker)) {
          return { h: data.readUInt16BE(o + 5), w: data.readUInt16BE(o + 7), depth: 24 };
        }
        o += 2 + len;
      }
    }
  } catch { /* fall through */ }
  return { w: 0, h: 0, depth: 0 };
}

/** FLAC-style PICTURE structure (also used, base64-encoded, in Ogg files). */
function flacPicture(pic) {
  const mime = Buffer.from(pic.mime, 'latin1');
  const { w, h, depth } = imageSize(pic.data);
  return Buffer.concat([u32be(3), u32be(mime.length), mime, u32be(0), u32be(w), u32be(h), u32be(depth), u32be(0), u32be(pic.data.length), pic.data]);
}

/**
 * Writes `parts` (Buffers, or {start, end} byte ranges of the source file) to `dest`.
 */
async function assemble(src, dest, parts) {
  const out = await fs.promises.open(dest, 'w');
  try {
    let pos = 0;
    for (const p of parts) {
      if (Buffer.isBuffer(p)) {
        await out.write(p, 0, p.length, pos);
        pos += p.length;
        continue;
      }
      const CHUNK = 1024 * 1024;
      for (let o = p.start; o < p.end; o += CHUNK) {
        const buf = await src.read(o, Math.min(CHUNK, p.end - o));
        if (!buf.length) throw new TagWriteError('The file ended earlier than expected');
        await out.write(buf, 0, buf.length, pos);
        pos += buf.length;
      }
    }
    await out.sync();
  } finally {
    await out.close();
  }
}

// ------------------------------------------------------------------ ID3v2 (MP3, and the "id3 " chunk in WAV)

const ID3_FRAMES = {
  title: ['TIT2'], artist: ['TPE1'], albumArtist: ['TPE2'], album: ['TALB'], genre: ['TCON'],
  year: ['TYER', 'TDRC', 'TDAT', 'TIME', 'TRDA', 'TDOR', 'TORY'], track: ['TRCK'], disc: ['TPOS'],
};

/** Raw frames of an ID3v2.3 / v2.4 tag body (unsynchronisation already removed). */
function parseId3Frames(body, major) {
  const frames = [];
  let o = 0;
  while (o + 10 <= body.length) {
    const id = body.toString('latin1', o, o + 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const size = major === 4 ? readSynchsafe(body, o + 4) : body.readUInt32BE(o + 4);
    if (size < 0 || o + 10 + size > body.length) break;
    frames.push({ id, flags: body.subarray(o + 8, o + 10), data: body.subarray(o + 10, o + 10 + size) });
    o += 10 + size;
  }
  return frames;
}

function id3Text(text, major) {
  if (major === 4) return Buffer.concat([Buffer.from([3]), Buffer.from(text, 'utf8')]);
  if (/^[\x20-\x7e]*$/.test(text)) return Buffer.concat([Buffer.from([0]), Buffer.from(text, 'latin1')]);
  return Buffer.concat([Buffer.from([1, 0xFF, 0xFE]), Buffer.from(text, 'utf16le')]);
}

function id3Frame(id, data, major, flags = Buffer.alloc(2)) {
  return Buffer.concat([Buffer.from(id, 'latin1'), major === 4 ? synchsafe(data.length) : u32be(data.length), flags, data]);
}

const pair = (no, of) => (no ? (of ? `${no}/${of}` : String(no)) : '');

/**
 * Builds a new ID3v2 tag. `existing` is the old tag (Buffer incl. header) or null; `v` the merged values;
 * `changed` which value groups to replace; `art` undefined (keep) / null (remove) / {mime, data}.
 */
function buildId3(existing, v, changed, art, padding) {
  let major = 3;
  let keep = [];
  if (existing) {
    const ver = existing[3];
    const flags = existing[5];
    const size = readSynchsafe(existing, 6);
    if (ver === 3 || ver === 4) {
      major = ver;
      let body = existing.subarray(10, 10 + size);
      if (flags & 0x80 && ver === 3) body = removeUnsync(body);
      let o = 0;
      if (flags & 0x40) o = ver === 4 ? readSynchsafe(body, 0) : body.readUInt32BE(0) + 4;
      keep = parseId3Frames(body.subarray(o), ver);
    } else {
      // ID3v2.2: rewritten from scratch as v2.3 with every detail we know.
      for (const k of Object.keys(ID3_FRAMES)) changed.add(k);
    }
  }
  const drop = new Set();
  for (const k of changed) for (const id of ID3_FRAMES[k] || []) drop.add(id);
  if (art !== undefined) drop.add('APIC');
  const frames = keep.filter((f) => !drop.has(f.id)).map((f) => id3Frame(f.id, f.data, major, f.flags));

  const text = (id, value) => { if (!isEmpty(value)) frames.push(id3Frame(id, id3Text(String(value), major), major)); };
  if (changed.has('title')) text('TIT2', v.title);
  if (changed.has('artist')) text('TPE1', v.artist);
  if (changed.has('albumArtist')) text('TPE2', v.albumArtist);
  if (changed.has('album')) text('TALB', v.album);
  if (changed.has('genre')) text('TCON', v.genre);
  if (changed.has('year')) text(major === 4 ? 'TDRC' : 'TYER', v.year ? String(v.year) : '');
  if (changed.has('track')) text('TRCK', pair(v.trackNo, v.trackOf));
  if (changed.has('disc')) text('TPOS', pair(v.discNo, v.discOf));
  if (art) {
    const head = Buffer.concat([Buffer.from([0]), Buffer.from(`${art.mime}\0`, 'latin1'), Buffer.from([3, 0])]);
    frames.push(id3Frame('APIC', Buffer.concat([head, art.data]), major));
  }
  const body = Buffer.concat([...frames, Buffer.alloc(padding)]);
  const header = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([major, 0, 0]), synchsafe(body.length)]);
  return Buffer.concat([header, body]);
}

function removeUnsync(buf) {
  const out = Buffer.alloc(buf.length);
  let j = 0;
  for (let i = 0; i < buf.length; i++) { out[j++] = buf[i]; if (buf[i] === 0xFF && buf[i + 1] === 0x00) i++; }
  return out.subarray(0, j);
}

/** Field names → ID3 frame groups. */
function id3Groups(fields) {
  const g = new Set();
  for (const k of Object.keys(fields)) {
    if (k === 'trackNo' || k === 'trackOf') g.add('track');
    else if (k === 'discNo' || k === 'discOf') g.add('disc');
    else g.add(k);
  }
  return g;
}

async function readTagAt(src, offset) {
  const head = await src.read(offset, 10);
  if (head.length < 10 || head.toString('latin1', 0, 3) !== 'ID3') return null;
  const size = readSynchsafe(head, 6) + 10 + (head[5] & 0x10 ? 10 : 0);
  return src.read(offset, size);
}

function latin1Field(s, len) {
  const b = Buffer.alloc(len);
  b.write(String(s || '').replace(/[^\x20-\xff]/g, '?').slice(0, len), 'latin1');
  return b;
}

async function writeMp3(src, dest, v, fields, art) {
  const existing = await readTagAt(src, 0);
  const audioStart = existing ? existing.length : 0;
  const tail = src.size >= 128 ? await src.read(src.size - 128, 128) : Buffer.alloc(0);
  const hasV1 = tail.length === 128 && tail.toString('latin1', 0, 3) === 'TAG';
  const tag = buildId3(existing, v, id3Groups(fields), art, 2048);
  const parts = [tag, { start: audioStart, end: src.size - (hasV1 ? 128 : 0) }];
  if (hasV1) {
    // Keep the old-style ID3v1 tag at the end in step with the new details.
    const v1 = Buffer.from(tail);
    latin1Field(v.title, 30).copy(v1, 3);
    latin1Field(v.artist, 30).copy(v1, 33);
    latin1Field(v.album, 30).copy(v1, 63);
    latin1Field(v.year ? String(v.year) : '', 4).copy(v1, 93);
    if (v1[125] === 0) v1[126] = Math.min(255, v.trackNo || 0);
    if ('genre' in fields) {
      const gi = ID3V1_GENRES.findIndex((g) => g.toLowerCase() === v.genre.toLowerCase());
      v1[127] = gi >= 0 ? gi : 255;
    }
    parts.push(v1);
  }
  await assemble(src, dest, parts);
}

// ------------------------------------------------------------------ Vorbis comments (FLAC, Ogg)

const VORBIS_KEYS = {
  title: ['TITLE'], artist: ['ARTIST'], albumArtist: ['ALBUMARTIST', 'ALBUM ARTIST', 'ALBUM_ARTIST'], album: ['ALBUM'],
  genre: ['GENRE'], year: ['DATE', 'YEAR'], track: ['TRACKNUMBER', 'TRACKTOTAL', 'TOTALTRACKS'], disc: ['DISCNUMBER', 'DISCTOTAL', 'TOTALDISCS'],
};

function parseVorbisComment(buf) {
  let o = 0;
  const vlen = buf.readUInt32LE(o); o += 4;
  const vendor = buf.subarray(o, o + vlen); o += vlen;
  const count = buf.readUInt32LE(o); o += 4;
  const entries = [];
  for (let i = 0; i < count && o + 4 <= buf.length; i++) {
    const len = buf.readUInt32LE(o); o += 4;
    entries.push(buf.subarray(o, o + len)); o += len;
  }
  return { vendor, entries, end: o };
}

function buildVorbisComment(existing, v, fields, art, keepPictures) {
  const groups = id3Groups(fields);
  const drop = new Set();
  for (const g of groups) for (const k of VORBIS_KEYS[g] || []) drop.add(k);
  if (art !== undefined && !keepPictures) drop.add('METADATA_BLOCK_PICTURE');
  const vendor = existing ? existing.vendor : Buffer.from('Discshelf', 'utf8');
  const entries = (existing ? existing.entries : []).filter((e) => {
    const eq = e.indexOf(0x3D);
    return eq <= 0 || !drop.has(e.toString('utf8', 0, eq).toUpperCase());
  });
  const add = (k, val) => { if (!isEmpty(val)) entries.push(Buffer.from(`${k}=${val}`, 'utf8')); };
  if (groups.has('title')) add('TITLE', v.title);
  if (groups.has('artist')) add('ARTIST', v.artist);
  if (groups.has('albumArtist')) add('ALBUMARTIST', v.albumArtist);
  if (groups.has('album')) add('ALBUM', v.album);
  if (groups.has('genre')) add('GENRE', v.genre);
  if (groups.has('year')) add('DATE', v.year || '');
  if (groups.has('track')) { add('TRACKNUMBER', v.trackNo || ''); add('TRACKTOTAL', v.trackOf || ''); }
  if (groups.has('disc')) { add('DISCNUMBER', v.discNo || ''); add('DISCTOTAL', v.discOf || ''); }
  if (art && !keepPictures) add('METADATA_BLOCK_PICTURE', flacPicture(art).toString('base64'));
  return Buffer.concat([u32le(vendor.length), vendor, u32le(entries.length), ...entries.flatMap((e) => [u32le(e.length), e])]);
}

// ------------------------------------------------------------------ FLAC

async function writeFlac(src, dest, v, fields, art) {
  let o = 0;
  const id3 = await readTagAt(src, 0);
  if (id3) o = id3.length;
  const prefix = await src.read(0, o);
  if ((await src.read(o, 4)).toString('latin1') !== 'fLaC') throw new TagWriteError('Not a FLAC file');
  o += 4;
  const blocks = [];
  let last = false;
  while (!last) {
    const h = await src.read(o, 4);
    if (h.length < 4) throw new TagWriteError('The FLAC header is damaged');
    last = (h[0] & 0x80) !== 0;
    const type = h[0] & 0x7F;
    const len = (h[1] << 16) | (h[2] << 8) | h[3];
    blocks.push({ type, data: await src.read(o + 4, len) });
    o += 4 + len;
  }
  const audioStart = o;
  if (!blocks.length || blocks[0].type !== 0) throw new TagWriteError('The FLAC header is damaged');

  const vcBlock = blocks.find((b) => b.type === 4);
  const vc = buildVorbisComment(vcBlock ? parseVorbisComment(vcBlock.data) : null, v, fields, art, true);
  const out = [];
  for (const b of blocks) {
    if (b.type === 4 || b.type === 1) continue; // comments (rebuilt), padding (rebuilt)
    if (b.type === 6 && art !== undefined) continue; // pictures: replaced or removed
    out.push(b);
  }
  out.splice(1, 0, { type: 4, data: vc });
  if (art) {
    const pic = flacPicture(art);
    if (pic.length > 0xFFFFFF) throw new TagWriteError('That artwork is too large for a FLAC file (16 MB)');
    out.push({ type: 6, data: pic });
  }
  out.push({ type: 1, data: Buffer.alloc(4096) });
  const meta = out.map((b, i) => Buffer.concat([
    Buffer.from([(i === out.length - 1 ? 0x80 : 0) | b.type, (b.data.length >> 16) & 0xFF, (b.data.length >> 8) & 0xFF, b.data.length & 0xFF]),
    b.data,
  ]));
  await assemble(src, dest, [prefix, Buffer.from('fLaC', 'latin1'), ...meta, { start: audioStart, end: src.size }]);
}

// ------------------------------------------------------------------ MP4 / M4A

const MP4_CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'edts', 'dinf']);

function parseMp4(buf, start, end) {
  const out = [];
  let o = start;
  while (o + 8 <= end) {
    let size = buf.readUInt32BE(o);
    const type = buf.toString('latin1', o + 4, o + 8);
    let hdr = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(o + 8)); hdr = 16; } else if (size === 0) size = end - o;
    if (size < hdr || o + size > end) throw new TagWriteError('The MP4 structure is damaged');
    const box = { type, raw: buf.subarray(o, o + size) };
    if (MP4_CONTAINERS.has(type)) box.children = parseMp4(buf, o + hdr, o + size);
    else if (type === 'meta') {
      const full = buf.toString('latin1', o + hdr + 4, o + hdr + 8) !== 'hdlr';
      box.prefix = full ? buf.subarray(o + hdr, o + hdr + 4) : Buffer.alloc(0);
      box.children = parseMp4(buf, o + hdr + box.prefix.length, o + size);
    } else if (type === 'ilst') box.children = parseMp4(buf, o + hdr, o + size);
    out.push(box);
    o += size;
  }
  return out;
}

function mp4Box(type, ...payload) {
  const body = Buffer.concat(payload);
  return Buffer.concat([u32be(body.length + 8), Buffer.from(type, 'latin1'), body]);
}

function serializeMp4(box) {
  if (!box.children) return box.raw;
  return mp4Box(box.type, box.prefix || Buffer.alloc(0), ...box.children.map(serializeMp4));
}

const ILST_KEYS = {
  title: ['\xA9nam'], artist: ['\xA9ART'], albumArtist: ['aART'], album: ['\xA9alb'], genre: ['\xA9gen', 'gnre'],
  year: ['\xA9day'], track: ['trkn'], disc: ['disk'],
};

function ilstItem(name, type, payload) {
  return { type: name, raw: mp4Box(name, mp4Box('data', u32be(type), u32be(0), payload)) };
}

function buildIlst(ilst, v, fields, art) {
  const groups = id3Groups(fields);
  const drop = new Set();
  for (const g of groups) for (const k of ILST_KEYS[g] || []) drop.add(k);
  if (art !== undefined) drop.add('covr');
  const items = ilst.children.filter((c) => !drop.has(c.type));
  const text = (name, val) => { if (!isEmpty(val)) items.push(ilstItem(name, 1, Buffer.from(String(val), 'utf8'))); };
  if (groups.has('title')) text('\xA9nam', v.title);
  if (groups.has('artist')) text('\xA9ART', v.artist);
  if (groups.has('albumArtist')) text('aART', v.albumArtist);
  if (groups.has('album')) text('\xA9alb', v.album);
  if (groups.has('genre')) text('\xA9gen', v.genre);
  if (groups.has('year')) text('\xA9day', v.year || '');
  const num = (n) => Buffer.from([(n >> 8) & 0xFF, n & 0xFF]);
  if (groups.has('track') && (v.trackNo || v.trackOf)) items.push(ilstItem('trkn', 0, Buffer.concat([Buffer.alloc(2), num(v.trackNo || 0), num(v.trackOf || 0), Buffer.alloc(2)])));
  if (groups.has('disc') && (v.discNo || v.discOf)) items.push(ilstItem('disk', 0, Buffer.concat([Buffer.alloc(2), num(v.discNo || 0), num(v.discOf || 0)])));
  if (art) items.push(ilstItem('covr', art.mime === 'image/png' ? 14 : 13, art.data));
  ilst.children = items;
}

function findChild(box, type) { return box.children ? box.children.find((c) => c.type === type) : null; }

/** Adds `delta` to every chunk offset (stco / co64) that points at or after `from`. */
function shiftChunkOffsets(box, delta, from) {
  for (const c of box.children || []) {
    if (c.children) { shiftChunkOffsets(c, delta, from); continue; }
    if (c.type !== 'stco' && c.type !== 'co64') continue;
    const b = Buffer.from(c.raw);
    const hdr = b.readUInt32BE(0) === 1 ? 16 : 8;
    const count = b.readUInt32BE(hdr + 4);
    for (let i = 0; i < count; i++) {
      if (c.type === 'stco') {
        const at = hdr + 8 + i * 4;
        const val = b.readUInt32BE(at);
        if (val >= from) {
          const nv = val + delta;
          if (nv > 0xFFFFFFFF) throw new TagWriteError('This MP4 file is too large to retag');
          b.writeUInt32BE(nv, at);
        }
      } else {
        const at = hdr + 8 + i * 8;
        const val = b.readBigUInt64BE(at);
        if (val >= BigInt(from)) b.writeBigUInt64BE(val + BigInt(delta), at);
      }
    }
    c.raw = b;
  }
}

async function writeMp4(src, dest, v, fields, art) {
  // Top-level boxes (headers only; mdat is never loaded).
  const top = [];
  let o = 0;
  while (o + 8 <= src.size) {
    const h = await src.read(o, 16);
    let size = h.readUInt32BE(0);
    const type = h.toString('latin1', 4, 8);
    if (size === 1) size = Number(h.readBigUInt64BE(8)); else if (size === 0) size = src.size - o;
    if (size < 8 || o + size > src.size) throw new TagWriteError('The MP4 structure is damaged');
    top.push({ type, start: o, size });
    o += size;
  }
  if (top.some((b) => b.type === 'moof')) throw new TagWriteError('Fragmented MP4 files can’t be retagged');
  const mi = top.findIndex((b) => b.type === 'moov');
  if (mi < 0) throw new TagWriteError('This MP4 file has no moov box');
  const old = top[mi];
  if (old.size > 128 * 1024 * 1024) throw new TagWriteError('The MP4 header is too large');
  const moovBuf = await src.read(old.start, old.size);
  const [moov] = parseMp4(moovBuf, 0, moovBuf.length);

  // moov → udta → meta → ilst, created when missing.
  let udta = findChild(moov, 'udta');
  if (!udta) { udta = { type: 'udta', children: [] }; moov.children.push(udta); }
  let meta = findChild(udta, 'meta');
  if (!meta) {
    const hdlr = mp4Box('hdlr', Buffer.alloc(8), Buffer.from('mdirappl', 'latin1'), Buffer.alloc(9));
    meta = { type: 'meta', prefix: Buffer.alloc(4), children: [{ type: 'hdlr', raw: hdlr }] };
    udta.children.push(meta);
  }
  let ilst = findChild(meta, 'ilst');
  if (!ilst) { ilst = { type: 'ilst', children: [] }; meta.children.push(ilst); }
  buildIlst(ilst, v, fields, art);

  const mdatAfter = top.slice(mi + 1).some((b) => b.type === 'mdat');
  let newMoov = serializeMp4(moov);
  const parts = top.slice(0, mi).map((b) => ({ start: b.start, end: b.start + b.size }));
  let rest = mi + 1;
  if (mdatAfter) {
    const next = top[mi + 1];
    const delta = newMoov.length - old.size;
    if (next && (next.type === 'free' || next.type === 'skip') && next.size - delta >= 8) {
      // Padding right after moov absorbs the change, so nothing in mdat moves.
      parts.push(newMoov, mp4Box('free', Buffer.alloc(next.size - delta - 8)));
      rest = mi + 2;
    } else {
      // mdat moves: fix the chunk offsets, and leave some padding for next time.
      const pad = 2048;
      const shift = newMoov.length + pad - old.size;
      shiftChunkOffsets(moov, shift, old.start + old.size);
      newMoov = serializeMp4(moov);
      parts.push(newMoov, mp4Box('free', Buffer.alloc(pad - 8)));
    }
  } else {
    parts.push(newMoov);
  }
  for (const b of top.slice(rest)) parts.push({ start: b.start, end: b.start + b.size });
  await assemble(src, dest, parts);
}

// ------------------------------------------------------------------ Ogg (Vorbis, Opus)

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? ((r << 1) ^ 0x04C11DB7) >>> 0 : (r << 1) >>> 0;
    t[i] = r >>> 0;
  }
  return t;
})();

function oggCrc(buf) {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ buf[i]) & 0xFF]) >>> 0;
  return crc >>> 0;
}

function makePage({ flags, granule, serial, seq, segments, body }) {
  const h = Buffer.alloc(27);
  h.write('OggS', 0, 'latin1');
  h[4] = 0;
  h[5] = flags;
  h.writeBigInt64LE(granule, 6);
  h.writeUInt32LE(serial, 14);
  h.writeUInt32LE(seq, 18);
  h.writeUInt32LE(0, 22);
  h[26] = segments.length;
  const page = Buffer.concat([h, Buffer.from(segments), body]);
  page.writeUInt32LE(oggCrc(page), 22);
  return page;
}

function readPages(buf) {
  const pages = [];
  let o = 0;
  while (o + 27 <= buf.length) {
    if (buf.toString('latin1', o, o + 4) !== 'OggS') throw new TagWriteError('The Ogg file is damaged');
    const nseg = buf[o + 26];
    const segs = buf.subarray(o + 27, o + 27 + nseg);
    let len = 0;
    for (const s of segs) len += s;
    const end = o + 27 + nseg + len;
    if (end > buf.length) throw new TagWriteError('The Ogg file is cut short');
    pages.push({ start: o, end, flags: buf[o + 5], granule: buf.readBigInt64LE(o + 6), serial: buf.readUInt32LE(o + 14), seq: buf.readUInt32LE(o + 18), segs, body: buf.subarray(o + 27 + nseg, end) });
    o = end;
  }
  return pages;
}

/** Splits packets into pages (header pages: granule 0 when a packet ends on the page, -1 otherwise). */
function paginate(packets, serial, firstSeq) {
  const pages = [];
  let segs = [];
  let body = [];
  let continued = false;
  let endsPacket = false;
  const flush = (nextContinued) => {
    pages.push(makePage({ flags: continued ? 1 : 0, granule: endsPacket ? 0n : -1n, serial, seq: firstSeq + pages.length, segments: segs, body: Buffer.concat(body) }));
    segs = []; body = []; endsPacket = false; continued = nextContinued;
  };
  for (const p of packets) {
    let o = 0;
    for (;;) {
      const n = Math.min(255, p.length - o);
      segs.push(n);
      body.push(p.subarray(o, o + n));
      o += n;
      const done = n < 255;
      if (done) endsPacket = true;
      if (segs.length === 255) flush(!done);
      if (done) break;
    }
  }
  if (segs.length) flush(false);
  return pages;
}

async function writeOgg(src, dest, v, fields, art) {
  if (src.size > 300 * 1024 * 1024) throw new TagWriteError('This Ogg file is too large to retag');
  const buf = await src.read(0, src.size);
  const pages = readPages(buf);
  if (!pages.length) throw new TagWriteError('Not an Ogg file');
  const serial = pages[0].serial;
  if (pages.some((p) => p.serial !== serial)) throw new TagWriteError('Ogg files with more than one stream can’t be retagged');

  // Collect the header packets and note the page where they end.
  const first = pages[0].body;
  const isVorbis = first[0] === 1 && first.toString('latin1', 1, 7) === 'vorbis';
  const isOpus = first.toString('latin1', 0, 8) === 'OpusHead';
  if (!isVorbis && !isOpus) throw new TagWriteError('Only Ogg Vorbis and Opus files can be retagged');
  const need = isVorbis ? 3 : 2;
  const packets = [];
  let cur = [];
  let headerEnd = -1;
  for (let i = 0; i < pages.length && headerEnd < 0; i++) {
    const p = pages[i];
    let o = 0;
    p.segs.forEach((s, k) => {
      cur.push(p.body.subarray(o, o + s));
      o += s;
      if (s < 255) {
        packets.push(Buffer.concat(cur));
        cur = [];
        if (packets.length === need) {
          if (k !== p.segs.length - 1) throw new TagWriteError('This Ogg file’s header layout isn’t supported');
          headerEnd = i;
        }
      }
    });
  }
  if (headerEnd < 0) throw new TagWriteError('The Ogg header is incomplete');
  if (pages[0].segs.length !== 1) throw new TagWriteError('This Ogg file’s header layout isn’t supported');

  const magic = isVorbis ? Buffer.concat([Buffer.from([3]), Buffer.from('vorbis', 'latin1')]) : Buffer.from('OpusTags', 'latin1');
  const oldComment = parseVorbisComment(packets[1].subarray(magic.length));
  const vc = buildVorbisComment(oldComment, v, fields, art, false);
  const comment = Buffer.concat([magic, vc, isVorbis ? Buffer.from([1]) : Buffer.alloc(0)]);
  const headerPages = paginate(isVorbis ? [comment, packets[2]] : [comment], serial, 1);
  const shift = headerPages.length - headerEnd; // pages 1..headerEnd are replaced

  const out = [buf.subarray(pages[0].start, pages[0].end), ...headerPages];
  for (const p of pages.slice(headerEnd + 1)) {
    const page = Buffer.from(buf.subarray(p.start, p.end));
    page.writeUInt32LE(p.seq + shift, 18);
    page.writeUInt32LE(0, 22);
    page.writeUInt32LE(oggCrc(page), 22);
    out.push(page);
  }
  if (pages[pages.length - 1].end < buf.length) out.push(buf.subarray(pages[pages.length - 1].end));
  await assemble(src, dest, out);
}

// ------------------------------------------------------------------ WAV

async function writeWav(src, dest, v, fields, art) {
  const h = await src.read(0, 12);
  if (h.toString('latin1', 0, 4) !== 'RIFF' || h.toString('latin1', 8, 12) !== 'WAVE') throw new TagWriteError('Not a WAV file');
  const chunks = [];
  let o = 12;
  while (o + 8 <= src.size) {
    const c = await src.read(o, 8);
    const id = c.toString('latin1', 0, 4);
    const size = c.readUInt32LE(4);
    const end = Math.min(src.size, o + 8 + size + (size & 1));
    chunks.push({ id, start: o, end, size });
    o = end;
  }
  let info = {};
  let oldId3 = null;
  const keep = [];
  for (const c of chunks) {
    if (c.id === 'LIST') {
      const l = await src.read(c.start + 8, Math.min(c.size, 16 * 1024 * 1024));
      if (l.toString('latin1', 0, 4) === 'INFO') {
        let p = 4;
        while (p + 8 <= l.length) {
          const k = l.toString('latin1', p, p + 4);
          const len = l.readUInt32LE(p + 4);
          info[k] = l.subarray(p + 8, p + 8 + len);
          p += 8 + len + (len & 1);
        }
        continue;
      }
    }
    if (c.id === 'id3 ' || c.id === 'ID3 ') { oldId3 = await src.read(c.start + 8, c.size); continue; }
    keep.push(c);
  }
  // RIFF INFO (what Windows shows) …
  const groups = id3Groups(fields);
  const setInfo = (k, val) => { if (isEmpty(val)) delete info[k]; else info[k] = Buffer.from(`${val}\0`, 'utf8'); };
  if (groups.has('title')) setInfo('INAM', v.title);
  if (groups.has('artist')) setInfo('IART', v.artist);
  if (groups.has('album')) setInfo('IPRD', v.album);
  if (groups.has('genre')) setInfo('IGNR', v.genre);
  if (groups.has('year')) setInfo('ICRD', v.year || '');
  if (groups.has('track')) setInfo('ITRK', v.trackNo || '');
  const infoBody = Buffer.concat(Object.entries(info).map(([k, b]) => Buffer.concat([Buffer.from(k, 'latin1'), u32le(b.length), b, Buffer.alloc(b.length & 1)])));
  const list = Buffer.concat([Buffer.from('INFO', 'latin1'), infoBody]);
  // … and an ID3 chunk (album artist, disc, artwork; read by most music players).
  const id3 = buildId3(oldId3 && oldId3.toString('latin1', 0, 3) === 'ID3' ? oldId3 : null, v, groups, art, 0);
  const chunk = (id, body) => Buffer.concat([Buffer.from(id, 'latin1'), u32le(body.length), body, Buffer.alloc(body.length & 1)]);
  const parts = [];
  let total = 4;
  for (const c of keep) { parts.push({ start: c.start, end: c.end }); total += c.end - c.start; }
  const extra = [chunk('LIST', list), chunk('id3 ', id3)];
  for (const e of extra) { parts.push(e); total += e.length; }
  if (total > 0xFFFFFFFF) throw new TagWriteError('This WAV file is too large to retag');
  await assemble(src, dest, [Buffer.concat([Buffer.from('RIFF', 'latin1'), u32le(total), Buffer.from('WAVE', 'latin1')]), ...parts]);
}

// ------------------------------------------------------------------ entry point

async function sniffKind(src, ext) {
  const head = await src.read(0, 12);
  const s4 = head.toString('latin1', 0, 4);
  if (s4 === 'fLaC') return 'flac';
  if (s4 === 'OggS') return 'ogg';
  if (s4 === 'RIFF' && head.toString('latin1', 8, 12) === 'WAVE') return 'wav';
  if (head.toString('latin1', 4, 8) === 'ftyp') return 'mp4';
  if (head.toString('latin1', 0, 3) === 'ID3' && ext === '.flac') {
    const t = await readTagAt(src, 0);
    if (t && (await src.read(t.length, 4)).toString('latin1') === 'fLaC') return 'flac';
  }
  if (head.toString('latin1', 0, 3) === 'ID3' || (head[0] === 0xFF && (head[1] & 0xE0) === 0xE0)) return ext === '.aac' ? null : 'mp3';
  return null;
}

const same = (a, b) => String(a ?? '').trim() === String(b ?? '').trim() || (isEmpty(a) && isEmpty(b));

/**
 * Writes `fields` (any of title, artist, albumArtist, album, genre, year, trackNo, trackOf, discNo, discOf)
 * and/or artwork (`art`: undefined = leave alone, null = remove, {mime, data} = set) into the file.
 * Throws TagWriteError with a plain-language message if it can't.
 */
async function writeTags(filePath, fields = {}, art) {
  fields = Object.fromEntries(Object.entries(fields).filter(([k]) => FIELD_KEYS.includes(k)));
  if (!Object.keys(fields).length && art === undefined) return { written: false };
  if (art && (!art.data || art.data.length > MAX_PICTURE)) throw new TagWriteError('That artwork is too large to save into the file');

  const before = await readTags(filePath).catch(() => null);
  if (!before) throw new TagWriteError('Discshelf couldn’t read this file');
  const v = {};
  for (const k of FIELD_KEYS) v[k] = k in fields ? fields[k] : before[k];
  for (const k of ['year', 'trackNo', 'trackOf', 'discNo', 'discOf']) v[k] = parseInt(v[k], 10) || 0;
  for (const k of ['title', 'artist', 'albumArtist', 'album', 'genre']) v[k] = String(v[k] ?? '').trim();

  let st;
  try { st = await fs.promises.stat(filePath); } catch { throw new TagWriteError('The file is missing'); }
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.discshelf-tmp`);
  const src = await FileSource.open(filePath);
  try {
    const kind = await sniffKind(src, path.extname(filePath).toLowerCase());
    if (kind === 'mp3') await writeMp3(src, tmp, v, fields, art);
    else if (kind === 'flac') await writeFlac(src, tmp, v, fields, art);
    else if (kind === 'mp4') await writeMp4(src, tmp, v, fields, art);
    else if (kind === 'ogg') await writeOgg(src, tmp, v, fields, art);
    else if (kind === 'wav') await writeWav(src, tmp, v, fields, art);
    else throw new TagWriteError('Discshelf can’t save details into this type of file');
  } catch (err) {
    await src.close();
    await fs.promises.rm(tmp, { force: true });
    if (err.code === 'EACCES' || err.code === 'EPERM') throw new TagWriteError('Discshelf isn’t allowed to change files in this folder');
    if (err.code === 'ENOSPC') throw new TagWriteError('The disk is full');
    throw err instanceof TagWriteError ? err : new TagWriteError(`Couldn’t save into the file (${err.message})`);
  }
  await src.close();

  // Check the new file before it replaces the original.
  try {
    const after = await readTags(tmp);
    for (const k of Object.keys(fields)) {
      // WAV keeps no album artist / disc in RIFF INFO, but the ID3 chunk has them.
      if (!same(after[k], v[k])) throw new TagWriteError(`Checking the saved file failed (${k} reads “${after[k]}”, expected “${v[k]}”)`);
    }
    if (art && !after.picture) throw new TagWriteError('Checking the saved file failed (the artwork is missing)');
    if (art === null && after.picture && before.picture && after.picture.data.equals(before.picture.data)) throw new TagWriteError('Checking the saved file failed (the artwork is still there)');
    if (before.duration > 0 && Math.abs(after.duration - before.duration) > 0.5) throw new TagWriteError('Checking the saved file failed (the length changed)');
  } catch (err) {
    await fs.promises.rm(tmp, { force: true });
    throw err instanceof TagWriteError ? err : new TagWriteError(`Checking the saved file failed (${err.message})`);
  }

  // Swap it in (a few tries: Windows can briefly hold the file, e.g. for a thumbnail).
  for (let attempt = 0; ; attempt++) {
    try {
      try { await fs.promises.chmod(tmp, st.mode); } catch { /* not important */ }
      await fs.promises.rename(tmp, filePath);
      break;
    } catch (err) {
      if (attempt < 4 && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')) { await new Promise((r) => setTimeout(r, 300 * (attempt + 1))); continue; }
      await fs.promises.rm(tmp, { force: true });
      throw new TagWriteError(err.code === 'EBUSY' || err.code === 'EPERM' ? 'The file is in use by another program' : `Couldn’t replace the file (${err.message})`);
    }
  }
  return { written: true };
}

module.exports = { writeTags, TagWriteError, oggCrc, FIELD_KEYS };
