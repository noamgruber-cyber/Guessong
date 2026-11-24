import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { ATTEMPTS, CLIP_STAGES_MS, SONGS_PER_ROUND, type AppConfig } from '@guessong/shared';
import type { Config } from './config';
import type { Db } from './db';
import { ApiError } from './lib/util';
import { createProviders, type Providers } from './providers';
import { SpotifyApiError } from './providers/spotify';
import { registerAuthRoutes } from './routes/auth';
import { registerGameRoutes } from './routes/game';
import { registerSpotifyRoutes } from './routes/spotify';
import type { SeedPlaylist } from './seeds';
import { Catalog } from './services/catalog';
import { Playlists } from './services/playlists';
import { Rounds } from './services/rounds';
import { SearchService } from './services/search';
import { Users, type UserRow } from './services/users';

export const SESSION_COOKIE = 'gs_session';

export interface Ctx {
  config: Config;
  db: Db;
  providers: Providers;
  seeds: SeedPlaylist[];
  users: Users;
  catalog: Catalog;
  playlists: Playlists;
  rounds: Rounds;
  search: SearchService;
  appConfig: AppConfig;
  /** Current user from the session cookie, or undefined. */
  currentUser(req: FastifyRequest): UserRow | undefined;
  requireUser(req: FastifyRequest): UserRow;
  startSession(reply: FastifyReply, userId: string): void;
}

export interface BuildOptions {
  config: Config;
  db: Db;
  seeds: SeedPlaylist[];
  providers?: Providers;
  fetchImpl?: typeof fetch;
  logger?: boolean;
}

export async function buildApp(opts: BuildOptions): Promise<{ app: FastifyInstance; ctx: Ctx }> {
  const { config, db, seeds } = opts;
  const providers = opts.providers ?? createProviders(config, seeds, opts.fetchImpl);
  const users = new Users(db, config.sessionSecret, providers.spotify);
  const catalog = new Catalog(db, providers.music, config);
  const playlists = new Playlists(db, catalog);
  const rounds = new Rounds(db, catalog, playlists, providers.music, config);
  const search = new SearchService(providers.music, catalog);

  const appConfig: AppConfig = {
    provider: config.provider,
    providerLabel: providers.music.label,
    requiresSpotifyLogin: config.provider === 'spotify',
    clipStagesMs: [...CLIP_STAGES_MS],
    basePoints: [...config.scoring.basePoints],
    hints: config.scoring.hints,
    minPointsWithHints: config.scoring.minPointsWithHints,
    songsPerRound: SONGS_PER_ROUND,
    attempts: ATTEMPTS,
  };

  const app = Fastify({
    logger: opts.logger ? { level: config.isProd ? 'info' : 'warn' } : false,
    trustProxy: true,
    bodyLimit: 64 * 1024,
  });
  await app.register(cookie, { secret: config.sessionSecret });

  const ctx: Ctx = {
    config,
    db,
    providers,
    seeds,
    users,
    catalog,
    playlists,
    rounds,
    search,
    appConfig,
    currentUser(req) {
      const raw = req.cookies[SESSION_COOKIE];
      if (!raw) return undefined;
      const un = req.unsignCookie(raw);
      return un.valid && un.value ? users.sessionUser(un.value) : undefined;
    },
    requireUser(req) {
      const u = ctx.currentUser(req);
      if (!u) throw new ApiError(401, 'unauthenticated', 'Start a session first');
      return u;
    },
    startSession(reply, userId) {
      const sid = users.createSession(userId);
      reply.setCookie(SESSION_COOKIE, sid, {
        signed: true,
        httpOnly: true,
        sameSite: 'lax',
        secure: config.secureCookies,
        path: '/',
        maxAge: 60 * 60 * 24 * 365,
      });
    },
  };

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: { code: 'invalid_request', message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') } });
    }
    if (err instanceof SpotifyApiError) {
      const mapped = mapSpotifyError(err);
      return reply.status(mapped.status).send({ error: { code: mapped.code, message: mapped.message } });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      return reply.status(status).send({ error: { code: 'bad_request', message: (err as Error).message } });
    }
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'internal', message: 'Something went wrong' } });
  });

  app.get('/api/v1/health', async () => ({ ok: true, provider: config.provider }));

  await app.register(async (api) => {
    registerAuthRoutes(api, ctx);
    registerGameRoutes(api, ctx);
    registerSpotifyRoutes(api, ctx);
  }, { prefix: '/api/v1' });

  // Built web client + SPA fallback (client-side routes like /play/:id, /c/:code).
  const hasWeb = !!config.webDistDir && existsSync(resolve(config.webDistDir, 'index.html'));
  if (hasWeb) {
    await app.register(fastifyStatic, {
      root: config.webDistDir!,
      index: false,
      wildcard: false, // one route per built file; everything else falls through to index.html
      setHeaders(res, path) {
        if (path.includes('/assets/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      },
    });
  }
  const sendIndex = (reply: FastifyReply) => reply.header('Cache-Control', 'no-cache').sendFile('index.html');
  if (hasWeb) app.get('/', (_req, reply) => sendIndex(reply));
  app.setNotFoundHandler((req, reply) => {
    if (hasWeb && req.method === 'GET' && !req.url.startsWith('/api/')) return sendIndex(reply);
    return reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } });
  });

  return { app, ctx };
}

export function mapSpotifyError(err: SpotifyApiError): ApiError {
  if (err.reason === 'PREMIUM_REQUIRED' || (err.status === 403 && /premium/i.test(err.message))) {
    return new ApiError(403, 'premium_required', 'Spotify Premium is required to play');
  }
  if (err.status === 404 || err.reason === 'NO_ACTIVE_DEVICE') {
    return new ApiError(409, 'device_not_found', 'Spotify device not found. Open Spotify on your device and try again.');
  }
  if (err.status === 401) return new ApiError(401, 'spotify_not_connected', 'Reconnect Spotify to continue');
  if (err.status === 403) {
    return new ApiError(403, 'spotify_forbidden', `Spotify refused the request: ${err.message}. In Development Mode, your account must be added under User Management in the Spotify dashboard.`);
  }
  return new ApiError(502, 'spotify_error', err.message);
}
