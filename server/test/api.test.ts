import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { GuessResponse, RoundStateResponse, RoundSummaryDTO, SongStateDTO } from '@guessong/shared';
import { buildApp, type Ctx } from '../src/app';
import { loadConfig } from '../src/config';
import { get, openDb, run, type Db } from '../src/db';
import { mockTrackId } from '../src/providers/mock';
import { loadSeedPlaylists } from '../src/seeds';

let app: FastifyInstance;
let ctx: Ctx;
let db: Db;

class Client {
  cookie = '';
  async req<T = any>(method: string, url: string, body?: unknown): Promise<{ status: number; json: T; headers: Record<string, any>; raw: string }> {
    const res = await app.inject({
      method: method as any,
      url,
      payload: body as any,
      headers: this.cookie ? { cookie: this.cookie } : {},
    });
    const set = res.headers['set-cookie'];
    if (set) {
      const first = (Array.isArray(set) ? set : [set]).find((c) => c.startsWith('gs_session='));
      if (first) this.cookie = first.split(';')[0];
    }
    let json: any = null;
    try {
      json = res.json();
    } catch {
      /* binary */
    }
    return { status: res.statusCode, json, headers: res.headers, raw: res.body };
  }
}

function targetOf(songId: string) {
  return get<{ id: string; title: string; artists: string }>(
    db,
    'SELECT t.id, t.title, t.artists FROM round_songs rs JOIN tracks t ON t.id = rs.track_id AND t.provider = ? WHERE rs.id = ?',
    'mock',
    songId,
  )!;
}

beforeAll(async () => {
  const config = loadConfig({ provider: 'mock', dbPath: ':memory:', ingestOnStart: false, webDistDir: null }, {
    MUSIC_PROVIDER: 'mock',
  } as NodeJS.ProcessEnv);
  db = openDb(':memory:');
  const seeds = loadSeedPlaylists(config.dataDir);
  ({ app, ctx } = await buildApp({ config, db, seeds }));
  await ctx.catalog.ingestSeeds(seeds);
});

afterAll(async () => {
  await app.close();
});

describe('session & discovery', () => {
  it('starts without a user and creates a guest', async () => {
    const c = new Client();
    const me = await c.req('GET', '/api/v1/me');
    expect(me.json.user).toBeNull();
    expect(me.json.config.provider).toBe('mock');
    expect(me.json.config.clipStagesMs).toEqual([500, 1500, 3000, 5000, 9000, 15000]);
    const g = await c.req('POST', '/api/v1/auth/guest', { displayName: 'Tester' });
    expect(g.json.user.displayName).toBe('Tester');
    expect((await c.req('GET', '/api/v1/me')).json.user.id).toBe(g.json.user.id);
  });

  it('lists ready playlists with language chips', async () => {
    const c = new Client();
    const res = await c.req('GET', '/api/v1/playlists');
    expect(res.status).toBe(200);
    expect(res.json.playlists.length).toBeGreaterThanOrEqual(10);
    expect(res.json.languages.map((l: any) => l.code)).toContain('en');
    const en = await c.req('GET', '/api/v1/playlists?lang=de');
    expect(en.json.playlists.every((p: any) => p.lang === 'de')).toBe(true);
    expect(res.json.playlists[0].mosaic.length).toBe(4);
  });

  it('requires a session to play', async () => {
    const c = new Client();
    const r = await c.req('POST', '/api/v1/rounds', { playlistId: '80s-hits' });
    expect(r.status).toBe(401);
  });
});

