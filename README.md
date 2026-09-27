# Music

A fast, private web player for the music library in your OneDrive. It runs as a static site on GitHub Pages, signs in with your Microsoft account, and streams songs straight from OneDrive — in any browser, or as an app on your iPhone's home screen.

## What it does

- **Indexes the whole library** (built for 50,000+ songs): title, artist, album, album artist, genre, year, track, disc, length, bitrate, format, size, date added, composer, folder, and which playlists each song is on.
- **Fills in extra details in the background** (optional): record label, your old ratings and play counts saved in MP3/FLAC tags by Windows Media Player / MediaMonkey etc., public popularity and similar artists from Last.fm, labels and album-art IDs from MusicBrainz.
- **Tracks your listening**: play count, skip count, last played, and your own 1–5★ rating. Songs you skip get picked much less often in mixes (each net skip makes a song ~60% less likely); 4–5★ songs come up more.
- **A table you control**: show/hide/reorder/resize any column; every column sorts (shift-click for a secondary sort) and has its own filter.
- **Click any cell** to act on everything that shares that value — e.g. click a *Year* of 1973 → *Play all* / *Shuffle all* / *Similar mix* / *Show all* for 1973.
- **Instant mixes**: opens with a fresh shuffled mix of 20–30 songs. Search "Pink Floyd" and one tap builds a mix of similar-genre, similar-era music. Genre and decade buttons in the sidebar play a mix with a double-click.
- **Shuffle, Replay** (off / whole list / this song), save any list or the current queue as a playlist, and "keep going" with similar songs when a list ends.
- **Imports your existing playlists** (.m3u, .m3u8, .pls, .wpl, .zpl) found in the music folder.
- **Everything syncs through OneDrive** (`OneDrive/Apps/Music/`): `library.json.gz` (the database) and `userdata.json` (plays, skips, ratings, playlists). Your phone and computer stay in step, and play counts from both are added together rather than overwritten.

## One-time setup (about 10 minutes)

### 1. Put the site on GitHub Pages
1. Create a new repository named **`music`** at github.com (it can be public; no secrets live in these files).
2. Upload everything in this folder (keep the folder structure: `index.html`, `css/`, `js/`, `vendor/`, `icons/`, `sw.js`, `manifest.webmanifest`, `.nojekyll`).
3. In the repo: **Settings → Pages → Build and deployment → Source: Deploy from a branch → `main` / `(root)` → Save.**
4. After a minute the site is live at **`https://jhomnick.github.io/music/`** (swap in your GitHub username if different).

### 2. Register the app with Microsoft (free)
1. Go to **https://entra.microsoft.com** (or portal.azure.com) → **App registrations → New registration**. If a personal Microsoft account is asked to create a directory/Azure account first, accept the free option — app registrations cost nothing.
2. **Name:** `Music` (this also names the OneDrive folder `Apps/Music`).
3. **Supported account types:** *Accounts in any organizational directory and personal Microsoft accounts*.
4. **Redirect URI:** platform **Single-page application (SPA)**, URL `https://jhomnick.github.io/music/` (exactly as the setup screen shows it, including the trailing slash).
5. Click **Register**, then copy the **Application (client) ID**.
6. (Optional) **API permissions**: *User.Read* is there by default; the app asks for *Files.ReadWrite* when you first sign in. No client secret is needed.

### 3. First run
1. Open the site, paste the client ID, and (optionally) a Last.fm API key.
2. Sign in with the Microsoft account that holds your music and accept the permissions.
3. Pick your music folder (your OneDrive *Music* folder is suggested at the top).
4. The first scan reads OneDrive's own index of your files — roughly 200 files per request — so 50,000 songs take a few minutes. The library is then saved to `OneDrive/Apps/Music/library.json.gz`, and on other devices it simply downloads.
5. When offered, start **Fill in more details**. It runs while the app is open, saves progress every couple of minutes, and resumes next time. Reading tags touches only the first few KB of each MP3/FLAC.

