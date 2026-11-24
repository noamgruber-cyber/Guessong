import { normalizeArtist, normalizeTitle } from '@guessong/shared';
import { sha1 } from '../lib/util';
import type { SeedPlaylist } from '../seeds';
import type { MusicProvider, ProviderTrack, SeedTrack } from './types';

/**
 * Offline demo provider: builds a catalog from the seed playlists (plus a few
 * decoy covers), serves synthesized 30s "previews" and generated cover art.
 * Used for tests, screenshots and trying the game without network access.
 */

export function mockTrackId(title: string, artist: string): string {
  return `m${sha1(`${normalizeTitle(title)}|${normalizeArtist(artist)}`).slice(0, 12)}`;
}

const DECOYS: [string, string][] = [
  ['Come On Eileen', "Pickin' On Series"],
  ['Come On Eileen (Single Edit)', 'Dexys Midnight Runners & Kevin Rowland'],
  ['Take On Me', 'Weezer'],
  ['Africa', 'Weezer'],
  ['Smells Like Teen Spirit', 'Tori Amos'],
  ['Hallelujah', 'Jeff Buckley'],
  ['Hallelujah', 'Leonard Cohen'],
  ['Hurt', 'Johnny Cash'],
  ['Valerie', 'Mark Ronson & Amy Winehouse'],
  ['Tainted Love', 'Marilyn Manson'],
];

export class MockProvider implements MusicProvider {
  readonly id = 'mock' as const;
  readonly label = 'Demo catalog';
  readonly playback = 'preview' as const;
  private tracks = new Map<string, ProviderTrack>();

  constructor(seedPlaylists: SeedPlaylist[]) {
    const add = (title: string, artist: string, album: string) => {
      const id = mockTrackId(title, artist);
      if (this.tracks.has(id)) return;
      this.tracks.set(id, {
        id,
        title,
        artists: [artist],
        album,
        artworkUrl: `/api/v1/mock/art/${id}.svg`,
        previewUrl: `/api/v1/mock/audio/${id}.wav`,
        isrc: null,
        durationMs: 180_000 + (parseInt(id.slice(1, 5), 16) % 120_000),
        uri: null,
        externalUrl: null,
      });
    };
    for (const p of seedPlaylists) for (const t of p.tracks) add(t.title, t.artist, `${t.artist} — Greatest Hits`);
    for (const [title, artist] of DECOYS) add(title, artist, 'Covers & Tributes');
  }

  isThrottled() {
    return false;
  }

  async search(query: string, opts: { storefront: string; limit: number }): Promise<ProviderTrack[]> {
    const words = normalizeTitle(query).split(' ').filter(Boolean);
    if (!words.length) return [];
    const scored: { t: ProviderTrack; score: number }[] = [];
    for (const t of this.tracks.values()) {
      const hay = ` ${normalizeTitle(t.title)} ${normalizeTitle(t.artists.join(' '))} `;
      if (!words.every((w) => hay.includes(` ${w}`))) continue;
      const titleStarts = normalizeTitle(t.title).startsWith(words.join(' ')) ? 2 : 0;
      scored.push({ t, score: titleStarts });
    }
    scored.sort((a, b) => b.score - a.score || a.t.title.localeCompare(b.t.title));
    return scored.slice(0, opts.limit).map((s) => s.t);
  }

  searchPatiently(query: string, storefront: string) {
    return this.search(query, { storefront, limit: 25 });
  }

  async getTrack(id: string): Promise<ProviderTrack | null> {
    return this.tracks.get(id) ?? null;
  }

  async getTracks(ids: string[]): Promise<ProviderTrack[]> {
    return ids.map((id) => this.tracks.get(id)).filter((t): t is ProviderTrack => !!t);
  }

  seedQueries(seed: SeedTrack): string[] {
    return [`${seed.title} ${seed.artist}`];
  }

  hasTrack(id: string) {
    return this.tracks.has(id);
  }
}

// ---------------------------------------------------------------------------
// Synthesized assets
// ---------------------------------------------------------------------------

function rng(seed: string) {
  let h = parseInt(sha1(seed).slice(0, 8), 16) || 1;
  return () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return ((h >>> 0) % 100_000) / 100_000;
  };
}

const SAMPLE_RATE = 16_000;
const MOCK_PREVIEW_SECONDS = 30;

/** A unique, deterministic 30s melody (mono 16-bit WAV) per track id. */
export function synthesizePreviewWav(id: string): Buffer {
  const rand = rng(id);
  const n = SAMPLE_RATE * MOCK_PREVIEW_SECONDS;
  const pcm = new Int16Array(n);
  const root = 196 * 2 ** (Math.floor(rand() * 12) / 12);
  const scale = rand() > 0.5 ? [0, 2, 4, 5, 7, 9, 11, 12] : [0, 2, 3, 5, 7, 8, 10, 12];
  const beat = 0.18 + rand() * 0.14;
  const motif = Array.from({ length: 8 }, () => scale[Math.floor(rand() * scale.length)]);
  const bass = [0, 5, 7, 3].map((i) => scale[i % scale.length] - 12);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const step = Math.floor(t / beat);
    const phase = (t % beat) / beat;
    const semis = motif[step % motif.length] + (Math.floor(step / 16) % 2 ? 2 : 0);
    const f = root * 2 ** (semis / 12);
    const env = Math.min(1, phase * 20) * Math.exp(-phase * 3);
    const lead = Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t);
    const bf = root * 2 ** (bass[Math.floor(step / 4) % bass.length] / 12);
    const b = 0.45 * Math.sin(2 * Math.PI * bf * t);
    pcm[i] = Math.max(-1, Math.min(1, 0.32 * (lead * env + b))) * 32767;
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, Buffer.from(pcm.buffer)]);
}

function escapeXml(s: string) {
  return s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function mockArtworkSvg(track: ProviderTrack): string {
  const rand = rng(`art:${track.id}`);
  const h1 = Math.floor(rand() * 360);
  const h2 = (h1 + 40 + Math.floor(rand() * 140)) % 360;
  const initials = track.title
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w))
    .slice(0, 2)
    .map((w) => Array.from(w.replace(/[^\p{L}\p{N}]/gu, ''))[0] ?? '')
    .join('')
    .toUpperCase();
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600" width="600" height="600">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="hsl(${h1} 70% 55%)"/><stop offset="1" stop-color="hsl(${h2} 65% 35%)"/>
  </linearGradient></defs>
  <rect width="600" height="600" fill="url(#g)"/>
  <circle cx="300" cy="300" r="${150 + Math.floor(rand() * 90)}" fill="none" stroke="rgba(255,255,255,.25)" stroke-width="18"/>
  <text x="300" y="345" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="150" font-weight="800" fill="rgba(255,255,255,.92)">${escapeXml(initials)}</text>
</svg>`;
}
