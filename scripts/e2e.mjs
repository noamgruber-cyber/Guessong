/**
 * End-to-end check: builds nothing, expects `npm run build` first.
 * Starts the server in mock mode, plays a full round in Chromium at phone
 * size, verifies the clip/slice mechanics through Web Audio instrumentation,
 * and writes screenshots to ./e2e-screenshots (or $E2E_OUT).
 *
 *   npm run build && npm run test:e2e
 *
 * Requires Playwright with Chromium (npx playwright install chromium).
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { DatabaseSync } = require('node:sqlite');

const ROOT = resolve(import.meta.dirname, '..');
const PORT = Number(process.env.E2E_PORT ?? 8899);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = process.env.E2E_OUT ?? join(ROOT, 'e2e-screenshots');
const DB = join(tmpdir(), `guessong-e2e-${process.pid}.sqlite`);
const SCALE = Number(process.env.E2E_SCALE ?? 2);

mkdirSync(OUT, { recursive: true });
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/dist/index.js'], {
  cwd: ROOT,
  env: { ...process.env, MUSIC_PROVIDER: 'mock', PORT: String(PORT), DATABASE_PATH: DB, PUBLIC_URL: BASE, NODE_ENV: 'test' },
  stdio: ['ignore', 'pipe', 'inherit'],
});

const fail = (msg) => {
  throw new Error(msg);
};
const assert = (cond, msg) => cond || fail(`Assertion failed: ${msg}`);

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/api/v1/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  fail('server did not start');
}

/** Test-only peek at the answer for the current song (straight from the DB). */
function currentAnswer(roundId) {
  const db = new DatabaseSync(DB, { readOnly: true });
  const row = db
    .prepare(
      `SELECT t.title, t.artists FROM round_songs rs JOIN tracks t ON t.id = rs.track_id
       WHERE rs.round_id = ? AND rs.position IS NOT NULL AND rs.status IN ('pending','active') ORDER BY rs.position LIMIT 1`,
    )
    .get(roundId);
  db.close();
  return row ? { title: row.title, artist: JSON.parse(row.artists)[0] } : null;
}

const results = [];
const step = (name) => results.push(name) && console.log(`  ✓ ${name}`);

async function main() {
  await waitForServer();
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: SCALE,
    isMobile: true,
    hasTouch: true,
  });
  // Record every Web Audio slice the game schedules.
  await context.addInitScript(() => {
    window.__slices = [];
    const orig = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (when, offset, duration) {
      if (this.buffer && this.buffer.length > 1) window.__slices.push({ offset: offset ?? 0, duration: duration ?? null });
      return orig.apply(this, arguments);
    };
  });
  context.setDefaultTimeout(15_000);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const shot = (name) => page.screenshot({ path: join(OUT, `${name}.png`) });
  try {
    await run(page, shot, browser, errors);
  } catch (e) {
    await page.screenshot({ path: join(OUT, 'failure.png') }).catch(() => {});
    throw e;
  }
  await browser.close();
}

