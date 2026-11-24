import type {
  ChallengeCreateResponse,
  ChallengeInfoDTO,
  GuessResponse,
  HintType,
  LeaderboardResponse,
  MeResponse,
  PlaylistCardDTO,
  PlaylistsResponse,
  PlaylistSummaryResponse,
  ResolveResponse,
  RoundStateResponse,
  RoundSummaryDTO,
  SearchResponse,
  SongActionResponse,
  SpotifyDeviceDTO,
  SpotifyPlaylistOptionDTO,
  UserDTO,
} from '@guessong/shared';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'network', 'You appear to be offline');
  }
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new ApiError(res.status, json?.error?.code ?? `http_${res.status}`, json?.error?.message ?? 'Request failed');
  }
  return json as T;
}

const song = (roundId: string, songId: string) => `/rounds/${roundId}/songs/${songId}`;

export const api = {
  me: () => request<MeResponse>('GET', '/me'),
  guest: (displayName?: string) => request<{ user: UserDTO }>('POST', '/auth/guest', { displayName }),
  rename: (displayName: string) => request<{ user: UserDTO }>('PATCH', '/me', { displayName }),
  logout: () => request<{ ok: true }>('POST', '/auth/logout'),
  disconnectSpotify: () => request<{ user: UserDTO }>('POST', '/me/spotify/disconnect'),

  playlists: (lang?: string, filter?: 'popular' | 'unplayed') => {
    const q = new URLSearchParams();
    if (lang) q.set('lang', lang);
    if (filter) q.set('filter', filter);
    return request<PlaylistsResponse>('GET', `/playlists?${q}`);
  },
  playlistSummary: (id: string) => request<PlaylistSummaryResponse>('GET', `/playlists/${id}/summary`),
  leaderboard: (id: string, page = 1, limit = 50) =>
    request<LeaderboardResponse>('GET', `/playlists/${id}/leaderboard?page=${page}&limit=${limit}`),
  challengeFromBest: (playlistId: string) => request<ChallengeCreateResponse>('POST', `/playlists/${playlistId}/challenge`),

  createRound: (playlistId: string, challengeCode?: string) =>
    request<RoundStateResponse>('POST', '/rounds', { playlistId, challengeCode }),
  round: (roundId: string) => request<RoundStateResponse>('GET', `/rounds/${roundId}`),
  start: (roundId: string, songId: string) => request<SongActionResponse>('POST', `${song(roundId, songId)}/start`),
  skip: (roundId: string, songId: string) => request<SongActionResponse>('POST', `${song(roundId, songId)}/skip`),
  hint: (roundId: string, songId: string, hintType: HintType) =>
    request<SongActionResponse>('POST', `${song(roundId, songId)}/hint`, { hintType }),
  guess: (roundId: string, songId: string, trackId: string) =>
    request<GuessResponse>('POST', `${song(roundId, songId)}/guess`, { trackId }),
  reveal: (roundId: string, songId: string) => request<ResolveResponse>('POST', `${song(roundId, songId)}/reveal`),
  replace: (roundId: string, songId: string) => request<SongActionResponse>('POST', `${song(roundId, songId)}/replace`),
  complete: (roundId: string) => request<RoundSummaryDTO>('POST', `/rounds/${roundId}/complete`),
  summary: (roundId: string) => request<RoundSummaryDTO>('GET', `/rounds/${roundId}/summary`),
  abandon: (roundId: string) => request<{ ok: true }>('POST', `/rounds/${roundId}/abandon`),
  createChallenge: (roundId: string) => request<ChallengeCreateResponse>('POST', `/rounds/${roundId}/challenge`),
  challenge: (code: string) => request<ChallengeInfoDTO>('GET', `/challenges/${code}`),

  search: (q: string, playlistId: string | undefined, signal: AbortSignal) =>
    request<SearchResponse>(
      'GET',
      `/search?${new URLSearchParams({ q, ...(playlistId ? { playlistId } : {}) })}`,
      undefined,
      signal,
    ),

  spotifyToken: () => request<{ accessToken: string; expiresAt: number }>('GET', '/spotify/token'),
  spotifyDevices: () => request<{ devices: SpotifyDeviceDTO[] }>('GET', '/spotify/devices'),
  spotifyLoad: (roundId: string, songId: string, deviceId: string) =>
    request<{ ok: true; clipStartMs: number }>('POST', `${song(roundId, songId)}/spotify/load`, { deviceId }),
  spotifyPlay: (roundId: string, songId: string, deviceId: string, startMs: number, endMs: number) =>
    request<{ ok: true; durationMs: number }>('POST', `${song(roundId, songId)}/spotify/play`, { deviceId, startMs, endMs }),
  spotifyPause: (deviceId?: string) => request<{ ok: true }>('POST', '/spotify/pause', { deviceId }),
  spotifyPlaylists: () => request<{ playlists: SpotifyPlaylistOptionDTO[] }>('GET', '/spotify/playlists'),
  importPlaylist: (spotifyPlaylistId: string, lang: string) =>
    request<{ playlist: PlaylistCardDTO }>('POST', '/playlists/import', { spotifyPlaylistId, lang }),
};

export const SPOTIFY_LOGIN_URL = '/api/v1/auth/spotify/login';
