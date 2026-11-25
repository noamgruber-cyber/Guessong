import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeArtist, normalizeTitle, type SearchResultDTO } from '@guessong/shared';

/** data/catalog/<provider>-<storefront>.json, written by `npm run build-catalog`. */
export interface CatalogFile {
  version: 1;
  storefront: string;
  builtAt: string;
  /** [id, title, artist, rank within the artist's songs (1 = most popular)] */
  tracks: [string, string, string, number][];
}

interface Entry {
  id: string;
  title: string;
  artist: string;
  titleWords: string[];
  artistWords: string[];
  normTitle: string;
  key: string;
  rank: number;
}

const NEUTRAL_RANK = 25;

function makeEntry(id: string, title: string, artist: string, rank: number): Entry {
  const normTitle = normalizeTitle(title);
  return {
    id,
    title,
    artist,
    titleWords: normTitle.split(' ').filter(Boolean),
    artistWords: normalizeTitle(artist).split(' ').filter(Boolean),
    normTitle,
    key: `${normTitle}|${normalizeArtist(artist)}`,
    rank,
  };
}

function wordScore(q: string, words: string[], exact: number, prefix: number): number {
  let best = 0;
  for (const w of words) {
    if (w === q) return exact;
    if (w.startsWith(q)) best = prefix;
  }
  return best;
}

/**
 * Local autocomplete over a large static catalog (tens of thousands of songs by
 * the curated playlists' artists and the current charts) plus every track the
 * server has seen. Used when the live search API is throttled, and to pad thin
 * live results.
 *
 * Ranking is text relevance plus the song's popularity within its artist's
 * catalog. Membership in a playlist plays no part, so the suggestions don't
 * give the answer away.
 */
export class CatalogIndex {
  private byStorefront = new Map<string, Entry[]>();
  private extra = new Map<string, Entry>();
  private byId = new Map<string, Entry>();

  static load(dataDir: string, provider: string): CatalogIndex {
    const index = new CatalogIndex();
    const dir = resolve(dataDir, 'catalog');
    if (!existsSync(dir)) return index;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(`${provider}-`) || !name.endsWith('.json')) continue;
      const file = JSON.parse(readFileSync(resolve(dir, name), 'utf8')) as CatalogFile;
      index.addFile(file);
    }
    return index;
  }

  addFile(file: CatalogFile) {
    const entries = file.tracks.map(([id, title, artist, rank]) => makeEntry(id, title, artist, rank));
    this.byStorefront.set(file.storefront, [...(this.byStorefront.get(file.storefront) ?? []), ...entries]);
    for (const e of entries) if (!this.byId.has(e.id)) this.byId.set(e.id, e);
  }

  /** Index a track the server knows about (any storefront). */
  addTrack(id: string, title: string, artists: string[]) {
    if (this.byId.has(id)) return;
    const e = makeEntry(id, title, artists.join(', '), NEUTRAL_RANK);
    this.extra.set(id, e);
    this.byId.set(id, e);
  }

  get size() {
    let n = this.extra.size;
    for (const list of this.byStorefront.values()) n += list.length;
    return n;
  }

  get(id: string): { id: string; title: string; artist: string } | undefined {
    const e = this.byId.get(id);
    return e && { id: e.id, title: e.title, artist: e.artist };
  }

  search(query: string, storefront: string, limit: number): SearchResultDTO[] {
    const normQuery = normalizeTitle(query);
    const qWords = normQuery.split(' ').filter(Boolean).slice(0, 6);
    if (!qWords.length) return [];

    const scored: { e: Entry; s: number }[] = [];
    const consider = (e: Entry) => {
      let s = 0;
      for (const q of qWords) {
        const t = wordScore(q, e.titleWords, 3, 2);
        const a = wordScore(q, e.artistWords, 1.5, 1);
        if (!t && !a) return;
        s += Math.max(t, a);
      }
      if (e.normTitle === normQuery) s += 3;
      else if (e.normTitle.startsWith(normQuery)) s += 2;
      s += ((50 - Math.min(e.rank, 50)) / 50) * 1.5;
      scored.push({ e, s });
    };
    for (const e of this.byStorefront.get(storefront) ?? []) consider(e);
    for (const e of this.extra.values()) consider(e);

    scored.sort((a, b) => b.s - a.s);
    const seen = new Set<string>();
    const out: SearchResultDTO[] = [];
    for (const { e } of scored) {
      if (seen.has(e.key)) continue;
      seen.add(e.key);
      out.push({ id: e.id, title: e.title, artist: e.artist });
      if (out.length >= limit) break;
    }
    return out;
  }
}
