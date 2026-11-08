'use strict';
// Inline SVG icons (24×24, drawn with currentColor).
(() => {
  const s = (d, extra = '') => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"${extra}>${d}</svg>`;
  const f = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">${d}</svg>`;
  window.ICONS = {
    play: f('<path d="M8 5.2v13.6c0 .8.9 1.3 1.6.9l10.6-6.8c.6-.4.6-1.4 0-1.8L9.6 4.3C8.9 3.9 8 4.4 8 5.2z"/>'),
    pause: f('<rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/>'),
    next: f('<path d="M5 6.3v11.4c0 .8.9 1.3 1.6.8l8.2-5.7c.6-.4.6-1.2 0-1.6L6.6 5.5C5.9 5 5 5.5 5 6.3z"/><rect x="16.5" y="5.5" width="2.6" height="13" rx="1.1"/>'),
    prev: f('<path d="M19 6.3v11.4c0 .8-.9 1.3-1.6.8l-8.2-5.7c-.6-.4-.6-1.2 0-1.6l8.2-5.7c.7-.5 1.6 0 1.6.8z"/><rect x="4.9" y="5.5" width="2.6" height="13" rx="1.1"/>'),
    shuffle: s('<path d="M3 7h3.2c2 0 3.2 1 4.3 2.6l2.9 4.8c1 1.6 2.3 2.6 4.3 2.6H21"/><path d="M3 17h3.2c1.4 0 2.4-.5 3.3-1.3"/><path d="M14.5 8.3c.9-.8 1.9-1.3 3.2-1.3H21"/><path d="M18.5 4.5 21 7l-2.5 2.5"/><path d="m18.5 14.5 2.5 2.5-2.5 2.5"/>'),
    repeat: s('<path d="M4 11.5V10a3.5 3.5 0 0 1 3.5-3.5H20"/><path d="M17 3.5l3 3-3 3"/><path d="M20 12.5V14a3.5 3.5 0 0 1-3.5 3.5H4"/><path d="M7 20.5l-3-3 3-3"/>'),
    repeatOne: s('<path d="M4 11.5V10a3.5 3.5 0 0 1 3.5-3.5H20"/><path d="M17 3.5l3 3-3 3"/><path d="M20 12.5V14a3.5 3.5 0 0 1-3.5 3.5H4"/><path d="M7 20.5l-3-3 3-3"/><path d="M11.3 10.4l1.3-.9v5" stroke-width="1.7"/>'),
    volume: s('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" stroke-linejoin="round"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6"/><path d="M18.2 6.4a8 8 0 0 1 0 11.2"/>'),
    volumeLow: s('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" stroke-linejoin="round"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6"/>'),
    mute: s('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" stroke-linejoin="round"/><path d="m16 9.5 5 5M21 9.5l-5 5"/>'),
    search: s('<circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.8-4.8"/>'),
    music: s('<path d="M9 17.5V6l10.5-2v11.5"/><circle cx="6.5" cy="17.5" r="2.5"/><circle cx="17" cy="15.5" r="2.5"/>'),
    recent: s('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
    top: s('<path d="m3.5 16.5 5.5-5.5 4 4 7-7"/><path d="M15 8h5v5"/>'),
    folder: s('<path d="M3.5 7.5a2 2 0 0 1 2-2h3.7l2 2.2h7.3a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>'),
    plus: s('<path d="M12 5v14M5 12h14"/>'),
    gear: s('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
    speaker: f('<path d="M3.5 9.3h3.3l4.4-3.8v13l-4.4-3.8H3.5z"/><path d="M14.4 8.6a4.6 4.6 0 0 1 0 6.8" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><path d="M17 6a8.3 8.3 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>'),
    close: s('<path d="M6 6l12 12M18 6 6 18"/>'),
    disc: s('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.2"/>'),
  };
})();
