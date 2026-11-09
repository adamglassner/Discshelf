'use strict';
/* Accent colors: a chosen accent, or the colors of the album that's playing ("Album colors"). */
window.DSModules = window.DSModules || {};
window.DSModules.colors = (ctx) => {
  const { state, artUrl } = ctx;
  const PROPS = ['--accent', '--accent-hover', '--accent-fg', '--pane-active', '--pane-active-fg', '--sel-bg', '--sel-inactive-bg', '--playing-fg',
    '--play-bg', '--play-fg', '--track-fill', '--tint'];
  const cache = new Map(); // art file -> [r,g,b] | null
  let wanted = '';

  const ACCENTS = [
    ['', 'Theme'], ['#2a66d4', 'Blue'], ['#0f8b8d', 'Teal'], ['#2f9e44', 'Green'], ['#e8590c', 'Orange'],
    ['#e03131', 'Red'], ['#d6336c', 'Pink'], ['#7048e8', 'Purple'], ['#5c5f66', 'Graphite'],
  ];

  // ---------------------------------------------------------------- color maths

  function rgbToHsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b); const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
  }

  function hslToRgb([h, s, l]) {
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [f(0), f(8), f(4)].map((x) => Math.round(x * 255));
  }

  const hex = (rgb) => `#${rgb.map((x) => x.toString(16).padStart(2, '0')).join('')}`;
  const parseHex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const lum = (rgb) => { const c = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const contrast = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

  /** The most striking color of an image: frequent, saturated, not too dark or light. */
  function pickColor(img) {
    const size = 32;
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, size, size);
    let data;
    try { data = g.getImageData(0, 0, size, size).data; } catch { return null; }
    const buckets = new Map();
    for (let i = 0; i < data.length; i += 4) {
      const [h, s, l] = rgbToHsl([data[i], data[i + 1], data[i + 2]]);
      if (l < 0.08 || l > 0.94) continue;
      const k = `${Math.round(h / 20)}|${Math.round(s * 3)}|${Math.round(l * 4)}`;
      const b = buckets.get(k) || { n: 0, r: 0, g: 0, b: 0, s };
      b.n++; b.r += data[i]; b.g += data[i + 1]; b.b += data[i + 2];
      buckets.set(k, b);
    }
    let best = null; let bestScore = 0;
    for (const b of buckets.values()) {
      const score = b.n * (0.15 + b.s * b.s);
      if (score > bestScore) { bestScore = score; best = b; }
    }
    return best ? [best.r / best.n, best.g / best.n, best.b / best.n].map(Math.round) : null;
  }

  /** Adjusts a color so it reads well as an accent on this theme's background. */
  function fit(rgb, dark) {
    let [h, s, l] = rgbToHsl(rgb);
    s = Math.max(s, 0.35) * (s < 0.12 ? 0.3 : 1); // greys stay grey-ish
    l = dark ? Math.min(Math.max(l, 0.55), 0.72) : Math.min(Math.max(l, 0.32), 0.5);
    let out = hslToRgb([h, s, l]);
    const bg = dark ? [27, 28, 31] : [255, 255, 255];
    for (let i = 0; i < 12 && contrast(out, bg) < 3.2; i++) { l += dark ? 0.03 : -0.03; out = hslToRgb([h, s, l]); }
    return out;
  }

  // ---------------------------------------------------------------- applying

  function apply(rgb) {
    const root = document.documentElement.style;
    if (!rgb) { for (const p of PROPS) root.removeProperty(p); return; }
    const dark = /dark/.test(document.documentElement.dataset.theme);
    const classic = document.documentElement.dataset.style === 'classic';
    const c = fit(rgb, dark);
    const [h, s, l] = rgbToHsl(c);
    const accent = hex(c);
    const fg = lum(c) > 0.35 ? '#10131a' : '#ffffff';
    const set = (k, v) => root.setProperty(k, v);
    set('--accent', accent);
    set('--accent-hover', hex(hslToRgb([h, s, Math.max(0, Math.min(1, l + (dark ? 0.06 : -0.06)))])));
    set('--accent-fg', fg);
    set('--playing-fg', accent);
    set('--tint', `rgba(${c.join(',')}, ${dark ? 0.12 : 0.09})`);
    if (!classic) {
      set('--pane-active', `rgba(${c.join(',')}, ${dark ? 0.18 : 0.13})`);
      set('--pane-active-fg', hex(hslToRgb([h, s, dark ? Math.max(l, 0.7) : Math.min(l, 0.4)])));
      set('--sel-bg', hex(hslToRgb([h, s, dark ? 0.4 : Math.min(l, 0.45)])));
      set('--sel-inactive-bg', `rgba(${c.join(',')}, ${dark ? 0.22 : 0.16})`);
      set('--play-bg', accent);
      set('--play-fg', fg);
      set('--track-fill', accent);
    }
  }

  function chosenAccent() {
    const a = state.settings.accent;
    return /^#[0-9a-f]{6}$/i.test(a || '') ? parseHex(a) : null;
  }

  /** Re-applies colors for the current song / settings / theme. */
  function update() {
    const t = state.current;
    const fallback = chosenAccent();
    if (!state.settings.albumColors || !t || !t.art || state.radio) { wanted = ''; apply(fallback); return; }
    wanted = t.art;
    if (cache.has(t.art)) { apply(cache.get(t.art) || fallback); return; }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const rgb = pickColor(img);
      cache.set(t.art, rgb);
      if (cache.size > 300) cache.delete(cache.keys().next().value);
      if (wanted === t.art) apply(rgb || fallback);
    };
    img.onerror = () => { cache.set(t.art, null); if (wanted === t.art) apply(fallback); };
    img.src = artUrl(t);
  }

  return { update, ACCENTS };
};
