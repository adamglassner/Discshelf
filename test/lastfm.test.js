'use strict';
// Last.fm client against a fake server: request signing, sign-in, now playing, scrobble queue + retries.
// Run: node test/lastfm.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { Lastfm, scrobbleThreshold } = require('../src/main/lastfm');

const KEY = 'a'.repeat(32);
const SECRET = 'b'.repeat(32);
const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');

function fakeServer() {
  const calls = [];
  let mode = 'ok';
  let approved = false;
  const fetch = async (url, opts = {}) => {
    const params = Object.fromEntries(new URLSearchParams(opts.body || url.split('?')[1] || ''));
    calls.push(params);
    // Check the signature the way Last.fm does.
    const { api_sig: sig, format, ...rest } = params;
    const expect = md5(Object.keys(rest).sort().map((k) => k + rest[k]).join('') + SECRET);
    const reply = (obj, status = 200) => ({ ok: status < 400, status, json: async () => obj, headers: new Map() });
    if (sig !== expect) return reply({ error: 13, message: 'Invalid method signature' }, 403);
    switch (params.method) {
      case 'auth.getToken': return reply({ token: 'tok123' });
      case 'auth.getSession': return approved ? reply({ session: { name: 'adam', key: 'sk999' } }) : reply({ error: 14, message: 'Unauthorized Token' }, 403);
      case 'track.updateNowPlaying': return reply({ nowplaying: {} });
      case 'track.scrobble':
        if (mode === 'down') return reply({ error: 16, message: 'Service temporarily unavailable' }, 503);
        if (mode === 'revoked') return reply({ error: 9, message: 'Invalid session key' }, 403);
        return reply({ scrobbles: { '@attr': { accepted: 1 } } });
      default: return reply({ error: 3, message: 'Invalid method' }, 400);
    }
  };
  return { fetch, calls, setMode: (m) => { mode = m; }, approve: () => { approved = true; } };
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discshelf-lf-'));
  try {
    assert.strictEqual(scrobbleThreshold(20), null, 'short songs never scrobble');
    assert.strictEqual(scrobbleThreshold(200), 100, 'half the song');
    assert.strictEqual(scrobbleThreshold(900), 240, 'or 4 minutes');

    const srv = fakeServer();
    let session = null;
    const lf = new Lastfm({ fetch: srv.fetch, dataDir: dir, getKeys: () => ({ apiKey: KEY, secret: SECRET }), getSession: () => session, setSession: (s) => { session = s; } });

    // Sign in: the poll keeps getting "unauthorized" until the person approves in the browser.
    const url = await lf.beginAuth();
    assert.ok(url.startsWith('https://www.last.fm/api/auth/?api_key=') && url.includes('token=tok123'));
    await new Promise((r) => setTimeout(r, 3300));
    assert.strictEqual(session, null, 'not connected before approval');
    srv.approve();
    await new Promise((r) => setTimeout(r, 3300));
    assert.deepStrictEqual(session, { name: 'adam', key: 'sk999' }, 'connected after approval');
    assert.strictEqual(lf.status().user, 'adam');

    const song = { artist: 'Ada Feld', title: 'Small Talk', album: 'Copper Hours', albumArtist: 'Ada Feld', duration: 251.4, trackNo: 4 };
    assert.strictEqual(await lf.nowPlaying(song), true);
    const np = srv.calls.find((c) => c.method === 'track.updateNowPlaying');
    assert.strictEqual(np.sk, 'sk999');
    assert.strictEqual(np.track, 'Small Talk');
    assert.strictEqual(np.albumArtist, undefined, 'album artist only sent when it differs');

    // Last.fm down: scrobble stays queued (and on disk), then goes out later.
    srv.setMode('down');
    lf.scrobble(song, Date.UTC(2026, 10, 9, 12, 0, 0));
    await lf.flushing;
    assert.strictEqual(lf.queue.length, 1, 'kept while Last.fm is down');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'lastfm-queue.json'), 'utf8')).length, 1, 'queue saved to disk');
    srv.setMode('ok');
    const sent = await lf.flush();
    assert.strictEqual(sent, 1);
    assert.strictEqual(lf.queue.length, 0);
    const sc = srv.calls.filter((c) => c.method === 'track.scrobble').pop();
    assert.strictEqual(sc['artist[0]'], 'Ada Feld');
    assert.strictEqual(sc['timestamp[0]'], String(Date.UTC(2026, 10, 9, 12, 0, 0) / 1000));

    // 120 queued scrobbles go out in batches of 50.
    for (let i = 0; i < 120; i++) lf.queue.push({ ...Lastfm.params(song), timestamp: 1700000000 + i });
    const before = srv.calls.length;
    await lf.flush();
    assert.strictEqual(srv.calls.length - before, 3, '3 batches');
    assert.strictEqual(lf.queue.length, 0);

    // Access revoked on last.fm: disconnect and keep the scrobble for later.
    let errMsg = null;
    lf.on('authError', (m) => { errMsg = m; });
    srv.setMode('revoked');
    lf.scrobble(song, Date.now());
    await lf.flushing;
    assert.strictEqual(session, null, 'disconnected');
    assert.ok(errMsg && /disconnected/i.test(errMsg));
    assert.strictEqual(lf.queue.length, 1);

    // No API key: a clear error.
    const nokey = new Lastfm({ fetch: srv.fetch, dataDir: dir, getKeys: () => null, getSession: () => null, setSession: () => {} });
    await assert.rejects(nokey.beginAuth(), /API key/);
    console.log('all last.fm tests passed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((err) => { console.error('FAIL', err); process.exit(1); });
