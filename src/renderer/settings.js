'use strict';
/* Settings page: appearance, library, playback + equalizer, song info & artwork, Last.fm, about. */
window.DSModules = window.DSModules || {};
window.DSModules.settings = (ctx) => {
  const { api, $, esc, I, n, plural, state, toast } = ctx;
  let lf = { hasKeys: false, connected: false, user: null, queued: 0, authorizing: false, builtInKey: false };
  let artJob = null;

  const toggle = (id, checked, label, hint = '') => `
    <label class="set-row">
      <span class="set-text"><span class="set-label">${label}</span>${hint ? `<span class="set-hint">${hint}</span>` : ''}</span>
      <span class="switch"><input type="checkbox" id="${id}"${checked ? ' checked' : ''}><span></span></span>
    </label>`;

  function styleTile(id, label, desc) {
    const on = (state.settings.style || 'modern') === id;
    return `<button type="button" class="style-tile${on ? ' on' : ''}" data-style="${id}" aria-pressed="${on}">
      <span class="style-preview ${id}" aria-hidden="true">
        <span class="sp-bar"></span><span class="sp-side"></span><span class="sp-list"><i></i><i class="sel"></i><i></i><i></i></span>
      </span>
      <span class="style-name">${label}</span><span class="style-desc">${desc}</span></button>`;
  }

  function seg(name, value, options) {
    return `<div class="seg" role="radiogroup">${options.map(([v, l]) => `<button type="button" role="radio" data-${name}="${v}" aria-checked="${value === v}">${l}</button>`).join('')}</div>`;
  }

  function lastfmHtml() {
    if (!lf.hasKeys) {
      return `<p class="set-hint">This copy of Discshelf doesn’t have a Last.fm API key built in yet. If you have one (from <a href="https://www.last.fm/api/account/create">last.fm/api/account/create</a>), enter it here:</p>
        <div class="set-keys">
          <label class="gi-field"><span>API key</span><input type="text" id="lf-key" spellcheck="false" autocomplete="off"></label>
          <label class="gi-field"><span>Shared secret</span><input type="password" id="lf-secret" spellcheck="false" autocomplete="off"></label>
          <button type="button" class="btn" id="lf-savekeys">Save key</button>
        </div>`;
    }
    if (lf.authorizing) {
      return `<div class="set-row"><span class="set-text"><span class="set-label"><span class="spinner"></span> Waiting for you to allow Discshelf on Last.fm…</span>
        <span class="set-hint">A Last.fm page opened in your browser. Click “Yes, allow access” there, then come back here.</span></span>
        <button type="button" class="btn" id="lf-cancel">Cancel</button></div>`;
    }
    if (!lf.connected) {
      return `<div class="set-row"><span class="set-text"><span class="set-label">Not connected</span>
        <span class="set-hint">Connect your Last.fm account to scrobble the songs you play.</span></span>
        <button type="button" class="btn primary" id="lf-connect">Connect to Last.fm</button></div>
        ${!lf.builtInKey ? '<button type="button" class="linkbtn" id="lf-clearkeys">Use a different API key</button>' : ''}`;
    }
    return `<div class="set-row"><span class="set-text"><span class="set-label">Connected as <a href="https://www.last.fm/user/${encodeURIComponent(lf.user)}">${esc(lf.user)}</a></span>
        <span class="set-hint">${lf.queued ? `${plural(lf.queued, 'scrobble is', 'scrobbles are')} waiting to be sent.` : 'All scrobbles sent.'}</span></span>
        <button type="button" class="btn" id="lf-disconnect">Disconnect</button></div>
      ${toggle('set-scrobble', state.settings.scrobble !== false, 'Scrobble songs I play', 'A song counts once you’ve heard half of it, or 4 minutes. Songs of 30 seconds or less aren’t scrobbled.')}`;
  }

  function render() {
    const s = state.settings;
    const missing = ctx.albums.all().filter((a) => !a.artTrack && a.title).length;
    const folders = state.folders.length
      ? state.folders.map((f) => {
        const c = state.tracks.filter((t) => ctx.isInside(t.path, f)).length;
        return `<div class="set-folder"><span class="p" title="${esc(f)}">${I.folder}<span>${esc(f)}</span></span><span class="c">${plural(c, 'song', 'songs')}</span>
          <button type="button" class="btn" data-remove-folder="${esc(f)}">Remove</button></div>`;
      }).join('')
      : '<p class="set-hint">No music folders yet.</p>';

    $('#settings-view').innerHTML = `
      <div class="set-page">
        <h1>Settings</h1>

        <section class="set-card" id="set-appearance">
          <h2>Appearance</h2>
          <div class="style-tiles">
            ${styleTile('modern', 'Modern', 'Clean and flat')}
            ${styleTile('classic', 'Classic', 'Songbird’s glossy look and colors')}
            ${styleTile('itunes', 'iTunes', 'Bright white, like iTunes 12')}
          </div>
          <div class="set-row"><span class="set-text"><span class="set-label">Light or dark</span></span>
            ${seg('mode', s.theme || 'system', [['system', 'Follow Windows'], ['light', 'Light'], ['dark', 'Dark']])}</div>
          <div class="set-row"><span class="set-text"><span class="set-label">Accent color</span>
            <span class="set-hint">Used for buttons, the seek bar and the song that’s playing.</span></span>
            <div class="swatches" role="radiogroup">${ctx.colors.ACCENTS.map(([c, label]) => `<button type="button" class="swatch${c ? '' : ' theme'}" role="radio" data-accent="${c}" aria-checked="${(s.accent || '') === c}" title="${label}" style="${c ? `--sw:${c}` : ''}"></button>`).join('')}</div></div>
          ${toggle('set-albumcolors', !!s.albumColors, 'Album colors', 'Tint Discshelf with the colors of the album that’s playing.')}
        </section>

        <section class="set-card">
          <h2>Library</h2>
          <div class="set-folders">${folders}</div>
          <div class="set-buttons">
            <button type="button" class="btn" id="set-addfolder">${I.plus}<span>Add folder…</span></button>
            <button type="button" class="btn" id="set-rescan">Rescan now</button>
          </div>
          ${toggle('set-rescanstart', s.rescanOnStart !== false, 'Look for new music when Discshelf starts', 'Adds new songs and drops deleted ones from your music folders.')}
          <p class="set-hint">${plural(state.tracks.length, 'song', 'songs')} in ${plural(ctx.albums.all().length, 'album', 'albums')}.</p>
        </section>

        <section class="set-card">
          <h2>Playback</h2>
          <div class="set-row"><span class="set-text"><span class="set-label">Equalizer</span><span class="set-hint" id="set-eq-summary">${esc(ctx.eq.summary())}</span></span>
            <button type="button" class="btn" id="set-eq">Open equalizer</button></div>
          ${toggle('set-resume', s.resumeOnStart !== false, 'Pick up where I left off', 'When Discshelf starts, the last song is ready to play from where you stopped.')}
        </section>

        <section class="set-card">
          <h2>Song info &amp; artwork</h2>
          <p class="set-hint">To change a song’s details or artwork yourself, right-click it and choose <b>Get Info</b> (or press Ctrl+I).</p>
          ${toggle('set-writetags', s.writeTags !== false, 'Save changes into the music files', 'Details and artwork you change are written into the files themselves, so other players see them too. Each file is checked after saving, before it replaces the original.')}
          <div class="set-row" id="set-pending-row" hidden><span class="set-text"><span class="set-label">Earlier changes</span>
            <span class="set-hint" id="set-pending-status"></span></span>
            <button type="button" class="btn" id="set-writepending">Save into files</button></div>
          ${toggle('set-online', s.onlineLookup !== false, 'Look up song info and artwork online', 'Uses the iTunes and Deezer search services. Only the search words you send (artist, album or song names) leave your computer.')}
          <div class="set-row"><span class="set-text"><span class="set-label">Find missing album artwork</span>
            <span class="set-hint" id="set-art-status">${artJob ? '' : missing ? `${plural(missing, 'album has', 'albums have')} no artwork.` : 'Every album has artwork.'}</span></span>
            <button type="button" class="btn" id="set-findart"${!missing || s.onlineLookup === false ? ' disabled' : ''}>${artJob ? 'Stop' : 'Find artwork'}</button></div>
        </section>

        <section class="set-card" id="set-lastfm">
          <h2><span class="lf-mark" aria-hidden="true">as</span> Last.fm</h2>
          <div id="lf-body">${lastfmHtml()}</div>
        </section>

        <section class="set-card">
          <h2>About</h2>
          <div class="set-about">
            <img src="../assets/icon.png" alt="" width="56" height="56">
            <div><div class="set-label">Discshelf ${esc(state.info.version || '')}</div>
            <div class="set-hint">© ${new Date().getFullYear()} Bytehawk Studio</div></div>
          </div>
          ${toggle('set-checkupdates', s.checkUpdates !== false, 'Check for updates', 'Asks GitHub for the latest version when Discshelf starts. Updates are installed from the Bytehawk Studio Launcher.')}
          <div class="set-buttons">
            <button type="button" class="btn" id="set-version">Version &amp; what’s new</button>
            <button type="button" class="btn" id="set-shortcuts">Keyboard shortcuts</button>
            <button type="button" class="btn" id="set-data">Open data folder</button>
          </div>
        </section>
      </div>`;
    if (artJob) showArtProgress(artJob);
    refreshPending();
  }

  let writing = false;
  async function refreshPending() {
    const row = $('#set-pending-row');
    if (!row || writing) return;
    const count = state.settings.writeTags === false ? 0 : await api.pendingEdits();
    row.hidden = !count;
    if (count) $('#set-pending-status').textContent = `${plural(count, 'song has', 'songs have')} changes saved only in your library. Save them into the files too?`;
  }

  function renderLastfm() {
    const body = $('#lf-body');
    if (body) body.innerHTML = lastfmHtml();
  }

  function showArtProgress(p) {
    const el = $('#set-art-status');
    const btn = $('#set-findart');
    if (!el) return;
    if (p.finished) {
      el.textContent = `Done. Found artwork for ${plural(p.found, 'album', 'albums')}${p.total - p.found ? `; ${n(p.total - p.found)} not found` : ''}.`;
      if (btn) { btn.textContent = 'Find artwork'; btn.disabled = false; }
      return;
    }
    el.textContent = `Looking… ${n(p.done)} of ${n(p.total)}: ${p.current}`;
    if (btn) { btn.textContent = 'Stop'; btn.disabled = false; }
  }

  const errText = (err) => String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  function setup() {
    const view = $('#settings-view');
    view.addEventListener('click', async (e) => {
      const t = e.target;
      const style = t.closest('.style-tile[data-style]');
      if (style) { ctx.setAppearance({ style: style.dataset.style }); render(); return; }
      const acc = t.closest('[data-accent]');
      if (acc) { ctx.saveSettings({ accent: acc.dataset.accent }); ctx.colors.update(); render(); return; }
      const mode = t.closest('.seg [data-mode]');
      if (mode) { ctx.setAppearance({ theme: mode.dataset.mode }); render(); return; }
      const rm = t.closest('[data-remove-folder]');
      if (rm) {
        const f = rm.dataset.removeFolder;
        const r = await ctx.modal(`<h2>Remove this folder?</h2><p>${esc(f)}</p><p>Its songs are taken out of your library. No files are deleted.</p>
          <div class="actions"><button type="button" class="btn" data-result="cancel">Cancel</button><button type="button" class="btn danger" data-result="ok" data-autofocus>Remove</button></div>`);
        if (r === 'ok') { await api.removeFolder(f); await ctx.reloadLibrary(); render(); }
        return;
      }
      const a = t.closest('a[href^="https://"]');
      if (a) { e.preventDefault(); window.open(a.href); return; }
      switch (t.closest('button')?.id) {
        case 'set-addfolder': api.addFolder(); break;
        case 'set-rescan': api.rescan(); break;
        case 'set-eq': ctx.eq.open(); break;
        case 'set-shortcuts': ctx.shortcuts(); break;
        case 'set-version': ctx.setView('version'); break;
        case 'set-data': api.openDataFolder(); break;
        case 'set-findart':
          if (artJob) { api.cancelFindArt(); break; }
          ctx.findMissingArt();
          break;
        case 'set-writepending': {
          writing = true;
          const btn = $('#set-writepending');
          btn.disabled = true;
          try {
            const r = await api.writePendingEdits();
            writing = false;
            await ctx.reloadLibrary();
            toast(`Saved changes into ${plural(r.written, 'file', 'files')}.`);
            if (r.failed.length) toast(`${plural(r.failed.length, 'file', 'files')} couldn’t be saved into. First: “${r.failed[0].title}”: ${r.failed[0].message}.`, 'error');
          } catch (err) {
            toast(errText(err), 'error');
          }
          writing = false;
          btn.disabled = false;
          break;
        }
        case 'lf-connect':
          try { lf = await api.lastfmConnect(); renderLastfm(); } catch (err) { toast(`Couldn’t connect to Last.fm: ${errText(err)}`, 'error'); }
          break;
        case 'lf-cancel': lf = await api.lastfmCancel(); renderLastfm(); break;
        case 'lf-disconnect': lf = await api.lastfmDisconnect(); renderLastfm(); break;
        case 'lf-savekeys': {
          const apiKey = $('#lf-key').value.trim(); const secret = $('#lf-secret').value.trim();
          if (!/^[0-9a-f]{32}$/i.test(apiKey) || !/^[0-9a-f]{32}$/i.test(secret)) { toast('The API key and shared secret are each 32 letters and numbers.', 'error'); break; }
          lf = await api.lastfmSetKeys({ apiKey, secret }); renderLastfm();
          break;
        }
        case 'lf-clearkeys': lf = await api.lastfmSetKeys(null); renderLastfm(); break;
        default: break;
      }
    });
    view.addEventListener('change', (e) => {
      const id = e.target.id;
      if (id === 'set-rescanstart') ctx.saveSettings({ rescanOnStart: e.target.checked });
      if (id === 'set-resume') ctx.saveSettings({ resumeOnStart: e.target.checked });
      if (id === 'set-online') { ctx.saveSettings({ onlineLookup: e.target.checked }); render(); }
      if (id === 'set-scrobble') ctx.saveSettings({ scrobble: e.target.checked });
      if (id === 'set-writetags') { ctx.saveSettings({ writeTags: e.target.checked }); refreshPending(); }
      if (id === 'set-albumcolors') { ctx.saveSettings({ albumColors: e.target.checked }); ctx.colors.update(); }
      if (id === 'set-checkupdates') ctx.saveSettings({ checkUpdates: e.target.checked });
    });

    api.onTagProgress((p) => {
      const el = $('#set-pending-status');
      if (el && writing) el.textContent = `Saving into files… ${n(p.done)} of ${n(p.total)}`;
    });
    api.lastfmStatus().then((st) => { lf = st; if (state.view === 'settings') renderLastfm(); });
    api.onLastfmStatus((st) => { lf = st; if (state.view === 'settings') renderLastfm(); });
    api.onLastfmError((msg) => { toast(msg, 'error'); });
    api.onArtProgress((p) => {
      artJob = p.finished ? null : p;
      if (state.view === 'settings') showArtProgress(p);
      if (p.finished) {
        ctx.reloadLibrary();
        if (state.view !== 'settings') toast(`Found artwork for ${plural(p.found, 'album', 'albums')}.`);
      }
    });
  }

  return { setup, render, lastfm: () => lf, refreshEq: () => { const el = $('#set-eq-summary'); if (el) el.textContent = ctx.eq.summary(); } };
};
