'use strict';
// Radio: directory search against a fake Radio Browser server, ICY metadata stripping, playlist parsing.
// Run: node test/radio.test.js
const assert = require('assert');
const { RadioBrowser, icyStripper, firstPlaylistUrl } = require('../src/main/radio');

const station = (o) => ({
  stationuuid: o.id, name: o.name, url: 'http://x/s', url_resolved: o.url || 'https://x/stream', favicon: o.favicon || '',
  country: 'United States', countrycode: 'US', state: 'Ohio', tags: 'rock,classic rock,80s,hits,extra',
  codec: o.codec || 'MP3', bitrate: 128, hls: o.hls || 0, votes: 5, clickcount: 9,
});

(async () => {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    calls.push({ url, ua: opts.headers && opts.headers['User-Agent'] });
    const json = (o) => ({ ok: true, status: 200, json: async () => o });
    if (url.includes('all.api.radio-browser.info')) return json([{ name: 'xx1.api.radio-browser.info' }, { name: 'evil.example.com' }]);
    if (url.startsWith('https://xx1.api.radio-browser.info/json/stations/search')) {
      return json([
        station({ id: '11111111-1111-1111-1111-111111111111', name: '  Rock FM ', favicon: 'https://x/icon.png' }),
        station({ id: '22222222-2222-2222-2222-222222222222', name: 'HLS Station', hls: 1 }),
        station({ id: '33333333-3333-3333-3333-333333333333', name: 'WMA Station', codec: 'WMA' }),
        station({ id: '44444444-4444-4444-4444-444444444444', name: 'rock fm' }), // duplicate name
        station({ id: '55555555-5555-5555-5555-555555555555', name: 'AAC+ Jazz', codec: 'AAC+', favicon: 'ftp://nope' }),
      ]);
    }
    if (url.includes('/json/countries')) return json([{ name: 'United States', iso_3166_1: 'us', stationcount: 6000 }, { name: 'Tiny', iso_3166_1: 'TI', stationcount: 2 }, { name: 'Austria', iso_3166_1: 'AT', stationcount: 400 }]);
    if (url.includes('/json/url/')) return json({ ok: true });
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const rb = new RadioBrowser(fetch, 'Discshelf/test');
  const r = await rb.search({ tag: 'rock', countryCode: 'US', limit: 10 });
  assert.deepStrictEqual(r.stations.map((s) => s.name), ['Rock FM', 'AAC+ Jazz'], 'HLS, WMA and duplicates are left out');
  assert.strictEqual(r.stations[0].url, 'https://x/stream');
  assert.deepStrictEqual(r.stations[0].tags, ['rock', 'classic rock', '80s', 'hits'], 'four tags at most');
  assert.strictEqual(r.stations[1].favicon, '', 'non-http favicons dropped');
  const searchCall = calls.find((c) => c.url.includes('/stations/search'));
  assert.ok(searchCall.url.includes('countrycode=US') && searchCall.url.includes('tag=rock') && searchCall.url.includes('hidebroken=true'));
  assert.ok(!calls.some((c) => c.url.includes('evil.example.com')), 'only radio-browser.info servers are used');
  assert.ok(calls.every((c) => c.ua === 'Discshelf/test'), 'every request says who is asking');

  const countries = await rb.countries();
  assert.deepStrictEqual(countries.map((c) => c.code), ['AT', 'US'], 'sorted by name, tiny countries left out');

  await rb.click('11111111-1111-1111-1111-111111111111');
  assert.ok(calls.some((c) => c.url.endsWith('/json/url/11111111-1111-1111-1111-111111111111')));
  await rb.click('../../etc'); // ignored

  // ICY: audio "AAAA…" with metadata every 8 bytes, split into awkward chunks.
  const metaint = 8;
  const meta = (t) => {
    const body = Buffer.from(t ? `StreamTitle='${t}';` : '');
    const len = Math.ceil(body.length / 16);
    const block = Buffer.alloc(len * 16);
    body.copy(block);
    return Buffer.concat([Buffer.from([len]), block]);
  };
  const stream = Buffer.concat([
    Buffer.from('AAAAAAAA'), meta('Artist One - Song One'),
    Buffer.from('BBBBBBBB'), meta(''),
    Buffer.from('CCCCCCCC'), meta('Artist Two - Song Two'),
    Buffer.from('DDDD'),
  ]);
  const titles = [];
  const ts = icyStripper(metaint, (t) => titles.push(t));
  const writer = ts.writable.getWriter();
  const out = [];
  const reading = (async () => { const rd = ts.readable.getReader(); for (;;) { const { value, done } = await rd.read(); if (done) break; out.push(Buffer.from(value)); } })();
  for (let i = 0; i < stream.length; i += 5) await writer.write(new Uint8Array(stream.subarray(i, i + 5)));
  await writer.close();
  await reading;
  assert.strictEqual(Buffer.concat(out).toString(), 'AAAAAAAABBBBBBBBCCCCCCCCDDDD', 'metadata removed from the audio');
  assert.deepStrictEqual(titles, ['Artist One - Song One', 'Artist Two - Song Two'], 'song titles reported');

  assert.strictEqual(firstPlaylistUrl('[playlist]\nNumberOfEntries=1\nFile1=http://a.b/live\nTitle1=x'), 'http://a.b/live');
  assert.strictEqual(firstPlaylistUrl('#EXTM3U\n#EXTINF:-1,x\nhttps://c.d/stream.mp3\n'), 'https://c.d/stream.mp3');
  assert.strictEqual(firstPlaylistUrl('<html>nope</html>'), null);
  console.log('all radio tests passed');
})().catch((err) => { console.error('FAIL', err); process.exit(1); });
