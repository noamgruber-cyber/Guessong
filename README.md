# Guessong

Guess the song from the shortest possible clip. Pick a playlist, play 10 songs, and identify each one from a clip that grows from **0.5s → 1.5s → 3s → 5s → 9s → 15s** across 6 attempts. Score per-playlist leaderboards (ties go to the faster round), use point-costing hints, and challenge friends to beat you on the exact same 10 songs.

It's a mobile-first web app (installable as a PWA) with a Node/TypeScript server.

## Music sources

The game runs on a swappable music layer. Pick one per deployment with `MUSIC_PROVIDER`:

| Mode | Audio | Who can play | Use it for |
|---|---|---|---|
| `apple` (default) | 30s previews from the free **iTunes Search API**, decoded in the browser with sample-accurate timing | Anyone. No login or subscription | Public use |
| `spotify` | Full tracks through the player's **Spotify Premium** account | You + up to 4 people you allowlist | Private play with friends |
| `mock` | Offline demo catalog with synthesized audio | Anyone | Development, tests, demos |

Apple mode can also offer **Spotify games**. Add Spotify credentials, and you plus up to 4 friends can connect Spotify and play games built from your own playlists, Liked Songs, top songs and favorite genres. Everyone else keeps playing the curated playlists. See [Spotify games](#spotify-games-for-you-and-up-to-4-friends).

### ⚠️ Read before using Spotify mode

Spotify mode works, but you should know what Spotify's rules say:

- **The [Spotify Developer Policy](https://developer.spotify.com/policy/) prohibits games and trivia quizzes** ("Do not create a game, including trivia quizzes"). Its compliance guidance names a "name that tune" quiz as a disallowed use. Spotify can disable an app that breaks this.
- The policy also requires showing the track's **cover art and metadata whenever Spotify audio plays**. That's incompatible with a guessing game.
- Since February 2026, **Development Mode apps allow at most 5 users**, each added by hand in the dashboard. The app owner also needs Premium ([migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide)). Extended quota requires an established business.
- Development Mode apps **can't read Spotify's editorial playlists or other users' playlists**, and new apps get **no 30-second preview URLs**. That's why Spotify mode plays full tracks via Premium, and why curated playlists are seed lists rather than Spotify playlist IDs.

Use Spotify mode only for private play, and at your own risk. For anything public, use `apple`, or get written approval from Spotify first.

## Quick start

Requires **Node 22.13+** (the server uses the built-in `node:sqlite`).

```bash
npm install
npm run dev            # API on :8787 + web on :5173, Apple previews by default
# open http://127.0.0.1:5173
```

On first start the server resolves the curated playlists. Resolved track IDs are pinned in `server/data/pins/apple.json`, so this takes a few seconds.

To try it offline, with no network access at all:

```bash
MUSIC_PROVIDER=mock npm run dev
```

## Spotify games (for you and up to 4 friends)

In Apple mode with `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` set, the home screen shows **Your Spotify games**. A player connects Spotify and picks what to play:

- **Liked Songs** or **Your Top Songs** (short, medium and long term combined)
- a **genre**, like "Your Mizrahi" or "Your Hip-Hop & Rap". Genres come from the Spotify genre tags of the artists you listen to, grouped into broad genres. A genre is offered once it has at least 16 of your songs.
- one of **your playlists**

How a game is built:

- Spotify supplies the song list only. Each song is matched to a **Deezer 30-second preview**, by exact ISRC first, then by title and artist with covers and karaoke versions skipped.
- Nobody needs Premium, and clips are timed precisely on every device, iPhone included.
- A game keeps up to 150 songs. Songs without a preview are skipped, and a game needs at least 13.
- Matching runs in the background with a progress bar, usually 10–30 seconds. Matches are cached, so later games are faster.
- Guess suggestions in these rounds come from Deezer's whole catalog, and the result card links back to the song on Spotify.
- Games are **private**: only the person who built one sees it on their home screen. Each game has its own leaderboard, and a challenge link lets anyone play it.

Spotify's limits:

- **5 users.** Spotify's Development Mode allows the app owner plus at most 4 more accounts, each added by hand. Wider access is only granted to companies.
- **Only your own playlists.** Development Mode apps can read playlists the user owns or collaborates on, not ones they only follow. Those show up greyed out with an explanation. To play one, copy its songs into a playlist of your own.
- **Policy.** The same caveat as Spotify mode applies (see above): Spotify's policy prohibits games, so keep this private.

Setup:

1. Create an app at the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and select **Web API**.
2. Add the redirect URI, which must match exactly:
   - on Render: `https://YOUR-APP.onrender.com/api/v1/auth/spotify/callback`
   - locally: `http://127.0.0.1:5173/api/v1/auth/spotify/callback`
3. Under **User Management**, add the name and Spotify email of each friend (max 5 including you). Anyone not on the list sees "This Spotify account isn't on Guessong's invite list yet."
4. Set `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`. On Render that's the service's **Environment** tab, then **Save, rebuild and deploy**. Locally it's `.env`. Leave `MUSIC_PROVIDER` as `apple`.

## Spotify mode setup

1. Create an app at the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and select **Web API** and **Web Playback SDK**.
2. Add the redirect URIs, which must match exactly. Spotify rejects `localhost`, so use `127.0.0.1`:
   - development: `http://127.0.0.1:5173/api/v1/auth/spotify/callback`
   - production: `https://YOUR-DOMAIN/api/v1/auth/spotify/callback`
3. Under **User Management**, add the Spotify account of every person who will play (max 5).
4. Configure `.env` (see `.env.example`):
   ```bash
   MUSIC_PROVIDER=spotify
   SPOTIFY_CLIENT_ID=…
   SPOTIFY_CLIENT_SECRET=…
   SPOTIFY_MARKET=US
   ```
5. Run `npm run dev`, open the app, tap **Connect**, and sign in with a Premium account.

**Where the music plays:**

- **Desktop browsers and Android Chrome:** the in-browser Spotify player (Web Playback SDK). Clips are timed locally, to within about ±50ms.
- **iPhone and iPad:** browsers there don't support Spotify's in-browser player reliably, so the game uses **Connect mode**. Open the Spotify app, play and pause any song once, then pick the phone under *Profile → Playback device*. The server starts each clip and schedules its pause, so timing is close but less precise (network latency). `SPOTIFY_CONNECT_COMP_MS` adds a small correction if clips sound short.
- **Your own playlists:** playlists you own can be added from *Profile → Add a playlist from your library*. Each gets its own leaderboard. This is the only kind of Spotify playlist a Development Mode app can read.

Spotify has no "preview hook", so a clip starts about 30% into the full track, which usually lands near the first chorus. To pin a better start for a seed, use `{"title": "…", "artist": "…", "startAt": "1:02"}`.

## How the game works

**Clips.**
- When a song loads, it auto-plays 0 → 0.5s.
- **Skip** auto-plays only the newly unlocked slice (for example 1.5s → 3s).
- **▶** replays everything unlocked, from 0.
- A **wrong guess** unlocks more audio and waits for ▶.
- On attempt 6 the skip button becomes **Reveal**.
- The result card keeps the song playing in the background.

**Scoring.**
- A correct guess earns 100 / 80 / 60 / 40 / 20 / 10 points on attempts 1–6, and a miss earns 0, so a round's maximum is 1000.
- Round time counts only time spent on each song: from its first play to its answer. Loading and result screens don't count.
- Leaderboards rank by best score, then the faster time.

**Hints.** Your spec left the meaning of the hint numbers open. I treated them as **flat penalties on that song's reward**, with a floor so that a correct answer is still worth at least 5:

`points = max(5, base(attempt) − Σ penalties)`

| Hint | Penalty | Available |
|---|---|---|
| Artist | 75 | from attempt 1 |
| Song (masked title, e.g. `C••• O• E•••••`) | 100 | from attempt 3 |
| Cover | 85 | from attempt 1 |

All of these are configurable with `HINT_PENALTIES`, `SONG_HINT_UNLOCK_ATTEMPT` and `MIN_POINTS_WITH_HINTS`.

**Guess search.** Suggestions come from the provider's *whole* catalog, never just the playlist, so they don't give the answer away.

- Live results from the iTunes Search API come first.
- That API allows only about 20 calls a minute per server. So the server also ships a local catalog of about 23,500 songs in `server/data/catalog/`: up to 50 songs by every artist in the curated playlists and in Apple's current top-100 chart, for each storefront. `aliases.json` there lists other spellings of artist names, so "נועה קירל" also finds songs Apple lists under "Noa Kirel". Live versions and medleys rank below the studio song.
- When Apple is rate-limiting, or returns only a few results, suggestions come from that catalog, ranked by text match and popularity. Being in the playlist plays no part in the ranking.
- Rebuild the catalog after changing the playlists with `npm run build-catalog`. It takes about 10 minutes, because it paces itself to Apple's limit.

**Answer matching.** Guesses come from autocomplete over the provider's *whole* catalog, not just the playlist. The server looks up the guessed track itself; it never trusts titles sent by the client. A guess is correct on an id or ISRC match, or when the canonical title and the artist both match:

- edition tags like *(Single Edit)*, *- 2011 Remaster* and *feat. X* are stripped
- accents and punctuation are ignored, and small typos are tolerated in longer titles, but numbers must match ("Part 1" is not "Part 2")
- the artists must share at least one credited artist

For example, with *Come On Eileen (Single Edit)* by *Dexys Midnight Runners & Kevin Rowland* as the answer:
- *Come On Eileen* by *Dexys Midnight Runners* is **correct**
- *Come On Eileen* by *Pickin' On Series* is **wrong**

**Challenges.** A challenge link (`/c/CODE`) replays the challenger's exact 10 songs in the same order. The result shows who won.

## Architecture

```
shared/   game rules, scoring, timeline math, answer matching, API types (used by both sides)
server/   Fastify + node:sqlite
  src/providers/   apple.ts · spotify.ts · mock.ts behind one MusicProvider interface · deezer.ts (previews for Spotify games)
  src/services/    catalog (ingestion, track cache) · catalogIndex (local autocomplete) · rounds · playlists/leaderboards
                   search · library (Spotify games) · users
  src/routes/      auth · game · spotify · library
  data/            playlists.json (curated seeds) · pins/apple.json (resolved ids) · catalog/ (autocomplete catalog)
web/      React + Vite
  src/audio/       PreviewEngine (Web Audio) · SpotifySdkEngine · SpotifyConnectEngine
  src/game/        machine.ts (round state machine) · useGame.ts (API + audio orchestration)
  src/screens/     Discovery + pre-game sheet · Play (game, loading, result) · Summary · Leaderboard · Challenge
```

**Anti-spoiler.**
- Song payloads never contain the title, artist, artwork or track id before the song is resolved, unless a hint unlocked them.
- Preview audio streams through `/api/v1/rounds/:id/songs/:id/audio`, so the URL reveals nothing. Nothing is stored; bytes pass through.
- In Spotify mode the server starts playback, so the track URI never appears in this app's API.
- Scoring and timing are server-side.
- One limit: in Spotify mode the Spotify player itself knows what's playing, so a determined player could look it up.

**Fallback tracks.** Each round reserves 3 spare songs. If a song's audio fails to load before it has been heard, the client swaps in a spare and the round continues.

### API (all under `/api/v1`)

| Method & path | Purpose |
|---|---|
| `GET /me`, `POST /auth/guest`, `PATCH /me`, `POST /auth/logout` | Session (anonymous guests) and display name |
| `GET /auth/spotify/login`, `GET /auth/spotify/callback`, `POST /me/spotify/disconnect` | Spotify OAuth (Authorization Code flow; tokens encrypted at rest) |
| `GET /playlists?lang=&filter=popular\|unplayed` | Discovery grid, themed and language chips (`lang` takes either), recently played |
| `GET /playlists/:id/summary`, `GET /playlists/:id/leaderboard?page=&limit=` | Pre-game sheet (top 3) and full leaderboard |
| `POST /rounds {playlistId, challengeCode?}`, `GET /rounds/:id` | Start a round (10 songs + 3 fallbacks), or resume one |
| `POST /rounds/:id/songs/:songId/start\|skip\|hint\|guess\|reveal\|replace` | Song actions |
| `GET /rounds/:id/songs/:songId/audio` | Preview stream (Apple and mock modes) |
| `POST /rounds/:id/complete`, `GET /rounds/:id/summary` | Finish the round and update bests and ranks |
| `POST /rounds/:id/challenge`, `POST /playlists/:id/challenge`, `GET /challenges/:code` | Challenges |
| `GET /search?q=&playlistId=` | Autocomplete. Cached; falls back to known tracks when rate-limited |
| `GET /spotify/token\|devices\|playlists`, `POST /rounds/:id/songs/:songId/spotify/load\|play`, `POST /spotify/pause`, `POST /playlists/import` | Spotify mode |
| `GET /library`, `POST /library/games {kind: liked\|top\|genre\|playlist}`, `GET /library/jobs/:id`, `DELETE /library/games/:playlistId` | Spotify games (Apple mode) |

## Curating playlists

Edit `server/data/playlists.json`. Each playlist is a list of `["Title", "Artist"]` seeds, with a language and a storefront. A seed can carry a third item, a fun fact shown on the answer card (`["Waterloo", "ABBA", "🇸🇪 Sweden · Eurovision winner 1974"]`). It never appears before the song is resolved. Then run:

```bash
npm run ingest -- --write-pins        # resolves new seeds and pins their ids (Apple)
npm run ingest -- --only 80s-hits --force
```

Hebrew playlists: Israeli Hits, Mizrahi Hits, Israeli Classics, New Israeli Pop and Israeli Rock, 40 songs each except Israeli Hits (26). Their songs are each artist's most popular tracks on Apple's Israeli store, with ids pinned.

**Themed shelves.** `"collection": "eurovision"` or `"themes"` puts a playlist on a themed chip, which Discovery shows before the language chips (`COLLECTIONS` in `shared/src/languages.ts`). A themed playlist still appears on its language's shelf. A playlist that mixes languages uses `"lang": "multi"` and appears only on its theme.

| Shelf | Playlists |
| --- | --- |
| 🎤 Eurovision | Eurovision Winners (58), Eurovision Bangers (49, the famous ones that mostly didn't win), Israel at Eurovision (41, Hebrew shelf too). Every song's answer card shows the country, year and placing, checked against Wikipedia |
| ✨ Themes | Movie Hits (42) and Disney Songs (42), whose answer cards name the film; One-Hit Wonders (43), Christmas Hits (42), Army Band Classics (45, Hebrew shelf too) |

The international themed playlists use the UK store (`GB`), the best match for Eurovision's catalog.

The command lists any seeds it couldn't match. Some originals aren't in a given storefront, and the matcher deliberately rejects covers and karaoke versions. Israeli-store titles are in Hebrew script, so write those seeds in Hebrew.

## Deploying

```bash
npm run build
NODE_ENV=production SESSION_SECRET=$(openssl rand -hex 32) PUBLIC_URL=https://your-domain npm start
```

- A `Dockerfile` is included; mount `/data` for the SQLite database.
- The server serves the built web app, and HTTPS is needed for Spotify mode and for sharing.
- Back up the `.sqlite` file. It holds users, rounds and leaderboards.

### Render (free, works from a phone)

`render.yaml` describes the service, so there's nothing to configure:

1. Sign in at [dashboard.render.com](https://dashboard.render.com) with GitHub.
2. Choose **New → Blueprint**, give Render access to this repository, and pick the branch.
3. Choose **Deploy Blueprint**. The first build takes about 5 minutes. The app is then at `https://guessong-….onrender.com`.

The server reads its public address from `RENDER_EXTERNAL_URL`, and Render generates `SESSION_SECRET`. On the free plan the service sleeps after 15 idle minutes, so the next visit takes about a minute to wake it.

**Keeping data on the free plan.** Render's free plan wipes the disk every time the service sleeps, restarts or redeploys. Without a backup, players lose their sign-in, Spotify connection, Spotify games and leaderboards. A free Postgres database keeps a copy:

1. Sign up at [neon.tech](https://neon.tech) (free, no card) and create a project in a region near your Render service.
2. Copy the connection string: **Connect → Connection string**. It looks like `postgresql://…@ep-….neon.tech/neondb?sslmode=require`.
3. In Render, under **Environment**, add `BACKUP_DATABASE_URL` with that value, then save and deploy.

How the backup works:
- On start the server restores the saved copy. The log says `✓ Database backup: restored the saved copy`, or `no saved copy yet` on the first run.
- It saves a compressed copy whenever something changed, at most every 30 seconds, and once more on shutdown. The live database is still SQLite.
- If the backup can't be read at start, backups stay off for that run, so an empty database never overwrites the saved copy.

On a paid plan you can attach a disk at `/data` instead.

## Testing

```bash
npm test                          # 74 unit + API tests: rules, matching, search, full rounds, Spotify mode and Spotify games (simulated APIs)
npm run build && npm run test:e2e # in Chromium: a full round with clip-timing checks, then a Spotify game against a fake Spotify + Deezer
```

The e2e test needs Playwright with Chromium installed (`npx playwright install chromium`). Screenshots go to `e2e-screenshots/`.

## Differences from the original spec, and next steps

- **Web/PWA instead of React Native.** A native iOS app would need Spotify's iOS SDK (App Remote) for precise Spotify timing on iPhone. Apple mode already has precise timing on iPhone through Web Audio.
- **SQLite instead of Postgres + Redis.** Leaderboards are SQL window queries. `compositeLeaderboardScore()` in `shared/src/rules.ts` gives the single sortable number for a Redis ZSET when you scale out.
- **Guest accounts** (plus Spotify login in Spotify mode) instead of Sign in with Apple/Google. Guests are upgraded in place when they connect Spotify.
- **Curated playlists are our own seed lists**, titled "Guessong Picks", rather than Apple or Spotify editorial playlists.
- **Apple's limits.** The iTunes Search API allows about 20 calls per minute per server IP. Search is cached and throttled, but a larger audience should move to the Apple Music API with a developer token. That's a new provider behind the same interface.
