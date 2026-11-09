'use strict';
/* Albums view: an iTunes-style grid (Recently Added + All Albums) and an album page with Play / Shuffle. */
window.DSModules = window.DSModules || {};
window.DSModules.albums = (ctx) => {
  const { $, esc, fold, I, n, plural, fmtTime, fmtTotal, fmtSize, artUrl, collator, sortName, state, api } = ctx;

  let albums = null; // built lazily from the library
  let byKey = new Map();
  let shown = []; // albums in the All Albums grid (after search + sort)
  let recent = [];
  let openKey = null; // album page that's open, if any
  let recentExpanded = false;
  let selectedTrack = null;

  // ---------------------------------------------------------------- grouping

  const dirOf = (p) => p.replace(/[\\/][^\\/]*$/, '').toLowerCase();

  function build() {
    // 1) Songs with an album artist group by album + album artist; songs without one group by
    //    album + folder (so a compilation in one folder stays together); no album groups by artist.
    const first = new Map();
    for (const t of state.tracks) {
      const album = t.album || '';
      const k = album
        ? (t.albumArtist ? `a|${fold(album)}|${fold(t.albumArtist)}` : `d|${fold(album)}|${dirOf(t.path)}`)
        : `u|${fold(t.artist)}`;
      if (!first.has(k)) first.set(k, []);
      first.get(k).push(t);
    }
    // 2) Work out each group's artist, then merge groups that end up with the same album + artist
    //    (e.g. "CD1" and "CD2" folders of one album).
    const merged = new Map();
    for (const tracks of first.values()) {
      const t0 = tracks[0];
      let artist = tracks.find((t) => t.albumArtist)?.albumArtist || '';
      if (!artist) {
        const names = new Set(tracks.map((t) => t.artist).filter(Boolean));
        artist = names.size === 1 ? [...names][0] : names.size > 1 ? 'Various Artists' : '';
      }
      const key = `${fold(t0.album)}|${fold(artist)}`;
      if (!merged.has(key)) merged.set(key, { key, title: t0.album || '', artist, tracks: [] });
      merged.get(key).tracks.push(...tracks);
    }
    albums = [...merged.values()].map((a) => {
      a.tracks.sort((x, y) => (x.discNo || 1) - (y.discNo || 1) || (x.trackNo || 0) - (y.trackNo || 0) || collator.compare(x.title, y.title));
      a.ids = a.tracks.map((t) => t.id);
      a.year = Math.max(0, ...a.tracks.map((t) => t.year || 0));
      const genres = new Map();
      for (const t of a.tracks) if (t.genre) genres.set(t.genre, (genres.get(t.genre) || 0) + 1);
      a.genre = [...genres.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] || '';
      a.artTrack = a.tracks.find((t) => t.art) || null;
      a.added = Math.max(0, ...a.tracks.map((t) => t.added || 0));
      a.duration = a.tracks.reduce((s, t) => s + (t.duration || 0), 0);
      a.size = a.tracks.reduce((s, t) => s + (t.size || 0), 0);
      a.discs = new Set(a.tracks.map((t) => t.discNo || 1)).size;
      a.various = new Set(a.tracks.map((t) => t.artist)).size > 1;
      a._s = fold(`${a.title} ${a.artist} ${a.genre} ${a.year || ''} ${a.tracks.map((t) => `${t.title} ${t.artist}`).join(' ')}`);
      return a;
    });
    byKey = new Map(albums.map((a) => [a.key, a]));
  }

  function all() {
    if (!albums) build();
    return albums;
  }

  function invalidate() { albums = null; }

  /** Song ids of the album a song belongs to (for "apply artwork to the whole album"). */
  function albumOf(trackId) {
    return all().find((a) => a.ids.includes(trackId)) || null;
  }

  // ---------------------------------------------------------------- sorting / search

  const SORTS = {
    artist: (a, b) => collator.compare(sortName(a.artist) || '￿', sortName(b.artist) || '￿') || (a.year || 0) - (b.year || 0) || collator.compare(a.title, b.title),
    title: (a, b) => collator.compare(sortName(a.title) || '￿', sortName(b.title) || '￿') || collator.compare(a.artist, b.artist),
    year: (a, b) => (b.year || 0) - (a.year || 0) || SORTS.artist(a, b),
    added: (a, b) => b.added - a.added || SORTS.artist(a, b),
  };

  function filtered() {
    let list = all();
    if (state.search) {
      const words = fold(state.search).split(/\s+/).filter(Boolean);
      list = list.filter((a) => words.every((w) => a._s.includes(w)));
    }
    return list;
  }

  // ---------------------------------------------------------------- rendering

  function cover(a, size = 'grid') {
    const url = artUrl(a.artTrack);
    if (url) return `<img src="${esc(url)}" alt="" loading="lazy" decoding="async"${size === 'hero' ? ' crossorigin="anonymous"' : ''}>`;
    return `<div class="al-ph">${I.music}</div>`;
  }

  function card(a, list, i) {
    return `<div class="al-card" data-list="${list}" data-i="${i}">
      <button type="button" class="al-open" title="${esc(`${a.title || 'Unknown Album'} — ${a.artist || 'Unknown Artist'}`)}">
        <span class="al-cover">${cover(a)}</span>
        <span class="al-title">${esc(a.title || 'Unknown Album')}</span>
        <span class="al-artist">${esc(a.artist || 'Unknown Artist')}</span>
      </button>
      <div class="al-overlay"><button type="button" class="al-play" aria-label="Play ${esc(a.title || 'album')}" tabindex="-1">${I.play}</button></div>
    </div>`;
  }

  function render() {
    const view = $('#albums-view');
    if (openKey && byKey.has(openKey) && all() && byKey.get(openKey)) {
      renderDetail(byKey.get(openKey));
      return;
    }
    openKey = null;
    $('#al-detail').hidden = true;
    $('#al-grid-page').hidden = false;
    const list = filtered().slice().sort(SORTS[state.settings.albumSort] || SORTS.artist);
    shown = list;
    recent = state.search ? [] : all().slice().sort(SORTS.added).slice(0, 40);
    const recentSection = $('#al-recent');
    recentSection.hidden = recent.length < 2;
    if (recent.length >= 2) {
      $('#al-recent-grid').innerHTML = recent.map((a, i) => card(a, 'recent', i)).join('');
      $('#al-recent-grid').classList.toggle('one-row', !recentExpanded);
      $('#al-recent-more').textContent = recentExpanded ? 'Show less' : 'Show more';
    }
    $('#al-all-title').textContent = state.search ? `Albums matching “${state.search}”` : 'All Albums';
    $('#al-sort').value = state.settings.albumSort || 'artist';
    $('#al-all-grid').innerHTML = list.length
      ? list.map((a, i) => card(a, 'all', i)).join('')
      : `<div class="al-none">${state.search ? 'No albums match your search.' : 'No albums yet.'}</div>`;
    view.dataset.page = 'grid';
    ctx.renderStatus();
  }

  function trackRows(a) {
    let html = '';
    let disc = null;
    a.tracks.forEach((t, i) => {
      const d = t.discNo || 1;
      if (a.discs > 1 && d !== disc) { disc = d; html += `<div class="al-disc">Disc ${d}</div>`; }
      const playing = state.current && state.current.id === t.id;
      html += `<div class="al-row${playing ? ' playing' : ''}${selectedTrack === t.id ? ' selected' : ''}" data-i="${i}">
        <span class="al-no">${playing ? (ctx.audio.paused ? I.pause : I.speaker) : (t.trackNo || '')}</span>
        <span class="al-name">${esc(t.title)}${a.various && t.artist ? `<span class="al-by"> — ${esc(t.artist)}</span>` : ''}</span>
        <span class="al-plays">${t.playCount ? plural(t.playCount, 'play', 'plays') : ''}</span>
        <span class="al-time">${t.duration ? fmtTime(t.duration) : ''}</span></div>`;
    });
    return html;
  }

  function renderDetail(a) {
    openKey = a.key;
    $('#al-grid-page').hidden = true;
    const d = $('#al-detail');
    d.hidden = false;
    $('#albums-view').dataset.page = 'detail';
    const meta = [a.genre, a.year || ''].filter(Boolean).join(' · ');
    d.innerHTML = `
      <button type="button" class="al-back">${I.back}<span>Albums</span></button>
      <div class="al-hero">
        <div class="al-hero-art">${cover(a, 'hero')}</div>
        <div class="al-hero-info">
          <h1>${esc(a.title || 'Unknown Album')}</h1>
          <div class="al-hero-artist">${esc(a.artist || 'Unknown Artist')}</div>
          <div class="al-hero-meta">${esc(meta)}</div>
          <div class="al-hero-buttons">
            <button type="button" class="btn primary" data-act="play">${I.play}<span>Play</span></button>
            <button type="button" class="btn" data-act="shuffle">${I.shuffle}<span>Shuffle</span></button>
            <button type="button" class="btn" data-act="info">Get Info</button>
          </div>
          <div class="al-rows" tabindex="0" role="listbox" aria-label="Songs on ${esc(a.title)}">${trackRows(a)}</div>
          <div class="al-foot">${plural(a.tracks.length, 'song', 'songs')}, ${fmtTotal(a.duration)}, ${fmtSize(a.size)}</div>
        </div>
      </div>`;
    tint(a);
    ctx.renderStatus();
  }

  /** Tints the album page with the cover's average colour, like iTunes did. */
  function tint(a) {
    const d = $('#al-detail');
    d.style.removeProperty('--al-tint');
    const img = d.querySelector('.al-hero-art img');
    if (!img) return;
    const go = () => {
      try {
        const c = document.createElement('canvas');
        c.width = 12; c.height = 12;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0, 12, 12);
        const px = g.getImageData(0, 0, 12, 12).data;
        let r = 0; let gg = 0; let b = 0;
        for (let i = 0; i < px.length; i += 4) { r += px[i]; gg += px[i + 1]; b += px[i + 2]; }
        const k = px.length / 4;
        if (openKey === a.key) d.style.setProperty('--al-tint', `rgb(${Math.round(r / k)}, ${Math.round(gg / k)}, ${Math.round(b / k)})`);
      } catch { /* cross-origin or decode problem: no tint */ }
    };
    if (img.complete && img.naturalWidth) go(); else img.addEventListener('load', go, { once: true });
  }

  function updatePlaying() {
    if (!openKey || $('#al-detail').hidden) return;
    const a = byKey.get(openKey);
    if (a) { const rows = $('#al-detail .al-rows'); if (rows) rows.innerHTML = trackRows(a); }
  }

  function open(key) {
    const a = byKey.get(key);
    if (!a) return;
    selectedTrack = null;
    renderDetail(a);
    $('#albums-view').scrollTop = 0;
  }

  function openForTrack(trackId) {
    const a = albumOf(trackId);
    if (!a) return;
    ctx.setView('albums');
    selectedTrack = trackId;
    renderDetail(a);
    const row = $(`#al-detail .al-row[data-i="${a.ids.indexOf(trackId)}"]`);
    if (row) row.scrollIntoView({ block: 'center' });
  }

  function back() {
    openKey = null;
    render();
  }

  function albumFromCard(el) {
    const c = el.closest('.al-card');
    if (!c) return null;
    const list = c.dataset.list === 'recent' ? recent : shown;
    return list[parseInt(c.dataset.i, 10)] || null;
  }

  // ---------------------------------------------------------------- events

  function setup() {
    const view = $('#albums-view');
    view.addEventListener('click', (e) => {
      if (e.target.closest('.al-play')) { const a = albumFromCard(e.target); if (a) ctx.playQueue(a.ids, 0); return; }
      if (e.target.closest('.al-open')) { const a = albumFromCard(e.target); if (a) open(a.key); return; }
      if (e.target.closest('.al-back')) { back(); return; }
      if (e.target.closest('#al-recent-more')) { recentExpanded = !recentExpanded; render(); return; }
      const act = e.target.closest('[data-act]');
      if (act && openKey) {
        const a = byKey.get(openKey);
        if (act.dataset.act === 'play') ctx.playQueue(a.ids, 0);
        if (act.dataset.act === 'shuffle') ctx.playQueue(a.ids, -1, { shuffle: true });
        if (act.dataset.act === 'info') ctx.getInfo(a.ids);
        return;
      }
      const row = e.target.closest('.al-row');
      if (row && openKey) {
        const a = byKey.get(openKey);
        selectedTrack = a.ids[parseInt(row.dataset.i, 10)];
        for (const r of view.querySelectorAll('.al-row')) r.classList.toggle('selected', r === row);
        if (state.artMode === 'selected') ctx.renderArtPane(selectedTrack);
      }
    });
    view.addEventListener('dblclick', (e) => {
      const row = e.target.closest('.al-row');
      if (row && openKey) { ctx.playQueue(byKey.get(openKey).ids, parseInt(row.dataset.i, 10)); return; }
      if (e.target.closest('.al-open')) { const a = albumFromCard(e.target); if (a) ctx.playQueue(a.ids, 0); }
    });
    view.addEventListener('contextmenu', (e) => {
      const row = e.target.closest('.al-row');
      if (row && openKey) { e.preventDefault(); const id = byKey.get(openKey).ids[parseInt(row.dataset.i, 10)]; api.trackMenu([id], e.clientX, e.clientY); return; }
      const a = albumFromCard(e.target) || (e.target.closest('.al-hero-art') && byKey.get(openKey));
      if (a) { e.preventDefault(); api.albumMenu(a.ids, a.title, e.clientX, e.clientY); }
    });
    view.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && openKey && !e.target.matches('input')) { e.preventDefault(); back(); return; }
      if (!openKey || !e.target.closest('.al-rows')) return;
      const a = byKey.get(openKey);
      let i = selectedTrack ? a.ids.indexOf(selectedTrack) : -1;
      if (e.key === 'ArrowDown') i = Math.min(a.ids.length - 1, i + 1);
      else if (e.key === 'ArrowUp') i = Math.max(0, i - 1);
      else if (e.key === 'Enter') { e.preventDefault(); ctx.playQueue(a.ids, Math.max(0, i)); return; } else return;
      e.preventDefault();
      selectedTrack = a.ids[i];
      for (const r of view.querySelectorAll('.al-row')) r.classList.toggle('selected', parseInt(r.dataset.i, 10) === i);
      view.querySelector(`.al-row[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest' });
    });
    $('#al-sort').addEventListener('change', (e) => { ctx.saveSettings({ albumSort: e.target.value }); render(); });
  }

  function status() {
    if (openKey && byKey.get(openKey)) {
      const a = byKey.get(openKey);
      return `${plural(a.tracks.length, 'song', 'songs')}, ${fmtTotal(a.duration)}, ${fmtSize(a.size)}`;
    }
    const list = filtered();
    let dur = 0; let size = 0;
    for (const a of list) { dur += a.duration; size += a.size; }
    return `${plural(list.length, 'album', 'albums')}, ${fmtTotal(dur)}, ${fmtSize(size)}`;
  }

  function selectedIds() {
    if (openKey && selectedTrack) return [selectedTrack];
    if (openKey && byKey.get(openKey)) return byKey.get(openKey).ids;
    return [];
  }

  return { setup, render, invalidate, all, albumOf, open, openForTrack, updatePlaying, status, selectedIds, isDetailOpen: () => !!openKey, back };
};
