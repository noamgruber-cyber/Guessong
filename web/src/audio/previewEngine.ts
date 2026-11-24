import { CLIP_STAGES_MS, type Slice } from '@guessong/shared';
import { AudioLoadError, rafLoop, type AudioEngine, type PlayOutcome, type SongHandle } from './engine';

const FADE_S = 0.006; // 6ms ramps remove clicks at slice edges
const MIN_PREVIEW_MS = CLIP_STAGES_MS[CLIP_STAGES_MS.length - 1];

/**
 * Plays 30-second previews with the Web Audio API. The whole preview is
 * decoded into memory, so slices are sample-accurate (AudioBufferSourceNode
 * start(when, offset, duration)) with tiny gain ramps at both ends.
 */
export class PreviewEngine implements AudioEngine {
  readonly kind = 'preview' as const;
  private ctx: AudioContext | null = null;
  private buffers = new Map<string, Promise<AudioBuffer>>();
  private current: AudioBuffer | null = null;
  private active: { src: AudioBufferSourceNode; gain: GainNode; finish: (o: PlayOutcome) => void; cancelTicks: () => void } | null = null;

  private context(): AudioContext {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor({ latencyHint: 'interactive' });
    }
    return this.ctx;
  }

  unlock() {
    // Safari 17+: play through the ring/silent switch like a media app.
    const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
    if (session) {
      try {
        session.type = 'playback';
      } catch {
        /* ignore */
      }
    }
    const ctx = this.context();
    if (ctx.state !== 'running') void ctx.resume();
    // A one-sample silent buffer started in the gesture unlocks iOS output.
    const b = ctx.createBuffer(1, 1, 22050);
    const s = ctx.createBufferSource();
    s.buffer = b;
    s.connect(ctx.destination);
    s.start(0);
  }

  private url(handle: SongHandle): string {
    if (handle.song.audio.kind !== 'preview') throw new AudioLoadError('Not a preview source', false);
    return handle.song.audio.url;
  }

  private fetchBuffer(url: string, onProgress?: (p: number) => void): Promise<AudioBuffer> {
    const cached = this.buffers.get(url);
    if (cached) {
      onProgress?.(1);
      return cached;
    }
    const p = (async () => {
      let res: Response;
      try {
        res = await fetch(url, { credentials: 'same-origin' });
      } catch {
        throw new AudioLoadError('Network error while loading the song', false, 'network');
      }
      if (!res.ok) throw new AudioLoadError(`Song failed to load (${res.status})`, res.status === 404 || res.status === 502);
      const total = Number(res.headers.get('content-length') ?? 0);
      let bytes: ArrayBuffer;
      if (res.body && total > 0 && onProgress) {
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let received = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.byteLength;
          onProgress(Math.min(0.9, (received / total) * 0.9));
        }
        const merged = new Uint8Array(received);
        let off = 0;
        for (const c of chunks) {
          merged.set(c, off);
          off += c.byteLength;
        }
        bytes = merged.buffer;
      } else {
        bytes = await res.arrayBuffer();
        onProgress?.(0.9);
      }
      let buffer: AudioBuffer;
      try {
        buffer = await this.context().decodeAudioData(bytes);
      } catch {
        throw new AudioLoadError('This song could not be decoded', true);
      }
      if (buffer.duration * 1000 < MIN_PREVIEW_MS) throw new AudioLoadError('Preview is too short', true);
      onProgress?.(1);
      return buffer;
    })();
    this.buffers.set(url, p);
    p.catch(() => this.buffers.delete(url));
    // Keep memory bounded: current + next song is all we need.
    while (this.buffers.size > 3) this.buffers.delete(this.buffers.keys().next().value!);
    return p;
  }

  async load(handle: SongHandle, onProgress: (p: number) => void) {
    this.stop();
    this.current = await this.fetchBuffer(this.url(handle), onProgress);
  }

  prefetch(handle: SongHandle) {
    if (handle.song.audio.kind === 'preview') void this.fetchBuffer(handle.song.audio.url).catch(() => {});
  }

  play(slice: Slice, onTick: (ms: number) => void): Promise<PlayOutcome> {
    this.stop();
    const buffer = this.current;
    if (!buffer) return Promise.resolve('stopped');
    const ctx = this.context();
    if (ctx.state !== 'running') void ctx.resume();

    const startS = slice.startMs / 1000;
    const endS = Math.min(slice.endMs / 1000, buffer.duration);
    const dur = Math.max(0.01, endS - startS);
    const when = ctx.currentTime + 0.03;

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(1, when + FADE_S);
    gain.gain.setValueAtTime(1, when + Math.max(FADE_S, dur - FADE_S));
    gain.gain.linearRampToValueAtTime(0, when + dur);
    src.connect(gain).connect(ctx.destination);
    src.start(when, startS, dur);

    return new Promise<PlayOutcome>((resolve) => {
      let done = false;
      const finish = (o: PlayOutcome) => {
        if (done) return;
        done = true;
        cancelTicks();
        if (this.active?.src === src) this.active = null;
        onTick(o === 'ended' ? endS * 1000 : Math.min(endS, startS + Math.max(0, ctx.currentTime - when)) * 1000);
        resolve(o);
      };
      const cancelTicks = rafLoop(() => {
        const elapsed = Math.max(0, ctx.currentTime - when);
        onTick(Math.min(endS, startS + elapsed) * 1000);
        return elapsed < dur;
      });
      src.onended = () => finish('ended');
      this.active = { src, gain, finish, cancelTicks };
    });
  }

  stop() {
    const a = this.active;
    if (!a) return;
    this.active = null;
    try {
      const ctx = this.context();
      a.gain.gain.cancelScheduledValues(ctx.currentTime);
      a.gain.gain.setValueAtTime(a.gain.gain.value, ctx.currentTime);
      a.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + FADE_S);
      a.src.stop(ctx.currentTime + FADE_S + 0.001);
    } catch {
      /* already stopped */
    }
    a.finish('stopped');
  }

  dispose() {
    this.stop();
    this.buffers.clear();
    void this.ctx?.close();
    this.ctx = null;
  }
}
