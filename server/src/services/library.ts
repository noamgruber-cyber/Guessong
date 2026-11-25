import {
  artistsOverlap,
  normalizeArtist,
  normalizeTitle,
  stripEditionTags,
  titlesMatch,
  type LibraryGenreDTO,
  type LibraryJobDTO,
  type LibraryOverviewDTO,
  type LibrarySourceDTO,
} from '@guessong/shared';
import type { Config } from '../config';
import { all, get, run, tx, type Db } from '../db';
import { ApiError, newId, now, shuffle } from '../lib/util';
import type { DeezerClient } from '../providers/deezer';
import type { LibraryTrack, SpotifyApi, SpotifyArtistInfo } from '../providers/spotify';
import { SpotifyApiError } from '../providers/spotify';
import type { ProviderTrack } from '../providers/types';
import { MIN_PLAYLIST_TRACKS, NOISE_WORDS, type Catalog, type PlaylistRow } from './catalog';
import type { Playlists } from './playlists';
import type { Users } from './users';

/**
 * Games built from a player's own Spotify library: Liked Songs, top songs, playlists
 * they own, and genre games grouped from the artists they listen to.
 *
 * Spotify only supplies the song list. Each song is matched to a Deezer 30-second
 * preview (exact ISRC lookup first, then title + artist search), so players don't
 * need Premium and clips are timed precisely on every device, iPhone included.
 * Matches are cached in `track_links` for everyone.
 */

/** Most songs one game keeps (more variety for replays, bounded matching time). */
export const MAX_GAME_TRACKS = 150;
/** Smallest genre group offered as a game (some songs won't have a preview). */
const MIN_GENRE_SONGS = MIN_PLAYLIST_TRACKS + 3;
const LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const SCAN_TTL_MS = 60 * 60 * 1000;
const MAX_ARTIST_LOOKUPS = 60;

/** Spotify genre tags → broad game genres. Order matters only for display ties. */
export const GENRE_BUCKETS: { key: string; label: string; test: RegExp }[] = [
  { key: 'mizrahi', label: 'Mizrahi', test: /mizrahi|mediterranean|yemenite/ },
  { key: 'israeli', label: 'Israeli', test: /israeli|hebrew|\bisrael/ },
  { key: 'hiphop', label: 'Hip-Hop & Rap', test: /hip hop|hip-hop|\brap\b|trap|drill|grime|boom bap/ },
  { key: 'rock', label: 'Rock', test: /rock|punk|grunge|\bemo\b|post-hardcore/ },
  { key: 'metal', label: 'Metal', test: /metal|djent/ },
  { key: 'electronic', label: 'Electronic & Dance', test: /edm|house|techno|trance|dubstep|electro|\bdance\b|drum and bass|dnb|uk garage|hardstyle|disco/ },
  { key: 'rnb', label: 'R&B & Soul', test: /r&b|\brnb\b|soul|funk|motown/ },
  { key: 'indie', label: 'Indie & Alternative', test: /indie|alternative|shoegaze|dream pop|bedroom/ },
  { key: 'latin', label: 'Latin', test: /latin|reggaeton|urbano|salsa|bachata|cumbia|corrido|sertanejo|brazil|\bmpb\b/ },
  { key: 'kpop', label: 'K-Pop', test: /k-pop|korean/ },
  { key: 'country', label: 'Country & Folk', test: /country|folk|americana|bluegrass|singer-songwriter/ },
  { key: 'jazz', label: 'Jazz & Blues', test: /jazz|blues|swing|bossa/ },
  { key: 'reggae', label: 'Reggae & Afro', test: /reggae|dancehall|\bska\b|afrobeat|amapiano/ },
  { key: 'turkish', label: 'Turkish', test: /turkish|türk|arabesk/ },
  { key: 'arabic', label: 'Arabic', test: /\barab|khaleeji|egyptian|lebanese/ },
  { key: 'french', label: 'French', test: /french|chanson|francoton/ },
  { key: 'german', label: 'German', test: /german|deutsch|schlager/ },
  { key: 'pop', label: 'Pop', test: /pop/ },
];

