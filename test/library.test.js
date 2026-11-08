'use strict';
// Scans test/fixtures into a temporary library and checks adding, rescanning, art caching and removal.
// Run: node test/library.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { Library } = require('../src/main/library');

(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'discshelf-lib-'));
  const music = fs.mkdtempSync(path.join(os.tmpdir(), 'discshelf-music-'));
  const fixtures = path.join(__dirname, 'fixtures');
  // Copy fixtures into an album folder plus a second folder that only has a cover.jpg for art.
  fs.mkdirSync(path.join(music, 'Album A'));
  fs.mkdirSync(path.join(music, 'Album B'));
  for (const f of fs.readdirSync(fixtures)) {
    if (f.endsWith('.jpg')) continue;
    fs.copyFileSync(path.join(fixtures, f), path.join(music, 'Album A', f));
  }
  fs.copyFileSync(path.join(fixtures, 'test.ogg'), path.join(music, 'Album B', 'song.ogg'));
  fs.copyFileSync(path.join(fixtures, 'cover.jpg'), path.join(music, 'Album B', 'Folder.jpg'));
  fs.writeFileSync(path.join(music, 'Album A', 'notes.txt'), 'not music');

  try {
    const lib = new Library(data);
    lib.load();
    const r1 = await lib.scan([music]);
    assert.strictEqual(r1.found, 10, `found ${r1.found}`);
    assert.strictEqual(r1.added, 10, `added ${r1.added}`);
    assert.deepStrictEqual(lib.folders, [path.resolve(music)]);

    const tracks = lib.snapshot().tracks;
    const flac = tracks.find((t) => t.path.endsWith('test.flac'));
    assert.ok(flac.art && fs.existsSync(path.join(data, 'artwork', flac.art)), 'embedded art cached');
    const ogg = tracks.find((t) => t.path.endsWith('song.ogg'));
    assert.ok(ogg.art, 'folder.jpg used as art');
    const broken = tracks.find((t) => t.path.endsWith('broken.mp3'));
    assert.strictEqual(broken.title, 'broken', 'unreadable file named after itself');

    // Rescan: nothing changed.
    const r2 = await lib.scan();
    assert.strictEqual(r2.added + r2.updated + r2.removed, 0, 'rescan with no changes');

    // Delete a file and rescan: it's dropped.
    fs.unlinkSync(path.join(music, 'Album A', 'test.wav'));
    const r3 = await lib.scan();
    assert.strictEqual(r3.removed, 1, 'missing file removed');

    // Save + reload.
    lib.saveNow();
    const lib2 = new Library(data);
    lib2.load();
    assert.strictEqual(lib2.snapshot().tracks.length, 9);

    // Play counts.
    const p = lib2.markPlayed(flac.id);
    assert.strictEqual(p.playCount, 1);

    // Removing the folder removes its tracks.
    const gone = lib2.removeFolder(music);
    assert.strictEqual(gone, 9);
    assert.strictEqual(lib2.snapshot().tracks.length, 0);
    lib2.saveNow();
    console.log('all library tests passed');
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
    fs.rmSync(music, { recursive: true, force: true });
  }
})().catch((err) => { console.error('FAIL', err.message); process.exit(1); });
