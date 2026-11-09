'use strict';
/* The audio graph: two players ("decks", for gapless playback and crossfades), each with a fade gain
   and a volume-leveling gain → preamp → 10-band equalizer → analyser (visualizer) → master (sleep fade). */
window.DSModules = window.DSModules || {};
window.DSModules.eq = (ctx) => {
  const { esc, state } = ctx;
  const BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const LABELS = ['32', '64', '125', '250', '500', '1K', '2K', '4K', '8K', '16K'];
  const MAX_DB = 12;

  // The usual presets (dB per band, 32 Hz → 16 kHz).
  const PRESETS = {
    Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    Acoustic: [4.5, 4.5, 3.5, 1, 1.5, 1.5, 3, 3.5, 3, 1.5],
    'Bass Booster': [5.5, 4.5, 3.5, 2.5, 1.5, 0, 0, 0, 0, 0],
    'Bass Reducer': [-5.5, -4.5, -3.5, -2.5, -1.5, 0, 0, 0, 0, 0],
    Classical: [4.5, 3.5, 3, 2.5, -1.5, -1.5, 0, 2, 3, 3.5],
    Dance: [3.5, 6.5, 5, 0, 1.5, 3.5, 5, 4.5, 3.5, 0],
    Electronic: [4, 3.5, 1, 0, -2, 2, 1, 1.5, 4, 5],
    'Hip-Hop': [5, 4, 1.5, 3, -1, -1, 1.5, -0.5, 2, 3],
    Jazz: [4, 3, 1.5, 2, -1.5, -1.5, 0, 1.5, 3, 3.5],
    Loudness: [6, 4, 0, 0, -2, 0, -1, -5, 5, 1],
    Pop: [-1.5, -1, 0, 2, 4, 4, 2, 0, -1, -1.5],
    Rock: [5, 4, 3, 1.5, -0.5, -1, 0.5, 2.5, 3.5, 4.5],
    'Small Speakers': [5.5, 4.5, 4, 2.5, 2.5, 0, -1.5, -2, -1, 0],
    'Spoken Word': [-3.5, -0.5, 0, 0.5, 3.5, 4.5, 4.5, 4, 2.5, 0],
    'Treble Booster': [0, 0, 0, 0, 0, 1.5, 2.5, 3.5, 4.5, 5.5],
    'Treble Reducer': [0, 0, 0, 0, 0, -1.5, -2.5, -3.5, -4.5, -5.5],
    'Vocal Booster': [-1.5, -3, -3, 1.5, 3.5, 3.5, 3, 1.5, 0, -1.5],
  };

  let ac = null;
  let pre = null;
  let filters = [];
  let analyser = null;
  let master = null;
  const deckNodes = new Map(); // audio element -> {fade, level}

  /** Builds the audio graph once. Must run before the first song plays. */
  function init() {
    if (ac) return;
    try {
      ac = new AudioContext({ latencyHint: 'playback' });
      pre = ac.createGain();
      for (const el of ctx.decks) {
        const src = ac.createMediaElementSource(el);
        const fade = ac.createGain();
        const level = ac.createGain();
        src.connect(fade).connect(level).connect(pre);
        deckNodes.set(el, { fade, level });
        el.addEventListener('play', () => { if (ac.state !== 'running') ac.resume(); });
      }
      filters = BANDS.map((f, i) => {
        const b = ac.createBiquadFilter();
        b.type = i === 0 ? 'lowshelf' : i === BANDS.length - 1 ? 'highshelf' : 'peaking';
        b.frequency.value = f;
        b.Q.value = 1.2;
        b.gain.value = 0;
        return b;
      });
      analyser = ac.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.78;
      let node = pre;
      for (const f of filters) node = node.connect(f);
      node.connect(analyser);
      master = ac.createGain();
      analyser.connect(master);
      master.connect(ac.destination);
      apply();
    } catch (err) {
      console.error('Equalizer unavailable:', err);
      ac = null;
    }
  }

  const dbToGain = (db) => 10 ** (db / 20);

  /** Fades one deck to `value` (0–1) over `seconds` (crossfades). False when Web Audio isn't available. */
  function deckFade(el, value, seconds = 0) {
    const n = deckNodes.get(el);
    if (!n) return false;
    const t = ac.currentTime;
    n.fade.gain.cancelScheduledValues(t);
    n.fade.gain.setValueAtTime(n.fade.gain.value, t);
    if (seconds > 0) {
      // An equal-power-ish curve sounds smoother than a straight line.
      const from = n.fade.gain.value;
      const steps = 24;
      const curve = new Float32Array(steps + 1).map((_, i) => {
        const x = i / steps;
        return value > from ? from + (value - from) * Math.sin((x * Math.PI) / 2) : value + (from - value) * Math.cos((x * Math.PI) / 2);
      });
      n.fade.gain.setValueCurveAtTime(curve, t, seconds);
    } else {
      n.fade.gain.setValueAtTime(value, t);
    }
    return true;
  }

  /** Volume leveling: a fixed gain for the song on this deck. */
  function deckLevel(el, gain) {
    const n = deckNodes.get(el);
    if (!n) return false;
    n.level.gain.setTargetAtTime(gain, ac.currentTime, 0.05);
    return true;
  }

  /** Fades the whole output to `value` (0–1) over `seconds`; used by the sleep timer. */
  function setMaster(value, seconds = 0) {
    if (ac && master) {
      const t = ac.currentTime;
      master.gain.cancelScheduledValues(t);
      master.gain.setValueAtTime(master.gain.value, t);
      if (seconds > 0) master.gain.linearRampToValueAtTime(value, t + seconds); else master.gain.setValueAtTime(value, t);
      return true;
    }
    return false;
  }

  function apply() {
    if (!ac) return;
    const eq = state.settings.eq;
    const on = eq && eq.enabled;
    const t = ac.currentTime;
    pre.gain.setTargetAtTime(on ? dbToGain(eq.preamp || 0) : 1, t, 0.02);
    filters.forEach((f, i) => f.gain.setTargetAtTime(on ? eq.bands[i] || 0 : 0, t, 0.02));
  }

  function save(patch) {
    const eq = { ...state.settings.eq, ...patch };
    ctx.saveSettings({ eq });
    apply();
    ctx.onEqChange && ctx.onEqChange();
  }

  function summary() {
    const eq = state.settings.eq;
    return eq.enabled ? `On — ${eq.preset || 'Custom'}` : 'Off';
  }

  /** Current output level (0–1), used by tests. */
  function level() {
    if (!analyser) return 0;
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v));
    return peak;
  }

  // ---------------------------------------------------------------- the window

  function open() {
    const eq = state.settings.eq;
    const bandHtml = BANDS.map((_, i) => `
      <div class="eq-band">
        <span class="eq-val" data-val="${i}">${fmtDb(eq.bands[i])}</span>
        <span class="eq-slot"><input type="range" class="eq-slider" data-band="${i}" min="-${MAX_DB}" max="${MAX_DB}" step="0.5" value="${eq.bands[i]}" aria-label="${LABELS[i]} Hz" aria-orientation="vertical"></span>
        <span class="eq-freq">${LABELS[i]}</span>
      </div>`).join('');
    const presets = Object.keys(PRESETS).map((p) => `<option${p === eq.preset ? ' selected' : ''}>${esc(p)}</option>`).join('');
    ctx.modal(`
      <div class="eq-head">
        <h2>Equalizer</h2>
        <label class="switch-row"><span>On</span><span class="switch"><input type="checkbox" id="eq-on"${eq.enabled ? ' checked' : ''}><span></span></span></label>
      </div>
      <div class="eq-top">
        <label class="field-inline">Preset
          <select id="eq-preset">${presets}<option value="Custom"${PRESETS[eq.preset] ? '' : ' selected'}>Custom</option></select>
        </label>
        <button type="button" class="btn" id="eq-reset">Reset</button>
      </div>
      <div class="eq-body" id="eq-body">
        <div class="eq-band eq-pre">
          <span class="eq-val" data-val="pre">${fmtDb(eq.preamp)}</span>
          <span class="eq-slot"><input type="range" class="eq-slider" id="eq-preamp" min="-${MAX_DB}" max="${MAX_DB}" step="0.5" value="${eq.preamp}" aria-label="Preamp" aria-orientation="vertical"></span>
          <span class="eq-freq">Preamp</span>
        </div>
        <div class="eq-scale" aria-hidden="true"><span>+12 dB</span><span>0 dB</span><span>−12 dB</span></div>
        ${bandHtml}
      </div>
      <p class="eq-note">Boosting a lot of bands can make loud songs distort. If it does, lower the preamp.</p>
      <div class="actions"><button type="button" class="btn primary" data-result="done">Done</button></div>`, {
      onMount(root) {
        root.querySelector('.modal').classList.add('modal-wide');
        const body = root.querySelector('#eq-body');
        const sync = () => {
          const cur = state.settings.eq;
          body.classList.toggle('off', !cur.enabled);
          root.querySelectorAll('.eq-slider[data-band]').forEach((s) => { s.value = cur.bands[s.dataset.band]; });
          root.querySelectorAll('.eq-val[data-val]').forEach((v) => {
            v.textContent = fmtDb(v.dataset.val === 'pre' ? cur.preamp : cur.bands[v.dataset.val]);
          });
          root.querySelector('#eq-preamp').value = cur.preamp;
          root.querySelectorAll('.eq-slider').forEach((sl) => sl.style.setProperty('--pct', `${((parseFloat(sl.value) + MAX_DB) / (2 * MAX_DB)) * 100}%`));
          root.querySelector('#eq-preset').value = PRESETS[cur.preset] ? cur.preset : 'Custom';
        };
        sync();
        root.querySelector('#eq-on').addEventListener('change', (e) => { save({ enabled: e.target.checked }); sync(); });
        root.querySelector('#eq-preset').addEventListener('change', (e) => {
          const p = e.target.value;
          if (PRESETS[p]) save({ preset: p, bands: [...PRESETS[p]], enabled: true });
          root.querySelector('#eq-on').checked = state.settings.eq.enabled;
          sync();
        });
        root.querySelector('#eq-reset').addEventListener('click', () => { save({ preset: 'Flat', bands: [...PRESETS.Flat], preamp: 0 }); sync(); });
        body.addEventListener('input', (e) => {
          const s = e.target;
          if (!s.classList.contains('eq-slider')) return;
          const v = parseFloat(s.value);
          if (s.id === 'eq-preamp') save({ preamp: v });
          else {
            const bands = [...state.settings.eq.bands];
            bands[s.dataset.band] = v;
            // Moving a slider turns the equalizer on and makes the preset "Custom".
            save({ bands, preset: 'Custom', enabled: true });
            root.querySelector('#eq-on').checked = true;
          }
          sync();
        });
      },
    });
  }

  function fmtDb(v) {
    v = Number(v) || 0;
    return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)}`;
  }

  return { init, apply, open, summary, level, setMaster, deckFade, deckLevel, ready: () => !!ac, analyser: () => analyser, PRESETS, BANDS };
};
