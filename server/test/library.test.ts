import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type Ctx } from '../src/app';
import { loadConfig } from '../src/config';
import { openDb, type Db } from '../src/db';
import { RateLimiter } from '../src/lib/util';
import { loadSeedPlaylists } from '../src/seeds';
import { bucketsFor, pickMatch } from '../src/services/library';

/**
 * Spotify-library games in Apple/mock mode, against simulated Spotify and Deezer
 * APIs: connect, scan Liked Songs/top songs/genres, build a game (Spotify tracks
 * matched to Deezer previews by ISRC, then by search), keep it private, play it.
 */

let app: FastifyInstance;
let ctx: Ctx;
let db: Db;
let meStatus = 200;
let deezerCalls = 0;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// 40 liked songs: odd ones are Israeli pop, even ones rock. Every 10th has no ISRC
// (matched by search instead); song 7 isn't on Deezer at all.
const liked = Array.from({ length: 40 }, (_, i) => ({
  id: `sp${i}`,
  name: `Liked Song ${i}`,
  uri: `spotify:track:sp${i}`,
  type: 'track',
  duration_ms: 200_000,
  artists: [{ id: i % 2 ? 'artIL' : 'artRock', name: i % 2 ? 'Omer Adam' : 'The Rockers' }],
  album: { name: 'Album', images: [{ url: 'https://i.scdn.co/a.jpg', width: 640 }] },
  external_ids: i % 10 === 0 ? {} : { isrc: `ISRC${i}` },
  external_urls: { spotify: `https://open.spotify.com/track/sp${i}` },
}));

function dz(i: number) {
  return {
    id: 1000 + i,
    readable: true,
    title: `Liked Song ${i}`,
    isrc: `ISRC${i}`,
    link: `https://www.deezer.com/track/${1000 + i}`,
    duration: 200,
    preview: 'data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA',
    artist: { name: i % 2 ? 'Omer Adam' : 'The Rockers' },
    album: { title: 'Album', cover_xl: `https://e-cdns-images.dzcdn.net/${i}.jpg` },
  };
}

const fakeFetch: typeof fetch = async (input) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.host === 'accounts.spotify.com') return json(200, { access_token: 'tok', refresh_token: 'ref', expires_in: 3600 });
  if (url.host === 'api.deezer.com') {
    deezerCalls++;
    const p = url.pathname;
    const isrc = p.match(/^\/track\/isrc:ISRC(\d+)$/);
    if (isrc) return Number(isrc[1]) === 7 ? json(200, { error: { code: 800, message: 'no data' } }) : json(200, dz(Number(isrc[1])));
    const byId = p.match(/^\/track\/(\d+)$/);
    if (byId) return json(200, dz(Number(byId[1]) - 1000));
    if (p === '/search') {
      const q = url.searchParams.get('q')!;
      const n = q.match(/Liked Song (\d+)/);
      if (n && Number(n[1]) !== 7) return json(200, { data: [{ ...dz(Number(n[1])), title: `Liked Song ${n[1]} (Karaoke Version)` }, dz(Number(n[1]))] });
      return json(200, { data: [dz(3), dz(5), dz(8)], total: 3 });
    }
    return json(200, { error: { code: 800, message: 'no data' } });
  }
  const p = url.pathname.replace(/^\/v1/, '');
  if (p === '/me') return meStatus === 200 ? json(200, { id: 'noa', display_name: 'Noa' }) : json(meStatus, { error: { status: meStatus, message: 'User not registered in the Developer Dashboard' } });
  if (p === '/me/tracks') {
    const limit = Number(url.searchParams.get('limit'));
    const offset = Number(url.searchParams.get('offset') ?? 0);
    return json(200, { total: liked.length, items: liked.slice(offset, offset + limit).map((t) => ({ track: t })), next: null });
  }
  if (p === '/me/top/tracks') return json(200, { items: liked.slice(0, 20) });
  if (p === '/me/top/artists') return json(200, { items: [{ id: 'artIL', name: 'Omer Adam', genres: ['israeli pop', 'mizrahi'] }] });
  if (p === '/artists/artRock') return json(200, { id: 'artRock', name: 'The Rockers', genres: ['alternative rock'] });
  if (p === '/me/playlists') {
    return json(200, {
      items: [
        { id: 'Mine1', name: 'Road Trip', owner: { id: 'noa' }, collaborative: false, items: { total: 15 }, images: [] },
        { id: 'Theirs1', name: 'Top 50 Israel', owner: { id: 'spotify' }, collaborative: false, items: { total: 50 }, images: [] },
      ],
      next: null,
    });
  }
  if (p === '/playlists/Mine1') return json(200, { id: 'Mine1', name: 'Road Trip', images: [{ url: 'https://i/rt.jpg', width: 300 }] });
  if (p === '/playlists/Mine1/items') return json(200, { items: liked.slice(10, 30).map((t) => ({ item: t })), next: null });
  if (p === '/playlists/Theirs1') return json(200, { id: 'Theirs1', name: 'Top 50 Israel' });
  // Development Mode: no items for playlists the user doesn't own.
  if (p === '/playlists/Theirs1/items') return json(200, { items: [], next: null });
  return json(404, { error: { status: 404, message: `unhandled ${p}` } });
};

