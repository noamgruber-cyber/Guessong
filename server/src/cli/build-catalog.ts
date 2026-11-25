/**
 * Build the static autocomplete catalog for Apple mode.
 *
 *   npm run build-catalog                 # every storefront used by the seed playlists
 *   npm run build-catalog -- --only il,tr # some storefronts
 *
 * For each storefront it collects the artists of the curated playlists plus the
 * artists of Apple's current top-100 chart, then fetches up to 50 songs per
 * artist. The result (data/catalog/apple-<storefront>.json) lets guess search
 * return real, varied suggestions even while the iTunes Search API is
 * rate-limiting us, so the suggestions never shrink to "the playlist's songs".
 *
 * It paces itself to ~17 requests/minute (Apple's limit is about 20/minute).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeArtist, normalizeTitle } from '@guessong/shared';
import { loadConfig } from '../config';
import { sleep } from '../lib/util';
import { loadPins, loadSeedPlaylists } from '../seeds';
import type { CatalogFile } from '../services/catalogIndex';

const BASE = 'https://itunes.apple.com';
const SONGS_PER_ARTIST = 50;
const ARTISTS_PER_REQUEST = 15;
const GAP_MS = 3_600;

interface ItunesRow {
  wrapperType?: string;
  kind?: string;
  trackId?: number;
  trackName?: string;
  artistId?: number;
  artistName?: string;
  primaryGenreName?: string;
}

let lastCall = 0;
async function itunes(path: string): Promise<ItunesRow[]> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const wait = lastCall + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    try {
      const res = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
      if (res.status === 403 || res.status === 429 || res.status >= 500) {
        console.log(`  ${res.status} from Apple, backing off 60s`);
        await sleep(60_000);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { results?: ItunesRow[] };
      return body.results ?? [];
    } catch (e) {
      console.log(`  request failed (${(e as Error).message}), retrying`);
      await sleep(5_000);
    }
  }
  throw new Error(`Giving up on ${path}`);
}

async function chartSongIds(storefront: string): Promise<string[]> {
  const url = `https://rss.marketingtools.apple.com/api/v2/${storefront}/music/most-played/100/songs.json`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const body = (await res.json()) as { feed?: { results?: { id: string }[] } };
    return (body.feed?.results ?? []).map((r) => r.id);
  } catch {
    return [];
  }
}

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

async function buildStorefront(storefront: string, seedTrackIds: string[]): Promise<CatalogFile> {
  const charts = await chartSongIds(storefront);
  console.log(`[${storefront}] ${seedTrackIds.length} playlist songs, ${charts.length} chart songs`);

  // 1) Resolve the artists behind the playlist and chart songs.
  const artistOrder: number[] = [];
  const seenArtist = new Set<number>();
  for (const ids of chunk([...new Set([...seedTrackIds, ...charts])], 150)) {
    for (const r of await itunes(`/lookup?id=${ids.join(',')}&country=${storefront}`)) {
      if (r.artistId && !seenArtist.has(r.artistId)) {
        seenArtist.add(r.artistId);
        artistOrder.push(r.artistId);
      }
    }
  }
  console.log(`[${storefront}] ${artistOrder.length} artists`);

  // 2) Up to 50 songs per artist (Apple returns them roughly by popularity).
  const tracks: CatalogFile['tracks'] = [];
  const seenId = new Set<string>();
  const seenKey = new Set<string>();
  const batches = chunk(artistOrder, ARTISTS_PER_REQUEST);
  for (const [i, ids] of batches.entries()) {
    const rows = await itunes(`/lookup?id=${ids.join(',')}&entity=song&limit=${SONGS_PER_ARTIST}&country=${storefront}`);
    const perArtistRank = new Map<number, number>();
    for (const r of rows) {
      if (r.wrapperType !== 'track' || (r.kind && r.kind !== 'song') || !r.trackId || !r.trackName || !r.artistName) continue;
      const rank = (perArtistRank.get(r.artistId ?? 0) ?? 0) + 1;
      perArtistRank.set(r.artistId ?? 0, rank);
      const id = String(r.trackId);
      const key = `${normalizeTitle(r.trackName)}|${normalizeArtist(r.artistName)}`;
      if (seenId.has(id) || seenKey.has(key)) continue;
      seenId.add(id);
      seenKey.add(key);
      tracks.push([id, r.trackName, r.artistName, rank]);
    }
    if ((i + 1) % 5 === 0 || i === batches.length - 1) {
      console.log(`[${storefront}] ${i + 1}/${batches.length} artist batches, ${tracks.length} songs`);
    }
  }
  return { version: 1, storefront, builtAt: new Date().toISOString().slice(0, 10), tracks };
}

async function main() {
  const args = process.argv.slice(2);
  const onlyIdx = args.indexOf('--only');
  const only = onlyIdx >= 0 ? args[onlyIdx + 1]?.split(',') : null;

  const config = loadConfig();
  const seeds = loadSeedPlaylists(config.dataDir);
  const pins = loadPins(config.dataDir, 'apple');
  const byStorefront = new Map<string, string[]>();
  for (const s of seeds) {
    const ids = Object.values(pins[s.id] ?? {});
    byStorefront.set(s.storefront, [...(byStorefront.get(s.storefront) ?? []), ...ids]);
  }

  const outDir = resolve(config.dataDir, 'catalog');
  mkdirSync(outDir, { recursive: true });
  for (const [storefront, ids] of byStorefront) {
    if (only && !only.includes(storefront)) continue;
    const file = await buildStorefront(storefront, ids);
    // One track per line keeps diffs readable when the catalog is rebuilt.
    const body = `{"version":1,"storefront":${JSON.stringify(storefront)},"builtAt":${JSON.stringify(file.builtAt)},"tracks":[\n${file.tracks
      .map((t) => JSON.stringify(t))
      .join(',\n')}\n]}\n`;
    writeFileSync(resolve(outDir, `apple-${storefront}.json`), body);
    console.log(`[${storefront}] wrote ${file.tracks.length} songs`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
