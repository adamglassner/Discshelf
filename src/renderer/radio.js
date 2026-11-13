'use strict';
/* Radio view: live stations from the Radio Browser directory. Search, country, genres, favorites, recent. */
window.DSModules = window.DSModules || {};
window.DSModules.radio = (ctx) => {
  const { $, esc, I, n, state, api, toast } = ctx;

  const GENRES = [
    ['', 'Top stations'], ['pop', 'Pop'], ['rock', 'Rock'], ['hits', 'Hits'], ['jazz', 'Jazz'], ['classical', 'Classical'],
    ['country', 'Country'], ['dance', 'Dance'], ['electronic', 'Electronic'], ['hip hop', 'Hip-Hop'], ['oldies', 'Oldies'],
    ['chillout', 'Chill'], ['80s', "'80s"], ['90s', "'90s"], ['news', 'News'], ['talk', 'Talk'], ['sports', 'Sports'],
  ];
  const PAGE = 60;

  let countries = [];
  let results = [];
  let more = false;
  let query = { name: '', tag: '', countryCode: null };
  let loading = false;
  let loaded = false;
  let error = '';

  const country = () => (query.countryCode !== null ? query.countryCode : (state.settings.radioCountry || defaultCountry()));
  function defaultCountry() {
    const m = /[-_]([A-Z]{2})\b/.exec(navigator.language || '');
    return m ? m[1] : 'US';
  }
  const countryName = (code) => (code ? (countries.find((c) => c.code === code)?.name || code) : 'the world');
  const favs = () => state.settings.radioFavorites || [];
  const isFav = (id) => favs().some((s) => s.id === id);

  // ---------------------------------------------------------------- data

  async function search({ append = false } = {}) {
    if (loading) return;
    loading = true;
    error = '';
    if (!append) { results = []; renderResults(); }
    try {
      const r = await api.radioSearch({ name: query.name, tag: query.tag, countryCode: query.name ? '' : country(), limit: PAGE, offset: append ? results.length : 0 });
      results = append ? results.concat(r.stations) : r.stations;
      more = r.more;
    } catch (err) {
      error = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    }
    loading = false;
    loaded = true;
    renderResults();
  }

  async function loadCountries() {
    try {
      countries = await api.radioCountries();
      renderCountrySelect();
    } catch { /* the station search shows the error */ }
  }

  // ---------------------------------------------------------------- rendering

  function stationRow(s, list, i) {
    const playing = state.radio && state.radio.station.id === s.id;
    const sub = s.custom
      ? ['Added by you', (s.tags || []).join(', '), s.homepage ? s.homepage.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '') : ''].filter(Boolean).join(' · ')
      : [s.state && s.country ? `${s.state}, ${s.countryCode || s.country}` : s.country, s.tags.join(', ')].filter(Boolean).join(' · ');
    const fmt = [s.codec, s.bitrate ? `${s.bitrate} kbps` : ''].filter(Boolean).join(' ');
    return `<div class="rd-row${playing ? ' playing' : ''}" data-list="${list}" data-i="${i}" role="button" tabindex="0" aria-label="Play ${esc(s.name)}">
      <span class="rd-logo">${s.favicon ? `<img src="${esc(s.favicon)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : I.radio}</span>
      <span class="rd-text"><span class="rd-name">${playing ? `<span class="rd-live">${I.speaker}</span>` : ''}${esc(s.name)}</span><span class="rd-sub">${esc(sub)}</span></span>
      <span class="rd-fmt">${esc(fmt)}</span>
      ${s.custom ? `<button type="button" class="ibtn rd-edit" data-edit="${list}:${i}" aria-label="Edit ${esc(s.name)}" title="Edit station">${I.pencil}</button>` : '<span></span>'}
      <button type="button" class="ibtn rd-fav${isFav(s.id) ? ' on' : ''}" data-fav="${list}:${i}" aria-label="${isFav(s.id) ? 'Remove from favorites' : 'Add to favorites'}" aria-pressed="${isFav(s.id)}">${isFav(s.id) ? I.starFill : I.star}</button>
    </div>`;
  }

  function renderCountrySelect() {
    const sel = $('#rd-country');
    if (!sel) return;
    const cur = country();
    const opts = countries.length ? countries : [{ code: cur, name: cur }];
    sel.innerHTML = `<option value="">Whole world</option>${opts.map((c) => `<option value="${esc(c.code)}">${esc(c.name)}</option>`).join('')}`;
    sel.value = cur;
  }

  function render() {
    const page = $('#radio-view');
    if (!page.dataset.built) {
      page.dataset.built = '1';
      page.innerHTML = `
        <div class="rd-page">
          <div class="rd-head">
            <h1>Radio</h1>
            <form class="rd-search" id="rd-form">
              <label class="search rd-searchbox"><span class="search-icon">${I.search}</span><input type="search" id="rd-q" placeholder="Search stations by name" spellcheck="false"></label>
              <select id="rd-country" aria-label="Country"></select>
              <button type="button" class="btn" id="rd-add" title="Add a station that isn’t in the directory, by its web or stream address">${I.plus}<span>Add station</span></button>
            </form>
          </div>
          <div class="rd-genres" id="rd-genres" role="radiogroup" aria-label="Genre">
            ${GENRES.map(([tag, label]) => `<button type="button" role="radio" data-tag="${esc(tag)}" aria-checked="${tag === ''}">${esc(label)}</button>`).join('')}
          </div>
          <section class="rd-section" id="rd-favs-section"><h2>Favorites</h2><div id="rd-favs"></div></section>
          <section class="rd-section" id="rd-recent-section"><h2>Recently played</h2><div id="rd-recent"></div></section>
          <section class="rd-section"><h2 id="rd-title"></h2><div id="rd-results"></div></section>
          <p class="rd-credit">Stations from the free <a href="https://www.radio-browser.info/">Radio Browser</a> directory. Can’t find one? Use <b>Add station</b> with its web address.</p>
        </div>`;
      renderCountrySelect();
      loadCountries();
    }
    renderSaved();
    if (!loaded) search(); else renderResults();
  }

  function renderSaved() {
    const f = favs();
    $('#rd-favs-section').hidden = !f.length;
    $('#rd-favs').innerHTML = f.map((s, i) => stationRow(s, 'favs', i)).join('');
    const recent = (state.settings.radioRecent || []).filter((s) => !isFav(s.id)).slice(0, 5);
    $('#rd-recent-section').hidden = !recent.length || !!query.name;
    $('#rd-recent').innerHTML = recent.map((s, i) => stationRow(s, 'recent', i)).join('');
    lists.recent = recent;
  }

  const lists = { favs: [], recent: [], results: [] };

  function renderResults() {
    const box = $('#rd-results');
    if (!box) return;
    lists.favs = favs();
    lists.results = results;
    const genre = GENRES.find(([t]) => t === query.tag);
    $('#rd-title').textContent = query.name
      ? `Stations matching “${query.name}”`
      : `${query.tag ? `${genre ? genre[1] : query.tag} stations` : 'Top stations'} in ${countryName(country())}`;
    if (error) { box.innerHTML = `<div class="rd-empty">${esc(error)} <button type="button" class="linkbtn" id="rd-retry">Try again</button></div>`; return; }
    if (loading && !results.length) { box.innerHTML = '<div class="rd-empty"><span class="spinner"></span> Finding stations…</div>'; return; }
    if (!results.length) { box.innerHTML = '<div class="rd-empty">No stations found. Try another genre or country, or search by name.</div>'; return; }
    box.innerHTML = results.map((s, i) => stationRow(s, 'results', i)).join('')
      + (more ? `<div class="rd-more"><button type="button" class="btn" id="rd-more"${loading ? ' disabled' : ''}>${loading ? 'Loading…' : 'Show more stations'}</button></div>` : '');
  }

  function refreshPlaying() {
    if ($('#radio-view').hidden || !$('#radio-view').dataset.built) return;
    renderSaved();
    renderResults();
  }

  // ---------------------------------------------------------------- playing + favorites

  function stationAt(el) {
    const list = lists[el.dataset.list];
    return list ? { station: list[parseInt(el.dataset.i, 10)], list } : null;
  }

  function play(station, list) {
    ctx.playRadio(station, list);
    const recent = [station, ...(state.settings.radioRecent || []).filter((s) => s.id !== station.id)].slice(0, 20);
    ctx.saveSettings({ radioRecent: recent });
  }

  function toggleFav(station) {
    if (station.custom && isFav(station.id)) { editStation(station); return; }
    const f = favs();
    const next = isFav(station.id) ? f.filter((s) => s.id !== station.id) : [...f, station];
    ctx.saveSettings({ radioFavorites: next });
    toast(isFav(station.id) ? `Added “${station.name}” to your radio favorites.` : `Removed “${station.name}” from your radio favorites.`);
    refreshPlaying();
    ctx.renderSidebar();
  }

  // ---------------------------------------------------------------- stations added by address

  /** Add (station = null) or edit a station of your own. */
  async function editStation(station = null) {
    let found = station ? { url: station.url, name: station.name, favicon: station.favicon, homepage: station.homepage, codec: station.codec, bitrate: station.bitrate, genre: (station.tags || [])[0] || '' } : null;
    const r = await ctx.modal(`<h2>${station ? 'Edit station' : 'Add a radio station'}</h2>
      <p class="set-hint">Paste the station’s web page (like <b>i1430.com</b>) or its stream address. Discshelf finds the stream for you.</p>
      <form id="as-find" class="as-find">
        <input type="text" id="as-addr" placeholder="Web page or stream address" spellcheck="false" value="${esc(station ? (station.homepage || station.url) : '')}" data-autofocus>
        <button type="submit" class="btn" id="as-go">Find stream</button>
      </form>
      <div id="as-status" class="as-status" aria-live="polite"></div>
      <div id="as-details" ${found ? '' : 'hidden'}>
        <div class="as-preview"><span class="rd-logo" id="as-logo"></span><div class="as-fields">
          <label class="gi-field"><span>Name</span><input type="text" id="as-name" maxlength="120" spellcheck="false"></label>
          <label class="gi-field"><span>Genre</span><input type="text" id="as-genre" maxlength="60" placeholder="Optional" spellcheck="false"></label>
          <label class="gi-field"><span>Logo</span><input type="text" id="as-icon" placeholder="Image address (optional)" spellcheck="false"></label>
        </div></div>
        <div class="set-hint as-stream" id="as-stream"></div>
      </div>
      <div class="actions">${station ? '<button type="button" class="btn danger as-left" data-result="delete">Remove station</button>' : ''}
        <button type="button" class="btn" data-result="cancel">Cancel</button>
        <button type="button" class="btn primary" id="as-save" ${found ? '' : 'disabled'}>${station ? 'Save' : 'Add and play'}</button></div>`, {
      onMount(root, close) {
        const q = (s) => root.querySelector(s);
        const logo = () => { const u = q('#as-icon').value.trim(); q('#as-logo').innerHTML = /^https?:\/\//.test(u) ? `<img src="${esc(u)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : I.radio; };
        const fill = (f) => {
          q('#as-details').hidden = false;
          if (!q('#as-name').value || !station) q('#as-name').value = f.name || q('#as-name').value || '';
          if (!q('#as-genre').value) q('#as-genre').value = f.genre || '';
          if (!q('#as-icon').value) q('#as-icon').value = f.favicon || '';
          q('#as-stream').innerHTML = `Stream: ${esc(f.url)}${f.codec ? ` · ${esc(f.codec)}${f.bitrate ? ` ${f.bitrate} kbps` : ''}` : ''}`;
          q('#as-save').disabled = false;
          logo();
          if (!q('#as-name').value) q('#as-name').focus();
        };
        if (found) { q('#as-name').value = found.name || ''; q('#as-genre').value = found.genre || ''; q('#as-icon').value = found.favicon || ''; fill(found); }
        q('#as-icon').addEventListener('change', logo);
        q('#as-find').addEventListener('submit', async (e) => {
          e.preventDefault();
          const addr = q('#as-addr').value.trim();
          if (!addr) return;
          q('#as-go').disabled = true;
          q('#as-status').className = 'as-status';
          q('#as-status').innerHTML = '<span class="spinner"></span> Looking for the stream…';
          try {
            found = await api.radioResolve(addr);
            q('#as-status').innerHTML = '';
            fill(found);
          } catch (err) {
            q('#as-status').className = 'as-status error';
            q('#as-status').textContent = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
          }
          q('#as-go').disabled = false;
        });
        q('#as-save').addEventListener('click', () => {
          if (!found) return;
          const name = q('#as-name').value.trim() || found.name || 'My station';
          const genre = q('#as-genre').value.trim();
          const icon = q('#as-icon').value.trim();
          close({
            id: station ? station.id : `custom:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
            custom: true, name, url: found.url, homepage: found.homepage || '',
            favicon: /^https?:\/\//.test(icon) ? icon : '',
            country: '', countryCode: '', state: '', tags: genre ? [genre] : [],
            codec: found.codec || '', bitrate: found.bitrate || 0, votes: 0, clicks: 0,
          });
        });
      },
    });
    if (!r || r === 'cancel') return;
    if (r === 'delete') {
      ctx.saveSettings({
        radioFavorites: favs().filter((s) => s.id !== station.id),
        radioRecent: (state.settings.radioRecent || []).filter((s) => s.id !== station.id),
      });
      toast(`Removed “${station.name}”.`);
      refreshPlaying();
      ctx.renderSidebar();
      return;
    }
    const f = favs();
    const next = station ? f.map((s) => (s.id === station.id ? r : s)) : [...f, r];
    ctx.saveSettings({
      radioFavorites: next,
      radioRecent: (state.settings.radioRecent || []).map((s) => (s.id === r.id ? r : s)),
    });
    refreshPlaying();
    ctx.renderSidebar();
    if (!station) { toast(`Added “${r.name}” to your radio favorites.`); play(r, favs()); }
    else if (state.radio && state.radio.station.id === r.id && state.radio.station.url !== r.url) play(r, favs());
    else toast(`Saved “${r.name}”.`);
  }

  /** Next / previous station in the list the station was started from. */
  function step(dir) {
    const r = state.radio;
    if (!r || !r.list || r.list.length < 2) return;
    const i = r.list.findIndex((s) => s.id === r.station.id);
    const next = r.list[(i + dir + r.list.length) % r.list.length];
    play(next, r.list);
  }

  // ---------------------------------------------------------------- events

  function setup() {
    const page = $('#radio-view');
    page.addEventListener('click', (e) => {
      const fav = e.target.closest('[data-fav]');
      if (fav) {
        const [list, i] = fav.dataset.fav.split(':');
        const st = lists[list][parseInt(i, 10)];
        if (st) toggleFav(st);
        return;
      }
      const ed = e.target.closest('[data-edit]');
      if (ed) {
        const [list, i] = ed.dataset.edit.split(':');
        const st = lists[list][parseInt(i, 10)];
        if (st) editStation(st);
        return;
      }
      if (e.target.closest('#rd-add')) { editStation(); return; }
      const g = e.target.closest('[data-tag]');
      if (g) {
        query.tag = g.dataset.tag;
        query.name = '';
        $('#rd-q').value = '';
        page.querySelectorAll('[data-tag]').forEach((b) => b.setAttribute('aria-checked', String(b === g)));
        renderSaved();
        search();
        return;
      }
      if (e.target.closest('#rd-more')) { search({ append: true }); renderResults(); return; }
      if (e.target.closest('#rd-retry')) { search(); return; }
      const a = e.target.closest('a[href^="https://"]');
      if (a) { e.preventDefault(); window.open(a.href); return; }
      const row = e.target.closest('.rd-row');
      if (row) { const r = stationAt(row); if (r && r.station) play(r.station, r.list); }
    });
    page.addEventListener('keydown', (e) => {
      const row = e.target.closest('.rd-row');
      if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); const r = stationAt(row); if (r) play(r.station, r.list); }
    });
    page.addEventListener('submit', (e) => {
      e.preventDefault();
      query.name = $('#rd-q').value.trim();
      if (query.name) page.querySelectorAll('[data-tag]').forEach((b) => b.setAttribute('aria-checked', 'false'));
      renderSaved();
      search();
    });
    page.addEventListener('change', (e) => {
      if (e.target.id === 'rd-country') {
        query.countryCode = e.target.value;
        ctx.saveSettings({ radioCountry: e.target.value || '' });
        query.name = '';
        $('#rd-q').value = '';
        search();
      }
    });
    page.addEventListener('input', (e) => {
      if (e.target.id === 'rd-q' && !e.target.value && query.name) { query.name = ''; renderSaved(); search(); }
    });
    page.addEventListener('error', (e) => {
      if (e.target.tagName === 'IMG' && e.target.closest('.rd-logo')) e.target.closest('.rd-logo').innerHTML = I.radio;
    }, true);
  }

  return { setup, render, step, refreshPlaying, addStation: () => editStation(), favoritesCount: () => favs().length };
};
