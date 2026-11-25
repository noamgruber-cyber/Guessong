import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HINT_ORDER, type HintType } from '@guessong/shared';
import type { Ctx } from '../app';
import { ApiError, LruCache, RateLimiter } from '../lib/util';
import { isDeezerId } from '../providers/deezer';
import { mockArtworkSvg, MockProvider, synthesizePreviewWav } from '../providers/mock';

const params = z.object({ roundId: z.string(), songId: z.string() });

export function registerGameRoutes(api: FastifyInstance, ctx: Ctx) {
  const userId = (req: Parameters<Ctx['currentUser']>[0]) => ctx.currentUser(req)?.id ?? null;

  // ---- discovery & leaderboards ----------------------------------------------

  api.get('/playlists', async (req) => {
    const q = z
      .object({ lang: z.string().max(8).optional(), filter: z.enum(['popular', 'unplayed']).optional() })
      .parse(req.query);
    return ctx.playlists.list(userId(req), q);
  });

  api.get('/playlists/:playlistId/summary', async (req) => {
    const { playlistId } = z.object({ playlistId: z.string() }).parse(req.params);
    return ctx.playlists.summary(playlistId, userId(req));
  });

  api.get('/playlists/:playlistId/leaderboard', async (req) => {
    const { playlistId } = z.object({ playlistId: z.string() }).parse(req.params);
    const q = z
      .object({ page: z.coerce.number().int().optional(), limit: z.coerce.number().int().optional() })
      .parse(req.query);
    return ctx.playlists.leaderboard(playlistId, userId(req), q.page ?? 1, q.limit ?? 50);
  });

  // ---- rounds ----------------------------------------------------------------

  api.post('/rounds', async (req) => {
    const body = z.object({ playlistId: z.string(), challengeCode: z.string().max(16).optional() }).parse(req.body);
    const u = ctx.requireUser(req);
    if (ctx.config.provider === 'spotify' && !u.spotify_refresh_token) {
      throw new ApiError(401, 'spotify_not_connected', 'Connect your Spotify Premium account to play');
    }
    return ctx.rounds.create(u.id, body.playlistId, body.challengeCode);
  });

  api.get('/rounds/:roundId', async (req) => {
    const { roundId } = z.object({ roundId: z.string() }).parse(req.params);
    return ctx.rounds.state(ctx.requireUser(req).id, roundId);
  });

  api.post('/rounds/:roundId/songs/:songId/start', async (req) => {
    const p = params.parse(req.params);
    return { song: ctx.rounds.start(ctx.requireUser(req).id, p.roundId, p.songId) };
  });

  api.post('/rounds/:roundId/songs/:songId/skip', async (req) => {
    const p = params.parse(req.params);
    return { song: ctx.rounds.skip(ctx.requireUser(req).id, p.roundId, p.songId) };
  });

  api.post('/rounds/:roundId/songs/:songId/hint', async (req) => {
    const p = params.parse(req.params);
    const body = z.object({ hintType: z.enum(HINT_ORDER as [HintType, ...HintType[]]) }).parse(req.body);
    return { song: ctx.rounds.hint(ctx.requireUser(req).id, p.roundId, p.songId, body.hintType) };
  });

  api.post('/rounds/:roundId/songs/:songId/guess', async (req) => {
    const p = params.parse(req.params);
    const body = z.object({ trackId: z.string().min(1).max(64) }).parse(req.body);
    return ctx.rounds.guess(ctx.requireUser(req).id, p.roundId, p.songId, body.trackId);
  });

  api.post('/rounds/:roundId/songs/:songId/reveal', async (req) => {
    const p = params.parse(req.params);
    return ctx.rounds.reveal(ctx.requireUser(req).id, p.roundId, p.songId);
  });

  api.post('/rounds/:roundId/songs/:songId/replace', async (req) => {
    const p = params.parse(req.params);
    return { song: ctx.rounds.replace(ctx.requireUser(req).id, p.roundId, p.songId) };
  });

  api.post('/rounds/:roundId/complete', async (req) => {
    const { roundId } = z.object({ roundId: z.string() }).parse(req.params);
    return ctx.rounds.complete(ctx.requireUser(req).id, roundId);
  });

  api.get('/rounds/:roundId/summary', async (req) => {
    const { roundId } = z.object({ roundId: z.string() }).parse(req.params);
    return ctx.rounds.summaryFor(ctx.requireUser(req).id, roundId);
  });

  api.post('/rounds/:roundId/abandon', async (req) => {
    const { roundId } = z.object({ roundId: z.string() }).parse(req.params);
    ctx.rounds.abandon(ctx.requireUser(req).id, roundId);
    return { ok: true };
  });

  api.post('/rounds/:roundId/challenge', async (req) => {
    const { roundId } = z.object({ roundId: z.string() }).parse(req.params);
    return ctx.rounds.createChallenge(ctx.requireUser(req).id, roundId);
  });

  /** Pre-game "Challenge" button: share your best round on this playlist. */
  api.post('/playlists/:playlistId/challenge', async (req) => {
    const { playlistId } = z.object({ playlistId: z.string() }).parse(req.params);
    const u = ctx.requireUser(req);
    const best = ctx.db
      .prepare('SELECT best_round_id FROM user_playlist_best WHERE user_id = ? AND playlist_id = ?')
      .get(u.id, playlistId) as { best_round_id: string } | undefined;
    if (!best) throw new ApiError(409, 'no_score_yet', 'Play a round first, then challenge your friends to beat it');
    return ctx.rounds.createChallenge(u.id, best.best_round_id);
  });

  api.get('/challenges/:code', async (req) => {
    const { code } = z.object({ code: z.string().max(16) }).parse(req.params);
    return ctx.rounds.challenge(code, userId(req));
  });

  // ---- audio (preview providers) ---------------------------------------------
  // Streams the preview through the server so the client never sees a URL that
  // could identify the track. Nothing is stored; bytes are passed through.

  const wavCache = new LruCache<Buffer>(40, 30 * 60 * 1000);

  api.get('/rounds/:roundId/songs/:songId/audio', async (req, reply) => {
    const p = params.parse(req.params);
    const { track } = ctx.rounds.playableTrack(ctx.requireUser(req).id, p.roundId, p.songId);
    reply.header('Cache-Control', 'private, no-store');
    if (isDeezerId(track.id)) {
      // Deezer preview links are signed and expire: ask for a current one.
      const url = ctx.providers.deezer ? await ctx.providers.deezer.previewUrl(track.id) : null;
      if (!url) throw new ApiError(404, 'audio_unavailable', 'No preview for this song');
      let upstream = await fetch(url);
      if (upstream.status === 403 && ctx.providers.deezer) {
        const fresh = await ctx.providers.deezer.getTrack(track.id, { fresh: true });
        if (fresh?.previewUrl) upstream = await fetch(fresh.previewUrl);
      }
      if (!upstream.ok || !upstream.body) throw new ApiError(502, 'audio_unavailable', 'Preview could not be loaded');
      reply.type(upstream.headers.get('content-type') ?? 'audio/mpeg');
      const len = upstream.headers.get('content-length');
      if (len) reply.header('Content-Length', len);
      return reply.send(Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream));
    }
    if (ctx.providers.music instanceof MockProvider) {
      let wav = wavCache.get(track.id);
      if (!wav) {
        wav = synthesizePreviewWav(track.id);
        wavCache.set(track.id, wav);
      }
      return reply.type('audio/wav').send(wav);
    }
    if (!track.preview_url) throw new ApiError(404, 'audio_unavailable', 'No preview for this song');
    if (!ctx.config.apple.proxyAudio) return reply.redirect(track.preview_url);
    const upstream = await fetch(track.preview_url);
    if (!upstream.ok || !upstream.body) throw new ApiError(502, 'audio_unavailable', 'Preview could not be loaded');
    reply.type(upstream.headers.get('content-type')?.replace('audio/x-m4p', 'audio/mp4') ?? 'audio/mp4');
    const len = upstream.headers.get('content-length');
    if (len) reply.header('Content-Length', len);
    return reply.send(Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream));
  });

  if (ctx.providers.music instanceof MockProvider) {
    const mock = ctx.providers.music;
    api.get('/mock/art/:file', async (req, reply) => {
      const { file } = z.object({ file: z.string() }).parse(req.params);
      const t = await mock.getTrack(file.replace(/\.svg$/, ''));
      if (!t) throw new ApiError(404, 'not_found', 'Not found');
      reply.header('Cache-Control', 'public, max-age=86400');
      return reply.type('image/svg+xml').send(mockArtworkSvg(t));
    });
  }

  // ---- search ------------------------------------------------------------------

  const limiters = new Map<string, RateLimiter>();
  api.get('/search', async (req) => {
    const q = z.object({ q: z.string().max(100), playlistId: z.string().optional() }).parse(req.query);
    const key = ctx.currentUser(req)?.id ?? req.ip;
    let limiter = limiters.get(key);
    if (!limiter) {
      limiter = new RateLimiter(40, 30_000);
      limiters.set(key, limiter);
      if (limiters.size > 5000) limiters.delete(limiters.keys().next().value!);
    }
    if (!limiter.tryTake()) throw new ApiError(429, 'slow_down', 'Too many searches, slow down a little');
    const playlist = q.playlistId ? ctx.catalog.getPlaylist(q.playlistId) : undefined;
    const storefront = playlist?.storefront ?? (ctx.config.provider === 'spotify' ? ctx.config.spotify.market : 'US');
    // Library games are Deezer tracks, so their guesses come from Deezer's catalog.
    if (playlist?.source_type === 'library' && ctx.providers.deezer) {
      return ctx.search.search(q.q, storefront, ctx.providers.deezer);
    }
    return ctx.search.search(q.q, storefront);
  });
}
