/**
 * End-to-end check of Spotify-library games (expects `npm run build` first).
 *
 * Starts a fake Spotify + Deezer on one local port, starts the server in mock
 * mode pointed at it (SPOTIFY_API_BASE / SPOTIFY_ACCOUNTS_BASE / DEEZER_API_BASE),
 * then in Chromium at phone size: connects Spotify, builds a game from Liked
 * Songs, plays a song with a Deezer-style preview, guesses it right, checks the
 * game is listed privately, and checks the "not on the invite list" message.
 *
 *   npm run build && node scripts/e2e-library.mjs
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { DatabaseSync } = require('node:sqlite');

const ROOT = resolve(import.meta.dirname, '..');
const PORT = Number(process.env.E2E_PORT ?? 8897);
const FAKE_PORT = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}`;
const FAKE = `http://127.0.0.1:${FAKE_PORT}`;
const OUT = process.env.E2E_OUT ?? join(ROOT, 'e2e-screenshots');
const DB = join(tmpdir(), `guessong-e2e-lib-${process.pid}.sqlite`);
const SCALE = Number(process.env.E2E_SCALE ?? 2);

// ---- fake upstreams ------------------------------------------------------------

const ARTISTS = {
  weeknd: { name: 'The Weeknd', genres: ['canadian pop', 'pop'] },
  dua: { name: 'Dua Lipa', genres: ['dance pop', 'uk pop'] },
  arctic: { name: 'Arctic Monkeys', genres: ['garage rock', 'modern rock'] },
  kendrick: { name: 'Kendrick Lamar', genres: ['hip hop', 'west coast rap'] },
  omer: { name: 'Omer Adam', genres: ['israeli pop', 'mizrahi'] },
  noa: { name: 'Noa Kirel', genres: ['israeli pop'] },
  eden: { name: 'Eden Ben Zaken', genres: ['mizrahi'] },
  linkin: { name: 'Linkin Park', genres: ['alternative metal', 'nu metal'] },
  coldplay: { name: 'Coldplay', genres: ['permanent wave', 'pop'] },
  eminem: { name: 'Eminem', genres: ['detroit hip hop', 'rap'] },
};
const SONGS = [
  ['Blinding Lights', 'weeknd'], ['Save Your Tears', 'weeknd'], ['Starboy', 'weeknd'], ['The Hills', 'weeknd'],
  ['Levitating', 'dua'], ["Don't Start Now", 'dua'], ['New Rules', 'dua'],
  ['Do I Wanna Know?', 'arctic'], ['R U Mine?', 'arctic'], ['505', 'arctic'], ['Fluorescent Adolescent', 'arctic'],
  ['HUMBLE.', 'kendrick'], ['DNA.', 'kendrick'], ['Not Like Us', 'kendrick'], ['Alright', 'kendrick'],
  ['תל אביב', 'omer'], ['שני משוגעים', 'omer'], ['מלכת הדור', 'omer'],
  ['Unicorn', 'noa'], ['מיליון דולר', 'noa'],
  ['חמסה', 'eden'], ['חיים שלי', 'eden'],
  ['In the End', 'linkin'], ['Numb', 'linkin'], ['Faint', 'linkin'],
  ['Yellow', 'coldplay'], ['Viva La Vida', 'coldplay'], ['The Scientist', 'coldplay'],
  ['Lose Yourself', 'eminem'], ['Without Me', 'eminem'], ['Mockingbird', 'eminem'],
  // Deeper cuts so each genre has enough songs for its own game.
  ...Object.keys(ARTISTS).flatMap((a) => Array.from({ length: 10 }, (_, k) => [`${ARTISTS[a].name} Deep Cut ${k + 1}`, a])),
].map(([title, artist], i) => ({ i, title, artist, spotifyId: `sp${String(i).padStart(3, '0')}`, isrc: `TEST${String(i).padStart(7, '0')}` }));
const NO_PREVIEW = 9; // "505" isn't on Deezer

function spTrack(s) {
  return {
    id: s.spotifyId,
    name: s.title,
    uri: `spotify:track:${s.spotifyId}`,
    type: 'track',
    duration_ms: 210_000,
    artists: [{ id: s.artist, name: ARTISTS[s.artist].name }],
    album: { name: `${s.title} (Single)`, images: [{ url: `${FAKE}/art/${s.i}.svg`, width: 640 }] },
    external_ids: { isrc: s.isrc },
    external_urls: { spotify: `https://open.spotify.com/track/${s.spotifyId}` },
  };
}
function dzTrack(s) {
  return {
    id: 7000 + s.i,
    readable: true,
    title: s.title,
    isrc: s.isrc,
    link: `https://www.deezer.com/track/${7000 + s.i}`,
    duration: 210,
    preview: `${FAKE}/preview/${s.i}.wav`,
    artist: { name: ARTISTS[s.artist].name },
    album: { title: `${s.title} (Single)`, cover_xl: `${FAKE}/art/${s.i}.svg` },
  };
}

/** 30 s, 8 kHz, mono: a short melody unique to each song. */
function wav(i) {
  const rate = 8000;
  const n = rate * 30;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  const notes = [0, 4, 7, 12, 7, 4].map((x) => 220 * 2 ** ((x + (i % 12)) / 12));
  for (let k = 0; k < n; k++) {
    const f = notes[Math.floor(k / (rate / 4)) % notes.length];
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * f * k) / rate) * 9000), 44 + k * 2);
  }
  return buf;
}

