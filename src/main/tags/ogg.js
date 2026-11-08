'use strict';
// Ogg Vorbis and Ogg Opus: identification + comment packets, duration from the last page's granule position.
const { applyVorbisComments } = require('./common');

const MAX_HEADER_BYTES = 32 * 1024 * 1024;

async function readPage(src, pos) {
  const h = await src.read(pos, 27);
  if (h.length < 27 || h.toString('latin1', 0, 4) !== 'OggS') return null;
  const nseg = h[26];
  const segTable = await src.read(pos + 27, nseg);
  let bodyLen = 0;
  for (const s of segTable) bodyLen += s;
  const body = await src.read(pos + 27 + nseg, bodyLen);
  return { serial: h.readUInt32LE(14), granule: h.readBigInt64LE(6), segTable, body, next: pos + 27 + nseg + bodyLen };
}

/** The first `count` packets of the first logical stream. */
async function readPackets(src, count) {
  const packets = [];
  let current = [];
  let serial = null;
  let pos = 0;
  let total = 0;
  while (packets.length < count && pos < src.size && total < MAX_HEADER_BYTES) {
    const page = await readPage(src, pos);
    if (!page) break;
    pos = page.next;
    if (serial === null) serial = page.serial;
    if (page.serial !== serial) continue;
    let o = 0;
    for (const seg of page.segTable) {
      current.push(page.body.subarray(o, o + seg));
      o += seg;
      total += seg;
      if (seg < 255) {
        packets.push(Buffer.concat(current));
        current = [];
        if (packets.length >= count) break;
      }
    }
  }
  return { packets, serial };
}

async function lastGranule(src, serial) {
  for (const span of [64 * 1024, 1024 * 1024]) {
    const start = Math.max(0, src.size - span);
    const tail = await src.read(start, src.size - start);
    for (let i = tail.length - 27; i >= 0; i--) {
      if (tail[i] !== 0x4F || tail.toString('latin1', i, i + 4) !== 'OggS') continue;
      if (tail.readUInt32LE(i + 14) !== serial) continue;
      const g = tail.readBigInt64LE(i + 6);
      if (g >= 0n) return Number(g);
    }
    if (start === 0) break;
  }
  return 0;
}

async function parseOgg(src, tags) {
  const { packets, serial } = await readPackets(src, 2);
  if (packets.length === 0) throw new Error('Not an Ogg file');
  const id = packets[0];
  const comments = packets[1];
  let granuleRate = 0;
  let preSkip = 0;

  if (id.length >= 30 && id[0] === 1 && id.toString('latin1', 1, 7) === 'vorbis') {
    tags.codec = 'Vorbis';
    tags.channels = id[11];
    tags.sampleRate = id.readUInt32LE(12);
    const nominal = id.readInt32LE(20);
    if (nominal > 0) tags.bitrate = nominal;
    granuleRate = tags.sampleRate;
    if (comments && comments[0] === 3 && comments.toString('latin1', 1, 7) === 'vorbis') {
      applyVorbisComments(comments.subarray(7), tags);
    }
  } else if (id.length >= 19 && id.toString('latin1', 0, 8) === 'OpusHead') {
    tags.codec = 'Opus';
    tags.channels = id[9];
    preSkip = id.readUInt16LE(10);
    tags.sampleRate = id.readUInt32LE(12) || 48000;
    granuleRate = 48000; // Opus granule positions always count 48 kHz samples
    if (comments && comments.toString('latin1', 0, 8) === 'OpusTags') {
      applyVorbisComments(comments.subarray(8), tags);
    }
  } else {
    throw new Error('Unsupported Ogg stream');
  }

  if (granuleRate > 0 && serial !== null) {
    const g = await lastGranule(src, serial);
    tags.duration = Math.max(0, g - preSkip) / granuleRate;
  }
  if (tags.duration > 0 && (!tags.bitrate || tags.codec === 'Opus')) {
    tags.bitrate = Math.round((src.size * 8) / tags.duration);
  }
  return tags;
}

module.exports = { parseOgg };
