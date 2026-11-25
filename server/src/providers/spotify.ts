import { sleep } from '../lib/util';
import type { MusicProvider, ProviderTrack, SeedTrack } from './types';
import { UpstreamThrottledError } from './types';

/**
 * Spotify Web API client + provider.
 *
 * Constraints for Development Mode apps (Feb 2026 platform changes):
 *  - search `limit` max is 10
 *  - no batch GET /tracks; tracks are fetched one by one
 *  - playlist items only for playlists the signed-in user owns or collaborates on
 *  - GET /me no longer returns `product`, so Premium is detected from the
 *    Web Playback SDK `account_error` event or a PREMIUM_REQUIRED player error
 *  - max 5 users, each added under User Management in the developer dashboard
 */

export const SPOTIFY_SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
  'playlist-read-private',
  'playlist-read-collaborative',
];

/** Apple/mock mode: read-only access to build games from the player's library. */
export const SPOTIFY_LIBRARY_SCOPES = [
  'user-read-private',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-library-read',
  'user-top-read',
];

const API = 'https://api.spotify.com/v1';
const ACCOUNTS = 'https://accounts.spotify.com';

export class SpotifyApiError extends Error {
  constructor(
    public status: number,
    public reason: string,
    message: string,
  ) {
    super(message);
  }
}

export interface SpotifyTokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
}

interface SpImage {
  url: string;
  width?: number | null;
}
interface SpTrack {
  id: string;
  name: string;
  uri: string;
  type?: string;
  is_local?: boolean;
  duration_ms: number;
  artists: { id?: string; name: string }[];
  album?: { name: string; images?: SpImage[] };
  external_ids?: { isrc?: string };
  external_urls?: { spotify?: string };
}

export interface SpotifyProfile {
  id: string;
  accountId: string | null;
  displayName: string;
  imageUrl: string | null;
}

export interface SpotifyPlaylistSummary {
  id: string;
  name: string;
  imageUrl: string | null;
  ownerId: string;
  collaborative: boolean;
  trackCount: number | null;
}

/** A track from the player's library, with artist ids for genre grouping. */
export interface LibraryTrack extends ProviderTrack {
  artistIds: string[];
}

export interface SpotifyArtistInfo {
  id: string;
  name: string;
  genres: string[];
}

export interface SpotifyDevice {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
}

function bestImage(images: SpImage[] | undefined): string | null {
  if (!images?.length) return null;
  const sorted = [...images].sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  return sorted[0].url;
}

export function toSpotifyTrack(t: SpTrack): ProviderTrack | null {
  if (!t?.id || t.is_local || (t.type && t.type !== 'track')) return null;
  return {
    id: t.id,
    title: t.name,
    artists: t.artists.map((a) => a.name),
    album: t.album?.name ?? null,
    artworkUrl: bestImage(t.album?.images),
    previewUrl: null,
    isrc: t.external_ids?.isrc ?? null,
    durationMs: t.duration_ms,
    uri: t.uri,
    externalUrl: t.external_urls?.spotify ?? `https://open.spotify.com/track/${t.id}`,
  };
}

function toLibraryTrack(t: SpTrack): LibraryTrack | null {
  const base = toSpotifyTrack(t);
  if (!base) return null;
  return { ...base, artistIds: t.artists.map((a) => a.id).filter((id): id is string => !!id) };
}

export class SpotifyApi {
  private appToken: { token: string; exp: number } | null = null;
  private throttledUntil = 0;