let blockMe = false;
const fake = createServer((req, res) => {
  const url = new URL(req.url, FAKE);
  const p = url.pathname;
  const json = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  // Spotify accounts
  if (p === '/authorize') {
    const back = new URL(url.searchParams.get('redirect_uri'));
    back.searchParams.set('code', 'fakecode');
    back.searchParams.set('state', url.searchParams.get('state'));
    res.writeHead(302, { location: back.href });
    return res.end();
  }
  if (p === '/api/token') return json(200, { access_token: 'tok', refresh_token: 'ref', expires_in: 3600 });
  // Spotify Web API
  if (p === '/v1/me') return blockMe ? json(403, { error: { status: 403, message: 'User not registered in the Developer Dashboard' } }) : json(200, { id: 'dana', display_name: 'Dana' });
  if (p === '/v1/me/tracks') {
    const limit = Number(url.searchParams.get('limit'));
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const next = offset + limit < SONGS.length ? `${FAKE}/v1/me/tracks?offset=${offset + limit}&limit=${limit}` : null;
    return json(200, { total: SONGS.length, items: SONGS.slice(offset, offset + limit).map((s) => ({ track: spTrack(s) })), next });
  }
  if (p === '/v1/me/top/tracks') return json(200, { items: SONGS.slice(0, 20).map(spTrack) });
  if (p === '/v1/me/top/artists') return json(200, { items: ['weeknd', 'omer', 'arctic'].map((id) => ({ id, ...ARTISTS[id] })) });
  const artist = p.match(/^\/v1\/artists\/(\w+)$/);
  if (artist && ARTISTS[artist[1]]) return json(200, { id: artist[1], ...ARTISTS[artist[1]] });
  if (p === '/v1/me/playlists') {
    return json(200, {
      items: [
        { id: 'road1', name: 'Road Trip', owner: { id: 'dana' }, collaborative: false, items: { total: 20 }, images: [{ url: `${FAKE}/art/3.svg` }] },
        { id: 'tth1', name: "Today's Top Hits", owner: { id: 'spotify' }, collaborative: false, items: { total: 50 }, images: [{ url: `${FAKE}/art/8.svg` }] },
      ],
      next: null,
    });
  }
  if (p === '/v1/playlists/road1') return json(200, { id: 'road1', name: 'Road Trip', images: [{ url: `${FAKE}/art/3.svg`, width: 300 }] });
  if (p === '/v1/playlists/road1/items') return json(200, { items: SONGS.slice(5, 25).map((s) => ({ item: spTrack(s) })), next: null });
  // Deezer
  const isrc = p.match(/^\/track\/isrc:(\w+)$/);
  if (isrc) {
    const s = SONGS.find((x) => x.isrc === isrc[1]);
    return s && s.i !== NO_PREVIEW ? json(200, dzTrack(s)) : json(200, { error: { code: 800, message: 'no data' } });
  }
  const byId = p.match(/^\/track\/(\d+)$/);
  if (byId) {
    const s = SONGS[Number(byId[1]) - 7000];
    return s ? json(200, dzTrack(s)) : json(200, { error: { code: 800, message: 'no data' } });
  }
  if (p === '/search') {
    const q = (url.searchParams.get('q') ?? '').toLowerCase().replace(/artist:|track:|"/g, ' ');
    const words = q.split(/\s+/).filter(Boolean);
    const hits = SONGS.filter((s) => s.i !== NO_PREVIEW && words.every((w) => `${s.title} ${ARTISTS[s.artist].name}`.toLowerCase().includes(w)));
    return json(200, { data: hits.map(dzTrack), total: hits.length });
  }
  const prev = p.match(/^\/preview\/(\d+)\.wav$/);
  if (prev) {
    const body = wav(Number(prev[1]));
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': body.length });
    return res.end(body);
  }
  const art = p.match(/^\/art\/(\d+)\.svg$/);
  if (art) {
    const hue = (Number(art[1]) * 47) % 360;
    res.writeHead(200, { 'content-type': 'image/svg+xml' });
    return res.end(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},70%,55%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},70%,35%)"/></linearGradient></defs><rect width="100" height="100" fill="url(#g)"/><circle cx="50" cy="50" r="22" fill="none" stroke="rgba(255,255,255,.5)" stroke-width="3"/></svg>`,
    );
  }
  json(404, { error: { status: 404, message: `fake: unhandled ${p}` } });
});

// ---- run ---------------------------------------------------------------------------

