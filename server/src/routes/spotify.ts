import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LANGUAGES, unlockedMs, type SpotifyDeviceDTO, type SpotifyPlaylistOptionDTO } from '@guessong/shared';
import type { Ctx } from '../app';
import { ApiError } from '../lib/util';

/**
 * Spotify-mode endpoints. Playback is always started by the server with the
 * user's token, so the track id/URI never appears in this app's API payloads.
 */
export function registerSpotifyRoutes(api: FastifyInstance, ctx: Ctx) {
  const spotify = () => {
    if (!ctx.providers.spotify) throw new ApiError(404, 'spotify_disabled', 'Spotify mode is not enabled on this server');
    return ctx.providers.spotify;
  };
  const songParams = z.object({ roundId: z.string(), songId: z.string() });
  /** Pending server-side "pause at end of clip" timers (Connect mode), per user. */
  const pauseTimers = new Map<string, NodeJS.Timeout>();

  /** Short-lived token for the Web Playback SDK (`getOAuthToken`). */
  api.get('/spotify/token', async (req) => {
    spotify();
    const u = ctx.requireUser(req);
    return ctx.users.spotifyAccessToken(u.id);
  });

  api.get('/spotify/devices', async (req): Promise<{ devices: SpotifyDeviceDTO[] }> => {
    const u = ctx.requireUser(req);
    const { accessToken } = await ctx.users.spotifyAccessToken(u.id);
    return { devices: await spotify().devices(accessToken) };
  });

  /** Load the song onto a device at the clip start (SDK mode mutes and pauses it right away). */
  api.post('/rounds/:roundId/songs/:songId/spotify/load', async (req) => {
    const p = songParams.parse(req.params);
    const body = z.object({ deviceId: z.string().min(1) }).parse(req.body);
    const u = ctx.requireUser(req);
    const { track } = ctx.rounds.playableTrack(u.id, p.roundId, p.songId);
    if (!track.uri) throw new ApiError(409, 'not_playable', 'Track has no Spotify URI');
    const { accessToken } = await ctx.users.spotifyAccessToken(u.id);
    await spotify().play(accessToken, body.deviceId, track.uri, track.clip_start_ms);
    return { ok: true, clipStartMs: track.clip_start_ms };
  });

  /**
   * Connect mode (the game controls the Spotify app on a phone/speaker):
   * start the slice and schedule the pause on the server, so both commands
   * travel the same path and the heard length stays close to the clip length.
   */
  api.post('/rounds/:roundId/songs/:songId/spotify/play', async (req) => {
    const p = songParams.parse(req.params);
    const body = z
      .object({ deviceId: z.string().min(1), startMs: z.number().min(0).max(30_000), endMs: z.number().min(0).max(30_000) })
      .parse(req.body);
    if (body.endMs <= body.startMs) throw new ApiError(400, 'invalid_slice', 'endMs must be after startMs');
    const u = ctx.requireUser(req);
    const { track, song } = ctx.rounds.playableTrack(u.id, p.roundId, p.songId);
    // Before the song is resolved, never play past what the player has unlocked.
    const unlocked = unlockedMs(song.attempt);
    const resolved = song.status === 'correct' || song.status === 'missed';
    if (!resolved && body.endMs > unlocked) throw new ApiError(403, 'not_unlocked', 'That part of the clip is still locked');
    if (!track.uri) throw new ApiError(409, 'not_playable', 'Track has no Spotify URI');
    const { accessToken } = await ctx.users.spotifyAccessToken(u.id);
    clearTimeout(pauseTimers.get(u.id));
    await spotify().play(accessToken, body.deviceId, track.uri, track.clip_start_ms + body.startMs);
    const duration = body.endMs - body.startMs + ctx.config.spotify.connectStartCompMs;
    pauseTimers.set(
      u.id,
      setTimeout(() => {
        pauseTimers.delete(u.id);
        spotify().pause(accessToken, body.deviceId).catch((e) => req.log.warn(e, 'scheduled pause failed'));
      }, duration),
    );
    return { ok: true, durationMs: duration };
  });

  api.post('/spotify/pause', async (req) => {
    const body = z.object({ deviceId: z.string().min(1).optional() }).parse(req.body ?? {});
    const u = ctx.requireUser(req);
    clearTimeout(pauseTimers.get(u.id));
    pauseTimers.delete(u.id);
    const { accessToken } = await ctx.users.spotifyAccessToken(u.id);
    await spotify().pause(accessToken, body.deviceId);
    return { ok: true };
  });

  // ---- importing the user's own playlists -----------------------------------

  api.get('/spotify/playlists', async (req): Promise<{ playlists: SpotifyPlaylistOptionDTO[] }> => {
    const u = ctx.requireUser(req);
    const { accessToken } = await ctx.users.spotifyAccessToken(u.id);
    const me = await spotify().me(accessToken);
    const mine = (await spotify().myPlaylists(accessToken)).filter((p) => p.ownerId === me.id || p.collaborative);
    return {
      playlists: mine.map((p) => ({
        id: p.id,
        name: p.name,
        imageUrl: p.imageUrl,
        trackCount: p.trackCount,
        imported: !!ctx.catalog.getPlaylist(`sp-${p.id.toLowerCase()}`),
      })),
    };
  });

  api.post('/playlists/import', async (req) => {
    const body = z
      .object({
        spotifyPlaylistId: z.string().regex(/^[A-Za-z0-9]+$/),
        lang: z.enum(LANGUAGES.map((l) => l.code) as [string, ...string[]]),
      })
      .parse(req.body);
    const u = ctx.requireUser(req);
    const { accessToken } = await ctx.users.spotifyAccessToken(u.id);
    const api_ = spotify();
    const meta = await api_.playlistMeta(accessToken, body.spotifyPlaylistId);
    if (!meta) throw new ApiError(404, 'not_found', 'Playlist not found');
    const tracks = await api_.playlistTracks(accessToken, body.spotifyPlaylistId, ctx.config.spotify.market);
    const row = await ctx.catalog.importSpotifyPlaylist({
      userId: u.id,
      spotifyPlaylistId: body.spotifyPlaylistId,
      lang: body.lang,
      meta: {
        name: meta.name,
        description: meta.description?.replace(/<[^>]+>/g, '') || null,
        imageUrl: meta.images?.[0]?.url ?? null,
      },
      tracks,
      storefront: ctx.config.spotify.market,
    });
    return { playlist: ctx.playlists.card(row, u.id) };
  });
}
