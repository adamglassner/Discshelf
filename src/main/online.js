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

function sniffImage(data) {
  if (!data || data.length < 8) return null;
  if (data[0] === 0xFF && data[1] === 0xD8) return 'image/jpeg';
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47) return 'image/png';
  if (data.toString('latin1', 0, 3) === 'GIF') return 'image/gif';
  if (data.length > 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

module.exports = { Online, norm, sniffImage };
