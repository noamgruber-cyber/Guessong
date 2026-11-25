import type { Config } from '../config';
import type { SeedPlaylist } from '../seeds';
import { AppleProvider } from './apple';
import { DeezerClient } from './deezer';
import { MockProvider } from './mock';
import { SpotifyApi, SpotifyProvider } from './spotify';
import type { MusicProvider } from './types';

export interface Providers {
  music: MusicProvider;
  /** Spotify mode (OAuth + player control), or Apple/mock mode with library games enabled. */
  spotify: SpotifyApi | null;
  /** Previews and search for Spotify-library games (Apple/mock mode only). */
  deezer: DeezerClient | null;
}

function spotifyApi(config: Config, fetchImpl: typeof fetch) {
  return new SpotifyApi(
    {
      clientId: config.spotify.clientId,
      clientSecret: config.spotify.clientSecret,
      redirectUri: config.spotify.redirectUri,
      apiBase: config.spotify.apiBase,
      accountsBase: config.spotify.accountsBase,
    },
    fetchImpl,
  );
}

export function createProviders(config: Config, seeds: SeedPlaylist[], fetchImpl: typeof fetch = fetch): Providers {
  switch (config.provider) {
    case 'apple':
    case 'mock': {
      const music = config.provider === 'apple' ? new AppleProvider(config.apple.searchPerMinute, fetchImpl) : new MockProvider(seeds);
      return {
        music,
        spotify: config.spotifyLibrary ? spotifyApi(config, fetchImpl) : null,
        // Always present so existing Spotify games keep playing even if the keys are removed.
        deezer: new DeezerClient(fetchImpl, config.deezerApiBase),
      };
    }
    case 'spotify': {
      const api = spotifyApi(config, fetchImpl);
      return { music: new SpotifyProvider(api, config.spotify.market), spotify: api, deezer: null };
    }
  }
}

export type { MusicProvider, ProviderTrack } from './types';