  constructor(
    private cfg: { clientId: string; clientSecret: string; redirectUri: string; apiBase?: string; accountsBase?: string },
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private get api() {
    return this.cfg.apiBase ?? API;
  }

  private get accounts() {
    return this.cfg.accountsBase ?? ACCOUNTS;
  }

  isThrottled() {
    return Date.now() < this.throttledUntil;
  }

  authorizeUrl(state: string, scopes: string[] = SPOTIFY_SCOPES): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.cfg.clientId,
      scope: scopes.join(' '),
      redirect_uri: this.cfg.redirectUri,
      state,
    });
    return `${this.accounts}/authorize?${params}`;
  }

  private basicAuth() {
    return `Basic ${Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString('base64')}`;
  }

  private async tokenRequest(body: Record<string, string>): Promise<SpotifyTokenSet> {
    const res = await this.fetchImpl(`${this.accounts}/api/token`, {
      method: 'POST',
      headers: { Authorization: this.basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    });
    const json = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !json.access_token) {
      throw new SpotifyApiError(res.status, json.error ?? 'token_error', json.error_description ?? 'Spotify token request failed');
    }
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? null,
      expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    };
  }

  exchangeCode(code: string) {
    return this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: this.cfg.redirectUri });
  }

  refresh(refreshToken: string) {
    return this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  private async getAppToken(): Promise<string> {
    if (this.appToken && this.appToken.exp > Date.now() + 60_000) return this.appToken.token;
    const t = await this.tokenRequest({ grant_type: 'client_credentials' });
    this.appToken = { token: t.accessToken, exp: t.expiresAt };
    return t.accessToken;
  }

  /** Low-level call. `token: 'app'` uses the client-credentials token. */
  async call<T>(
    token: string | 'app',
    method: string,
    path: string,
    opts: { query?: Record<string, string | number | undefined>; body?: unknown; retry429?: boolean } = {},
  ): Promise<T | null> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) q.set(k, String(v));
    const url = `${this.api}${path}${q.size ? `?${q}` : ''}`;
    for (let attempt = 0; attempt < 4; attempt++) {
      const bearer = token === 'app' ? await this.getAppToken() : token;
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${bearer}`,
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after') ?? '2') * 1000;
        this.throttledUntil = Date.now() + retryAfter;
        if (opts.retry429 === false || retryAfter > 30_000) throw new UpstreamThrottledError(retryAfter);
        await sleep(retryAfter + 250);
        continue;
      }
      if (res.status === 401 && token === 'app' && attempt === 0) {
        this.appToken = null;
        continue;
      }
      if (res.status === 204 || res.status === 202) return null;
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        /* non-JSON */
      }
      if (!res.ok) {
        const err = (json as { error?: { message?: string; reason?: string } } | null)?.error;
        throw new SpotifyApiError(res.status, err?.reason ?? `http_${res.status}`, err?.message ?? `Spotify ${path} failed (${res.status})`);
      }
      return json as T;
    }
    throw new UpstreamThrottledError(30_000);
  }

  async search(query: string, market: string, limit = 10, retry429 = false): Promise<ProviderTrack[]> {
    const body = await this.call<{ tracks?: { items: SpTrack[] } }>('app', 'GET', '/search', {
      query: { q: query, type: 'track', limit: Math.min(10, limit), market },
      retry429,
    });
    return (body?.tracks?.items ?? []).map(toSpotifyTrack).filter((t): t is ProviderTrack => t !== null);
  }

  async getTrack(id: string, market: string): Promise<ProviderTrack | null> {
    try {
      const t = await this.call<SpTrack>('app', 'GET', `/tracks/${encodeURIComponent(id)}`, { query: { market } });
      return t ? toSpotifyTrack(t) : null;
    } catch (e) {
      if (e instanceof SpotifyApiError && (e.status === 404 || e.status === 400)) return null;
      throw e;
    }
  }

  async me(token: string): Promise<SpotifyProfile> {
    const me = await this.call<{ id: string; account_id?: string; display_name?: string | null; images?: SpImage[] }>(
      token,
      'GET',
      '/me',
    );
    if (!me) throw new SpotifyApiError(500, 'no_profile', 'Spotify returned no profile');
    return {
      id: me.id,
      accountId: me.account_id ?? null,
      displayName: me.display_name || me.id,
      imageUrl: bestImage(me.images),
    };
  }

  async myPlaylists(token: string): Promise<SpotifyPlaylistSummary[]> {
    const out: SpotifyPlaylistSummary[] = [];
    for (let offset = 0; offset < 500; offset += 50) {
      const page = await this.call<{
        items: {
          id: string;
          name: string;
          images?: SpImage[] | null;
          owner: { id: string };
          collaborative: boolean;
          tracks?: { total?: number };
          items?: { total?: number };
        }[];
        next: string | null;
      }>(token, 'GET', '/me/playlists', { query: { limit: 50, offset } });
      for (const p of page?.items ?? []) {
        out.push({
          id: p.id,
          name: p.name,
          imageUrl: bestImage(p.images ?? undefined),
          ownerId: p.owner.id,
          collaborative: p.collaborative,
          trackCount: p.items?.total ?? p.tracks?.total ?? null,
        });
      }
      if (!page?.next) break;
    }
    return out;
  }

  async playlistMeta(token: string, id: string) {
    return this.call<{ id: string; name: string; description?: string | null; images?: SpImage[] | null }>(
      token,
      'GET',
      `/playlists/${encodeURIComponent(id)}`,
      { query: { fields: 'id,name,description,images' } },
    );
  }

  /** Items of a playlist the user owns/collaborates on (the only kind Dev Mode returns). */
  async playlistTracks(token: string, id: string, market: string): Promise<ProviderTrack[]> {
    const out: ProviderTrack[] = [];
    for (let offset = 0; offset < 1000; offset += 50) {
      const page = await this.call<{ items: { item?: SpTrack | null; track?: SpTrack | null }[]; next: string | null }>(
        token,
        'GET',
        `/playlists/${encodeURIComponent(id)}/items`,
        { query: { limit: 50, offset, market, additional_types: 'track' }, retry429: true },
      );
      for (const entry of page?.items ?? []) {
        const t = entry.item ?? entry.track;
        const mapped = t ? toSpotifyTrack(t) : null;
        if (mapped) out.push(mapped);
      }
      if (!page?.next) break;
    }
    return out;
  }

  // ---- library (Apple/mock mode games) -------------------------------------------

  /** Items of a playlist the user owns or collaborates on, with artist ids. */
  async playlistLibraryTracks(token: string, id: string, max = 500): Promise<LibraryTrack[]> {
    const out: LibraryTrack[] = [];
    for (let offset = 0; offset < max; offset += 50) {
      const page = await this.call<{ items?: { item?: SpTrack | null; track?: SpTrack | null }[]; next: string | null }>(
        token,
        'GET',
        `/playlists/${encodeURIComponent(id)}/items`,
        { query: { limit: 50, offset, market: 'from_token', additional_types: 'track' }, retry429: true },
      );
      for (const entry of page?.items ?? []) {
        const t = entry.item ?? entry.track;
        const mapped = t ? toLibraryTrack(t) : null;
        if (mapped) out.push(mapped);
      }
      if (!page?.next) break;
    }
    return out;
  }

  async savedTracksTotal(token: string): Promise<number | null> {
    const page = await this.call<{ total?: number }>(token, 'GET', '/me/tracks', { query: { limit: 1 }, retry429: true });
    return page?.total ?? null;
  }

  /** Liked Songs, most recently liked first. */
  async savedTracks(token: string, max = 500): Promise<LibraryTrack[]> {
    const out: LibraryTrack[] = [];
    for (let offset = 0; offset < max; offset += 50) {
      const page = await this.call<{ items?: { item?: SpTrack | null; track?: SpTrack | null }[]; next: string | null }>(
        token,
        'GET',
        '/me/tracks',
        { query: { limit: 50, offset, market: 'from_token' }, retry429: true },
      );
      for (const entry of page?.items ?? []) {
        const t = entry.item ?? entry.track;
        const mapped = t ? toLibraryTrack(t) : null;
        if (mapped) out.push(mapped);
      }
      if (!page?.next) break;
    }
    return out;
  }

  async topTracks(token: string, range: 'short_term' | 'medium_term' | 'long_term'): Promise<LibraryTrack[]> {
    const page = await this.call<{ items?: SpTrack[] }>(token, 'GET', '/me/top/tracks', {
      query: { limit: 50, time_range: range },
      retry429: true,
    });
    return (page?.items ?? []).map(toLibraryTrack).filter((t): t is LibraryTrack => t !== null);
  }

  async topArtists(token: string, range: 'short_term' | 'medium_term' | 'long_term'): Promise<SpotifyArtistInfo[]> {
    const page = await this.call<{ items?: { id: string; name: string; genres?: string[] }[] }>(token, 'GET', '/me/top/artists', {
      query: { limit: 50, time_range: range },
      retry429: true,
    });
    return (page?.items ?? []).map((a) => ({ id: a.id, name: a.name, genres: a.genres ?? [] }));
  }

  /** One artist (the batch endpoint is gone for Development Mode apps). */
  async artist(token: string, id: string): Promise<SpotifyArtistInfo | null> {
    try {
      const a = await this.call<{ id: string; name: string; genres?: string[] }>(token, 'GET', `/artists/${encodeURIComponent(id)}`, {
        retry429: true,
      });
      return a ? { id: a.id, name: a.name, genres: a.genres ?? [] } : null;
    } catch (e) {
      if (e instanceof SpotifyApiError && e.status === 404) return null;
      throw e;
    }
  }

  async devices(token: string): Promise<SpotifyDevice[]> {
    const body = await this.call<{ devices: { id: string | null; name: string; type: string; is_active: boolean; is_restricted?: boolean }[] }>(
      token,
      'GET',
      '/me/player/devices',
    );
    return (body?.devices ?? [])
      .filter((d) => d.id && !d.is_restricted)
      .map((d) => ({ id: d.id!, name: d.name, type: d.type, isActive: d.is_active }));
  }

  async play(token: string, deviceId: string, uri: string, positionMs: number) {
    await this.call(token, 'PUT', '/me/player/play', {
      query: { device_id: deviceId },
      body: { uris: [uri], position_ms: Math.max(0, Math.round(positionMs)) },
      retry429: false,
    });
  }

  async pause(token: string, deviceId?: string) {
    try {
      await this.call(token, 'PUT', '/me/player/pause', { query: { device_id: deviceId }, retry429: false });
    } catch (e) {
      // Pausing an already-paused player returns 403 "Restriction violated"; that's fine.
      if (!(e instanceof SpotifyApiError && e.status === 403)) throw e;
    }
  }
}

export class SpotifyProvider implements MusicProvider {
  readonly id = 'spotify' as const;
  readonly label = 'Spotify';
  readonly playback = 'spotify' as const;

  constructor(
    public api: SpotifyApi,
    private market: string,
  ) {}

  isThrottled() {
    return this.api.isThrottled();
  }

  search(query: string, opts: { storefront: string; limit: number }) {
    return this.api.search(query, opts.storefront || this.market, opts.limit);
  }

  searchPatiently(query: string, storefront: string) {
    return this.api.search(query, storefront || this.market, 10, true);
  }

  getTrack(id: string, opts: { storefront: string }) {
    return this.api.getTrack(id, opts.storefront || this.market);
  }

  async getTracks(ids: string[], opts: { storefront: string }) {
    const out: ProviderTrack[] = [];
    for (const id of ids) {
      const t = await this.getTrack(id, opts);
      if (t) out.push(t);
    }
    return out;
  }

  seedQueries(seed: SeedTrack): string[] {
    const clean = (s: string) => s.replace(/"/g, '');
    return [`track:"${clean(seed.title)}" artist:"${clean(seed.artist)}"`, `${seed.artist} ${seed.title}`];
  }
}
