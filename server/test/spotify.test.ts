import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type Ctx } from '../src/app';
import { loadConfig } from '../src/config';
import { openDb, run, type Db } from '../src/db';
import type { SeedPlaylist } from '../src/seeds';

/**
 * Drives the Spotify mode against a fake Spotify Web API that follows the
 * Development Mode shapes (search limit ≤ 10, playlist `items[].item`,
 * PREMIUM_REQUIRED player errors, no `product` on /me).
 */

let app: FastifyInstance;
let ctx: Ctx;
let db: Db;
const calls: { method: string; url: URL; body: any }[] = [];

function fakeTrack(title: string, artist: string, extra: Partial<Record<string, unknown>> = {}) {
  const id = `sp${createHash('sha1').update(`${title}|${artist}`).digest('hex').slice(0, 16)}`;
  return {
    id,
    name: title,
    uri: `spotify:track:${id}`,
    type: 'track',
    duration_ms: 200_000,
    artists: [{ name: artist }],
    album: { name: `${artist} album`, images: [{ url: `https://i.scdn.co/image/${id}`, width: 640 }] },
    external_ids: { isrc: `ISRC${id.slice(2, 10)}` },
    external_urls: { spotify: `https://open.spotify.com/track/${id}` },
    ...extra,
  };
}

const json = (status: number, body: unknown) =>
  new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fakeFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : (input as Request).url);
  const method = init?.method ?? 'GET';
  let body: any = init?.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      /* form */
    }
  } else if (body instanceof URLSearchParams) body = Object.fromEntries(body);
  calls.push({ method, url, body });

  if (url.host === 'accounts.spotify.com' && url.pathname === '/api/token') {
    if (body.grant_type === 'client_credentials') return json(200, { access_token: 'app-token', expires_in: 3600 });
    if (body.grant_type === 'authorization_code') {
      return json(200, { access_token: 'user-token-1', refresh_token: 'refresh-1', expires_in: 3600 });
    }
    if (body.grant_type === 'refresh_token') return json(200, { access_token: 'user-token-2', expires_in: 3600 });
  }
  const p = url.pathname.replace('/v1', '');
  if (p === '/search') {
    expect(Number(url.searchParams.get('limit'))).toBeLessThanOrEqual(10);
    const q = url.searchParams.get('q')!;
    const m = /^track:"(.+)" artist:"(.+)"$/.exec(q);
    const items = m ? [fakeTrack(`${m[1]} - Live`, m[2]), fakeTrack(m[1], m[2])] : [fakeTrack(q, 'Somebody')];
    return json(200, { tracks: { items } });
  }
  if (p.startsWith('/tracks/')) return json(200, fakeTrack('Looked Up', 'Artist'));
  if (p === '/me') return json(200, { id: 'spuser', account_id: 'acc-123', display_name: 'DJ Test', images: [{ url: 'https://i/me.jpg', width: 300 }] });
  if (p === '/me/player/play') {
    if (url.searchParams.get('device_id') === 'free-device') {
      return json(403, { error: { status: 403, message: 'Player command failed: Premium required', reason: 'PREMIUM_REQUIRED' } });
    }
    return new Response(null, { status: 204 });
  }
  if (p === '/me/player/pause') return new Response(null, { status: 204 });
  if (p === '/me/player/devices') return json(200, { devices: [{ id: 'phone-1', name: 'iPhone', type: 'Smartphone', is_active: true }] });
  if (p === '/me/playlists') {
    return json(200, {
      items: [
        { id: 'MyMix1', name: 'My Mix', images: [], owner: { id: 'spuser' }, collaborative: false, items: { total: 15 } },
        { id: 'TheirMix', name: 'Not mine', images: [], owner: { id: 'someone' }, collaborative: false, items: { total: 50 } },
      ],
      next: null,
    });
  }
  if (p === '/playlists/MyMix1') return json(200, { id: 'MyMix1', name: 'My Mix', description: 'mine', images: [{ url: 'https://i/mix.jpg' }] });
  if (p === '/playlists/MyMix1/items') {
    return json(200, {
      items: Array.from({ length: 15 }, (_, i) => ({ item: fakeTrack(`Mix Song ${i}`, `Mix Artist ${i}`) })),
      next: null,
    });
  }
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
      /* redirect */
    }
    return { status: res.statusCode, json: j, headers: res.headers, raw: res.body };
  }
}

const seeds: SeedPlaylist[] = [
  {
    id: 'test-hits',
    title: 'Test Hits',
    description: null,
    lang: 'en',
    storefront: 'US',
    tracks: Array.from({ length: 14 }, (_, i) => ({ title: `Song ${i}`, artist: `Artist ${i}`, ...(i === 0 ? { startAt: '1:02' } : {}) })),
  },
];

beforeAll(async () => {
  const config = loadConfig(
    { dbPath: ':memory:', ingestOnStart: false, webDistDir: null },
    {
      MUSIC_PROVIDER: 'spotify',
      SPOTIFY_CLIENT_ID: 'cid',
      SPOTIFY_CLIENT_SECRET: 'secret',
      PUBLIC_URL: 'http://127.0.0.1:8787',
    } as NodeJS.ProcessEnv,
  );
  db = openDb(':memory:');
  ({ app, ctx } = await buildApp({ config, db, seeds, fetchImpl: fakeFetch }));
});

afterAll(async () => {
  await app.close();
});