/** Broad genres for one artist's Spotify tags. "Pop" only when nothing more specific fits. */
export function bucketsFor(genres: string[]): string[] {
  const tags = genres.map((g) => g.toLowerCase());
  const keys = GENRE_BUCKETS.filter((b) => tags.some((t) => b.test.test(t))).map((b) => b.key);
  return keys.length > 1 ? keys.filter((k) => k !== 'pop') : keys;
}

interface Scan {
  at: number;
  status: 'scanning' | 'ready' | 'error';
  liked: LibraryTrack[];
  top: LibraryTrack[];
  genres: (LibraryGenreDTO & { trackIds: string[] })[];
  promise?: Promise<void>;
}

interface Job extends LibraryJobDTO {
  userId: string;
  createdAt: number;
}

function dedupe(tracks: LibraryTrack[]): LibraryTrack[] {
  const seen = new Set<string>();
  return tracks.filter((t) => {
    const k = `${normalizeTitle(t.title)}|${normalizeArtist(t.artists[0] ?? '')}`;
    if (seen.has(t.id) || seen.has(k)) return false;
    seen.add(t.id);
    seen.add(k);
    return true;
  });
}

export class Library {
  private scans = new Map<string, Scan>();
  private jobs = new Map<string, Job>();
  private profileIds = new Map<string, { id: string; name: string; at: number }>();

  constructor(
    private db: Db,
    private users: Users,
    private spotify: SpotifyApi,
    private deezer: DeezerClient,
    private catalog: Catalog,
    private playlists: Playlists,
    private config: Config,
  ) {}

  private token(userId: string) {
    return this.users.spotifyAccessToken(userId).then((t) => t.accessToken);
  }

  private async profile(userId: string, token: string) {
    const cached = this.profileIds.get(userId);
    if (cached && cached.at > now() - 10 * 60_000) return cached;
    const me = await this.spotify.me(token);
    const p = { id: me.id, name: me.displayName, at: now() };
    this.profileIds.set(userId, p);
    return p;
  }

  games(userId: string) {
    return all<PlaylistRow>(
      this.db,
      "SELECT * FROM playlists WHERE source_type = 'library' AND owner_user_id = ? AND status = 'ready' ORDER BY updated_at DESC",
      userId,
    ).map((p) => this.playlists.card(p, userId));
  }

  async overview(userId: string): Promise<LibraryOverviewDTO> {
    const token = await this.token(userId);
    const me = await this.profile(userId, token);
    const [likedCount, playlists] = await Promise.all([this.spotify.savedTracksTotal(token), this.spotify.myPlaylists(token)]);
    const scan = this.freshScan(userId);
    if (!scan) void this.startScan(userId);
    const current = this.scans.get(userId);
    return {
      displayName: me.name,
      likedCount,
      playlists: playlists
        .map((p) => ({
          id: p.id,
          name: p.name,
          imageUrl: p.imageUrl,
          trackCount: p.trackCount,
          readable: p.ownerId === me.id || p.collaborative,
        }))
        .sort((a, b) => Number(b.readable) - Number(a.readable)),
      genres: current?.status === 'ready' ? current.genres.map(({ key, label, count }) => ({ key, label, count })) : [],
      genresStatus: current?.status ?? 'idle',
      games: this.games(userId),
    };
  }

  private freshScan(userId: string): Scan | undefined {
    const s = this.scans.get(userId);
    if (!s) return undefined;
    if (s.status === 'error' && s.at < now() - 60_000) return undefined;
    if (s.status === 'ready' && s.at < now() - SCAN_TTL_MS) return undefined;
    return s;
  }

