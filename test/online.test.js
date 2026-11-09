'use strict';
// Online lookups against canned iTunes / Deezer replies, plus Get Info edits surviving a rescan.
// Run: node test/online.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { Online, norm } = require('../src/main/online');
const { Library } = require('../src/main/library');

const JPEG = fs.readFileSync(path.join(__dirname, 'fixtures', 'cover.jpg'));

const itunesSongs = { results: [{
  trackName: 'Small Talk', artistName: 'Ada Feld', collectionName: 'Copper Hours', primaryGenreName: 'Jazz',
  releaseDate: '2023-04-07T07:00:00Z', trackNumber: 4, trackCount: 5, discNumber: 1, discCount: 1,
  artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/abc/100x100bb.jpg',
}] };
const itunesAlbums = { results: [
  { collectionName: 'Something Else', artistName: 'Other', artworkUrl100: 'https://x.test/1/100x100bb.jpg' },
  { collectionName: 'Copper Hours (Deluxe Edition)', artistName: 'Ada Feld', trackCount: 5, releaseDate: '2023-04-07', artworkUrl100: 'https://x.test/2/100x100bb.jpg' },
] };
const deezer = { data: [
  { title: 'Small Talk', artist: { name: 'Ada Feld' }, album: { title: 'Copper Hours', cover_xl: 'https://dz.test/xl.jpg', cover_medium: 'https://dz.test/m.jpg' } },
  { title: 'Late Bloom', artist: { name: 'Ada Feld' }, album: { title: 'Copper Hours', cover_xl: 'https://dz.test/xl.jpg' } },
] };

const fetch = async (url) => {
  const json = (o) => ({ ok: true, status: 200, json: async () => o, headers: new Map() });
  if (url.startsWith('https://itunes.apple.com/search') && url.includes('entity=album')) return json(itunesAlbums);
  if (url.startsWith('https://itunes.apple.com/search')) return json(itunesSongs);
  if (url.startsWith('https://api.deezer.com/search')) return json(deezer);
  if (url.endsWith('.jpg')) return { ok: true, status: 200, headers: new Map([['content-length', String(JPEG.length)]]), arrayBuffer: async () => JPEG };
  return { ok: false, status: 404, json: async () => ({}), headers: new Map() };
};

(async () => {
  assert.strictEqual(norm('The Copper Hours (2019 Remaster)'), 'copper hours');
  assert.strictEqual(norm('Ember & Ash'), 'ember and ash');

  const online = new Online(fetch);
  const songs = await online.search('Ada Feld Small Talk', 'song');
  assert.strictEqual(songs.results[0].source, 'iTunes');
  assert.strictEqual(songs.results[0].year, 2023);
  assert.strictEqual(songs.results[0].artwork, 'https://is1-ssl.mzstatic.com/image/thumb/abc/600x600bb.jpg');
  assert.strictEqual(songs.results.length, 2, 'Deezer duplicate of the iTunes result is dropped');

  const cover = await online.findAlbumCover('Ada Feld', 'Copper Hours');
  assert.ok(cover && cover.artwork.includes('/2/600x600bb'), 'matches the right album, ignoring "(Deluxe Edition)"');
  assert.strictEqual(await online.findAlbumCover('Nobody', 'Unknown Thing'), null);

  const img = await online.downloadImage('https://x.test/2/600x600bb.jpg');
  assert.strictEqual(img.mime, 'image/jpeg');
  await assert.rejects(online.downloadImage('http://insecure.test/a.jpg'), /https/);

  // Get Info edits are kept in the library and survive a rescan of a changed file.
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'discshelf-edit-'));
  const music = fs.mkdtempSync(path.join(os.tmpdir(), 'discshelf-music-'));
  try {
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'test.flac'), path.join(music, 'a.flac'));
    const lib = new Library(data);
    lib.load();
    await lib.scan([music]);
    const t = lib.snapshot().tracks[0];
    const origArt = t.art;
    const otherImg = { mime: img.mime, data: Buffer.concat([img.data, Buffer.from('different')]) };
    await lib.updateTracks([t.id], { title: 'My Title', year: '1999', genre: '  Jazz  ', bogus: 'x' }, otherImg);
    let t2 = lib.get(t.id);
    assert.strictEqual(t2.title, 'My Title');
    assert.strictEqual(t2.year, 1999);
    assert.strictEqual(t2.genre, 'Jazz');
    assert.strictEqual(t2.bogus, undefined, 'unknown fields ignored');
    assert.ok(t2.art && t2.art !== origArt, 'new artwork');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(music, 'a.flac'), later, later);
    await lib.scan();
    t2 = lib.get(t.id);
    assert.strictEqual(t2.title, 'My Title', 'edit survives rescan');
    assert.strictEqual(t2.album, 'Test_Album', 'untouched fields still come from the file');
    await lib.updateTracks([t.id], {}, null);
    assert.strictEqual(lib.get(t.id).art, null, 'artwork removed');
    lib.saveNow();
    console.log('all online + edit tests passed');
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
    fs.rmSync(music, { recursive: true, force: true });
  }
})().catch((err) => { console.error('FAIL', err); process.exit(1); });
