import type { Config } from '../config';
import type { SeedPlaylist } from '../seeds';
import { AppleProvider } from './apple';
import { MockProvider } from './mock';
import { SpotifyApi, SpotifyProvider } from './spotify';
import type { MusicProvider } from './types';

export interface Providers {
  music: MusicProvider;
  /** Present only in Spotify mode: OAuth + player control. */
  spotify: SpotifyApi | null;
}

export function createProviders(config: Config, seeds: SeedPlaylist[], fetchImpl: typeof fetch = fetch): Providers {
  switch (config.provider) {
    case 'apple':
      return { music: new AppleProvider(config.apple.searchPerMinute, fetchImpl), spotify: null };
    case 'mock':
      return { music: new MockProvider(seeds), spotify: null };
    case 'spotify': {
      const api = new SpotifyApi(
        {
          clientId: config.spotify.clientId,
          clientSecret: config.spotify.clientSecret,
          redirectUri: config.spotify.redirectUri,
        },
        fetchImpl,
      );
      return { music: new SpotifyProvider(api, config.spotify.market), spotify: api };
    }
  }
}

export type { MusicProvider, ProviderTrack } from './types';
