// BrowserRenderer: Chromium overlay pass piped into one FFmpeg composition (PRD §7.4, §11 steps 2 and 7).
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { planHash } from '@takeoff/compiler';
import { validate, type Id, type RenderProfile } from '@takeoff/contracts';
import { analyzeColor, type ColorCorrection } from '@takeoff/media';
import type { Rect, RenderArtifact, RenderInput, RenderOptions, Renderer } from '@takeoff/renderer-api';
import {
  addInput, audioGraph, ffFile, finishVideo, int, measureGraph, newGraph, parseLoudnorm, videoGraph,
  type BrowserResolvedAsset, type ComposeContext, type Graph,
} from './compose.ts';
import { openOverlay, renderSize, sceneRuntimeHash, type OverlayViolation } from './overlay.ts';

export const RENDERER_ID = 'browser-chromium';
export const RENDERER_VERSION = '0.1.0';
const FFMPEG = process.env.TAKEOFF_FFMPEG ?? 'ffmpeg';
const FFPROBE = process.env.TAKEOFF_FFPROBE ?? 'ffprobe';
const HDR = new Set(['smpte2084', 'arib-std-b67']);

export type BrowserRenderInput = RenderInput & { assets: Record<Id, BrowserResolvedAsset> };

export interface OverlayReport {
  captionBounds: Array<{ captionId: Id; rect: Rect }>;
  /** `undeclared_network` is a hard QA failure; the others are layout failures for QA to raise. */
  violations: OverlayViolation[];
}
export interface BrowserRenderArtifact extends RenderArtifact {
  overlay: OverlayReport;
  /** Milliseconds per stage, for performance budgets (PRD §12). */
  timings: { colorMs: number; loudnessMs: number; composeMs: number; totalMs: number };
  /** Distinct overlay PNGs captured (the rest reused a previous PNG). */
  overlayCaptures: number;
}

export class RenderError extends Error {
  code: 'invalid_input' | 'ffmpeg_failed' | 'validation_failed';
  constructor(code: RenderError['code'], message: string) {
    super(message);
    this.name = 'RenderError';
    this.code = code;
  }
}

/** Spawns FFmpeg with an argument array; aborting kills it. stderr is kept for parsing, never surfaced (it may hold paths). */
function ff(bin: string, args: string[], signal?: AbortSignal) {
  // SIGKILL: on SIGTERM FFmpeg shuts down gracefully and can wait forever on an open stdin pipe.
  const child = spawn(bin, args, { signal, killSignal: 'SIGKILL', stdio: ['pipe', 'pipe', 'pipe'] });
  const out: Buffer[] = [];
  let err = '';
  child.stdout.on('data', (c: Buffer) => out.push(c));
  child.stderr.on('data', (c: Buffer) => { if (err.length < 4 << 20) err += c.toString('utf8'); });
  child.stdin.on('error', () => {}); // EPIPE when FFmpeg exits early; the exit code reports it.
  const done = new Promise<{ code: number; stdout: Buffer; stderr: string }>((ok, fail) => {
    child.on('error', fail);
    child.on('close', (code) => (signal?.aborted ? fail(signal.reason) : ok({ code: code ?? -1, stdout: Buffer.concat(out), stderr: err })));
  });
  return { child, done };
}
async function ffOk(args: string[], signal?: AbortSignal, stdin?: Buffer) {
  const p = ff(FFMPEG, ['-hide_banner', '-loglevel', 'info', '-nostats', ...args], signal);
  p.child.stdin.end(stdin);
  const r = await p.done;
  if (r.code !== 0) throw new RenderError('ffmpeg_failed', `ffmpeg exited with code ${r.code}`);
  return r;
}

let ffVersion: Promise<string> | undefined;
const ffmpegVersion = () => (ffVersion ??= ff(FFMPEG, ['-version']).done.then((r) => /ffmpeg version (\S+)/.exec(r.stdout.toString())?.[1] ?? 'unknown'));

function checkInput(input: RenderInput): void {
  const bad = (m: string) => new RenderError('invalid_input', m);
  if (!validate('compiled-timeline', input.compiled).ok) throw bad('compiled timeline does not match its schema');
  if (!validate('edit-plan', input.plan).ok) throw bad('plan does not match its schema');
  if (planHash(input.plan) !== input.compiled.planHash) throw bad('compiled timeline was not compiled from this plan');
  if (!Number.isInteger(input.seed) || input.seed < 0 || input.seed > 0xffffffff) throw bad('seed must be a uint32');
  if (input.compiled.totalFrames < 1) throw bad('timeline is empty');
}

