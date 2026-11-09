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

    // Saving into the files: with it off, edits stay in the library; turning it on saves them later.
    const { writeTags } = require('../src/main/tags/writer');
    const { readTags } = require('../src/main/tags');
    lib2.tagWriter = writeTags;
    let writeOn = false;
    lib2.shouldWriteFiles = () => writeOn;
    const mp3 = lib2.snapshot().tracks.find((x) => x.path.endsWith('cbr-v23.mp3'));
    const w1 = await lib2.updateTracks([mp3.id], { title: 'Library Only' });
    assert.strictEqual(w1.written, 0);
    assert.strictEqual((await readTags(mp3.path)).title, 'Sine_Song', 'file untouched while saving into files is off');
    assert.strictEqual(lib2.pendingEdits().length, 1);
    writeOn = true;
    const w2 = await lib2.writePendingEdits();
    assert.strictEqual(w2.written, 1);
    assert.strictEqual((await readTags(mp3.path)).title, 'Library Only', 'earlier edit saved into the file');
    assert.strictEqual(lib2.pendingEdits().length, 0, 'nothing left pending');
    const w3 = await lib2.updateEach([{ id: mp3.id, fields: { title: 'Per Song Write', trackNo: 9 } }]);
    assert.strictEqual(w3.written, 1);
    const back = await readTags(mp3.path);
    assert.strictEqual(back.title, 'Per Song Write');
    assert.strictEqual(back.trackNo, 9);
    assert.strictEqual(lib2.get(mp3.id).edits, undefined, 'edits cleared once in the file');
    const rescan = await lib2.scan();
    assert.strictEqual(rescan.updated, 0, 'rescan sees the file as unchanged');
    const bad = lib2.snapshot().tracks.find((x) => x.path.endsWith('broken.mp3'));
    const r4 = await lib2.updateTracks([bad.id], { title: 'Nope' });
    assert.strictEqual(r4.failed.length, 1, 'a file that can’t be written is reported');
    assert.strictEqual(lib2.get(bad.id).title, 'Nope', '… but the library keeps the change');

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
