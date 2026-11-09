'use strict';
/* Get Info: edit song details and artwork by hand, or look them up online (iTunes / Deezer). */
window.DSModules = window.DSModules || {};
window.DSModules.info = (ctx) => {
  const { api, esc, I, state, toast } = ctx;

  const FIELDS = [
    { key: 'title', label: 'Title', single: true },
    { key: 'artist', label: 'Artist' },
    { key: 'albumArtist', label: 'Album artist' },
    { key: 'album', label: 'Album' },
    { key: 'genre', label: 'Genre' },
    { key: 'year', label: 'Year', num: true, small: true },
  ];

  function commonValue(tracks, key) {
    const v = tracks[0][key] ?? '';
    return tracks.every((t) => (t[key] ?? '') === v) ? v : undefined; // undefined = mixed
  }

  const toDataUrl = (img) => (img ? `data:${img.mime};base64,${img.base64}` : null);

  async function open(ids) {
    const tracks = ids.map((id) => state.byId.get(id)).filter(Boolean);
    if (!tracks.length) return;
    const one = tracks.length === 1;
    const t0 = tracks[0];
    const album = one ? ctx.albums.albumOf(t0.id) : null;
    const albumHasOthers = !!(album && album.ids.length > 1 && t0.album);

    // Staged changes: only what the person touched is saved.
    const dirty = new Set();
    let art; // undefined = unchanged, null = remove, {mime, base64} = new
    const currentArt = commonValue(tracks, 'art');
    const artNow = currentArt ? ctx.artUrl({ art: currentArt }) : null;

    const fieldHtml = FIELDS.filter((f) => one || !f.single).map((f) => {
      const v = commonValue(tracks, f.key);
      const val = v === undefined ? '' : (f.num ? (v || '') : v);
      const ph = v === undefined ? 'Mixed — leave blank to keep each song’s own' : '';
      return `<label class="gi-field${f.small ? ' small' : ''}"><span>${f.label}</span>
        <input type="${f.num ? 'number' : 'text'}" data-key="${f.key}" value="${esc(val)}" placeholder="${esc(ph)}" ${f.num ? 'min="0" max="9999"' : ''} spellcheck="false"></label>`;
    }).join('');
    const pair = (a, b, label) => {
      const va = commonValue(tracks, a); const vb = commonValue(tracks, b);
      return `<label class="gi-field small"><span>${label}</span><span class="gi-pair">
        <input type="number" data-key="${a}" value="${va || ''}" min="0" max="9999" ${one ? '' : 'disabled'} placeholder="${va === undefined ? '—' : ''}" aria-label="${label} number">
        <span>of</span>
        <input type="number" data-key="${b}" value="${vb || ''}" min="0" max="9999" placeholder="${vb === undefined ? '—' : ''}" aria-label="${label} total"></span></label>`;
    };

    const onlineOn = state.settings.onlineLookup;
    const searchTerm = one ? `${t0.artist} ${t0.title}`.trim() : `${commonValue(tracks, 'albumArtist') || commonValue(tracks, 'artist') || ''} ${commonValue(tracks, 'album') || ''}`.trim();

    const html = `
      <h2>${one ? esc(t0.title) : `${tracks.length} songs`}</h2>
      <p class="gi-sub">${one ? esc([t0.artist, t0.album].filter(Boolean).join(' — ')) : 'Changes apply to every selected song.'}</p>
      <div class="gi-tabs" role="tablist">
        <button type="button" role="tab" data-tab="details" aria-selected="true">Details</button>
        <button type="button" role="tab" data-tab="artwork" aria-selected="false">Artwork</button>
        <button type="button" role="tab" data-tab="online" aria-selected="false">Find online</button>
        ${one ? '<button type="button" role="tab" data-tab="file" aria-selected="false">File</button>' : ''}
      </div>

      <section class="gi-panel" data-panel="details">
        <div class="gi-grid">${fieldHtml}${pair('trackNo', 'trackOf', 'Track')}${pair('discNo', 'discOf', 'Disc')}</div>
      </section>

      <section class="gi-panel" data-panel="artwork" hidden>
        <div class="gi-art">
          <div class="gi-art-frame" id="gi-art">${artNow ? `<img src="${esc(artNow)}" alt="">` : (currentArt === undefined && !one ? '<span>Mixed artwork</span>' : I.disc)}</div>
          <div class="gi-art-side">
            <button type="button" class="btn" id="gi-art-file">${I.folder}<span>Choose image…</span></button>
            <button type="button" class="btn" id="gi-art-paste">Paste</button>
            <button type="button" class="btn" id="gi-art-remove">Remove artwork</button>
            ${albumHasOthers ? `<label class="check"><input type="checkbox" id="gi-art-album" checked> Use for all ${album.ids.length} songs on “${esc(t0.album)}”</label>` : ''}
            <p class="gi-hint">You can also drag an image onto the artwork, or find one in the “Find online” tab.</p>
          </div>
        </div>
      </section>

      <section class="gi-panel" data-panel="online" hidden>
        ${onlineOn ? `
        <form class="gi-search" id="gi-search">
          <input type="search" id="gi-term" value="${esc(searchTerm)}" placeholder="Artist, song or album" spellcheck="false">
          <select id="gi-kind" aria-label="Search for"><option value="song"${one ? ' selected' : ''}>Songs</option><option value="album"${one ? '' : ' selected'}>Albums</option></select>
          <button type="submit" class="btn primary">${I.search}<span>Search</span></button>
        </form>
        <div class="gi-results" id="gi-results"><p class="gi-hint">Search iTunes and Deezer for this ${one ? 'song' : 'album'}, then pick a result to use its details, its artwork, or both.</p></div>`
        : '<p class="gi-hint">Online lookups are turned off. You can turn them on in Settings → Song info &amp; artwork.</p>'}
      </section>

      ${one ? `<section class="gi-panel" data-panel="file" hidden>
        <dl class="gi-file">
          <dt>Location</dt><dd>${esc(t0.path)}</dd>
          <dt>Format</dt><dd>${esc(ctx.formatLine(t0) || '—')}</dd>
          <dt>Length</dt><dd>${t0.duration ? ctx.fmtTime(t0.duration) : '—'}</dd>
          <dt>Size</dt><dd>${(t0.size / 1e6).toFixed(1)} MB</dd>
          <dt>Added</dt><dd>${t0.added ? new Date(t0.added).toLocaleString() : '—'}</dd>
          <dt>Plays</dt><dd>${t0.playCount || 0}${t0.lastPlayed ? ` (last ${new Date(t0.lastPlayed).toLocaleString()})` : ''}</dd>
        </dl>
        <button type="button" class="linkbtn" id="gi-reveal">Show in Explorer</button>
      </section>` : ''}

      <p class="gi-note">${state.settings.writeTags !== false
    ? 'Changes are saved into the music files and your Discshelf library.'
    : 'Changes are saved in your Discshelf library only (saving into the music files is turned off in Settings).'}</p>
      <div class="actions"><button type="button" class="btn" data-result="cancel">Cancel</button><button type="button" class="btn primary" id="gi-save">Save</button></div>`;

    await ctx.modal(html, {
      sticky: true,
      onMount(root, close) {
        root.querySelector('.modal').classList.add('modal-wide', 'gi');
        const $r = (s) => root.querySelector(s);

        // tabs
        root.querySelectorAll('[data-tab]').forEach((tab) => tab.addEventListener('click', () => {
          root.querySelectorAll('[data-tab]').forEach((x) => x.setAttribute('aria-selected', String(x === tab)));
          root.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== tab.dataset.tab; });
          if (tab.dataset.tab === 'online') $r('#gi-term')?.focus();
        }));

        root.querySelectorAll('[data-key]').forEach((inp) => inp.addEventListener('input', () => dirty.add(inp.dataset.key)));

        const showArt = () => {
          const f = $r('#gi-art');
          if (art === null) f.innerHTML = I.disc;
          else if (art) f.innerHTML = `<img src="${toDataUrl(art)}" alt="">`;
        };
        const stage = (img) => { if (img) { art = img; showArt(); } };
        const fail = (err) => toast(String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error');

        $r('#gi-art-file').addEventListener('click', () => api.openArtFile().then(stage).catch(fail));
        $r('#gi-art-paste').addEventListener('click', () => api.pasteArt().then((img) => (img ? stage(img) : toast('There’s no image on the clipboard.'))).catch(fail));
        $r('#gi-art-remove').addEventListener('click', () => { art = null; showArt(); });
        const frame = $r('#gi-art');
        frame.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); frame.classList.add('drop'); });
        frame.addEventListener('dragleave', () => frame.classList.remove('drop'));
        frame.addEventListener('drop', (e) => {
          e.preventDefault(); e.stopPropagation(); frame.classList.remove('drop');
          const file = [...(e.dataTransfer?.files || [])].find((f) => /^image\//.test(f.type));
          if (!file) { toast('Drop a JPEG, PNG, GIF or WebP image.'); return; }
          const reader = new FileReader();
          reader.onload = () => { const [head, b64] = String(reader.result).split(','); stage({ mime: head.slice(5, head.indexOf(';')), base64: b64 }); };
          reader.readAsDataURL(file);
        });

        $r('#gi-reveal')?.addEventListener('click', () => api.showInFolder(t0.id));

        // online search
        let results = [];
        const form = $r('#gi-search');
        if (form) {
          form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const term = $r('#gi-term').value.trim();
            if (!term) return;
            const box = $r('#gi-results');
            box.innerHTML = '<p class="gi-hint"><span class="spinner"></span> Searching…</p>';
            try {
              const r = await api.searchOnline(term, $r('#gi-kind').value);
              results = r.results;
              if (!results.length) {
                box.innerHTML = `<p class="gi-hint">${r.errors.length ? `Couldn’t search: ${esc(r.errors.join('; '))}` : 'Nothing found. Try fewer words, or just the artist and album.'}</p>`;
                return;
              }
              box.innerHTML = results.map((x, i) => `
                <div class="gi-result">
                  ${x.thumb ? `<img src="${esc(x.thumb)}" alt="" loading="lazy">` : `<span class="gi-noimg">${I.disc}</span>`}
                  <div class="gi-rtext">
                    <div class="gi-rtitle">${esc(x.title || x.album)}</div>
                    <div class="gi-rsub">${esc([x.artist, x.title ? x.album : '', x.year || '', x.genre].filter(Boolean).join(' · '))}</div>
                    <div class="gi-rsrc">${esc(x.source)}</div>
                  </div>
                  <div class="gi-ractions">
                    <button type="button" class="btn" data-use="both" data-i="${i}">Use</button>
                    <button type="button" class="btn" data-use="info" data-i="${i}">Details only</button>
                    ${x.artwork ? `<button type="button" class="btn" data-use="art" data-i="${i}">Artwork only</button>` : ''}
                  </div>
                </div>`).join('') + (r.errors.length ? `<p class="gi-hint">${esc(r.errors.join('; '))}</p>` : '');
            } catch (err) {
              box.innerHTML = `<p class="gi-hint">Couldn’t search: ${esc(String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))}</p>`;
            }
          });
          $r('#gi-results').addEventListener('click', async (e) => {
            const b = e.target.closest('[data-use]');
            if (!b) return;
            const x = results[parseInt(b.dataset.i, 10)];
            const use = b.dataset.use;
            if (use === 'both' || use === 'info') applyResult(x);
            if ((use === 'both' || use === 'art') && x.artwork) {
              b.disabled = true;
              try { stage(await api.fetchOnlineImage(x.artwork)); } catch (err) { fail(err); }
              b.disabled = false;
            }
            // An album (or several songs): also get the album's track list for titles + track numbers.
            if ((use === 'both' || use === 'info') && x.albumRef && (!one || !x.title)) {
              await loadTrackList(x);
              return;
            }
            const what = use === 'art' ? 'Artwork' : use === 'info' ? 'Details' : 'Details and artwork';
            toast(`${what} filled in. Check the Details and Artwork tabs, then click Save.`);
          });
        }

        // ---- album track list: match each song to a track, so titles + numbers can be filled in
        let trackList = null; // {album, artist, tracks}
        const matchIdx = new Map(); // song id -> index into trackList.tracks (-1 = leave alone)
        const fmtNo = (t) => (trackList.discOf > 1 ? `${t.discNo || 1}-${String(t.trackNo).padStart(2, '0')}` : String(t.trackNo || ''));

        async function loadTrackList(x) {
          const box = $r('#gi-results');
          const keep = box.innerHTML;
          box.innerHTML = '<p class="gi-hint"><span class="spinner"></span> Getting the album’s track list…</p>';
          let r;
          try {
            r = await api.albumTracks(x.albumRef, ids);
          } catch (err) {
            box.innerHTML = keep;
            fail(err);
            return;
          }
          if (!r.tracks.length) { box.innerHTML = keep; toast('That album has no track list. Its details were filled in.'); return; }
          trackList = { ...r, discOf: Math.max(1, ...r.tracks.map((t) => t.discOf || t.discNo || 1)) };
          setField('genre', r.genre); setField('year', r.year); setField('album', r.album);
          if (!one) setField('albumArtist', r.artist);
          matchIdx.clear();
          for (const m of r.matches) matchIdx.set(m.id, m.index);
          renderMatches(r.matches, keep);
        }

        function renderMatches(matches, keepHtml) {
          const box = $r('#gi-results');
          const matched = matches.filter((m) => m.index >= 0).length;
          const how = { title: 'matched by title', number: 'matched by track number', order: 'matched by file order' };
          const opts = trackList.tracks.map((t, j) => `<option value="${j}">${esc(fmtNo(t))}. ${esc(t.title)}${t.duration ? ` (${ctx.fmtTime(t.duration)})` : ''}</option>`).join('');
          const rows = tracks.slice().sort((a, b) => (a.discNo || 1) - (b.discNo || 1) || (a.trackNo || 0) - (b.trackNo || 0) || ctx.collator.compare(a.path, b.path)).map((t) => {
            const m = matches.find((x) => x.id === t.id);
            return `<div class="gi-mrow">
              <div class="gi-mlocal"><div class="gi-mtitle">${esc(t.title)}</div><div class="gi-mfile">${esc(t.path.split(/[\\/]/).pop())}</div></div>
              <span class="gi-marrow" aria-hidden="true">→</span>
              <div class="gi-mpick"><select data-mid="${esc(t.id)}" aria-label="Album track for ${esc(t.title)}"><option value="-1">Leave title and number as they are</option>${opts}</select>
              <span class="gi-mhow">${m && m.how ? how[m.how] : 'no match found'}</span></div></div>`;
          }).join('');
          box.innerHTML = `
            <div class="gi-match">
              <div class="gi-match-head"><div><b>${esc(trackList.album)}</b> — ${esc(trackList.artist)} · ${trackList.tracks.length} tracks</div>
                <button type="button" class="linkbtn" id="gi-match-back">Back to results</button></div>
              <p class="gi-hint">Matched ${matched} of ${tracks.length} ${tracks.length === 1 ? 'song' : 'songs'} to the album’s track list. Check each one, then click <b>Save</b> to set the titles and track numbers.</p>
              ${rows}
            </div>`;
          box.querySelectorAll('select[data-mid]').forEach((sel) => { sel.value = String(matchIdx.get(sel.dataset.mid) ?? -1); });
          box.querySelector('#gi-match-back').addEventListener('click', () => { trackList = null; box.innerHTML = keepHtml; });
          box.addEventListener('change', (e) => {
            const sel = e.target.closest('select[data-mid]');
            if (sel) matchIdx.set(sel.dataset.mid, parseInt(sel.value, 10));
          });
          if (one) {
            const j = matchIdx.get(t0.id);
            if (j >= 0) { const t = trackList.tracks[j]; setField('title', t.title); setField('trackNo', t.trackNo); setField('trackOf', t.trackOf); setField('discNo', t.discNo); setField('discOf', t.discOf); }
          }
          toast('Album details filled in. Check the track matches, then click Save.');
        }

        function setField(key, value) {
          const inp = root.querySelector(`[data-key="${key}"]`);
          if (!inp || inp.disabled || value === undefined || value === null || value === '' || value === 0) return;
          inp.value = value;
          dirty.add(key);
        }
        function applyResult(x) {
          if (one && x.title) setField('title', x.title);
          if (one || commonValue(tracks, 'artist') !== undefined) setField('artist', x.artist);
          setField('albumArtist', x.albumArtist || (one ? '' : x.artist));
          setField('album', x.album);
          setField('genre', x.genre);
          setField('year', x.year);
          if (one) { setField('trackNo', x.trackNo); setField('discNo', x.discNo); }
          setField('trackOf', x.trackOf);
          setField('discOf', x.discOf);
        }

        // save
        $r('#gi-save').addEventListener('click', async () => {
          const fields = {};
          for (const key of dirty) {
            const inp = root.querySelector(`[data-key="${key}"]`);
            if (!inp) continue;
            // In a multi-song edit an empty "Mixed" field means "keep each song's own value".
            if (!one && inp.value === '' && inp.placeholder) continue;
            fields[key] = inp.value;
          }
          if (!Object.keys(fields).length && art === undefined && !trackList) { close('cancel'); return; }
          const btn = $r('#gi-save');
          btn.disabled = true;
          try {
            if (trackList) {
              // Each song gets its own title + numbers from the album's track list.
              const shared = { ...fields };
              for (const k of ['title', 'trackNo', 'discNo']) delete shared[k];
              const various = new Set(trackList.tracks.map((t) => t.artist)).size > 1;
              const entries = ids.map((id) => {
                const j = matchIdx.get(id);
                const t = j >= 0 ? trackList.tracks[j] : null;
                const own = t ? { title: t.title, trackNo: t.trackNo, trackOf: t.trackOf, discNo: t.discNo, discOf: t.discOf } : {};
                if (t && various && t.artist) own.artist = t.artist;
                return { id, fields: { ...shared, ...own } };
              });
              const artIds = art !== undefined ? ($r('#gi-art-album')?.checked ? album.ids : ids) : null;
              const res = await api.saveEach(entries, art, artIds);
              close('saved');
              await ctx.reloadLibrary();
              const n = entries.filter((e) => e.fields.title !== undefined).length;
              toast(`Saved ${tracks.length === 1 ? 'the song' : `${tracks.length} songs`}${n ? `; ${n} got titles and track numbers from the album` : ''}.`);
              reportFiles([res]);
              return;
            }
            const artIds = art !== undefined && $r('#gi-art-album')?.checked ? album.ids : ids;
            const results = [];
            if (Object.keys(fields).length) results.push(await api.saveTracks(ids, fields, artIds === ids ? art : undefined));
            if (art !== undefined && (artIds !== ids || !Object.keys(fields).length)) results.push(await api.saveTracks(artIds, {}, art));
            close('saved');
            await ctx.reloadLibrary();
            toast(one ? 'Song info saved.' : `Saved ${tracks.length} songs.`);
            reportFiles(results);
          } catch (err) {
            btn.disabled = false;
            fail(err);
          }
        });
      },
    });
  }

  /** Tells the person about any music files the changes couldn't be saved into. */
  function reportFiles(results) {
    const failed = results.flatMap((r) => (r && r.failed) || []);
    if (!failed.length) return;
    const first = failed[0];
    toast(`Saved in your library, but not into ${failed.length === 1 ? `“${first.title}”` : `${failed.length} files`}: ${first.message}.`, 'error');
  }

  return { open };
};
