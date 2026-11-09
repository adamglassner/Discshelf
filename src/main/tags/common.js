'use strict';
// Vorbis comments (FLAC, Ogg Vorbis, Opus) and the ID3v1 genre list (also used by MP4 "gnre").
const { cleanText, parseNumberPair, parseYear, imageMimeFromData } = require('./reader');

const ID3V1_GENRES = [
  'Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop', 'Jazz', 'Metal',
  'New Age', 'Oldies', 'Other', 'Pop', 'R&B', 'Rap', 'Reggae', 'Rock', 'Techno', 'Industrial',
  'Alternative', 'Ska', 'Death Metal', 'Pranks', 'Soundtrack', 'Euro-Techno', 'Ambient', 'Trip-Hop', 'Vocal', 'Jazz+Funk',
  'Fusion', 'Trance', 'Classical', 'Instrumental', 'Acid', 'House', 'Game', 'Sound Clip', 'Gospel', 'Noise',
  'Alternative Rock', 'Bass', 'Soul', 'Punk', 'Space', 'Meditative', 'Instrumental Pop', 'Instrumental Rock', 'Ethnic', 'Gothic',
  'Darkwave', 'Techno-Industrial', 'Electronic', 'Pop-Folk', 'Eurodance', 'Dream', 'Southern Rock', 'Comedy', 'Cult', 'Gangsta',
  'Top 40', 'Christian Rap', 'Pop/Funk', 'Jungle', 'Native American', 'Cabaret', 'New Wave', 'Psychedelic', 'Rave', 'Showtunes',
  'Trailer', 'Lo-Fi', 'Tribal', 'Acid Punk', 'Acid Jazz', 'Polka', 'Retro', 'Musical', 'Rock & Roll', 'Hard Rock',
  'Folk', 'Folk-Rock', 'National Folk', 'Swing', 'Fast Fusion', 'Bebop', 'Latin', 'Revival', 'Celtic', 'Bluegrass',
  'Avantgarde', 'Gothic Rock', 'Progressive Rock', 'Psychedelic Rock', 'Symphonic Rock', 'Slow Rock', 'Big Band', 'Chorus', 'Easy Listening', 'Acoustic',
  'Humour', 'Speech', 'Chanson', 'Opera', 'Chamber Music', 'Sonata', 'Symphony', 'Booty Bass', 'Primus', 'Porn Groove',
  'Satire', 'Slow Jam', 'Club', 'Tango', 'Samba', 'Folklore', 'Ballad', 'Power Ballad', 'Rhythmic Soul', 'Freestyle',
  'Duet', 'Punk Rock', 'Drum Solo', 'A Cappella', 'Euro-House', 'Dance Hall', 'Goa', 'Drum & Bass', 'Club-House', 'Hardcore',
  'Terror', 'Indie', 'Britpop', 'Afro-Punk', 'Polsk Punk', 'Beat', 'Christian Gangsta Rap', 'Heavy Metal', 'Black Metal', 'Crossover',
  'Contemporary Christian', 'Christian Rock', 'Merengue', 'Salsa', 'Thrash Metal', 'Anime', 'J-Pop', 'Synthpop',
];

function genreFromIndex(i) {
  return Number.isInteger(i) && i >= 0 && i < ID3V1_GENRES.length ? ID3V1_GENRES[i] : '';
}

/** ID3 genres can be "(17)", "17", "(17)Rock", "Rock" or "RX"/"CR". */
function normalizeId3Genre(raw) {
  let s = cleanText(raw);
  if (!s) return '';
  const m = /^\((\d+)\)(.*)$/.exec(s);
  if (m) return cleanText(m[2]) || genreFromIndex(parseInt(m[1], 10));
  if (/^\d+$/.test(s)) return genreFromIndex(parseInt(s, 10)) || s;
  if (s === 'RX') return 'Remix';
  if (s === 'CR') return 'Cover';
  return s;
}

/** RATING=0–100 (some taggers write 1–5). */
function ratingFromPercent(v) {
  const n = parseFloat(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n <= 5 && Number.isInteger(n)) return n;
  return Math.max(1, Math.min(5, Math.round(n / 20)));
}
/** FMPS_RATING=0.0–1.0 */
function ratingFromFraction(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 ? Math.max(1, Math.min(5, Math.round(n * 5))) : 0;
}
/** ID3 POPM rating byte (0–255, as Windows Media Player writes it) → 0–5 stars. */
function ratingFromPopm(b) {
  if (!b) return 0;
  if (b < 32) return 1;
  if (b < 96) return 2;
  if (b < 160) return 3;
  if (b < 224) return 4;
  return 5;
}

