import {
  ATTEMPTS,
  computeSongPoints,
  FALLBACK_SONGS,
  isHintUnlocked,
  maskTitle,
  matchGuess,
  MAX_ROUND_SCORE,
  potentialPoints,
  SONGS_PER_ROUND,
  unlockedMs,
  type AttemptLogEntryDTO,
  type AudioSourceDTO,
  type ChallengeCreateResponse,
  type ChallengeInfoDTO,
  type GuessResponse,
  type HintStateDTO,
  type HintType,
  type ResolveResponse,
  type RevealDTO,
  type RoundDTO,
  type RoundStateResponse,
  type RoundSummaryDTO,
  type SongStateDTO,
} from '@guessong/shared';
import type { Config } from '../config';
import { all, get, run, tx, type Db } from '../db';
import { ApiError, newId, notFound, now, shuffle } from '../lib/util';
import type { MusicProvider } from '../providers/types';
import { artistLine, trackArtists, type Catalog, type TrackRow } from './catalog';
import type { Playlists } from './playlists';

interface RoundRow {
  id: string;
  user_id: string;
  playlist_id: string;
  challenge_code: string | null;
  status: 'active' | 'completed' | 'abandoned';
  total_score: number;
  duration_ms: number | null;
  is_new_best: number | null;
  prev_best_score: number | null;
  prev_best_duration_ms: number | null;
  created_at: number;
  completed_at: number | null;
}

interface SongRow {
  id: string;
  round_id: string;
  slot: number;
  position: number | null;
  track_id: string;
  status: 'pending' | 'active' | 'correct' | 'missed' | 'replaced' | 'fallback';
  attempt: number;
  hints: string;
  points: number;
  started_at: number | null;
  resolved_at: number | null;
  active_ms: number | null;
}

interface EventRow {
  kind: string;
  attempt: number;
  guess_title: string | null;
  guess_artist: string | null;
}

interface ChallengeRow {
  code: string;
  round_id: string;
  user_id: string;
  playlist_id: string;
  track_ids: string;
  score: number;
  duration_ms: number;
  created_at: number;
}

const RESOLVED = new Set(['correct', 'missed']);

function externalLabel(url: string | null): string | null {
  if (!url) return null;
  if (url.includes('open.spotify.com')) return 'Spotify';
  if (url.includes('deezer.com')) return 'Deezer';
  return null;
}

export class Rounds {
  constructor(
    private db: Db,
    private catalog: Catalog,
    private playlists: Playlists,
    private provider: MusicProvider,
    private config: Config,
  ) {}

  // ---- reads ---------------------------------------------------------------

  private round(userId: string, roundId: string): RoundRow {
    const r = get<RoundRow>(this.db, 'SELECT * FROM rounds WHERE id = ? AND user_id = ?', roundId, userId);
    if (!r) throw notFound('Round');
    return r;
  }

  private songs(roundId: string): SongRow[] {
    return all<SongRow>(this.db, 'SELECT * FROM round_songs WHERE round_id = ? ORDER BY slot', roundId);
  }

  private song(roundId: string, songId: string): SongRow {
    const s = get<SongRow>(this.db, 'SELECT * FROM round_songs WHERE id = ? AND round_id = ?', songId, roundId);
    if (!s) throw notFound('Song');
    return s;
  }

  private byPosition(roundId: string): SongRow[] {
    return all<SongRow>(
      this.db,
      'SELECT * FROM round_songs WHERE round_id = ? AND position IS NOT NULL ORDER BY position',
      roundId,
    );
  }

  private currentSong(roundId: string): SongRow | undefined {
    return get<SongRow>(
      this.db,
      `SELECT * FROM round_songs WHERE round_id = ? AND position IS NOT NULL AND status IN ('pending', 'active')
       ORDER BY position LIMIT 1`,
      roundId,
    );
  }

  private track(id: string): TrackRow {
    const t = this.catalog.getTrack(id);
    if (!t) throw new ApiError(500, 'track_missing', 'Track metadata missing');
    return t;
  }

  private hints(s: SongRow): HintType[] {
    return JSON.parse(s.hints) as HintType[];
  }

