'use strict';
/* Volume leveling: measures the loudness of songs that have no ReplayGain tags (ITU-R BS.1770 / EBU R128
   style: K-weighting, 400 ms blocks, absolute and relative gates), one song at a time in the background. */
window.DSModules = window.DSModules || {};
window.DSModules.leveling = (ctx) => {
  const { state, api } = ctx;
  const RATE = 22050; // plenty for loudness, and half the memory
  let running = false;
  let stopFlag = false;
  let progress = { done: 0, total: 0 };
  const failed = new Set();
  const listeners = new Set();

  const needs = (t) => t.rgTrack === null && !Number.isFinite(t.lufs) && !failed.has(t.id) && t.codec !== 'ALAC'
    && t.duration > 0 && t.duration < 1800;

  /** Integrated loudness (LUFS) of one song, or null. */
  async function measure(t) {
    const res = await fetch(`discshelf://media/${encodeURIComponent(t.id)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.arrayBuffer();
    // Decoding needs a context; the offline one resamples to RATE as it decodes.
    const decodeCtx = new OfflineAudioContext(2, RATE, RATE);
    const decoded = await decodeCtx.decodeAudioData(data);
    const ch = Math.min(2, decoded.numberOfChannels);
    const off = new OfflineAudioContext(ch, decoded.length, RATE);
    const src = off.createBufferSource();
    src.buffer = decoded;
    // K-weighting: a high shelf (+4 dB above ~1.7 kHz) and a high-pass at ~38 Hz.
    const shelf = off.createBiquadFilter();
    shelf.type = 'highshelf'; shelf.frequency.value = 1681.97; shelf.gain.value = 4;
    const hp = off.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 38.14; hp.Q.value = 0.5;
    src.connect(shelf).connect(hp).connect(off.destination);
    src.start();
    const out = await off.startRendering();
    // 400 ms blocks overlapping by 75 %.
    const block = Math.round(RATE * 0.4);
    const step = Math.round(block / 4);
    const chans = [...Array(ch).keys()].map((c) => out.getChannelData(c));
    const energies = [];
    for (let s = 0; s + block <= out.length; s += step) {
      let sum = 0;
      for (const d of chans) { let e = 0; for (let i = s; i < s + block; i++) e += d[i] * d[i]; sum += e / block; }
      energies.push(sum);
    }
    if (!energies.length) return null;
    const lufs = (e) => -0.691 + 10 * Math.log10(e);
    const abs = energies.filter((e) => e > 0 && lufs(e) > -70);
    if (!abs.length) return null;
    const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const relGate = lufs(mean(abs)) - 10;
    const gated = abs.filter((e) => lufs(e) > relGate);
    return Math.round(lufs(mean(gated.length ? gated : abs)) * 100) / 100;
  }

  function emit() { for (const fn of listeners) fn(progress); }

  /** Measures every song that needs it. Songs that are playing or next go first. */
  async function run() {
    if (running || (state.settings.leveling || 'off') === 'off') return;
    running = true;
    stopFlag = false;
    try {
      for (;;) {
        if (stopFlag || (state.settings.leveling || 'off') === 'off') break;
        const todo = state.tracks.filter(needs);
        progress = { done: progress.done, total: progress.done + todo.length, running: true };
        emit();
        if (!todo.length) break;
        const first = [state.current && state.current.id, ...state.upNext].filter(Boolean);
        const t = todo.find((x) => first.includes(x.id)) || todo[0];
        // Stay out of the way: wait while a song is starting or the window is busy.
        await new Promise((r) => setTimeout(r, document.hidden ? 50 : 400));
        try {
          const l = await measure(t);
          if (l === null) failed.add(t.id);
          else {
            t.lufs = l;
            api.setLoudness(t.id, l);
            if (state.current && state.current.id === t.id) ctx.eq.deckLevel(ctx.audio, ctx.levelGain(t));
          }
        } catch (err) {
          console.warn('Loudness scan failed for', t.path, err.message);
          failed.add(t.id);
        }
        progress.done++;
      }
    } finally {
      running = false;
      progress = { ...progress, running: false };
      emit();
    }
  }

  /** Album loudness from the measured songs (energy average, weighted by length). */
  function albumGain(t) {
    if (!t.album) return null;
    const artist = t.albumArtist || t.artist;
    let w = 0; let e = 0;
    for (const x of state.tracks) {
      if (x.album !== t.album || (x.albumArtist || x.artist) !== artist) continue;
      const l = x.rgTrack !== null && x.rgTrack !== undefined ? -18 - x.rgTrack : x.lufs;
      if (!Number.isFinite(l)) continue;
      w += x.duration || 1;
      e += (x.duration || 1) * 10 ** (l / 10);
    }
    return w ? Math.round((-18 - 10 * Math.log10(e / w)) * 100) / 100 : null;
  }

  function pending() { return state.tracks.filter(needs).length; }

  return {
    run, albumGain, pending, measure,
    stop: () => { stopFlag = true; },
    progress: () => progress,
    onProgress: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
};
