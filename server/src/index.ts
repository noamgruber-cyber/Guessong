import { buildApp } from './app';
import { loadConfig } from './config';
import { openDb } from './db';
import { loadSeedPlaylists } from './seeds';

async function main() {
  const config = loadConfig();
  const db = openDb(config.dbPath);
  const seeds = loadSeedPlaylists(config.dataDir);
  const { app, ctx } = await buildApp({ config, db, seeds, logger: true });

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

  const shutdown = async () => {
    await app.close();
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
