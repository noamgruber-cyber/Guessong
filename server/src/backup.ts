import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import pg from 'pg';
import type { Db } from './db';

/**
 * Keeps the SQLite database alive on hosts whose disk is wiped on every restart
 * (Render's free plan wipes it whenever the service sleeps, restarts or redeploys).
 *
 * On boot the latest copy is restored from a Postgres database (Neon's free plan
 * works well); while running, a compressed snapshot is saved whenever something
 * changed, at most every 30 seconds, and once more on shutdown. SQLite stays the
 * live database, so nothing else in the app changes.
 */

export interface BackupStore {
  load(): Promise<{ data: Buffer; savedAt: number } | null>;
  save(data: Buffer, savedAt: number): Promise<void>;
  close(): Promise<void>;
}

interface Log {
  info(msg: string): void;
  warn(msg: string): void;
}

const ROW_ID = 'main';

export class PostgresBackupStore implements BackupStore {
  private pool: pg.Pool;
  private ready: Promise<void> | null = null;

  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 15_000, idleTimeoutMillis: 30_000 });
    // An idle client dropping (Neon suspends idle databases) must not crash the server.
    this.pool.on('error', () => {});
  }

  private ensureTable() {
    this.ready ??= this.pool
      .query(
        `CREATE TABLE IF NOT EXISTS guessong_backup (
           id TEXT PRIMARY KEY,
           data BYTEA NOT NULL,
           saved_at BIGINT NOT NULL,
           size_bytes INTEGER NOT NULL
         )`,
      )
      .then(() => undefined)
      .catch((e) => {
        this.ready = null;
        throw e;
      });
    return this.ready;
  }

  async load() {
    await this.ensureTable();
    const r = await this.pool.query<{ data: Buffer; saved_at: string }>('SELECT data, saved_at FROM guessong_backup WHERE id = $1', [ROW_ID]);
    const row = r.rows[0];
    return row ? { data: row.data, savedAt: Number(row.saved_at) } : null;
  }

  async save(data: Buffer, savedAt: number) {
    await this.ensureTable();
    await this.pool.query(
      `INSERT INTO guessong_backup (id, data, saved_at, size_bytes) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, saved_at = EXCLUDED.saved_at, size_bytes = EXCLUDED.size_bytes`,
      [ROW_ID, data, savedAt, data.length],
    );
  }

  close() {
    return this.pool.end();
  }
}

/**
 * Restore the saved copy into `dbPath` (before the database is opened).
 * Throws when the backup can't be read, so the caller can avoid overwriting it.
 */
export async function restoreDatabase(store: BackupStore, dbPath: string): Promise<'restored' | 'no-backup' | 'local-is-newer'> {
  const backup = await store.load();
  if (!backup) return 'no-backup';
  if (existsSync(dbPath) && statSync(dbPath).mtimeMs >= backup.savedAt) return 'local-is-newer';
  const tmp = `${dbPath}.restore`;
  writeFileSync(tmp, gunzipSync(backup.data));
  for (const ext of ['', '-wal', '-shm']) rmSync(`${dbPath}${ext}`, { force: true });
  renameSync(tmp, dbPath);
  return 'restored';
}

export class DatabaseBackup {
  private timer: NodeJS.Timeout | null = null;
  private savedChanges = -1;
  private inflight: Promise<void> | null = null;

  constructor(
    private db: Db,
    private dbPath: string,
    private store: BackupStore,
    private log: Log,
    private intervalMs = 30_000,
  ) {}

  private changes(): number {
    return (this.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
  }

  start() {
    this.savedChanges = this.changes();
    this.timer = setInterval(() => void this.flush(), this.intervalMs);
    this.timer.unref();
  }

  /** Save a snapshot if anything changed since the last one. */
  flush(): Promise<void> {
    if (this.inflight) return this.inflight;
    const changes = this.changes();
    if (changes === this.savedChanges) return Promise.resolve();
    this.inflight = (async () => {
      const tmp = `${this.dbPath}.snapshot`;
      rmSync(tmp, { force: true });
      try {
        // A consistent, compact copy of the live database (WAL included).
        this.db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
        const data = gzipSync(readFileSync(tmp));
        await this.store.save(data, Date.now());
        this.savedChanges = changes;
        this.log.info(`database backed up (${Math.max(1, Math.round(data.length / 1024))} KB)`);
      } finally {
        rmSync(tmp, { force: true });
      }
    })()
      .catch((e) => this.log.warn(`database backup failed, will retry: ${(e as Error).message}`))
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.inflight) await this.inflight;
    await this.flush();
  }
}
