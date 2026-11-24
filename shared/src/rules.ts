/**
 * Core Guessong game rules. Shared by the server (authoritative scoring) and
 * the web client (labels, timeline drawing, optimistic UI).
 */

export const ATTEMPTS = 6;
export const SONGS_PER_ROUND = 10;
/** Extra tracks reserved per round so a track that fails to load can be swapped silently. */
export const FALLBACK_SONGS = 3;

/** Total unlocked clip length after each attempt (attempt 1 → index 0). */
export const CLIP_STAGES_MS = [500, 1500, 3000, 5000, 9000, 15000] as const;

/** Base points for a correct guess on attempt N (attempt 1 → index 0). */
export const BASE_POINTS = [100, 80, 60, 40, 20, 10] as const;

export const MAX_ROUND_SCORE = SONGS_PER_ROUND * BASE_POINTS[0];

export type HintType = 'artist' | 'song' | 'cover';
export const HINT_ORDER: readonly HintType[] = ['artist', 'song', 'cover'];

export interface HintRule {
  type: HintType;
  label: string;
  /** Flat points deducted from this song's reward when the hint is used. */
  penalty: number;
  /** The hint can be used once the player is on this attempt or later. */
  unlockAttempt: number;
}

export type HintRules = Record<HintType, HintRule>;

export const DEFAULT_HINT_RULES: HintRules = {
  artist: { type: 'artist', label: 'Artist', penalty: 75, unlockAttempt: 1 },
  song: { type: 'song', label: 'Song', penalty: 100, unlockAttempt: 3 },
  cover: { type: 'cover', label: 'Cover', penalty: 85, unlockAttempt: 1 },
};

/**
 * A correct answer is always worth at least this much, even after hints, so a
 * hint never turns a correct guess into a negative or zero score.
 */
export const DEFAULT_MIN_POINTS_WITH_HINTS = 5;

export interface ScoringRules {
  basePoints: readonly number[];
  hints: HintRules;
  minPointsWithHints: number;
}

export const DEFAULT_SCORING: ScoringRules = {
  basePoints: BASE_POINTS,
  hints: DEFAULT_HINT_RULES,
  minPointsWithHints: DEFAULT_MIN_POINTS_WITH_HINTS,
};

export function clampAttempt(attempt: number): number {
  return Math.min(ATTEMPTS, Math.max(1, Math.floor(attempt)));
}

export function unlockedMs(attempt: number): number {
  return CLIP_STAGES_MS[clampAttempt(attempt) - 1];
}

export function basePoints(attempt: number, rules: ScoringRules = DEFAULT_SCORING): number {
  return rules.basePoints[clampAttempt(attempt) - 1] ?? 0;
}

/**
 * points = correct ? max(minPointsWithHints, base(attempt) − Σ hint penalties) : 0
 * (no floor applies when no hint was used, so the plain table is exact).
 */
export function computeSongPoints(
  input: { correct: boolean; attempt: number; hints: readonly HintType[] },
  rules: ScoringRules = DEFAULT_SCORING,
): number {
  if (!input.correct) return 0;
  const base = basePoints(input.attempt, rules);
  if (input.hints.length === 0) return base;
  const penalty = input.hints.reduce((sum, h) => sum + (rules.hints[h]?.penalty ?? 0), 0);
  return Math.max(rules.minPointsWithHints, base - penalty);
}

export function potentialPoints(attempt: number, hints: readonly HintType[], rules: ScoringRules = DEFAULT_SCORING) {
  return computeSongPoints({ correct: true, attempt, hints }, rules);
}

export function isHintUnlocked(type: HintType, attempt: number, rules: HintRules = DEFAULT_HINT_RULES): boolean {
  return clampAttempt(attempt) >= rules[type].unlockAttempt;
}

/** Audio added by skipping from `attempt` to `attempt + 1`, or null on the last attempt. */
export function skipDeltaMs(attempt: number): number | null {
  const a = clampAttempt(attempt);
  if (a >= ATTEMPTS) return null;
  return CLIP_STAGES_MS[a] - CLIP_STAGES_MS[a - 1];
}

/** "0.5s", "1.5s", "3s", "15s" */
export function formatSeconds(ms: number): string {
  const s = Math.round(ms / 100) / 10;
  return `${Number.isInteger(s) ? s.toFixed(0) : s.toFixed(1)}s`;
}

/** Button label for the skip/reveal button while on `attempt`. */
export function skipLabel(attempt: number): string {
  const delta = skipDeltaMs(attempt);
  return delta === null ? 'Reveal' : `Skip +${formatSeconds(delta)}`;
}

export interface Slice {
  startMs: number;
  endMs: number;
}

/** After skipping from `fromAttempt`, only the newly unlocked audio plays. */
export function sliceAfterSkip(fromAttempt: number): Slice {
  const from = clampAttempt(fromAttempt);
  const to = clampAttempt(from + 1);
  return { startMs: CLIP_STAGES_MS[from - 1], endMs: CLIP_STAGES_MS[to - 1] };
}

/** The manual ▶ button replays the whole unlocked clip from the start. */
export function sliceForReplay(attempt: number): Slice {
  return { startMs: 0, endMs: unlockedMs(attempt) };
}

/** First play of a song: 0 → 0.5s. */
export const FIRST_SLICE: Slice = { startMs: 0, endMs: CLIP_STAGES_MS[0] };

/**
 * Visual widths of the 6 timeline segments (percent). Strictly proportional
 * widths would make the 0.5s segment unreadably thin, so the bar is
 * non-linear and progress is interpolated piecewise-linearly per segment.
 */
export const TIMELINE_SEGMENT_PCT = [8, 10, 14, 18, 22, 28] as const;

export function timeToTimelinePct(ms: number): number {
  if (ms <= 0) return 0;
  let pctStart = 0;
  let msStart = 0;
  for (let i = 0; i < CLIP_STAGES_MS.length; i++) {
    const msEnd = CLIP_STAGES_MS[i];
    const pctEnd = pctStart + TIMELINE_SEGMENT_PCT[i];
    if (ms <= msEnd) {
      return pctStart + ((ms - msStart) / (msEnd - msStart)) * (pctEnd - pctStart);
    }
    pctStart = pctEnd;
    msStart = msEnd;
  }
  return 100;
}

/** Right edge (percent) of the segment that ends at `attempt`'s unlocked length. */
export function timelineEdgePct(attempt: number): number {
  return TIMELINE_SEGMENT_PCT.slice(0, clampAttempt(attempt)).reduce((a, b) => a + b, 0);
}

/** "4:42" */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const DURATION_SPAN = 10_000_000; // ms (~2.7h), longer rounds are clamped

/**
 * Single sortable number for leaderboards (e.g. a Redis ZSET): higher points
 * always win; equal points rank the faster round higher.
 */
export function compositeLeaderboardScore(score: number, durationMs: number): number {
  const d = Math.min(Math.max(0, Math.round(durationMs)), DURATION_SPAN - 1);
  return score * DURATION_SPAN + (DURATION_SPAN - 1 - d);
}
