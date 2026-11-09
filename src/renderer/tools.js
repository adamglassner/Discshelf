'use strict';
/* Library tools: Statistics, Duplicates and Missing info. */
window.DSModules = window.DSModules || {};
window.DSModules.tools = (ctx) => {
  const { $, esc, fold, I, n, plural, fmtTime, fmtTotal, fmtSize, artUrl, state, api, toast } = ctx;
  let plays = null;
  let statsYear = null;
  let fixJob = null; // {cancelled, done, total}

  const errText = (err) => String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const pct = (v, max) => (max ? Math.max(2, Math.round((v / max) * 100)) : 0);
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
  const hours = (sec) => (sec >= 3600 ? `${(sec / 3600).toFixed(sec >= 36000 ? 0 : 1)} hours` : `${Math.round(sec / 60)} minutes`);

  function barList(items, { label, value, sub, onclick }) {
    const max = Math.max(1, ...items.map(value));
    return `<ol class="st-bars">${items.map((x, i) => `<li${onclick ? ` data-go="${esc(onclick(x))}"` : ''}>
        <span class="st-rank">${i + 1}</span>
        <span class="st-bar-text"><span class="st-name">${esc(label(x))}</span>${sub ? `<span class="st-sub">${esc(sub(x))}</span>` : ''}</span>
        <span class="st-bar"><span style="width:${pct(value(x), max)}%"></span></span>
        <span class="st-val">${n(value(x))}</span></li>`).join('')}</ol>`;
  }

  // ================================================================ Statistics

  async function renderStats() {
    const view = $('#tools-view');
    if (!plays) { view.innerHTML = '<div class="tl-page"><p class="set-hint"><span class="spinner"></span> Adding up…</p></div>'; plays = await api.getPlays(); }
    const tracks = state.tracks;
    const byId = state.byId;
    const albums = ctx.albums.all();
    const artistsN = ctx.artists.count();
    const totalDur = tracks.reduce((s, t) => s + (t.duration || 0), 0);
    const totalSize = tracks.reduce((s, t) => s + (t.size || 0), 0);
    const listened = tracks.reduce((s, t) => s + (t.playCount || 0) * (t.duration || 0), 0);

    const topSongs = tracks.filter((t) => t.playCount).sort((a, b) => b.playCount - a.playCount).slice(0, 10);
    const sumBy = (keyFn, labelFn) => {
      const m = new Map();
      for (const t of tracks) {
        if (!t.playCount) continue;
        const k = keyFn(t);
        if (!k) continue;
        const e = m.get(k) || { key: k, label: labelFn(t), plays: 0, any: t };
        e.plays += t.playCount;
        m.set(k, e);
      }
      return [...m.values()].sort((a, b) => b.plays - a.plays).slice(0, 10);
    };
    const topArtists = sumBy((t) => fold(t.albumArtist || t.artist), (t) => t.albumArtist || t.artist);
    const topAlbums = sumBy((t) => (t.album ? `${fold(t.album)}|${fold(t.albumArtist || t.artist)}` : ''), (t) => `${t.album} — ${t.albumArtist || t.artist}`);

    // Listening by month (last 12 months), from the play history.
    const now = new Date();
    const months = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({ y: d.getFullYear(), m: d.getMonth(), sec: 0 });
    }
    for (const [, at, sec] of plays) {
      const d = new Date(at);
      const mo = months.find((x) => x.y === d.getFullYear() && x.m === d.getMonth());
      if (mo) mo.sec += sec || 0;
    }
    const maxMonth = Math.max(1, ...months.map((x) => x.sec));

    // Library make-up.
    const count = (fn) => { const m = new Map(); for (const t of tracks) { const k = fn(t); if (k) m.set(k, (m.get(k) || 0) + 1); } return [...m.entries()].sort((a, b) => b[1] - a[1]); };
    const formats = count((t) => t.codec || 'Other').slice(0, 6);
    const genres = count((t) => t.genre).slice(0, 8);
    const decades = count((t) => (t.year ? `${Math.floor(t.year / 10) * 10}s` : '')).sort((a, b) => a[0].localeCompare(b[0]));
    const maxDecade = Math.max(1, ...decades.map((d) => d[1]));

    const years = [...new Set(plays.map(([, at]) => new Date(at).getFullYear()))].sort((a, b) => b - a);
    if (!statsYear || !years.includes(statsYear)) statsYear = years[0] || now.getFullYear();

    view.innerHTML = `
      <div class="tl-page">
        <h1>Statistics</h1>
        <div class="st-cards">
          <div class="st-card"><span class="st-big">${n(tracks.length)}</span><span>songs</span></div>
          <div class="st-card"><span class="st-big">${n(albums.length)}</span><span>albums</span></div>
          <div class="st-card"><span class="st-big">${n(artistsN)}</span><span>artists</span></div>
          <div class="st-card"><span class="st-big">${esc(fmtTotal(totalDur))}</span><span>of music · ${esc(fmtSize(totalSize))}</span></div>
          <div class="st-card"><span class="st-big">${esc(hours(listened))}</span><span>listened in Discshelf</span></div>
        </div>

        <section class="st-section">
          <h2>Year in review</h2>
          ${years.length ? `<div class="seg st-years" role="radiogroup">${years.map((y) => `<button type="button" role="radio" data-year="${y}" aria-checked="${y === statsYear}">${y}</button>`).join('')}</div>
          ${yearInReview(statsYear)}` : '<p class="set-hint">Your year in review fills in as you listen. Discshelf keeps a listening history from version 0.5 on.</p>'}
        </section>

        <section class="st-section">
          <h2>Listening by month</h2>
          ${plays.length ? `<div class="st-months">${months.map((mo) => `<div class="st-month" title="${MONTHS[mo.m]} ${mo.y}: ${esc(hours(mo.sec))}">
              <span class="st-col"><span style="height:${mo.sec ? pct(mo.sec, maxMonth) : 0}%"></span></span><span class="st-mlabel">${MONTHS[mo.m]}</span></div>`).join('')}</div>`
          : '<p class="set-hint">Nothing yet. Play some music and come back.</p>'}
        </section>

        <section class="st-section st-grid3">
          <div><h2>Most played songs</h2>${topSongs.length ? barList(topSongs, { label: (t) => t.title, sub: (t) => t.artist, value: (t) => t.playCount, onclick: (t) => `track:${t.id}` }) : '<p class="set-hint">No plays yet.</p>'}</div>
          <div><h2>Most played artists</h2>${topArtists.length ? barList(topArtists, { label: (x) => x.label, value: (x) => x.plays, onclick: (x) => `artist:${x.any.id}` }) : '<p class="set-hint">No plays yet.</p>'}</div>
          <div><h2>Most played albums</h2>${topAlbums.length ? barList(topAlbums, { label: (x) => x.label, value: (x) => x.plays, onclick: (x) => `album:${x.any.id}` }) : '<p class="set-hint">No plays yet.</p>'}</div>
        </section>

        <section class="st-section st-grid3">
          <div><h2>Formats</h2>${barList(formats.map(([k, v]) => ({ k, v })), { label: (x) => x.k, value: (x) => x.v })}</div>
          <div><h2>Top genres</h2>${genres.length ? barList(genres.map(([k, v]) => ({ k, v })), { label: (x) => x.k, value: (x) => x.v }) : '<p class="set-hint">No genres yet.</p>'}</div>
          <div><h2>Decades</h2>${decades.length ? `<div class="st-decades">${decades.map(([k, v]) => `<div class="st-month" title="${esc(k)}: ${plural(v, 'song', 'songs')}"><span class="st-col"><span style="height:${pct(v, maxDecade)}%"></span></span><span class="st-mlabel">${esc(k.slice(2))}</span></div>`).join('')}</div>` : '<p class="set-hint">No years in your songs’ details yet.</p>'}</div>
        </section>
      </div>`;
    ctx.renderStatus();

    function yearInReview(year) {
      const inYear = plays.filter(([, at]) => new Date(at).getFullYear() === year);
      if (!inYear.length) return '<p class="set-hint">No listening history for this year.</p>';
      const sec = inYear.reduce((s, p) => s + (p[2] || 0), 0);
      const songs = new Map();
      const artists = new Map();
      const albumsY = new Map();
      const days = new Array(7).fill(0);
      const monthSec = new Array(12).fill(0);
      const dates = new Set();
      for (const [id, at, s] of inYear) {
        const t = byId.get(id);
        const d = new Date(at);
        days[d.getDay()] += 1;
        monthSec[d.getMonth()] += s || 0;
        dates.add(d.toDateString());
        if (!t) continue;
        songs.set(id, (songs.get(id) || 0) + 1);
        const ar = t.albumArtist || t.artist;
        if (ar) artists.set(ar, (artists.get(ar) || 0) + 1);
        if (t.album) albumsY.set(`${t.album} — ${ar}`, (albumsY.get(`${t.album} — ${ar}`) || 0) + 1);
      }
      // Artists first played this year.
      const before = new Set();
      for (const [id, at] of plays) if (new Date(at).getFullYear() < year) { const t = byId.get(id); if (t) before.add(t.albumArtist || t.artist); }
      const discovered = [...artists.keys()].filter((a) => !before.has(a)).length;
      // Longest run of days in a row with music.
      const sortedDays = [...dates].map((d) => new Date(d).getTime()).sort((a, b) => a - b);
      let streak = 0; let best = 0; let prev = 0;
      for (const d of sortedDays) { streak = prev && d - prev <= 86400000 * 1.5 ? streak + 1 : 1; best = Math.max(best, streak); prev = d; }
      const top = (m, k = 5) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
      const busiest = monthSec.indexOf(Math.max(...monthSec));
      const favDay = days.indexOf(Math.max(...days));
      const topSong = top(songs, 1)[0];
      return `
        <div class="st-cards">
          <div class="st-card accent"><span class="st-big">${esc(hours(sec))}</span><span>of music in ${year}</span></div>
          <div class="st-card"><span class="st-big">${n(inYear.length)}</span><span>plays · ${plural(songs.size, 'different song', 'different songs')}</span></div>
          <div class="st-card"><span class="st-big">${n(discovered)}</span><span>${discovered === 1 ? 'artist' : 'artists'} you first played this year</span></div>
          <div class="st-card"><span class="st-big">${MONTHS[busiest]}</span><span>your busiest month</span></div>
          <div class="st-card"><span class="st-big">${best}</span><span>${best === 1 ? 'day' : 'days in a row'} with music · mostly on ${DAYS[favDay]}</span></div>
        </div>
        ${topSong ? `<div class="st-hero">${artUrl(byId.get(topSong[0])) ? `<img src="${esc(artUrl(byId.get(topSong[0])))}" alt="">` : ''}
          <div><div class="st-sub">Your song of ${year}</div><div class="st-hero-title">${esc(byId.get(topSong[0]).title)}</div>
          <div class="st-sub">${esc(byId.get(topSong[0]).artist)} · ${plural(topSong[1], 'play', 'plays')}</div></div></div>` : ''}
        <div class="st-grid3">
          <div><h3>Top artists</h3>${barList(top(artists).map(([k, v]) => ({ k, v })), { label: (x) => x.k, value: (x) => x.v })}</div>
          <div><h3>Top songs</h3>${barList(top(songs).map(([k, v]) => ({ t: byId.get(k), v })), { label: (x) => x.t.title, sub: (x) => x.t.artist, value: (x) => x.v, onclick: (x) => `track:${x.t.id}` })}</div>
          <div><h3>Top albums</h3>${barList(top(albumsY).map(([k, v]) => ({ k, v })), { label: (x) => x.k, value: (x) => x.v })}</div>
        </div>`;
    }
  }

  // ================================================================ Duplicates

  const LOSSLESS = { FLAC: 3.3, ALAC: 3.2, WAV: 3, 'WAV (float)': 3 };
  function quality(t) {
    return (LOSSLESS[t.codec] || 0) * 1e6 + (t.bitrate || 0) / 1000 + (t.art ? 0.5 : 0) + (t.year ? 0.2 : 0) + (t.playCount || 0) / 1e4;
  }
  const dupeTitle = (s) => fold(s).replace(/\s*[([][^)\]]*remaster[^)\]]*[)\]]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

  function findDuplicates() {
    const groups = new Map();
    for (const t of state.tracks) {
      const k = `${fold(t.artist).replace(/[^a-z0-9]+/g, ' ').trim()}|${dupeTitle(t.title)}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(t);
    }
    const ignored = new Set(state.settings.dupesIgnored || []);
    const out = [];
    for (const [k, list] of groups) {
      if (list.length < 2) continue;
      // Same song = same name and about the same length (a live version or remix usually differs).
      list.sort((a, b) => (a.duration || 0) - (b.duration || 0));
      let cluster = [list[0]];
      const flush = () => {
        if (cluster.length > 1) {
          const key = `${k}|${Math.round(cluster[0].duration || 0)}`;
          if (!ignored.has(key)) {
            const best = cluster.slice().sort((a, b) => quality(b) - quality(a))[0];
            out.push({ key, tracks: cluster.slice(), best: best.id });
          }
        }
      };
      for (const t of list.slice(1)) {
        if (Math.abs((t.duration || 0) - (cluster[cluster.length - 1].duration || 0)) <= 4) cluster.push(t);
        else { flush(); cluster = [t]; }
      }
      flush();
    }
    return out.sort((a, b) => ctx.collator.compare(a.tracks[0].artist, b.tracks[0].artist) || ctx.collator.compare(a.tracks[0].title, b.tracks[0].title));
  }

  let dupes = [];
  function renderDupes() {
    dupes = findDuplicates();
    const extra = dupes.reduce((s, g) => s + g.tracks.length - 1, 0);
    const extraSize = dupes.reduce((s, g) => s + g.tracks.filter((t) => t.id !== g.best).reduce((a, t) => a + (t.size || 0), 0), 0);
    $('#tools-view').innerHTML = `
      <div class="tl-page">
        <h1>Duplicates</h1>
        ${dupes.length ? `
        <p class="set-hint">${plural(dupes.length, 'song is', 'songs are')} in your library more than once: ${plural(extra, 'extra copy', 'extra copies')}, ${esc(fmtSize(extraSize))}. For each song, Discshelf picks the best copy (lossless first, then the highest bitrate). Keeping one copy moves its plays, rating and playlists over to it.</p>
        <div class="dp-all">
          <label class="check"><input type="checkbox" id="dp-trash"> Also move the extra files to the Recycle Bin</label>
          <button type="button" class="btn primary" id="dp-fixall">Keep the best copy of every song</button>
        </div>
        ${dupes.map((g, gi) => `
          <section class="dp-group" data-g="${gi}">
            <div class="dp-head"><div><b>${esc(g.tracks[0].title)}</b> <span class="set-hint">— ${esc(g.tracks[0].artist || 'Unknown Artist')}</span></div>
              <div class="dp-buttons"><button type="button" class="btn" data-keep="${gi}">Keep the selected copy</button><button type="button" class="linkbtn" data-notdupe="${gi}">Not duplicates</button></div></div>
            ${g.tracks.map((t) => `
              <label class="dp-row">
                <input type="radio" name="dp-${gi}" value="${esc(t.id)}"${t.id === g.best ? ' checked' : ''}>
                <span class="dp-info"><span>${esc(ctx.formatLine(t) || t.codec)} · ${esc(fmtSize(t.size || 0))} · ${t.duration ? fmtTime(t.duration) : ''}${t.playCount ? ` · ${plural(t.playCount, 'play', 'plays')}` : ''}${t.id === g.best ? ' <span class="dp-best">Best</span>' : ''}</span>
                <span class="dp-path">${esc(t.path)}</span></span>
              </label>`).join('')}
          </section>`).join('')}`
        : '<p class="set-hint">No duplicates found. Every song is in your library once.</p>'}
      </div>`;
    ctx.renderStatus();
  }

  async function keepCopy(g, keepId, trash) {
    const remove = g.tracks.map((t) => t.id).filter((id) => id !== keepId);
    const r = await api.mergeDuplicates(keepId, remove, trash);
    return r;
  }

  // ================================================================ Missing info

  const cleanTitle = (t) => {
    let s = t.title;
    const base = t.path.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
    s = s.replace(/_/g, ' ');
    s = s.replace(/^\s*(\d{1,2}[-.]?)?\d{1,3}\s*[-._)]\s*/, '');
    if (t.artist) {
      const a = t.artist.toLowerCase();
      if (s.toLowerCase().startsWith(`${a} - `)) s = s.slice(a.length + 3);
    }
    s = s.replace(/\s{2,}/g, ' ').trim();
    return s && s !== t.title && (t.title === base || /^\d|_/.test(t.title)) ? s : null;
  };

  function missingGroups() {
    const albums = ctx.albums.all();
    const noArt = albums.filter((a) => !a.artTrack && a.title);
    const lacking = albums.filter((a) => a.title).map((a) => {
      const miss = [];
      if (a.tracks.some((t) => !t.genre)) miss.push('genre');
      if (a.tracks.some((t) => !t.year)) miss.push('year');
      if (a.tracks.some((t) => !t.trackNo)) miss.push('track numbers');
      return { a, miss };
    }).filter((x) => x.miss.length);
    const noAlbum = state.tracks.filter((t) => !t.album || !t.artist);
    const titles = state.tracks.map((t) => ({ t, clean: cleanTitle(t) })).filter((x) => x.clean);
    return { noArt, lacking, noAlbum, titles };
  }

  function renderMissing() {
    const g = missingGroups();
    const online = state.settings.onlineLookup !== false;
    const total = g.noArt.length + g.lacking.length + g.noAlbum.length + g.titles.length;
    const albumRow = (a, extra, btn) => `<div class="ms-row"><span class="ms-art">${artUrl(a.artTrack) ? `<img src="${esc(artUrl(a.artTrack))}" alt="">` : I.music}</span>
      <span class="ms-text"><b>${esc(a.title)}</b> <span class="set-hint">— ${esc(a.artist || 'Unknown Artist')}</span>${extra ? `<span class="ms-miss">${esc(extra)}</span>` : ''}</span>${btn}</div>`;
    $('#tools-view').innerHTML = `
      <div class="tl-page">
        <h1>Missing info</h1>
        <p class="set-hint">${total ? 'Songs and albums with details missing. Fixes are looked up online (iTunes and Deezer) and only fill in what’s missing.' : 'Nothing is missing. Every song has its details and artwork.'}</p>
        ${!online && total ? '<p class="set-hint">Online lookups are turned off in Settings, so only manual fixes are available.</p>' : ''}
        <p class="set-hint" id="ms-progress"></p>

        ${g.noArt.length ? `<details class="ms-cat" open><summary><b>No artwork</b> <span class="ms-count">${plural(g.noArt.length, 'album', 'albums')}</span>
          ${online ? '<button type="button" class="btn" id="ms-art-all">Find all</button>' : ''}</summary>
          ${g.noArt.slice(0, 100).map((a) => albumRow(a, '', `${online ? `<button type="button" class="btn" data-art="${esc(a.key)}">Find artwork</button>` : ''}<button type="button" class="btn" data-info="${esc(a.key)}">Get Info</button>`)).join('')}</details>` : ''}

        ${g.lacking.length ? `<details class="ms-cat" open><summary><b>No genre, year or track numbers</b> <span class="ms-count">${plural(g.lacking.length, 'album', 'albums')}</span>
          ${online ? `<button type="button" class="btn" id="ms-fix-all">${fixJob ? 'Stop' : 'Fix all'}</button>` : ''}</summary>
          ${g.lacking.slice(0, 150).map(({ a, miss }) => albumRow(a, `missing ${miss.join(', ')}`, `${online ? `<button type="button" class="btn" data-fix="${esc(a.key)}">Look up</button>` : ''}<button type="button" class="btn" data-info="${esc(a.key)}">Get Info</button>`)).join('')}</details>` : ''}

        ${g.titles.length ? `<details class="ms-cat"><summary><b>Titles that look like file names</b> <span class="ms-count">${plural(g.titles.length, 'song', 'songs')}</span>
          <button type="button" class="btn" id="ms-titles">Clean up all</button></summary>
          ${g.titles.slice(0, 200).map(({ t, clean }) => `<div class="ms-row"><span class="ms-text"><span class="ms-old">${esc(t.title)}</span> → <b>${esc(clean)}</b></span></div>`).join('')}</details>` : ''}

        ${g.noAlbum.length ? `<details class="ms-cat"><summary><b>No album or artist</b> <span class="ms-count">${plural(g.noAlbum.length, 'song', 'songs')}</span>
          <button type="button" class="btn" id="ms-noalbum">Edit in Get Info</button></summary>
          ${g.noAlbum.slice(0, 200).map((t) => `<div class="ms-row"><span class="ms-text">${esc(t.title)} <span class="set-hint">${esc(t.path)}</span></span></div>`).join('')}</details>` : ''}
      </div>`;
    ctx.renderStatus();
  }

  async function fixAll() {
    if (fixJob) { fixJob.cancelled = true; return; }
    const list = missingGroups().lacking;
    fixJob = { cancelled: false, done: 0, total: list.length, fixed: 0 };
    renderMissing();
    const prog = () => { const el = $('#ms-progress'); if (el && fixJob) el.textContent = `Looking up ${n(fixJob.done + 1)} of ${n(fixJob.total)}…`; };
    for (const { a } of list) {
      if (fixJob.cancelled) break;
      prog();
      try { const r = await api.fixAlbumInfo(a.ids); if (r.ok && r.changed) fixJob.fixed++; } catch { /* next */ }
      fixJob.done++;
      if (!fixJob.cancelled && fixJob.done < list.length) await new Promise((r) => setTimeout(r, 3000)); // be gentle with the free services
    }
    const job = fixJob;
    fixJob = null;
    await ctx.reloadLibrary();
    toast(`Filled in missing details for ${plural(job.fixed, 'album', 'albums')}${job.done - job.fixed ? `; ${n(job.done - job.fixed)} couldn’t be found online` : ''}.`);
    if (state.view === 'missing') renderMissing();
  }

  // ================================================================ events

  function setup() {
    const view = $('#tools-view');
    view.addEventListener('click', async (e) => {
      const albumBy = (key) => ctx.albums.all().find((a) => a.key === key);
      const yr = e.target.closest('[data-year]');
      if (yr) { statsYear = parseInt(yr.dataset.year, 10); renderStats(); return; }
      const go = e.target.closest('[data-go]');
      if (go) {
        const [kind, id] = go.dataset.go.split(':');
        if (kind === 'track') { ctx.setView('music'); ctx.revealTrack(id); }
        if (kind === 'artist') ctx.artists.openForTrack(id);
        if (kind === 'album') ctx.albums.openForTrack(id);
        return;
      }
      // duplicates
      const keep = e.target.closest('[data-keep]');
      if (keep) {
        const g = dupes[parseInt(keep.dataset.keep, 10)];
        const id = view.querySelector(`input[name="dp-${keep.dataset.keep}"]:checked`)?.value || g.best;
        keep.disabled = true;
        try {
          const r = await keepCopy(g, id, $('#dp-trash').checked);
          toast(`Kept one copy of “${g.tracks[0].title}”.${r.trashFailed.length ? ' Some files couldn’t be moved to the Recycle Bin.' : ''}`);
        } catch (err) { toast(errText(err), 'error'); }
        await ctx.reloadLibrary();
        return;
      }
      const notd = e.target.closest('[data-notdupe]');
      if (notd) {
        const g = dupes[parseInt(notd.dataset.notdupe, 10)];
        ctx.saveSettings({ dupesIgnored: [...(state.settings.dupesIgnored || []), g.key] });
        renderDupes();
        return;
      }
      if (e.target.closest('#dp-fixall')) {
        const trash = $('#dp-trash').checked;
        const r = await ctx.modal(`<h2>Keep the best copy of ${plural(dupes.length, 'song', 'songs')}?</h2>
          <p>The other copies are taken out of your library${trash ? ' and their files are moved to the Recycle Bin' : ' (their files stay where they are)'}. Plays, ratings and playlists move to the copy that’s kept.</p>
          <div class="actions"><button type="button" class="btn" data-result="cancel">Cancel</button><button type="button" class="btn primary" data-result="ok" data-autofocus>Keep best copies</button></div>`);
        if (r !== 'ok') return;
        let done = 0;
        for (const g of dupes) { try { await keepCopy(g, g.best, trash); done++; } catch { /* next */ } }
        await ctx.reloadLibrary();
        toast(`Cleaned up ${plural(done, 'song', 'songs')}.`);
        return;
      }
      // missing info
      const art = e.target.closest('[data-art]');
      if (art) {
        const a = albumBy(art.dataset.art);
        art.disabled = true;
        art.textContent = 'Looking…';
        try {
          const r = await api.findArtForAlbum(a.ids);
          toast(r.found ? `Found artwork for “${a.title}”.` : `No artwork found online for “${a.title}”. Try Get Info to search or add your own.`);
        } catch (err) { toast(errText(err), 'error'); }
        await ctx.reloadLibrary();
        return;
      }
      if (e.target.closest('#ms-art-all')) { ctx.findMissingArt(); return; }
      const fix = e.target.closest('[data-fix]');
      if (fix) {
        const a = albumBy(fix.dataset.fix);
        fix.disabled = true;
        fix.textContent = 'Looking…';
        try {
          const r = await api.fixAlbumInfo(a.ids);
          toast(r.ok ? (r.changed ? `Filled in details for ${plural(r.changed, 'song', 'songs')} on “${a.title}”.` : `“${a.title}” was found, but it had nothing to add.`) : `${r.reason}. Try Get Info to search yourself.`);
        } catch (err) { toast(errText(err), 'error'); }
        await ctx.reloadLibrary();
        return;
      }
      if (e.target.closest('#ms-fix-all')) { e.preventDefault(); fixAll(); return; }
      const info = e.target.closest('[data-info]');
      if (info) { ctx.getInfo(albumBy(info.dataset.info).ids); return; }
      if (e.target.closest('#ms-titles')) {
        e.preventDefault();
        const list = missingGroups().titles;
        const r = await api.saveEach(list.map(({ t, clean }) => ({ id: t.id, fields: { title: clean } })));
        await ctx.reloadLibrary();
        toast(`Cleaned up ${plural(list.length, 'title', 'titles')}.${r.failed && r.failed.length ? ` ${n(r.failed.length)} couldn’t be saved into the files.` : ''}`);
        return;
      }
      if (e.target.closest('#ms-noalbum')) { e.preventDefault(); ctx.getInfo(missingGroups().noAlbum.map((t) => t.id)); }
    });
  }

  function render(view) {
    if (view === 'stats') { plays = null; renderStats(); }
    if (view === 'dupes') renderDupes();
    if (view === 'missing') renderMissing();
    $('#tools-view').scrollTop = 0;
  }

  function refresh(view) {
    // After library changes: redraw without losing the scroll position.
    const top = $('#tools-view').scrollTop;
    if (view === 'stats') renderStats(); else if (view === 'dupes') renderDupes(); else if (view === 'missing') renderMissing();
    $('#tools-view').scrollTop = top;
  }

  function status(view) {
    if (view === 'dupes') return plural(dupes.length, 'song with duplicates', 'songs with duplicates');
    if (view === 'missing') { const g = missingGroups(); return `${plural(g.noArt.length + g.lacking.length, 'album', 'albums')} and ${plural(g.titles.length + g.noAlbum.length, 'song', 'songs')} to tidy up`; }
    return `${plural(state.tracks.length, 'song', 'songs')}`;
  }

  return { setup, render, refresh, status, findDuplicates, missingCount: () => { const g = missingGroups(); return g.noArt.length + g.lacking.length + g.titles.length + g.noAlbum.length; } };
};
