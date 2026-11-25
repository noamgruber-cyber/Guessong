import { artistsOverlap, normalizeArtist, normalizeTitle, titlesMatch, FALLBACK_SONGS, SONGS_PER_ROUND } from '@guessong/shared';
import type { Config } from '../config';
import { all, get, run, tx, type Db } from '../db';
import { ApiError, now, sha1 } from '../lib/util';
import type { MusicProvider, ProviderTrack, SeedTrack } from '../providers/types';
import { UpstreamThrottledError } from '../providers/types';
import { mockTrackId } from '../providers/mock';
import { parseStartAt, seedKey, type SeedPlaylist } from '../seeds';
import type { CatalogIndex } from './catalogIndex';
import { isDeezerId, type DeezerClient } from '../providers/deezer';

export const MIN_PLAYLIST_TRACKS = SONGS_PER_ROUND + FALLBACK_SONGS;

export interface TrackRow {
  provider: string;
  id: string;
  title: string;
  artists: string;
  album: string | null;
  artwork_url: string | null;
  preview_url: string | null;
  isrc: string | null;
  duration_ms: number | null;
  uri: string | null;
  external_url: string | null;
  clip_start_ms: number;
}

export interface PlaylistRow {
  id: string;
  provider: string;
  title: string;
  description: string | null;
  lang: string;
  storefront: string;
  artwork_url: string | null;
  source_type: 'seed' | 'import' | 'library';
  source_ref: string | null;
  owner_user_id: string | null;
  status: 'pending' | 'ready' | 'error';
  status_detail: string | null;
  sort_order: number;
}

export function trackArtists(row: TrackRow): string[] {
  return JSON.parse(row.artists) as string[];
}

export function artistLine(row: TrackRow): string {
  return trackArtists(row).join(', ');
}

/**
 * Spotify has no preview "hook", so clips start partway into the full track
 * (≈30% in, which usually lands near the first chorus) unless the seed pins
 * a `startAt`. Previews (Apple) already start at a recognisable part → 0.
 */
export function defaultClipStartMs(durationMs: number | null): number {
  if (!durationMs || durationMs < 70_000) return 0;
  const target = Math.min(Math.max(durationMs * 0.3, 30_000), durationMs - 40_000);
  return Math.round(target / 500) * 500;
}

export const NOISE_WORDS = /\b(live|karaoke|instrumental|remix|acoustic|cover|tribute|re-?recorded|sped up|slowed|8-bit|lullaby|made famous|in the style of|originally performed)\b/i;

export interface IngestReport {
  playlistId: string;
  resolved: number;
  unresolved: SeedTrack[];
  status: PlaylistRow['status'];
  pins: Record<string, string>;
}

export class Catalog {
  /** Set when Spotify-library games are enabled: resolves `dz:` track ids. */
  deezer: DeezerClient | null = null;

  constructor(
    private db: Db,
    private provider: MusicProvider,
    private config: Config,
    private index?: CatalogIndex,
  ) {}

  /** Put every known main-catalog track into the autocomplete index. */
  indexKnownTracks() {
    if (!this.index) return;
    for (const r of all<TrackRow>(this.db, 'SELECT * FROM tracks WHERE provider = ?', this.provider.id)) {
      if (!r.id.startsWith('dz:')) this.index.addTrack(r.id, r.title, trackArtists(r));
    }
  }

  get providerId() {
    return this.provider.id;
  }

  upsertTrack(t: ProviderTrack, clipStartMs?: number) {
    run(
      this.db,
      `INSERT INTO tracks (provider, id, title, artists, album, artwork_url, preview_url, isrc, duration_ms, uri, external_url, clip_start_ms, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, id) DO UPDATE SET
         title = excluded.title, artists = excluded.artists, album = excluded.album,
         artwork_url = COALESCE(excluded.artwork_url, tracks.artwork_url),
         preview_url = COALESCE(excluded.preview_url, tracks.preview_url),
         isrc = COALESCE(excluded.isrc, tracks.isrc),
         duration_ms = COALESCE(excluded.duration_ms, tracks.duration_ms),
         uri = COALESCE(excluded.uri, tracks.uri),
         -- Keep an existing link: library games point at Spotify, while search results
         -- for the same Deezer track carry a Deezer link.
         external_url = COALESCE(tracks.external_url, excluded.external_url),
         clip_start_ms = CASE WHEN ? THEN excluded.clip_start_ms ELSE tracks.clip_start_ms END,
         updated_at = excluded.updated_at`,
      this.provider.id,
      t.id,
      t.title,
      JSON.stringify(t.artists),
      t.album,
      t.artworkUrl,
      t.previewUrl,
      t.isrc,
      t.durationMs,
      t.uri,
      t.externalUrl,
      clipStartMs ?? 0,
      now(),
      clipStartMs !== undefined ? 1 : 0,
    );
    if (this.index && !t.id.startsWith('dz:')) this.index.addTrack(t.id, t.title, t.artists);
  }

