'use strict';
// Online song info and cover art lookups: the iTunes Search API and Deezer's public search
// (neither needs an account or key). `fetchFn` is injected so tests can run offline.

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s*[([].*?(edition|remaster|version|deluxe|expanded|anniversary|bonus|mono|stereo).*?[)\]]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^the /, '')
    .trim();
}

function yearOf(date) {
  const m = /^(\d{4})/.exec(String(date || ''));
  return m ? parseInt(m[1], 10) : 0;
}

function itunesArt(url, size = 600) {
  return url ? url.replace(/\/\d+x\d+(bb)?\.(jpg|png)$/i, `/${size}x${size}bb.jpg`) : '';
}

function fromItunes(r) {
  return {
    source: 'iTunes',
    title: r.trackName || '',
    artist: r.artistName || '',
    albumArtist: r.collectionArtistName || '',
    album: r.collectionName || '',
    genre: r.primaryGenreName || '',
    year: yearOf(r.releaseDate),
    trackNo: r.trackNumber || 0,
    trackOf: r.trackCount || 0,
    discNo: r.discNumber || 0,
    discOf: r.discCount || 0,
    thumb: itunesArt(r.artworkUrl100, 100),
    artwork: itunesArt(r.artworkUrl100, 600),
    albumRef: r.collectionId ? `itunes:${r.collectionId}` : '',
  };
}

function fromDeezer(r) {
  return {
    source: 'Deezer',
    title: r.title || '',
    artist: (r.artist && r.artist.name) || '',
    albumArtist: '',
    album: (r.album && r.album.title) || '',
    genre: '',
    year: 0,
    trackNo: 0, trackOf: 0, discNo: 0, discOf: 0,
    thumb: (r.album && (r.album.cover_medium || r.album.cover_small)) || '',
    artwork: (r.album && (r.album.cover_xl || r.album.cover_big)) || '',
    albumRef: r.album && r.album.id ? `deezer:${r.album.id}` : '',
  };
}

function fromDeezerAlbum(r) {
  return {
    source: 'Deezer',
    title: '',
    artist: (r.artist && r.artist.name) || '',
    albumArtist: (r.artist && r.artist.name) || '',
    album: r.title || '',
    genre: '', year: 0, trackNo: 0, trackOf: r.nb_tracks || 0, discNo: 0, discOf: 0,
    thumb: r.cover_medium || r.cover_small || '',
    artwork: r.cover_xl || r.cover_big || '',
    albumRef: r.id ? `deezer:${r.id}` : '',
  };
}

class Online {
  constructor(fetchFn) {
    this.fetch = fetchFn;
  }