function emptyTags() {
  return {
    title: '', artist: '', albumArtist: '', album: '', genre: '', year: 0,
    trackNo: 0, trackOf: 0, discNo: 0, discOf: 0,
    duration: 0, codec: '', bitrate: 0, sampleRate: 0, bitsPerSample: 0, channels: 0,
    rating: 0, loved: false,
    pictures: [],
  };
}

/** Parses a FLAC METADATA_BLOCK_PICTURE structure (also base64-embedded in Vorbis comments). */
function parseFlacPicture(buf) {
  try {
    let o = 0;
    const type = buf.readUInt32BE(o); o += 4;
    const mimeLen = buf.readUInt32BE(o); o += 4;
    const mime = buf.toString('latin1', o, o + mimeLen); o += mimeLen;
    const descLen = buf.readUInt32BE(o); o += 4 + descLen;
    o += 16; // width, height, depth, colours
    const dataLen = buf.readUInt32BE(o); o += 4;
    const data = buf.subarray(o, o + dataLen);
    if (data.length !== dataLen) return null;
    return { type, mime: imageMimeFromData(data, mime), data };
  } catch {
    return null;
  }
}

/**
 * Parses a Vorbis comment block: vendor string then KEY=value pairs, all lengths little-endian.
 * Fills `tags` in place.
 */
function applyVorbisComments(buf, tags) {
  let o = 0;
  const need = (n) => { if (o + n > buf.length) throw new Error('short'); };
  try {
    need(4);
    const vendorLen = buf.readUInt32LE(o); o += 4 + vendorLen;
    need(4);
    const count = buf.readUInt32LE(o); o += 4;
    const fields = {};
    for (let i = 0; i < count && o + 4 <= buf.length; i++) {
      const len = buf.readUInt32LE(o); o += 4;
      if (o + len > buf.length) break;
      const raw = buf.toString('utf8', o, o + len); o += len;
      const eq = raw.indexOf('=');
      if (eq <= 0) continue;
      const key = raw.slice(0, eq).toUpperCase();
      const value = raw.slice(eq + 1);
      if (key === 'METADATA_BLOCK_PICTURE') {
        const pic = parseFlacPicture(Buffer.from(value, 'base64'));
        if (pic) tags.pictures.push(pic);
        continue;
      }
      if (!(key in fields)) fields[key] = value; // first value wins
    }
    const f = (k) => cleanText(fields[k] || '');
    tags.title = f('TITLE') || tags.title;
    tags.artist = f('ARTIST') || tags.artist;
    tags.albumArtist = f('ALBUMARTIST') || f('ALBUM ARTIST') || f('ALBUM_ARTIST') || tags.albumArtist;
    tags.album = f('ALBUM') || tags.album;
    tags.genre = f('GENRE') || tags.genre;
    tags.year = parseYear(f('DATE') || f('YEAR') || f('ORIGINALDATE')) || tags.year;
    const track = parseNumberPair(f('TRACKNUMBER'));
    const disc = parseNumberPair(f('DISCNUMBER'));
    tags.trackNo = track.no || tags.trackNo;
    tags.trackOf = track.of || parseInt(f('TRACKTOTAL') || f('TOTALTRACKS'), 10) || tags.trackOf;
    tags.discNo = disc.no || tags.discNo;
    tags.discOf = disc.of || parseInt(f('DISCTOTAL') || f('TOTALDISCS'), 10) || tags.discOf;
    tags.rating = ratingFromPercent(f('RATING')) || ratingFromFraction(f('FMPS_RATING')) || tags.rating;
    if (/^(1|true|yes)$/i.test(f('LOVED'))) tags.loved = true;
  } catch {
    /* a damaged comment block: keep whatever we have */
  }
  return tags;
}

module.exports = { ratingFromPercent, ratingFromFraction, ratingFromPopm, ID3V1_GENRES, genreFromIndex, normalizeId3Genre, emptyTags, parseFlacPicture, applyVorbisComments };
