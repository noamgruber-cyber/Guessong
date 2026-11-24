import { describe, expect, it } from 'vitest';
import {
  CLIP_STAGES_MS,
  computeSongPoints,
  compositeLeaderboardScore,
  formatDuration,
  formatSeconds,
  isHintUnlocked,
  potentialPoints,
  skipLabel,
  sliceAfterSkip,
  sliceForReplay,
  timeToTimelinePct,
  timelineEdgePct,
  unlockedMs,
} from '../src/rules';

describe('clip stages', () => {
  it('unlocks 0.5 → 15s across 6 attempts', () => {
    expect([1, 2, 3, 4, 5, 6].map(unlockedMs)).toEqual([500, 1500, 3000, 5000, 9000, 15000]);
  });

  it('labels the skip button with the audio it adds', () => {
    expect([1, 2, 3, 4, 5, 6].map(skipLabel)).toEqual([
      'Skip +1s',
      'Skip +1.5s',
      'Skip +2s',
      'Skip +4s',
      'Skip +6s',
      'Reveal',
    ]);
  });

  it('plays only the newly unlocked slice after a skip', () => {
    expect(sliceAfterSkip(2)).toEqual({ startMs: 1500, endMs: 3000 });
    expect(sliceAfterSkip(1)).toEqual({ startMs: 500, endMs: 1500 });
    expect(sliceAfterSkip(5)).toEqual({ startMs: 9000, endMs: 15000 });
  });

  it('replays the whole unlocked clip from 0 on manual play', () => {
    expect(sliceForReplay(3)).toEqual({ startMs: 0, endMs: 3000 });
  });

  it('formats seconds compactly', () => {
    expect(CLIP_STAGES_MS.map(formatSeconds)).toEqual(['0.5s', '1.5s', '3s', '5s', '9s', '15s']);
  });
});

describe('scoring', () => {
  it('matches the base table, with attempt 3 worth 60', () => {
    expect([1, 2, 3, 4, 5, 6].map((attempt) => computeSongPoints({ correct: true, attempt, hints: [] }))).toEqual([
      100, 80, 60, 40, 20, 10,
    ]);
  });

  it('awards 0 for a miss', () => {
    expect(computeSongPoints({ correct: false, attempt: 1, hints: [] })).toBe(0);
  });

  it('deducts hint penalties but never below the floor', () => {
    expect(computeSongPoints({ correct: true, attempt: 1, hints: ['artist'] })).toBe(25);
    expect(computeSongPoints({ correct: true, attempt: 1, hints: ['cover'] })).toBe(15);
    expect(computeSongPoints({ correct: true, attempt: 3, hints: ['artist'] })).toBe(5);
    expect(computeSongPoints({ correct: true, attempt: 1, hints: ['artist', 'cover'] })).toBe(5);
    expect(potentialPoints(6, ['song'])).toBe(5);
  });

  it('keeps the song hint locked until attempt 3', () => {
    expect(isHintUnlocked('song', 1)).toBe(false);
    expect(isHintUnlocked('song', 2)).toBe(false);
    expect(isHintUnlocked('song', 3)).toBe(true);
    expect(isHintUnlocked('artist', 1)).toBe(true);
  });
});

describe('timeline', () => {
  it('maps stage boundaries to segment edges', () => {
    expect(timeToTimelinePct(0)).toBe(0);
    expect(timeToTimelinePct(500)).toBeCloseTo(8);
    expect(timeToTimelinePct(1500)).toBeCloseTo(18);
    expect(timeToTimelinePct(15000)).toBeCloseTo(100);
    expect(timeToTimelinePct(20000)).toBe(100);
    expect(timelineEdgePct(2)).toBe(18);
  });

  it('interpolates inside a segment', () => {
    expect(timeToTimelinePct(250)).toBeCloseTo(4);
    expect(timeToTimelinePct(1000)).toBeCloseTo(13);
  });
});

describe('leaderboard ordering', () => {
  it('ranks higher score first, then faster time', () => {
    const a = compositeLeaderboardScore(720, 282_000);
    const b = compositeLeaderboardScore(720, 212_000);
    const c = compositeLeaderboardScore(690, 100_000);
    expect(b).toBeGreaterThan(a);
    expect(a).toBeGreaterThan(c);
  });

  it('formats durations as m:ss', () => {
    expect(formatDuration(282_000)).toBe('4:42');
    expect(formatDuration(212_400)).toBe('3:32');
  });
});