  private audio(round: RoundRow, s: SongRow, t: TrackRow): AudioSourceDTO {
    if (this.provider.playback === 'spotify') return { kind: 'spotify', clipStartMs: t.clip_start_ms };
    return { kind: 'preview', url: `/api/v1/rounds/${round.id}/songs/${s.id}/audio` };
  }

  private songDTO(round: RoundRow, s: SongRow): SongStateDTO {
    const t = this.track(s.track_id);
    const used = this.hints(s);
    const hints: HintStateDTO = {};
    if (used.includes('artist')) hints.artist = artistLine(t);
    if (used.includes('song')) hints.song = maskTitle(t.title);
    if (used.includes('cover') && t.artwork_url) hints.cover = t.artwork_url;
    const log: AttemptLogEntryDTO[] = all<EventRow>(
      this.db,
      "SELECT kind, attempt, guess_title, guess_artist FROM round_events WHERE round_song_id = ? AND kind IN ('skip', 'wrong') ORDER BY id",
      s.id,
    ).map((e) => ({
      attempt: e.attempt,
      kind: e.kind as 'skip' | 'wrong',
      ...(e.kind === 'wrong' ? { title: e.guess_title ?? '', artist: e.guess_artist ?? '' } : {}),
    }));
    return {
      roundSongId: s.id,
      position: s.position ?? 0,
      attempt: s.attempt,
      unlockedMs: unlockedMs(s.attempt),
      status: s.status === 'pending' || s.status === 'active' || s.status === 'correct' || s.status === 'missed' ? s.status : 'pending',
      hints,
      hintsUsed: used,
      log,
      potentialPoints: potentialPoints(s.attempt, used, this.config.scoring),
      audio: this.audio(round, s, t),
    };
  }

  private challengeInfo(code: string, viewerId: string | null): ChallengeInfoDTO | null {
    const c = get<ChallengeRow>(this.db, 'SELECT * FROM challenges WHERE code = ?', code);
    if (!c) return null;
    const p = this.catalog.getPlaylist(c.playlist_id);
    if (!p) return null;
    const u = get<{ display_name: string; avatar_url: string | null; avatar_color: string }>(
      this.db,
      'SELECT display_name, avatar_url, avatar_color FROM users WHERE id = ?',
      c.user_id,
    );
    return {
      code: c.code,
      playlist: this.playlists.card(p, viewerId),
      challenger: {
        displayName: u?.display_name ?? 'A friend',
        avatarUrl: u?.avatar_url ?? null,
        avatarColor: u?.avatar_color ?? '#16A34A',
      },
      score: c.score,
      durationMs: c.duration_ms,
      createdAt: new Date(c.created_at).toISOString(),
    };
  }

  private roundDTO(r: RoundRow): RoundDTO {
    const p = this.catalog.getPlaylist(r.playlist_id);
    return {
      id: r.id,
      playlist: {
        id: r.playlist_id,
        title: p?.title ?? 'Playlist',
        artworkUrl: p?.artwork_url ?? null,
        mosaic: p?.artwork_url ? [] : this.catalog.mosaic(r.playlist_id),
      },
      totalSongs: SONGS_PER_ROUND,
      totalScore: r.total_score,
      status: r.status,
      challenge: r.challenge_code ? this.challengeInfo(r.challenge_code, r.user_id) : null,
      audioLabel: p?.source_type === 'library' ? 'Deezer' : null,
    };
  }

  state(userId: string, roundId: string): RoundStateResponse {
    const r = this.round(userId, roundId);
    const cur = r.status === 'active' ? this.currentSong(roundId) : undefined;
    return { round: this.roundDTO(r), song: cur ? this.songDTO(r, cur) : null };
  }

  // ---- create --------------------------------------------------------------

