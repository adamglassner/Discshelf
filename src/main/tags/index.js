'use strict';
// readTags(filePath): title/artist/album/... plus duration, format details and embedded pictures.
// Detects the format from the file's first bytes, falling back to the extension.
const path = require('path');
const { FileSource, choosePicture } = require('./reader');
const { emptyTags } = require('./common');
const { parseMp3 } = require('./mp3');
const { parseFlac } = require('./flac');
const { parseOgg } = require('./ogg');
const { parseMp4 } = require('./mp4');
const { parseWav } = require('./wav');

const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.m4b', '.mp4', '.aac', '.flac', '.ogg', '.oga', '.opus', '.wav']);

async function sniff(src, ext) {
  const head = await src.read(0, 12);
  const s4 = head.toString('latin1', 0, 4);
  if (s4 === 'fLaC') return 'flac';
  if (s4 === 'OggS') return 'ogg';
  if (s4 === 'RIFF' && head.toString('latin1', 8, 12) === 'WAVE') return 'wav';
  if (head.toString('latin1', 4, 8) === 'ftyp') return 'mp4';
  if (head.toString('latin1', 0, 3) === 'ID3') {
    // ID3 in front of FLAC happens; check after the tag.
    if (ext === '.flac') return 'flac';
    return 'mp3';
  }
  if (head[0] === 0xFF && (head[1] & 0xE0) === 0xE0) return 'mp3';
  switch (ext) {
    case '.flac': return 'flac';
    case '.ogg': case '.oga': case '.opus': return 'ogg';
    case '.wav': return 'wav';
    case '.m4a': case '.m4b': case '.mp4': return 'mp4';
    default: return 'mp3';
  }
}

/**
 * Returns the tags for one audio file. The cover picture (if any) is returned as `picture`
 * ({mime, data}); other pictures are dropped.
 */
async function readTags(filePath) {
  const src = await FileSource.open(filePath);
  const tags = emptyTags();
  try {
    const ext = path.extname(filePath).toLowerCase();
    const kind = await sniff(src, ext);
    switch (kind) {
      case 'flac': await parseFlac(src, tags); break;
      case 'ogg': await parseOgg(src, tags); break;
      case 'wav': await parseWav(src, tags); break;
      case 'mp4': await parseMp4(src, tags); break;
      default: await parseMp3(src, tags); break;
    }
    if (ext === '.aac' && !tags.codec) tags.codec = 'AAC';
  } finally {
    await src.close();
  }
  const picture = choosePicture(tags.pictures);
  delete tags.pictures;
  tags.picture = picture ? { mime: picture.mime, data: picture.data } : null;
  if (!Number.isFinite(tags.duration) || tags.duration < 0) tags.duration = 0;
  return tags;
}

function isAudioFile(filePath) {
  return AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

module.exports = { readTags, isAudioFile, AUDIO_EXTENSIONS };
