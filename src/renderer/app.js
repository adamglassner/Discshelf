'use strict';
/* Discshelf renderer: library views, Genre/Artist/Album filter panes, virtual track list, player. */
(() => {
  const api = window.discshelf;
  const I = window.ICONS;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  const ROW_H = 28;
  const RECENT_DAYS = 30;
  const DRAG_IDS = 'application/x-discshelf-ids'; // songs being dragged (to playlists, Up Next)

  // ---------------------------------------------------------------- state

  const state = {
    info: {},
    settings: {},
    tracks: [],
    byId: new Map(),
    folders: [],
    view: 'music', // music | recent | top | folder:<path>
    search: '',
    filter: { genre: null, artist: null, album: null },
    sortByView: {},
    rows: [], // tracks currently shown
    rowIndex: new Map(), // id -> index in rows
    selected: new Set(),
    anchor: -1, // index of last clicked row (shift-select)
    focusIndex: -1,
    artMode: 'playing',
    systemDark: false,
    // player
    current: null, // track
    queue: [],
    order: [], // queue positions in play order (shuffle-aware)
    pos: -1, // position in order
    counted: false,
    errorsInARow: 0,
    seeking: false,
    showRemaining: true,
    upNext: [], // songs lined up with Play Next / Add to Up Next
    queueSource: '', // name of the list the queue came from ("Songs", an album, a playlist)
    playlists: [],
  };

  const audio = new Audio();
  audio.preload = 'auto';
  audio.crossOrigin = 'anonymous'; // lets the equalizer (Web Audio) process the sound

  // ---------------------------------------------------------------- helpers

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const artistOf = (t) => t.artist || '';
  const sortName = (s) => fold(s).replace(/^the\s+/, '');

  function fmtTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = String(sec % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  function fmtTotal(sec) {
    if (sec >= 86400) return `${(sec / 86400).toFixed(1)} days`;
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    if (h) return `${h} hr ${m} min`;
    return `${m} min`;
  }

  function fmtSize(bytes) {
    if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(2)} TB`;
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
    return `${Math.max(0, Math.round(bytes / 1e6))} MB`;
  }

  const n = (x) => x.toLocaleString();
  const plural = (k, one, many) => `${n(k)} ${k === 1 ? one : many}`;
  const folderName = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

  function isInside(file, folder) {
    const a = file.toLowerCase().replace(/\\/g, '/');
    const b = folder.toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '') + '/';
    return a.startsWith(b);
  }

  function artUrl(t) {
    return t && t.art ? `discshelf://art/${encodeURIComponent(t.art)}` : null;
  }

  function formatLine(t) {
    const parts = [];
    if (t.codec) parts.push(t.codec);
    if (t.sampleRate) parts.push(`${(t.sampleRate / 1000).toFixed(t.sampleRate % 1000 ? 1 : 0)} kHz`);
    if (t.bitsPerSample && /FLAC|ALAC|WAV/.test(t.codec)) parts.push(`${t.bitsPerSample}-bit`);
    if (t.bitrate) parts.push(`${Math.round(t.bitrate / 1000)} kbps`);
    return parts.join(' · ');
  }

  function toast(message, kind = '') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = message;
    $('#toasts').appendChild(el);
    setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; }, kind === 'error' ? 5200 : 3800);
    setTimeout(() => el.remove(), kind === 'error' ? 5600 : 4200);
  }

  function saveSettings(patch) {
    Object.assign(state.settings, patch);
    api.setSettings(patch);
  }

  // ---------------------------------------------------------------- theme

  function applyTheme() {
    const s = state.settings;
    const dark = s.theme === 'dark' || (s.theme !== 'light' && state.systemDark);
    const style = ['classic', 'itunes'].includes(s.style) ? s.style : 'modern';
    document.documentElement.dataset.style = style;
    document.documentElement.dataset.theme = style === 'modern' ? (dark ? 'dark' : 'light') : `${style}-${dark ? 'dark' : 'light'}`;
    if (mods.colors) mods.colors.update();
    const cs = getComputedStyle(document.documentElement);
    api.setTitleBar({ color: cs.getPropertyValue('--titlebar-bg').trim(), symbolColor: cs.getPropertyValue('--titlebar-fg').trim() });
  }

  function setAppearance(patch) {
    saveSettings(patch);
    applyTheme();
  }

  // ---------------------------------------------------------------- library data

  function setLibrary(data) {
    state.folders = data.folders || [];
    state.tracks = data.tracks || [];
    state.playlists = data.playlists || [];
    state.byId = new Map();
    for (const t of state.tracks) {
      t._s = fold(`${t.title} ${t.artist} ${t.albumArtist} ${t.album} ${t.genre}`);
      state.byId.set(t.id, t);
    }
    // Keep selection/now-playing references fresh.
    for (const id of [...state.selected]) if (!state.byId.has(id)) state.selected.delete(id);
    if (state.current) {
      const fresh = state.byId.get(state.current.id);
      if (fresh) {
        const changed = ['art', 'title', 'artist', 'album'].some((k) => fresh[k] !== state.current[k]);
        state.current = fresh;
        if (changed) setTimeout(updateNowPlaying, 0); // e.g. new artwork from Get Info
      }
    }
    if (state.view.startsWith('folder:') && !state.folders.includes(state.view.slice(7))) state.view = 'music';
    if (state.view.startsWith('pl:') && !mods.playlists.get(state.view.slice(3))) { state.view = 'music'; updateMode(); }
    state.artistImages = data.artists || {};
    mods.albums.invalidate();
    mods.artists.invalidate();
    renderSidebar();
    recompute();
    $('#empty').hidden = state.tracks.length > 0;
    if (state.view === 'albums') mods.albums.render();
    if (state.view === 'artists') mods.artists.render();
    if (state.view === 'settings') mods.settings.render();
    if (isToolView(state.view)) mods.tools.refresh(state.view);
    mods.queue.render();
    updateLoveButton();
  }

  async function reloadLibrary() {
    setLibrary(await api.getLibrary());
  }

  // ---------------------------------------------------------------- sidebar

  const VIEWS = [
    { id: 'music', label: 'Songs', icon: 'music' },
    { id: 'artists', label: 'Artists', icon: 'artists' },
    { id: 'albums', label: 'Albums', icon: 'albums' },
    { id: 'recent', label: 'Recently added', icon: 'recent' },
    { id: 'top', label: 'Most played', icon: 'top' },
    { id: 'radio', label: 'Radio', icon: 'radio' },
  ];

  const TOOLS = [
    { id: 'stats', label: 'Statistics', icon: 'stats' },
    { id: 'dupes', label: 'Duplicates', icon: 'dupes' },
    { id: 'missing', label: 'Missing info', icon: 'missing' },
  ];
  const isToolView = (v) => v === 'stats' || v === 'dupes' || v === 'missing';
  let plPos = new Map(); // position of each song in the playlist being shown

  function viewTracks(view) {
    if (view.startsWith('pl:')) {
      const pl = mods.playlists.get(view.slice(3));
      if (!pl) return [];
      plPos = new Map(pl.ids.map((id, i) => [id, i]));
      return pl.ids.map((id) => state.byId.get(id)).filter(Boolean);
    }
    if (view === 'recent') {
      const since = Date.now() - RECENT_DAYS * 86400000;
      return state.tracks.filter((t) => t.added >= since);
    }
    if (view === 'top') return state.tracks.filter((t) => t.playCount > 0);
    if (view.startsWith('folder:')) {
      const f = view.slice(7);
      return state.tracks.filter((t) => isInside(t.path, f));
    }
    return state.tracks;
  }

  function renderSidebar() {
    $('#views').innerHTML = VIEWS.map((v) => {
      const count = v.id === 'albums' ? mods.albums.all().length
        : v.id === 'artists' ? mods.artists.count()
          : v.id === 'radio' ? 0
            : viewTracks(v.id).length;
      return `<button type="button" class="side-item${state.view === v.id ? ' active' : ''}" data-view="${v.id}" role="listitem">
        ${I[v.icon]}<span class="label">${esc(v.label)}</span><span class="count">${count ? n(count) : ''}</span></button>`;
    }).join('');
    $('#folder-list').innerHTML = state.folders.length
      ? state.folders.map((f) => {
        const id = `folder:${f}`;
        const count = state.tracks.filter((t) => isInside(t.path, f)).length;
        return `<button type="button" class="side-item${state.view === id ? ' active' : ''}" data-view="${esc(id)}" title="${esc(f)}" role="listitem">
          ${I.folder}<span class="label">${esc(folderName(f))}</span><span class="count">${n(count)}</span></button>`;
      }).join('')
      : '<div class="side-empty">No folders yet</div>';
    $('#tool-list').innerHTML = TOOLS.map((v) => `<button type="button" class="side-item${state.view === v.id ? ' active' : ''}" data-view="${v.id}" role="listitem">
        ${I[v.icon]}<span class="label">${esc(v.label)}</span><span class="count"></span></button>`).join('');
    mods.playlists.renderSidebar();
    $('#btn-settings').classList.toggle('active', state.view === 'settings' || state.view === 'version');
  }

  function setView(view) {
    if (state.view === view) {
      if (view === 'albums' && mods.albums.isDetailOpen()) mods.albums.back();
      return;
    }
    const wasSongs = isSongView(state.view);
    state.view = view;
    if (isSongView(view) || !wasSongs) {
      state.filter = { genre: null, artist: null, album: null };
      state.selected.clear();
      state.anchor = -1;
    }
    updateMode();
    renderSidebar();
    recompute();
    $('#tl-scroll').scrollTop = 0;
  }

  const PAGE_VIEWS = ['albums', 'artists', 'radio', 'settings', 'version', 'stats', 'dupes', 'missing'];
  const isSongView = (v) => !PAGE_VIEWS.includes(v);

  /** Shows the songs list, the albums grid, a tool or the settings page in the content area. */
  function updateMode() {
    const mode = isToolView(state.view) ? 'tools' : PAGE_VIEWS.includes(state.view) ? state.view : 'songs';
    $('#content').dataset.mode = mode;
    $('#albums-view').hidden = mode !== 'albums';
    $('#artists-view').hidden = mode !== 'artists';
    $('#radio-view').hidden = mode !== 'radio';
    $('#settings-view').hidden = mode !== 'settings';
    $('#tools-view').hidden = mode !== 'tools';
    $('#version-view').hidden = mode !== 'version';
    if (mode === 'tools') mods.tools.render(state.view);
    if (mode === 'version') { mods.version.render(); $('#version-view').scrollTop = 0; }
    if (mode === 'albums') mods.albums.render();
    if (mode === 'artists') mods.artists.render();
    if (mode === 'radio') mods.radio.render();
    if (mode === 'settings') { mods.settings.render(); $('#settings-view').scrollTop = 0; }
  }

  // ---------------------------------------------------------------- filtering + sorting

  function currentSort() {
    if (state.sortByView[state.view]) return state.sortByView[state.view];
    if (state.view === 'recent') return { key: 'added', dir: -1 };
    if (state.view === 'top') return { key: 'playCount', dir: -1 };
    if (state.view.startsWith('pl:')) return { key: 'order', dir: 1 };
    return state.settings.sort || { key: 'artist', dir: 1 };
  }

  function cmpText(a, b) {
    // Empty values sort last.
    if (!a && b) return 1;
    if (a && !b) return -1;
    return collator.compare(a, b);
  }

  const albumOrder = (a, b) => (a.discNo || 1) - (b.discNo || 1) || (a.trackNo || 0) - (b.trackNo || 0) || cmpText(a.title, b.title);
  const SORTERS = {
    title: (a, b) => cmpText(a.title, b.title) || cmpText(sortName(a.artist), sortName(b.artist)),
    artist: (a, b) => cmpText(sortName(a.albumArtist || a.artist), sortName(b.albumArtist || b.artist)) || cmpText(a.album, b.album) || albumOrder(a, b),
    album: (a, b) => cmpText(a.album, b.album) || albumOrder(a, b),
    genre: (a, b) => cmpText(a.genre, b.genre) || SORTERS.artist(a, b),
    year: (a, b) => (a.year || 9999) - (b.year || 9999) || SORTERS.artist(a, b),
    duration: (a, b) => a.duration - b.duration,
    trackNo: (a, b) => albumOrder(a, b) || SORTERS.artist(a, b),
    playCount: (a, b) => (a.playCount || 0) - (b.playCount || 0) || (a.lastPlayed || 0) - (b.lastPlayed || 0),
    added: (a, b) => (a.added || 0) - (b.added || 0) || -SORTERS.artist(a, b),
    codec: (a, b) => cmpText(a.codec, b.codec) || SORTERS.artist(a, b),
    order: (a, b) => (plPos.get(a.id) ?? 0) - (plPos.get(b.id) ?? 0),
    rating: (a, b) => (a.rating || 0) - (b.rating || 0) || -SORTERS.artist(a, b),
    loved: (a, b) => (a.loved ? 1 : 0) - (b.loved ? 1 : 0) || -SORTERS.artist(a, b),
  };

  function buildFilterList(tracks, keyFn) {
    const counts = new Map();
    for (const t of tracks) {
      const k = keyFn(t);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => {
      if (a[0] === '' && b[0] !== '') return 1;
      if (b[0] === '' && a[0] !== '') return -1;
      return collator.compare(sortName(a[0]), sortName(b[0]));
    });
  }

  let filterLists = { genre: [], artist: [], album: [] };

  function recompute({ keepScroll = true } = {}) {
    let base = viewTracks(state.view);
    if (state.search) {
      const words = fold(state.search).split(/\s+/).filter(Boolean);
      base = base.filter((t) => words.every((w) => t._s.includes(w)));
    }
    const f = state.filter;
    filterLists.genre = buildFilterList(base, (t) => t.genre || '');
    if (f.genre !== null && !filterLists.genre.some(([k]) => k === f.genre)) f.genre = null;
    const byGenre = f.genre === null ? base : base.filter((t) => (t.genre || '') === f.genre);

    filterLists.artist = buildFilterList(byGenre, artistOf);
    if (f.artist !== null && !filterLists.artist.some(([k]) => k === f.artist)) f.artist = null;
    const byArtist = f.artist === null ? byGenre : byGenre.filter((t) => artistOf(t) === f.artist);

    filterLists.album = buildFilterList(byArtist, (t) => t.album || '');
    if (f.album !== null && !filterLists.album.some(([k]) => k === f.album)) f.album = null;
    const rows = f.album === null ? byArtist : byArtist.filter((t) => (t.album || '') === f.album);

    const { key, dir } = currentSort();
    const sorter = SORTERS[key] || SORTERS.artist;
    rows.sort((a, b) => dir * sorter(a, b));
    state.rows = rows;
    state.rowIndex = new Map(rows.map((t, i) => [t.id, i]));
    renderFilters();
    renderHeader();
    if (!keepScroll) $('#tl-scroll').scrollTop = 0;
    renderRows(true);
    renderStatus();
    renderArtPane();
  }

  // ---------------------------------------------------------------- filter panes

  const FILTER_LABELS = { genre: ['Genre', 'Genres', 'Unknown Genre'], artist: ['Artist', 'Artists', 'Unknown Artist'], album: ['Album', 'Albums', 'Unknown Album'] };

  function renderFilters() {
    for (const kind of ['genre', 'artist', 'album']) {
      const list = $(`.filter-pane[data-filter="${kind}"] .filter-list`);
      const items = filterLists[kind];
      const sel = state.filter[kind];
      const [, many, unknown] = FILTER_LABELS[kind];
      let html = `<div class="filter-item all${sel === null ? ' selected' : ''}" data-i="-1" role="option" aria-selected="${sel === null}"><span class="name">All (${plural(items.length, FILTER_LABELS[kind][0].toLowerCase(), many.toLowerCase())})</span></div>`;
      html += items.map(([k, c], i) => `<div class="filter-item${k === '' ? ' unknown' : ''}${sel === k ? ' selected' : ''}" data-i="${i}" role="option" aria-selected="${sel === k}">
        <span class="name">${esc(k || unknown)}</span><span class="n">${n(c)}</span></div>`).join('');
      list.innerHTML = html;
    }
  }

  function pickFilter(kind, index) {
    const value = index < 0 ? null : filterLists[kind][index]?.[0] ?? null;
    if (state.filter[kind] === value) return;
    state.filter[kind] = value;
    // Picking a genre resets artist + album; picking an artist resets album (like Songbird).
    if (kind === 'genre') { state.filter.artist = null; state.filter.album = null; }
    if (kind === 'artist') state.filter.album = null;
    state.selected.clear();
    state.anchor = -1;
    recompute({ keepScroll: false });
    const list = $(`.filter-pane[data-filter="${kind}"] .filter-list`);
    const el = list.querySelector('.filter-item.selected');
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  function setupFilters() {
    for (const pane of $$('.filter-pane')) {
      const kind = pane.dataset.filter;
      const list = $('.filter-list', pane);
      list.addEventListener('mousedown', (e) => {
        const item = e.target.closest('.filter-item');
        if (item) pickFilter(kind, parseInt(item.dataset.i, 10));
      });
      list.addEventListener('dblclick', (e) => {
        if (e.target.closest('.filter-item')) playRows(0);
      });
      list.addEventListener('keydown', (e) => {
        const cur = state.filter[kind] === null ? -1 : filterLists[kind].findIndex(([k]) => k === state.filter[kind]);
        const max = filterLists[kind].length - 1;
        let next = null;
        if (e.key === 'ArrowDown') next = Math.min(max, cur + 1);
        else if (e.key === 'ArrowUp') next = Math.max(-1, cur - 1);
        else if (e.key === 'Home') next = -1;
        else if (e.key === 'End') next = max;
        else if (e.key === 'Enter') { e.preventDefault(); playRows(0); return; }
        if (next !== null) { e.preventDefault(); pickFilter(kind, next); }
      });
    }
  }

  // ---------------------------------------------------------------- track list

  const COLUMNS = [
    { key: 'ind', label: '', width: '30px', sort: null },
    { key: 'trackNo', label: '#', width: '44px', right: true },
    { key: 'title', label: 'Title', width: 'minmax(150px, 2.4fr)' },
    { key: 'loved', label: '', width: '28px' },
    { key: 'duration', label: 'Time', width: '62px', right: true },
    { key: 'artist', label: 'Artist', width: 'minmax(110px, 1.5fr)' },
    { key: 'album', label: 'Album', width: 'minmax(110px, 1.5fr)' },
    { key: 'genre', label: 'Genre', width: 'minmax(70px, 0.8fr)' },
    { key: 'year', label: 'Year', width: '54px', right: true },
    { key: 'rating', label: 'Rating', width: '84px' },
    { key: 'playCount', label: 'Plays', width: '54px', right: true },
    { key: 'codec', label: 'Format', width: '72px' },
  ];
  $('#tracklist').style.setProperty('--tl-cols', COLUMNS.map((c) => c.width).join(' '));

  function renderHeader() {
    const { key, dir } = currentSort();
    $('#tl-head').innerHTML = COLUMNS.map((c) => {
      const active = c.key === key;
      const ind = active ? `<span class="sort-ind">${dir > 0 ? '▲' : '▼'}</span>` : '';
      if (c.key === 'ind' && state.view.startsWith('pl:')) {
        return `<div class="col" data-key="order" role="columnheader" title="Playlist order" aria-sort="${key === 'order' ? 'ascending' : 'none'}">${key === 'order' ? '<span class="sort-ind">▲</span>' : ''}</div>`;
      }
      if (c.key === 'loved') {
        return `<div class="col love-col" data-key="loved" role="columnheader" title="Loved" aria-sort="${active ? (dir > 0 ? 'ascending' : 'descending') : 'none'}">${I.heart}</div>`;
      }
      return `<div class="col${c.right ? ' right' : ''}" data-key="${c.key}" role="columnheader" aria-sort="${active ? (dir > 0 ? 'ascending' : 'descending') : 'none'}">${c.right ? ind : ''}${esc(c.label)}${c.right ? '' : ind}</div>`;
    }).join('');
  }

  function setSort(key) {
    if (key === 'ind') return;
    const cur = currentSort();
    const dir = key === 'order' ? 1 : cur.key === key ? -cur.dir : (['playCount', 'added', 'rating', 'loved'].includes(key) ? -1 : 1);
    const sort = { key, dir };
    if (state.view === 'music' || state.view.startsWith('folder:')) saveSettings({ sort });
    state.sortByView[state.view] = sort;
    recompute();
  }

  function rowHtml(t, i) {
    const playing = state.current && state.current.id === t.id;
    const cls = `tl-row ${i % 2 ? 'odd' : 'even'}${playing ? ' playing' : ''}${state.selected.has(t.id) ? ' selected' : ''}`;
    const icon = playing ? (audio.paused ? 'pause' : 'speaker') : '';
    const track = t.trackNo ? String(t.trackNo) : '';
    return `<div class="${cls}" data-i="${i}" role="row" draggable="true" aria-selected="${state.selected.has(t.id)}">
      <div class="c ind" data-icon="${icon}">${icon ? I[icon] : ''}</div>
      <div class="c right dim">${track}</div>
      <div class="c">${esc(t.title)}</div>
      <div class="c love${t.loved ? ' on' : ''}" data-love title="${t.loved ? 'Loved (click to unlove)' : 'Love'}">${t.loved ? I.heartFill : I.heart}</div>
      <div class="c right dim">${t.duration ? fmtTime(t.duration) : ''}</div>
      <div class="c">${esc(t.artist)}</div>
      <div class="c">${esc(t.album)}</div>
      <div class="c dim">${esc(t.genre)}</div>
      <div class="c right dim">${t.year || ''}</div>
      <div class="c stars" data-rating="${t.rating || 0}">${starsHtml(t.rating || 0)}</div>
      <div class="c right dim">${t.playCount || ''}</div>
      <div class="c dim">${esc(t.codec)}</div></div>`;
  }

  const starsHtml = (r) => [1, 2, 3, 4, 5].map((k) => `<span class="star${k <= r ? ' on' : ''}" data-star="${k}">${k <= r ? I.starFill : I.star}</span>`).join('');

  let lastRange = '';
  function renderRows(force = false) {
    const scroller = $('#tl-scroll');
    const total = state.rows.length;
    $('#tl-spacer').style.height = `${total * ROW_H}px`;
    const first = Math.max(0, Math.floor(scroller.scrollTop / ROW_H) - 8);
    const visible = Math.ceil(scroller.clientHeight / ROW_H) + 16;
    const last = Math.min(total, first + visible);
    const key = `${first}-${last}-${total}`;
    if (!force && key === lastRange) return;
    lastRange = key;
    let html = '';
    for (let i = first; i < last; i++) html += rowHtml(state.rows[i], i);
    const rowsEl = $('#tl-rows');
    rowsEl.style.transform = `translateY(${first * ROW_H}px)`;
    rowsEl.innerHTML = html;

    const msg = $('#tl-message');
    if (total === 0 && state.tracks.length > 0) {
      msg.hidden = false;
      msg.textContent = state.search
        ? `No songs match “${state.search}”.`
        : state.view === 'top' ? 'Songs you play will show up here.'
          : state.view === 'recent' ? `Nothing added in the last ${RECENT_DAYS} days.`
            : state.view.startsWith('pl:') ? 'This playlist is empty. Drag songs onto it in the sidebar, or right-click songs and choose Add to Playlist.'
              : 'No songs here.';
    } else {
      msg.hidden = true;
    }
  }

  /** Updates selection / now-playing marks on the rows already on screen (keeps the same elements,
   *  so a double-click lands on the row it started on). */
  function updateRowStates() {
    for (const el of $('#tl-rows').children) {
      const i = parseInt(el.dataset.i, 10);
      const t = state.rows[i];
      if (!t) continue;
      const playing = !!state.current && state.current.id === t.id;
      el.classList.toggle('playing', playing);
      el.classList.toggle('selected', state.selected.has(t.id));
      el.setAttribute('aria-selected', String(state.selected.has(t.id)));
      const ind = el.firstElementChild;
      const want = playing ? (audio.paused ? 'pause' : 'speaker') : '';
      if (ind.dataset.icon !== want) { ind.dataset.icon = want; ind.innerHTML = want ? I[want] : ''; }
    }
  }

  function scrollToIndex(i) {
    const sc = $('#tl-scroll');
    const top = i * ROW_H;
    if (top < sc.scrollTop) sc.scrollTop = top;
    else if (top + ROW_H > sc.scrollTop + sc.clientHeight) sc.scrollTop = top + ROW_H - sc.clientHeight;
  }

  function selectIndex(i, { shift = false, ctrl = false } = {}) {
    if (i < 0 || i >= state.rows.length) return;
    const id = state.rows[i].id;
    if (shift && state.anchor >= 0) {
      if (!ctrl) state.selected.clear();
      const [a, b] = state.anchor < i ? [state.anchor, i] : [i, state.anchor];
      for (let k = a; k <= b; k++) state.selected.add(state.rows[k].id);
    } else if (ctrl) {
      if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
      state.anchor = i;
    } else {
      state.selected.clear();
      state.selected.add(id);
      state.anchor = i;
    }
    state.focusIndex = i;
    updateRowStates();
    renderStatus();
    if (state.artMode === 'selected') renderArtPane();
  }

  function selectedIds() {
    return state.rows.filter((t) => state.selected.has(t.id)).map((t) => t.id);
  }

  function setupTrackList() {
    const scroller = $('#tl-scroll');
    scroller.addEventListener('scroll', () => renderRows(false), { passive: true });
    new ResizeObserver(() => renderRows(true)).observe(scroller);

    $('#tl-head').addEventListener('click', (e) => {
      const col = e.target.closest('.col');
      if (col) setSort(col.dataset.key);
    });

    const rowsEl = $('#tl-rows');
    rowsEl.addEventListener('click', (e) => {
      const row = e.target.closest('.tl-row');
      if (!row || e.shiftKey || e.ctrlKey || e.metaKey) return;
      const t = state.rows[parseInt(row.dataset.i, 10)];
      if (!t) return;
      const star = e.target.closest('[data-star]');
      if (star) { const r = parseInt(star.dataset.star, 10); rate([t.id], t.rating === r ? 0 : r); return; }
      if (e.target.closest('[data-love]')) love([t.id], !t.loved);
    });
    // Hovering over the stars previews the rating.
    rowsEl.addEventListener('mouseover', (e) => {
      const star = e.target.closest('[data-star]');
      const cell = e.target.closest('.stars');
      for (const c of rowsEl.querySelectorAll('.stars.hover')) if (c !== cell) { c.classList.remove('hover'); c.querySelectorAll('.star').forEach((s) => s.classList.remove('pre')); }
      if (!star || !cell) return;
      cell.classList.add('hover');
      const k = parseInt(star.dataset.star, 10);
      cell.querySelectorAll('.star').forEach((s) => s.classList.toggle('pre', parseInt(s.dataset.star, 10) <= k));
    });
    rowsEl.addEventListener('mouseleave', () => { for (const c of rowsEl.querySelectorAll('.stars.hover')) { c.classList.remove('hover'); c.querySelectorAll('.star').forEach((s) => s.classList.remove('pre')); } });

    // Drag songs onto playlists or Up Next; in a playlist (in playlist order), drag to reorder.
    let dragIds = null;
    rowsEl.addEventListener('dragstart', (e) => {
      const row = e.target.closest('.tl-row');
      if (!row) return;
      const t = state.rows[parseInt(row.dataset.i, 10)];
      dragIds = state.selected.has(t.id) ? selectedIds() : [t.id];
      if (!state.selected.has(t.id)) selectIndex(parseInt(row.dataset.i, 10));
      e.dataTransfer.effectAllowed = 'copyMove';
      e.dataTransfer.setData(DRAG_IDS, JSON.stringify(dragIds));
      e.dataTransfer.setData('text/plain', dragIds.map((id) => state.byId.get(id)?.title).join('\n'));
      const ghost = document.createElement('div');
      ghost.className = 'drag-ghost';
      ghost.textContent = dragIds.length === 1 ? state.byId.get(dragIds[0]).title : `${n(dragIds.length)} songs`;
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, -10, -6);
      setTimeout(() => ghost.remove(), 0);
    });
    rowsEl.addEventListener('dragend', () => { dragIds = null; clearDropMarks(); });
    const canReorder = () => state.view.startsWith('pl:') && currentSort().key === 'order' && !state.search
      && state.filter.genre === null && state.filter.artist === null && state.filter.album === null;
    const clearDropMarks = () => rowsEl.querySelectorAll('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
    rowsEl.addEventListener('dragover', (e) => {
      if (!dragIds || !canReorder()) return;
      const row = e.target.closest('.tl-row');
      if (!row) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      clearDropMarks();
      const r = row.getBoundingClientRect();
      row.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
    });
    rowsEl.addEventListener('drop', (e) => {
      if (!dragIds || !canReorder()) return;
      const row = e.target.closest('.tl-row');
      if (!row) return;
      e.preventDefault();
      const r = row.getBoundingClientRect();
      const i = parseInt(row.dataset.i, 10) + (e.clientY < r.top + r.height / 2 ? 0 : 1);
      const before = state.rows[i];
      const pl = mods.playlists.get(state.view.slice(3));
      const to = before ? pl.ids.indexOf(before.id) : pl.ids.length;
      clearDropMarks();
      mods.playlists.reorder(pl.id, dragIds, to);
      dragIds = null;
    });

    rowsEl.addEventListener('mousedown', (e) => {
      const row = e.target.closest('.tl-row');
      if (!row) return;
      if (e.button === 0 && !e.shiftKey && !e.ctrlKey && state.selected.has(state.rows[parseInt(row.dataset.i, 10)].id) && state.selected.size > 1) return; // may be the start of a drag
      const i = parseInt(row.dataset.i, 10);
      if (e.button === 2 && state.selected.has(state.rows[i].id)) return; // keep multi-selection for the menu
      selectIndex(i, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey });
    });
    rowsEl.addEventListener('dblclick', (e) => {
      const row = e.target.closest('.tl-row');
      if (row) playRows(parseInt(row.dataset.i, 10));
    });
    rowsEl.addEventListener('contextmenu', (e) => {
      const row = e.target.closest('.tl-row');
      if (!row) return;
      e.preventDefault();
      api.trackMenu(selectedIds(), e.clientX, e.clientY, mods.playlists.idOfView(state.view));
    });
    // A click (without dragging) on one of several selected songs selects just that song.
    rowsEl.addEventListener('mouseup', (e) => {
      const row = e.target.closest('.tl-row');
      if (!row || e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey || state.selected.size < 2) return;
      if (e.target.closest('[data-star], [data-love]')) return;
      selectIndex(parseInt(row.dataset.i, 10));
    });

    $('#tracklist').addEventListener('keydown', (e) => {
      const page = Math.max(1, Math.floor(scroller.clientHeight / ROW_H) - 1);
      const cur = state.focusIndex >= 0 ? state.focusIndex : -1;
      let next = null;
      switch (e.key) {
        case 'ArrowDown': next = cur + 1; break;
        case 'ArrowUp': next = cur - 1; break;
        case 'PageDown': next = cur + page; break;
        case 'PageUp': next = cur - page; break;
        case 'Home': next = 0; break;
        case 'End': next = state.rows.length - 1; break;
        case 'Enter':
          e.preventDefault();
          if (cur >= 0) playRows(cur);
          return;
        case 'Delete':
          e.preventDefault();
          if (state.view.startsWith('pl:') && selectedIds().length) mods.playlists.removeFrom(state.view.slice(3), selectedIds());
          else confirmRemove(selectedIds());
          return;
        case 'a':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            state.rows.forEach((t) => state.selected.add(t.id));
            updateRowStates(); renderStatus();
          }
          return;
        default: return;
      }
      e.preventDefault();
      next = Math.max(0, Math.min(state.rows.length - 1, next));
      if (e.shiftKey && state.anchor < 0) state.anchor = Math.max(0, cur);
      selectIndex(next, { shift: e.shiftKey });
      scrollToIndex(next);
    });
  }

  // ---------------------------------------------------------------- status + art pane

  function renderStatus() {
    const rows = state.rows;
    if (!state.tracks.length && !['radio', 'settings', 'version'].includes(state.view)) { $('#status-text').textContent = 'Your library is empty'; return; }
    if (state.view === 'albums') { $('#status-text').textContent = mods.albums.status(); return; }
    if (state.view === 'artists') { $('#status-text').textContent = mods.artists.status(); return; }
    if (state.view === 'radio') { $('#status-text').textContent = state.radio ? `Listening to ${state.radio.station.name}` : 'Live radio from around the world'; return; }
    if (state.view === 'settings') { $('#status-text').textContent = `${plural(state.tracks.length, 'song', 'songs')} in your library`; return; }
    if (isToolView(state.view)) { $('#status-text').textContent = mods.tools.status(state.view); return; }
    if (state.view === 'version') { $('#status-text').textContent = mods.version.status(); return; }
    let dur = 0; let size = 0;
    for (const t of rows) { dur += t.duration || 0; size += t.size || 0; }
    let text = `${plural(rows.length, 'song', 'songs')}, ${fmtTotal(dur)}, ${fmtSize(size)}`;
    const sel = state.selected.size;
    if (sel > 1) text = `${n(sel)} of ${text} selected`;
    $('#status-text').textContent = text;
  }

  const placeholderArt = () => I.disc;

  function renderArtPane(selectedId) {
    if (!state.settings.showArtPane) return;
    if (state.artMode === 'playing' && state.radio) { renderRadioArt(); return; }
    let t = null;
    if (state.artMode === 'playing') t = state.current;
    else {
      const ids = selectedId ? [selectedId] : state.view === 'albums' ? mods.albums.selectedIds() : state.view === 'artists' ? mods.artists.selectedIds() : selectedIds();
      t = ids.length ? state.byId.get(ids[ids.length - 1]) : null;
    }
    const frame = $('#art-frame');
    const url = artUrl(t);
    const want = url || 'none';
    if (frame.dataset.src !== want) {
      frame.dataset.src = want;
      frame.innerHTML = url ? `<img src="${esc(url)}" alt="">` : placeholderArt();
      const img = frame.querySelector('img');
      if (img) img.onerror = () => { frame.innerHTML = placeholderArt(); };
    }
    const info = $('#art-info');
    if (!t) {
      info.innerHTML = `<div class="none">${state.artMode === 'playing' ? 'Nothing playing' : 'No song selected'}</div>`;
      return;
    }
    const rows = [];
    if (t.year) rows.push(['Year', t.year]);
    if (t.genre) rows.push(['Genre', esc(t.genre)]);
    if (t.trackNo) rows.push(['Track', t.trackOf ? `${t.trackNo} of ${t.trackOf}` : t.trackNo]);
    if (t.discNo && (t.discOf > 1 || t.discNo > 1)) rows.push(['Disc', t.discOf ? `${t.discNo} of ${t.discOf}` : t.discNo]);
    if (t.duration) rows.push(['Length', fmtTime(t.duration)]);
    if (t.rating) rows.push(['Rating', '★'.repeat(t.rating)]);
    const fl = formatLine(t);
    if (fl) rows.push(['Format', esc(fl)]);
    rows.push(['Plays', t.playCount || 0]);
    info.innerHTML = `
      <div class="t">${esc(t.title)}</div>
      <div class="a">${esc(t.artist || 'Unknown Artist')}</div>
      <div class="b">${esc(t.album || 'Unknown Album')}</div>
      <dl class="meta">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
      <div class="path">${esc(t.path)}</div>
      <div><button type="button" class="linkbtn" data-reveal="${esc(t.id)}">Show in Explorer</button></div>`;
  }

  function renderRadioArt() {
    const st = state.radio.station;
    const frame = $('#art-frame');
    const want = `radio:${st.favicon}`;
    if (frame.dataset.src !== want) {
      frame.dataset.src = want;
      frame.innerHTML = st.favicon ? `<img src="${esc(st.favicon)}" alt="" class="radio-logo" referrerpolicy="no-referrer">` : I.radio;
      const img = frame.querySelector('img');
      if (img) img.onerror = () => { frame.innerHTML = I.radio; };
    }
    const rows = [];
    if (st.country) rows.push(['Country', esc(st.state ? `${st.state}, ${st.country}` : st.country)]);
    if (st.tags.length) rows.push(['Style', esc(st.tags.join(', '))]);
    if (st.codec || st.bitrate) rows.push(['Format', esc([st.codec, st.bitrate ? `${st.bitrate} kbps` : ''].filter(Boolean).join(' · '))]);
    const r = state.radio;
    const lf = mods.settings.lastfm();
    let scrobble = '';
    if (r.song && lf.connected && state.settings.scrobble !== false) {
      scrobble = `<div class="radio-scrobble">${r.song.scrobbled ? 'Scrobbled to Last.fm' : 'Will be scrobbled to Last.fm'}</div>`;
    } else if (r.title && !r.song) {
      scrobble = '<div class="radio-scrobble muted">Not a song (won’t be scrobbled)</div>';
    }
    const history = (r.history || []).slice(1, 6);
    $('#art-info').innerHTML = `
      <div class="t">${esc(r.song ? r.song.title : (r.title || st.name))}</div>
      <div class="a">${r.song ? esc(r.song.artist) : r.title ? esc(st.name) : 'Live radio'}</div>
      ${r.song ? `<div class="b">on ${esc(st.name)}</div>` : ''}
      ${scrobble}
      <dl class="meta">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
      ${history.length ? `<div class="radio-history"><div class="rh-head">Recently heard</div>${history.map((h) => `<div class="rh-item">${esc(h.text)}</div>`).join('')}</div>` : ''}
      ${st.homepage && /^https?:/.test(st.homepage) ? `<div><a class="linkbtn" href="${esc(st.homepage)}" data-external>Station website</a></div>` : ''}`;
  }

  // ---------------------------------------------------------------- playback

  function shuffledOrder(length, first) {
    const arr = [...Array(length).keys()].filter((i) => i !== first);
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return first >= 0 ? [first, ...arr] : arr;
  }

  function buildOrder(startQueueIndex) {
    const len = state.queue.length;
    state.order = state.settings.shuffle ? shuffledOrder(len, startQueueIndex) : [...Array(len).keys()];
    state.pos = state.order.indexOf(startQueueIndex);
  }

  function viewLabel(v = state.view) {
    if (v.startsWith('pl:')) return mods.playlists.get(v.slice(3))?.name || 'the playlist';
    if (v.startsWith('folder:')) return folderName(v.slice(7));
    if (state.filter.album) return state.filter.album;
    if (state.filter.artist) return state.filter.artist;
    return (VIEWS.find((x) => x.id === v) || { label: 'your library' }).label;
  }

  /** Plays the current list starting at row i (the queue is the list as shown). */
  function playRows(i) {
    if (!state.rows.length) return;
    i = Math.max(0, Math.min(i, state.rows.length - 1));
    state.queue = state.rows.map((t) => t.id);
    setQueueSource(state.search ? `“${state.search}”` : viewLabel());
    buildOrder(i);
    state.errorsInARow = 0;
    loadAndPlay(state.byId.get(state.queue[i]));
  }

  /** Plays a list of song ids from position `start` (-1 = random start). shuffle: force a shuffled order. */
  function playQueue(ids, start = 0, { shuffle = false, source = '' } = {}) {
    state.queue = ids.filter((id) => state.byId.has(id));
    if (!state.queue.length) return;
    setQueueSource(source || sourceFor(state.queue));
    if (start < 0) start = Math.floor(Math.random() * state.queue.length);
    start = Math.min(start, state.queue.length - 1);
    state.order = shuffle || state.settings.shuffle ? shuffledOrder(state.queue.length, start) : [...Array(state.queue.length).keys()];
    state.pos = state.order.indexOf(start);
    state.errorsInARow = 0;
    loadAndPlay(state.byId.get(state.queue[start]));
  }

  function playIds(ids) {
    const list = ids.map((id) => state.byId.get(id)).filter(Boolean);
    if (!list.length) return;
    if (list.length === 1 && isSongView(state.view) && state.rowIndex.has(list[0].id)) { playRows(state.rowIndex.get(list[0].id)); return; }
    state.queue = list.map((t) => t.id);
    setQueueSource(sourceFor(state.queue));
    buildOrder(state.settings.shuffle ? Math.floor(Math.random() * list.length) : 0);
    loadAndPlay(state.byId.get(state.queue[state.order[state.pos]]));
  }

  function setQueueSource(name) {
    state.queueSource = name;
    saveSettings({ queueSource: name });
    mods.queue.render();
  }

  /** "Album — Artist" when the songs are one album, else the view they came from. */
  function sourceFor(ids) {
    const ts = ids.map((id) => state.byId.get(id)).filter(Boolean);
    if (ts.length && ts.every((t) => t.album && t.album === ts[0].album)) return ts[0].album;
    if (ts.length && ts.every((t) => (t.albumArtist || t.artist) === (ts[0].albumArtist || ts[0].artist))) return ts[0].albumArtist || ts[0].artist || 'your songs';
    return isSongView(state.view) ? viewLabel() : 'your songs';
  }

  /** The song that will play next (Up Next first), or null. */
  function peekNext() {
    const up = mods.queue.peek();
    if (up) return state.byId.get(up);
    if (!state.queue.length) return null;
    const pos = state.pos + 1;
    if (pos < state.order.length) return state.byId.get(state.queue[state.order[pos]]);
    return state.settings.repeat === 'all' ? state.byId.get(state.queue[state.order[0]]) : null;
  }

  /** For the sleep timer: is the song that's playing the last one of its album? */
  function isLastOfAlbum() {
    const t = state.current;
    if (!t) return true;
    const nx = peekNext();
    return !nx || !t.album || nx.album !== t.album || (nx.albumArtist || nx.artist) !== (t.albumArtist || t.artist);
  }

  /** Plays one song now without changing the list it's part of (used by Up Next). */
  function playTrack(id) {
    const t = state.byId.get(id);
    if (!t) return;
    state.errorsInARow = 0;
    if (!state.queue.length) { state.queue = [id]; state.order = [0]; state.pos = 0; setQueueSource(t.album || 'Up Next'); }
    loadAndPlay(t);
  }

  /** Skips forward (or back) `offset` songs in the list that's playing. */
  function jumpInQueue(offset) {
    if (!state.queue.length) return;
    let pos = state.pos + offset;
    if (pos >= state.order.length) pos %= state.order.length;
    state.pos = Math.max(0, pos);
    loadAndPlay(state.byId.get(state.queue[state.order[state.pos]]));
  }

  /** Plays a live station. `list` is where next / previous move to. */
  function playRadio(station, list = []) {
    if (!station || !station.url) return;
    state.radio = { station, title: '', list, startedAt: Date.now() };
    state.current = null;
    state.play = null;
    state.queue = [];
    audio.src = `discshelf://radio/stream?u=${encodeURIComponent(station.url)}&s=${encodeURIComponent(station.id)}&t=${Date.now()}`;
    audio.play().catch(() => { /* handled by the error event */ });
    api.radioClick(station.id);
    updateNowPlaying();
    updateRowStates();
    mods.albums.updatePlaying();
    mods.artists.updatePlaying();
    mods.radio.refreshPlaying();
  }

  function leaveRadio() {
    if (!state.radio) return;
    state.radio = null;
    api.radioStop();
    mods.radio.refreshPlaying();
  }

  function loadAndPlay(t, { autoplay = true, at = 0 } = {}) {
    if (!t) return;
    leaveRadio();
    state.current = t;
    state.counted = false;
    state.play = { id: t.id, startedAt: 0, listened: 0, lastPos: at || 0, scrobbled: false };
    audio.src = `discshelf://media/${encodeURIComponent(t.id)}`;
    if (at > 0) {
      const seekOnce = () => { try { audio.currentTime = at; } catch { /* ignore */ } };
      audio.addEventListener('loadedmetadata', seekOnce, { once: true });
    }
    if (autoplay) {
      audio.play().catch(() => { /* errors are handled by the 'error' event */ });
    }
    updateNowPlaying();
    saveSettings({ lastTrackId: t.id, lastPosition: at });
    mods.queue.render();
  }

  function stop() {
    audio.pause();
    try { audio.currentTime = 0; } catch { /* ignore */ }
    updatePlayButton();
    updateRowStates();
  }

  function advance(step, { fromEnded = false } = {}) {
    if (step > 0) {
      const up = mods.queue.take();
      if (up) { state.errorsInARow = 0; loadAndPlay(state.byId.get(up)); return; }
    }
    if (!state.queue.length) { if (fromEnded) stop(); return; }
    let pos = state.pos + step;
    if (pos >= state.order.length) {
      if (state.settings.repeat !== 'all' && fromEnded) { stop(); return; }
      if (state.settings.shuffle) {
        state.order = shuffledOrder(state.queue.length, -1);
      }
      pos = 0;
    } else if (pos < 0) {
      pos = state.settings.repeat === 'all' ? state.order.length - 1 : 0;
    }
    state.pos = pos;
    loadAndPlay(state.byId.get(state.queue[state.order[pos]]));
  }

  function next() { if (state.radio) { mods.radio.step(1); return; } advance(1); }
  function prev() {
    if (state.radio) { mods.radio.step(-1); return; }
    if (audio.currentTime > 3 || state.pos <= 0 && state.settings.repeat !== 'all') {
      if (state.current) { audio.currentTime = 0; if (audio.paused) audio.play().catch(() => {}); }
      return;
    }
    advance(-1);
  }

  function playPause() {
    if (state.radio) {
      // Live radio: pausing stops the stream; playing reconnects so you hear it live, not from where it stopped.
      if (audio.paused) playRadio(state.radio.station, state.radio.list);
      else { audio.pause(); api.radioStop(); }
      return;
    }
    if (!state.current) {
      const up = mods.queue.take();
      if (up) { playTrack(up); return; }
      const ids = isSongView(state.view) ? selectedIds() : [];
      if (isSongView(state.view)) playRows(ids.length ? state.rowIndex.get(ids[0]) : 0);
      else if (state.tracks.length) { setView('music'); playRows(0); }
      return;
    }
    if (audio.paused) audio.play().catch(() => {}); else audio.pause();
  }

  function revealPlaying() {
    if (!state.current) return;
    let i = state.rowIndex.get(state.current.id);
    if (i === undefined) {
      // Not in the current view: go back to the whole library.
      state.view = 'music'; state.search = ''; $('#search').value = '';
      state.filter = { genre: null, artist: null, album: null };
      renderSidebar(); recompute();
      i = state.rowIndex.get(state.current.id);
    }
    if (i === undefined) return;
    selectIndex(i);
    const sc = $('#tl-scroll');
    sc.scrollTop = Math.max(0, i * ROW_H - sc.clientHeight / 2);
    $('#tracklist').focus();
  }

  function updatePlayButton() {
    const active = !!state.current || !!state.radio;
    const playing = !audio.paused && active;
    const b = $('#btn-play');
    b.innerHTML = playing ? (state.radio ? I.stop : I.pause) : I.play;
    b.setAttribute('aria-label', playing ? (state.radio ? 'Stop' : 'Pause') : 'Play');
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = active ? (playing ? 'playing' : 'paused') : 'none';
  }

  function updateNowPlaying() {
    const t = state.current;
    const art = $('#fp-art');
    $('#faceplate').classList.toggle('live', !!state.radio);
    if (state.radio) {
      const r = state.radio;
      const st = r.station;
      $('#fp-title').textContent = r.song ? r.song.title : (r.title || st.name);
      $('#fp-sub').textContent = r.song ? `${r.song.artist} · ${st.name}` : r.title ? st.name : ['Live radio', st.country].filter(Boolean).join(' · ');
      const want = `radio:${st.favicon}`;
      if (art.dataset.src !== want) {
        art.dataset.src = want;
        art.innerHTML = st.favicon ? `<img src="${esc(st.favicon)}" alt="" class="radio-logo" referrerpolicy="no-referrer">` : I.radio;
        const img = art.querySelector('img');
        if (img) img.onerror = () => { art.innerHTML = I.radio; };
      }
      $('#seek').disabled = true;
      $('#btn-love').hidden = true;
      mods.colors.update();
      document.title = `${r.title || st.name} · Discshelf`;
      updatePlayButton();
      updateTime();
      if (state.artMode === 'playing') renderArtPane();
      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({ title: r.title || st.name, artist: r.title ? st.name : 'Live radio', album: '', artwork: st.favicon ? [{ src: st.favicon }] : [] });
      }
      return;
    }
    delete art.dataset.src;
    if (!t) {
      $('#fp-title').textContent = 'Discshelf';
      $('#fp-sub').textContent = state.tracks.length ? 'Double-click a song to play it' : 'Add music to get started';
      art.innerHTML = I.disc;
      $('#seek').disabled = true;
      $('#btn-love').hidden = true;
      mods.colors.update();
      document.title = 'Discshelf';
      return;
    }
    $('#fp-title').textContent = t.title;
    $('#fp-sub').textContent = [t.artist || 'Unknown Artist', t.album].filter(Boolean).join(' — ');
    const url = artUrl(t);
    art.innerHTML = url ? `<img src="${esc(url)}" alt="">` : I.disc;
    const img = art.querySelector('img');
    if (img) img.onerror = () => { art.innerHTML = I.disc; };
    $('#seek').disabled = false;
    document.title = `${t.title} — ${t.artist || 'Unknown Artist'} · Discshelf`;
    updatePlayButton();
    updateTime();
    updateRowStates();
    mods.albums.updatePlaying();
    mods.artists.updatePlaying();
    if (state.artMode === 'playing') renderArtPane();
    updateLoveButton();
    mods.colors.update();

    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: t.title, artist: t.artist || '', album: t.album || '',
        artwork: url ? [{ src: url, sizes: '512x512' }] : [],
      });
    }
  }

  function updateLoveButton() {
    const b = $('#btn-love');
    const t = state.current;
    b.hidden = !t || !!state.radio;
    if (!t) return;
    b.innerHTML = t.loved ? I.heartFill : I.heart;
    b.classList.toggle('on', !!t.loved);
    b.setAttribute('aria-pressed', String(!!t.loved));
    b.title = t.loved ? 'Loved (click to unlove)' : 'Love this song';
  }

  // ---------------------------------------------------------------- ratings + loved

  function refreshTrackMarks() {
    renderRows(true);
    if (state.view === 'albums') mods.albums.render();
    if (state.view === 'artists') mods.artists.render();
    updateLoveButton();
    renderArtPane();
  }

  async function rate(ids, rating) {
    for (const id of ids) { const t = state.byId.get(id); if (t) t.rating = rating; }
    if (currentSort().key === 'rating') recompute(); else refreshTrackMarks();
    try { await api.rate(ids, rating); } catch (err) { toast(String(err.message || err), 'error'); }
  }

  async function love(ids, loved) {
    for (const id of ids) { const t = state.byId.get(id); if (t) t.loved = loved; }
    if (currentSort().key === 'loved') recompute(); else refreshTrackMarks();
    try { await api.love(ids, loved); } catch (err) { toast(String(err.message || err), 'error'); }
  }

  function setRangePct(el, pct) { el.style.setProperty('--pct', `${Math.max(0, Math.min(100, pct))}%`); }

  function updateTime() {
    if (state.radio) {
      $('#fp-elapsed').textContent = fmtTime(audio.currentTime || 0);
      $('#fp-remaining').textContent = 'LIVE';
      const seek = $('#seek');
      seek.value = 1000;
      setRangePct(seek, audio.paused ? 0 : 100);
      return;
    }
    const d = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (state.current?.duration || 0);
    const c = audio.currentTime || 0;
    $('#fp-elapsed').textContent = fmtTime(c);
    $('#fp-remaining').textContent = state.showRemaining ? `-${fmtTime(Math.max(0, d - c))}` : fmtTime(d);
    if (!state.seeking) {
      const seek = $('#seek');
      seek.value = d ? Math.round((c / d) * 1000) : 0;
      setRangePct(seek, d ? (c / d) * 100 : 0);
    }
  }

  function countPlay() {
    if (state.counted || !state.current) return;
    state.counted = true;
    const t = state.current;
    api.markPlayed(t.id, 0).then((r) => { // 0 = count the whole song as listening time
      if (!r) return;
      t.playCount = r.playCount;
      t.lastPlayed = r.lastPlayed;
      renderRows(true);
      if (state.artMode === 'playing') renderArtPane();
    });
  }

  /**
   * A station's "Artist - Title" metadata → {artist, title}, or null for station IDs, ads and the like.
   */
  function parseRadioSong(text, station) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t || /https?:|www\.|\.com\b/i.test(t)) return null;
    if (/\b(advert|advertisement|commercial|jingle|station id|sponsor|promo)\b/i.test(t)) return null;
    const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(t);
    if (!m) return null;
    const artist = m[1].trim();
    const title = m[2].replace(/\s*\[[^\]]*\]\s*$/, '').trim();
    const name = (station.name || '').toLowerCase();
    if (!artist || !title || artist.length > 200 || title.length > 200) return null;
    if (name && (artist.toLowerCase() === name || title.toLowerCase() === name)) return null;
    if (/^(unknown|various|n\/a|-+)$/i.test(artist) || /^(unknown|untitled|n\/a)$/i.test(title)) return null;
    return { artist, title };
  }

  /** A new song started on the radio: remember it, send "Now playing" and get its length for scrobbling. */
  function onRadioSong(text) {
    const r = state.radio;
    r.history = r.history || [];
    if (text && (!r.history[0] || r.history[0].text !== text)) r.history.unshift({ text, at: Date.now() });
    r.history = r.history.slice(0, 8);
    const song = parseRadioSong(text, r.station);
    r.song = song ? { ...song, startedAt: Date.now(), listened: 0, lastPos: audio.currentTime || 0, scrobbled: false, duration: 0 } : null;
    if (song && state.settings.scrobble !== false && !audio.paused) {
      const cur = r.song;
      api.lastfmRadioNowPlaying(song).then((d) => { cur.duration = d || 0; }).catch(() => {});
    }
  }

  /** Radio: counts how long the current song has been heard, and scrobbles it like a library song
   *  (half its length or 4 minutes; 2 minutes when Last.fm doesn't know how long it is). */
  function trackRadioListening() {
    const song = state.radio && state.radio.song;
    if (!song || audio.paused) return;
    const pos = audio.currentTime;
    const d = pos - song.lastPos;
    if (d > 0 && d < 1.5) song.listened += d;
    song.lastPos = pos;
    if (song.scrobbled || state.settings.scrobble === false) return;
    if (song.duration && song.duration <= 30) return;
    const need = song.duration ? Math.min(song.duration / 2, 240) : 120;
    if (song.listened >= need) {
      song.scrobbled = true;
      api.lastfmRadioScrobble({ artist: song.artist, title: song.title }, song.startedAt);
      if (state.artMode === 'playing') renderArtPane();
    }
  }

  /** Adds up how long the current song has actually been heard (not skipped over) and scrobbles it
   *  to Last.fm once that passes half the song or 4 minutes. */
  function trackListening() {
    if (state.radio) { trackRadioListening(); return; }
    const p = state.play;
    if (!p || audio.paused || !state.current || p.id !== state.current.id) return;
    const pos = audio.currentTime;
    const d = pos - p.lastPos;
    if (d > 0 && d < 1.5) p.listened += d;
    p.lastPos = pos;
    const dur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : state.current.duration;
    if (!p.scrobbled && p.startedAt && dur > 30 && p.listened >= Math.min(dur / 2, 240)) {
      p.scrobbled = true;
      api.lastfmScrobble(p.id, p.startedAt);
    }
  }

  let lastPositionSave = 0;
  function setupAudio() {
    audio.addEventListener('play', () => { updatePlayButton(); updateRowStates(); mods.albums.updatePlaying(); mods.artists.updatePlaying(); });
    audio.addEventListener('pause', () => { updatePlayButton(); updateRowStates(); mods.albums.updatePlaying(); mods.artists.updatePlaying(); if (state.radio) return; saveSettings({ lastPosition: audio.currentTime || 0 }); });
    audio.addEventListener('playing', () => {
      state.errorsInARow = 0;
      const p = state.play;
      if (p && !p.startedAt && state.current && p.id === state.current.id) {
        p.startedAt = Date.now();
        api.lastfmNowPlaying(p.id);
      }
    });
    audio.addEventListener('timeupdate', () => {
      updateTime();
      trackListening();
      const d = audio.duration;
      if (!state.counted && Number.isFinite(d) && d > 0 && audio.currentTime >= Math.min(d * 0.5, 240)) countPlay();
      const now = Date.now();
      if (now - lastPositionSave > 5000 && !audio.paused) { lastPositionSave = now; saveSettings({ lastPosition: audio.currentTime }); }
    });
    audio.addEventListener('durationchange', updateTime);
    audio.addEventListener('ended', () => {
      if (state.radio) { toast(`${state.radio.station.name} stopped broadcasting.`); updatePlayButton(); return; }
      countPlay();
      if (mods.sleep.onEnded()) { updatePlayButton(); updateRowStates(); return; }
      if (state.settings.repeat === 'one') {
        state.play = { id: state.current.id, startedAt: 0, listened: 0, lastPos: 0, scrobbled: false };
        audio.currentTime = 0; audio.play().catch(() => {}); state.counted = false; return;
      }
      advance(1, { fromEnded: true });
    });
    audio.addEventListener('error', () => {
      if (state.radio) {
        toast(`Couldn’t play ${state.radio.station.name}. The station may be offline; try another one.`, 'error');
        updatePlayButton();
        return;
      }
      if (!state.current || !audio.getAttribute('src')) return;
      const t = state.current;
      const why = t.codec === 'ALAC' ? 'Apple Lossless (ALAC) files can’t be played yet' : 'the file is missing or in a format Discshelf can’t play';
      toast(`Couldn’t play “${t.title}”: ${why}.`, 'error');
      state.errorsInARow++;
      if (state.errorsInARow < 5 && state.queue.length > 1) setTimeout(() => advance(1, { fromEnded: true }), 700);
      else { state.errorsInARow = 0; updatePlayButton(); }
    });

    const seek = $('#seek');
    seek.addEventListener('input', () => {
      state.seeking = true;
      setRangePct(seek, seek.value / 10);
      const d = audio.duration || state.current?.duration || 0;
      $('#fp-elapsed').textContent = fmtTime((seek.value / 1000) * d);
    });
    seek.addEventListener('change', () => {
      const d = audio.duration;
      if (Number.isFinite(d) && d > 0) audio.currentTime = (seek.value / 1000) * d;
      state.seeking = false;
      updateTime();
    });
    $('#fp-remaining').addEventListener('click', () => { state.showRemaining = !state.showRemaining; updateTime(); });

    const vol = $('#volume');
    const applyVolume = () => {
      audio.volume = state.settings.volume;
      audio.muted = !!state.settings.muted;
      vol.value = Math.round(state.settings.volume * 100);
      setRangePct(vol, state.settings.muted ? 0 : state.settings.volume * 100);
      const icon = state.settings.muted || state.settings.volume === 0 ? I.mute : state.settings.volume < 0.5 ? I.volumeLow : I.volume;
      $('#btn-mute').innerHTML = icon;
      $('#btn-mute').setAttribute('aria-label', state.settings.muted ? 'Unmute' : 'Mute');
    };
    vol.addEventListener('input', () => { state.settings.volume = vol.value / 100; state.settings.muted = false; applyVolume(); });
    vol.addEventListener('change', () => saveSettings({ volume: state.settings.volume, muted: false }));
    vol.addEventListener('wheel', (e) => {
      e.preventDefault();
      const v = Math.max(0, Math.min(1, state.settings.volume + (e.deltaY < 0 ? 0.05 : -0.05)));
      saveSettings({ volume: Math.round(v * 100) / 100, muted: false });
      applyVolume();
    }, { passive: false });
    $('#btn-mute').addEventListener('click', () => { saveSettings({ muted: !state.settings.muted }); applyVolume(); });
    state.applyVolume = applyVolume;
    applyVolume();

    $('#btn-play').addEventListener('click', playPause);
    $('#btn-next').addEventListener('click', next);
    $('#btn-prev').addEventListener('click', prev);
    $('#btn-shuffle').addEventListener('click', toggleShuffle);
    $('#btn-repeat').addEventListener('click', () => {
      const order = ['off', 'all', 'one'];
      setRepeat(order[(order.indexOf(state.settings.repeat) + 1) % order.length]);
    });
    $('#fp-title').addEventListener('click', revealPlaying);

    if ('mediaSession' in navigator) {
      const ms = navigator.mediaSession;
      ms.setActionHandler('play', () => playPause());
      ms.setActionHandler('pause', () => audio.pause());
      ms.setActionHandler('nexttrack', next);
      ms.setActionHandler('previoustrack', prev);
      try { ms.setActionHandler('seekto', (d) => { if (Number.isFinite(d.seekTime)) audio.currentTime = d.seekTime; }); } catch { /* unsupported */ }
    }
  }

  function toggleShuffle() {
    const on = !state.settings.shuffle;
    saveSettings({ shuffle: on });
    if (state.queue.length && state.pos >= 0) buildOrder(state.order[state.pos]);
    renderModes();
  }

  function setRepeat(mode) {
    saveSettings({ repeat: mode });
    renderModes();
  }

  function renderModes() {
    const sh = $('#btn-shuffle');
    sh.innerHTML = I.shuffle;
    sh.setAttribute('aria-pressed', String(!!state.settings.shuffle));
    sh.title = state.settings.shuffle ? 'Shuffle: on' : 'Shuffle: off';
    const rp = $('#btn-repeat');
    const mode = state.settings.repeat || 'off';
    rp.innerHTML = mode === 'one' ? I.repeatOne : I.repeat;
    rp.setAttribute('aria-pressed', String(mode !== 'off'));
    const label = { off: 'Repeat: off', all: 'Repeat: all', one: 'Repeat: this song' }[mode];
    rp.title = label;
    rp.setAttribute('aria-label', label);
  }

  // ---------------------------------------------------------------- dialogs

  function modal(html, { onMount, sticky = false } = {}) {
    return new Promise((resolve) => {
      const root = $('#modal-root');
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      backdrop.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
      root.appendChild(backdrop);
      const close = (value) => { backdrop.remove(); document.removeEventListener('keydown', onKey, true); resolve(value); };
      const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } };
      document.addEventListener('keydown', onKey, true);
      if (!sticky) backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(null); });
      backdrop.addEventListener('click', (e) => {
        const b = e.target.closest('[data-result]');
        if (b) close(b.dataset.result);
      });
      if (onMount) onMount(backdrop, close);
      const focusEl = backdrop.querySelector('[data-autofocus]') || backdrop.querySelector('button');
      if (focusEl) focusEl.focus();
    });
  }

  async function confirmRemove(ids) {
    if (!ids || !ids.length) return;
    const one = ids.length === 1 ? state.byId.get(ids[0]) : null;
    const what = one ? `“${esc(one.title)}”` : `${n(ids.length)} songs`;
    const r = await modal(`<h2>Remove from library?</h2>
      <p>${what} will be removed from your Discshelf library. The files stay on your computer.</p>
      <p>Songs in a music folder come back the next time you rescan the library. To stop that, remove the folder in Manage Music Folders.</p>
      <div class="actions"><button type="button" class="btn" data-result="cancel">Cancel</button><button type="button" class="btn danger" data-result="ok" data-autofocus>Remove</button></div>`);
    if (r !== 'ok') return;
    await api.removeTracks(ids);
    state.selected.clear();
    await reloadLibrary();
  }

  async function manageFolders() {
    const render = () => (state.folders.length
      ? state.folders.map((f) => {
        const c = state.tracks.filter((t) => isInside(t.path, f)).length;
        return `<div class="folder-row"><span class="p">${esc(f)}</span><span class="n">${plural(c, 'song', 'songs')}</span><button type="button" class="btn" data-remove="${esc(f)}">Remove</button></div>`;
      }).join('')
      : '<p>No music folders yet.</p>');
    await modal(`<h2>Music folders</h2>
      <p>Discshelf looks for music in these folders. Removing a folder takes its songs out of the library but doesn't delete any files.</p>
      <div id="folder-rows">${render()}</div>
      <div class="actions"><button type="button" class="btn" id="mf-add">${I.plus} Add folder…</button><button type="button" class="btn" id="mf-rescan">Rescan</button><button type="button" class="btn primary" data-result="done" data-autofocus>Done</button></div>`, {
      onMount(el, close) {
        el.addEventListener('click', async (e) => {
          const rm = e.target.closest('[data-remove]');
          if (rm) {
            await api.removeFolder(rm.dataset.remove);
            await reloadLibrary();
            $('#folder-rows', el).innerHTML = render();
          }
          if (e.target.closest('#mf-add')) { close('add'); addFolder(); }
          if (e.target.closest('#mf-rescan')) { close('rescan'); api.rescan(); }
        });
      },
    });
  }

  function about() {
    const v = state.info.version || '';
    modal(`<svg class="about-mark" viewBox="0 0 32 32" aria-hidden="true"><circle cx="13" cy="14" r="9.5" fill="none" stroke="currentColor" stroke-width="2.2"/><circle cx="13" cy="14" r="2.6" fill="var(--accent)"/><path d="M2.5 27.5h27M26 5v22.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>
      <h2>Discshelf</h2>
      <p>Version ${esc(v)}<br>A music player for the music on your computer.</p>
      <p>© ${new Date().getFullYear()} Bytehawk Studio</p>
      <div class="actions"><button type="button" class="btn" data-result="new">What’s new</button><button type="button" class="btn primary" data-result="ok">Close</button></div>`).then((r) => { if (r === 'new') setView('version'); });
  }

  function shortcuts() {
    const rows = [
      ['Play / pause', '<kbd>Space</kbd>'], ['Next / previous song', '<kbd>Ctrl</kbd> <kbd>→</kbd> / <kbd>Ctrl</kbd> <kbd>←</kbd>'],
      ['Volume up / down', '<kbd>Ctrl</kbd> <kbd>↑</kbd> / <kbd>Ctrl</kbd> <kbd>↓</kbd>'], ['Play selected song', '<kbd>Enter</kbd>'],
      ['Search', '<kbd>Ctrl</kbd> <kbd>F</kbd>'], ['Go to the song that’s playing', '<kbd>Ctrl</kbd> <kbd>L</kbd>'],
      ['Add a folder', '<kbd>Ctrl</kbd> <kbd>O</kbd>'], ['Add files', '<kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>O</kbd>'],
      ['Rescan library', '<kbd>F5</kbd>'], ['Remove from library (or from the playlist)', '<kbd>Delete</kbd>'], ['Select all', '<kbd>Ctrl</kbd> <kbd>A</kbd>'],
      ['New playlist', '<kbd>Ctrl</kbd> <kbd>N</kbd>'], ['Show Up Next', '<kbd>Ctrl</kbd> <kbd>U</kbd>'], ['Get Info', '<kbd>Ctrl</kbd> <kbd>I</kbd>'],
    ];
    modal(`<h2>Keyboard shortcuts</h2><table>${rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('')}</table>
      <div class="actions"><button type="button" class="btn primary" data-result="ok">Close</button></div>`);
  }

  // ---------------------------------------------------------------- adding music + scanning

  async function addFolder() { await api.addFolder(); }
  async function addFiles() { await api.addFiles(); }

  let lastReload = 0;
  let lastAddedSeen = 0;
  function onScanProgress(p) {
    const box = $('#scan-status');
    if (p.scanning) {
      box.hidden = false;
      $('#scan-text').textContent = p.phase === 'finding'
        ? `Looking for music… ${plural(p.found, 'song', 'songs')} found`
        : p.phase === 'reading' ? `Adding songs… ${n(p.processed)} of ${n(p.found)}` : 'Tidying up…';
      // Show songs as they arrive, without reloading too often.
      if (p.added > lastAddedSeen && Date.now() - lastReload > 2500) {
        lastAddedSeen = p.added;
        lastReload = Date.now();
        reloadLibrary();
      }
      return;
    }
    box.hidden = true;
    lastAddedSeen = 0;
    const parts = [];
    if (p.added) parts.push(`Added ${plural(p.added, 'song', 'songs')}`);
    if (p.updated) parts.push(`updated ${n(p.updated)}`);
    if (p.removed) parts.push(`removed ${plural(p.removed, 'missing song', 'missing songs')}`);
    let msg = parts.length ? parts.join(', ') + '.' : (p.found ? 'Your library is up to date.' : 'No music found there.');
    if (p.cancelled) msg = `Stopped. ${msg}`;
    toast(msg);
    if (p.errors) toast(`${plural(p.errors, 'file', 'files')} couldn’t be read and were added with their file names only.`);
  }

  function setupDrop() {
    const overlay = $('#drop-overlay');
    let depth = 0;
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; overlay.hidden = false; });
    window.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) overlay.hidden = true; });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0; overlay.hidden = true;
      const files = e.dataTransfer?.files;
      if (files && files.length) api.addDropped(files);
    });
  }

  // ---------------------------------------------------------------- layout: splitters + panes

  function applyLayout() {
    const s = state.settings;
    const root = document.documentElement.style;
    root.setProperty('--sidebar-w', `${s.sidebarWidth}px`);
    root.setProperty('--art-w', `${s.artPaneWidth}px`);
    root.setProperty('--filter-h', `${s.filterHeight}px`);
    $('#main').classList.toggle('no-art', !s.showArtPane);
    $('#content').classList.toggle('no-filters', !s.showFilters);
    renderRows(true);
  }

  function setupSplitters() {
    for (const sp of $$('.splitter')) {
      sp.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const which = sp.dataset.split;
        const startX = e.clientX; const startY = e.clientY;
        const s = state.settings;
        const start = { sidebar: s.sidebarWidth, art: s.artPaneWidth, filters: s.filterHeight }[which];
        const move = (ev) => {
          if (which === 'sidebar') s.sidebarWidth = Math.max(160, Math.min(420, start + ev.clientX - startX));
          if (which === 'art') s.artPaneWidth = Math.max(200, Math.min(480, start - (ev.clientX - startX)));
          if (which === 'filters') s.filterHeight = Math.max(90, Math.min(window.innerHeight - 300, start + ev.clientY - startY));
          applyLayout();
        };
        const up = () => {
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
          saveSettings({ sidebarWidth: s.sidebarWidth, artPaneWidth: s.artPaneWidth, filterHeight: s.filterHeight });
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      });
    }
  }

  // ---------------------------------------------------------------- commands + keyboard

  function runCommand({ name, arg }) {
    switch (name) {
      case 'appearance': Object.assign(state.settings, arg); applyTheme(); if (state.view === 'settings') mods.settings.render(); break;
      case 'view': setView(arg); break;
      case 'settings': setView('settings'); break;
      case 'equalizer': mods.eq.open(); break;
      case 'getInfo': getInfo(arg); break;
      case 'goToAlbum': mods.albums.openForTrack(arg); break;
      case 'goToArtist': mods.artists.openForTrack(arg); break;
      case 'shuffleIds': playQueue(arg, -1, { shuffle: true }); break;
      case 'findMissingArt': findMissingArt(); break;
      case 'showFilters': saveSettings({ showFilters: arg }); applyLayout(); break;
      case 'showArtPane': saveSettings({ showArtPane: arg }); applyLayout(); renderArtPane(); break;
      case 'focusSearch': $('#search').focus(); $('#search').select(); break;
      case 'revealPlaying': revealPlaying(); break;
      case 'playPause': playPause(); break;
      case 'next': next(); break;
      case 'prev': prev(); break;
      case 'toggleShuffle': toggleShuffle(); break;
      case 'repeat': setRepeat(arg); break;
      case 'manageFolders': setView('settings'); break;
      case 'about': about(); break;
      case 'shortcuts': shortcuts(); break;
      case 'playIds': playIds(arg); break;
      case 'confirmRemove': confirmRemove(arg); break;
      case 'newPlaylist': mods.playlists.create(Array.isArray(arg) ? arg : currentSelection()); break;
      case 'addToPlaylist': mods.playlists.addTo(arg.id, arg.ids); break;
      case 'removeFromPlaylist': mods.playlists.removeFrom(arg.id, arg.ids); break;
      case 'renamePlaylist': mods.playlists.rename(arg); break;
      case 'deletePlaylist': mods.playlists.remove(arg); break;
      case 'playNext': mods.queue.playNext(arg); break;
      case 'addUpNext': mods.queue.add(arg); break;
      case 'toggleQueue': mods.queue.toggle(); break;
      case 'rate': rate(arg.ids, arg.rating); break;
      case 'love': love(arg.ids, arg.loved); break;
      case 'sleep': mods.sleep.set(arg); break;
      case 'whatsNew': setView('version'); break;
      case 'checkUpdates': setView('version'); mods.version.check(); break;
      default: break;
    }
  }

  function setupKeyboard() {
    document.addEventListener('keydown', (e) => {
      if ($('#modal-root').children.length) return;
      const inInput = e.target.matches('input[type="search"], input[type="text"]');
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === 'f') { e.preventDefault(); runCommand({ name: 'focusSearch' }); return; }
      if (ctrl && e.key.toLowerCase() === 'l') { e.preventDefault(); revealPlaying(); return; }
      if (ctrl && e.key.toLowerCase() === 'o') { e.preventDefault(); if (e.shiftKey) addFiles(); else addFolder(); return; }
      if (e.key === 'F5') { e.preventDefault(); api.rescan(); return; }
      if (ctrl && e.key === ',') { e.preventDefault(); setView('settings'); return; }
      if (ctrl && e.key.toLowerCase() === 'n') { e.preventDefault(); mods.playlists.create(currentSelection()); return; }
      if (ctrl && e.key.toLowerCase() === 'u') { e.preventDefault(); mods.queue.toggle(); return; }
      if (e.key === 'Escape' && !$('#queue-panel').hidden && !inInput) { e.preventDefault(); mods.queue.toggle(false); return; }
      if (inInput) return;
      if (ctrl && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        const ids = state.view === 'albums' ? mods.albums.selectedIds() : state.view === 'artists' ? mods.artists.selectedIds() : selectedIds();
        if (ids.length) getInfo(ids); else if (state.current) getInfo([state.current.id]);
        return;
      }
      if (ctrl && e.key === 'ArrowRight') { e.preventDefault(); next(); return; }
      if (ctrl && e.key === 'ArrowLeft') { e.preventDefault(); prev(); return; }
      if (ctrl && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        const v = Math.max(0, Math.min(1, state.settings.volume + (e.key === 'ArrowUp' ? 0.05 : -0.05)));
        saveSettings({ volume: Math.round(v * 100) / 100, muted: false });
        state.applyVolume();
        return;
      }
      if (e.key === ' ' && !e.target.matches('button, input')) { e.preventDefault(); playPause(); }
    });

    const search = $('#search');
    let t = null;
    search.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        state.search = search.value.trim();
        state.selected.clear();
        if (state.view === 'settings' || state.view === 'radio') setView('music');
        recompute({ keepScroll: false });
        if (state.view === 'albums') { if (mods.albums.isDetailOpen()) mods.albums.back(); else mods.albums.render(); }
        if (state.view === 'artists') mods.artists.render();
      }, 120);
    });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { search.value = ''; search.dispatchEvent(new Event('input')); search.blur(); }
      if (e.key === 'Enter' && isSongView(state.view)) { e.preventDefault(); clearTimeout(t); state.search = search.value.trim(); recompute({ keepScroll: false }); playRows(0); }
      if (e.key === 'ArrowDown') { e.preventDefault(); $('#tracklist').focus(); if (state.rows.length) selectIndex(0); }
    });
  }

  function setupChrome() {
    $('#search-icon').innerHTML = I.search;
    $('#btn-prev').innerHTML = I.prev;
    $('#btn-next').innerHTML = I.next;
    $('#btn-manage-folders').innerHTML = I.gear;
    $('#btn-add-music').innerHTML = `${I.plus}<span>Add music</span>`;

    for (const b of $$('.menubar [data-menu]')) {
      b.addEventListener('click', async () => {
        const r = b.getBoundingClientRect();
        b.classList.add('open');
        await api.popupMenu(b.dataset.menu, r.left, r.bottom + 2);
        b.classList.remove('open');
      });
    }

    $('#views').addEventListener('click', (e) => { const b = e.target.closest('[data-view]'); if (b) setView(b.dataset.view); });
    $('#tool-list').addEventListener('click', (e) => { const b = e.target.closest('[data-view]'); if (b) setView(b.dataset.view); });
    $('#btn-love').addEventListener('click', () => { if (state.current) love([state.current.id], !state.current.loved); });
    $('#folder-list').addEventListener('click', (e) => { const b = e.target.closest('[data-view]'); if (b) setView(b.dataset.view); });
    $('#btn-manage-folders').addEventListener('click', () => setView('settings'));
    $('#btn-settings').innerHTML = `${I.gear}<span class="label">Settings</span>`;
    $('#btn-settings').addEventListener('click', () => setView('settings'));
    $('#btn-eq').innerHTML = I.eq;
    $('#btn-eq').addEventListener('click', () => mods.eq.open());
    $('#btn-add-music').addEventListener('click', addFolder);
    $('#empty-add-folder').addEventListener('click', addFolder);
    $('#empty-add-files').addEventListener('click', addFiles);
    $('#scan-cancel').addEventListener('click', () => api.cancelScan());

    if (state.info.musicDir) {
      const b = $('#empty-add-music-dir');
      b.hidden = false;
      b.innerHTML = `${I.folder}<span>Add my Music folder</span>`;
      b.title = state.info.musicDir;
      b.addEventListener('click', () => api.addMusicDir());
    } else {
      $('#empty-add-folder').classList.add('primary');
    }

    for (const tab of $$('.art-tabs [data-artmode]')) {
      tab.addEventListener('click', () => {
        state.artMode = tab.dataset.artmode;
        for (const t of $$('.art-tabs [data-artmode]')) t.setAttribute('aria-selected', String(t === tab));
        renderArtPane();
      });
    }
    $('#art-info').addEventListener('click', (e) => {
      const ext = e.target.closest('a[data-external]');
      if (ext) { e.preventDefault(); window.open(ext.href); return; }
      const b = e.target.closest('[data-reveal]');
      if (b) api.showInFolder(b.dataset.reveal);
    });
  }

  // ---------------------------------------------------------------- modules (albums, equalizer, get info, settings)

  const mods = {};
  const ctx = {
    api, I, $, $$, esc, fold, n, plural, fmtTime, fmtTotal, fmtSize, artUrl, formatLine, toast, modal, collator, sortName,
    isInside, state, audio, saveSettings, setAppearance, setView, playQueue, reloadLibrary, renderStatus, renderArtPane,
    playRadio, renderSidebar: () => renderSidebar(), clearSearch: () => { $('#search').value = ''; state.search = ''; recompute(); },
    shortcuts, getInfo: (ids) => getInfo(ids), findMissingArt: () => findMissingArt(),
    recompute: () => recompute(), currentSelection: () => currentSelection(), playTrack, jumpInQueue, isLastOfAlbum,
    revealTrack: (id) => revealTrack(id), rate: (ids, r) => rate(ids, r), love: (ids, l) => love(ids, l), formatLine,
    onEqChange: () => { updateEqButton(); mods.settings.refreshEq(); },
  };

  function getInfo(ids) {
    if (ids && ids.length) mods.info.open(ids);
  }

  /** The songs selected in whichever view is showing. */
  function currentSelection() {
    if (state.view === 'albums') return mods.albums.selectedIds();
    if (state.view === 'artists') return mods.artists.selectedIds();
    return isSongView(state.view) ? selectedIds() : [];
  }

  /** Shows a song in the Songs list, selected. */
  function revealTrack(id) {
    if (!state.byId.has(id)) return;
    if (!state.rowIndex.has(id)) {
      state.search = ''; $('#search').value = '';
      state.filter = { genre: null, artist: null, album: null };
      recompute();
    }
    const i = state.rowIndex.get(id);
    if (i === undefined) return;
    selectIndex(i);
    const sc = $('#tl-scroll');
    sc.scrollTop = Math.max(0, i * ROW_H - sc.clientHeight / 2);
    $('#tracklist').focus();
  }

  function updateEqButton() {
    const b = $('#btn-eq');
    const on = !!(state.settings.eq && state.settings.eq.enabled);
    b.setAttribute('aria-pressed', String(on));
    b.title = `Equalizer: ${mods.eq.summary()}`;
  }

  async function findMissingArt() {
    if (!state.settings.onlineLookup) {
      toast('Online lookups are turned off. Turn them on in Settings → Song info & artwork.');
      return;
    }
    const missing = mods.albums.all().filter((a) => !a.artTrack && a.title).length;
    if (!missing) { toast('Every album already has artwork.'); return; }
    const r = await modal(`<h2>Find missing album artwork?</h2>
      <p>Discshelf will search iTunes and Deezer for ${plural(missing, 'album', 'albums')} without artwork and add any covers it finds. This takes about ${Math.max(1, Math.round((missing * 3.5) / 60))} min; you can keep listening meanwhile.</p>
      <div class="actions"><button type="button" class="btn" data-result="cancel">Cancel</button><button type="button" class="btn primary" data-result="ok" data-autofocus>Find artwork</button></div>`);
    if (r !== 'ok') return;
    api.findMissingArt().catch((err) => toast(String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error'));
    if (state.view !== 'settings') toast('Looking for album artwork… Progress is shown in Settings.');
  }

  // ---------------------------------------------------------------- start

  async function start() {
    const [info, settings, systemDark, lib] = await Promise.all([api.info(), api.getSettings(), api.systemDark(), api.getLibrary()]);
    state.info = info;
    state.settings = settings;
    state.systemDark = systemDark;
    applyTheme();
    mods.albums = window.DSModules.albums(ctx);
    mods.artists = window.DSModules.artists(ctx);
    mods.radio = window.DSModules.radio(ctx);
    mods.eq = window.DSModules.eq(ctx);
    mods.info = window.DSModules.info(ctx);
    mods.settings = window.DSModules.settings(ctx);
    mods.queue = window.DSModules.queue(ctx);
    mods.playlists = window.DSModules.playlists(ctx);
    mods.tools = window.DSModules.tools(ctx);
    mods.sleep = window.DSModules.sleep(ctx);
    mods.colors = window.DSModules.colors(ctx);
    mods.version = window.DSModules.version(ctx);
    ctx.albums = mods.albums;
    ctx.artists = mods.artists;
    ctx.eq = mods.eq;
    ctx.colors = mods.colors;
    ctx.version = mods.version;
    state.upNext = Array.isArray(settings.upNext) ? settings.upNext.slice() : [];
    state.queueSource = settings.queueSource || '';
    mods.eq.init();
    updateEqButton();
    setupChrome();
    mods.albums.setup();
    mods.artists.setup();
    mods.radio.setup();
    mods.settings.setup();
    mods.queue.setup();
    mods.playlists.setup();
    mods.tools.setup();
    mods.sleep.setup();
    mods.version.setup();
    applyTheme();
    setupFilters();
    setupTrackList();
    setupAudio();
    setupKeyboard();
    setupDrop();
    setupSplitters();
    applyLayout();
    renderModes();
    setLibrary(lib);

    // Pick up where the user left off (paused).
    const last = settings.resumeOnStart !== false && settings.lastTrackId && state.byId.get(settings.lastTrackId);
    if (last) {
      const i = state.rowIndex.get(last.id);
      state.queue = state.rows.map((t) => t.id);
      state.queueSource = 'Songs';
      if (i !== undefined) buildOrder(i); else { state.queue = [last.id]; buildOrder(0); }
      loadAndPlay(last, { autoplay: false, at: settings.lastPosition || 0 });
    } else {
      updateNowPlaying();
    }
    updatePlayButton();

    api.onCommand(runCommand);
    api.onScanProgress(onScanProgress);
    api.onLibraryChanged((c) => { if (!(c && c.quiet)) reloadLibrary(); });
    api.onToast((m) => (typeof m === 'string' ? toast(m) : toast(m.text, m.error ? 'error' : '')));
    api.onSystemTheme((dark) => { state.systemDark = dark; applyTheme(); });
    api.onRadioTitle(({ id, title }) => {
      if (!state.radio || state.radio.station.id !== id || title === null) return;
      state.radio.title = title;
      onRadioSong(title);
      updateNowPlaying();
    });
    api.onRadioError(({ id, message }) => {
      if (state.radio && state.radio.station.id === id) toast(`${state.radio.station.name}: ${message}`, 'error');
    });
    updateMode();
    if (mods.version.onStart()) setView('version');
    window.__discshelfReady = true;
    window.__discshelfTest = { level: () => mods.eq.level(), state, mods, runCommand };
  }

  start().catch((err) => {
    console.error(err);
    document.body.insertAdjacentHTML('beforeend', `<div class="toast error" style="position:fixed;left:16px;bottom:40px">Discshelf couldn’t start: ${esc(err.message)}</div>`);
  });
})();
