'use strict';
/* Up Next: songs you've lined up with "Play Next" / "Add to Up Next". They play before the rest of
   the album, playlist or list you started from. The panel shows both and lets you reorder Up Next. */
window.DSModules = window.DSModules || {};
window.DSModules.queue = (ctx) => {
  const { $, esc, I, n, plural, fmtTime, fmtTotal, artUrl, state, toast } = ctx;
  let open = false;

  const list = () => state.upNext;
  function save() { ctx.saveSettings({ upNext: state.upNext.slice(0, 2000) }); }

  function playNext(ids) {
    const add = ids.filter((id) => state.byId.has(id));
    if (!add.length) return;
    state.upNext.unshift(...add);
    save();
    render();
    toast(add.length === 1 ? `“${state.byId.get(add[0]).title}” will play next.` : `${plural(add.length, 'song', 'songs')} will play next.`);
  }

  function add(ids) {
    const items = ids.filter((id) => state.byId.has(id));
    if (!items.length) return;
    state.upNext.push(...items);
    save();
    render();
    toast(items.length === 1 ? `Added “${state.byId.get(items[0]).title}” to Up Next.` : `Added ${plural(items.length, 'song', 'songs')} to Up Next.`);
  }

  /** The next song from Up Next (removed from the list), or null. */
  function take() {
    while (state.upNext.length) {
      const id = state.upNext.shift();
      if (state.byId.has(id)) { save(); render(); return id; }
    }
    return null;
  }

  function peek() {
    return state.upNext.find((id) => state.byId.has(id)) || null;
  }

  /** Songs that come after Up Next, from the list you started playing. */
  function thenPlaying(max = 40) {
    const out = [];
    if (!state.queue.length || state.pos < 0) return out;
    for (let p = state.pos + 1; p < state.order.length && out.length < max; p++) out.push(state.queue[state.order[p]]);
    if (state.settings.repeat === 'all') {
      for (let p = 0; p <= state.pos && out.length < max; p++) out.push(state.queue[state.order[p]]);
    }
    return out;
  }

  function row(t, i, kind) {
    const url = artUrl(t);
    return `<div class="q-row" data-kind="${kind}" data-i="${i}"${kind === 'next' ? ' draggable="true"' : ''}>
      <span class="q-art">${url ? `<img src="${esc(url)}" alt="" loading="lazy">` : I.music}</span>
      <span class="q-text"><span class="q-title">${esc(t.title)}</span><span class="q-sub">${esc([t.artist, t.album].filter(Boolean).join(' — '))}</span></span>
      <span class="q-time">${t.duration ? fmtTime(t.duration) : ''}</span>
      ${kind === 'next' ? `<button type="button" class="ibtn small q-remove" data-remove="${i}" aria-label="Remove from Up Next">${I.close}</button>` : '<span></span>'}
    </div>`;
  }

  function render() {
    const panel = $('#queue-panel');
    $('#btn-queue').setAttribute('aria-pressed', String(open));
    const count = list().length;
    $('#btn-queue').classList.toggle('has-items', count > 0);
    $('#btn-queue').title = count ? `Up Next: ${plural(count, 'song', 'songs')}` : 'Up Next';
    if (!open) { panel.hidden = true; return; }
    panel.hidden = false;
    const next = list().map((id) => state.byId.get(id)).filter(Boolean);
    const then = thenPlaying().map((id) => state.byId.get(id)).filter(Boolean);
    const dur = next.reduce((s, t) => s + (t.duration || 0), 0);
    const cur = state.current;
    panel.innerHTML = `
      <div class="q-head"><h2>Up Next</h2>
        <button type="button" class="linkbtn" id="q-clear"${next.length ? '' : ' hidden'}>Clear</button>
        <button type="button" class="ibtn small" id="q-close" aria-label="Close">${I.close}</button></div>
      ${cur ? `<div class="q-now"><div class="q-label">Now playing</div>${row(cur, 0, 'now')}</div>` : ''}
      <div class="q-label">${next.length ? `Up Next · ${plural(next.length, 'song', 'songs')}, ${fmtTotal(dur)}` : 'Up Next'}</div>
      <div class="q-list" id="q-next">${next.length ? next.map((t, i) => row(t, i, 'next')).join('')
        : '<p class="q-empty">Right-click a song, album or playlist and choose <b>Play Next</b> or <b>Add to Up Next</b>. You can also drag songs here.</p>'}</div>
      ${then.length ? `<div class="q-label">Then from ${esc(state.queueSource || 'your list')}</div><div class="q-list">${then.map((t, i) => row(t, i, 'then')).join('')}</div>` : ''}`;
  }

  function toggle(force) {
    open = force === undefined ? !open : !!force;
    render();
  }

  function setup() {
    $('#btn-queue').innerHTML = I.queue;
    $('#btn-queue').addEventListener('click', () => toggle());
    const panel = $('#queue-panel');
    let dragFrom = -1;
    panel.addEventListener('click', (e) => {
      if (e.target.closest('#q-close')) { toggle(false); return; }
      if (e.target.closest('#q-clear')) { state.upNext = []; save(); render(); return; }
      const rm = e.target.closest('[data-remove]');
      if (rm) { state.upNext.splice(parseInt(rm.dataset.remove, 10), 1); save(); render(); }
    });
    panel.addEventListener('dblclick', (e) => {
      const r = e.target.closest('.q-row');
      if (!r) return;
      const i = parseInt(r.dataset.i, 10);
      if (r.dataset.kind === 'next') {
        const [id] = state.upNext.splice(i, 1);
        save();
        ctx.playTrack(id);
      } else if (r.dataset.kind === 'then') {
        ctx.jumpInQueue(i + 1);
      }
      render();
    });
    panel.addEventListener('contextmenu', (e) => {
      const r = e.target.closest('.q-row');
      if (!r || r.dataset.kind === 'now') return;
      e.preventDefault();
      const id = r.dataset.kind === 'next' ? state.upNext[parseInt(r.dataset.i, 10)] : thenPlaying()[parseInt(r.dataset.i, 10)];
      if (id) ctx.api.trackMenu([id], e.clientX, e.clientY);
    });
    // Reorder Up Next by dragging; drop songs from the lists to add them.
    panel.addEventListener('dragstart', (e) => {
      const r = e.target.closest('.q-row[data-kind="next"]');
      if (!r) return;
      dragFrom = parseInt(r.dataset.i, 10);
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('application/x-discshelf-queue', String(dragFrom));
    });
    panel.addEventListener('dragover', (e) => {
      const types = [...e.dataTransfer.types];
      if (!types.includes('application/x-discshelf-queue') && !types.includes('application/x-discshelf-ids')) return;
      e.preventDefault();
      panel.querySelectorAll('.q-row.drop-before').forEach((x) => x.classList.remove('drop-before'));
      const r = e.target.closest('.q-row[data-kind="next"]');
      if (r) r.classList.add('drop-before');
    });
    panel.addEventListener('drop', (e) => {
      e.preventDefault();
      const r = e.target.closest('.q-row[data-kind="next"]');
      const to = r ? parseInt(r.dataset.i, 10) : state.upNext.length;
      const ids = e.dataTransfer.getData('application/x-discshelf-ids');
      if (ids) {
        const add = JSON.parse(ids).filter((id) => state.byId.has(id));
        state.upNext.splice(to, 0, ...add);
      } else if (dragFrom >= 0) {
        const [id] = state.upNext.splice(dragFrom, 1);
        state.upNext.splice(dragFrom < to ? to - 1 : to, 0, id);
      }
      dragFrom = -1;
      save();
      render();
    });
  }

  return { setup, render, toggle, playNext, add, take, peek, thenPlaying, count: () => list().length };
};
