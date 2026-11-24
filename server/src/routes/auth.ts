import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { MeResponse } from '@guessong/shared';
import { SESSION_COOKIE, type Ctx } from '../app';
import { ApiError, newId } from '../lib/util';
import { userDTO } from '../services/users';

const OAUTH_STATE_COOKIE = 'gs_oauth_state';

export function registerAuthRoutes(api: FastifyInstance, ctx: Ctx) {
  api.get('/me', async (req): Promise<MeResponse> => {
    const u = ctx.currentUser(req);
    return { user: u ? userDTO(u) : null, config: ctx.appConfig };
  });

  /** Anonymous guest session (can be upgraded by connecting Spotify later). */
  api.post('/auth/guest', async (req, reply) => {
    const body = z.object({ displayName: z.string().max(40).optional() }).parse(req.body ?? {});
    const existing = ctx.currentUser(req);
    if (existing) return { user: userDTO(existing) };
    const u = ctx.users.createGuest(body.displayName);
    ctx.startSession(reply, u.id);
    return { user: userDTO(u) };
  });

  api.patch('/me', async (req) => {
    const body = z.object({ displayName: z.string() }).parse(req.body);
    const u = ctx.requireUser(req);
    return { user: userDTO(ctx.users.rename(u.id, body.displayName)) };
  });

  api.post('/auth/logout', async (req, reply) => {
    const raw = req.cookies[SESSION_COOKIE];
    const un = raw ? req.unsignCookie(raw) : null;
    if (un?.valid && un.value) ctx.users.deleteSession(un.value);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  // ---- Spotify OAuth (Authorization Code flow, confidential client) --------

  api.get('/auth/spotify/login', async (req, reply) => {
    const spotify = ctx.providers.spotify;
    if (!spotify) throw new ApiError(404, 'spotify_disabled', 'Spotify mode is not enabled on this server');
    const state = newId(24);
    reply.setCookie(OAUTH_STATE_COOKIE, state, {
      signed: true,
      httpOnly: true,
      sameSite: 'lax',
      secure: ctx.config.secureCookies,
      path: '/',
      maxAge: 600,
    });
    return reply.redirect(spotify.authorizeUrl(state));
  });

  api.get('/auth/spotify/callback', async (req, reply) => {
    const spotify = ctx.providers.spotify;
    if (!spotify) throw new ApiError(404, 'spotify_disabled', 'Spotify mode is not enabled on this server');
    const q = z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }).parse(req.query);
    const raw = req.cookies[OAUTH_STATE_COOKIE];
    const expected = raw ? req.unsignCookie(raw) : null;
    reply.clearCookie(OAUTH_STATE_COOKIE, { path: '/' });
    const fail = (code: string) => reply.redirect(`/?spotify_error=${encodeURIComponent(code)}`);
    if (q.error) return fail(q.error);
    if (!q.code || !q.state || !expected?.valid || expected.value !== q.state) return fail('state_mismatch');
    try {
      const tokens = await spotify.exchangeCode(q.code);
      const profile = await spotify.me(tokens.accessToken);
      const current = ctx.currentUser(req);
      const user = ctx.users.linkSpotify(current?.id ?? null, profile, tokens);
      if (!current || current.id !== user.id) ctx.startSession(reply, user.id);
      return reply.redirect('/?spotify=connected');
    } catch (e) {
      req.log.warn(e, 'spotify callback failed');
      return fail('login_failed');
    }
  });

  api.post('/me/spotify/disconnect', async (req) => {
    const u = ctx.requireUser(req);
    ctx.users.disconnectSpotify(u.id);
    return { user: userDTO(ctx.users.require(u.id)) };
  });
}