class Client {
  jar = new Map<string, string>();
  async req(method: string, url: string, body?: unknown) {
    const res = await app.inject({
      method: method as any,
      url,
      payload: body as any,
      headers: this.jar.size ? { cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {},
    });
    const set = res.headers['set-cookie'];
    for (const c of set ? (Array.isArray(set) ? set : [set]) : []) {
      const [kv] = c.split(';');
      const [k, ...v] = kv.split('=');
      this.jar.set(k, v.join('='));
    }
    let j: any = null;
    try {
      j = res.json();
    } catch {
      /* redirect / audio */
    }
    return { status: res.statusCode, json: j, headers: res.headers, raw: res.body };
  }

  async connect() {
    await this.req('POST', '/api/v1/auth/guest', {});
    const login = await this.req('GET', '/api/v1/auth/spotify/login');
    const state = new URL(login.headers.location as string).searchParams.get('state');
    return this.req('GET', `/api/v1/auth/spotify/callback?code=abc&state=${state}`);
  }

  async waitJob(jobId: string) {
    for (let i = 0; i < 200; i++) {
      const r = await this.req('GET', `/api/v1/library/jobs/${jobId}`);
      if (r.json.job.status !== 'running') return r.json.job;
      await new Promise((res) => setTimeout(res, 10));
    }
    throw new Error('job did not finish');
  }
}

beforeAll(async () => {
  const config = loadConfig(
    { dbPath: ':memory:', ingestOnStart: false, webDistDir: null },
    { MUSIC_PROVIDER: 'mock', SPOTIFY_CLIENT_ID: 'cid', SPOTIFY_CLIENT_SECRET: 'secret', PUBLIC_URL: 'http://127.0.0.1:8787' } as NodeJS.ProcessEnv,
  );
  db = openDb(':memory:');
  const seeds = loadSeedPlaylists(config.dataDir);
  ({ app, ctx } = await buildApp({ config, db, seeds, fetchImpl: fakeFetch }));
  // The real limit (40 calls / 5 s) would make these tests wait; the fake API has none.
  (ctx.providers.deezer as unknown as { limiter: RateLimiter }).limiter = new RateLimiter(100_000, 1_000);
  await ctx.catalog.ingestSeeds(seeds);
});

afterAll(async () => {
  await app.close();
});

describe('genre grouping', () => {
  it('maps Spotify genre tags to broad genres, using Pop only as a fallback', () => {
    expect(bucketsFor(['israeli pop', 'mizrahi'])).toEqual(['mizrahi', 'israeli']);
    expect(bucketsFor(['dance pop', 'pop'])).toEqual(['electronic']);
    expect(bucketsFor(['pop'])).toEqual(['pop']);
    expect(bucketsFor(['alternative rock'])).toEqual(['rock', 'indie']);
    expect(bucketsFor([])).toEqual([]);
  });

  it('prefers the original over karaoke versions when matching by search', () => {
    const base = { album: null, artworkUrl: null, isrc: null, durationMs: null, uri: null, externalUrl: null };
    const target = { ...base, id: 's', title: 'Come On Eileen', artists: ['Dexys Midnight Runners'], previewUrl: null };
    const picked = pickMatch(target, [
      { ...base, id: 'k', title: 'Come On Eileen (Karaoke Version)', artists: ['Dexys Midnight Runners'], previewUrl: 'p' },
      { ...base, id: 'o', title: 'Come On Eileen', artists: ['Dexys Midnight Runners'], previewUrl: 'p' },
      { ...base, id: 'c', title: 'Come On Eileen', artists: ['Pickin On'], previewUrl: 'p' },
    ]);
    expect(picked?.id).toBe('o');
  });
});

describe('Spotify library games', () => {
  it('advertises the feature and asks only for read-only library scopes', async () => {
    const c = new Client();
    const me = await c.req('GET', '/api/v1/me');
    expect(me.json.config.spotifyLibrary).toBe(true);
    await c.req('POST', '/api/v1/auth/guest', {});
    const login = await c.req('GET', '/api/v1/auth/spotify/login');
    const scope = new URL(login.headers.location as string).searchParams.get('scope')!;
    expect(scope).toContain('user-library-read');
    expect(scope).toContain('user-top-read');
    expect(scope).not.toContain('streaming');
  });

  it('explains when the account is not on the app’s user list', async () => {
    meStatus = 403;
    const res = await new Client().connect();
    meStatus = 200;
    expect(res.headers.location).toBe('/?spotify_error=not_allowlisted');
  });

  it('builds a private game from Liked Songs and plays it with Deezer previews', async () => {
    const c = new Client();
    const cb = await c.connect();
    expect(cb.headers.location).toBe('/?spotify=connected');

    const overview = await c.req('GET', '/api/v1/library');
    expect(overview.status).toBe(200);
    expect(overview.json.likedCount).toBe(40);
    expect(overview.json.playlists).toEqual([
      expect.objectContaining({ id: 'Mine1', readable: true }),
      expect.objectContaining({ id: 'Theirs1', readable: false }),
    ]);

    // The genre scan runs in the background.
    await ctx.library!.waitForScan(cb.json?.user?.id ?? [...(ctx.db.prepare("SELECT id FROM users WHERE spotify_id = 'noa'").all() as { id: string }[])][0].id);
    const after = await c.req('GET', '/api/v1/library');
    expect(after.json.genresStatus).toBe('ready');
    expect(after.json.genres.map((g: any) => g.key)).toEqual(expect.arrayContaining(['mizrahi', 'israeli', 'rock']));

    const start = await c.req('POST', '/api/v1/library/games', { kind: 'liked' });
    expect(start.status).toBe(200);
    const job = await c.waitJob(start.json.job.id);
    expect(job.status).toBe('done');
    expect(job.total).toBe(40);
    expect(job.matched).toBe(39); // song 7 has no Deezer match

    // Private: in my list, not in the shared grid, not visible to others.
    const lists = await c.req('GET', '/api/v1/playlists');
    expect(lists.json.mine.map((p: any) => p.id)).toEqual([job.playlistId]);
    expect(lists.json.mine[0]).toMatchObject({ title: 'Liked Songs', source: 'library', songCount: 39 });
    expect(lists.json.playlists.some((p: any) => p.id === job.playlistId)).toBe(false);
    const other = new Client();
    await other.req('POST', '/api/v1/auth/guest', {});
    expect((await other.req('GET', '/api/v1/playlists')).json.mine).toEqual([]);

    // Play it.
    const round = await c.req('POST', '/api/v1/rounds', { playlistId: job.playlistId });
    expect(round.status).toBe(200);
    const song = round.json.song;
    const audio = await c.req('GET', song.audio.url);
    expect(audio.status).toBe(200);
    expect(audio.headers['content-type']).toContain('audio/mpeg');

    // Guess search comes from Deezer's catalog for these rounds.
    const search = await c.req('GET', `/api/v1/search?q=liked&playlistId=${job.playlistId}`);
    expect(search.json.results.length).toBeGreaterThan(0);
    expect(search.json.results.every((r: any) => r.id.startsWith('dz:'))).toBe(true);

    const target = ctx.db.prepare('SELECT track_id FROM round_songs WHERE id = ?').get(song.roundSongId) as { track_id: string };
    await c.req('POST', `/api/v1/rounds/${round.json.round.id}/songs/${song.roundSongId}/start`);
    const guess = await c.req('POST', `/api/v1/rounds/${round.json.round.id}/songs/${song.roundSongId}/guess`, { trackId: target.track_id });
    expect(guess.json.status).toBe('resolved');
    expect(guess.json.reveal.status).toBe('correct');
    expect(guess.json.reveal.externalUrl).toMatch(/^https:\/\/open\.spotify\.com\/track\//);
    expect(guess.json.reveal.externalLabel).toBe('Spotify');
  });

  it('reuses cached matches, builds genre and playlist games, and explains unreadable playlists', async () => {
    const c = new Client();
    await c.connect();
    await c.req('GET', '/api/v1/library');
    const before = deezerCalls;
    const top = await c.waitJob((await c.req('POST', '/api/v1/library/games', { kind: 'top' })).json.job.id);
    expect(top.status).toBe('done');
    expect(deezerCalls - before).toBeLessThan(20); // matches cached by the Liked Songs game

    const genre = await c.waitJob((await c.req('POST', '/api/v1/library/games', { kind: 'genre', key: 'rock' })).json.job.id);
    expect(genre.status).toBe('done');
    const lists = await c.req('GET', '/api/v1/playlists');
    expect(lists.json.mine.map((p: any) => p.title)).toEqual(expect.arrayContaining(['Your Top Songs', 'Your Rock']));

    const mine = await c.waitJob((await c.req('POST', '/api/v1/library/games', { kind: 'playlist', id: 'Mine1' })).json.job.id);
    expect(mine.status).toBe('done');

    const theirs = await c.waitJob((await c.req('POST', '/api/v1/library/games', { kind: 'playlist', id: 'Theirs1' })).json.job.id);
    expect(theirs.status).toBe('error');
    expect(theirs.error.code).toBe('playlist_unreadable');

    const del = await c.req('DELETE', `/api/v1/library/games/${mine.playlistId}`);
    expect(del.status).toBe(200);
    expect((await c.req('GET', '/api/v1/playlists')).json.mine.some((p: any) => p.id === mine.playlistId)).toBe(false);
  });

  it('requires a Spotify connection', async () => {
    const c = new Client();
    await c.req('POST', '/api/v1/auth/guest', {});
    const res = await c.req('GET', '/api/v1/library');
    expect(res.status).toBe(401);
    expect(res.json.error.code).toBe('spotify_not_connected');
  });
});
