'use strict';
// Writing details + artwork into files, for every format. Each written file is checked three ways:
//  1. Discshelf's own reader sees the new details and artwork;
//  2. ffprobe (a completely separate tag reader) sees them too;
//  3. the decoded audio is bit-for-bit what it was before, and decodes without errors.
// ffmpeg checks are skipped when ffmpeg isn't installed. Run: node test/writer.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');
const { writeTags, oggCrc } = require('../src/main/tags/writer');
const { readTags } = require('../src/main/tags');

const FIX = path.join(__dirname, 'fixtures');
const hasFfmpeg = (() => { try { execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const run = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();

function audioMd5(file) {
  return run('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a', '-f', 'md5', '-']).trim();
}
function decodeErrors(file) {
  return execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a', '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}
function probeTags(file) {
  const j = JSON.parse(run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]));
  const tags = {};
  for (const src of [j.format.tags || {}, ...(j.streams || []).map((s) => s.tags || {})]) {
    for (const [k, v] of Object.entries(src)) if (!(k.toLowerCase() in tags)) tags[k.toLowerCase()] = v;
  }
  const hasPic = (j.streams || []).some((s) => s.disposition && s.disposition.attached_pic);
  return { tags, hasPic };
}

const FIELDS = {
  title: 'Nouveau Tïtle ✓', artist: 'Writer Artist', albumArtist: 'Writer Album Artist', album: 'Written Album',
  genre: 'Jazz', year: 1999, trackNo: 7, trackOf: 12, discNo: 2, discOf: 3, rating: 4, loved: true,
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discshelf-write-'));
  const coverJpg = fs.readFileSync(path.join(FIX, 'cover.jpg'));
  // A big cover (so it spans many Ogg pages and needs FLAC/MP4 to grow a lot).
  let bigArt = coverJpg;
  if (hasFfmpeg) {
    const big = path.join(dir, 'big.jpg');
    run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=900x900', '-frames:v', '1', '-q:v', '2', big]);
    bigArt = fs.readFileSync(big);
  }

  // Extra MP3 / MP4 layouts made with ffmpeg.
  const variants = [
    ['cbr-v23.mp3'], ['vbr-v24.mp3'], ['test.flac'], ['test.ogg'], ['test.opus'], ['test.m4a'], ['alac.m4a'], ['test.wav'],
  ];
  if (hasFfmpeg) {
    run('ffmpeg', ['-v', 'error', '-i', path.join(FIX, 'cbr-v23.mp3'), '-map', '0:a', '-c', 'copy', '-map_metadata', '-1', '-id3v2_version', '0', '-write_id3v1', '0', path.join(dir, 'notag.mp3')]);
    run('ffmpeg', ['-v', 'error', '-i', path.join(FIX, 'cbr-v23.mp3'), '-map', '0:a', '-c', 'copy', '-id3v2_version', '3', '-write_id3v1', '1', path.join(dir, 'v1.mp3')]);
    run('ffmpeg', ['-v', 'error', '-i', path.join(FIX, 'test.m4a'), '-map', '0:a', '-c', 'copy', '-movflags', '+faststart', path.join(dir, 'faststart.m4a')]);
    run('ffmpeg', ['-v', 'error', '-i', path.join(FIX, 'test.m4a'), '-map', '0:a', '-c', 'copy', '-map_metadata', '-1', path.join(dir, 'bare.m4a')]);
    variants.push(['notag.mp3', dir], ['v1.mp3', dir], ['faststart.m4a', dir], ['bare.m4a', dir]);
  }

  let failed = 0;
  for (const [name, from = FIX] of variants) {
    const f = path.join(dir, `w-${name}`);
    fs.copyFileSync(path.join(from, name), f);
    try {
      const md5Before = hasFfmpeg ? audioMd5(f) : null;

      // 1) every field + a big cover
      await writeTags(f, FIELDS, { mime: 'image/jpeg', data: bigArt });
      const t = await readTags(f);
      const wav = name.endsWith('.wav');
      for (const [k, v] of Object.entries(FIELDS)) assert.strictEqual(String(t[k]), String(v), `${k}: ${t[k]}`);
      assert.ok(t.picture && t.picture.data.equals(bigArt), 'artwork saved');
      if (hasFfmpeg) {
        assert.strictEqual(audioMd5(f), md5Before, 'audio unchanged');
        assert.strictEqual(decodeErrors(f), '', 'decodes cleanly');
        const p = probeTags(f).tags;
        assert.strictEqual(p.title, FIELDS.title, `ffprobe title: ${p.title}`);
        assert.strictEqual(p.artist, FIELDS.artist, `ffprobe artist: ${p.artist}`);
        assert.strictEqual(p.album, FIELDS.album, `ffprobe album: ${p.album}`);
        assert.strictEqual(p.genre, FIELDS.genre, `ffprobe genre: ${p.genre}`);
        if (!wav) {
          assert.strictEqual(p.album_artist || p.albumartist, FIELDS.albumArtist, `ffprobe album artist: ${JSON.stringify(p)}`);
          assert.ok(/^1999/.test(p.date || p.year || ''), `ffprobe date: ${p.date}`);
          assert.ok(/^7(\/12)?$/.test(p.track || p.tracknumber || ''), `ffprobe track: ${p.track || p.tracknumber}`);
        }
      }

      // 2) change just the title, remove the artwork
      await writeTags(f, { title: 'Second Pass' }, null);
      const t2 = await readTags(f);
      assert.strictEqual(t2.title, 'Second Pass');
      assert.strictEqual(t2.album, FIELDS.album, 'other details kept');
      assert.strictEqual(t2.trackNo, 7, 'track number kept');
      assert.strictEqual(t2.picture, null, 'artwork removed');
      if (hasFfmpeg) {
        assert.strictEqual(audioMd5(f), md5Before, 'audio unchanged after second write');
        assert.strictEqual(decodeErrors(f), '', 'decodes cleanly after second write');
      }

      // 3) clearing a value removes it
      await writeTags(f, { genre: '', trackOf: 0, rating: 2, loved: false });
      const t3 = await readTags(f);
      assert.strictEqual(t3.genre, '', 'genre cleared');
      assert.strictEqual(t3.rating, 2, 'rating changed');
      assert.strictEqual(t3.loved, false, 'loved cleared');
      assert.strictEqual(t3.trackNo, 7, 'track number still there');
      assert.ok(!fs.readdirSync(dir).some((x) => x.endsWith('.discshelf-tmp')), 'no temp files left behind');
      console.log(`ok   ${name}`);
    } catch (err) {
      failed++;
      console.error(`FAIL ${name}: ${err.message}`);
    }
  }

  // Files Discshelf can't write into are refused, and left untouched.
  const broken = path.join(dir, 'broken.mp3');
  fs.copyFileSync(path.join(FIX, 'broken.mp3'), broken);
  const orig = fs.readFileSync(broken);
  await assert.rejects(writeTags(broken, { title: 'x' }));
  assert.ok(fs.readFileSync(broken).equals(orig), 'refused file is untouched');

  // Ogg CRC matches the spec's check value for "OggS" pages (a page with its CRC field zeroed).
  assert.strictEqual(typeof oggCrc(Buffer.from('123456789')), 'number');
  assert.strictEqual(oggCrc(Buffer.from('123456789')).toString(16), '89a1897f', 'CRC-32/MPEG-2 style polynomial without reflection');

  fs.rmSync(dir, { recursive: true, force: true });
  if (!hasFfmpeg) console.log('(ffmpeg not found: skipped the ffprobe / audio checks)');
  if (failed) { console.error(`${failed} failed`); process.exit(1); }
  console.log('all writer tests passed');
})().catch((err) => { console.error('FAIL', err); process.exit(1); });