describe('a full round', () => {
  const c = new Client();
  let round: RoundStateResponse;
  let summary: RoundSummaryDTO;

  it('creates a round without leaking the answer', async () => {
    await c.req('POST', '/api/v1/auth/guest', { displayName: 'Round Runner' });
    const res = await c.req<RoundStateResponse>('POST', '/api/v1/rounds', { playlistId: '80s-hits' });
    expect(res.status).toBe(200);
    round = res.json;
    expect(round.round.totalSongs).toBe(10);
    expect(round.song!.position).toBe(1);
    expect(round.song!.attempt).toBe(1);
    expect(round.song!.unlockedMs).toBe(500);
    expect(round.song!.audio.kind).toBe('preview');
    const target = targetOf(round.song!.roundSongId);
    // The playlist's cover mosaic shows its first songs' artwork, just like the public
    // playlist card does, so leave it out; nothing else may identify the song.
    const { mosaic: _cover, ...playlist } = round.round.playlist;
    const visible = JSON.stringify({ ...round, round: { ...round.round, playlist } });
    expect(visible).not.toContain(target.title);
    expect(visible).not.toContain(target.id);
  });

  it('serves audio for the current song', async () => {
    const audio = await c.req('GET', (round.song!.audio as { url: string }).url);
    expect(audio.status).toBe(200);
    expect(audio.headers['content-type']).toContain('audio/wav');
    expect(audio.raw.length).toBeGreaterThan(100_000);
  });

  it('skips, hints and validates guesses with the canonical matcher', async () => {
    const song = round.song!;
    const base = `/api/v1/rounds/${round.round.id}/songs/${song.roundSongId}`;
    // Pin the target to the spec's example so we can test the matcher end to end.
    const eileen = mockTrackId('Come On Eileen', 'Dexys Midnight Runners');
    run(db, 'UPDATE round_songs SET track_id = ? WHERE id = ?', eileen, song.roundSongId);

    expect((await c.req('POST', `${base}/start`)).json.song.status).toBe('active');
    const skipped = (await c.req<{ song: SongStateDTO }>('POST', `${base}/skip`)).json.song;
    expect(skipped.attempt).toBe(2);
    expect(skipped.unlockedMs).toBe(1500);
    expect(skipped.log).toEqual([{ attempt: 1, kind: 'skip' }]);

    const locked = await c.req('POST', `${base}/hint`, { hintType: 'song' });
    expect(locked.status).toBe(409);
    expect(locked.json.error.code).toBe('hint_locked');

    const hinted = (await c.req<{ song: SongStateDTO }>('POST', `${base}/hint`, { hintType: 'artist' })).json.song;
    expect(hinted.hints.artist).toBe('Dexys Midnight Runners');
    expect(hinted.potentialPoints).toBe(5); // 80 − 75

    const search = await c.req('GET', '/api/v1/search?q=come on eileen');
    const ids = search.json.results.map((r: any) => `${r.title} — ${r.artist}`);
    expect(ids).toContain("Come On Eileen — Pickin' On Series");

    const coverId = mockTrackId('Come On Eileen', "Pickin' On Series");
    const wrong = await c.req<GuessResponse>('POST', `${base}/guess`, { trackId: coverId });
    expect(wrong.json.status).toBe('wrong');
    if (wrong.json.status !== 'wrong') throw new Error();
    expect(wrong.json.song.attempt).toBe(3);
    expect(wrong.json.song.log[1]).toMatchObject({ kind: 'wrong', title: 'Come On Eileen', artist: "Pickin' On Series" });

    const editId = mockTrackId('Come On Eileen (Single Edit)', 'Dexys Midnight Runners & Kevin Rowland');
    const right = await c.req<GuessResponse>('POST', `${base}/guess`, { trackId: editId });
    expect(right.json.status).toBe('resolved');
    if (right.json.status !== 'resolved') throw new Error();
    expect(right.json.reveal).toMatchObject({
      status: 'correct',
      title: 'Come On Eileen',
      attemptsUsed: 3,
      timeListenedMs: 3000,
      pointsAwarded: 5, // 60 − 75 → floor of 5
      roundTotalScore: 5,
      isLast: false,
    });
    expect(right.json.next!.position).toBe(2);
    round.song = right.json.next;

    const again = await c.req('POST', `${base}/skip`);
    expect(again.status).toBe(409);
  });

  it('rejects actions on songs other than the current one', async () => {
    const other = get<{ id: string }>(db, 'SELECT id FROM round_songs WHERE round_id = ? AND position = 5', round.round.id)!;
    const res = await c.req('POST', `/api/v1/rounds/${round.round.id}/songs/${other.id}/skip`);
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('not_current_song');
  });

  it('plays out the remaining songs', async () => {
    let song = round.song!;
    for (let pos = 2; pos <= 10; pos++) {
      const base = `/api/v1/rounds/${round.round.id}/songs/${song.roundSongId}`;
      await c.req('POST', `${base}/start`);
      let res: { json: any };
      if (pos % 3 === 0) {
        res = await c.req('POST', `${base}/reveal`);
        expect(res.json.reveal.status).toBe('missed');
        expect(res.json.reveal.pointsAwarded).toBe(0);
      } else {
        const target = targetOf(song.roundSongId);
        res = await c.req('POST', `${base}/guess`, { trackId: target.id });
        expect(res.json.reveal.pointsAwarded).toBe(100);
      }
      if (pos < 10) song = res.json.next;
      else expect(res.json.next).toBeNull();
    }
    // 5 + six correct first-try guesses (2,4,5,7,8,10)
    const state = await c.req<RoundStateResponse>('GET', `/api/v1/rounds/${round.round.id}`);
    expect(state.json.round.totalScore).toBe(605);
    expect(state.json.song).toBeNull();
  });

  it('completes the round and updates the leaderboard', async () => {
    const res = await c.req<RoundSummaryDTO>('POST', `/api/v1/rounds/${round.round.id}/complete`);
    expect(res.status).toBe(200);
    summary = res.json;
    expect(summary.totalScore).toBe(605);
    expect(summary.maxScore).toBe(1000);
    expect(summary.correctCount).toBe(7);
    expect(summary.isNewBest).toBe(true);
    expect(summary.rank).toBe(1);
    expect(summary.songs).toHaveLength(10);
    expect(summary.songs[0]).toMatchObject({ title: 'Come On Eileen', attemptsUsed: 3, points: 5, hintsUsed: ['artist'] });

    const again = await c.req<RoundSummaryDTO>('POST', `/api/v1/rounds/${round.round.id}/complete`);
    expect(again.json.totalScore).toBe(605);

    const lb = await c.req('GET', '/api/v1/playlists/80s-hits/leaderboard');
    expect(lb.json.entries).toHaveLength(1);
    expect(lb.json.entries[0]).toMatchObject({ rank: 1, bestScore: 605, isMe: true, displayName: 'Round Runner' });

    const sum = await c.req('GET', '/api/v1/playlists/80s-hits/summary');
    expect(sum.json.me.bestScore).toBe(605);
    expect(sum.json.top).toHaveLength(1);

    const list = await c.req('GET', '/api/v1/playlists');
    expect(list.json.recent[0].playlist.id).toBe('80s-hits');
    const unplayed = await c.req('GET', '/api/v1/playlists?filter=unplayed');
    expect(unplayed.json.playlists.find((p: any) => p.id === '80s-hits')).toBeUndefined();
  });

  it('lets a friend replay the exact same songs as a challenge', async () => {
    const ch = await c.req('POST', `/api/v1/rounds/${round.round.id}/challenge`);
    expect(ch.json.code).toHaveLength(8);
    expect(ch.json.url).toContain(`/c/${ch.json.code}`);

    const friend = new Client();
    await friend.req('POST', '/api/v1/auth/guest', { displayName: 'Friend' });
    const info = await friend.req('GET', `/api/v1/challenges/${ch.json.code}`);
    expect(info.json).toMatchObject({ score: 605, challenger: { displayName: 'Round Runner' } });

    const r = await friend.req<RoundStateResponse>('POST', '/api/v1/rounds', { playlistId: '80s-hits', challengeCode: ch.json.code });
    const order = (rid: string) =>
      (db.prepare('SELECT track_id FROM round_songs WHERE round_id = ? AND position IS NOT NULL ORDER BY position').all(rid) as { track_id: string }[]).map(
        (x) => x.track_id,
      );
    expect(order(r.json.round.id)).toEqual(order(round.round.id));
    expect(r.json.round.challenge?.code).toBe(ch.json.code);

    // Friend reveals everything → loses the challenge.
    let song = r.json.song!;
    for (let i = 0; i < 10; i++) {
      const res = await friend.req('POST', `/api/v1/rounds/${r.json.round.id}/songs/${song.roundSongId}/reveal`);
      song = res.json.next;
    }
    const s = await friend.req<RoundSummaryDTO>('POST', `/api/v1/rounds/${r.json.round.id}/complete`);
    expect(s.json.versus).toMatchObject({ outcome: 'lost', score: 605 });
    expect(s.json.rank).toBe(2);
  });
});