/** Per-source F12 corrections when auto colour is on; HDR sources are left untouched (P0 is SDR, never silently reinterpreted). */
async function colors(input: BrowserRenderInput, signal?: AbortSignal): Promise<Map<Id, ColorCorrection>> {
  const out = new Map<Id, ColorCorrection>();
  if (!input.plan.settings.autoColor) return out;
  for (const id of new Set(input.compiled.segments.map((s) => s.assetId))) {
    const a = input.assets[id];
    const v = a?.manifest.probe.video;
    if (!a || !v || HDR.has(v.colorTransfer ?? '')) continue;
    out.set(id, (await analyzeColor(a.path, { signal })).correction);
  }
  return out;
}

async function context(input: BrowserRenderInput, profile: RenderProfile, signal?: AbortSignal): Promise<ComposeContext> {
  checkInput(input);
  return { compiled: input.compiled, plan: input.plan, assets: input.assets, ...renderSize(input.compiled, profile), draft: profile === 'draft', colors: await colors(input, signal) };
}

const graphArgs = (g: Graph) => [...g.args, '-filter_complex', g.filters.join(';')];

async function sha256(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** Decodable MP4 with exactly the compiled frame and sample counts (PRD §5.5 "validate before declaring success"). */
async function validateOutput(path: string, c: ComposeContext, signal?: AbortSignal): Promise<void> {
  const p = ff(FFPROBE, ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,width,height,nb_read_frames,duration_ts,time_base', '-of', 'json', ffFile(path)], signal);
  p.child.stdin.end();
  const r = await p.done;
  type S = { codec_type: string; width?: number; height?: number; nb_read_frames?: string; duration_ts?: number; time_base?: string };
  const streams = r.code === 0 ? (JSON.parse(r.stdout.toString()) as { streams: S[] }).streams : [];
  const v = streams.find((s) => s.codec_type === 'video'), a = streams.find((s) => s.codec_type === 'audio');
  const problems: string[] = [];
  if (!v || v.width !== c.width || v.height !== c.height) problems.push('video size');
  if (Number(v?.nb_read_frames) !== c.compiled.totalFrames) problems.push(`video frames ${v?.nb_read_frames} != ${c.compiled.totalFrames}`);
  if (!a || a.time_base !== '1/48000' || a.duration_ts !== c.compiled.totalSamples) problems.push(`audio samples ${a?.duration_ts} != ${c.compiled.totalSamples}`);
  if (problems.length) throw new RenderError('validation_failed', `output failed validation: ${problems.join(', ')}`);
}

export class BrowserRenderer implements Renderer {
  readonly id = RENDERER_ID;

  async render(input: RenderInput, opts: RenderOptions): Promise<BrowserRenderArtifact> {
    const { signal, profile } = opts;
    const t0 = performance.now();
    // Source media is immutable: the final rename (and FFmpeg's -y on the partial) must never land on an input.
    // ponytail: lexical compare; a symlink or case-variant path to an input slips through, realpath both sides if that matters.
    const outs = [resolve(opts.outPath), resolve(`${opts.outPath}.partial.mp4`)];
    const ins = [...Object.values(input.assets as BrowserRenderInput['assets']).flatMap((a) => [a.path, a.proxyPath]), ...input.fonts.map((f) => f.path)];
    if (ins.some((p) => p !== undefined && outs.includes(resolve(p)))) throw new RenderError('invalid_input', 'the output path is one of the render inputs');
    const c = await context(input as BrowserRenderInput, profile, signal);
    const tColor = performance.now();

    // Two-pass loudness (F11): measure the full mix, then apply the measured values linearly.
    const m = measureGraph(c);
    let measured: ReturnType<typeof parseLoudnorm> = null;
    if (m) {
      const err = (await ffOk([...graphArgs(m.g), '-map', `[${m.out}]`, '-f', 'null', '-'], signal)).stderr;
      // No JSON at all means the measurement did not run; never ship un-normalised audio as if Studio voice applied.
      if (!err.includes('"input_i"')) throw new RenderError('ffmpeg_failed', 'loudness measurement produced no result');
      measured = parseLoudnorm(err);
    }
    const tLoud = performance.now();

    const total = c.compiled.totalFrames;
    const rate = `${int(c.compiled.fps.num, 1)}/${int(c.compiled.fps.den, 1)}`;
    const partial = `${opts.outPath}.partial.mp4`;
    const overlay = await openOverlay(input, profile, signal);
    let captures = 0;
    let ffChild: ReturnType<typeof spawn> | undefined;
    let ffDone: Promise<unknown> | undefined;
    try {
      const g = newGraph();
      const base = videoGraph(g, c, 0, total);
      const ov = addInput(g, '-f', 'image2pipe', '-framerate', rate, '-c:v', 'png', '-i', 'pipe:0');
      const vout = finishVideo(g, base, ov, false);
      const aout = audioGraph(g, c, measured);
      const draft = profile === 'draft';
      const p = ff(FFMPEG, [
        '-hide_banner', '-loglevel', 'error', '-y', ...graphArgs(g),
        '-map', `[${vout}]`, '-map', `[${aout}]`,
        '-c:v', 'libx264', '-preset', draft ? 'veryfast' : 'medium', '-crf', draft ? '28' : '18', '-pix_fmt', 'yuv420p',
        '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
        '-r', rate, '-frames:v', String(total),
        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
        '-movflags', '+faststart', '-f', 'mp4', ffFile(partial),
      ], signal);
      ffChild = p.child;
      ffDone = p.done;
      // Stream overlay PNGs with backpressure: memory holds one frame, not the clip.
      let prev: Buffer | null = null;
      for (let f = 0; f < total; f++) {
        const fr = await overlay.frame(f);
        if (fr.png !== prev && !fr.empty) captures++;
        prev = fr.png;
        if (!p.child.stdin.write(fr.png)) await Promise.race([once(p.child.stdin, 'drain'), p.done]);
        if (p.child.exitCode !== null || p.child.signalCode !== null) break; // FFmpeg died early: stop capturing, its exit code is reported below.
        opts.onProgress?.({ frame: f, totalFrames: total });
      }
      p.child.stdin.end();
      const r = await p.done;
      if (r.code !== 0) throw new RenderError('ffmpeg_failed', `ffmpeg exited with code ${r.code}`);
      await validateOutput(partial, c, signal);
      await rename(partial, opts.outPath);
      opts.onProgress?.({ frame: total, totalFrames: total });
    } catch (e) {
      ffChild?.kill('SIGKILL');
      await ffDone?.catch(() => {});
      await rm(partial, { force: true });
      throw signal?.aborted ? (signal.reason ?? e) : e;
    } finally {
      await overlay.close().catch(() => {});
    }

    return {
      path: opts.outPath,
      sha256: await sha256(opts.outPath),
      bytes: (await stat(opts.outPath)).size,
      profile,
      planHash: c.compiled.planHash,
      width: c.width,
      height: c.height,
      fps: c.compiled.fps,
      durationFrames: total,
      rendererId: RENDERER_ID,
      seed: input.seed,
      versions: { ...input.versions, rendererBrowser: RENDERER_VERSION, chromium: overlay.chromiumVersion, ffmpeg: await ffmpegVersion(), sceneRuntime: sceneRuntimeHash() },
      overlay: { captionBounds: [...overlay.captionBounds].map(([captionId, rect]) => ({ captionId, rect })), violations: [...overlay.violations] },
      timings: { colorMs: Math.round(tColor - t0), loudnessMs: Math.round(tLoud - tColor), composeMs: Math.round(performance.now() - tLoud), totalMs: Math.round(performance.now() - t0) },
      overlayCaptures: captures,
    };
  }
}

/** One composed output frame (source, zoom, B-roll, overlay) as PNG, for QA contact sheets and frame inspection (PRD §11). */
export async function renderStill(input: RenderInput, frame: number, opts: { profile?: RenderProfile; signal?: AbortSignal } = {}): Promise<Buffer> {
  const profile = opts.profile ?? 'draft';
  const c = await context(input as BrowserRenderInput, profile, opts.signal);
  int(frame, 0, c.compiled.totalFrames - 1);
  const overlay = await openOverlay(input, profile, opts.signal);
  let png: Buffer;
  try {
    png = (await overlay.frame(frame)).png;
  } finally {
    await overlay.close();
  }
  const g = newGraph();
  const base = videoGraph(g, c, frame, frame + 1);
  const ov = addInput(g, '-f', 'image2pipe', '-c:v', 'png', '-i', 'pipe:0');
  const out = finishVideo(g, base, ov, true);
  return (await ffOk([...graphArgs(g), '-map', `[${out}]`, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'], opts.signal, png)).stdout;
}
