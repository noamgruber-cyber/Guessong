import type { Slice } from '@guessong/shared';
import { api, ApiError } from '../api';
import { AudioLoadError, rafLoop, type AudioEngine, type PlayOutcome, type SongHandle } from './engine';

/* Minimal typings for https://sdk.scdn.co/spotify-player.js */
interface SpState {
  paused: boolean;
  position: number;
  loading?: boolean;
  track_window: { current_track: { id: string | null; uri: string } | null };
}
interface SpPlayer {
  connect(): Promise<boolean>;
  disconnect(): void;
  addListener(event: string, cb: (arg: any) => void): boolean;
  getCurrentState(): Promise<SpState | null>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  seek(ms: number): Promise<void>;
  setVolume(v: number): Promise<void>;
  activateElement(): Promise<void>;
}
declare global {
  interface Window {
    Spotify?: { Player: new (opts: { name: string; getOAuthToken: (cb: (t: string) => void) => void; volume?: number }) => SpPlayer };
    onSpotifyWebPlaybackSDKReady?: () => void;
  }
}

export class SdkUnavailableError extends Error {
  constructor(
    public reason: 'unsupported' | 'premium_required' | 'auth' | 'timeout',
    message: string,
  ) {
    super(message);
  }
}

let sdkScript: Promise<void> | null = null;
function loadSdk(): Promise<void> {
  if (window.Spotify) return Promise.resolve();
  if (!sdkScript) {
    sdkScript = new Promise((resolve, reject) => {
      window.onSpotifyWebPlaybackSDKReady = () => resolve();
      const s = document.createElement('script');
      s.src = 'https://sdk.scdn.co/spotify-player.js';
      s.async = true;
      s.onerror = () => reject(new SdkUnavailableError('unsupported', 'Could not load the Spotify player'));
      document.head.appendChild(s);
    });
    sdkScript.catch(() => (sdkScript = null));
  }
  return sdkScript;
}

