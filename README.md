# Discshelf

A music player for the music on your computer, from Bytehawk Studio. It takes its layout from the classic Songbird media player: player controls and a "now playing" display across the top, your library on the left, Genre / Artist / Album filter panes above the song list, and album art on the right. Discshelf comes in **Light**, **Dark** and **Classic** (Songbird colors) themes.

![Discshelf's Albums view](docs/screenshots/albums.png)

| Classic light | Classic dark |
|---|---|
| ![Classic light](docs/screenshots/classic-light.png) | ![Classic dark](docs/screenshots/classic-dark.png) |
| **Modern light** | **Modern dark** |
| ![Modern light](docs/screenshots/light.png) | ![Modern dark](docs/screenshots/dark.png) |

## Download

**Windows 10/11:** get the latest release from [Releases](https://github.com/adamglassner/discshelf/releases/latest):

- `Discshelf-<version>-Setup.exe`: installer (installs for your user account, no admin rights needed)
- `Discshelf-<version>-win-x64.zip`: portable version (unzip, then run `Discshelf.exe`)

Discshelf is also listed in the **Bytehawk Studio Launcher**, which installs it and keeps it up to date.

The builds aren't code-signed yet, so Windows SmartScreen may say it "protected your PC". Click **More info → Run anyway**.

## What it does

- **Add music:** choose music folders (**File → Add Folder**, Ctrl+O), add single files, or drag folders and songs into the window. Discshelf finds **MP3, AAC (M4A), FLAC, Ogg Vorbis, Opus and WAV** files, reads their tags and cover art (embedded, or `cover.jpg` / `folder.jpg` next to the music) and adds them to your library. Your files stay where they are. New songs are picked up when Discshelf starts, or press **F5**.
- **Library:** Songs, Albums, Recently added, Most played, and one entry for each music folder.
- **Albums:** an iTunes-style grid with Recently Added along the top and all your albums below. Open an album for its artwork and song list, then Play or Shuffle it.
- **Songs:** Genre → Artist → Album filter panes, a sortable song list (click a column header) and search (Ctrl+F).
- **Play:** double-click a song or press Enter. Play/pause, next/previous, seek, volume, shuffle, and repeat (all or one song). Your keyboard's media keys work too.
- **Equalizer:** 10 bands, preamp and presets (button in the player bar, or **Playback → Equalizer**).
- **Get Info** (Ctrl+I, or right-click a song or album): edit song details and artwork yourself, or look them up on iTunes and Deezer. **File → Find Missing Album Artwork** fills in covers for your whole library. Edits are kept in your Discshelf library; your music files aren't changed.
- **Last.fm:** connect your account in **Settings** to scrobble what you play.
- **Themes:** **Modern** or **Classic** (Songbird's look), each in light or dark, or following Windows (**Settings → Appearance**).

Apple Lossless (ALAC) files are added to the library, but they can't be played yet.

Your library and settings are kept in `%APPDATA%\Discshelf` (**Settings → Open data folder**).

## Keyboard shortcuts

| | |
|---|---|
| Play / pause | Space |
| Next / previous song | Ctrl+→ / Ctrl+← |
| Volume up / down | Ctrl+↑ / Ctrl+↓ |
| Play selected song | Enter |
| Search | Ctrl+F |
| Go to the song that's playing | Ctrl+L |
| Add a folder / add files | Ctrl+O / Ctrl+Shift+O |
| Rescan library | F5 |
| Remove from library | Delete |
| Get Info | Ctrl+I |
| Settings | Ctrl+, |

## Building from source

You need [Node.js](https://nodejs.org/) 22 or newer.

```
git clone https://github.com/adamglassner/discshelf
cd discshelf
npm install
npm start          # run Discshelf
npm test           # tag reader and library tests
npm run dist       # build dist/Discshelf-<version>-Setup.exe and the portable zip (run this on Windows)
```

Discshelf is an Electron app with no other runtime dependencies. The tag reader (`src/main/tags/`) handles ID3v1/v2, FLAC, Vorbis comments, MP4 and RIFF INFO tags itself.

| Folder | What's in it |
|---|---|
| `src/main/` | Main process: window, menus, the `discshelf://` protocol that streams songs and artwork, library scanning |
| `src/main/tags/` | Reads tags, duration, format details and cover art from each file type |
| `src/main/online.js`, `src/main/lastfm.js` | iTunes / Deezer lookups, Last.fm sign-in and scrobbling |
| `src/renderer/` | The window: layout, themes, songs and albums views, Get Info, equalizer, settings, player |
| `test/` | Tests and small fixture files (`npm test`) |
| `design/mockups/` | Early design mockups for the desktop, mobile and server apps |

## Last.fm API key

Last.fm requires each app to have its own API key. To build it into the release:

1. Create an API account at <https://www.last.fm/api/account/create> (application name: Discshelf). You'll get an **API key** and a **shared secret**.
2. In this repository, go to **Settings → Secrets and variables → Actions** and add two repository secrets: `LASTFM_API_KEY` and `LASTFM_SECRET`.
3. The next release picks them up automatically.

Without them, Discshelf still works: Settings → Last.fm lets people enter their own key.

## Releasing

1. Update `version` in `package.json` and add a section to `CHANGELOG.md`.
2. Push to `main`. GitHub Actions runs the tests, builds the installer and portable zip, installs and starts both the way the launcher does, then publishes release `v<version>` with both files.

The Bytehawk Studio Launcher picks up the new release automatically. Its catalog entry downloads `Discshelf-*-win-x64.zip` and launches `Discshelf.exe`.

## Coming later

Playlists, a play queue, writing tag edits back to the music files, ALAC playback, the Discshelf server, and the mobile and macOS apps. Design mockups for these are in [`design/mockups/`](design/mockups/) ([design canvas](https://claude.ai/artifact/HXFw1C7RiSvCq4xAK6p3ZG)).

---

© 2026 Bytehawk Studio
