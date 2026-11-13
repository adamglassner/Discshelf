'use strict';
// Adding a radio station by address: stream URLs, playlists, and station web pages.
const assert = require('assert');
const { resolveStation, knownStream } = require('../src/main/radio');

const audio = (headers = {}) => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(1000)); } }), { status: 200, headers: { 'content-type': 'audio/mpeg', ...headers } });
const html = (body) => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
const text = (body, type) => new Response(body, { status: 200, headers: { 'content-type': type } });

(async () => {
  assert.strictEqual(knownStream('https://live365.com/station/WION-AM-STEREO-1430-a83993'), 'https://streaming.live365.com/a83993');
  assert.strictEqual(knownStream('https://example.com/'), null);

  const seen = [];
  const sites = {
    // A station homepage that links its Live365 page (like i1430.com)
    'https://i1430.com/': () => html(`<html><head><title>WION AM STEREO 1430 – The Music You Know</title>
      <meta property="og:image" content="/logo.png"></head><body><a href="https://www.i1430.com/listen/">POPOUT PLAYER</a>
      <a href="https://live365.com/station/WION-AM-STEREO-1430-a83993">Live365</a></body></html>`),
    'https://streaming.live365.com/a83993': () => audio({ 'icy-name': 'WION AM Stereo 1430', 'icy-br': '128', 'icy-genre': 'Oldies' }),
    // A page whose stream is only on its "listen live" page
    'https://kxyz.example/': () => html('<html><title>KXYZ 99.1 | Home</title><a href="/listen-live">Listen live</a></html>'),
    'https://kxyz.example/listen-live': () => html('<html><audio src="https://ice.kxyz.example:8000/live.aac"></audio></html>'),
    'https://ice.kxyz.example:8000/live.aac': () => audio({ 'content-type': 'audio/aacp' }),
    // A .pls playlist
    'https://pl.example/radio.pls': () => text('[playlist]\nFile1=https://pl.example/stream\nTitle1=X\n', 'audio/x-scpls'),
    'https://pl.example/stream': () => audio({ 'icy-name': 'Playlist FM' }),
    // A page with nothing playable
    'https://empty.example/': () => html('<html><title>Nothing</title><p>hi</p></html>'),
  };
  const fetchFn = async (url, opts) => {
    seen.push(url);
    assert.ok(opts.headers['User-Agent']);
    const f = sites[url];
    if (!f) return new Response('not found', { status: 404 });
    const r = f();
    Object.defineProperty(r, 'url', { value: url });
    return r;
  };

  let r = await resolveStation('i1430.com', fetchFn, 'test');
  assert.strictEqual(r.url, 'https://streaming.live365.com/a83993');
  assert.strictEqual(r.name, 'WION AM Stereo 1430');
  assert.strictEqual(r.bitrate, 128);
  assert.strictEqual(r.codec, 'MP3');
  assert.strictEqual(r.genre, 'Oldies');
  assert.strictEqual(r.favicon, 'https://i1430.com/logo.png');
  assert.strictEqual(r.homepage, 'https://i1430.com/');

  r = await resolveStation('https://live365.com/station/WION-AM-STEREO-1430-a83993', fetchFn, 'test');
  assert.strictEqual(r.url, 'https://streaming.live365.com/a83993');

  r = await resolveStation('https://kxyz.example/', fetchFn, 'test');
  assert.strictEqual(r.url, 'https://ice.kxyz.example:8000/live.aac');
  assert.strictEqual(r.codec, 'AAC+');
  assert.strictEqual(r.name, 'KXYZ 99.1');

  r = await resolveStation('https://pl.example/radio.pls', fetchFn, 'test');
  assert.strictEqual(r.url, 'https://pl.example/stream');
  assert.strictEqual(r.name, 'Playlist FM');

  await assert.rejects(resolveStation('https://empty.example/', fetchFn, 'test'), /Couldn’t find a stream/);
  await assert.rejects(resolveStation('', fetchFn, 'test'), /Paste the address/);
  console.log('all add-station tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