/** Spotify's browser player needs EME (Widevine); iOS browsers don't provide it reliably. */
export function sdkLikelySupported(): boolean {
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return !iOS && typeof navigator.requestMediaKeySystemAccess === 'function';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const STOP_LEAD_MS = 35; // pause slightly early to absorb the pause() round-trip

/**
 * Full-track playback inside the browser via the Spotify Web Playback SDK
 * (Premium only). The server starts the track on our SDK device at the clip
 * start; we mute, pause and seek locally, then play slices with local
 * seek/resume/pause for the best timing the SDK allows (~±50ms).
 */
export class SpotifySdkEngine implements AudioEngine {
  readonly kind = 'spotify-sdk' as const;
  private player: SpPlayer | null = null;
  private deviceId: string | null = null;
  private clipStartMs = 0;
  private volume = 0.85;
  private state: SpState | null = null;
  private stateWaiters: ((s: SpState) => void)[] = [];
  private active: { finish: (o: PlayOutcome) => void } | null = null;
  private fatal: SdkUnavailableError | null = null;

  async init(): Promise<void> {
    await loadSdk();
    if (!window.Spotify) throw new SdkUnavailableError('unsupported', 'Spotify player unavailable');
    const player = new window.Spotify.Player({
      name: 'Guessong',
      volume: this.volume,
      getOAuthToken: (cb) => {
        api
          .spotifyToken()
          .then((t) => cb(t.accessToken))
          .catch(() => (this.fatal = new SdkUnavailableError('auth', 'Spotify session expired')));
      },
    });
    this.player = player;
    const ready = new Promise<string>((resolve, reject) => {
      player.addListener('ready', ({ device_id }: { device_id: string }) => resolve(device_id));
      player.addListener('initialization_error', ({ message }: { message: string }) =>
        reject(new SdkUnavailableError('unsupported', message)),
      );
      player.addListener('authentication_error', ({ message }: { message: string }) =>
        reject(new SdkUnavailableError('auth', message)),
      );
      player.addListener('account_error', () =>
        reject(new SdkUnavailableError('premium_required', 'Spotify Premium is required to play')),
      );
      setTimeout(() => reject(new SdkUnavailableError('timeout', 'The Spotify player did not start')), 12_000);
    });
    player.addListener('account_error', () => (this.fatal = new SdkUnavailableError('premium_required', 'Spotify Premium is required')));
    player.addListener('not_ready', () => (this.deviceId = null));
    player.addListener('ready', ({ device_id }: { device_id: string }) => (this.deviceId = device_id));
    player.addListener('player_state_changed', (s: SpState | null) => {
      if (!s) return;
      this.state = s;
      const waiters = this.stateWaiters;
      this.stateWaiters = [];
      waiters.forEach((w) => w(s));
    });
    const ok = await player.connect();
    if (!ok) throw new SdkUnavailableError('unsupported', 'Could not connect the Spotify player');
    this.deviceId = await ready;
  }

  private waitForState(pred: (s: SpState) => boolean, timeoutMs: number): Promise<SpState> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      const check = (s: SpState) => {
        if (pred(s)) {
          clearTimeout(timer);
          resolve(s);
        } else this.stateWaiters.push(check);
      };
      this.stateWaiters.push(check);
    });
  }

  unlock() {
    void this.player?.activateElement();
  }

  async load(handle: SongHandle, onProgress: (p: number) => void) {
    this.stop();
    if (this.fatal) throw this.fatal;
    if (!this.player || !this.deviceId) throw new AudioLoadError('Spotify player is not ready', false, 'player_not_ready');
    if (handle.song.audio.kind !== 'spotify') throw new AudioLoadError('Not a Spotify song', false);
    this.clipStartMs = handle.song.audio.clipStartMs;
    const previousTrack = this.state?.track_window.current_track?.uri ?? null;
    onProgress(0.15);
    await this.player.setVolume(0);
    onProgress(0.3);
    try {
      await api.spotifyLoad(handle.roundId, handle.song.roundSongId, this.deviceId);
    } catch (e) {
      await this.player.setVolume(this.volume);
      if (e instanceof ApiError && e.code === 'premium_required') throw new SdkUnavailableError('premium_required', e.message);
      throw new AudioLoadError(e instanceof Error ? e.message : 'Spotify refused to play this song', false, e instanceof ApiError ? e.code : 'load_failed');
    }
    onProgress(0.55);
    try {
      await this.waitForState(
        (s) =>
          !s.paused &&
          !s.loading &&
          !!s.track_window.current_track &&
          (s.track_window.current_track.uri !== previousTrack || Math.abs(s.position - this.clipStartMs) < 4000),
        10_000,
      );
    } catch {
      await this.player.setVolume(this.volume);
      throw new AudioLoadError('Spotify did not start this song', true);
    }
    onProgress(0.8);
    await this.player.pause();
    await this.player.seek(this.clipStartMs);
    await sleep(120);
    await this.player.setVolume(this.volume);
    onProgress(1);
  }

  prefetch() {
    /* the SDK holds one track at a time */
  }

  async play(slice: Slice, onTick: (ms: number) => void): Promise<PlayOutcome> {
    this.stop();
    const player = this.player;
    if (!player) return 'stopped';
    let stopped = false;
    let resolveOuter!: (o: PlayOutcome) => void;
    const outcome = new Promise<PlayOutcome>((r) => (resolveOuter = r));
    let cancelTicks = () => {};
    const finish = (o: PlayOutcome) => {
      if (stopped) return;
      stopped = true;
      cancelTicks();
      if (this.active?.finish === finish) this.active = null;
      void player.pause();
      onTick(o === 'ended' ? slice.endMs : slice.startMs);
      resolveOuter(o);
    };
    this.active = { finish };

    await player.seek(this.clipStartMs + slice.startMs);
    if (stopped) return outcome;
    await player.resume();
    // Wait until the SDK confirms playback, then run a local clock that is
    // re-synced against the SDK position a few times per second.
    let t0 = performance.now();
    let p0 = slice.startMs;
    try {
      const s = await this.waitForState((st) => !st.paused, 3000);
      t0 = performance.now();
      p0 = Math.max(slice.startMs, s.position - this.clipStartMs);
    } catch {
      /* fall back to the local clock */
    }
    if (stopped) return outcome;
    let lastSync = t0;
    cancelTicks = rafLoop(() => {
      const now = performance.now();
      const est = p0 + (now - t0);
      onTick(Math.min(slice.endMs, est));
      if (est >= slice.endMs - STOP_LEAD_MS) {
        finish('ended');
        return false;
      }
      if (now - lastSync > 250) {
        lastSync = now;
        void player.getCurrentState().then((st) => {
          if (st && !st.paused && !stopped) {
            t0 = performance.now();
            p0 = st.position - this.clipStartMs;
          }
        });
      }
      return true;
    });
    return outcome;
  }

  stop() {
    this.active?.finish('stopped');
    this.active = null;
  }

  dispose() {
    this.stop();
    this.player?.disconnect();
    this.player = null;
  }
}