### 4. Put it on your iPhone
Open the site in Safari → **Share → Add to Home Screen**. It opens full-screen like an app, keeps playing in the background, and shows lock-screen controls with album art.

### Optional: Last.fm key
Get a free key at https://www.last.fm/api/account/create (any app name; callback URL can be blank). It powers *Public Rating* (how widely each song is listened to), "similar artists" for better mixes, and genres for untagged songs. Add it on the setup screen or in **Settings**.

## Using it

| Want to… | Do this |
|---|---|
| Play a song | Double-click the row, click its cover, or click a cell → *Play* |
| Play everything from a year / artist / genre / label… | Click that cell → *Play all* / *Shuffle all* / *Similar mix* |
| Quick mix like an artist | Search the artist → tap **Mix like …** |
| Fresh random mix | **New Random Mix** in the sidebar, or **Mix** with nothing searched |
| Mix from any list | Filter/search or open a list, then **Mix** |
| Save the current list | The *save* icon next to Mix (in *Now Playing* it saves the queue) |
| Rate a song | Click the stars in the *My Rating* column or the player |
| Choose columns | Columns icon (desktop) or Settings → *Choose columns* (phone) |

**Column filters** (funnel icon): text columns match anything containing the text; `=Rush` means exactly, `!live` excludes, `^The` starts with, `=` alone finds blanks. Number columns take `>256`, `<=3`, `1970-1979`, `=5`; time takes `>5:00`; dates take `<30d` (within 30 days) or `>2024-01-01`.

**Keyboard:** Space play/pause · N next · P previous · S shuffle · R replay mode · / search.

**How plays and skips are counted:** a play counts once you've actually heard half the song or 4 minutes, whichever comes first (seeking ahead doesn't count). A skip counts when you press Next (or pick another song) before that point. *Previous* is never a skip. Click any cell of a song → *Reset play & skip counts* if something got mis-counted.

## Good to know

- **Formats:** MP3, AAC/M4A, FLAC, WAV and OGG play in modern browsers (FLAC and OGG on recent iOS). WMA, APE and DRM-protected files are listed but greyed out — browsers can't decode them. Convert them to M4A or FLAC if you want them playable.
- **Privacy:** there is no server. Files stream from OneDrive to your browser. The only outside lookups are the optional Last.fm and MusicBrainz ones, which send artist, album and track names. Nothing else leaves OneDrive.
- **New music:** the app checks OneDrive for added, changed or removed files automatically (at most every 12 hours), or on demand via Settings → *Check for new music*. This uses OneDrive's change feed, so it takes seconds.
- **Work/school OneDrive:** OneDrive for Business sometimes doesn't index audio details. The app then uses folder names (`Artist/Album/01 Title.mp3`) until *Fill in more details* reads the tags.
- **Demo:** the setup screen has *Try the demo library* — 50,000 generated songs that play short tones — handy for trying the interface.

## Testing on your computer
Serve the folder locally (`python3 -m http.server 8000`) and add `http://localhost:8000/` as a second SPA redirect URI in the app registration.

## Files
```
index.html            app page
css/app.css           styles
js/main.js            UI: views, table, menus, dialogs, player bar
js/table.js           virtual table (only visible rows are drawn)
js/player.js          playback, queue, shuffle/replay, play & skip counting, lock screen
js/mix.js             weighted random + similar mixes
js/scanner.js         OneDrive delta scan
js/library.js         library model and local storage
js/userdata.js        plays/skips/ratings/playlists with conflict-free multi-device merge
js/sync.js            OneDrive app-folder sync
js/enrich.js          tags, Last.fm, MusicBrainz enrichment
js/tags.js            ID3v2 / FLAC tag reader (HTTP range requests)
js/art.js, source.js  cover art lookup and caching
js/playlists.js       .m3u/.pls/.wpl import
js/view.js            columns, filters, sorting
js/graph.js, auth.js  Microsoft Graph + sign-in (MSAL.js in vendor/)
js/demo.js            demo library
sw.js, manifest       offline shell + home-screen app
```
