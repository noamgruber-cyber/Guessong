import { LruCache, RateLimiter, sleep } from '../lib/util';
import type { ProviderTrack } from './types';
import { UpstreamThrottledError } from './types';

/**
 * Deezer's public API (no key, no login): search, ISRC lookup and 30-second MP3
 * previews. Used for games built from a player's Spotify library, because Spotify
 * no longer gives new apps preview clips. Deezer allows about 50 requests per
 * 5 seconds per IP, far more than the iTunes Search API, and an ISRC lookup gives
 * an exact match for each Spotify track.
 *
 * Track ids are prefixed with `dz:` so they can live next to the main provider's
 * tracks without colliding.
 */

export const DEEZER_PREFIX = 'dz:';

export function isDeezerId(id: string): boolean {
  return id.startsWith(DEEZER_PREFIX);
}

interface DzTrack {
  id: number;
  readable?: boolean;
  title: string;
  title_short?: string;
  isrc?: string;
  link?: string;
  duration?: number;
  preview?: string;
  artist?: { name: string };
  contributors?: { name: string; role?: string }[];
  album?: { title?: string; cover_big?: string; cover_xl?: string; cover_medium?: string };
}

interface DzError {
  error?: { type?: string; message?: string; code?: number };
}

export function toDeezerTrack(d: DzTrack): ProviderTrack | null {
  if (!d?.id || !d.title) return null;
  const main = d.contributors?.filter((c) => !c.role || c.role === 'Main').map((c) => c.name);
  const artists = main?.length ? main : d.artist?.name ? [d.artist.name] : [];
  if (!artists.length) return null;
  return {
    id: `${DEEZER_PREFIX}${d.id}`,
    title: d.title,
    artists,
    album: d.album?.title ?? null,
    artworkUrl: d.album?.cover_xl ?? d.album?.cover_big ?? d.album?.cover_medium ?? null,
    previewUrl: d.readable === false ? null : d.preview || null,
    isrc: d.isrc ?? null,
    durationMs: d.duration ? d.duration * 1000 : null,
    uri: null,
    externalUrl: d.link ?? `https://www.deezer.com/track/${d.id}`,
  };
}

export class DeezerClient {
  readonly key = 'deezer';
  private limiter = new RateLimiter(40, 5_000);
  private blockedUntil = 0;
  private trackCache = new LruCache<ProviderTrack | null>(5000, 15 * 60 * 1000);

  constructor(
    private fetchImpl: typeof fetch = fetch,
    private base = 'https://api.deezer.com',
  ) {}

  isThrottled(): boolean {
    return Date.now() < this.blockedUntil || this.limiter.waitMs() > 0;
  }

  /** `wait`: queue for rate-limit capacity (imports) instead of failing fast (search). */
  private async call<T>(path: string, params: Record<string, string> = {}, wait = true): Promise<T | null> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const blockedFor = this.blockedUntil - Date.now();
      if (blockedFor > 0) {
        if (!wait) throw new UpstreamThrottledError(blockedFor);
        await sleep(blockedFor);
      }
      if (wait) await this.limiter.take();
      else if (!this.limiter.tryTake()) throw new UpstreamThrottledError(this.limiter.waitMs());

      const q = new URLSearchParams(params);
      const res = await this.fetchImpl(`${this.base}${path}${q.size ? `?${q}` : ''}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(wait ? 15_000 : 6_000),
      });
      if (res.status === 429 || res.status >= 500) {
        this.blockedUntil = Date.now() + 5_000;
        continue;
      }
      if (!res.ok) throw new Error(`Deezer ${path} failed: HTTP ${res.status}`);
      const body = (await res.json()) as T & DzError;
      if (body?.error) {
        // 4 = quota exceeded (back off), 800 = no data (not found).
        if (body.error.code === 4) {
          this.blockedUntil = Date.now() + 5_000;
          continue;
        }
        if (body.error.code === 800) return null;
        throw new Error(`Deezer ${path}: ${body.error.message ?? 'error'}`);
      }
      return body;
    }
    throw new UpstreamThrottledError(5_000);
  }

  /** Autocomplete for Spotify-library rounds. */
  async search(query: string, opts: { limit: number }): Promise<ProviderTrack[]> {
    const body = await this.call<{ data?: DzTrack[] }>('/search', { q: query, limit: String(Math.min(50, opts.limit)) }, false);
    return (body?.data ?? []).map(toDeezerTrack).filter((t): t is ProviderTrack => t !== null);
  }

  /** Matching: candidates for a title + artist when there is no ISRC hit. */
  async searchTrack(title: string, artist: string): Promise<ProviderTrack[]> {
    const q = `artist:"${artist.replace(/"/g, '')}" track:"${title.replace(/"/g, '')}"`;
    const body = await this.call<{ data?: DzTrack[] }>('/search', { q, limit: '10' });
    return (body?.data ?? []).map(toDeezerTrack).filter((t): t is ProviderTrack => t !== null);
  }

  async trackByIsrc(isrc: string): Promise<ProviderTrack | null> {
    const body = await this.call<DzTrack>(`/track/isrc:${encodeURIComponent(isrc)}`);
    return body ? toDeezerTrack(body) : null;
  }

  async getTrack(id: string, opts: { fresh?: boolean } = {}): Promise<ProviderTrack | null> {
    if (!isDeezerId(id)) return null;
    if (!opts.fresh) {
      const hit = this.trackCache.get(id);
      if (hit !== undefined) return hit;
    }
    const body = await this.call<DzTrack>(`/track/${encodeURIComponent(id.slice(DEEZER_PREFIX.length))}`);
    const t = body ? toDeezerTrack(body) : null;
    this.trackCache.set(id, t);
    return t;
  }

  /**
   * A current preview URL. Deezer's preview links are signed and expire, so the
   * audio proxy asks for a fresh one (cached for 15 minutes).
   */
  async previewUrl(id: string): Promise<string | null> {
    return (await this.getTrack(id))?.previewUrl ?? null;
  }
}
