import type { Slice } from '@guessong/shared';
import { api, ApiError } from '../api';
import { AudioLoadError, rafLoop, type AudioEngine, type PlayOutcome, type SongHandle } from './engine';

/**
 * Spotify Connect mode: the game remote-controls the Spotify app on the
 * player's phone (or any Connect device). Used where the in-browser player
 * isn't available, e.g. iPhone browsers. The server issues both "play at
 * position" and the scheduled "pause", so the clip length is roughly right,
 * but network latency makes it less precise than the in-browser player.
 */
export class SpotifyConnectEngine implements AudioEngine {
  readonly kind = 'spotify-connect' as const;
  private handle: SongHandle | null = null;
  private active: { finish: (o: PlayOutcome) => void } | null = null;

  constructor(public deviceId: string) {}

  unlock() {
    /* audio plays in the Spotify app, nothing to unlock here */
  }

  async load(handle: SongHandle, onProgress: (p: number) => void) {
    this.stop();
    if (handle.song.audio.kind !== 'spotify') throw new AudioLoadError('Not a Spotify song', false);
    this.handle = handle;
    onProgress(1);
  }

  prefetch() {}

  async play(slice: Slice, onTick: (ms: number) => void): Promise<PlayOutcome> {
    this.stop();
    const h = this.handle;
    if (!h) return 'stopped';
    let stopped = false;
    let resolveOuter!: (o: PlayOutcome) => void;
    const outcome = new Promise<PlayOutcome>((r) => (resolveOuter = r));
    let cancelTicks = () => {};
    const finish = (o: PlayOutcome, remotePause: boolean) => {
      if (stopped) return;
      stopped = true;
      cancelTicks();
      if (this.active?.finish === active.finish) this.active = null;
      if (remotePause) void api.spotifyPause(this.deviceId).catch(() => {});
      onTick(o === 'ended' ? slice.endMs : slice.startMs);
      resolveOuter(o);
    };
    const active = { finish: (o: PlayOutcome) => finish(o, o === 'stopped') };
    this.active = active;

    let durationMs = slice.endMs - slice.startMs;
    try {
      const res = await api.spotifyPlay(h.roundId, h.song.roundSongId, this.deviceId, slice.startMs, slice.endMs);
      durationMs = res.durationMs;
    } catch (e) {
      finish('stopped', false);
      if (e instanceof ApiError) throw new AudioLoadError(e.message, false, e.code);
      throw e;
    }
    if (stopped) return outcome;
    const t0 = performance.now();
    cancelTicks = rafLoop(() => {
      const elapsed = performance.now() - t0;
      onTick(Math.min(slice.endMs, slice.startMs + elapsed));
      if (elapsed >= durationMs) {
        finish('ended', false); // the server already scheduled the pause
        return false;
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
  }
}
