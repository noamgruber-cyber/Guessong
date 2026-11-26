import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { openDb } from '../src/db';
import { AppleProvider } from '../src/providers/apple';
import type { MusicProvider, ProviderTrack } from '../src/providers/types';
import { UpstreamThrottledError } from '../src/providers/types';
import { Catalog } from '../src/services/catalog';
import { CatalogIndex, type CatalogFile } from '../src/services/catalogIndex';
import { SearchService } from '../src/services/search';

const file: CatalogFile = {
  version: 1,
  storefront: 'us',
  builtAt: '2026-11-25',
  tracks: [
    ['1', 'Come On Eileen', 'Dexys Midnight Runners', 1],
    ['2', 'Geno', 'Dexys Midnight Runners', 2],
    ['3', 'Jackie Wilson Said', 'Dexys Midnight Runners', 3],
    ['4', 'Come Together', 'The Beatles', 1],
    ['5', 'Come As You Are', 'Nirvana', 2],
    ['6', 'Come On Over', 'Shania Twain', 4],
    ['7', 'Come Away With Me', 'Norah Jones', 1],
    ['8', 'Come On Eileen (Single Edit)', 'Dexys Midnight Runners', 9],
    ['9', 'Eileen', 'Keedy', 30],
    ['10', 'Here Comes the Sun', 'The Beatles', 2],
  ],
};

function track(id: string, title: string, artist: string): ProviderTrack {
  return { id, title, artists: [artist], album: null, artworkUrl: null, previewUrl: null, isrc: null, durationMs: null, uri: null, externalUrl: null };
}

function fakeProvider(search: () => Promise<ProviderTrack[]>, getTrack = async (): Promise<ProviderTrack | null> => null): MusicProvider {
  return {
    id: 'apple',
    label: 'Apple Music',
    playback: 'preview',
    search,
    getTrack,
    getTracks: async () => [],
    seedQueries: () => [],
    searchPatiently: search,
    isThrottled: () => false,
  };
}

function setup(provider: MusicProvider) {
  const config = loadConfig({ dbPath: ':memory:', ingestOnStart: false, webDistDir: null }, { MUSIC_PROVIDER: 'apple' } as NodeJS.ProcessEnv);
  const db = openDb(':memory:');
  const index = new CatalogIndex();
  index.addFile(file);
  const catalog = new Catalog(db, provider, config, index);
  return { index, catalog, search: new SearchService(provider, catalog, index) };
}

describe('CatalogIndex', () => {
  it('matches word prefixes in title or artist and ranks by relevance', () => {
    const index = new CatalogIndex();
    index.addFile(file);
    const r = index.search('come on ei', 'us', 10).map((x) => x.title);
    expect(r[0]).toBe('Come On Eileen');
    // The single edit is the same song for search purposes, so it's not listed twice.
    expect(r.filter((t) => t.startsWith('Come On Eileen'))).toHaveLength(1);
    expect(index.search('dexys', 'us', 10).map((x) => x.title)).toEqual(['Come On Eileen', 'Geno', 'Jackie Wilson Said']);
    expect(index.search('beatles', 'us', 10)).toHaveLength(2);
    expect(index.search('come', 'gb', 10)).toHaveLength(0);
  });

  it('finds an artist by either spelling of their name', () => {
    const index = new CatalogIndex();
    index.setAliases([['Noa Kirel', 'נועה קירל']]);
    index.addFile({ version: 1, storefront: 'il', builtAt: '', tracks: [['n1', 'Unicorn', 'Noa Kirel', 1], ['n2', 'בריידזילה', 'נועה קירל', 2], ['x', 'Other', 'Someone', 1]] });
    expect(index.search('נועה', 'il', 10).map((x) => x.id)).toEqual(['n1', 'n2']);
    expect(index.search('noa kirel', 'il', 10).map((x) => x.id)).toEqual(['n1', 'n2']);
    expect(index.search('unicorn נועה', 'il', 10).map((x) => x.id)).toEqual(['n1']);
  });

  it('handles Hebrew titles', () => {
    const index = new CatalogIndex();
    index.addFile({ version: 1, storefront: 'il', builtAt: '', tracks: [['h1', 'תל אביב', 'עומר אדם', 1], ['h2', 'תפילה', 'Omer Adam', 2]] });
    expect(index.search('תל', 'il', 10).map((x) => x.id)).toEqual(['h1']);
    expect(index.search('omer', 'il', 10).map((x) => x.id)).toEqual(['h2']);
  });
});

describe('SearchService', () => {
  it('uses live results first and pads thin ones from the local catalog', async () => {
    const { search } = setup(fakeProvider(async () => [track('900', 'Come On Eileen', 'Dexys Midnight Runners')]));
    const res = await search.search('come', 'us');
    expect(res.partial).toBe(false);
    expect(res.results[0].id).toBe('900');
    expect(res.results.length).toBeGreaterThanOrEqual(6);
    expect(res.results.filter((r) => r.title === 'Come On Eileen')).toHaveLength(1);
  });

  it('still gives varied suggestions, not just playlist songs, while the live API is throttled', async () => {
    const { search, catalog } = setup(
      fakeProvider(async () => {
        throw new UpstreamThrottledError(30_000);
      }),
    );
    // A playlist track the server knows about.
    catalog.upsertTrack(track('pl-1', 'Come On Eileen', 'Dexys Midnight Runners'));
    const res = await search.search('come', 'us');
    expect(res.partial).toBe(true);
    expect(res.results.length).toBeGreaterThanOrEqual(6);
    expect(res.results.map((r) => r.title)).toEqual(expect.arrayContaining(['Come Together', 'Come As You Are', 'Come On Over']));
  });

  it('puts an exact title match first even when the live API buries it', async () => {
    const { search } = setup(
      fakeProvider(async () => Array.from({ length: 12 }, (_, i) => track(`junk${i}`, `I'm Song ${i}`, `Someone ${i}`))),
    );
    // "Geno" exists only in the local catalog; live results are all unrelated.
    const res = await search.search('geno', 'us');
    expect(res.results[0].title).toBe('Geno');
    const typed = await search.search('geno dexys', 'us');
    expect(typed.results[0].title).toBe('Geno');
  });

  it('falls back to the local catalog when the live API errors', async () => {
    const { search } = setup(
      fakeProvider(async () => {
        throw new Error('timeout');
      }),
    );
    const res = await search.search('geno', 'us');
    expect(res.results.map((r) => r.id)).toEqual(['2']);
  });

  it('validates a guess from the local catalog without calling the API', async () => {
    let calls = 0;
    const { catalog } = setup(
      fakeProvider(
        async () => [],
        async () => {
          calls++;
          return null;
        },
      ),
    );
    const t = await catalog.ensureTrack('4', 'us');
    expect(t?.title).toBe('Come Together');
    expect(calls).toBe(0);
  });
});

describe('AppleProvider', () => {
  it('stops calling Apple for a minute after a rate-limit response', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response('', { status: 403 });
    }) as unknown as typeof fetch;
    const apple = new AppleProvider(20, fetchImpl);
    await expect(apple.search('a', { storefront: 'us', limit: 5 })).rejects.toBeInstanceOf(UpstreamThrottledError);
    await expect(apple.search('b', { storefront: 'us', limit: 5 })).rejects.toBeInstanceOf(UpstreamThrottledError);
    expect(calls).toBe(1);
    expect(apple.isThrottled()).toBe(true);
  });
});