describe('fallback tracks', () => {
  it('replaces a song that failed to load, but only before it was heard', async () => {
    const c = new Client();
    await c.req('POST', '/api/v1/auth/guest');
    const r = await c.req<RoundStateResponse>('POST', '/api/v1/rounds', { playlistId: '90s-hits' });
    const first = r.json.song!;
    const base = `/api/v1/rounds/${r.json.round.id}/songs`;
    const replaced = await c.req<{ song: SongStateDTO }>('POST', `${base}/${first.roundSongId}/replace`);
    expect(replaced.status).toBe(200);
    expect(replaced.json.song.position).toBe(1);
    expect(replaced.json.song.roundSongId).not.toBe(first.roundSongId);

    await c.req('POST', `${base}/${replaced.json.song.roundSongId}/start`);
    const denied = await c.req('POST', `${base}/${replaced.json.song.roundSongId}/replace`);
    expect(denied.status).toBe(409);
  });

  it('runs out of skips on attempt 6 and must reveal', async () => {
    const c = new Client();
    await c.req('POST', '/api/v1/auth/guest');
    const r = await c.req<RoundStateResponse>('POST', '/api/v1/rounds', { playlistId: '2000s-hits' });
    const base = `/api/v1/rounds/${r.json.round.id}/songs/${r.json.song!.roundSongId}`;
    let s: SongStateDTO = r.json.song!;
    for (let i = 0; i < 5; i++) s = (await c.req('POST', `${base}/skip`)).json.song;
    expect(s.attempt).toBe(6);
    expect(s.unlockedMs).toBe(15000);
    expect((await c.req('POST', `${base}/skip`)).json.error.code).toBe('no_more_skips');
    const reveal = await c.req('POST', `${base}/reveal`);
    expect(reveal.json.reveal).toMatchObject({ status: 'missed', attemptsUsed: 6, timeListenedMs: 15000, pointsAwarded: 0 });
  });

  it('a sixth wrong guess resolves the song as missed', async () => {
    const c = new Client();
    await c.req('POST', '/api/v1/auth/guest');
    const r = await c.req<RoundStateResponse>('POST', '/api/v1/rounds', { playlistId: 'rock-anthems' });
    const base = `/api/v1/rounds/${r.json.round.id}/songs/${r.json.song!.roundSongId}`;
    const wrongId = mockTrackId('Hurt', 'Johnny Cash');
    let res: any;
    for (let i = 0; i < 6; i++) res = (await c.req('POST', `${base}/guess`, { trackId: wrongId })).json;
    expect(res.status).toBe('resolved');
    expect(res.reveal).toMatchObject({ status: 'missed', attemptsUsed: 6 });
    expect(res.guess).toMatchObject({ title: 'Hurt' });
  });
});

