'use strict';
// FLAC: STREAMINFO for duration/format, VORBIS_COMMENT for tags, PICTURE for artwork.
const { applyVorbisComments, parseFlacPicture } = require('./common');
const { readId3v2 } = require('./mp3');

const MAX_BLOCK = 32 * 1024 * 1024;

async function parseFlac(src, tags) {
  let o = 0;
  // A few rippers put an ID3v2 tag in front of the FLAC stream.
  const id3 = await readId3v2(src, 0, tags);
  if (id3) o = id3.size;

  const magic = await src.read(o, 4);
  if (magic.toString('latin1') !== 'fLaC') throw new Error('Not a FLAC file');
  o += 4;

  let last = false;
  while (!last && o + 4 <= src.size) {
    const h = await src.read(o, 4);
    if (h.length < 4) break;
    last = (h[0] & 0x80) !== 0;
    const type = h[0] & 0x7F;
    const len = (h[1] << 16) | (h[2] << 8) | h[3];
    o += 4;
    if (type === 0 && len >= 18) {
      const b = await src.read(o, len);
      const sampleRate = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4);
      const channels = ((b[12] >> 1) & 7) + 1;
      const bps = (((b[12] & 1) << 4) | (b[13] >> 4)) + 1;
      const totalSamples = (b[13] & 0x0F) * 2 ** 32 + b.readUInt32BE(14);
      tags.sampleRate = sampleRate;
      tags.channels = channels;
      tags.bitsPerSample = bps;
      tags.duration = sampleRate > 0 ? totalSamples / sampleRate : 0;
    } else if (type === 4 && len <= MAX_BLOCK) {
      applyVorbisComments(await src.read(o, len), tags);
    } else if (type === 6 && len <= MAX_BLOCK) {
      const pic = parseFlacPicture(await src.read(o, len));
      if (pic) tags.pictures.push(pic);
    }
    o += len;
  }

  tags.codec = 'FLAC';
  if (tags.duration > 0) tags.bitrate = Math.round(((src.size - o) * 8) / tags.duration);
  return tags;
}

module.exports = { parseFlac };
