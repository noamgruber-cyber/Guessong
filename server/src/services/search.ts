import { normalizeTitle, type SearchResponse, type SearchResultDTO } from '@guessong/shared';
import { LruCache } from '../lib/util';
import type { MusicProvider, ProviderTrack } from '../providers/types';
import { UpstreamThrottledError } from '../providers/types';
import { artistLine, type Catalog } from './catalog';

const RESULT_LIMIT = 10;

/**
 * Autocomplete over the provider's full catalog (not just the playlist, so the
 * suggestions don't give the answer away). Responses are cached, and every
 * returned track is stored so a guess can be validated without another call.
 * When the upstream API is rate-limited we fall back to tracks we already know.
 */
export class SearchService {
  private cache = new LruCache<ProviderTrack[]>(3000, 6 * 60 * 60 * 1000);
  private inflight = new Map<string, Promise<ProviderTrack[]>>();

  constructor(
    private provider: MusicProvider,
    private catalog: Catalog,
  ) {}

  async search(query: string, storefront: string): Promise<SearchResponse> {
    const q = query.trim().slice(0, 100);
    const norm = normalizeTitle(q);
    if (norm.length < 2) return { results: [], partial: false };
    const key = `${storefront}:${norm}`;

    let tracks = this.cache.get(key);
    let partial = false;
    if (!tracks) {
      try {
        let pending = this.inflight.get(key);
        if (!pending) {
          pending = this.provider.search(q, { storefront, limit: this.provider.id === 'spotify' ? 10 : 25 });
          this.inflight.set(key, pending);
        }
        tracks = await pending.finally(() => this.inflight.delete(key));
        this.cache.set(key, tracks);
        for (const t of tracks) this.catalog.upsertTrack(t);
      } catch (e) {
        if (!(e instanceof UpstreamThrottledError)) throw e;
        partial = true;
        const local = this.catalog.searchLocal(q, RESULT_LIMIT);
        return { results: local.map((r) => ({ id: r.id, title: r.title, artist: artistLine(r) })), partial };
      }
    }

    const seen = new Set<string>();
    const results: SearchResultDTO[] = [];
    for (const t of tracks) {
      const artist = t.artists.join(', ');
      const k = `${t.title.toLowerCase()}|${artist.toLowerCase()}`;
      if (seen.has(k)) continue;
      seen.add(k);
      results.push({ id: t.id, title: t.title, artist });
      if (results.length >= RESULT_LIMIT) break;
    }
    return { results, partial };
  }
}
