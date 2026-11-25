/**
 * Canonical answer matching: decides whether a guessed track counts as the
 * target track. Title AND artist must match; editions, remasters, single
 * edits and featured credits are ignored.
 */

export interface MatchableTrack {
  id: string;
  title: string;
  /** One entry per credited artist, or a single combined credit string. */
  artists: readonly string[];
  isrc?: string | null;
}

export type MatchReason = 'id' | 'isrc' | 'canonical' | 'none';

export interface MatchResult {
  correct: boolean;
  reason: MatchReason;
}

const EDITION_WORDS = [
  'remaster(?:ed)?',
  'single',
  'edit',
  'radio',
  'version',
  'album',
  'bonus',
  'deluxe',
  'feat\\.?',
  'ft\\.?',
  'featuring',
  'with',
  'live',
  'acoustic',
  'mono',
  'stereo',
  'mix',
  'remix(?:ed)?',
  'explicit',
  'clean',
  'edition',
  'anniversary',
  'demo',
  'instrumental',
  'from',
  'soundtrack',
  'original',
  'extended',
  're-?recorded',
  '\\d{4}',
].join('|');

/** "(Single Edit)", "[2012 Remaster]", "(feat. X)" … but not "(Forget About Me)". */
const BRACKET_EDITION_RE = new RegExp(`\\s*[(\\[][^)\\]]*?(?<![\\p{L}\\p{N}])(?:${EDITION_WORDS})(?![\\p{L}\\p{N}])[^)\\]]*[)\\]]`, 'giu');
/** " - 2011 Remaster", " - Single Version", " - Live at Wembley" */
const HYPHEN_EDITION_RE = new RegExp(`\\s+[-–—]\\s+[^-–—]*?(?<![\\p{L}\\p{N}])(?:${EDITION_WORDS})(?![\\p{L}\\p{N}])[^-–—]*$`, 'iu');
/** Trailing unbracketed "feat. X" */
const TRAILING_FEAT_RE = /\s+(?:feat\.?|ft\.?|featuring)\s+.*$/iu;
const ANY_BRACKETS_RE = /\s*[([][^)\]]*[)\]]/gu;

/** Letters that NFD does not decompose into base + mark. */
const LETTER_FOLDS: Record<string, string> = {
  ı: 'i',
  ß: 'ss',
  ø: 'o',
  æ: 'ae',
  œ: 'oe',
  ł: 'l',
  đ: 'd',
  ð: 'd',
  þ: 'th',
};

function basicNormalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[ıßøæœłđðþ]/g, (ch) => LETTER_FOLDS[ch] ?? ch)
    .replace(/[’‘`´]/g, "'")
    .replace(/&/g, ' and ')
    .replace(/'/g, '')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Display title without edition noise: "Come On Eileen (Single Edit)" → "Come On Eileen". */
export function stripEditionTags(title: string): string {
  let t = title.replace(BRACKET_EDITION_RE, '');
  t = t.replace(HYPHEN_EDITION_RE, '');
  t = t.replace(TRAILING_FEAT_RE, '');
  t = t.trim();
  return t.length > 0 ? t : title.trim();
}

export function normalizeTitle(title: string): string {
  const n = basicNormalize(stripEditionTags(title));
  return n.length > 0 ? n : basicNormalize(title);
}

/** Title with every bracketed part removed; used as a secondary comparison. */
export function normalizeTitleLoose(title: string): string {
  const n = basicNormalize(stripEditionTags(title).replace(ANY_BRACKETS_RE, ' '));
  return n.length > 0 ? n : normalizeTitle(title);
}

const ARTIST_SPLIT_RE = /\s*(?:,|&|\+|\/|;|\s+feat\.?\s+|\s+ft\.?\s+|\s+featuring\s+|\s+with\s+|\s+x\s+|\s+and\s+|\s+vs\.?\s+)\s*/iu;

function normalizeArtistToken(s: string): string {
  return basicNormalize(s).replace(/^the\s+/, '').trim();
}

/** Full normalized credit, e.g. "dexys midnight runners and kevin rowland". */
export function normalizeArtist(artist: string): string {
  return normalizeArtistToken(artist);
}

/** {"dexys midnight runners", "kevin rowland", "dexys midnight runners and kevin rowland"} */
export function artistTokens(artists: readonly string[]): Set<string> {
  const tokens = new Set<string>();
  for (const credit of artists) {
    const full = normalizeArtistToken(credit);
    if (full) tokens.add(full);
    for (const part of credit
      .normalize('NFD')
      .replace(/\p{M}+/gu, '')
      .split(ARTIST_SPLIT_RE)) {
      const t = normalizeArtistToken(part);
      if (t) tokens.add(t);
    }
  }
  return tokens;
}

function containsWords(haystack: string, needle: string): boolean {
  return ` ${haystack} `.includes(` ${needle} `);
}

export function artistsOverlap(a: readonly string[], b: readonly string[]): boolean {
  const ta = artistTokens(a);
  const tb = artistTokens(b);
  for (const t of ta) if (tb.has(t)) return true;
  // "Hall & Oates" vs "Daryl Hall & John Oates": accept a whole-word
  // containment of a reasonably long token in the other side's full credit.
  const fullA = a.map(normalizeArtistToken);
  const fullB = b.map(normalizeArtistToken);
  for (const t of ta) if (t.length >= 4 && fullB.some((f) => containsWords(f, t))) return true;
  for (const t of tb) if (t.length >= 4 && fullA.some((f) => containsWords(f, t))) return true;
  return false;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let cur = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** 1 = identical, 0 = completely different. */
export function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - levenshtein(a, b) / max;
}

export const TITLE_SIMILARITY_THRESHOLD = 0.9;

export function titlesMatch(a: string, b: string): boolean {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (na === nb) return true;
  if (normalizeTitleLoose(a) === normalizeTitleLoose(b)) return true;
  // Tolerate punctuation/typo variants ("Livin' on a Prayer" / "Living on a Prayer")
  // but never for very short titles where one letter changes the song, and never
  // when the numbers differ ("Part 1" / "Part 2", "22" / "23").
  const digits = (s: string) => (s.match(/\d+/g) ?? []).join(' ');
  if (digits(na) !== digits(nb)) return false;
  return Math.min(na.length, nb.length) >= 6 && similarity(na, nb) >= TITLE_SIMILARITY_THRESHOLD;
}

export function matchGuess(target: MatchableTrack, guess: MatchableTrack): MatchResult {
  if (guess.id && guess.id === target.id) return { correct: true, reason: 'id' };
  if (guess.isrc && target.isrc && guess.isrc.toUpperCase() === target.isrc.toUpperCase()) {
    return { correct: true, reason: 'isrc' };
  }
  if (titlesMatch(target.title, guess.title) && artistsOverlap(target.artists, guess.artists)) {
    return { correct: true, reason: 'canonical' };
  }
  return { correct: false, reason: 'none' };
}

/**
 * Song hint: first letter of each word, the rest masked.
 * "Come On Eileen (Single Edit)" → "C••• O• E•••••"
 */
export function maskTitle(title: string): string {
  return stripEditionTags(title)
    .split(/(\s+)/)
    .map((word) => {
      if (/^\s+$/.test(word)) return ' ';
      let seenLetter = false;
      return Array.from(word)
        .map((ch) => {
          if (!/[\p{L}\p{N}]/u.test(ch)) return ch;
          if (!seenLetter) {
            seenLetter = true;
            return ch.toUpperCase();
          }
          return '•';
        })
        .join('');
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}