  /** Point a track's "Open in…" link somewhere specific (library games link to Spotify). */
  setExternalUrl(id: string, url: string) {
    run(this.db, 'UPDATE tracks SET external_url = ? WHERE provider = ? AND id = ?', url, this.provider.id, id);
  }

  getTrack(id: string): TrackRow | undefined {
    return get<TrackRow>(this.db, 'SELECT * FROM tracks WHERE provider = ? AND id = ?', this.provider.id, id);
  }

  /** Track metadata from cache, falling back to the provider (and caching it). */
  async ensureTrack(id: string, storefront: string): Promise<TrackRow | undefined> {
    const cached = this.getTrack(id);
    if (cached) return cached;
    if (isDeezerId(id)) {
      const d = this.deezer ? await this.deezer.getTrack(id) : null;
      if (!d) return undefined;
      this.upsertTrack(d);
      return this.getTrack(id);
    }
    // Songs from the static autocomplete catalog validate without an API call.
    const known = this.index?.get(id);
    if (known) {
      this.upsertTrack({
        id,
        title: known.title,
        artists: [known.artist],
        album: null,
        artworkUrl: null,
        previewUrl: null,
        isrc: null,
        durationMs: null,
        uri: null,
        externalUrl: null,
      });
      return this.getTrack(id);
    }
    const t = await this.provider.getTrack(id, { storefront });
    if (!t) return undefined;
    this.upsertTrack(t);
    return this.getTrack(id);
  }

  getPlaylist(id: string): PlaylistRow | undefined {
    return get<PlaylistRow>(this.db, 'SELECT * FROM playlists WHERE id = ? AND provider = ?', id, this.provider.id);
  }

  requireReadyPlaylist(id: string): PlaylistRow {
    const p = this.getPlaylist(id);
    if (!p || p.status !== 'ready') throw new ApiError(404, 'playlist_not_found', 'Playlist not found or not ready yet');
    return p;
  }

  playlistTrackIds(playlistId: string): string[] {
    return all<{ track_id: string }>(
      this.db,
      'SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position',
      playlistId,
    ).map((r) => r.track_id);
  }

  mosaic(playlistId: string): string[] {
    return all<{ artwork_url: string }>(
      this.db,
      `SELECT t.artwork_url FROM playlist_tracks pt
       JOIN tracks t ON t.provider = ? AND t.id = pt.track_id
       WHERE pt.playlist_id = ? AND t.artwork_url IS NOT NULL
       ORDER BY pt.position LIMIT 4`,
      this.provider.id,
      playlistId,
    ).map((r) => r.artwork_url);
  }

  /** Local search over every cached track (fallback when upstream search is throttled). */
  searchLocal(query: string, limit: number): TrackRow[] {
    const words = normalizeTitle(query).split(' ').filter((w) => w.length > 0).slice(0, 5);
    if (!words.length) return [];
    const rows = all<TrackRow>(this.db, 'SELECT * FROM tracks WHERE provider = ? LIMIT 20000', this.provider.id);
    const hits: TrackRow[] = [];
    for (const r of rows) {
      const hay = ` ${normalizeTitle(r.title)} ${normalizeTitle(trackArtists(r).join(' '))} `;
      if (words.every((w) => hay.includes(` ${w}`))) hits.push(r);
      if (hits.length >= limit) break;
    }
    return hits;
  }

  // -------------------------------------------------------------------------
  // Ingestion
  // -------------------------------------------------------------------------

  private clipStartFor(seed: SeedTrack | null, t: ProviderTrack): number {
    if (this.provider.playback === 'preview') return 0;
    return parseStartAt(seed?.startAt) ?? defaultClipStartMs(t.durationMs);
  }