describe('Spotify mode', () => {
  const c = new Client();
  let roundId = '';
  let songId = '';

  it('resolves seeds via search, skipping live versions, with a clip start offset', async () => {
    const [report] = await ctx.catalog.ingestSeeds(seeds);
    expect(report.status).toBe('ready');
    expect(report.resolved).toBe(14);
    const rows = db.prepare('SELECT title, clip_start_ms, uri FROM tracks ORDER BY title').all() as any[];
    expect(rows.every((r) => !r.title.includes('Live'))).toBe(true);
    expect(rows.find((r) => r.title === 'Song 0').clip_start_ms).toBe(62_000);
    expect(rows.find((r) => r.title === 'Song 1').clip_start_ms).toBe(60_000);
  });

  it('requires a Spotify connection to start a round', async () => {
    const me = await c.req('GET', '/api/v1/me');
    expect(me.json.config.requiresSpotifyLogin).toBe(true);
    await c.req('POST', '/api/v1/auth/guest', { displayName: 'Guesty' });
    const r = await c.req('POST', '/api/v1/rounds', { playlistId: 'test-hits' });
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe('spotify_not_connected');
  });

  it('logs in with OAuth and upgrades the guest account', async () => {
    const guestId = (await c.req('GET', '/api/v1/me')).json.user.id;
    const login = await c.req('GET', '/api/v1/auth/spotify/login');
    expect(login.status).toBe(302);
    const auth = new URL(login.headers.location as string);
    expect(auth.host).toBe('accounts.spotify.com');
    expect(auth.searchParams.get('scope')).toContain('streaming');
    expect(auth.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:8787/api/v1/auth/spotify/callback');

    const bad = await new Client().req('GET', `/api/v1/auth/spotify/callback?code=x&state=${auth.searchParams.get('state')}`);
    expect(bad.headers.location).toBe('/?spotify_error=state_mismatch');

    const cb = await c.req('GET', `/api/v1/auth/spotify/callback?code=abc&state=${auth.searchParams.get('state')}`);
    expect(cb.headers.location).toBe('/?spotify=connected');
    const me = (await c.req('GET', '/api/v1/me')).json.user;
    expect(me).toMatchObject({ id: guestId, displayName: 'DJ Test', spotifyConnected: true, isGuest: false });

    const stored = db.prepare('SELECT spotify_access_token, spotify_refresh_token FROM users WHERE id = ?').get(guestId) as any;
    expect(stored.spotify_access_token).not.toContain('user-token');
    expect(stored.spotify_refresh_token).not.toContain('refresh-1');
  });

  it('hands the Web Playback SDK a token and refreshes it when expired', async () => {
    expect((await c.req('GET', '/api/v1/spotify/token')).json.accessToken).toBe('user-token-1');
    run(db, 'UPDATE users SET spotify_token_expires_at = 0');
    expect((await c.req('GET', '/api/v1/spotify/token')).json.accessToken).toBe('user-token-2');
  });

  it('starts a round with a spotify audio source and no track ids in the payload', async () => {
    const r = await c.req('POST', '/api/v1/rounds', { playlistId: 'test-hits' });
    expect(r.status).toBe(200);
    expect(r.json.song.audio.kind).toBe('spotify');
    expect(r.raw).not.toContain('spotify:track');
    roundId = r.json.round.id;
    songId = r.json.song.roundSongId;
  });

  it('loads the song on the device at the clip start', async () => {
    calls.length = 0;
    const res = await c.req('POST', `/api/v1/rounds/${roundId}/songs/${songId}/spotify/load`, { deviceId: 'sdk-device' });
    expect(res.status).toBe(200);
    const play = calls.find((x) => x.url.pathname === '/v1/me/player/play')!;
    expect(play.method).toBe('PUT');
    expect(play.url.searchParams.get('device_id')).toBe('sdk-device');
    expect(play.body.uris[0]).toMatch(/^spotify:track:/);
    expect(play.body.position_ms).toBe(res.json.clipStartMs);
  });

  it('Connect mode plays only unlocked audio and pauses on schedule', async () => {
    const base = `/api/v1/rounds/${roundId}/songs/${songId}/spotify/play`;
    const locked = await c.req('POST', base, { deviceId: 'phone-1', startMs: 0, endMs: 1500 });
    expect(locked.json.error.code).toBe('not_unlocked');
    calls.length = 0;
    const ok = await c.req('POST', base, { deviceId: 'phone-1', startMs: 0, endMs: 500 });
    expect(ok.json.durationMs).toBe(500);
    await new Promise((r) => setTimeout(r, 650));
    expect(calls.map((x) => x.url.pathname)).toEqual(['/v1/me/player/play', '/v1/me/player/pause']);
  });

  it('maps PREMIUM_REQUIRED to a clear error', async () => {
    const res = await c.req('POST', `/api/v1/rounds/${roundId}/songs/${songId}/spotify/load`, { deviceId: 'free-device' });
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe('premium_required');
  });

  it('imports only playlists the user owns', async () => {
    const list = await c.req('GET', '/api/v1/spotify/playlists');
    expect(list.json.playlists.map((p: any) => p.id)).toEqual(['MyMix1']);
    const imp = await c.req('POST', '/api/v1/playlists/import', { spotifyPlaylistId: 'MyMix1', lang: 'en' });
    expect(imp.status).toBe(200);
    expect(imp.json.playlist).toMatchObject({ id: 'sp-mymix1', title: 'My Mix', songCount: 15, source: 'import' });
    const all = await c.req('GET', '/api/v1/playlists');
    expect(all.json.playlists.map((p: any) => p.id)).toContain('sp-mymix1');
  });

  it('lets the user disconnect Spotify', async () => {
    const res = await c.req('POST', '/api/v1/me/spotify/disconnect');
    expect(res.json.user.spotifyConnected).toBe(false);
    expect((await c.req('POST', '/api/v1/rounds', { playlistId: 'test-hits' })).json.error.code).toBe('spotify_not_connected');
  });
});
