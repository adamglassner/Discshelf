'use strict';
/* Lyrics tab in the album art pane: the playing song's lyrics; synced lyrics follow the song. */
window.DSModules = window.DSModules || {};
window.DSModules.lyrics = (ctx) => {
  const { $, esc, state, api } = ctx;
  const cache = new Map(); // track id -> Promise<result>
  let shownId = null;
  let lines = null; // synced lines [{t, text}]
  let nowIdx = -2;
  let userScrolledAt = 0;
  let raf = 0;

  const visible = () => state.artMode === 'lyrics' && state.settings.showArtPane && !$('#art-lyrics').hidden;

  function load(t) {
    if (!cache.has(t.id)) {
      const p = api.lyrics(t.id).catch((err) => ({ source: null, error: String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }));
      cache.set(t.id, p);
      if (cache.size > 200) cache.delete(cache.keys().next().value);
    }
    return cache.get(t.id);
  }

  function sourceLine(r) {
    if (r.source === 'lrclib') return 'Lyrics from <a href="https://lrclib.net">LRCLIB</a>';
    if (r.source === 'lrc') return 'Lyrics from the .lrc file next to the song';
    if (r.source === 'file') return 'Lyrics saved in the music file';
    return '';
  }

  async function show(force = false) {
    const box = $('#art-lyrics');
    const t = state.current;
    if (state.radio) { shownId = 'radio'; lines = null; box.innerHTML = '<div class="ly-empty">Lyrics aren’t available for radio.</div>'; return; }
    if (!t) { shownId = null; lines = null; box.innerHTML = '<div class="ly-empty">Play a song to see its lyrics.</div>'; return; }
    if (shownId === t.id && !force) { tick(); return; }
    shownId = t.id;
    lines = null;
    nowIdx = -2;
    box.innerHTML = `<div class="ly-head"><div class="t">${esc(t.title)}</div><div class="a">${esc(t.artist || '')}</div></div><div class="ly-empty"><span class="spinner"></span> Looking for lyrics…</div>`;
    const r = await load(t);
    if (shownId !== t.id) return; // the song changed meanwhile
    const head = `<div class="ly-head"><div class="t">${esc(t.title)}</div><div class="a">${esc(t.artist || '')}</div></div>`;
    if (!r.source) {
      const online = state.settings.lyricsOnline !== false && state.settings.onlineLookup !== false;
      box.innerHTML = `${head}<div class="ly-empty">${r.instrumental ? 'This song is an instrumental.' : r.error ? `Couldn’t look up lyrics (${esc(r.error)}).` : 'No lyrics found for this song.'}
        ${online ? '' : '<br><br>Online lyrics are turned off in Settings.'}<br><br><span class="set-hint">Discshelf reads lyrics saved in the music file or in a .lrc file with the same name next to it${online ? ', and looks them up on LRCLIB' : ''}.</span></div>`;
      return;
    }
    if (r.synced) {
      lines = r.synced;
      box.innerHTML = `${head}<div class="ly-lines synced">${lines.map((l, i) => `<p data-i="${i}" class="${l.text ? '' : 'gap'}">${esc(l.text) || '♪'}</p>`).join('')}</div><div class="ly-src">${sourceLine(r)}</div>`;
      tick();
      startLoop();
    } else {
      box.innerHTML = `${head}<div class="ly-lines plain">${esc(r.plain).replace(/\n/g, '<br>')}</div><div class="ly-src">${sourceLine(r)}</div>`;
    }
  }

  /** Highlights the line being sung and keeps it in view. */
  function tick() {
    if (!lines || !visible() || shownId !== state.current?.id) return;
    const now = ctx.audio.currentTime + 0.15;
    let lo = 0; let hi = lines.length - 1; let idx = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (lines[mid].t <= now) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
    if (idx === nowIdx) return;
    nowIdx = idx;
    const box = $('#art-lyrics');
    box.querySelectorAll('.ly-lines p.now').forEach((p) => p.classList.remove('now'));
    const el = idx >= 0 ? box.querySelector(`.ly-lines p[data-i="${idx}"]`) : null;
    if (el) {
      el.classList.add('now');
      if (Date.now() - userScrolledAt > 4000) {
        const top = el.offsetTop - box.clientHeight / 2 + el.offsetHeight / 2;
        box.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      }
    }
  }

  function loop() {
    raf = 0;
    tick();
    if (!ctx.audio.paused && lines && visible()) raf = requestAnimationFrame(loop);
  }
  const startLoop = () => { if (!raf) raf = requestAnimationFrame(loop); };

  function setup() {
    const box = $('#art-lyrics');
    box.addEventListener('wheel', () => { userScrolledAt = Date.now(); }, { passive: true });
    box.addEventListener('click', (e) => {
      const a = e.target.closest('a[href^="https://"]');
      if (a) { e.preventDefault(); api.openUrl(a.href); return; }
      const p = e.target.closest('.ly-lines.synced p[data-i]');
      if (p && lines) {
        ctx.audio.currentTime = lines[parseInt(p.dataset.i, 10)].t;
        userScrolledAt = 0;
        if (ctx.audio.paused) ctx.audio.play().catch(() => {});
      }
    });
    ctx.onDeck('play', startLoop);
    ctx.onDeck('timeupdate', () => { if (!raf) tick(); });
    ctx.onDeck('seeked', () => { nowIdx = -2; userScrolledAt = 0; tick(); });
  }

  return { setup, show: (force) => { show(force); startLoop(); }, forget: (id) => cache.delete(id) };
};