const fail = (msg) => {
  throw new Error(msg);
};
const assert = (cond, msg) => cond || fail(`Assertion failed: ${msg}`);
const step = (name) => console.log(`  ✓ ${name}`);

function currentAnswer(roundId) {
  const db = new DatabaseSync(DB, { readOnly: true });
  const row = db
    .prepare(
      `SELECT t.title FROM round_songs rs JOIN tracks t ON t.id = rs.track_id
       WHERE rs.round_id = ? AND rs.position IS NOT NULL AND rs.status IN ('pending','active') ORDER BY rs.position LIMIT 1`,
    )
    .get(roundId);
  db.close();
  return row?.title ?? null;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  await new Promise((r) => fake.listen(FAKE_PORT, '127.0.0.1', r));
  const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/dist/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      MUSIC_PROVIDER: 'mock',
      PORT: String(PORT),
      DATABASE_PATH: DB,
      PUBLIC_URL: BASE,
      NODE_ENV: 'test',
      SPOTIFY_CLIENT_ID: 'cid',
      SPOTIFY_CLIENT_SECRET: 'secret',
      SPOTIFY_API_BASE: `${FAKE}/v1`,
      SPOTIFY_ACCOUNTS_BASE: FAKE,
      DEEZER_API_BASE: FAKE,
      NO_PROXY: '127.0.0.1,localhost',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  let browser;
  try {
    for (let i = 0; i < 100; i++) {
      if (await fetch(`${BASE}/api/v1/health`).then((r) => r.ok).catch(() => false)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: SCALE, isMobile: true, hasTouch: true });
    context.setDefaultTimeout(15_000);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const shot = (name) => page.screenshot({ path: join(OUT, `${name}.png`) });

    try {
      await page.goto(BASE);
      await page.getByText('Play your own music').waitFor();
      await page.waitForTimeout(300);
      await shot('lib-1-connect');
      step('discovery offers "Connect Spotify"');

      await page.getByRole('link', { name: 'Connect Spotify' }).click();
      await page.getByRole('heading', { name: 'New game from Spotify' }).waitFor();
      await page.getByRole('button', { name: /Liked Songs/ }).waitFor();
      await page.locator('.lib-genres .chip').first().waitFor();
      const genres = await page.locator('.lib-genres .chip').allInnerTexts();
      assert(genres.some((g) => g.startsWith('Mizrahi')) && genres.some((g) => g.startsWith('Hip-Hop')), `genres: ${genres}`);
      assert(await page.getByRole('button', { name: /Today's Top Hits/ }).isDisabled(), 'unowned playlist is disabled');
      await page.waitForTimeout(300);
      await shot('lib-2-sheet');
      step(`connected; library sheet shows Liked/Top, genres (${genres.length}) and playlists`);

      await page.getByRole('button', { name: /Liked Songs/ }).click();
      await page.getByText('From your Spotify · previews by Deezer').waitFor({ timeout: 30_000 });
      await page.waitForTimeout(400);
      await shot('lib-3-playlist');
      step('built a game from Liked Songs and opened it');

      await page.getByRole('button', { name: /^Play$/ }).click();
      await page.waitForURL(/\/play\//);
      await page.getByText('Next guess').waitFor({ timeout: 20_000 });
      await page.getByText('Powered by Deezer').waitFor();
      const roundId = page.url().split('/play/')[1];
      const answer = currentAnswer(roundId);
      assert(answer, 'answer found');
      await page.getByRole('combobox').fill(answer.slice(0, 6));
      const opt = page.getByRole('option').filter({ hasText: answer }).first();
      await opt.waitFor();
      await page.waitForTimeout(250);
      await shot('lib-4-search');
      await opt.click();
      await page.getByRole('button', { name: 'Submit my guess' }).click();
      await page.locator('.result-card').waitFor();
      await page.getByRole('link', { name: 'Open in Spotify' }).waitFor();
      await page.waitForTimeout(500);
      await shot('lib-5-result');
      step(`played "${answer}" from a Deezer preview, guessed it, result links to Spotify`);

      await page.goto(BASE);
      await page.getByText('Your Spotify games').waitFor();
      await page.locator('.lib-card', { hasText: 'Liked Songs' }).waitFor();
      await page.waitForTimeout(300);
      await shot('lib-6-discovery');
      step('discovery lists the game under "Your Spotify games"');
      assert(errors.length === 0, `page errors: ${errors.join(' | ')}`);
    } catch (e) {
      await shot('lib-failure').catch(() => {});
      throw e;
    }

    // A friend who isn't on the app's Spotify user list.
    blockMe = true;
    const other = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    const p2 = await other.newPage();
    await p2.goto(BASE);
    await p2.getByRole('link', { name: 'Connect Spotify' }).click();
    await p2.getByText("isn't on Guessong's invite list").waitFor();
    step('explains when a Spotify account is not on the invite list');
    console.log('\nLibrary e2e passed.');
  } finally {
    await browser?.close();
    server.kill();
    fake.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