  async _json(url) {
    const res = await this.fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async _itunes(term, entity) {
    const url = `https://itunes.apple.com/search?media=music&entity=${entity}&limit=20&term=${encodeURIComponent(term)}`;
    const data = await this._json(url);
    return (data.results || []).map((r) => {
      if (entity === 'album') {
        return { ...fromItunes(r), title: '', albumArtist: r.artistName || '', trackNo: 0, trackOf: r.trackCount || 0 };
      }
      return fromItunes(r);
    });
  }

  async _deezer(term, entity) {
    const url = `https://api.deezer.com/search${entity === 'album' ? '/album' : ''}?limit=20&q=${encodeURIComponent(term)}`;
    const data = await this._json(url);
    if (data.error) throw new Error(data.error.message || 'Deezer error');
    return (data.data || []).map(entity === 'album' ? fromDeezerAlbum : fromDeezer);
  }

  /**
   * Searches both services. kind: 'song' | 'album'. Returns {results, errors}.
   * Results are de-duplicated, iTunes first (it has more details: year, genre, track numbers).
   */
  async search(term, kind = 'song') {
    term = String(term || '').trim();
    if (!term) return { results: [], errors: [] };
    const entity = kind === 'album' ? 'album' : 'song';
    const settled = await Promise.allSettled([this._itunes(term, entity), this._deezer(term, entity)]);
    const errors = [];
    const seen = new Set();
    const results = [];
    settled.forEach((s, i) => {
      if (s.status === 'rejected') { errors.push(`${i === 0 ? 'iTunes' : 'Deezer'}: ${s.reason.message}`); return; }
      for (const r of s.value) {
        const key = `${norm(r.title)}|${norm(r.artist)}|${norm(r.album)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push(r);
      }
    });
    return { results, errors };
  }

  /** Best cover for an album: an album search whose title and artist match. Returns a result or null. */
  async findAlbumCover(artist, album) {
    const { results } = await this.search(`${artist} ${album}`.trim(), 'album');
    const a = norm(album);
    const ar = norm(artist);
    const ok = (r) => {
      const ra = norm(r.album);
      const rr = norm(r.albumArtist || r.artist);
      const albumMatch = ra === a || (a.length > 3 && (ra.startsWith(a) || a.startsWith(ra)));
      const artistMatch = !ar || ar === 'various artists' || rr === ar || rr.includes(ar) || ar.includes(rr);
      return albumMatch && artistMatch && r.artwork;
    };
    return results.find(ok) || null;
  }

  /**
   * The track list of an album from a search result's albumRef ("itunes:123" / "deezer:456").
   * Returns {album, artist, year, genre, tracks: [{title, artist, trackNo, trackOf, discNo, discOf, duration}]}.
   */
  async albumTracks(ref) {
    const m = /^(itunes|deezer):(\d+)$/.exec(String(ref || ''));
    if (!m) throw new Error('No track list for this result');
    if (m[1] === 'itunes') {
      const data = await this._json(`https://itunes.apple.com/lookup?id=${m[2]}&entity=song&limit=300`);
      const all = data.results || [];
      const col = all.find((r) => r.wrapperType === 'collection') || {};
      const tracks = all.filter((r) => r.wrapperType === 'track' && r.kind === 'song').map((r) => ({
        title: r.trackName || '', artist: r.artistName || '',
        trackNo: r.trackNumber || 0, trackOf: r.trackCount || 0, discNo: r.discNumber || 0, discOf: r.discCount || 0,
        duration: r.trackTimeMillis ? r.trackTimeMillis / 1000 : 0,
      }));
      return { album: col.collectionName || '', artist: col.artistName || '', year: yearOf(col.releaseDate), genre: col.primaryGenreName || '', tracks: sortTracks(tracks) };
    }
    const [album, list] = await Promise.all([
      this._json(`https://api.deezer.com/album/${m[2]}`),
      this._json(`https://api.deezer.com/album/${m[2]}/tracks?limit=300`),
    ]);
    if (album.error) throw new Error(album.error.message || 'Deezer error');
    const items = (list.data || []);
    const discOf = Math.max(1, ...items.map((t) => t.disk_number || 1));
    const counts = {};
    for (const t of items) counts[t.disk_number || 1] = (counts[t.disk_number || 1] || 0) + 1;
    const tracks = items.map((t, i) => ({
      title: t.title || '', artist: (t.artist && t.artist.name) || '',
      trackNo: t.track_position || i + 1, trackOf: counts[t.disk_number || 1] || items.length,
      discNo: t.disk_number || 1, discOf,
      duration: t.duration || 0,
    }));
    const genre = album.genres && album.genres.data && album.genres.data[0] ? album.genres.data[0].name : '';
    return { album: album.title || '', artist: (album.artist && album.artist.name) || '', year: yearOf(album.release_date), genre, tracks: sortTracks(tracks) };
  }

  /** A photo of an artist (Deezer), or null. */
  async artistImage(name) {
    const data = await this._json(`https://api.deezer.com/search/artist?limit=5&q=${encodeURIComponent(name)}`);
    const want = norm(name);
    const hit = (data.data || []).find((a) => norm(a.name) === want);
    return hit && (hit.picture_xl || hit.picture_big) ? hit.picture_xl || hit.picture_big : null;
  }

  /** Downloads an image over https. Returns {mime, data}. */
  async downloadImage(url) {
    if (!/^https:\/\//i.test(String(url))) throw new Error('Only https images can be downloaded');
    const res = await this.fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const len = parseInt(res.headers.get('content-length') || '0', 10);
    if (len > MAX_IMAGE_BYTES) throw new Error('Image is too large');
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > MAX_IMAGE_BYTES) throw new Error('Image is too large');
    const mime = sniffImage(data);
    if (!mime) throw new Error('That download isn\'t an image');
    return { mime, data };
  }
}

function sortTracks(tracks) {
  return tracks.sort((a, b) => (a.discNo || 1) - (b.discNo || 1) || (a.trackNo || 0) - (b.trackNo || 0));
}

/** Title for matching: no "01 - " prefix, no "(feat. …)", no "(2011 Remaster)", lower case. */
function titleKey(s) {
  return norm(String(s || '')
    .replace(/^\s*\d{1,3}\s*[-._)]\s*/, '')
    .replace(/\s*[([](feat|ft|with)\.?\s.*?[)\]]/gi, '')
    .replace(/\s*-\s*(\d{4}\s*)?remaster(ed)?.*$/i, ''));
}

function words(s) { return new Set(s.split(' ').filter((w) => w.length > 1)); }

/**
 * Matches the songs you have to an album's track list.
 * local: [{id, title, trackNo, discNo, duration, path}], album: [{title, trackNo, discNo, duration}]
 * Returns [{id, index, how}] where index is into `album` (or -1) and how is
 * 'title' | 'number' | 'order' | null.
 */
function matchTracks(local, album) {
  const result = new Map(local.map((t) => [t.id, { id: t.id, index: -1, how: null }]));
  const usedAlbum = new Set();
  const pairs = [];
  local.forEach((t) => {
    const lk = titleKey(t.title);
    const lw = words(lk);
    album.forEach((a, j) => {
      const ak = titleKey(a.title);
      let score = 0;
      if (lk && lk === ak) score = 100;
      else if (lk.length > 3 && ak.length > 3 && (lk.includes(ak) || ak.includes(lk))) score = 75;
      else {
        const aw = words(ak);
        const inter = [...lw].filter((w) => aw.has(w)).length;
        const union = new Set([...lw, ...aw]).size;
        if (union && inter / union >= 0.5) score = 50 * (inter / union) + 20;
      }
      const sameNumber = t.trackNo && t.trackNo === a.trackNo && (t.discNo || 1) === (a.discNo || 1);
      if (score && sameNumber) score += 15;
      if (score && t.duration && a.duration && Math.abs(t.duration - a.duration) < 4) score += 10;
      if (score >= 45) pairs.push({ id: t.id, j, score });
    });
  });
  pairs.sort((a, b) => b.score - a.score);
  for (const p of pairs) {
    const r = result.get(p.id);
    if (r.index >= 0 || usedAlbum.has(p.j)) continue;
    r.index = p.j; r.how = 'title'; usedAlbum.add(p.j);
  }
  // Then by track (and disc) number.
  for (const t of local) {
    const r = result.get(t.id);
    if (r.index >= 0 || !t.trackNo) continue;
    const j = album.findIndex((a, k) => !usedAlbum.has(k) && a.trackNo === t.trackNo && (a.discNo || 1) === (t.discNo || 1));
    if (j >= 0) { r.index = j; r.how = 'number'; usedAlbum.add(j); }
  }
  // Then, if the counts line up, in file order.
  const leftLocal = local.filter((t) => result.get(t.id).index < 0);
  const leftAlbum = album.map((_, k) => k).filter((k) => !usedAlbum.has(k));
  if (leftLocal.length && leftLocal.length === leftAlbum.length) {
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    leftLocal.sort((a, b) => (a.discNo || 1) - (b.discNo || 1) || (a.trackNo || 0) - (b.trackNo || 0) || collator.compare(a.path || '', b.path || ''));
    leftLocal.forEach((t, i) => { const r = result.get(t.id); r.index = leftAlbum[i]; r.how = 'order'; });
  }
  return local.map((t) => result.get(t.id));
}

function sniffImage(data) {
  if (!data || data.length < 8) return null;
  if (data[0] === 0xFF && data[1] === 0xD8) return 'image/jpeg';
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47) return 'image/png';
  if (data.toString('latin1', 0, 3) === 'GIF') return 'image/gif';
  if (data.length > 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

module.exports = { Online, norm, sniffImage, matchTracks, titleKey };
