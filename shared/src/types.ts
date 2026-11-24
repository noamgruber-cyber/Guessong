/** API data contracts shared by server and web client. */
import type { HintRules, HintType } from './rules';

export type ProviderId = 'apple' | 'spotify' | 'mock';

export interface AppConfig {
  provider: ProviderId;
  /** "Apple Music" / "Spotify" / "Demo catalog" — used for attribution. */
  providerLabel: string;
  /** Spotify mode: a Spotify Premium sign-in is required to play. */
  requiresSpotifyLogin: boolean;
  clipStagesMs: number[];
  basePoints: number[];
  hints: HintRules;
  minPointsWithHints: number;
  songsPerRound: number;
  attempts: number;
}

export interface UserDTO {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  avatarColor: string;
  isGuest: boolean;
  spotifyConnected: boolean;
}

export interface MeResponse {
  user: UserDTO | null;
  config: AppConfig;
}

export interface LanguageDTO {
  code: string;
  label: string;
  flag: string;
  playlistCount: number;
}

export interface PersonalBestDTO {
  bestScore: number;
  bestDurationMs: number;
  rank: number;
}

export interface PlaylistCardDTO {
  id: string;
  title: string;
  description: string | null;
  lang: string;
  /** Explicit cover, or null → client draws a mosaic from `mosaic`. */
  artworkUrl: string | null;
  mosaic: string[];
  songCount: number;
  playerCount: number;
  me: PersonalBestDTO | null;
  source: 'seed' | 'import';
}

export interface RecentPlaylistDTO {
  playlist: PlaylistCardDTO;
  lastPlayedAt: string;
}

export interface PlaylistsResponse {
  languages: LanguageDTO[];
  playlists: PlaylistCardDTO[];
  recent: RecentPlaylistDTO[];
}

export interface LeaderboardEntryDTO {
  rank: number;
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  avatarColor: string;
  bestScore: number;
  bestDurationMs: number;
  isMe: boolean;
}

export interface PlaylistSummaryResponse {
  playlist: PlaylistCardDTO;
  top: LeaderboardEntryDTO[];
  me: LeaderboardEntryDTO | null;
  songsPerRound: number;
}

export interface LeaderboardResponse {
  playlist: PlaylistCardDTO;
  entries: LeaderboardEntryDTO[];
  total: number;
  page: number;
  limit: number;
  me: LeaderboardEntryDTO | null;
}

/** How the client gets audio for a song. Never contains the answer. */
export type AudioSourceDTO =
  | { kind: 'preview'; url: string }
  | { kind: 'spotify'; clipStartMs: number };

export interface HintStateDTO {
  artist?: string;
  song?: string;
  cover?: string;
}

export interface AttemptLogEntryDTO {
  attempt: number;
  kind: 'skip' | 'wrong';
  title?: string;
  artist?: string;
}

export type SongStatus = 'pending' | 'active' | 'correct' | 'missed';

export interface SongStateDTO {
  roundSongId: string;
  position: number;
  attempt: number;
  unlockedMs: number;
  status: SongStatus;
  hints: HintStateDTO;
  hintsUsed: HintType[];
  log: AttemptLogEntryDTO[];
  potentialPoints: number;
  audio: AudioSourceDTO;
}

export interface RevealDTO {
  status: 'correct' | 'missed';
  position: number;
  title: string;
  artist: string;
  album: string | null;
  artworkUrl: string | null;
  /** Link back to the track in the provider's app/store (attribution). */
  externalUrl: string | null;
  attemptsUsed: number;
  timeListenedMs: number;
  pointsAwarded: number;
  roundTotalScore: number;
  isLast: boolean;
}

export interface ChallengeInfoDTO {
  code: string;
  playlist: PlaylistCardDTO;
  challenger: { displayName: string; avatarUrl: string | null; avatarColor: string };
  score: number;
  durationMs: number;
  createdAt: string;
}

export interface RoundDTO {
  id: string;
  playlist: { id: string; title: string; artworkUrl: string | null; mosaic: string[] };
  totalSongs: number;
  totalScore: number;
  status: 'active' | 'completed' | 'abandoned';
  challenge: ChallengeInfoDTO | null;
}

export interface RoundStateResponse {
  round: RoundDTO;
  /** Current unresolved song, or null when all songs are resolved. */
  song: SongStateDTO | null;
}

export interface SongActionResponse {
  song: SongStateDTO;
}

export type GuessResponse =
  | { status: 'wrong'; song: SongStateDTO; guess: { title: string; artist: string } }
  | { status: 'resolved'; reveal: RevealDTO; next: SongStateDTO | null; guess: { title: string; artist: string } | null };

export interface ResolveResponse {
  reveal: RevealDTO;
  next: SongStateDTO | null;
}

export interface RoundSongRecapDTO {
  position: number;
  title: string;
  artist: string;
  artworkUrl: string | null;
  externalUrl: string | null;
  status: 'correct' | 'missed';
  attemptsUsed: number;
  points: number;
  hintsUsed: HintType[];
}

export interface RoundSummaryDTO {
  roundId: string;
  playlist: PlaylistCardDTO;
  totalScore: number;
  maxScore: number;
  durationMs: number;
  correctCount: number;
  songs: RoundSongRecapDTO[];
  rank: number;
  playerCount: number;
  isNewBest: boolean;
  previousBest: { score: number; durationMs: number } | null;
  versus: {
    challenger: { displayName: string; avatarUrl: string | null; avatarColor: string };
    score: number;
    durationMs: number;
    outcome: 'won' | 'lost' | 'tied';
  } | null;
}

export interface ChallengeCreateResponse {
  code: string;
  url: string;
}

export interface SearchResultDTO {
  id: string;
  title: string;
  artist: string;
}

export interface SearchResponse {
  results: SearchResultDTO[];
  /** True when upstream search was rate-limited and only cached/local hits are shown. */
  partial: boolean;
}

export interface SpotifyPlaylistOptionDTO {
  id: string;
  name: string;
  imageUrl: string | null;
  trackCount: number | null;
  imported: boolean;
}

export interface SpotifyDeviceDTO {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}
