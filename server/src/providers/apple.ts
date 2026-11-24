import { RateLimiter, sleep } from '../lib/util';
import type { MusicProvider, ProviderTrack, SeedTrack } from './types';
import { UpstreamThrottledError } from './types';

/**
 * Apple previews via the public iTunes Search API (no key, no login).
 * Apple documents a limit of roughly 20 calls/minute per client IP, so all
 * calls go through a token bucket and search results are cached upstream.
 */

interface ItunesResult {
  wrapperType?: string;
  kind?: string;
  trackId?: number;
  trackName?: string;
  artistName?: string;
  collectionName?: string;
  artworkUrl100?: string;
  previewUrl?: string;
  trackTimeMillis?: number;
  trackViewUrl?: string;
  isStreamable?: boolean;
}

const BASE = 'https://itunes.apple.com';

export function toAppleTrack(r: ItunesResult): ProviderTrack | null {
  if (!r.trackId || !r.trackName || !r.artistName) return null;
  if (r.kind && r.kind !== 'song') return null;
  return {
    id: String(r.trackId),
    title: r.trackName,
    artists: [r.artistName],
    album: r.collectionName ?? null,
    artworkUrl: r.artworkUrl100 ? r.artworkUrl100.replace(/\/\d+x\d+bb\./, '/600x600bb.') : null,
    previewUrl: r.previewUrl ?? null,
    isrc: null,
    durationMs: r.trackTimeMillis ?? null,
    uri: null,
    externalUrl: r.trackViewUrl ?? null,
  };
}

export class AppleProvider implements MusicProvider {
  readonly id = 'apple' as const;
  readonly label = 'Apple Music';
  readonly playback = 'preview' as const;
  private limiter: RateLimiter;

  constructor(
    searchPerMinute: number,
    private fetchImpl: typeof fetch = fetch,
  ) {
    this.limiter = new RateLimiter(Math.max(1, searchPerMinute), 60_000);
  }

  isThrottled(): boolean {
    return this.limiter.waitMs() > 0;
  }

  private async call(path: string, params: Record<string, string>, opts: { wait: boolean }): Promise<ItunesResult[]> {
    if (opts.wait) await this.limiter.take();
    else if (!this.limiter.tryTake()) throw new UpstreamThrottledError(this.limiter.waitMs());

    const url = `${BASE}${path}?${new URLSearchParams(params)}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await this.fetchImpl(url, { headers: { Accept: 'application/json' } });
      if (res.status === 403 || res.status === 429) {
        if (!opts.wait) throw new UpstreamThrottledError(30_000);
        await sleep(15_000 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`iTunes ${path} failed: HTTP ${res.status}`);
      const body = (await res.json()) as { results?: ItunesResult[] };
      return body.results ?? [];
    }
    throw new UpstreamThrottledError(60_000);
  }

  async search(query: string, opts: { storefront: string; limit: number; wait?: boolean }): Promise<ProviderTrack[]> {
    const results = await this.call(
      '/search',
      {
        term: query,
        media: 'music',
        entity: 'song',
        limit: String(Math.min(50, Math.max(opts.limit, 1))),
        country: opts.storefront,
      },
      { wait: opts.wait ?? false },
    );
    return results.map(toAppleTrack).filter((t): t is ProviderTrack => t !== null);
  }

  /** Used by ingestion: waits for rate-limit tokens instead of failing fast. */
  searchPatiently(query: string, storefront: string, limit = 25) {
    return this.search(query, { storefront, limit, wait: true });
  }

  async getTrack(id: string, opts: { storefront: string }): Promise<ProviderTrack | null> {
    const [t] = await this.getTracks([id], opts);
    return t ?? null;
  }

  async getTracks(ids: string[], opts: { storefront: string }): Promise<ProviderTrack[]> {
    const out: ProviderTrack[] = [];
    for (let i = 0; i < ids.length; i += 150) {
      const chunk = ids.slice(i, i + 150);
      const results = await this.call(
        '/lookup',
        { id: chunk.join(','), entity: 'song', country: opts.storefront },
        { wait: true },
      );
      for (const r of results) {
        const t = r.wrapperType === 'track' || r.kind === 'song' ? toAppleTrack(r) : null;
        if (t) out.push(t);
      }
    }
    return out;
  }

  seedQueries(seed: SeedTrack): string[] {
    return [`${seed.artist} ${seed.title}`, seed.title];
  }
}
