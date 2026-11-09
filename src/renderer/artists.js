'use strict';
/* Artists view (iTunes 12 style): artist list on the left; on the right a header with Play / Shuffle,
   an About box (Last.fm bio, tags, similar artists) and each album with its songs. */
window.DSModules = window.DSModules || {};
window.DSModules.artists = (ctx) => {
  const { $, esc, fold, I, n, plural, fmtTime, fmtTotal, fmtSize, artUrl, collator, sortName, state, api } = ctx;

  let artists = null;
  let byKey = new Map();
  let shown = [];
  let selectedKey = null;
  let selectedTrack = null;
  const infoCache = new Map(); // name -> Last.fm info (or null)
  const imgRequested = new Set();

  /** The artist a song is listed under: its album artist, unless that's "Various Artists". */
  function artistOf(t) {
    const aa = t.albumArtist && t.albumArtist.toLowerCase() !== 'various artists' ? t.albumArtist : '';
    return aa || t.artist || '';
  }

  function build() {
    const map = new Map();
    for (const t of state.tracks) {
      const name = artistOf(t);
      const key = fold(name);
      if (!map.has(key)) map.set(key, { key, name, tracks: [] });
      map.get(key).tracks.push(t);
    }
    artists = [...map.values()].map((a) => {
      // Albums: the library's album groups, keeping only this artist's songs on compilations.
      const albums = new Map();
      for (const t of a.tracks) {
        const al = ctx.albums.albumOf(t.id);
        const k = al ? al.key : `?${t.album}`;
        if (!albums.has(k)) albums.set(k, { album: al, title: t.album || 'Unknown Album', tracks: [] });
        albums.get(k).tracks.push(t);
      }
      a.albums = [...albums.values()].map((b) => {
        b.tracks.sort((x, y) => (x.discNo || 1) - (y.discNo || 1) || (x.trackNo || 0) - (y.trackNo || 0) || collator.compare(x.title, y.title));
        b.year = Math.max(0, ...b.tracks.map((t) => t.year || 0));
        b.genre = b.album ? b.album.genre : b.tracks[0].genre || '';
        b.artTrack = b.tracks.find((t) => t.art) || (b.album && b.album.artTrack) || null;
        b.various = new Set(b.tracks.map((t) => t.artist)).size > 1 || (b.album && b.album.artist === 'Various Artists');
        return b;
      }).sort((x, y) => (y.year || 0) - (x.year || 0) || collator.compare(x.title, y.title)); // newest first, like iTunes
      a.ids = a.albums.flatMap((b) => b.tracks.map((t) => t.id));
      a.duration = a.tracks.reduce((s, t) => s + (t.duration || 0), 0);
      a.size = a.tracks.reduce((s, t) => s + (t.size || 0), 0);
      a.coverTrack = a.albums.find((b) => b.artTrack)?.artTrack || null;
      a._s = fold(`${a.name} ${a.albums.map((b) => b.title).join(' ')}`);
      return a;
    }).sort((x, y) => {
      if (!x.name !== !y.name) return x.name ? -1 : 1; // Unknown Artist last
      return collator.compare(sortName(x.name), sortName(y.name));
    });
    byKey = new Map(artists.map((a) => [a.key, a]));
  }

  function all() { if (!artists) build(); return artists; }
  function invalidate() { artists = null; }

  function photo(a) {
    const info = state.artistImages && state.artistImages[a.name.toLowerCase()];
    if (info && info.art) return artUrl({ art: info.art });
    return artUrl(a.coverTrack);
  }

  function filtered() {
    let list = all();
    if (state.search) {
      const words = fold(state.search).split(/\s+/).filter(Boolean);
      list = list.filter((a) => words.every((w) => a._s.includes(w)));
    }
    return list;
  }

  // ---------------------------------------------------------------- rendering

  function listRow(a, i) {
    const url = photo(a);
    const albumsN = a.albums.length;
    return `<button type="button" class="ar-item${a.key === selectedKey ? ' selected' : ''}" data-i="${i}" role="option" aria-selected="${a.key === selectedKey}">
      <span class="ar-thumb" data-name="${esc(a.name)}">${url ? `<img src="${esc(url)}" alt="" loading="lazy">` : I.artists}</span>
      <span class="ar-text"><span class="ar-name">${esc(a.name || 'Unknown Artist')}</span>
      <span class="ar-count">${plural(albumsN, 'album', 'albums')}, ${plural(a.tracks.length, 'song', 'songs')}</span></span></button>`;
  }

  function render() {
    shown = filtered();
    if (!selectedKey || !shown.some((a) => a.key === selectedKey)) selectedKey = shown[0] ? shown[0].key : null;
    $('#ar-list').innerHTML = shown.length
      ? shown.map(listRow).join('')
      : `<div class="ar-none">${state.search ? 'No artists match your search.' : 'No artists yet.'}</div>`;
    renderDetail();
    observeThumbs();
    const sel = $('#ar-list .ar-item.selected');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }

  function songRows(b, ai) {
    return b.tracks.map((t, i) => {
      const playing = state.current && state.current.id === t.id;
      return `<div class="al-row${playing ? ' playing' : ''}${selectedTrack === t.id ? ' selected' : ''}" data-album="${ai}" data-i="${i}">
        <span class="al-no">${playing ? (ctx.audio.paused ? I.pause : I.speaker) : (t.trackNo || '')}</span>
        <span class="al-name">${esc(t.title)}${b.various && t.artist ? `<span class="al-by"> — ${esc(t.artist)}</span>` : ''}</span>
        <span class="al-plays">${t.playCount ? plural(t.playCount, 'play', 'plays') : ''}</span>
        <span class="al-time">${t.duration ? fmtTime(t.duration) : ''}</span></div>`;
    }).join('');
  }

  function renderDetail() {
    const box = $('#ar-detail');
    const a = byKey.get(selectedKey);
    if (!a) { box.innerHTML = ''; ctx.renderStatus(); return; }
    const url = photo(a);
    box.innerHTML = `
      <div class="ar-head">
        <div class="ar-head-img">${url ? `<img src="${esc(url)}" alt="">` : I.artists}</div>
        <div class="ar-head-text">
          <h1>${esc(a.name || 'Unknown Artist')}</h1>
          <div class="ar-head-sub">${plural(a.albums.length, 'album', 'albums')} · ${plural(a.tracks.length, 'song', 'songs')} · ${fmtTotal(a.duration)}</div>
          <div class="ar-head-buttons">
            <button type="button" class="btn primary" data-act="play">${I.play}<span>Play</span></button>
            <button type="button" class="btn" data-act="shuffle">${I.shuffle}<span>Shuffle</span></button>
          </div>
        </div>
      </div>
      <div class="ar-body">
        <div class="ar-albums">
          ${a.albums.map((b, ai) => `
            <section class="ar-album">
              <div class="ar-album-art" data-album="${ai}">${artUrl(b.artTrack) ? `<img src="${esc(artUrl(b.artTrack))}" alt="" loading="lazy">` : `<div class="al-ph">${I.music}</div>`}</div>
              <div class="ar-album-main">
                <div class="ar-album-head">
                  <div><h2><button type="button" class="ar-album-title" data-open-album="${ai}">${esc(b.title)}</button></h2>
                  <div class="ar-album-meta">${esc([b.genre, b.year || ''].filter(Boolean).join(' · '))}</div></div>
                  <button type="button" class="ibtn" data-play-album="${ai}" aria-label="Play ${esc(b.title)}" title="Play album">${I.play}</button>
                </div>
                <div class="al-rows" tabindex="0">${songRows(b, ai)}</div>
              </div>
            </section>`).join('')}
        </div>
        <aside class="ar-about" id="ar-about"></aside>
      </div>`;
    renderAbout(a);
    ctx.renderStatus();
  }

  async function renderAbout(a) {
    const box = $('#ar-about');
    if (!box) return;
    if (!a.name || !state.settings.onlineLookup) { box.hidden = true; return; }
    let info = infoCache.get(a.key);
    if (info === undefined) {
      box.hidden = true;
      info = await api.artistInfo(a.name).catch(() => null);
      infoCache.set(a.key, info);
      if (selectedKey !== a.key) return;
    }
    if (!info || (!info.bio && !info.similar.length)) { box.hidden = true; return; }
    const inLib = (name) => byKey.get(fold(name));
    box.hidden = false;
    box.innerHTML = `
      ${info.bio ? `<h3>About</h3><p class="ar-bio">${esc(info.bio)}</p>` : ''}
      ${info.tags.length ? `<div class="ar-tags">${info.tags.map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
      ${info.similar.length ? `<h3>Similar artists</h3><ul class="ar-similar">${info.similar.map((s) => (inLib(s)
        ? `<li><button type="button" class="linkbtn" data-goto-artist="${esc(fold(s))}">${esc(s)}</button> <span class="ar-inlib">in your library</span></li>`
        : `<li>${esc(s)}</li>`)).join('')}</ul>` : ''}
      ${info.url ? `<a class="ar-more" href="${esc(info.url)}">More on Last.fm</a>` : ''}`;
  }

  // Artist photos load as rows scroll into view (a few at a time).
  let observer = null;
  const queue = [];
  let active = 0;
  function pump() {
    while (active < 2 && queue.length) {
      const name = queue.shift();
      active++;
      api.artistImage(name).then((art) => {
        if (art) {
          state.artistImages = state.artistImages || {};
          state.artistImages[name.toLowerCase()] = { art, checked: Date.now() };
          const url = artUrl({ art });
          document.querySelectorAll(`.ar-thumb[data-name="${CSS.escape(name)}"]`).forEach((el) => { el.innerHTML = `<img src="${esc(url)}" alt="">`; });
          if (byKey.get(selectedKey)?.name === name) {
            const h = $('#ar-detail .ar-head-img');
            if (h) h.innerHTML = `<img src="${esc(url)}" alt="">`;
          }
        }
      }).catch(() => {}).finally(() => { active--; pump(); });
    }
  }
  function observeThumbs() {
    if (!state.settings.onlineLookup) return;
    if (!observer) {
      observer = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const name = e.target.dataset.name;
          observer.unobserve(e.target);
          const known = state.artistImages && state.artistImages[name.toLowerCase()];
          if (!name || imgRequested.has(name) || (known && known.art)) continue;
          imgRequested.add(name);
          queue.push(name);
        }
        pump();
      }, { root: $('#ar-list') });
    }
    document.querySelectorAll('#ar-list .ar-thumb[data-name]').forEach((el) => observer.observe(el));
  }

  function select(key) {
    selectedKey = key;
    selectedTrack = null;
    document.querySelectorAll('#ar-list .ar-item').forEach((el) => {
      const on = shown[parseInt(el.dataset.i, 10)]?.key === key;
      el.classList.toggle('selected', on);
      el.setAttribute('aria-selected', String(on));
    });
    renderDetail();
    $('#ar-detail').scrollTop = 0;
  }

  function updatePlaying() {
    const a = byKey.get(selectedKey);
    if (!a || $('#artists-view').hidden) return;
    document.querySelectorAll('#ar-detail .al-rows').forEach((rows, ai) => { rows.innerHTML = songRows(a.albums[ai], ai); });
  }

  function trackAt(el) {
    const a = byKey.get(selectedKey);
    const b = a && a.albums[parseInt(el.dataset.album, 10)];
    return b ? { a, b, i: parseInt(el.dataset.i, 10) } : null;
  }

  // ---------------------------------------------------------------- events

  function setup() {
    const list = $('#ar-list');
    list.addEventListener('click', (e) => {
      const it = e.target.closest('.ar-item');
      if (it) select(shown[parseInt(it.dataset.i, 10)].key);
    });
    list.addEventListener('dblclick', (e) => {
      const it = e.target.closest('.ar-item');
      if (it) ctx.playQueue(shown[parseInt(it.dataset.i, 10)].ids, 0);
    });
    list.addEventListener('keydown', (e) => {
      const i = shown.findIndex((a) => a.key === selectedKey);
      let j = null;
      if (e.key === 'ArrowDown') j = Math.min(shown.length - 1, i + 1);
      else if (e.key === 'ArrowUp') j = Math.max(0, i - 1);
      else if (e.key === 'Home') j = 0;
      else if (e.key === 'End') j = shown.length - 1;
      else if (e.key === 'Enter') { e.preventDefault(); if (shown[i]) ctx.playQueue(shown[i].ids, 0); return; } else return;
      e.preventDefault();
      if (shown[j]) {
        select(shown[j].key);
        const el = list.querySelector(`.ar-item[data-i="${j}"]`);
        if (el) { el.scrollIntoView({ block: 'nearest' }); el.focus(); }
      }
    });
    list.addEventListener('contextmenu', (e) => {
      const it = e.target.closest('.ar-item');
      if (!it) return;
      e.preventDefault();
      const a = shown[parseInt(it.dataset.i, 10)];
      api.albumMenu(a.ids, a.name || 'Unknown Artist', e.clientX, e.clientY);
    });

    const d = $('#ar-detail');
    d.addEventListener('click', (e) => {
      const a = byKey.get(selectedKey);
      if (!a) return;
      const act = e.target.closest('[data-act]');
      if (act) { ctx.playQueue(a.ids, act.dataset.act === 'shuffle' ? -1 : 0, { shuffle: act.dataset.act === 'shuffle' }); return; }
      const pa = e.target.closest('[data-play-album]');
      if (pa) { ctx.playQueue(a.albums[parseInt(pa.dataset.playAlbum, 10)].tracks.map((t) => t.id), 0); return; }
      const oa = e.target.closest('[data-open-album]');
      if (oa) { const b = a.albums[parseInt(oa.dataset.openAlbum, 10)]; if (b.tracks[0]) ctx.albums.openForTrack(b.tracks[0].id); return; }
      const ga = e.target.closest('[data-goto-artist]');
      if (ga) { if (state.search) { ctx.clearSearch(); } render(); select(ga.dataset.gotoArtist); return; }
      const more = e.target.closest('a.ar-more');
      if (more) { e.preventDefault(); window.open(more.href); return; }
      const row = e.target.closest('.al-row');
      if (row) {
        const r = trackAt(row);
        selectedTrack = r.b.tracks[r.i].id;
        d.querySelectorAll('.al-row').forEach((x) => x.classList.toggle('selected', x === row));
        if (state.artMode === 'selected') ctx.renderArtPane(selectedTrack);
      }
    });
    d.addEventListener('dblclick', (e) => {
      const row = e.target.closest('.al-row');
      if (row) {
        // Play the artist's songs, starting from this one.
        const r = trackAt(row);
        const id = r.b.tracks[r.i].id;
        ctx.playQueue(r.a.ids, r.a.ids.indexOf(id));
        return;
      }
      const art = e.target.closest('.ar-album-art');
      if (art) { const a = byKey.get(selectedKey); ctx.playQueue(a.albums[parseInt(art.dataset.album, 10)].tracks.map((t) => t.id), 0); }
    });
    d.addEventListener('contextmenu', (e) => {
      const row = e.target.closest('.al-row');
      if (row) { e.preventDefault(); const r = trackAt(row); api.trackMenu([r.b.tracks[r.i].id], e.clientX, e.clientY); return; }
      const art = e.target.closest('.ar-album-art');
      if (art) {
        e.preventDefault();
        const b = byKey.get(selectedKey).albums[parseInt(art.dataset.album, 10)];
        api.albumMenu(b.tracks.map((t) => t.id), b.title, e.clientX, e.clientY);
      }
    });
  }

  function status() {
    const a = byKey.get(selectedKey);
    if (a) return `${a.name || 'Unknown Artist'}: ${plural(a.albums.length, 'album', 'albums')}, ${plural(a.tracks.length, 'song', 'songs')}, ${fmtTotal(a.duration)}, ${fmtSize(a.size)}`;
    return `${plural(filtered().length, 'artist', 'artists')}`;
  }

  function selectedIds() {
    if (selectedTrack) return [selectedTrack];
    const a = byKey.get(selectedKey);
    return a ? a.ids : [];
  }

  /** Opens the Artists view on the artist of a song. */
  function openForTrack(trackId) {
    const t = state.byId.get(trackId);
    if (!t) return;
    ctx.setView('artists');
    const key = fold(artistOf(t));
    if (!shown.some((a) => a.key === key)) { ctx.clearSearch(); render(); }
    select(key);
    const el = $('#ar-list .ar-item.selected');
    if (el) el.scrollIntoView({ block: 'center' });
  }

  return { setup, render, invalidate, all, status, selectedIds, updatePlaying, openForTrack, count: () => all().length };
};
