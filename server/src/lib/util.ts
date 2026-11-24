import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new ApiError(404, 'not_found', `${what} not found`);
export const badRequest = (code: string, message: string) => new ApiError(400, code, message);
export const conflict = (code: string, message: string) => new ApiError(409, code, message);

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** URL-safe random id (Crockford-ish base32). */
export function newId(length = 16): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % 32];
  return out;
}

export function now(): number {
  return Date.now();
}

export function shuffle<T>(items: readonly T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomBytes(4).readUInt32LE(0) % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

const AVATAR_COLORS = ['#16A34A', '#2563EB', '#DB2777', '#EA580C', '#7C3AED', '#0891B2', '#CA8A04', '#DC2626'];

export function pickAvatarColor(seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

const ADJECTIVES = ['Groovy', 'Funky', 'Mellow', 'Electric', 'Golden', 'Neon', 'Velvet', 'Cosmic', 'Lucky', 'Sonic', 'Retro', 'Jazzy'];
const NOUNS = ['Falcon', 'Vinyl', 'Tempo', 'Echo', 'Chorus', 'Riff', 'Bassline', 'Melody', 'Encore', 'Groove', 'Rhythm', 'Hook'];

export function randomDisplayName(): string {
  const b = randomBytes(3);
  return `${ADJECTIVES[b[0] % ADJECTIVES.length]} ${NOUNS[b[1] % NOUNS.length]} ${10 + (b[2] % 90)}`;
}

/** AES-256-GCM for OAuth tokens at rest. */
export class TokenCipher {
  private key: Buffer;
  constructor(secret: string) {
    this.key = createHash('sha256').update(`guessong-token-key:${secret}`).digest();
  }
  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${enc.toString('base64url')}`;
  }
  decrypt(blob: string): string | null {
    const [v, iv, tag, data] = blob.split('.');
    if (v !== 'v1' || !iv || !tag || !data) return null;
    try {
      const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
    } catch {
      return null;
    }
  }
}

/** Simple token bucket used to stay under upstream rate limits. */
export class RateLimiter {
  private tokens: number;
  private last = Date.now();
  constructor(
    private capacity: number,
    private perMs: number,
  ) {
    this.tokens = capacity;
  }
  private refill() {
    const t = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / this.perMs) * this.capacity);
    this.last = t;
  }
  tryTake(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
  /** Milliseconds until one token is available. */
  waitMs(): number {
    this.refill();
    return this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) / this.capacity) * this.perMs);
  }
  async take(): Promise<void> {
    for (;;) {
      if (this.tryTake()) return;
      await sleep(this.waitMs() + 5);
    }
  }
}

/** Small LRU with TTL for upstream search responses. */
export class LruCache<V> {
  private map = new Map<string, { v: V; exp: number }>();
  constructor(
    private max: number,
    private ttlMs: number,
  ) {}
  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.exp < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.v;
  }
  set(key: string, v: V) {
    this.map.delete(key);
    this.map.set(key, { v, exp: Date.now() + this.ttlMs });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
}
