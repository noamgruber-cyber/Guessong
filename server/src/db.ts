import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync as DatabaseSyncType, SQLInputValue } from 'node:sqlite';

// Loaded via require so test tooling doesn't try to resolve the (newer) builtin itself.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export type Db = DatabaseSyncType;
export type Param = SQLInputValue;

const MIGRATIONS: string[] = [
  /* 1: initial schema */ `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    avatar_url TEXT,
    avatar_color TEXT NOT NULL,
    spotify_id TEXT UNIQUE,
    spotify_access_token TEXT,
    spotify_refresh_token TEXT,
    spotify_token_expires_at INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );

  CREATE TABLE playlists (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    lang TEXT NOT NULL,
    storefront TEXT NOT NULL,
    artwork_url TEXT,
    source_type TEXT NOT NULL,          -- seed | import
    source_ref TEXT,                    -- seed hash or provider playlist id
    owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    status TEXT NOT NULL,               -- pending | ready | error
    status_detail TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX playlists_provider ON playlists(provider, status);

  CREATE TABLE tracks (
    provider TEXT NOT NULL,
    id TEXT NOT NULL,
    title TEXT NOT NULL,
    artists TEXT NOT NULL,              -- JSON array of credits
    album TEXT,
    artwork_url TEXT,
    preview_url TEXT,
    isrc TEXT,
    duration_ms INTEGER,
    uri TEXT,
    external_url TEXT,
    clip_start_ms INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (provider, id)
  );

  CREATE TABLE playlist_tracks (
    playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    track_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (playlist_id, track_id)
  );

  CREATE TABLE rounds (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    challenge_code TEXT,
    status TEXT NOT NULL,               -- active | completed | abandoned
    total_score INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER,
    is_new_best INTEGER,
    prev_best_score INTEGER,
    prev_best_duration_ms INTEGER,
    created_at INTEGER NOT NULL,
    completed_at INTEGER
  );
  CREATE INDEX rounds_user ON rounds(user_id, created_at);

  CREATE TABLE round_songs (
    id TEXT PRIMARY KEY,
    round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
    slot INTEGER NOT NULL,              -- 1..10 playable, 11+ fallbacks
    position INTEGER,                   -- 1..10 once assigned
    track_id TEXT NOT NULL,
    status TEXT NOT NULL,               -- pending | active | correct | missed | replaced | fallback
    attempt INTEGER NOT NULL DEFAULT 1,
    hints TEXT NOT NULL DEFAULT '[]',
    points INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER,
    resolved_at INTEGER,
    active_ms INTEGER
  );
  CREATE INDEX round_songs_round ON round_songs(round_id, slot);

  CREATE TABLE round_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    round_song_id TEXT NOT NULL REFERENCES round_songs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,                 -- skip | wrong | hint | correct | reveal
    attempt INTEGER NOT NULL,
    guess_track_id TEXT,
    guess_title TEXT,
    guess_artist TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX round_events_song ON round_events(round_song_id, id);

  CREATE TABLE user_playlist_best (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    best_score INTEGER NOT NULL,
    best_duration_ms INTEGER NOT NULL,
    best_round_id TEXT NOT NULL,
    achieved_at INTEGER NOT NULL,
    plays_count INTEGER NOT NULL DEFAULT 1,
    last_played_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, playlist_id)
  );
  CREATE INDEX best_leaderboard ON user_playlist_best(playlist_id, best_score DESC, best_duration_ms ASC, achieved_at ASC);

  CREATE TABLE challenges (
    code TEXT PRIMARY KEY,
    round_id TEXT NOT NULL UNIQUE REFERENCES rounds(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    track_ids TEXT NOT NULL,            -- JSON array, in play order
    score INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  /* 2: Spotify → Deezer preview matches (cached across players and imports) */ `
  CREATE TABLE track_links (
    spotify_id TEXT PRIMARY KEY,
    deezer_id TEXT,                     -- NULL = no playable match found
    matched_at INTEGER NOT NULL
  );
  `,
  /* 3: themed shelves and per-song fun facts */ `
  ALTER TABLE playlists ADD COLUMN collection TEXT;
  ALTER TABLE playlist_tracks ADD COLUMN note TEXT;
  `,
];

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  migrate(db);
  return db;
}

function migrate(db: Db) {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    tx(db, () => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

let depth = 0;
/** Run `fn` in a write transaction (re-entrant: nested calls join the outer one). */
export function tx<T>(db: Db, fn: () => T): T {
  if (depth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  depth++;
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    depth--;
  }
}

export function get<T>(db: Db, sql: string, ...params: Param[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function all<T>(db: Db, sql: string, ...params: Param[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function run(db: Db, sql: string, ...params: Param[]) {
  return db.prepare(sql).run(...params);
}
