'use strict';
/* Visualizer: bars, a waveform or a ring around the album art, drawn from the music that's playing. */
window.DSModules = window.DSModules || {};
window.DSModules.visualizer = (ctx) => {
  const { $, esc, I, state, artUrl } = ctx;
  const STYLES = [['bars', 'Bars'], ['wave', 'Wave'], ['circle', 'Circle']];
  let open = false;
  let raf = 0;
  let canvas; let g;
  let freq = null; let wave = null;
  let peaks = [];
  let color = [91, 150, 255];
  let artImg = null; let artSrc = '';
  let spin = 0;

  const style = () => (STYLES.some(([k]) => k === state.settings.visualizer) ? state.settings.visualizer : 'bars');

  function readColor() {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    const m = /^#([0-9a-f]{6})$/i.exec(v);
    if (m) color = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  }

  const rgba = (a, lighten = 0) => `rgba(${color.map((c) => Math.round(c + (255 - c) * lighten)).join(',')},${a})`;

  function renderInfo() {
    const t = state.current;
    const r = state.radio;
    const url = r ? '' : artUrl(t);
    if (url !== artSrc) {
      artSrc = url;
      $('#viz-bg').style.backgroundImage = url ? `url("${url}")` : 'none';
      artImg = null;
      if (url) { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => { if (artSrc === url) artImg = im; }; im.src = url; }
    }
    $('#viz-info').innerHTML = t || r
      ? `${url ? `<img src="${esc(url)}" alt="">` : ''}<div><div class="t">${esc(r ? (r.song ? r.song.title : r.title || r.station.name) : t.title)}</div>
        <div class="a">${esc(r ? (r.song ? r.song.artist : r.station.name) : [t.artist, t.album].filter(Boolean).join(' — '))}</div></div>`
      : '<div><div class="t">Nothing playing</div></div>';
    $$('#viz-styles [data-viz]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.viz === style())));
    readColor();
  }
  const $$ = (s) => [...document.querySelectorAll(s)];

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
  }

  /** Frequency bins grouped into `n` bands on a log scale (low notes get as much room as high ones). */
  function bands(n) {
    const out = new Array(n).fill(0);
    const bins = freq.length;
    const minF = 2; const maxF = bins * 0.72;
    for (let i = 0; i < n; i++) {
      const a = Math.floor(minF * (maxF / minF) ** (i / n));
      const b = Math.max(a + 1, Math.floor(minF * (maxF / minF) ** ((i + 1) / n)));
      let s = 0;
      for (let k = a; k < b; k++) s = Math.max(s, freq[k]);
      out[i] = s / 255;
    }
    return out;
  }

  function draw() {
    raf = 0;
    if (!open) return;
    const an = ctx.eq.analyser();
    const W = canvas.width; const H = canvas.height;
    g.clearRect(0, 0, W, H);
    if (an) {
      if (!freq || freq.length !== an.frequencyBinCount) { freq = new Uint8Array(an.frequencyBinCount); wave = new Float32Array(an.fftSize); }
      an.getByteFrequencyData(freq);
      an.getFloatTimeDomainData(wave);
      const s = style();
      if (s === 'bars') drawBars(W, H);
      else if (s === 'wave') drawWave(W, H);
      else drawCircle(W, H);
    }
    raf = requestAnimationFrame(draw);
  }

  function drawBars(W, H) {
    const n = Math.max(24, Math.min(96, Math.floor(W / (14 * (window.devicePixelRatio || 1)))));
    const v = bands(n);
    if (peaks.length !== n) peaks = new Array(n).fill(0);
    const gap = W / n * 0.28;
    const bw = W / n - gap;
    const base = H * 0.8;
    const maxH = H * 0.62;
    const grad = g.createLinearGradient(0, base - maxH, 0, base);
    grad.addColorStop(0, rgba(1, 0.55));
    grad.addColorStop(1, rgba(0.9, 0));
    for (let i = 0; i < n; i++) {
      const h = Math.max(2, v[i] ** 1.6 * maxH);
      const x = i * (bw + gap) + gap / 2;
      g.fillStyle = grad;
      roundRect(x, base - h, bw, h, Math.min(bw / 2, 6));
      // reflection
      g.fillStyle = rgba(0.12);
      roundRect(x, base + 4, bw, h * 0.35, Math.min(bw / 2, 6));
      peaks[i] = Math.max(peaks[i] - maxH * 0.006, h);
      g.fillStyle = rgba(0.95, 0.75);
      g.fillRect(x, base - peaks[i] - 6, bw, 3);
    }
  }

  function roundRect(x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
    g.lineTo(x + w, y + h); g.lineTo(x, y + h); g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
    g.fill();
  }

  function drawWave(W, H) {
    const mid = H * 0.5;
    const amp = H * 0.34;
    const n = wave.length;
    const stepPx = Math.max(1, W / 400);
    for (const [width, alpha, scale] of [[10, 0.12, 1.05], [5, 0.25, 1.02], [2.2, 1, 1]]) {
      g.beginPath();
      for (let x = 0; x <= W; x += stepPx) {
        const i = Math.floor((x / W) * (n - 1));
        const y = mid + wave[i] * amp * scale * 1.6;
        if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.strokeStyle = rgba(alpha, 0.35);
      g.lineWidth = width * (window.devicePixelRatio || 1);
      g.lineJoin = 'round';
      g.stroke();
    }
    // soft glow from the bass
    const bass = bands(8).slice(0, 3).reduce((a, b) => a + b, 0) / 3;
    const rad = g.createRadialGradient(W / 2, mid, 0, W / 2, mid, W * 0.5);
    rad.addColorStop(0, rgba(0.18 * bass));
    rad.addColorStop(1, rgba(0));
    g.fillStyle = rad;
    g.fillRect(0, 0, W, H);
  }

  function drawCircle(W, H) {
    const cx = W / 2; const cy = H * 0.46;
    const R = Math.min(W, H) * 0.2;
    const n = 120;
    const v = bands(n / 2);
    const bass = v.slice(0, 6).reduce((a, b) => a + b, 0) / 6;
    const r0 = R * (1 + bass * 0.08);
    spin += 0.0016 + bass * 0.004;
    g.save();
    g.translate(cx, cy);
    g.rotate(spin);
    g.lineCap = 'round';
    for (let i = 0; i < n; i++) {
      const val = v[i < n / 2 ? i : n - 1 - i]; // mirrored, so low notes meet at the top and bottom
      const len = 4 + val ** 1.5 * R * 1.1;
      const a = (i / n) * Math.PI * 2;
      g.strokeStyle = rgba(0.55 + val * 0.45, val * 0.5);
      g.lineWidth = Math.max(2, (Math.PI * 2 * r0) / n * 0.55);
      g.beginPath();
      g.moveTo(Math.cos(a) * (r0 + 6), Math.sin(a) * (r0 + 6));
      g.lineTo(Math.cos(a) * (r0 + 6 + len), Math.sin(a) * (r0 + 6 + len));
      g.stroke();
    }
    g.restore();
    // album art in the middle
    g.save();
    g.beginPath();
    g.arc(cx, cy, r0, 0, Math.PI * 2);
    g.closePath();
    g.clip();
    if (artImg) g.drawImage(artImg, cx - r0, cy - r0, r0 * 2, r0 * 2);
    else { g.fillStyle = rgba(0.25); g.fill(); }
    g.restore();
    g.beginPath();
    g.arc(cx, cy, r0, 0, Math.PI * 2);
    g.strokeStyle = rgba(0.6, 0.4);
    g.lineWidth = 2;
    g.stroke();
  }

  function toggle(force) {
    open = force === undefined ? !open : !!force;
    const el = $('#visualizer');
    el.hidden = !open;
    if (!open) { cancelAnimationFrame(raf); raf = 0; if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); return; }
    renderInfo();
    resize();
    if (!raf) raf = requestAnimationFrame(draw);
  }

  function setup() {
    const el = $('#visualizer');
    el.innerHTML = `<div class="viz-bg" id="viz-bg"></div><canvas id="viz-canvas"></canvas>
      <div class="viz-top"><div class="seg" id="viz-styles" role="radiogroup">${STYLES.map(([k, l]) => `<button type="button" role="radio" data-viz="${k}">${l}</button>`).join('')}</div>
        <button type="button" class="ibtn" id="viz-full" title="Full screen (F11)" aria-label="Full screen"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg></button>
        <button type="button" class="ibtn" id="viz-close" title="Close (Esc)" aria-label="Close visualizer">${I.close}</button></div>
      <div class="viz-info" id="viz-info"></div>`;
    canvas = $('#viz-canvas');
    g = canvas.getContext('2d');
    new ResizeObserver(() => { if (open) resize(); }).observe(el);
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-viz]');
      if (b) { ctx.saveSettings({ visualizer: b.dataset.viz }); renderInfo(); return; }
      if (e.target.closest('#viz-close')) { toggle(false); return; }
      if (e.target.closest('#viz-full')) { if (document.fullscreenElement) document.exitFullscreen(); else el.requestFullscreen().catch(() => {}); }
    });
    el.addEventListener('dblclick', (e) => { if (e.target === canvas) { if (document.fullscreenElement) document.exitFullscreen(); else el.requestFullscreen().catch(() => {}); } });
  }

  return { setup, toggle, isOpen: () => open, refresh: () => { if (open) renderInfo(); } };
};
