import type { RevealDTO, RoundDTO, RoundSummaryDTO, SongStateDTO } from '@guessong/shared';

/**
 * Per-round finite state machine. All network/audio side effects live in
 * useGame; this reducer only decides which transitions are legal, which
 * prevents races such as double submits, stale playback ticks or a skip
 * landing after the song was already resolved.
 *
 *   loading ──SONG_READY──▶ ready ⇄ busy ──RESOLVED──▶ result ──CONTINUE──▶ loading | finishing
 *      ▲  └─SONG_REPLACED─┘                                                    finishing ──SUMMARY──▶ summary
 *      └─────────────── any ──ERROR──▶ error ──RETRY──▶ loading | finishing
 */

export type Phase = 'init' | 'loading' | 'ready' | 'busy' | 'result' | 'finishing' | 'summary' | 'error';

export interface GameError {
  code: string;
  message: string;
  retry: 'load' | 'finish' | null;
}

export interface GameState {
  phase: Phase;
  round: RoundDTO | null;
  song: SongStateDTO | null;
  reveal: RevealDTO | null;
  next: SongStateDTO | null;
  score: number;
  loadProgress: number;
  playing: boolean;
  lastWrong: { title: string; artist: string } | null;
  /** Increments on every wrong guess (drives the shake animation). */
  wrongCount: number;
  summary: RoundSummaryDTO | null;
  error: GameError | null;
}

export const initialGameState: GameState = {
  phase: 'init',
  round: null,
  song: null,
  reveal: null,
  next: null,
  score: 0,
  loadProgress: 0,
  playing: false,
  lastWrong: null,
  wrongCount: 0,
  summary: null,
  error: null,
};

export type GameAction =
  | { type: 'ROUND_LOADED'; round: RoundDTO; song: SongStateDTO | null }
  | { type: 'LOAD_PROGRESS'; progress: number }
  | { type: 'SONG_REPLACED'; song: SongStateDTO }
  | { type: 'SONG_READY' }
  | { type: 'PLAY_START' }
  | { type: 'PLAY_END' }
  | { type: 'BUSY' }
  | { type: 'ACTION_FAILED' }
  | { type: 'SONG_UPDATED'; song: SongStateDTO; wrong?: { title: string; artist: string } }
  | { type: 'RESOLVED'; reveal: RevealDTO; next: SongStateDTO | null }
  | { type: 'CONTINUE' }
  | { type: 'SUMMARY'; summary: RoundSummaryDTO }
  | { type: 'ERROR'; error: GameError }
  | { type: 'RETRY' };

export function gameReducer(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case 'ROUND_LOADED':
      return {
        ...initialGameState,
        round: action.round,
        song: action.song,
        score: action.round.totalScore,
        phase: action.song ? 'loading' : 'finishing',
      };

    case 'LOAD_PROGRESS':
      if (state.phase !== 'loading') return state;
      return { ...state, loadProgress: Math.max(state.loadProgress, Math.min(1, action.progress)) };

    case 'SONG_REPLACED':
      if (state.phase !== 'loading') return state;
      return { ...state, song: action.song, loadProgress: 0 };

    case 'SONG_READY':
      if (state.phase !== 'loading') return state;
      return { ...state, phase: 'ready', loadProgress: 1 };

    case 'PLAY_START':
      if (state.phase !== 'ready' && state.phase !== 'result') return state;
      return { ...state, playing: true };

    case 'PLAY_END':
      return state.playing ? { ...state, playing: false } : state;

    case 'BUSY':
      if (state.phase !== 'ready') return state;
      return { ...state, phase: 'busy' };

    case 'ACTION_FAILED':
      return state.phase === 'busy' ? { ...state, phase: 'ready' } : state;

    case 'SONG_UPDATED': {
      if (!state.song || action.song.roundSongId !== state.song.roundSongId) return state;
      if (state.phase !== 'busy' && state.phase !== 'ready') return state;
      return {
        ...state,
        phase: 'ready',
        song: action.song,
        lastWrong: action.wrong ?? state.lastWrong,
        wrongCount: action.wrong ? state.wrongCount + 1 : state.wrongCount,
      };
    }

    case 'RESOLVED':
      if (state.phase !== 'busy' && state.phase !== 'ready') return state;
      return {
        ...state,
        phase: 'result',
        reveal: action.reveal,
        next: action.next,
        score: action.reveal.roundTotalScore,
        playing: false,
      };

    case 'CONTINUE':
      if (state.phase !== 'result') return state;
      if (state.next) {
        return { ...state, phase: 'loading', song: state.next, next: null, reveal: null, loadProgress: 0, lastWrong: null, playing: false };
      }
      return { ...state, phase: 'finishing', playing: false };

    case 'SUMMARY':
      return { ...state, phase: 'summary', summary: action.summary, score: action.summary.totalScore, playing: false };

    case 'ERROR':
      return { ...state, phase: 'error', error: action.error, playing: false };

    case 'RETRY':
      if (state.phase !== 'error' || !state.error?.retry) return state;
      return {
        ...state,
        phase: state.error.retry === 'load' ? 'loading' : 'finishing',
        error: null,
        loadProgress: 0,
      };
  }
}