  create(userId: string, playlistId: string, challengeCode?: string): RoundStateResponse {
    const p = this.catalog.requireReadyPlaylist(playlistId);
    const ids = this.catalog.playlistTrackIds(p.id);
    let chosen: string[];

    if (challengeCode) {
      const c = get<ChallengeRow>(this.db, 'SELECT * FROM challenges WHERE code = ?', challengeCode);
      if (!c || c.playlist_id !== p.id) throw notFound('Challenge');
      const fixed = JSON.parse(c.track_ids) as string[];
      const rest = shuffle(ids.filter((id) => !fixed.includes(id))).slice(0, FALLBACK_SONGS);
      chosen = [...fixed, ...rest];
    } else {
      // Prefer songs the player hasn't heard in their last few rounds of this playlist.
      const recent = new Set(
        all<{ track_id: string }>(
          this.db,
          `SELECT rs.track_id FROM round_songs rs WHERE rs.round_id IN (
             SELECT id FROM rounds WHERE user_id = ? AND playlist_id = ? ORDER BY created_at DESC LIMIT 3
           ) AND rs.position IS NOT NULL`,
          userId,
          p.id,
        ).map((r) => r.track_id),
      );
      chosen = [...shuffle(ids.filter((id) => !recent.has(id))), ...shuffle(ids.filter((id) => recent.has(id)))].slice(
        0,
        SONGS_PER_ROUND + FALLBACK_SONGS,
      );
    }
    if (chosen.length < SONGS_PER_ROUND) throw new ApiError(409, 'playlist_too_small', 'Not enough songs in this playlist');

    const roundId = newId();
    const t = now();
    tx(this.db, () => {
      run(
        this.db,
        "UPDATE rounds SET status = 'abandoned' WHERE user_id = ? AND status = 'active'",
        userId,
      );
      run(
        this.db,
        `INSERT INTO rounds (id, user_id, playlist_id, challenge_code, status, total_score, created_at)
         VALUES (?, ?, ?, ?, 'active', 0, ?)`,
        roundId,
        userId,
        p.id,
        challengeCode ?? null,
        t,
      );
      chosen.forEach((trackId, i) => {
        const slot = i + 1;
        const playable = slot <= SONGS_PER_ROUND;
        run(
          this.db,
          `INSERT INTO round_songs (id, round_id, slot, position, track_id, status) VALUES (?, ?, ?, ?, ?, ?)`,
          newId(),
          roundId,
          slot,
          playable ? slot : null,
          trackId,
          playable ? 'pending' : 'fallback',
        );
      });
    });
    return this.state(userId, roundId);
  }

  // ---- song actions --------------------------------------------------------

  private forAction(userId: string, roundId: string, songId: string): { round: RoundRow; song: SongRow } {
    const round = this.round(userId, roundId);
    if (round.status !== 'active') throw new ApiError(409, 'round_finished', 'This round is over');
    const song = this.song(roundId, songId);
    if (RESOLVED.has(song.status)) throw new ApiError(409, 'song_resolved', 'This song is already resolved');
    const cur = this.currentSong(roundId);
    if (!cur || cur.id !== song.id) throw new ApiError(409, 'not_current_song', 'Not the current song');
    return { round, song };
  }

  /** First audible playback of a song: starts its clock. */
  start(userId: string, roundId: string, songId: string): SongStateDTO {
    const { round, song } = this.forAction(userId, roundId, songId);
    run(
      this.db,
      "UPDATE round_songs SET started_at = COALESCE(started_at, ?), status = 'active' WHERE id = ?",
      now(),
      song.id,
    );
    return this.songDTO(round, this.song(roundId, songId));
  }

  skip(userId: string, roundId: string, songId: string): SongStateDTO {
    return tx(this.db, () => {
      const { round, song } = this.forAction(userId, roundId, songId);
      if (song.attempt >= ATTEMPTS) throw new ApiError(409, 'no_more_skips', 'No skips left — reveal the answer instead');
      run(
        this.db,
        "UPDATE round_songs SET attempt = attempt + 1, status = 'active', started_at = COALESCE(started_at, ?) WHERE id = ?",
        now(),
        song.id,
      );
      this.event(song.id, 'skip', song.attempt);
      return this.songDTO(round, this.song(roundId, songId));
    });
  }

  hint(userId: string, roundId: string, songId: string, type: HintType): SongStateDTO {
    return tx(this.db, () => {
      const { round, song } = this.forAction(userId, roundId, songId);
      const used = this.hints(song);
      if (used.includes(type)) return this.songDTO(round, song);
      if (!isHintUnlocked(type, song.attempt, this.config.scoring.hints)) {
        throw new ApiError(409, 'hint_locked', `The ${type} hint unlocks on attempt ${this.config.scoring.hints[type].unlockAttempt}`);
      }
      if (type === 'cover' && !this.track(song.track_id).artwork_url) {
        throw new ApiError(409, 'hint_unavailable', 'No cover art for this song');
      }
      run(this.db, 'UPDATE round_songs SET hints = ? WHERE id = ?', JSON.stringify([...used, type]), song.id);
      this.event(song.id, 'hint', song.attempt);
      return this.songDTO(round, this.song(roundId, songId));
    });
  }

