'use strict';
// Lyrics (LRC parsing, sources in order: .lrc file, tags, LRCLIB) and ReplayGain parsing.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Lyrics, parseLrc, plainFromLrc } = require('../src/main/lyrics');
const { applyReplayGain, emptyTags } = require('../src/main/tags/common');

(async () => {
  // LRC
  const lrc = '[ar:Someone]\n[00:01.00]Hello\n[00:02.50][00:10.00]World <00:03.00>there\n\n[01:05.5]Late';
  const lines = parseLrc(lrc);
  assert.deepStrictEqual(lines.map((l) => l.t), [1, 2.5, 10, 65.5]);
  assert.strictEqual(lines[1].text, 'World there');
  assert.strictEqual(plainFromLrc(lrc), 'Hello\nWorld there\n\nLate');
  assert.strictEqual(parseLrc('just\nplain words'), null);
  assert.deepStrictEqual(parseLrc('[offset:+500]\n[00:01.00]a\n[00:02.00]b').map((l) => l.t), [0.5, 1.5]);

  // ReplayGain
  const t = emptyTags();
  applyReplayGain((k) => ({ REPLAYGAIN_TRACK_GAIN: '-6.48 dB', REPLAYGAIN_ALBUM_GAIN: '+1,5 dB', REPLAYGAIN_TRACK_PEAK: '0.988' }[k]), t);
  assert.strictEqual(t.rgTrack, -6.48);
  assert.strictEqual(t.rgAlbum, 1.5);
  assert.strictEqual(t.rgTrackPeak, 0.988);
  const o = emptyTags();
  applyReplayGain((k) => ({ R128_TRACK_GAIN: '-2560' }[k]), o);
  assert.strictEqual(o.rgTrack, -5); // -10 dB vs -23 LUFS = -5 dB vs ReplayGain's -18

  // Sources: .lrc wins; LRCLIB is asked only when the file has none, and the answer is cached.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-lyr-'));
  const song = path.join(dir, 'a.mp3');
  fs.writeFileSync(song, Buffer.alloc(2000));
  let calls = 0;
  const fetch = async (url) => {
    calls++;
    if (url.includes('/get?')) return new Response(JSON.stringify({ syncedLyrics: '[00:01.00]One\n[00:02.00]Two', plainLyrics: 'One\nTwo' }), { status: 200 });
    return new Response('[]', { status: 200 });
  };
  const ly = new Lyrics({ fetch, dataDir: dir, userAgent: 'test' });
  const track = { path: song, artist: 'A', title: 'B', album: 'C', duration: 100 };
  let r = await ly.get(track);
  assert.strictEqual(r.source, 'lrclib');
  assert.strictEqual(r.synced.length, 2);
  r = await ly.get(track);
  assert.strictEqual(calls, 1, 'cached');
  assert.strictEqual((await ly.get(track, { online: false })).source, null);
  fs.writeFileSync(path.join(dir, 'a.lrc'), '﻿[00:00.50]Local\n[00:01.50]File');
  r = await ly.get(track);
  assert.strictEqual(r.source, 'lrc');
  assert.strictEqual(r.synced[0].text, 'Local');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('all lyrics tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
