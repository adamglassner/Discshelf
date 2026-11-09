'use strict';
/* Version page: the version you have, what's new in each release (from CHANGELOG.md), and a check for updates. */
window.DSModules = window.DSModules || {};
window.DSModules.version = (ctx) => {
  const { $, esc, state, api, toast } = ctx;
  let changelog = null;
  let update = null; // {status: 'checking'|'current'|'available'|'error', version, url, download, message}

  const cmp = (a, b) => {
    const pa = String(a).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
    const pb = String(b).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
    return 0;
  };

  /** Just enough Markdown for the changelog: ## headings, lists, **bold**, `code` and links. */
  function inline(s) {
    return esc(s)
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  }

  /** CHANGELOG.md → [{version, title, html}] */
  function parse(md) {
    const out = [];
    let cur = null;
    let inList = false;
    const close = () => { if (inList) { cur.html += '</ul>'; inList = false; } };
    for (const raw of md.split(/\r?\n/)) {
      const line = raw.trimEnd();
      const h = /^##\s+(\S+)(?:\s+[—-]\s+(.*))?$/.exec(line);
      if (h) { if (cur) close(); cur = { version: h[1], title: h[2] || '', html: '' }; out.push(cur); continue; }
      if (!cur || /^#\s/.test(line)) continue;
      const li = /^\s*[-*]\s+(.*)$/.exec(line);
      if (li) { if (!inList) { cur.html += '<ul>'; inList = true; } cur.html += `<li>${inline(li[1])}</li>`; continue; }
      if (!line.trim()) { close(); continue; }
      const h3 = /^###\s+(.*)$/.exec(line);
      if (h3) { close(); cur.html += `<h4>${inline(h3[1])}</h4>`; continue; }
      if (inList) { cur.html = cur.html.replace(/<\/li>$/, ` ${inline(line.trim())}</li>`); continue; }
      cur.html += `<p>${inline(line)}</p>`;
    }
    if (cur) close();
    return out;
  }

  function updateHtml() {
    const v = state.info.version;
    if (!update) return '<button type="button" class="btn" id="vp-check">Check for updates</button>';
    if (update.status === 'checking') return '<span class="set-hint"><span class="spinner"></span> Checking for updates…</span>';
    if (update.status === 'error') return `<span class="set-hint">Couldn’t check for updates (${esc(update.message)}).</span> <button type="button" class="btn" id="vp-check">Try again</button>`;
    if (update.status === 'current') return `<span class="vp-ok">You have the latest version.</span> <button type="button" class="linkbtn" id="vp-check">Check again</button>`;
    return `<div class="vp-update"><b>Discshelf ${esc(update.version)} is available</b> (you have ${esc(v)}).
      <span class="set-hint">Update it from the Bytehawk Studio Launcher, or download the installer.</span>
      <span class="vp-buttons">${update.download ? '<button type="button" class="btn primary" id="vp-download">Download installer</button>' : ''}
      <button type="button" class="btn" id="vp-notes">Release page</button></span></div>`;
  }

  async function render() {
    const view = $('#version-view');
    if (changelog === null) {
      view.innerHTML = '<div class="tl-page"><p class="set-hint"><span class="spinner"></span></p></div>';
      try { changelog = parse(await api.changelog()); } catch { changelog = []; }
    }
    const v = state.info.version;
    view.innerHTML = `
      <div class="tl-page vp-page">
        <div class="vp-hero">
          <svg class="vp-mark" viewBox="0 0 32 32" aria-hidden="true"><circle cx="13" cy="14" r="9.5" fill="none" stroke="currentColor" stroke-width="2.2"/><circle cx="13" cy="14" r="2.6" fill="var(--accent)"/><path d="M2.5 27.5h27M26 5v22.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>
          <div><h1>Discshelf ${esc(v)}</h1>
          <div class="set-hint">© ${new Date().getFullYear()} Bytehawk Studio · Electron ${esc(state.info.electron || '')}</div>
          <div class="vp-check" id="vp-update">${updateHtml()}</div></div>
        </div>
        <h2>What’s new</h2>
        ${changelog.length ? changelog.map((r) => `
          <section class="vp-release${r.version === v ? ' current' : ''}">
            <h3>${esc(r.version)}${r.title ? ` <span class="vp-title">— ${esc(r.title)}</span>` : ''}${r.version === v ? ' <span class="vp-badge">This version</span>' : ''}</h3>
            ${r.html}
          </section>`).join('') : '<p class="set-hint">The list of changes isn’t available.</p>'}
      </div>`;
    ctx.renderStatus();
  }

  async function check({ quiet = false } = {}) {
    update = { status: 'checking' };
    if (state.view === 'version') $('#vp-update').innerHTML = updateHtml();
    try {
      const r = await api.checkUpdate();
      const newer = r.version && cmp(r.version, state.info.version) > 0;
      update = { status: newer ? 'available' : 'current', ...r };
      if (newer && quiet) toast(`Discshelf ${r.version} is available. Update it from the Bytehawk Studio Launcher (Help → What’s New has the details).`);
    } catch (err) {
      update = { status: 'error', message: String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') };
      if (quiet) update = null;
    }
    if (state.view === 'version') { const el = $('#vp-update'); if (el) el.innerHTML = updateHtml(); }
    return update;
  }

  function setup() {
    $('#version-view').addEventListener('click', (e) => {
      const a = e.target.closest('a[href^="https://"]');
      if (a) { e.preventDefault(); api.openUrl(a.href); return; }
      const id = e.target.closest('button')?.id;
      if (id === 'vp-check') check();
      if (id === 'vp-download' && update) api.openUrl(update.download);
      if (id === 'vp-notes' && update) api.openUrl(update.url);
    });
  }

  /** On start: open the page once after an update, and quietly check GitHub for a newer version. */
  function onStart() {
    const v = state.info.version;
    const seen = state.settings.lastSeenVersion;
    ctx.saveSettings({ lastSeenVersion: v });
    const updated = seen ? cmp(v, seen) > 0 : state.tracks.length > 0; // no record + a library = updated from 0.4 or older
    if (state.settings.checkUpdates !== false && !/--smoke-test/.test(navigator.userAgent)) setTimeout(() => check({ quiet: true }), 8000);
    return updated;
  }

  return { setup, render, check, onStart, status: () => `Discshelf ${state.info.version}` };
};