  async guess(userId: string, roundId: string, songId: string, guessTrackId: string): Promise<GuessResponse> {
    const { round } = this.forAction(userId, roundId, songId);
    const playlist = this.catalog.getPlaylist(round.playlist_id);
    // Never trust client-sent titles: look the guessed track up ourselves.
    const guessTrack = await this.catalog.ensureTrack(guessTrackId, playlist?.storefront ?? 'US');
    if (!guessTrack) throw new ApiError(400, 'unknown_track', 'Pick a song from the search results');

    return tx(this.db, (): GuessResponse => {
      const { song } = this.forAction(userId, roundId, songId); // re-check after the await
      const target = this.track(song.track_id);
      const guessInfo = { title: guessTrack.title, artist: artistLine(guessTrack) };
      const result = matchGuess(
        { id: target.id, title: target.title, artists: trackArtists(target), isrc: target.isrc },
        { id: guessTrack.id, title: guessTrack.title, artists: trackArtists(guessTrack), isrc: guessTrack.isrc },
      );
      if (result.correct) {
        this.event(song.id, 'correct', song.attempt, guessTrack);
        return { status: 'resolved', guess: guessInfo, ...this.resolve(round, song, 'correct') };
      }
      this.event(song.id, 'wrong', song.attempt, guessTrack);
      if (song.attempt < ATTEMPTS) {
        run(
          this.db,
          "UPDATE round_songs SET attempt = attempt + 1, status = 'active', started_at = COALESCE(started_at, ?) WHERE id = ?",
          now(),
          song.id,
        );
        return { status: 'wrong', guess: guessInfo, song: this.songDTO(round, this.song(roundId, songId)) };
      }
      return { status: 'resolved', guess: guessInfo, ...this.resolve(round, song, 'missed') };
    });
  }

  reveal(userId: string, roundId: string, songId: string): ResolveResponse {
    return tx(this.db, () => {
      const { round, song } = this.forAction(userId, roundId, songId);
      this.event(song.id, 'reveal', song.attempt);
      return this.resolve(round, song, 'missed');
    });
  }

  /** Swap in a fallback track when the current one fails to load (only before it was heard). */
  replace(userId: string, roundId: string, songId: string): SongStateDTO {
    return tx(this.db, () => {
      const { round, song } = this.forAction(userId, roundId, songId);
      if (song.started_at !== null || song.attempt > 1 || this.hints(song).length > 0) {
        throw new ApiError(409, 'replace_not_allowed', 'This song has already been played');
      }
      const fallback = get<SongRow>(
        this.db,
        "SELECT * FROM round_songs WHERE round_id = ? AND status = 'fallback' ORDER BY slot LIMIT 1",
        roundId,
      );
      if (!fallback) throw new ApiError(409, 'no_fallback', 'No replacement songs left');
      run(this.db, "UPDATE round_songs SET status = 'replaced', position = NULL WHERE id = ?", song.id);
      run(this.db, "UPDATE round_songs SET status = 'pending', position = ? WHERE id = ?", song.position, fallback.id);
      return this.songDTO(round, this.song(roundId, fallback.id));
    });
  }

