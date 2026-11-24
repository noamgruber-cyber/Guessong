import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { normalizeArtist, normalizeTitle } from '@guessong/shared';
import type { SeedTrack } from './providers/types';

/**
 * Curated playlists live in server/data/playlists.json as seed lists of
 * "title / artist" pairs. They are resolved against the active provider at
 * ingestion time, so the same curation works for Apple and Spotify (Spotify
 * Development Mode apps can't read editorial or other users' playlists).
 */

const trackSchema = z.union([
  z.tuple([z.string(), z.string()]),
  z.object({
    title: z.string(),
    artist: z.string(),
    startAt: z.string().optional(),
    apple: z.union([z.string(), z.number()]).optional(),
    spotify: z.string().optional(),
  }),
]);

const playlistSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string(),
  description: z.string().optional(),
  lang: z.string(),
  storefront: z.string().length(2),
  tracks: z.array(trackSchema).min(1),
});

const fileSchema = z.object({ playlists: z.array(playlistSchema) });

export interface SeedPlaylist {
  id: string;
  title: string;
  description: string | null;
  lang: string;
  storefront: string;
  tracks: SeedTrack[];
}

export function seedKey(seed: { title: string; artist: string }): string {
  return `${normalizeTitle(seed.title)}|${normalizeArtist(seed.artist)}`;
}

export function loadSeedPlaylists(dataDir: string): SeedPlaylist[] {
  const file = resolve(dataDir, 'playlists.json');
  const parsed = fileSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  const pins = loadPins(dataDir, 'apple');
  return parsed.playlists.map((p) => ({
    id: p.id,
    title: p.title,
    description: p.description ?? null,
    lang: p.lang,
    storefront: p.storefront.toUpperCase(),
    tracks: p.tracks.map((t) => {
      const seed: SeedTrack = Array.isArray(t)
        ? { title: t[0], artist: t[1] }
        : { title: t.title, artist: t.artist, startAt: t.startAt, apple: t.apple?.toString(), spotify: t.spotify };
      const pinned = pins[p.id]?.[seedKey(seed)];
      if (!seed.apple && pinned) seed.apple = String(pinned);
      return seed;
    }),
  }));
}

type Pins = Record<string, Record<string, string>>;

function pinsPath(dataDir: string, provider: string) {
  return resolve(dataDir, 'pins', `${provider}.json`);
}

/** Resolved provider ids, so later ingestions use one batched lookup instead of N searches. */
export function loadPins(dataDir: string, provider: string): Pins {
  const p = pinsPath(dataDir, provider);
  if (!existsSync(p)) return {};
  return JSON.parse(readFileSync(p, 'utf8')) as Pins;
}

export function savePins(dataDir: string, provider: string, pins: Pins) {
  const sorted: Pins = {};
  for (const k of Object.keys(pins).sort()) {
    sorted[k] = Object.fromEntries(Object.entries(pins[k]).sort(([a], [b]) => a.localeCompare(b)));
  }
  writeFileSync(pinsPath(dataDir, provider), `${JSON.stringify(sorted, null, 2)}\n`);
}

/** "1:02" → 62000 */
export function parseStartAt(v: string | undefined): number | null {
  if (!v) return null;
  const m = /^(\d+):(\d{1,2})(?:\.(\d+))?$/.exec(v.trim());
  if (!m) return null;
  return (Number(m[1]) * 60 + Number(m[2])) * 1000 + (m[3] ? Number(`0.${m[3]}`) * 1000 : 0);
}
