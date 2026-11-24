import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_HINT_RULES,
  DEFAULT_MIN_POINTS_WITH_HINTS,
  BASE_POINTS,
  type HintRules,
  type ProviderId,
  type ScoringRules,
} from '@guessong/shared';

const here = dirname(fileURLToPath(import.meta.url));
/** server/ directory, both from src/ (tsx) and dist/ (bundled). */
export const SERVER_DIR = resolve(here, '..');
export const REPO_DIR = resolve(SERVER_DIR, '..');

export interface Config {
  isProd: boolean;
  port: number;
  host: string;
  publicUrl: string;
  provider: ProviderId;
  dbPath: string;
  dataDir: string;
  sessionSecret: string;
  secureCookies: boolean;
  ingestOnStart: boolean;
  webDistDir: string | null;
  scoring: ScoringRules;
  apple: {
    searchPerMinute: number;
    proxyAudio: boolean;
  };
  spotify: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    market: string;
    /** Extra ms added to Connect-mode clips to make up for device start-up latency. */
    connectStartCompMs: number;
  };
}

function loadDotEnv() {
  for (const p of [resolve(REPO_DIR, '.env'), resolve(SERVER_DIR, '.env')]) {
    if (existsSync(p)) {
      try {
        process.loadEnvFile(p);
      } catch {
        /* ignore malformed .env */
      }
    }
  }
}

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function int(v: string | undefined, fallback: number): number {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseHintRules(env: NodeJS.ProcessEnv): HintRules {
  const rules: HintRules = structuredClone(DEFAULT_HINT_RULES);
  if (env.HINT_PENALTIES) {
    try {
      const parsed = JSON.parse(env.HINT_PENALTIES) as Partial<Record<keyof HintRules, number>>;
      for (const key of Object.keys(rules) as (keyof HintRules)[]) {
        if (typeof parsed[key] === 'number') rules[key].penalty = parsed[key]!;
      }
    } catch {
      throw new Error('HINT_PENALTIES must be JSON like {"artist":75,"song":100,"cover":85}');
    }
  }
  if (env.SONG_HINT_UNLOCK_ATTEMPT) rules.song.unlockAttempt = int(env.SONG_HINT_UNLOCK_ATTEMPT, rules.song.unlockAttempt);
  return rules;
}

export function loadConfig(overrides: Partial<Config> = {}, env: NodeJS.ProcessEnv = process.env): Config {
  if (env === process.env) loadDotEnv();
  const isProd = env.NODE_ENV === 'production';
  const port = int(env.PORT, 8787);
  const publicUrl = (env.PUBLIC_URL ?? `http://127.0.0.1:${port}`).replace(/\/$/, '');
  const provider = (env.MUSIC_PROVIDER ?? 'apple') as ProviderId;
  if (!['apple', 'spotify', 'mock'].includes(provider)) {
    throw new Error(`MUSIC_PROVIDER must be apple, spotify or mock (got "${provider}")`);
  }

  let sessionSecret = env.SESSION_SECRET ?? '';
  if (!sessionSecret) {
    if (isProd) throw new Error('SESSION_SECRET is required in production (32+ random characters).');
    sessionSecret = 'guessong-dev-secret-change-me-0123456789';
  }

  const dataDir = resolve(SERVER_DIR, 'data');
  const webDist = resolve(REPO_DIR, 'web', 'dist');

  const config: Config = {
    isProd,
    port,
    host: env.HOST ?? '0.0.0.0',
    publicUrl,
    provider,
    dbPath: env.DATABASE_PATH ? resolve(env.DATABASE_PATH) : resolve(dataDir, `guessong-${provider}.sqlite`),
    dataDir,
    sessionSecret,
    secureCookies: publicUrl.startsWith('https://'),
    ingestOnStart: bool(env.INGEST_ON_START, true),
    webDistDir: existsSync(resolve(webDist, 'index.html')) ? webDist : null,
    scoring: {
      basePoints: BASE_POINTS,
      hints: parseHintRules(env),
      minPointsWithHints: int(env.MIN_POINTS_WITH_HINTS, DEFAULT_MIN_POINTS_WITH_HINTS),
    },
    apple: {
      searchPerMinute: int(env.APPLE_SEARCH_PER_MINUTE, 20),
      proxyAudio: bool(env.AUDIO_PROXY, true),
    },
    spotify: {
      clientId: env.SPOTIFY_CLIENT_ID ?? '',
      clientSecret: env.SPOTIFY_CLIENT_SECRET ?? '',
      redirectUri: env.SPOTIFY_REDIRECT_URI ?? `${publicUrl}/api/v1/auth/spotify/callback`,
      market: env.SPOTIFY_MARKET ?? 'US',
      connectStartCompMs: int(env.SPOTIFY_CONNECT_COMP_MS, 0),
    },
    ...overrides,
  };

  if (config.provider === 'spotify' && (!config.spotify.clientId || !config.spotify.clientSecret)) {
    throw new Error('MUSIC_PROVIDER=spotify needs SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET (see README).');
  }
  return config;
}
