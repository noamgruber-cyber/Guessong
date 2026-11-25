import { normalizeArtist, normalizeTitle, type SearchResponse, type SearchResultDTO } from '@guessong/shared';
import { LruCache } from '../lib/util';
import type { MusicProvider, ProviderTrack } from '../providers/types';
import { UpstreamThrottledError } from '../providers/types';
import type { Catalog } from './catalog';
import type { CatalogIndex } from './catalogIndex';

export const RESULT_LIMIT = 10;

/** A live search backend: the main provider, or Deezer for Spotify-library rounds. */
export interface SearchBackend {
  readonly key: string;
  search(query: string, opts: { storefront: string; limit: number }): Promise<ProviderTrack[]>;
  isThrottled(): boolean;
}

function resultKey(r: SearchResultDTO): string {
  return `${normalizeTitle(r.title)}|${normalizeArtist(r.artist)}`;
}

/**
 * Autocomplete over the provider's whole catalog, never just the playlist, so the
 * suggestions can't give the answer away.
 *
 * Live results come first. When the live API returns few results, or is
 * rate-limited (the iTunes Search API allows about 20 calls a minute per server),
 * results are padded or replaced from the local CatalogIndex: tens of thousands of
 * songs that don't favour the playlist's tracks. Live responses are cached, and
 * every returned track is stored so a guess can be validated without another call.
 */
export class SearchService {
  private cache = new LruCache<ProviderTrack[]>(3000, 6 * 60 * 60 * 1000);
  private inflight = new Map<string, Promise<ProviderTrack[]>>();
  onError?: (e: Error) => void;

  constructor(
    private provider: MusicProvider,
    private catalog: Catalog,
    private index: CatalogIndex,
  ) {}

  async search(query: string, storefront: string, backend?: SearchBackend): Promise<SearchResponse> {
    const q = query.trim().slice(0, 100);
    const norm = normalizeTitle(q);
    if (norm.length < 2) return { results: [], partial: false };

    const live = backend ?? this.provider;
    // The local index covers the main provider's catalog only.
    const local = backend ? [] : this.index.search(q, storefront, RESULT_LIMIT);

    let tracks: ProviderTrack[] | null = null;
    let partial = false;
    try {
      tracks = await this.liveSearch(live, q, norm, storefront);
    } catch (e) {
      // Throttled, timed out or down: the local index still gives real suggestions.
      if (!(e instanceof UpstreamThrottledError)) this.onError?.(e as Error);
      partial = true;
    }

    const results: SearchResultDTO[] = [];
    const seen = new Set<string>();
    const push = (r: SearchResultDTO) => {
      const k = resultKey(r);
      if (seen.has(k) || results.length >= RESULT_LIMIT) return;
      seen.add(k);
      results.push(r);
    };
    for (const t of tracks ?? []) push({ id: t.id, title: t.title, artist: t.artists.join(', ') });
    for (const r of local) push(r);
    return { results, partial };
  }

  private async liveSearch(live: SearchBackend | MusicProvider, q: string, norm: string, storefront: string) {
    const key = `${'key' in live ? live.key : live.id}:${storefront}:${norm}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    let pending = this.inflight.get(key);
    if (!pending) {
      const limit = 'id' in live && live.id === 'spotify' ? 10 : 25;
      pending = live.search(q, { storefront, limit });
      this.inflight.set(key, pending);
    }
    const tracks = await pending.finally(() => this.inflight.delete(key));
    this.cache.set(key, tracks);
    for (const t of tracks) this.catalog.upsertTrack(t);
    return tracks;
  }
}
