'use strict';
// WAV: fmt + data chunks for duration, LIST/INFO and "id3 " chunks for tags.
const { cleanText, parseNumberPair, parseYear } = require('./reader');
const { readId3v2 } = require('./mp3');

async function parseWav(src, tags) {
  const h = await src.read(0, 12);
  if (h.toString('latin1', 0, 4) !== 'RIFF' || h.toString('latin1', 8, 12) !== 'WAVE') throw new Error('Not a WAV file');
  let o = 12;
  let byteRate = 0;
  let dataSize = 0;
  let format = 0;
  while (o + 8 <= src.size) {
    const c = await src.read(o, 8);
    if (c.length < 8) break;
    const id = c.toString('latin1', 0, 4);
    const size = c.readUInt32LE(4);
    const body = o + 8;
    if (id === 'fmt ') {
      const f = await src.read(body, Math.min(size, 40));
      format = f.readUInt16LE(0);
      tags.channels = f.readUInt16LE(2);
      tags.sampleRate = f.readUInt32LE(4);
      byteRate = f.readUInt32LE(8);
      tags.bitsPerSample = f.readUInt16LE(14);
    } else if (id === 'data') {
      dataSize = Math.min(size, src.size - body);
    } else if (id === 'LIST' && size >= 4 && size < 16 * 1024 * 1024) {
      const l = await src.read(body, size);
      if (l.toString('latin1', 0, 4) === 'INFO') {
        let p = 4;
        const info = {};
        while (p + 8 <= l.length) {
          const key = l.toString('latin1', p, p + 4);
          const len = l.readUInt32LE(p + 4);
          info[key] = cleanText(l.toString('utf8', p + 8, Math.min(l.length, p + 8 + len)));
          p += 8 + len + (len & 1);
        }
        tags.title = tags.title || info.INAM || '';
        tags.artist = tags.artist || info.IART || '';
        tags.album = tags.album || info.IPRD || '';
        tags.genre = tags.genre || info.IGNR || '';
        tags.year = tags.year || parseYear(info.ICRD);
        if (!tags.trackNo) tags.trackNo = parseNumberPair(info.ITRK || info.IPRT).no;
      }
    } else if (id === 'id3 ' || id === 'ID3 ') {
      await readId3v2(src, body, tags);
    }
    o = body + size + (size & 1);
  }
  tags.codec = format === 3 ? 'WAV (float)' : 'WAV';
  if (byteRate > 0) {
    tags.duration = dataSize / byteRate;
    tags.bitrate = byteRate * 8;
  }
  return tags;
}

module.exports = { parseWav };
