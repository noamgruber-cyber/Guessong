import type { AppConfig } from '@guessong/shared';
import { storageGet, storageSet } from '../lib/util';
import type { AudioEngine } from './engine';
import { PreviewEngine } from './previewEngine';
import { SpotifyConnectEngine } from './spotifyConnectEngine';
import { SdkUnavailableError, SpotifySdkEngine, sdkLikelySupported } from './spotifySdkEngine';

export type PlaybackPref = { mode: 'auto' } | { mode: 'browser' } | { mode: 'device'; deviceId: string; name: string };

const PREF_KEY = 'guessong.playback';

export function getPlaybackPref(): PlaybackPref {
  try {
    const raw = storageGet(PREF_KEY);
    if (raw) return JSON.parse(raw) as PlaybackPref;
  } catch {
    /* ignore */
  }
  return { mode: 'auto' };
}

export function setPlaybackPref(pref: PlaybackPref) {
  storageSet(PREF_KEY, JSON.stringify(pref));
  resetEngine();
}

/** Spotify mode without a usable in-browser player: the user must pick a device. */
export class NeedsDeviceError extends Error {
  constructor(message = 'Choose where to play: open Spotify on your phone, then pick it here.') {
    super(message);
  }
}

let engine: AudioEngine | null = null;
let pending: Promise<AudioEngine> | null = null;

/** The current engine if already created (for synchronous use inside tap handlers). */
export function peekEngine(): AudioEngine | null {
  return engine;
}

/**
 * Call synchronously from a user gesture before playback starts (Play /
 * Continue buttons). Creates the preview engine on the spot so its
 * AudioContext is unlocked by the tap, and activates the Spotify player.
 */
export function primeAudio(config: AppConfig | null) {
  if (config && config.provider !== 'spotify' && !engine) engine = new PreviewEngine();
  engine?.unlock();
  if (config?.provider === 'spotify' && !engine) void getEngine(config).catch(() => {});
}

export async function getEngine(config: AppConfig): Promise<AudioEngine> {
  if (engine) return engine;
  if (pending) return pending;
  pending = (async () => {
    if (config.provider !== 'spotify') return new PreviewEngine();
    const pref = getPlaybackPref();
    if (pref.mode === 'device') return new SpotifyConnectEngine(pref.deviceId);
    if (pref.mode === 'auto' && !sdkLikelySupported()) throw new NeedsDeviceError();
    const sdk = new SpotifySdkEngine();
    try {
      await sdk.init();
      return sdk;
    } catch (e) {
      sdk.dispose();
      if (e instanceof SdkUnavailableError && e.reason === 'premium_required') throw e;
      throw new NeedsDeviceError(
        `The in-browser Spotify player isn't available here (${(e as Error).message}). Open Spotify on your phone or computer and pick it as the device.`,
      );
    }
  })();
  try {
    engine = await pending;
    return engine;
  } finally {
    pending = null;
  }
}

export function resetEngine() {
  engine?.dispose();
  engine = null;
  pending = null;
}

export { SdkUnavailableError };
