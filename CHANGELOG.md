# Changelog

## 0.6.0

- **Gapless playback.** The next song is loaded while the current one plays, so albums meant to flow from one track into the next (live albums, DJ mixes, concept albums) play without a gap.
- **Crossfade.** Settings → Playback: let songs fade into each other over 1 to 10 seconds.
- **Volume leveling.** Settings → Playback: play every song at about the same loudness (**Songs**), or keep each album at one level so its quiet songs stay quiet (**Albums**). Uses ReplayGain from your files (including Opus R128 gain) and measures the loudness of songs without it in the background, the same way broadcasters do (EBU R128).
- **Lyrics.** A Lyrics tab in the album art pane (View → Lyrics, Ctrl+Shift+L). Discshelf reads lyrics from a .lrc file next to the song, from the music file, or looks them up on LRCLIB. Synced lyrics follow the song with the current line highlighted; click a line to jump there. Online lookup can be turned off in Settings.
- **Visualizer.** Bars, a waveform, or a ring around the album art, over a blurred backdrop of the cover. Open it with the button in the player bar, View → Visualizer (Ctrl+Shift+V) or by double-clicking the artwork in the player; double-click it for full screen, Esc to close.

## 0.5.0

- **Playlists.** Make playlists in the new Playlists section of the sidebar (the **+** button or Ctrl+N), then drag songs, albums or artists onto them, or right-click songs and choose **Add to Playlist**. Drag songs within a playlist to change the order; press Delete to take a song out of the playlist (it stays in your library). Right-click a playlist to play, shuffle, rename, duplicate, export it as an .m3u file, or delete it. **File → Import Playlist** reads .m3u and .m3u8 files.
- **Up Next.** Right-click songs, albums or playlists and choose **Play Next** or **Add to Up Next**. They play before the rest of the list you started. The Up Next button in the player bar (Ctrl+U) shows what's coming; drag to reorder, double-click to play, or drop songs on it.
- **Ratings and Loved.** Give songs one to five stars and a heart, in the song list, the player or the right-click menu. Both are saved into the music files (so other players see them), and loving a song also loves it on Last.fm when you're connected. Sort by Rating or Loved.
- **Sleep timer** (Playback → Sleep Timer): stop after 15 minutes to 1½ hours, fading out over the last 30 seconds, or at the end of the song or album. The player shows how long is left; click it to turn the timer off.
- **Statistics:** your library in numbers, most played songs, artists and albums, listening time by month, formats, genres and decades, and a **Year in review** for each year you listen.
- **Duplicates:** finds songs that are in your library more than once, picks the best copy (lossless first, then the highest bitrate) and keeps it, moving plays, ratings and playlists over. The other files can go to the Recycle Bin.
- **Missing info:** albums without artwork, genre, year or track numbers, songs without an album or artist, and titles that look like file names, each with a one-click fix (looked up online) and a Fix all.
- **New look options:** an **iTunes** style (white, like iTunes 12) in light and dark, a choice of accent colors, and **Album colors**, which tints Discshelf with the colors of the album that's playing (Settings → Appearance).
- **Version page:** Help → What's New (or Settings → About) shows the version you have, what's new in every release, and checks for updates. It opens by itself once after Discshelf updates.

## 0.4.0

- **Changes are saved into the music files.** Details and artwork you change in Get Info (by hand, from an online lookup, or with Find Missing Album Artwork) are now written into the files themselves, so other players and Windows see them too. Works with MP3, FLAC, M4A (AAC and Apple Lossless), Ogg Vorbis, Opus and WAV. Each file is written to a copy first, read back and checked, and only then swapped in for the original; the audio itself isn't touched. You can turn this off in Settings, and Settings offers to save changes you made in 0.2 and 0.3 into the files.
- **Radio songs are scrobbled to Last.fm.** When a station says what it's playing (most music stations do), Discshelf shows the artist and title, sends "Now playing" to Last.fm and scrobbles the song once you've heard enough of it (half the song or 4 minutes, using the song's length from Last.fm; 2 minutes when Last.fm doesn't know it). Station names, ads and announcements aren't scrobbled. The album art pane shows the scrobble status and the songs heard recently on the station.

## 0.3.0

- **Artists:** a new Artists view, like iTunes: every artist with their photo and how many albums and songs you have, and an artist page with Play and Shuffle, each album with its songs, and an About box (bio, styles and similar artists from Last.fm; similar artists in your library are links). Right-click a song and choose **Go to Artist**.
- **Radio:** listen to live radio from around the world (from the free Radio Browser directory). Browse top stations by country, pick a genre, or search by name; star stations to keep them in Favorites. The player shows the song the station is playing, the equalizer works on radio too, and Next / Previous move between stations.
- **Get Info:** when you look up an album online and use it, Discshelf now gets the album's track list and gives each song its title and track number (and disc number). It matches your songs by title, then track number, then file order, and shows the matches so you can fix any before saving.

## 0.2.0

- **Albums:** a new Albums view in the library, like iTunes: Recently Added along the top, then all your albums as artwork. Click an album to open its page (big artwork, song list, Play, Shuffle, Get Info); hover over a cover to play it straight away. Right-click a song and choose **Go to Album**.
- **Get Info** (right-click a song or album, or Ctrl+I): type in the title, artist, album artist, album, genre, year, and track and disc numbers yourself; choose, paste or drag in artwork, or remove it; or search iTunes and Deezer and use a result's details, artwork or both. Edit several songs at once. Changes are kept in your Discshelf library and survive rescans; your music files aren't changed.
- **Find missing album artwork** for your whole library in one go (File menu or Settings).
- **Equalizer:** 10 bands, preamp and the usual presets (Rock, Pop, Jazz, Bass Booster and more). Button in the player bar.
- **Last.fm scrobbling:** connect your account in Settings. Discshelf sends "Now playing" and scrobbles each song once you've heard half of it (or 4 minutes); scrobbles made offline are sent later.
- **Settings page:** appearance, music folders, playback, equalizer, song info & artwork, Last.fm, and about.
- **Classic now has light and dark:** Songbird's silver-and-white look as well as the charcoal one. Choose **Modern** or **Classic**, then **Follow Windows**, **Light** or **Dark**. If you used Classic in 0.1.0, you'll get Classic in dark mode.
- New songs in your music folders are picked up when Discshelf starts (you can turn this off in Settings).

## 0.1.0 — first version

- Add music folders (or single files, or drag them into the window). Discshelf finds MP3, AAC/M4A, FLAC, Ogg Vorbis, Opus and WAV files, reads their tags and cover art, and keeps them in your library. Your files stay where they are.
- Library views: Music, Recently added, Most played, and one view per music folder.
- Songbird-style browsing: Genre, Artist and Album filter panes above a sortable song list, plus search.
- Player: play/pause, next/previous, seek, volume, shuffle, repeat (all or one song). Works with your keyboard's media keys.
- Album art pane for the song that's playing or the one you've selected.
- Light, Dark and Classic (Songbird colors) themes, or follow Windows.
- Rescan (F5) picks up new, changed and deleted files.
- Picks up where you left off: the last song and position are restored (paused) when you start Discshelf.
