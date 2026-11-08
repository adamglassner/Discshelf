'use strict';
// Checks the tag reader against the small fixture files in test/fixtures (made with ffmpeg; 3 s of a 440 Hz tone).
// Run: node test/tags.test.js
const path = require('path');
const assert = require('assert');
const { readTags } = require('../src/main/tags');

const dir = path.join(__dirname, 'fixtures');
const common = {
  artist: 'Test_Artist', albumArtist: 'Test_Album_Artist', album: 'Test_Album',
  genre: 'Ambient', year: 2021, trackNo: 3, trackOf: 9, discNo: 1, discOf: 2,
};
const cases = [
  { file: 'cbr-v23.mp3', codec: 'MP3', title: 'Sine_Song', picture: 'image/jpeg', sampleRate: 44100 },
  { file: 'vbr-v24.mp3', codec: 'MP3', title: 'Ünïcödé Tïtle', picture: null, sampleRate: 44100 },
  { file: 'test.flac', codec: 'FLAC', title: 'Sine_Song', picture: 'image/jpeg', sampleRate: 44100 },
  { file: 'test.ogg', codec: 'Vorbis', title: 'Sine_Song', picture: null, sampleRate: 44100 },
  { file: 'test.opus', codec: 'Opus', title: 'Sine_Song', picture: null, sampleRate: 48000 },
  { file: 'test.m4a', codec: 'AAC', title: 'Sine_Song', picture: 'image/jpeg', sampleRate: 44100 },
  { file: 'alac.m4a', codec: 'ALAC', title: 'Sine_Song', picture: null, sampleRate: 44100 },
  { file: 'test.wav', codec: 'WAV', title: 'Sine_Song', picture: null, sampleRate: 8000, skipTags: ['albumArtist', 'discNo', 'discOf', 'trackOf'] },
];

let failed = 0;
(async () => {
  for (const c of cases) {
    try {
      const t = await readTags(path.join(dir, c.file));
      assert.strictEqual(t.codec, c.codec, 'codec');
      assert.strictEqual(t.title, c.title, 'title');
      for (const [k, v] of Object.entries(common)) {
        if (c.skipTags && c.skipTags.includes(k)) continue;
        assert.strictEqual(t[k], v, k);
      }
      assert.ok(Math.abs(t.duration - 3) < 0.15, `duration ${t.duration}`);
      assert.strictEqual(t.sampleRate, c.sampleRate, 'sampleRate');
      assert.ok(t.bitrate > 0, 'bitrate');
      assert.strictEqual(t.picture ? t.picture.mime : null, c.picture, 'picture');
      console.log(`ok   ${c.file}  ${t.codec} ${t.duration.toFixed(2)}s ${Math.round(t.bitrate / 1000)} kbps`);
    } catch (err) {
      failed++;
      console.error(`FAIL ${c.file}: ${err.message}`);
    }
  }
  // A file that isn't audio must not crash the reader.
  try {
    const t = await readTags(path.join(dir, 'broken.mp3'));
    assert.strictEqual(t.duration, 0);
    console.log('ok   broken.mp3  (no audio found, no crash)');
  } catch (err) {
    failed++;
    console.error(`FAIL broken.mp3: ${err.message}`);
  }
  if (failed) { console.error(`${failed} failed`); process.exit(1); }
  console.log('all tag tests passed');
})();