  /** Pick the catalog track that best matches a seed, or null. */
  pickCandidate(seed: SeedTrack, candidates: ProviderTrack[]): ProviderTrack | null {
    const seedHasNoise = NOISE_WORDS.test(seed.title);
    const ok = candidates.filter(
      (c) =>
        titlesMatch(seed.title, c.title) &&
        artistsOverlap([seed.artist], c.artists) &&
        (this.provider.playback !== 'preview' || !!c.previewUrl),
    );
    if (!ok.length) return null;
    const score = (c: ProviderTrack) => {
      let s = 0;
      if (!seedHasNoise && NOISE_WORDS.test(`${c.title} ${c.album ?? ''}`)) s -= 10;
      if (normalizeTitle(c.title) === normalizeTitle(seed.title)) s += 2;
      if (c.artists.some((a) => normalizeArtist(a) === normalizeArtist(seed.artist))) s += 2;
      return s;
    };
    return ok.map((c, i) => ({ c, s: score(c) - i * 0.01 })).sort((a, b) => b.s - a.s)[0].c;
  }

  async resolveSeed(seed: SeedTrack, storefront: string): Promise<ProviderTrack | null> {
    for (const q of this.provider.seedQueries(seed)) {
      const results = await this.provider.searchPatiently(q, storefront);
      const pick = this.pickCandidate(seed, results);
      if (pick) return pick;
    }
    return null;
  }

  private pinnedId(seed: SeedTrack): string | undefined {
    if (this.provider.id === 'apple') return seed.apple;
    if (this.provider.id === 'spotify') return seed.spotify;
    return mockTrackId(seed.title, seed.artist);
  }

  async ingestSeedPlaylist(
    seed: SeedPlaylist,
    sortOrder: number,
    opts: { force?: boolean; log?: (msg: string) => void } = {},
  ): Promise<IngestReport | null> {
    const log = opts.log ?? (() => {});
    const sourceRef = sha1(JSON.stringify({ p: this.provider.id, t: seed.tracks.map((t) => [t.title, t.artist, t.startAt ?? '']) }));
    const existing = this.getPlaylist(seed.id);
    const t0 = now();
    if (existing && existing.source_ref === sourceRef && existing.status === 'ready' && !opts.force) {
      run(
        this.db,
        'UPDATE playlists SET title = ?, description = ?, lang = ?, storefront = ?, sort_order = ? WHERE id = ?',
        seed.title,
        seed.description,
        seed.lang,
        seed.storefront,
        sortOrder,
        seed.id,
      );
      return null;
    }
    if (!existing) {
      run(
        this.db,
        `INSERT INTO playlists (id, provider, title, description, lang, storefront, source_type, source_ref, status, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'seed', NULL, 'pending', ?, ?, ?)`,
        seed.id,
        this.provider.id,
        seed.title,
        seed.description,
        seed.lang,
        seed.storefront,
        sortOrder,
        t0,
        t0,
      );
    }

    // 1) Pinned ids in one batched lookup.
    const resolved = new Map<number, ProviderTrack>();
    const pinnedIdx = seed.tracks.map((s, i) => [i, this.pinnedId(s)] as const).filter(([, id]) => !!id);
    if (pinnedIdx.length) {
      const found = await this.provider.getTracks(
        pinnedIdx.map(([, id]) => id!),
        { storefront: seed.storefront },
      );
      const byId = new Map(found.map((t) => [t.id, t]));
      for (const [i, id] of pinnedIdx) {
        const t = byId.get(id!);
        if (t && (this.provider.playback !== 'preview' || t.previewUrl)) resolved.set(i, t);
      }
    }

    // 2) Search for the rest.
    const unresolved: SeedTrack[] = [];
    let transientFailures = 0;
    for (let i = 0; i < seed.tracks.length; i++) {
      if (resolved.has(i)) continue;
      const s = seed.tracks[i];
      try {
        const t = await this.resolveSeed(s, seed.storefront);
        if (t) resolved.set(i, t);
        else unresolved.push(s);
      } catch (e) {
        transientFailures++;
        if (e instanceof UpstreamThrottledError) {
          log(`  throttled while resolving "${s.title}"; will retry on next ingestion`);
        } else {
          log(`  error resolving "${s.title}": ${(e as Error).message}`);
        }
        unresolved.push(s);
      }
    }

    const pins: Record<string, string> = {};
    const ordered: { seed: SeedTrack; t: ProviderTrack }[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < seed.tracks.length; i++) {
      const t = resolved.get(i);
      if (!t || seen.has(t.id)) continue;
      seen.add(t.id);
      ordered.push({ seed: seed.tracks[i], t });
      pins[seedKey(seed.tracks[i])] = t.id;
    }

    const status: PlaylistRow['status'] = ordered.length >= MIN_PLAYLIST_TRACKS ? 'ready' : existing?.status === 'ready' ? 'ready' : 'error';
    tx(this.db, () => {
      if (ordered.length >= MIN_PLAYLIST_TRACKS) {
        run(this.db, 'DELETE FROM playlist_tracks WHERE playlist_id = ?', seed.id);
        ordered.forEach(({ seed: s, t }, pos) => {
          this.upsertTrack(t, this.clipStartFor(s, t));
          run(this.db, 'INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)', seed.id, t.id, pos);
        });
      }
      run(
        this.db,
        `UPDATE playlists SET title = ?, description = ?, lang = ?, storefront = ?, sort_order = ?, status = ?,
           status_detail = ?, source_ref = ?, updated_at = ? WHERE id = ?`,
        seed.title,
        seed.description,
        seed.lang,
        seed.storefront,
        sortOrder,
        status,
        `${ordered.length}/${seed.tracks.length} tracks resolved`,
        // Only re-run automatically when something failed transiently (rate limit, network).
        ordered.length >= MIN_PLAYLIST_TRACKS && transientFailures === 0 ? sourceRef : null,
        now(),
        seed.id,
      );
    });
    log(`${seed.id}: ${ordered.length}/${seed.tracks.length} resolved → ${status}`);
    for (const u of unresolved) log(`  unresolved: ${u.title} — ${u.artist}`);
    return { playlistId: seed.id, resolved: ordered.length, unresolved, status, pins };
  }

