'use strict';
/* Sleep timer: stop after 15–90 minutes (fading out over the last 30 seconds), at the end of the
   song, or at the end of the album. */
window.DSModules = window.DSModules || {};
window.DSModules.sleep = (ctx) => {
  const { $, I, state, api, toast, fmtTime } = ctx;
  const FADE = 30;
  let mode = 'off';
  let endAt = 0;
  let timer = null;
  let fading = false;

  const LABELS = { 15: '15 minutes', 30: '30 minutes', 45: '45 minutes', 60: '1 hour', 90: '1½ hours', song: 'the end of this song', album: 'the end of this album' };

  function restoreVolume() {
    fading = false;
    ctx.eq.setMaster(1, 0.2);
  }

  function finish() {
    const was = mode;
    set('off', { quiet: true });
    ctx.audio.pause();
    // Put the volume back once playback has stopped, so the next play isn't silent.
    setTimeout(restoreVolume, 400);
    toast(was === 'song' || was === 'album' ? 'Sleep timer: stopped at the end of the ' + (was === 'song' ? 'song.' : 'album.') : 'Sleep timer: playback stopped. Good night.');
  }

  function tick() {
    if (mode === 'off') return;
    if (endAt) {
      const left = (endAt - Date.now()) / 1000;
      if (left <= 0) { finish(); return; }
      if (left <= FADE && !fading && !ctx.audio.paused) { fading = true; ctx.eq.setMaster(0, left); }
    } else if (mode === 'song' || (mode === 'album' && ctx.isLastOfAlbum())) {
      // Fade over the last few seconds of the song.
      const a = ctx.audio;
      const left = (a.duration || 0) - a.currentTime;
      if (Number.isFinite(left) && left > 0 && left <= 6 && !fading && !a.paused) { fading = true; ctx.eq.setMaster(0, left); }
    }
    render();
  }

  /** Called when a song ends: true means stop instead of playing the next one. */
  function onEnded() {
    if (mode === 'song' || (mode === 'album' && ctx.isLastOfAlbum())) { finish(); return true; }
    return false;
  }

  function set(m, { quiet = false } = {}) {
    clearInterval(timer);
    timer = null;
    if (fading) restoreVolume();
    mode = m || 'off';
    endAt = /^\d+$/.test(mode) ? Date.now() + parseInt(mode, 10) * 60000 : 0;
    if (mode !== 'off') timer = setInterval(tick, 1000);
    api.setSleepState(mode);
    render();
    if (!quiet) toast(mode === 'off' ? 'Sleep timer off.' : `Sleep timer: music stops at ${LABELS[mode]}.`);
  }

  function render() {
    const el = $('#fp-sleep');
    if (mode === 'off') { el.hidden = true; return; }
    el.hidden = false;
    const text = endAt ? fmtTime(Math.max(0, (endAt - Date.now()) / 1000)) : mode === 'song' ? 'song' : 'album';
    el.innerHTML = `${I.moon}<span>${text}</span>`;
    el.title = endAt ? `Sleep timer: stops in ${text}. Click to turn off.` : `Sleep timer: stops at ${LABELS[mode]}. Click to turn off.`;
  }

  function setup() {
    $('#fp-sleep').addEventListener('click', () => set('off'));
    // Pausing during the fade: put the volume back so a later play isn't silent.
    ctx.audio.addEventListener('pause', () => { if (fading && mode !== 'off') { fading = false; ctx.eq.setMaster(1, 0.1); } });
    ctx.audio.addEventListener('play', () => { if (mode !== 'off' && endAt && (endAt - Date.now()) / 1000 <= FADE) { fading = true; ctx.eq.setMaster(0, Math.max(0.5, (endAt - Date.now()) / 1000)); } });
  }

  return { setup, set, tick, onEnded, mode: () => mode, state: () => ({ mode, endAt }) };
};
