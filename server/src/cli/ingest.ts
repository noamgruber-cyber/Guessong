/**
 * Resolve the curated seed playlists against the configured provider.
 *
 *   npm run ingest                    # resolve anything new or changed
 *   npm run ingest -- --force         # re-resolve everything
 *   npm run ingest -- --only 80s-hits # one playlist
 *   npm run ingest -- --write-pins    # (Apple) save resolved ids to data/pins/apple.json
 */
import { loadConfig } from '../config';
import { openDb } from '../db';
import { createProviders } from '../providers';
import { loadPins, loadSeedPlaylists, savePins } from '../seeds';
import { Catalog } from '../services/catalog';

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const writePins = args.includes('--write-pins');
  const onlyIdx = args.indexOf('--only');
  const only = onlyIdx >= 0 ? args[onlyIdx + 1]?.split(',') : null;

  const config = loadConfig();
  const db = openDb(config.dbPath);
  const seeds = loadSeedPlaylists(config.dataDir);
  const providers = createProviders(config, seeds);
  const catalog = new Catalog(db, providers.music, config);

  const selected = only ? seeds.filter((s) => only.includes(s.id)) : seeds;
  console.log(`Ingesting ${selected.length} playlist(s) with provider "${config.provider}"…`);
  const reports = [];
  for (const seed of selected) {
    const r = await catalog.ingestSeedPlaylist(seed, seeds.indexOf(seed), { force, log: (m) => console.log(m) });
    if (r) reports.push(r);
    else console.log(`${seed.id}: up to date`);
  }

  if (writePins && config.provider !== 'mock') {
    const pins = loadPins(config.dataDir, config.provider);
    for (const r of reports) pins[r.playlistId] = { ...(pins[r.playlistId] ?? {}), ...r.pins };
    savePins(config.dataDir, config.provider, pins);
    console.log(`Saved pins to data/pins/${config.provider}.json`);
  }

  const unresolved = reports.flatMap((r) => r.unresolved.map((u) => `${r.playlistId}: ${u.title} — ${u.artist}`));
  if (unresolved.length) {
    console.log(`\n${unresolved.length} seed(s) could not be matched:`);
    for (const u of unresolved) console.log(`  - ${u}`);
  }
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
