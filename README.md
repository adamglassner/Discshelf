# Discshelf

A music-only player and library manager: a self-hosted **Discshelf Server** that holds your music collection, plus players for **iOS & Android** and **Windows & macOS**.

## Planned pieces

| Piece | Platforms | What it does |
|---|---|---|
| Discshelf Server | Self-hosted (Docker) | Scans music folders, reads tags and artwork, manages users, streams or transcodes to players, and serves a web admin dashboard |
| Discshelf Mobile | iOS, Android | Browse the library, play albums and playlists, download for offline listening |
| Discshelf Desktop | Windows, macOS | Full library view, queue, and lossless playback (FLAC/ALAC direct play) |

## Design mockups

Design canvas: [Discshelf mockups](https://claude.ai/artifact/HXFw1C7RiSvCq4xAK6p3ZG)

Screens so far:

- **Desktop player** — library sidebar, "Recently added" album grid, most-played tracks, queue panel, player bar
- **Server dashboard** — library stats, music folders and scan progress, active streams, users, transcoding rules
- **Mobile Library**, **Album**, and **Now Playing**

The source for each screen is in [`design/mockups/`](design/mockups/). Album names, artists, and stats in the mockups are placeholders.