  private event(songId: string, kind: string, attempt: number, guess?: TrackRow) {
    run(
      this.db,
      `INSERT INTO round_events (round_song_id, kind, attempt, guess_track_id, guess_title, guess_artist, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      songId,
      kind,
      attempt,
      guess?.id ?? null,
      guess?.title ?? null,
      guess ? artistLine(guess) : null,
      now(),
    );
  }

  private note(playlistId: string, trackId: string): string | null {
    return (
      get<{ note: string | null }>(this.db, 'SELECT note FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?', playlistId, trackId)
        ?.note ?? null
    );
  }

  private revealDTO(round: RoundRow, s: SongRow, roundTotal: number): RevealDTO {
    const t = this.track(s.track_id);
    return {
      status: s.status === 'correct' ? 'correct' : 'missed',
      position: s.position ?? 0,
      title: t.title,
      artist: artistLine(t),
      album: t.album,
      artworkUrl: t.artwork_url,
      externalUrl: t.external_url,
      externalLabel: externalLabel(t.external_url),
      note: this.note(round.playlist_id, s.track_id),
      attemptsUsed: s.attempt,
      timeListenedMs: unlockedMs(s.attempt),
      pointsAwarded: s.points,
      roundTotalScore: roundTotal,
      isLast: (s.position ?? 0) >= SONGS_PER_ROUND,
    };
  }

  private resolve(round: RoundRow, song: SongRow, status: 'correct' | 'missed'): ResolveResponse {
    const points = computeSongPoints(
      { correct: status === 'correct', attempt: song.attempt, hints: this.hints(song) },
      this.config.scoring,
    );
    const t = now();
    const started = song.started_at ?? t;
    run(
      this.db,
      'UPDATE round_songs SET status = ?, points = ?, resolved_at = ?, started_at = ?, active_ms = ? WHERE id = ?',
      status,
      points,
      t,
      started,
      Math.max(0, t - started),
      song.id,
    );
    run(this.db, 'UPDATE rounds SET total_score = total_score + ? WHERE id = ?', points, round.id);
    const fresh = get<RoundRow>(this.db, 'SELECT * FROM rounds WHERE id = ?', round.id)!;
    const next = this.currentSong(round.id);
    return {
      reveal: this.revealDTO(fresh, this.song(round.id, song.id), fresh.total_score),
      next: next ? this.songDTO(fresh, next) : null,
    };
  }

  // ---- completion ----------------------------------------------------------

  complete(userId: string, roundId: string): RoundSummaryDTO {
    return tx(this.db, () => {
      const round = this.round(userId, roundId);
      if (round.status === 'completed') return this.summary(round);
      if (round.status !== 'active') throw new ApiError(409, 'round_finished', 'This round was abandoned');
      const songs = this.byPosition(roundId);
      if (songs.length < SONGS_PER_ROUND || songs.some((s) => !RESOLVED.has(s.status))) {
        throw new ApiError(409, 'round_incomplete', 'Finish all songs first');
      }
      const durationMs = songs.reduce((sum, s) => sum + (s.active_ms ?? 0), 0);
      const t = now();
      const prev = get<{ best_score: number; best_duration_ms: number }>(
        this.db,
        'SELECT best_score, best_duration_ms FROM user_playlist_best WHERE user_id = ? AND playlist_id = ?',
        userId,
        round.playlist_id,
      );
      const better =
        !prev || round.total_score > prev.best_score || (round.total_score === prev.best_score && durationMs < prev.best_duration_ms);
      if (!prev) {
        run(
          this.db,
          `INSERT INTO user_playlist_best (user_id, playlist_id, best_score, best_duration_ms, best_round_id, achieved_at, plays_count, last_played_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
          userId,
          round.playlist_id,
          round.total_score,
          durationMs,
          round.id,
          t,
          t,
        );
      } else if (better) {
        run(
          this.db,
          `UPDATE user_playlist_best SET best_score = ?, best_duration_ms = ?, best_round_id = ?, achieved_at = ?,
             plays_count = plays_count + 1, last_played_at = ? WHERE user_id = ? AND playlist_id = ?`,
          round.total_score,
          durationMs,
          round.id,
          t,
          t,
          userId,
          round.playlist_id,
        );
      } else {
        run(
          this.db,
          'UPDATE user_playlist_best SET plays_count = plays_count + 1, last_played_at = ? WHERE user_id = ? AND playlist_id = ?',
          t,
          userId,
          round.playlist_id,
        );
      }
      run(
        this.db,
        `UPDATE rounds SET status = 'completed', duration_ms = ?, completed_at = ?, is_new_best = ?,
           prev_best_score = ?, prev_best_duration_ms = ? WHERE id = ?`,
        durationMs,
        t,
        better ? 1 : 0,
        prev?.best_score ?? null,
        prev?.best_duration_ms ?? null,
        round.id,
      );
      return this.summary(get<RoundRow>(this.db, 'SELECT * FROM rounds WHERE id = ?', round.id)!);
    });
  }

  summaryFor(userId: string, roundId: string): RoundSummaryDTO {
    const r = this.round(userId, roundId);
    if (r.status !== 'completed') throw new ApiError(409, 'round_incomplete', 'Round not finished yet');
    return this.summary(r);
  }

  private summary(r: RoundRow): RoundSummaryDTO {
    const p = this.catalog.getPlaylist(r.playlist_id)!;
    const songs = this.byPosition(r.id).map((s) => {
      const t = this.track(s.track_id);
      return {
        position: s.position ?? 0,
        title: t.title,
        artist: artistLine(t),
        artworkUrl: t.artwork_url,
        externalUrl: t.external_url,
        externalLabel: externalLabel(t.external_url),
        status: (s.status === 'correct' ? 'correct' : 'missed') as 'correct' | 'missed',
        attemptsUsed: s.attempt,
        points: s.points,
        hintsUsed: this.hints(s),
      };
    });
    const best = this.playlists.personalBest(r.playlist_id, r.user_id);
    let versus: RoundSummaryDTO['versus'] = null;
    if (r.challenge_code) {
      const c = this.challengeInfo(r.challenge_code, r.user_id);
      if (c) {
        const d = r.duration_ms ?? 0;
        const outcome =
          r.total_score > c.score || (r.total_score === c.score && d < c.durationMs)
            ? 'won'
            : r.total_score === c.score && d === c.durationMs
              ? 'tied'
              : 'lost';
        versus = { challenger: c.challenger, score: c.score, durationMs: c.durationMs, outcome };
      }
    }
    return {
      roundId: r.id,
      playlist: this.playlists.card(p, r.user_id),
      totalScore: r.total_score,
      maxScore: MAX_ROUND_SCORE,
      durationMs: r.duration_ms ?? 0,
      correctCount: songs.filter((s) => s.status === 'correct').length,
      songs,
      rank: best?.rank ?? this.playlists.rankFor(r.playlist_id, r.total_score, r.duration_ms ?? 0),
      playerCount: this.playlists.playerCount(r.playlist_id),
      isNewBest: r.is_new_best === 1,
      previousBest:
        r.prev_best_score !== null ? { score: r.prev_best_score, durationMs: r.prev_best_duration_ms ?? 0 } : null,
      versus,
    };
  }

  abandon(userId: string, roundId: string) {
    const r = this.round(userId, roundId);
    if (r.status === 'active') run(this.db, "UPDATE rounds SET status = 'abandoned' WHERE id = ?", r.id);
  }

  // ---- challenges ----------------------------------------------------------

  createChallenge(userId: string, roundId: string): ChallengeCreateResponse {
    return tx(this.db, () => {
      const r = this.round(userId, roundId);
      if (r.status !== 'completed') throw new ApiError(409, 'round_incomplete', 'Finish the round first');
      const existing = get<{ code: string }>(this.db, 'SELECT code FROM challenges WHERE round_id = ?', r.id);
      const code = existing?.code ?? newId(8);
      if (!existing) {
        const trackIds = this.byPosition(r.id).map((s) => s.track_id);
        run(
          this.db,
          `INSERT INTO challenges (code, round_id, user_id, playlist_id, track_ids, score, duration_ms, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          code,
          r.id,
          userId,
          r.playlist_id,
          JSON.stringify(trackIds),
          r.total_score,
          r.duration_ms ?? 0,
          now(),
        );
      }
      return { code, url: `${this.config.publicUrl}/c/${code}` };
    });
  }

  challenge(code: string, viewerId: string | null): ChallengeInfoDTO {
    const c = this.challengeInfo(code, viewerId);
    if (!c) throw notFound('Challenge');
    return c;
  }

  // ---- playback helpers ------------------------------------------------------

  /** Track for audio playback; allowed for the round's assigned songs only. */
  playableTrack(userId: string, roundId: string, songId: string): { round: RoundRow; song: SongRow; track: TrackRow; storefront: string } {
    const round = this.round(userId, roundId);
    const song = this.song(roundId, songId);
    if (song.position === null || song.status === 'replaced' || song.status === 'fallback') {
      throw new ApiError(409, 'not_playable', 'This song is not part of the round');
    }
    const storefront = this.catalog.getPlaylist(round.playlist_id)?.storefront ?? 'US';
    return { round, song, track: this.track(song.track_id), storefront };
  }
}
