import { useCallback, useEffect, useReducer, useRef } from 'react';
import {
  FIRST_SLICE,
  sliceAfterSkip,
  sliceForReplay,
  type HintType,
  type RevealDTO,
  type Slice,
  type SongStateDTO,
} from '@guessong/shared';
import { api, ApiError } from '../api';
import { AudioLoadError, type AudioEngine } from '../audio/engine';
import { getEngine, NeedsDeviceError, SdkUnavailableError } from '../audio';
import { haptic } from '../lib/util';
import { useSession } from '../lib/session';
import { gameReducer, initialGameState } from './machine';

/** Tiny external store for the playhead so 60fps ticks don't re-render the whole screen. */
export class Playhead {
  private ms = 0;
  private listeners = new Set<() => void>();
  get = () => this.ms;
  set(ms: number) {
    if (ms === this.ms) return;
    this.ms = ms;
    this.listeners.forEach((l) => l());
  }
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
}

/** How long the result card keeps playing the song in the background. */
const RESULT_LISTEN: Slice = { startMs: 0, endMs: 29_500 };

export function useGame(roundId: string) {
  const { config, toast } = useSession();
  const [state, dispatch] = useReducer(gameReducer, initialGameState);
  const engineRef = useRef<AudioEngine | null>(null);
  const playSeq = useRef(0);
  const playhead = useRef(new Playhead()).current;
  const stateRef = useRef(state);
  stateRef.current = state;
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      playSeq.current++;
      engineRef.current?.stop();
    };
  }, []);

  const fail = useCallback((e: unknown, retry: 'load' | 'finish' | null) => {
    if (!mounted.current) return;
    if (e instanceof NeedsDeviceError) {
      dispatch({ type: 'ERROR', error: { code: 'needs_device', message: e.message, retry: 'load' } });
    } else if (e instanceof SdkUnavailableError && e.reason === 'premium_required') {
      dispatch({ type: 'ERROR', error: { code: 'premium_required', message: 'Spotify Premium is required to play.', retry: null } });
    } else if (e instanceof ApiError || e instanceof AudioLoadError) {
      dispatch({ type: 'ERROR', error: { code: e.code, message: e.message, retry } });
    } else {
      dispatch({ type: 'ERROR', error: { code: 'unknown', message: (e as Error)?.message ?? 'Something went wrong', retry } });
    }
  }, []);

  const stopAudio = useCallback(() => {
    playSeq.current++;
    engineRef.current?.stop();
    dispatch({ type: 'PLAY_END' });
  }, []);

  const playSlice = useCallback(async (slice: Slice) => {
    const engine = engineRef.current;
    if (!engine) return;
    const seq = ++playSeq.current;
    dispatch({ type: 'PLAY_START' });
    playhead.set(slice.startMs);
    try {
      await engine.play(slice, (ms) => {
        if (seq === playSeq.current) playhead.set(ms);
      });
    } catch (e) {
      if (seq === playSeq.current) toast(e instanceof Error ? e.message : 'Playback failed', 'error');
    } finally {
      if (seq === playSeq.current && mounted.current) dispatch({ type: 'PLAY_END' });
    }
  }, [playhead, toast]);

  const loadSong = useCallback(
    async (song: SongStateDTO): Promise<void> => {
      if (!config) return;
      playhead.set(0);
      let engine: AudioEngine;
      try {
        engine = await getEngine(config);
        engineRef.current = engine;
      } catch (e) {
        fail(e, 'load');
        return;
      }
      try {
        await engine.load({ roundId, song }, (p) => dispatch({ type: 'LOAD_PROGRESS', progress: p }));
      } catch (e) {
        const fresh = song.attempt === 1 && song.hintsUsed.length === 0 && song.log.length === 0;
        if (e instanceof AudioLoadError && e.replaceable && fresh) {
          try {
            const { song: replacement } = await api.replace(roundId, song.roundSongId);
            dispatch({ type: 'SONG_REPLACED', song: replacement });
            return loadSong(replacement);
          } catch (re) {
            fail(re, 'load');
            return;
          }
        }
        fail(e, 'load');
        return;
      }
      if (!mounted.current) return;
      dispatch({ type: 'SONG_READY' });
      try {
        await api.start(roundId, song.roundSongId); // starts this song's server-side clock
      } catch {
        /* non-fatal */
      }
      playhead.set(0);
      // Attempt 1 auto-plays 0 → 0.5s. When resuming mid-song, wait for ▶.
      if (song.attempt === 1 && song.log.length === 0) void playSlice(FIRST_SLICE);
    },
    [config, roundId, fail, playSlice, playhead],
  );

  const finish = useCallback(async () => {
    try {
      const summary = await api.complete(roundId);
      if (mounted.current) dispatch({ type: 'SUMMARY', summary });
    } catch (e) {
      fail(e, 'finish');
    }
  }, [roundId, fail]);

  // Initial load / resume after refresh.
  useEffect(() => {
    if (!config) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.round(roundId);
        if (cancelled) return;
        if (res.round.status === 'completed') {
          dispatch({ type: 'ROUND_LOADED', round: res.round, song: null });
          dispatch({ type: 'SUMMARY', summary: await api.summary(roundId) });
          return;
        }
        if (res.round.status === 'abandoned') {
          fail(new ApiError(410, 'round_abandoned', 'This round was abandoned.'), null);
          return;
        }
        dispatch({ type: 'ROUND_LOADED', round: res.round, song: res.song });
        if (res.song) void loadSong(res.song);
        else void finish();
      } catch (e) {
        fail(e, null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roundId, config]);

  // ---- player actions ---------------------------------------------------------

  const togglePlay = useCallback(() => {
    const s = stateRef.current;
    if (!s.song || (s.phase !== 'ready' && s.phase !== 'result')) return;
    haptic();
    if (s.playing) stopAudio();
    else void playSlice(s.phase === 'result' ? RESULT_LISTEN : sliceForReplay(s.song.attempt));
  }, [playSlice, stopAudio]);

  const resolveWith = useCallback(
    (revealed: RevealDTO, nextSong: SongStateDTO | null) => {
      dispatch({ type: 'RESOLVED', reveal: revealed, next: nextSong });
      haptic(revealed.status === 'correct' ? 'success' : 'error');
      if (nextSong) engineRef.current?.prefetch({ roundId, song: nextSong });
      // Keep the song playing while the result card is up.
      void playSlice(RESULT_LISTEN);
    },
    [playSlice, roundId],
  );

  const reveal = useCallback(async () => {
    const s = stateRef.current;
    if (!s.song || s.phase !== 'ready') return;
    dispatch({ type: 'BUSY' });
    stopAudio();
    try {
      const r = await api.reveal(roundId, s.song.roundSongId);
      resolveWith(r.reveal, r.next);
    } catch (e) {
      dispatch({ type: 'ACTION_FAILED' });
      toast((e as Error).message, 'error');
    }
  }, [roundId, resolveWith, stopAudio, toast]);

  const skip = useCallback(async () => {
    const s = stateRef.current;
    if (!s.song || s.phase !== 'ready') return;
    if (s.song.attempt >= (config?.attempts ?? 6)) return reveal();
    const from = s.song.attempt;
    dispatch({ type: 'BUSY' });
    stopAudio();
    haptic();
    try {
      const r = await api.skip(roundId, s.song.roundSongId);
      dispatch({ type: 'SONG_UPDATED', song: r.song });
      void playSlice(sliceAfterSkip(from)); // only the newly unlocked audio
    } catch (e) {
      dispatch({ type: 'ACTION_FAILED' });
      toast((e as Error).message, 'error');
    }
  }, [config, roundId, playSlice, reveal, stopAudio, toast]);

  const guess = useCallback(
    async (trackId: string) => {
      const s = stateRef.current;
      if (!s.song || s.phase !== 'ready') return false;
      dispatch({ type: 'BUSY' });
      stopAudio();
      try {
        const r = await api.guess(roundId, s.song.roundSongId, trackId);
        if (r.status === 'wrong') {
          haptic('error');
          dispatch({ type: 'SONG_UPDATED', song: r.song, wrong: r.guess });
        } else {
          resolveWith(r.reveal, r.next);
        }
        return true;
      } catch (e) {
        dispatch({ type: 'ACTION_FAILED' });
        toast((e as Error).message, 'error');
        return false;
      }
    },
    [roundId, resolveWith, stopAudio, toast],
  );

  const hint = useCallback(
    async (type: HintType) => {
      const s = stateRef.current;
      if (!s.song || s.phase !== 'ready') return;
      haptic();
      try {
        const r = await api.hint(roundId, s.song.roundSongId, type);
        dispatch({ type: 'SONG_UPDATED', song: r.song });
      } catch (e) {
        toast((e as Error).message, 'error');
      }
    },
    [roundId, toast],
  );

  /** Must be called from the Continue tap (keeps audio unlocked on iOS). */
  const next = useCallback(() => {
    const s = stateRef.current;
    if (s.phase !== 'result') return;
    stopAudio();
    engineRef.current?.unlock();
    dispatch({ type: 'CONTINUE' });
    if (s.next) void loadSong(s.next);
    else void finish();
  }, [finish, loadSong, stopAudio]);

  const retry = useCallback(() => {
    const s = stateRef.current;
    if (s.phase !== 'error' || !s.error?.retry) return;
    engineRef.current?.unlock();
    dispatch({ type: 'RETRY' });
    if (s.error.retry === 'load' && s.song) void loadSong(s.song);
    if (s.error.retry === 'finish') void finish();
  }, [finish, loadSong]);

  const abandon = useCallback(async () => {
    stopAudio();
    try {
      await api.abandon(roundId);
    } catch {
      /* leaving anyway */
    }
  }, [roundId, stopAudio]);

  return { state, playhead, togglePlay, skip, guess, hint, reveal, next, retry, abandon, stopAudio };
}
