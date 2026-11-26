import { mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DatabaseBackup, restoreDatabase, type BackupStore } from '../src/backup';
import { openDb, run } from '../src/db';

class MemoryStore implements BackupStore {
  saved: { data: Buffer; savedAt: number } | null = null;
  saves = 0;
  failLoad = false;
  async load() {
    if (this.failLoad) throw new Error('connection refused');
    return this.saved;
  }
  async save(data: Buffer, savedAt: number) {
    this.saves++;
    this.saved = { data, savedAt };
  }
  async close() {}
}

const dir = mkdtempSync(join(tmpdir(), 'guessong-backup-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const silent = { info() {}, warn() {} };

function addUser(db: ReturnType<typeof openDb>, id: string) {
  run(db, "INSERT INTO users (id, display_name, avatar_color, created_at) VALUES (?, ?, '#000', 0)", id, `Player ${id}`);
}

describe('database backup', () => {
  it('snapshots only when something changed, and restores into a fresh disk', async () => {
    const store = new MemoryStore();
    const path = join(dir, 'a.sqlite');
    const db = openDb(path);
    const backup = new DatabaseBackup(db, path, store, silent);
    backup.start();

    await backup.flush();
    expect(store.saves).toBe(0); // nothing changed since start

    addUser(db, 'u1');
    await backup.flush();
    expect(store.saves).toBe(1);
    await backup.flush();
    expect(store.saves).toBe(1);

    addUser(db, 'u2');
    await backup.stop(); // final snapshot on shutdown
    expect(store.saves).toBe(2);
    db.close();

    // A new machine with an empty disk.
    const fresh = join(dir, 'b.sqlite');
    expect(await restoreDatabase(store, fresh)).toBe('restored');
    const restored = openDb(fresh);
    const ids = (restored.prepare('SELECT id FROM users ORDER BY id').all() as { id: string }[]).map((r) => r.id);
    expect(ids).toEqual(['u1', 'u2']);
    restored.close();
  });

  it('starts fresh when there is no saved copy yet', async () => {
    expect(await restoreDatabase(new MemoryStore(), join(dir, 'c.sqlite'))).toBe('no-backup');
  });

  it('keeps a local database that is newer than the saved copy', async () => {
    const store = new MemoryStore();
    const path = join(dir, 'd.sqlite');
    const db = openDb(path);
    const backup = new DatabaseBackup(db, path, store, silent);
    backup.start();
    addUser(db, 'u1');
    await backup.flush();
    db.close();
    const later = new Date(store.saved!.savedAt + 60_000);
    utimesSync(path, later, later);
    expect(await restoreDatabase(store, path)).toBe('local-is-newer');
  });

  it('fails loudly when the saved copy cannot be read', async () => {
    const store = new MemoryStore();
    store.failLoad = true;
    await expect(restoreDatabase(store, join(dir, 'e.sqlite'))).rejects.toThrow('connection refused');
  });

  it('keeps going when a save fails, and retries on the next change check', async () => {
    const store = new MemoryStore();
    const path = join(dir, 'f.sqlite');
    const db = openDb(path);
    const warnings: string[] = [];
    const backup = new DatabaseBackup(db, path, store, { info() {}, warn: (m) => warnings.push(m) });
    backup.start();
    addUser(db, 'u1');
    const realSave = store.save.bind(store);
    store.save = async () => {
      throw new Error('network down');
    };
    await backup.flush();
    expect(warnings[0]).toContain('network down');
    store.save = realSave;
    await backup.flush();
    expect(store.saves).toBe(1);
    await backup.stop();
    db.close();
  });
});
