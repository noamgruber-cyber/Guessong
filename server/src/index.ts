import { buildApp } from './app';
import { DatabaseBackup, PostgresBackupStore, restoreDatabase } from './backup';
import { loadConfig } from './config';
import { openDb } from './db';
import { sleep } from './lib/util';
import { loadSeedPlaylists } from './seeds';

async function main() {
  const config = loadConfig();

  // Bring back the saved copy of the database before opening it (see backup.ts).
  const store = config.backupDatabaseUrl && config.dbPath !== ':memory:' ? new PostgresBackupStore(config.backupDatabaseUrl) : null;
  let backupsOn = false;
  if (store) {
    for (let attempt = 1; attempt <= 4 && !backupsOn; attempt++) {
      try {
        const result = await restoreDatabase(store, config.dbPath);
        console.log(`  ✓ Database backup: ${result === 'restored' ? 'restored the saved copy' : result === 'no-backup' ? 'no saved copy yet, starting fresh' : 'local copy is newer, keeping it'}`);
        backupsOn = true;
      } catch (e) {
        console.error(`  ✗ Couldn't read the database backup (attempt ${attempt}/4): ${(e as Error).message}`);
        if (attempt < 4) await sleep(2000 * attempt);
      }
    }
    // Never overwrite a good backup with an empty database we couldn't restore into.
    if (!backupsOn) console.error('  ✗ Backups are OFF for this run so the saved copy is not overwritten. Check BACKUP_DATABASE_URL.');
  }

  const db = openDb(config.dbPath);
  const seeds = loadSeedPlaylists(config.dataDir);
  const { app, ctx } = await buildApp({ config, db, seeds, logger: true });
  const backup = store && backupsOn ? new DatabaseBackup(db, config.dbPath, store, app.log) : null;
  backup?.start();

  await app.listen({ port: config.port, host: config.host });
  app.log.info(`Guessong (${config.provider}) listening on ${config.publicUrl}`);
  console.log(`\n  ▶ Guessong running in ${config.provider} mode → ${config.publicUrl}\n`);

  if (config.ingestOnStart) {
    // Resolve curated playlists in the background; each becomes playable as soon as it's ready.
    ctx.catalog
      .ingestSeeds(seeds, { log: (m) => app.log.info(m) })
      .then((reports) => {
        if (reports.length) console.log(`  ✓ Playlists ingested: ${reports.map((r) => `${r.playlistId} (${r.resolved})`).join(', ')}`);
      })
      .catch((e) => app.log.error(e, 'playlist ingestion failed'));
  }

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
    // Last snapshot before the host stops (or wipes) the machine.
    await backup?.stop().catch(() => {});
    await store?.close().catch(() => {});
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
