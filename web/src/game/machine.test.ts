import { describe, expect, it } from 'vitest';
import type { RevealDTO, RoundDTO, SongStateDTO } from '@guessong/shared';
import { gameReducer, initialGameState, type GameState } from './machine';

const round: RoundDTO = {
  id: 'r1',
  playlist: { id: 'p', title: 'P', artworkUrl: null, mosaic: [] },
  totalSongs: 10,
  totalScore: 0,
  status: 'active',
  challenge: null,
  audioLabel: null,
};

const song = (id: string, attempt = 1): SongStateDTO => ({
  roundSongId: id,
  position: 1,
  attempt,
  unlockedMs: 500,
  status: 'pending',
  hints: {},
  hintsUsed: [],
  log: [],
  potentialPoints: 100,
  audio: { kind: 'preview', url: '/a' },
});

const reveal: RevealDTO = {
  status: 'correct',
  position: 1,
  title: 'T',
  artist: 'A',
  album: null,
  artworkUrl: null,
  externalUrl: null,
  externalLabel: null,
  attemptsUsed: 1,
  timeListenedMs: 500,
  pointsAwarded: 100,
  roundTotalScore: 100,
  isLast: false,
};

const run = (actions: Parameters<typeof gameReducer>[1][], from: GameState = initialGameState) => actions.reduce(gameReducer, from);

describe('game state machine', () => {
  it('loads, becomes ready and plays', () => {
    const s = run([{ type: 'ROUND_LOADED', round, song: song('s1') }, { type: 'LOAD_PROGRESS', progress: 0.5 }, { type: 'SONG_READY' }, { type: 'PLAY_START' }]);
    expect(s.phase).toBe('ready');
    expect(s.playing).toBe(true);
    expect(s.loadProgress).toBe(1);
  });

  it('ignores double submits while busy', () => {
    const ready = run([{ type: 'ROUND_LOADED', round, song: song('s1') }, { type: 'SONG_READY' }, { type: 'BUSY' }]);
    expect(gameReducer(ready, { type: 'BUSY' })).toBe(ready);
  });

  it('records wrong guesses and returns to ready', () => {
    const s = run([
      { type: 'ROUND_LOADED', round, song: song('s1') },
      { type: 'SONG_READY' },
      { type: 'BUSY' },
      { type: 'SONG_UPDATED', song: song('s1', 2), wrong: { title: 'X', artist: 'Y' } },
    ]);
    expect(s.phase).toBe('ready');
    expect(s.song!.attempt).toBe(2);
    expect(s.wrongCount).toBe(1);
    expect(s.lastWrong).toEqual({ title: 'X', artist: 'Y' });
  });

  it('drops updates for a song that is no longer current', () => {
    const s = run([{ type: 'ROUND_LOADED', round, song: song('s1') }, { type: 'SONG_READY' }]);
    expect(gameReducer(s, { type: 'SONG_UPDATED', song: song('other', 3) })).toBe(s);
  });

  it('moves from result to the next song, then to finishing after the last', () => {
    let s = run([{ type: 'ROUND_LOADED', round, song: song('s1') }, { type: 'SONG_READY' }, { type: 'BUSY' }, { type: 'RESOLVED', reveal, next: song('s2') }]);
    expect(s.phase).toBe('result');
    expect(s.score).toBe(100);
    s = gameReducer(s, { type: 'CONTINUE' });
    expect(s.phase).toBe('loading');
    expect(s.song!.roundSongId).toBe('s2');
    s = run([{ type: 'SONG_READY' }, { type: 'BUSY' }, { type: 'RESOLVED', reveal: { ...reveal, isLast: true }, next: null }, { type: 'CONTINUE' }], s);
    expect(s.phase).toBe('finishing');
  });

  it('ignores load progress and plays outside the right phases', () => {
    const s = run([{ type: 'ROUND_LOADED', round, song: song('s1') }, { type: 'SONG_READY' }]);
    expect(gameReducer(s, { type: 'LOAD_PROGRESS', progress: 0.2 })).toBe(s);
    const fin = run([{ type: 'ROUND_LOADED', round, song: null }]);
    expect(fin.phase).toBe('finishing');
    expect(gameReducer(fin, { type: 'PLAY_START' })).toBe(fin);
  });

  it('retries a failed load', () => {
    let s = run([{ type: 'ROUND_LOADED', round, song: song('s1') }, { type: 'ERROR', error: { code: 'x', message: 'x', retry: 'load' } }]);
    expect(s.phase).toBe('error');
    s = gameReducer(s, { type: 'RETRY' });
    expect(s.phase).toBe('loading');
  });
});
