'use strict';
/* Playlists: the sidebar section, creating / renaming / deleting, dragging songs in, and .m3u files. */
window.DSModules = window.DSModules || {};
window.DSModules.playlists = (ctx) => {
  const { $, esc, I, n, plural, state, api, toast } = ctx;
  const DRAG = 'application/x-discshelf-ids';

  const get = (id) => state.playlists.find((p) => p.id === id) || null;
  const viewId = (id) => `pl:${id}`;
  const idOfView = (v) => (v && v.startsWith('pl:') ? v.slice(3) : null);

  function renderSidebar() {
    const box = $('#playlist-list');
    box.innerHTML = state.playlists.length
      ? state.playlists.map((pl) => `<button type="button" class="side-item pl-item${state.view === viewId(pl.id) ? ' active' : ''}" data-view="${esc(viewId(pl.id))}" data-pl="${esc(pl.id)}" role="listitem" title="${esc(pl.name)}">
          ${I.playlist}<span class="label">${esc(pl.name)}</span><span class="count">${pl.ids.length ? n(pl.ids.length) : ''}</span></button>`).join('')
      : '<div class="side-empty">Drag songs onto <b>+</b> to make one</div>';
  }

  async function ask(title, value, okLabel) {
    let input = '';
    const r = await ctx.modal(`<h2>${esc(title)}</h2>
      <label class="gi-field"><span>Name</span><input type="text" id="pl-name" value="${esc(value)}" maxlength="200" spellcheck="false"></label>
      <div class="actions"><button type="button" class="btn" data-result="cancel">Cancel</button><button type="button" class="btn primary" data-result="ok" id="pl-ok">${esc(okLabel)}</button></div>`, {
      onMount(root, close) {
        const inp = root.querySelector('#pl-name');
        setTimeout(() => { inp.focus(); inp.select(); }, 0);
        inp.addEventListener('input', () => { input = inp.value; });
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input = inp.value; close('ok'); } });
        input = value;
      },
    });
    return r === 'ok' ? input.trim() : null;
  }

  async function create(ids = []) {
    const first = ids.length === 1 ? state.byId.get(ids[0]) : null;
    const name = await ask('New playlist', first ? `${first.title} mix` : 'New Playlist', 'Create');
    if (name === null) return null;
    const pl = await api.createPlaylist(name || 'New Playlist', ids);
    await ctx.reloadLibrary();
    ctx.setView(viewId(pl.id));
    if (ids.length) toast(`Made “${pl.name}” with ${plural(pl.ids.length, 'song', 'songs')}.`);
    return pl;
  }

  async function rename(id) {
    const pl = get(id);
    if (!pl) return;
    const name = await ask('Rename playlist', pl.name, 'Rename');
    if (!name) return;
    await api.renamePlaylist(id, name);
    await ctx.reloadLibrary();
  }

  async function remove(id) {
    const pl = get(id);
    if (!pl) return;
    const r = await ctx.modal(`<h2>Delete “${esc(pl.name)}”?</h2><p>The playlist is deleted. The songs stay in your library.</p>
      <div class="actions"><button type="button" class="btn" data-result="cancel">Cancel</button><button type="button" class="btn danger" data-result="ok" data-autofocus>Delete</button></div>`);
    if (r !== 'ok') return;
    if (state.view === viewId(id)) ctx.setView('music');
    await api.deletePlaylist(id);
    await ctx.reloadLibrary();
  }

  async function addTo(id, ids, position = null) {
    const pl = get(id);
    if (!pl || !ids.length) return;
    const r = await api.addToPlaylist(id, ids, position);
    await ctx.reloadLibrary();
    if (r.added && r.already) toast(`Added ${plural(r.added, 'song', 'songs')} to “${pl.name}” (${n(r.already)} already there).`);
    else if (r.added) toast(`Added ${r.added === 1 ? `“${state.byId.get(ids[0])?.title || 'the song'}”` : plural(r.added, 'song', 'songs')} to “${pl.name}”.`);
    else toast(`${ids.length === 1 ? 'That song is' : 'Those songs are'} already in “${pl.name}”.`);
  }

  async function removeFrom(id, ids) {
    const pl = get(id);
    if (!pl) return;
    const drop = new Set(ids);
    await api.setPlaylist(id, pl.ids.filter((x) => !drop.has(x)));
    state.selected.clear();
    await ctx.reloadLibrary();
    toast(`Removed ${plural(ids.length, 'song', 'songs')} from “${pl.name}”.`);
  }

  /** Moves `ids` so they sit before position `to` (an index into the playlist). */
  async function reorder(id, ids, to) {
    const pl = get(id);
    if (!pl) return;
    const moving = new Set(ids);
    const before = pl.ids.slice(0, to).filter((x) => !moving.has(x));
    const after = pl.ids.slice(to).filter((x) => !moving.has(x));
    const order = [...before, ...pl.ids.filter((x) => moving.has(x)), ...after];
    pl.ids = order; // show it straight away
    ctx.recompute();
    await api.setPlaylist(id, order);
    await ctx.reloadLibrary();
  }

  function onImported(results) {
    for (const r of results) {
      if (r.error) { toast(`Couldn’t import ${r.error}`, 'error'); continue; }
      toast(`Imported “${r.name}”: ${plural(r.count, 'song', 'songs')}${r.added ? ` (${n(r.added)} new to your library)` : ''}${r.missing ? `; ${plural(r.missing, 'file wasn’t', 'files weren’t')} found` : ''}.`);
    }
    const last = results.filter((r) => !r.error).pop();
    ctx.reloadLibrary().then(() => { if (last) ctx.setView(viewId(last.id)); });
  }

  // ---------------------------------------------------------------- drag and drop onto the sidebar

  function setup() {
    $('#btn-new-playlist').innerHTML = I.plus;
    $('#btn-new-playlist').addEventListener('click', () => create(ctx.currentSelection()));
    const box = $('#playlist-list');
    box.addEventListener('click', (e) => { const b = e.target.closest('[data-view]'); if (b) ctx.setView(b.dataset.view); });
    box.addEventListener('dblclick', (e) => {
      const b = e.target.closest('[data-pl]');
      const pl = b && get(b.dataset.pl);
      if (pl && pl.ids.length) ctx.playQueue(pl.ids, 0, { source: pl.name });
    });
    box.addEventListener('contextmenu', (e) => {
      const b = e.target.closest('[data-pl]');
      if (!b) return;
      e.preventDefault();
      api.playlistMenu(b.dataset.pl, e.clientX, e.clientY);
    });
    const targets = [box, $('#btn-new-playlist')];
    for (const t of targets) {
      t.addEventListener('dragover', (e) => {
        if (![...e.dataTransfer.types].includes(DRAG)) return;
        const item = e.target.closest('[data-pl]') || e.target.closest('#btn-new-playlist');
        if (!item) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        document.querySelectorAll('.drop-target').forEach((x) => x.classList.remove('drop-target'));
        item.classList.add('drop-target');
      });
      t.addEventListener('dragleave', (e) => { const item = e.target.closest('.drop-target'); if (item) item.classList.remove('drop-target'); });
      t.addEventListener('drop', (e) => {
        const raw = e.dataTransfer.getData(DRAG);
        document.querySelectorAll('.drop-target').forEach((x) => x.classList.remove('drop-target'));
        if (!raw) return;
        e.preventDefault();
        const ids = JSON.parse(raw);
        const item = e.target.closest('[data-pl]');
        if (item) addTo(item.dataset.pl, ids);
        else if (e.target.closest('#btn-new-playlist')) create(ids);
      });
    }
    api.onPlaylistImported(onImported);
  }

  return { setup, renderSidebar, create, rename, remove, addTo, removeFrom, reorder, get, idOfView, viewId };
};
