import type { Slice, SongStateDTO } from '@guessong/shared';

export type EngineKind = 'preview' | 'spotify-sdk' | 'spotify-connect';

export interface SongHandle {
  roundId: string;
  song: SongStateDTO;
}

export type PlayOutcome = 'ended' | 'stopped';

export class AudioLoadError extends Error {
  constructor(
    message: string,
    /** True when the track itself is broken → swap in a fallback track. */
    public replaceable: boolean,
    public code = 'audio_load_failed',
  ) {
    super(message);
  }
}

/**
 * Plays slices of the current song. Times are relative to the clip origin
 * (preview start for Apple, the clip start offset inside the full track for
 * Spotify), so `play({ startMs: 1500, endMs: 3000 })` means "1.5s → 3s".
 */
export interface AudioEngine {
  readonly kind: EngineKind;
  /** Must be called synchronously inside a user gesture (autoplay policies, iOS). */
  unlock(): void;
  /** Buffer/prime the song. `onProgress` receives 0…1. */
  load(handle: SongHandle, onProgress: (p: number) => void): Promise<void>;
  /** Warm the cache for an upcoming song (no-op where unsupported). */
  prefetch(handle: SongHandle): void;
  /** Resolves when the slice finished or was stopped. `onTick` gets the playhead (ms). */
  play(slice: Slice, onTick: (ms: number) => void): Promise<PlayOutcome>;
  stop(): void;
  dispose(): void;
}

/** requestAnimationFrame loop helper that stops when `step` returns false. */
export function rafLoop(step: () => boolean): () => void {
  let id = 0;
  let alive = true;
  const frame = () => {
    if (!alive) return;
    if (step()) id = requestAnimationFrame(frame);
  };
  id = requestAnimationFrame(frame);
  return () => {
    alive = false;
    cancelAnimationFrame(id);
  };
}