  /** Reads Liked Songs, top songs and artist genres in the background. */
  startScan(userId: string): Promise<void> {
    const existing = this.freshScan(userId);
    if (existing?.promise) return existing.promise;
    const scan: Scan = { at: now(), status: 'scanning', liked: [], top: [], genres: [] };
    this.scans.set(userId, scan);
    scan.promise = this.runScan(userId, scan).catch((e) => {
      scan.status = 'error';
      scan.at = now();
      if (!(e instanceof ApiError || e instanceof SpotifyApiError)) console.error('library scan failed', e);
    });
    return scan.promise;
  }

  async waitForScan(userId: string): Promise<Scan> {
    await this.startScan(userId);
    const s = this.scans.get(userId)!;
    if (s.status !== 'ready') throw new ApiError(502, 'scan_failed', "Couldn't read your Spotify library, try again in a minute");
    return s;
  }

  private async runScan(userId: string, scan: Scan) {
    const token = await this.token(userId);
    const [liked, short, medium, long, topArtistsMedium, topArtistsLong] = await Promise.all([
      this.spotify.savedTracks(token, 500),
      this.spotify.topTracks(token, 'short_term'),
      this.spotify.topTracks(token, 'medium_term'),
      this.spotify.topTracks(token, 'long_term'),
      this.spotify.topArtists(token, 'medium_term'),
      this.spotify.topArtists(token, 'long_term'),
    ]);
    scan.liked = dedupe(liked);
    scan.top = dedupe([...short, ...medium, ...long]);

    // Genres come from artists. Top artists arrive with genres; look up the most
    // frequent remaining artists one by one (no batch endpoint in Development Mode).
    const artists = new Map<string, SpotifyArtistInfo>();
    for (const a of [...topArtistsMedium, ...topArtistsLong]) artists.set(a.id, a);
    const all = dedupe([...scan.liked, ...scan.top]);
    const freq = new Map<string, number>();
    for (const t of all) for (const id of t.artistIds.slice(0, 1)) freq.set(id, (freq.get(id) ?? 0) + 1);
    const missing = [...freq.entries()]
      .filter(([id]) => !artists.has(id))
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_ARTIST_LOOKUPS)
      .map(([id]) => id);
    for (let i = 0; i < missing.length; i += 5) {
      const found = await Promise.all(missing.slice(i, i + 5).map((id) => this.spotify.artist(token, id).catch(() => null)));
      for (const a of found) if (a) artists.set(a.id, a);
    }

