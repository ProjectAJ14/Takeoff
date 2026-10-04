import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Settings, Transcript } from '@takeoff/contracts';
import type { RenderArtifact, RenderInput, RenderOptions, Renderer } from '@takeoff/renderer-api';
import { Engine, EngineError, type EngineOptions, type OverlayReport, type RendererModule, type Transcriber } from '../src/index.ts';

export const run = promisify(execFile);

export async function tmp(prefix = 'takeoff-engine-'): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Synthetic talking-head stand-in: test pattern video with a tone, `seconds` long. */
export async function makeVideo(path: string, seconds = 7): Promise<string> {
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=320x240:rate=30:duration=${seconds}`, '-f', 'lavfi', '-i', `sine=frequency=220:sample_rate=48000:duration=${seconds}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path]);
  return path;
}

export const SCRIPT = 'So today I want to show you how Flutter sends a request through Dio. It is really simple.';

export function transcriptFor(assetId: string, sourceHash: string, script = SCRIPT, startUs = 300_000): Transcript {
  const toks = script.split(/\s+/);
  const words = toks.map((text, i) => ({
    id: `w${String(i + 1).padStart(4, '0')}`,
    text,
    correctedText: null,
    sourceStartUs: startUs + i * 350_000,
    sourceEndUs: startUs + i * 350_000 + 300_000,
    score: 0.9,
    alignment: 'aligned' as const,
    speaker: null,
  }));
  const ends = toks.flatMap((t, i) => (/[.!?]$/.test(t) ? [i] : []));
  let from = 0;
  const sentences = ends.map((end, n) => {
    const s = { id: `s${String(n + 1).padStart(4, '0')}`, startWordId: words[from]!.id, endWordId: words[end]!.id, rawText: toks.slice(from, end + 1).join(' '), correctedText: null };
    from = end + 1;
    return s;
  });
  return {
    schemaVersion: '1.0', assetId, sourceHash, backend: 'faster_whisper', model: 'tiny', version: '1.2.1',
    configHash: 'c'.repeat(64), language: 'en', words, sentences,
    provenance: { createdAt: '2026-10-05T12:00:00Z', glossaryHash: null, vad: 'silero_vad_v6', alignment: null },
  };
}

export interface FakeTranscriber extends Transcriber {
  calls: number;
}
/** `mode`: 'ok' returns SCRIPT; 'hang' waits for abort; an error code throws that typed worker error. */
export function fakeTranscriber(mode: 'ok' | 'hang' | 'no_speech' | 'model_missing' = 'ok'): FakeTranscriber {
  const t: FakeTranscriber = {
    calls: 0,
    probe: async () => ({ models: ['tiny'], devices: ['cpu'], defaultDevice: 'cpu', versions: { fake: '1' } }),
    configHash: async () => 'f'.repeat(64),
    async transcribe(req) {
      t.calls++;
      if (mode === 'hang') {
        await new Promise((_, rej) => {
          const timer = setTimeout(() => rej(new Error('fake transcriber was never canceled')), 20_000);
          req.signal?.addEventListener('abort', () => (clearTimeout(timer), rej(req.signal!.reason)), { once: true });
        });
      }
      if (mode === 'no_speech') throw new EngineError('no_speech', 'no speech detected', 'Check the microphone.');
      if (mode === 'model_missing') throw new EngineError('model_missing', 'model tiny is not installed', 'Install the starter pack.');
      return { transcript: transcriptFor(req.assetId, req.sourceHash), speech: [{ assetId: req.assetId, sourceStartUs: 300_000, sourceEndUs: 6_500_000 }] };
    },
    downloadModel: async () => undefined,
  };
  return t;
}

export interface FakeRendererOptions {
  /** Frames to add to every render (non-zero = a duration defect QA must catch). */
  extraFrames?: number | ((profile: string) => number);
  overlay?: (input: RenderInput) => OverlayReport | undefined;
}
/** Writes a tiny 180x320 MP4 of the compiled duration with bt709 tags and a tone. */
export function fakeRenderer(o: FakeRendererOptions = {}): Renderer & { renders: RenderInput[] } {
  const renders: RenderInput[] = [];
  return {
    id: 'fake',
    renders,
    async render(input: RenderInput, opts: RenderOptions): Promise<RenderArtifact & { overlayReport?: OverlayReport }> {
      renders.push(input);
      const tl = input.compiled;
      const extra = typeof o.extraFrames === 'function' ? o.extraFrames(opts.profile) : (o.extraFrames ?? 0);
      const frames = tl.totalFrames + extra;
      const samples = Math.floor((frames * 48000 * tl.fps.den) / tl.fps.num);
      const partial = `${opts.outPath}.partial`;
      await run('ffmpeg', [
        '-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=gray:s=180x320:r=${tl.fps.num}/${tl.fps.den}`,
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-frames:v', String(frames),
        '-vf', 'setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709',
        '-af', `atrim=end_sample=${samples}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', '-f', 'mp4', partial,
      ], { signal: opts.signal });
      await rename(partial, opts.outPath);
      const bytes = (await stat(opts.outPath)).size;
      const sha256 = createHash('sha256').update(await readFile(opts.outPath)).digest('hex');
      opts.onProgress?.({ frame: tl.totalFrames, totalFrames: tl.totalFrames });
      return {
        path: opts.outPath, sha256, bytes, profile: opts.profile, planHash: tl.planHash, width: 180, height: 320, fps: tl.fps,
        durationFrames: frames, rendererId: 'fake', seed: input.seed, versions: input.versions, overlayReport: o.overlay?.(input),
      };
    },
  };
}

export const settings: Settings = {
  badTakes: true, fillers: true, silence: true, captions: true, userBroll: false, aiBroll: false, zoom: true,
  music: false, sfx: false, studioVoice: true, autoColor: true, textHook: false, motionGraphics: true, networkPolicy: 'local_only',
  fillerStrength: 'normal',
};

export interface Fixture {
  engine: Engine;
  root: string;
  transcriber: FakeTranscriber;
  renderer: ReturnType<typeof fakeRenderer>;
  take: string;
  cleanup: () => Promise<void>;
}

/** A project with one imported 7 s take, a fake transcriber and a fake renderer. */
export async function fixture(opts: { transcriber?: FakeTranscriber; renderer?: FakeRendererOptions; engine?: Partial<EngineOptions> } = {}): Promise<Fixture> {
  const { dir, cleanup } = await tmp();
  const media = join(dir, 'media');
  await mkdir(media);
  const take = await makeVideo(join(media, 'take one.mp4'));
  const transcriber = opts.transcriber ?? fakeTranscriber();
  const renderer = fakeRenderer(opts.renderer);
  const mod: RendererModule = { createRenderer: () => renderer };
  const engine = Engine.create(join(dir, 'project'), {
    name: 'Test',
    appDataDir: join(dir, 'appdata'),
    approvedRoots: [media, dir],
    transcriber,
    loadRenderer: async () => mod,
    asr: { model: 'tiny', language: 'en' },
    ...opts.engine,
  });
  const [r] = await engine.importAssets([take], { pool: 'takes' });
  if (!r?.assetId) throw new Error(`import failed: ${JSON.stringify(r?.error)}`);
  return { engine, root: engine.root, transcriber, renderer, take, cleanup: async () => (engine.close(), await cleanup()) };
}

export const pipeline = (f: Fixture, key: string, extra: Record<string, unknown> = {}) =>
  f.engine.runPipeline({ settings, targetSeconds: null, lengthPolicy: 'none', idempotencyKey: `job-key-${key}`, baseRevision: f.engine.store.currentRevision(), ...extra });
