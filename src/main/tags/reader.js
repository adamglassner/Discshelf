'use strict';
// Small helpers shared by the tag parsers: random-access file reads and text decoding.
const fs = require('fs');

class FileSource {
  static async open(filePath) {
    const handle = await fs.promises.open(filePath, 'r');
    const { size } = await handle.stat();
    return new FileSource(handle, size);
  }

  constructor(handle, size) {
    this.handle = handle;
    this.size = size;
  }

  /** Reads up to `length` bytes at `position` (fewer at the end of the file). */
  async read(position, length) {
    if (position < 0) position = 0;
    if (position >= this.size || length <= 0) return Buffer.alloc(0);
    length = Math.min(length, this.size - position);
    const buf = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
      const { bytesRead } = await this.handle.read(buf, done, length - done, position + done);
      if (bytesRead === 0) break;
      done += bytesRead;
    }
    return done === length ? buf : buf.subarray(0, done);
  }

  async close() {
    try { await this.handle.close(); } catch { /* ignore */ }
  }
}

function stripNulls(s) {
  return s.replace(/\u0000+$/g, '').replace(/^﻿/, '');
}

/** UTF-16 with optional BOM (defaults to little-endian, as most taggers write). */
function decodeUtf16(buf, bigEndianDefault = false) {
  let be = bigEndianDefault;
  let start = 0;
  if (buf.length >= 2) {
    if (buf[0] === 0xFE && buf[1] === 0xFF) { be = true; start = 2; }
    else if (buf[0] === 0xFF && buf[1] === 0xFE) { be = false; start = 2; }
  }
  let body = buf.subarray(start, start + ((buf.length - start) & ~1));
  if (be) {
    const copy = Buffer.from(body);
    copy.swap16();
    body = copy;
  }
  return body.toString('utf16le');
}

function cleanText(s) {
  if (typeof s !== 'string') return '';
  return stripNulls(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
}

/** "3/12" -> {no: 3, of: 12}; "07" -> {no: 7, of: 0}. */
function parseNumberPair(value) {
  const m = /^\s*(\d+)\s*(?:\/\s*(\d+))?/.exec(String(value || ''));
  if (!m) return { no: 0, of: 0 };
  return { no: parseInt(m[1], 10) || 0, of: m[2] ? parseInt(m[2], 10) || 0 : 0 };
}

function parseYear(value) {
  const m = /(\d{4})/.exec(String(value || ''));
  return m ? parseInt(m[1], 10) : 0;
}

function imageMimeFromData(data, fallback) {
  if (data && data.length > 4) {
    if (data[0] === 0xFF && data[1] === 0xD8) return 'image/jpeg';
    if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47) return 'image/png';
    if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return 'image/gif';
    if (data.length > 12 && data.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
    if (data[0] === 0x42 && data[1] === 0x4D) return 'image/bmp';
  }
  if (fallback && /^image\//i.test(fallback)) return fallback.toLowerCase().replace('image/jpg', 'image/jpeg');
  return null;
}

/** Picks the front cover (type 3) if there is one, otherwise the first picture. */
function choosePicture(pictures) {
  const usable = pictures.filter((p) => p && p.data && p.data.length > 64 && p.mime);
  if (usable.length === 0) return null;
  return usable.find((p) => p.type === 3) || usable[0];
}

module.exports = {
  FileSource,
  decodeUtf16,
  stripNulls,
  cleanText,
  parseNumberPair,
  parseYear,
  imageMimeFromData,
  choosePicture,
};