async function run(page, shot, browser, errors) {
  const slices = () => page.evaluate(() => window.__slices.splice(0));

  await page.goto(BASE);
  await page.getByRole('button', { name: /'80s Hits/ }).first().waitFor();
  await page.waitForTimeout(400);
  await shot('1-discovery');
  step('discovery grid renders with language chips');

  await page.getByRole('button', { name: /'80s Hits/ }).first().click();
  await page.getByText('No score yet').waitFor();
  await page.waitForTimeout(450);
  await shot('2-playlist-sheet');
  step('pre-game sheet shows status and actions');

  // Hold the first song's audio briefly so the loading screen can be captured.
  let held = false;
  await page.route('**/songs/*/audio', async (route) => {
    if (!held) {
      held = true;
      await new Promise((r) => setTimeout(r, 1500));
    }
    await route.continue();
  });
  await page.getByRole('button', { name: /^Play$/ }).click();
  await page.waitForURL(/\/play\//);
  await page.locator('.loading-screen').waitFor();
  await page.waitForTimeout(500);
  await shot('3-loading');
  const roundId = page.url().split('/play/')[1];
  await page.getByText('Next guess').waitFor();
  await page.waitForTimeout(900);
  let s = await slices();
  assert(s.length >= 1 && s[0].offset === 0 && Math.abs(s[0].duration - 0.5) < 1e-6, `first slice 0→0.5s, got ${JSON.stringify(s)}`);
  step('attempt 1 auto-plays 0 → 0.5s');
  await shot('4-game');

  await page.getByRole('button', { name: 'Skip +1s' }).click();
  await page.locator('.attempt.skipped').first().waitFor();
  await page.waitForTimeout(250);
  await shot('4b-game-playing-after-skip');
  await page.waitForTimeout(1000);
  s = await slices();
  assert(s.length === 1 && Math.abs(s[0].offset - 0.5) < 1e-6 && Math.abs(s[0].duration - 1.0) < 1e-6, `skip plays 0.5→1.5s only, got ${JSON.stringify(s)}`);
  step('skip plays only the newly unlocked slice (0.5 → 1.5s)');

  await page.getByRole('button', { name: /^Play 1.5s clip/ }).click();
  await page.waitForTimeout(1700);
  s = await slices();
  assert(s.length === 1 && s[0].offset === 0 && Math.abs(s[0].duration - 1.5) < 1e-6, `▶ replays 0→1.5s, got ${JSON.stringify(s)}`);
  step('▶ replays the whole unlocked clip from 0');

  await page.getByRole('button', { name: /Artist hint/ }).click();
  await page.locator('.hint-reveals').waitFor();
  step('artist hint reveals the artist');

  // Wrong guess: a decoy cover.
  await page.getByRole('combobox').fill('come on eileen');
  await page.getByRole('option').first().waitFor();
  await shot('4c-autocomplete');
  const answer0 = currentAnswer(roundId);
  const decoy = answer0.title === 'Come On Eileen' ? 'Hurt' : 'come on eileen';
  await page.getByRole('combobox').fill(decoy);
  await page.getByRole('option').first().waitFor();
  await page.getByRole('option').first().click();
  await page.getByRole('button', { name: 'Submit my guess' }).click();
  await page.locator('.attempt.wrong').first().waitFor();
  await shot('4d-wrong-guess');
  step('wrong guess shows a red row and advances the attempt');

  // Play the round: answer correctly on some songs, reveal others.
  for (let pos = 1; pos <= 10; pos++) {
    await page.getByText('Next guess').waitFor({ timeout: 15_000 });
    const ans = currentAnswer(roundId);
    console.log(`    song ${pos}: ${ans.title} — ${ans.artist}`);
    if (pos % 4 === 0) {
      for (let i = 0; i < 6; i++) {
        const btn = page.locator('.skip-btn');
        const label = await btn.innerText();
        await btn.click();
        if (label.includes('Reveal')) break;
        await page.waitForTimeout(120);
      }
    } else {
      await page.getByRole('combobox').fill(`${ans.title} ${ans.artist}`.slice(0, 60));
      const opt = page.getByRole('option').filter({ hasText: ans.title }).first();
      await opt.waitFor();
      await opt.click();
      await page.getByRole('button', { name: 'Submit my guess' }).click();
    }
    await page.locator('.result-card').waitFor();
    if (pos === 1) {
      await page.waitForTimeout(350);
      await shot('5-result-correct');
    }
    if (pos === 4) {
      await page.waitForTimeout(350);
      await shot('5b-result-missed');
    }
    const btn = page.getByRole('button', { name: pos === 10 ? 'See results' : 'Continue' });
    await btn.click();
  }
  step('played all 10 songs through result cards');

  await page.getByText('out of 1000').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(300);
  await shot('6-summary');
  const summaryText = await page.locator('.summary-hero').innerText();
  assert(/First score set/.test(summaryText), 'summary shows first score badge');
  step('round summary with score, rank and recap');

  await page.getByRole('button', { name: /Leaderboard/ }).click();
  await page.getByText('Best single round').waitFor();
  await page.waitForTimeout(200);
  await shot('7-leaderboard');
  step('leaderboard lists the player');

  // Back to discovery: personal best is shown.
  await page.goto(BASE);
  await page.getByText('Beat your record').first().waitFor();
  await shot('1b-discovery-after-play');
  step('discovery shows recent playlist and personal best');

  // Challenge link from the summary flow.
  const res = await page.evaluate(async (rid) => (await fetch(`/api/v1/rounds/${rid}/challenge`, { method: 'POST' })).json(), roundId);
  const friend = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: SCALE, isMobile: true, hasTouch: true });
  const fp = await friend.newPage();
  await fp.goto(res.url);
  await fp.getByText('challenged you').waitFor();
  await fp.waitForTimeout(300);
  await fp.screenshot({ path: join(OUT, '8-challenge.png') });
  await fp.getByRole('button', { name: 'Accept challenge' }).click();
  await fp.waitForURL(/\/play\//);
  await fp.getByText('Next guess').waitFor({ timeout: 15_000 });
  step('a friend can open the challenge link and start the same round');

  assert(errors.length === 0, `no page errors, got: ${errors.join(' | ')}`);
  step('no console or page errors');
}

main()
  .then(() => {
    console.log(`\nE2E passed (${results.length} checks). Screenshots in ${OUT}`);
  })
  .catch((e) => {
    console.error(`\nE2E FAILED: ${e.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    server.kill();
    for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
  });