describe('themed shelves and fun facts', () => {
  it('lists collections before languages and filters by them', async () => {
    const c = new Client();
    const res = await c.req('GET', '/api/v1/playlists');
    expect(res.json.collections.map((x: any) => x.code)).toEqual(['eurovision', 'themes']);
    expect(res.json.collections[0]).toMatchObject({ label: 'Eurovision', flag: '🎤' });
    // Multilingual playlists get no language chip of their own.
    expect(res.json.languages.map((l: any) => l.code)).not.toContain('multi');
    const ev = await c.req('GET', '/api/v1/playlists?lang=eurovision');
    expect(ev.json.playlists.map((p: any) => p.id).sort()).toEqual(['eurovision-bangers', 'eurovision-winners', 'israel-at-eurovision']);
    expect(ev.json.playlists.every((p: any) => p.collection === 'eurovision')).toBe(true);
    // A themed playlist in one language shows on that language's shelf too.
    const he = await c.req('GET', '/api/v1/playlists?lang=he');
    expect(he.json.playlists.map((p: any) => p.id)).toContain('israel-at-eurovision');
    const en = await c.req('GET', '/api/v1/playlists?lang=en');
    expect(en.json.playlists.map((p: any) => p.id)).not.toContain('eurovision-winners');
  });

  it('shows the curated fun fact with the answer, never before', async () => {
    const c = new Client();
    await c.req('POST', '/api/v1/auth/guest');
    const r = await c.req<RoundStateResponse>('POST', '/api/v1/rounds', { playlistId: 'eurovision-winners' });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.json)).not.toMatch(/Eurovision winner/);
    const base = `/api/v1/rounds/${r.json.round.id}/songs/${r.json.song!.roundSongId}`;
    for (let i = 0; i < 5; i++) await c.req('POST', `${base}/skip`);
    const reveal = await c.req('POST', `${base}/reveal`);
    expect(reveal.json.reveal.note).toMatch(/· Eurovision winner (19|20)\d\d/);
    // Playlists without notes reveal null.
    const r2 = await c.req<RoundStateResponse>('POST', '/api/v1/rounds', { playlistId: '80s-hits' });
    const base2 = `/api/v1/rounds/${r2.json.round.id}/songs/${r2.json.song!.roundSongId}`;
    for (let i = 0; i < 5; i++) await c.req('POST', `${base2}/skip`);
    expect((await c.req('POST', `${base2}/reveal`)).json.reveal.note).toBeNull();
  });
});