    const groups = new Map<string, string[]>();
    for (const t of all) {
      const genres = t.artistIds.flatMap((id) => artists.get(id)?.genres ?? []);
      for (const key of bucketsFor(genres)) groups.set(key, [...(groups.get(key) ?? []), t.id]);
    }
    scan.genres = GENRE_BUCKETS.filter((b) => (groups.get(b.key)?.length ?? 0) >= MIN_GENRE_SONGS)
      .map((b) => ({ key: b.key, label: b.label, count: groups.get(b.key)!.length, trackIds: groups.get(b.key)! }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    scan.status = 'ready';
    scan.at = now();
  }

  // ---------------------------------------------------------------------------
  // Building a game
  // ---------------------------------------------------------------------------

  job(userId: string, jobId: string): LibraryJobDTO {
    const j = this.jobs.get(jobId);
    if (!j || j.userId !== userId) throw new ApiError(404, 'job_not_found', 'That game is no longer being built');
    const { userId: _u, createdAt: _c, ...dto } = j;
    return dto;
  }

  createGame(userId: string, source: LibrarySourceDTO): LibraryJobDTO {
    for (const [id, j] of this.jobs) if (j.createdAt < now() - 60 * 60_000) this.jobs.delete(id);
    const running = [...this.jobs.values()].find((j) => j.userId === userId && j.status === 'running');
    if (running) return this.job(userId, running.id);
    const job: Job = {
      id: newId(12),
      userId,
      createdAt: now(),
      title: null,
      status: 'running',
      phase: 'reading',
      done: 0,
      total: 0,
      matched: 0,
      playlistId: null,
      error: null,
    };
    this.jobs.set(job.id, job);
    void this.buildGame(job, source).catch((e) => {
      job.status = 'error';
      if (e instanceof ApiError) job.error = { code: e.code, message: e.message };
      else if (e instanceof SpotifyApiError && e.status === 403) {
        job.error = { code: 'spotify_forbidden', message: "Spotify didn't allow reading that. Is your account on the app's invite list?" };
      } else {
        console.error('library game failed', e);
        job.error = { code: 'build_failed', message: "Couldn't build that game, try again in a minute" };
      }
    });
    return this.job(userId, job.id);
  }

  private async sourceTracks(userId: string, source: LibrarySourceDTO) {
    const token = await this.token(userId);
    switch (source.kind) {
      case 'liked': {
        const scan = this.freshScan(userId);
        const liked = scan?.status === 'ready' ? scan.liked : dedupe(await this.spotify.savedTracks(token, 500));
        return { slug: 'liked', title: 'Liked Songs', imageUrl: null, tracks: liked };
      }
      case 'top': {
        const scan = this.freshScan(userId);
        const top =
          scan?.status === 'ready'
            ? scan.top
            : dedupe((await Promise.all((['short_term', 'medium_term', 'long_term'] as const).map((r) => this.spotify.topTracks(token, r)))).flat());
        return { slug: 'top', title: 'Your Top Songs', imageUrl: null, tracks: top };
      }
      case 'genre': {
        const scan = await this.waitForScan(userId);
        const g = scan.genres.find((x) => x.key === source.key);
        if (!g) throw new ApiError(404, 'genre_not_found', 'That genre is no longer in your library');
        const byId = new Map([...scan.liked, ...scan.top].map((t) => [t.id, t]));
        return { slug: `genre-${g.key}`, title: `Your ${g.label}`, imageUrl: null, tracks: g.trackIds.map((id) => byId.get(id)!).filter(Boolean) };
      }
      case 'playlist': {
        const meta = await this.spotify.playlistMeta(token, source.id);
        if (!meta) throw new ApiError(404, 'playlist_not_found', 'Playlist not found');
        const tracks = dedupe(await this.spotify.playlistLibraryTracks(token, source.id));
        if (!tracks.length) {
          throw new ApiError(
            400,
            'playlist_unreadable',
            "Spotify only lets this app read playlists you own or collaborate on. Copy it to a playlist of your own and try again.",
          );
        }
        const image = meta.images?.length ? [...meta.images].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0].url : null;
        return { slug: `pl-${source.id.toLowerCase()}`, title: meta.name, imageUrl: image, tracks };
      }
    }
  }

