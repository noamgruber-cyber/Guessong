import {
  LANGUAGES,
  languageInfo,
  SONGS_PER_ROUND,
  type LanguageDTO,
  type LeaderboardEntryDTO,
  type LeaderboardResponse,
  type PersonalBestDTO,
  type PlaylistCardDTO,
  type PlaylistsResponse,
  type PlaylistSummaryResponse,
} from '@guessong/shared';
import { all, get, type Db } from '../db';
import type { Catalog, PlaylistRow } from './catalog';

interface BestRow {
  user_id: string;
  best_score: number;
  best_duration_ms: number;
  last_played_at: number;
}

interface EntryRow {
  rnk: number;
  user_id: string;
  display_name: string;
  avatar_url: string | null;
  avatar_color: string;
  best_score: number;
  best_duration_ms: number;
}

export class Playlists {
  constructor(
    private db: Db,
    private catalog: Catalog,
  ) {}

  private provider() {
    return this.catalog.providerId;
  }

  rankFor(playlistId: string, score: number, durationMs: number): number {
    const r = get<{ better: number }>(
      this.db,
      `SELECT COUNT(*) AS better FROM user_playlist_best
       WHERE playlist_id = ? AND (best_score > ? OR (best_score = ? AND best_duration_ms < ?))`,
      playlistId,
      score,
      score,
      durationMs,
    );
    return (r?.better ?? 0) + 1;
  }

  playerCount(playlistId: string): number {
    return get<{ n: number }>(this.db, 'SELECT COUNT(*) AS n FROM user_playlist_best WHERE playlist_id = ?', playlistId)?.n ?? 0;
  }

  personalBest(playlistId: string, userId: string | null): PersonalBestDTO | null {
    if (!userId) return null;
    const b = get<BestRow>(
      this.db,
      'SELECT * FROM user_playlist_best WHERE playlist_id = ? AND user_id = ?',
      playlistId,
      userId,
    );
    if (!b) return null;
    return {
      bestScore: b.best_score,
      bestDurationMs: b.best_duration_ms,
      rank: this.rankFor(playlistId, b.best_score, b.best_duration_ms),
    };
  }

  card(p: PlaylistRow, userId: string | null): PlaylistCardDTO {
    const songCount =
      get<{ n: number }>(this.db, 'SELECT COUNT(*) AS n FROM playlist_tracks WHERE playlist_id = ?', p.id)?.n ?? 0;
    return {
      id: p.id,
      title: p.title,
      description: p.description,
      lang: p.lang,
      artworkUrl: p.artwork_url,
      mosaic: p.artwork_url ? [] : this.catalog.mosaic(p.id),
      songCount,
      playerCount: this.playerCount(p.id),
      me: this.personalBest(p.id, userId),
      source: p.source_type,
    };
  }

  private readyPlaylists(): PlaylistRow[] {
    return all<PlaylistRow>(
      this.db,
      "SELECT * FROM playlists WHERE provider = ? AND status = 'ready' ORDER BY sort_order, title",
      this.provider(),
    );
  }

  list(userId: string | null, opts: { lang?: string; filter?: 'popular' | 'unplayed' }): PlaylistsResponse {
    const ready = this.readyPlaylists();
    const counts = new Map<string, number>();
    for (const p of ready) counts.set(p.lang, (counts.get(p.lang) ?? 0) + 1);
    const known = LANGUAGES.filter((l) => counts.has(l.code));
    const extra = [...counts.keys()].filter((c) => !LANGUAGES.some((l) => l.code === c)).map(languageInfo);
    const languages: LanguageDTO[] = [...known, ...extra].map((l) => ({ ...l, playlistCount: counts.get(l.code) ?? 0 }));

    let cards = ready.filter((p) => !opts.lang || p.lang === opts.lang).map((p) => this.card(p, userId));
    if (opts.filter === 'unplayed') {
      cards = cards.filter((c) => !c.me);
    } else {
      cards = cards
        .map((c, i) => ({ c, i }))
        .sort((a, b) => b.c.playerCount - a.c.playerCount || a.i - b.i)
        .map(({ c }) => c);
    }

    const recent = userId
      ? all<BestRow & { playlist_id: string }>(
          this.db,
          `SELECT b.* FROM user_playlist_best b JOIN playlists p ON p.id = b.playlist_id
           WHERE b.user_id = ? AND p.provider = ? AND p.status = 'ready'
           ORDER BY b.last_played_at DESC LIMIT 8`,
          userId,
          this.provider(),
        ).map((b) => ({
          playlist: this.card(ready.find((p) => p.id === b.playlist_id)!, userId),
          lastPlayedAt: new Date(b.last_played_at).toISOString(),
        }))
      : [];

    return { languages, playlists: cards, recent };
  }

  private entries(playlistId: string, userId: string | null, limit: number, offset: number): LeaderboardEntryDTO[] {
    return all<EntryRow>(
      this.db,
      `SELECT * FROM (
         SELECT RANK() OVER (ORDER BY b.best_score DESC, b.best_duration_ms ASC) AS rnk,
                b.user_id, u.display_name, u.avatar_url, u.avatar_color, b.best_score, b.best_duration_ms, b.achieved_at
         FROM user_playlist_best b JOIN users u ON u.id = b.user_id
         WHERE b.playlist_id = ?
       ) ORDER BY rnk, achieved_at LIMIT ? OFFSET ?`,
      playlistId,
      limit,
      offset,
    ).map((r) => toEntry(r, userId));
  }

  private meEntry(playlistId: string, userId: string | null): LeaderboardEntryDTO | null {
    if (!userId) return null;
    const r = get<EntryRow>(
      this.db,
      `SELECT 0 AS rnk, b.user_id, u.display_name, u.avatar_url, u.avatar_color, b.best_score, b.best_duration_ms
       FROM user_playlist_best b JOIN users u ON u.id = b.user_id WHERE b.playlist_id = ? AND b.user_id = ?`,
      playlistId,
      userId,
    );
    if (!r) return null;
    r.rnk = this.rankFor(playlistId, r.best_score, r.best_duration_ms);
    return toEntry(r, userId);
  }

  summary(playlistId: string, userId: string | null): PlaylistSummaryResponse {
    const p = this.catalog.requireReadyPlaylist(playlistId);
    return {
      playlist: this.card(p, userId),
      top: this.entries(playlistId, userId, 3, 0),
      me: this.meEntry(playlistId, userId),
      songsPerRound: SONGS_PER_ROUND,
    };
  }

  leaderboard(playlistId: string, userId: string | null, page: number, limit: number): LeaderboardResponse {
    const p = this.catalog.requireReadyPlaylist(playlistId);
    const safeLimit = Math.min(100, Math.max(1, limit));
    const safePage = Math.max(1, page);
    return {
      playlist: this.card(p, userId),
      entries: this.entries(playlistId, userId, safeLimit, (safePage - 1) * safeLimit),
      total: this.playerCount(playlistId),
      page: safePage,
      limit: safeLimit,
      me: this.meEntry(playlistId, userId),
    };
  }
}

function toEntry(r: EntryRow, userId: string | null): LeaderboardEntryDTO {
  return {
    rank: r.rnk,
    userId: r.user_id,
    displayName: r.display_name,
    avatarUrl: r.avatar_url,
    avatarColor: r.avatar_color,
    bestScore: r.best_score,
    bestDurationMs: r.best_duration_ms,
    isMe: r.user_id === userId,
  };
}
