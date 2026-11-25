import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { LibrarySourceDTO } from '@guessong/shared';
import type { Ctx } from '../app';
import { ApiError } from '../lib/util';

const sourceSchema: z.ZodType<LibrarySourceDTO> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('liked') }),
  z.object({ kind: z.literal('top') }),
  z.object({ kind: z.literal('genre'), key: z.string().max(40) }),
  z.object({ kind: z.literal('playlist'), id: z.string().regex(/^[A-Za-z0-9]{1,64}$/) }),
]);

/** Games from the player's Spotify library (Apple/mock mode with Spotify credentials). */
export function registerLibraryRoutes(api: FastifyInstance, ctx: Ctx) {
  const library = () => {
    if (!ctx.library) throw new ApiError(404, 'library_disabled', 'Spotify games are not enabled on this server');
    return ctx.library;
  };

  /** What can be turned into a game: Liked Songs, top songs, genres, playlists. */
  api.get('/library', async (req) => library().overview(ctx.requireUser(req).id));

  /** Start building a game; poll the returned job. */
  api.post('/library/games', async (req) => {
    const source = sourceSchema.parse(req.body);
    return { job: library().createGame(ctx.requireUser(req).id, source) };
  });

  api.get('/library/jobs/:jobId', async (req) => {
    const { jobId } = z.object({ jobId: z.string().max(32) }).parse(req.params);
    return { job: library().job(ctx.requireUser(req).id, jobId) };
  });

  /** Remove one of your library games from your list (its scores stay in history). */
  api.delete('/library/games/:playlistId', async (req) => {
    const { playlistId } = z.object({ playlistId: z.string().max(140) }).parse(req.params);
    const u = ctx.requireUser(req);
    const res = ctx.db
      .prepare("UPDATE playlists SET status = 'error', status_detail = 'removed by owner' WHERE id = ? AND owner_user_id = ? AND source_type = 'library'")
      .run(playlistId, u.id);
    if (!res.changes) throw new ApiError(404, 'playlist_not_found', 'Game not found');
    return { ok: true };
  });
}
