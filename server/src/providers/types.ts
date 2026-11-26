import type { ProviderId } from '@guessong/shared';

export interface ProviderTrack {
  id: string;
  title: string;
  artists: string[];
  album: string | null;
  artworkUrl: string | null;
  previewUrl: string | null;
  isrc: string | null;
  durationMs: number | null;
  /** Provider playback URI (spotify:track:…), null for preview providers. */
  uri: string | null;
  /** Link back to the track on the provider (attribution requirement). */
  externalUrl: string | null;
}

export interface SeedTrack {
  title: string;
  artist: string;
  /** Fun fact shown with the answer. */
  note?: string;
  /** Spotify mode: where the clip starts in the full track, e.g. "1:02". */
  startAt?: string;
  /** Pinned provider ids, skip searching when present. */
  apple?: string;
  spotify?: string;
}

export interface MusicProvider {
  readonly id: ProviderId;
  readonly label: string;
  /** Plays 30s previews in the browser (Apple, mock) vs full tracks via Spotify. */
  readonly playback: 'preview' | 'spotify';
  search(query: string, opts: { storefront: string; limit: number }): Promise<ProviderTrack[]>;
  /** Fetch one track by id (guess validation when the search cache misses). */
  getTrack(id: string, opts: { storefront: string }): Promise<ProviderTrack | null>;
  /** Fetch several tracks by id; providers without a batch endpoint loop. */
  getTracks(ids: string[], opts: { storefront: string }): Promise<ProviderTrack[]>;
  /** Search queries (most specific first) used to resolve a seed title/artist into a catalog track. */
  seedQueries(seed: SeedTrack): string[];
  /** Like search, but waits for rate-limit capacity instead of failing fast (ingestion). */
  searchPatiently(query: string, storefront: string): Promise<ProviderTrack[]>;
  /** True when search is currently throttled and callers should fall back to cache. */
  isThrottled(): boolean;
}

/** Thrown when an upstream music API rate-limits us. */
export class UpstreamThrottledError extends Error {
  constructor(public retryAfterMs: number) {
    super(`Upstream rate limited, retry after ${retryAfterMs}ms`);
  }
}