  async ingestSeeds(seeds: SeedPlaylist[], opts: { force?: boolean; log?: (msg: string) => void } = {}) {
    const reports: IngestReport[] = [];
    const seedIds = new Set(seeds.map((s) => s.id));
    // Retire seed playlists removed from the file (keeps their history in the DB).
    for (const row of all<{ id: string }>(
      this.db,
      "SELECT id FROM playlists WHERE provider = ? AND source_type = 'seed'",
      this.provider.id,
    )) {
      if (!seedIds.has(row.id)) run(this.db, "UPDATE playlists SET status = 'error', status_detail = 'removed from seeds' WHERE id = ?", row.id);
    }
    for (const [i, seed] of seeds.entries()) {
      const r = await this.ingestSeedPlaylist(seed, i, opts);
      if (r) reports.push(r);
    }
    return reports;
  }

  /** Spotify mode: turn a playlist the signed-in user owns into a game playlist. */
  async importSpotifyPlaylist(input: {
    userId: string;
    spotifyPlaylistId: string;
    lang: string;
    meta: { name: string; description: string | null; imageUrl: string | null };
    tracks: ProviderTrack[];
    storefront: string;
  }): Promise<PlaylistRow> {
    const id = `sp-${input.spotifyPlaylistId.toLowerCase()}`;
    const seen = new Set<string>();
    const tracks = input.tracks.filter((t) => {
      if (seen.has(t.id) || !t.uri || (t.durationMs ?? 0) < 60_000) return false;
      seen.add(t.id);
      return true;
    });
    if (tracks.length < MIN_PLAYLIST_TRACKS) {
      throw new ApiError(400, 'playlist_too_small', `A playlist needs at least ${MIN_PLAYLIST_TRACKS} playable songs (this one has ${tracks.length}).`);
    }
    const t0 = now();
    tx(this.db, () => {
      run(
        this.db,
        `INSERT INTO playlists (id, provider, title, description, lang, storefront, artwork_url, source_type, source_ref, owner_user_id, status, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'import', ?, ?, 'ready', 1000, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, description = excluded.description, lang = excluded.lang,
           artwork_url = excluded.artwork_url, status = 'ready', updated_at = excluded.updated_at`,
        id,
        this.provider.id,
        input.meta.name,
        input.meta.description,
        input.lang,
        input.storefront,
        input.meta.imageUrl,
        input.spotifyPlaylistId,
        input.userId,
        t0,
        t0,
      );
      run(this.db, 'DELETE FROM playlist_tracks WHERE playlist_id = ?', id);
      tracks.forEach((t, pos) => {
        this.upsertTrack(t, this.clipStartFor(null, t));
        run(this.db, 'INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)', id, t.id, pos);
      });
    });
    return this.getPlaylist(id)!;
  }
}