  private async buildGame(job: Job, source: LibrarySourceDTO) {
    const src = await this.sourceTracks(job.userId, source);
    job.title = src.title;
    const candidates = shuffle(src.tracks.filter((t) => (t.durationMs ?? 60_000) >= 45_000)).slice(0, MAX_GAME_TRACKS);
    job.phase = 'matching';
    job.total = candidates.length;

    const matched: { from: LibraryTrack; to: ProviderTrack }[] = [];
    let next = 0;
    const worker = async () => {
      while (next < candidates.length) {
        const t = candidates[next++];
        const m = await this.match(t).catch(() => null);
        if (m) {
          matched.push({ from: t, to: m });
          job.matched = matched.length;
        }
        job.done++;
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));

    if (matched.length < MIN_PLAYLIST_TRACKS) {
      throw new ApiError(
        400,
        'too_few_songs',
        `Only ${matched.length} of these songs have a preview clip, and a game needs ${MIN_PLAYLIST_TRACKS}. Try a bigger playlist.`,
      );
    }

    job.phase = 'saving';
    const id = `lib-${job.userId}-${src.slug}`.slice(0, 120);
    const t0 = now();
    // Keep the source order where there is one (playlists), shuffled otherwise.
    const order = new Map(src.tracks.map((t, i) => [t.id, i]));
    matched.sort((a, b) => (order.get(a.from.id) ?? 0) - (order.get(b.from.id) ?? 0));
    tx(this.db, () => {
      run(
        this.db,
        `INSERT INTO playlists (id, provider, title, description, lang, storefront, artwork_url, source_type, source_ref, owner_user_id, status, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'en', ?, ?, 'library', ?, ?, 'ready', 2000, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, description = excluded.description,
           artwork_url = excluded.artwork_url, source_ref = excluded.source_ref, status = 'ready', updated_at = excluded.updated_at`,
        id,
        this.catalog.providerId,
        src.title,
        `From your Spotify · ${matched.length} songs`,
        this.config.spotify.market.toLowerCase(),
        src.imageUrl,
        JSON.stringify(source),
        job.userId,
        t0,
        t0,
      );
      run(this.db, 'DELETE FROM playlist_tracks WHERE playlist_id = ?', id);
      const seen = new Set<string>();
      let pos = 0;
      for (const { from, to } of matched) {
        if (seen.has(to.id)) continue;
        seen.add(to.id);
        this.catalog.upsertTrack(to, 0);
        // The reveal links to the song on Spotify, where the player knows it from.
        if (from.externalUrl) this.catalog.setExternalUrl(to.id, from.externalUrl);
        run(this.db, 'INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)', id, to.id, pos++);
      }
    });
    job.playlistId = id;
    job.status = 'done';
  }

  /** Spotify track → Deezer track with a preview, or null. Cached in track_links. */
  async match(t: LibraryTrack): Promise<ProviderTrack | null> {
    const link = get<{ deezer_id: string | null; matched_at: number }>(
      this.db,
      'SELECT deezer_id, matched_at FROM track_links WHERE spotify_id = ?',
      t.id,
    );
    if (link) {
      const fresh = link.matched_at > now() - (link.deezer_id ? LINK_TTL_MS : MISS_TTL_MS);
      if (fresh && !link.deezer_id) return null;
      if (fresh && link.deezer_id) {
        const d = await this.deezer.getTrack(link.deezer_id);
        if (d?.previewUrl) return d;
      }
    }

    let found: ProviderTrack | null = null;
    if (t.isrc) {
      const d = await this.deezer.trackByIsrc(t.isrc);
      if (d?.previewUrl && (artistsOverlap(t.artists, d.artists) || titlesMatch(t.title, d.title))) found = d;
    }
    if (!found) found = pickMatch(t, await this.deezer.searchTrack(stripEditionTags(t.title), t.artists[0] ?? ''));
    run(
      this.db,
      `INSERT INTO track_links (spotify_id, deezer_id, matched_at) VALUES (?, ?, ?)
       ON CONFLICT(spotify_id) DO UPDATE SET deezer_id = excluded.deezer_id, matched_at = excluded.matched_at`,
      t.id,
      found?.id ?? null,
      now(),
    );
    return found;
  }
}

/** Best Deezer candidate for a Spotify track: same song, same artist, has a preview, not a cover/live take. */
export function pickMatch(t: ProviderTrack, candidates: ProviderTrack[]): ProviderTrack | null {
  const wantNoise = NOISE_WORDS.test(t.title);
  const ok = candidates.filter((c) => c.previewUrl && titlesMatch(t.title, c.title) && artistsOverlap(t.artists, c.artists));
  if (!ok.length) return null;
  const score = (c: ProviderTrack) => {
    let s = 0;
    if (!wantNoise && NOISE_WORDS.test(`${c.title} ${c.album ?? ''}`)) s -= 10;
    if (normalizeTitle(c.title) === normalizeTitle(t.title)) s += 2;
    if (t.durationMs && c.durationMs && Math.abs(t.durationMs - c.durationMs) < 5_000) s += 1;
    return s;
  };
  return ok.map((c, i) => ({ c, s: score(c) - i * 0.01 })).sort((a, b) => b.s - a.s)[0].c;
}
