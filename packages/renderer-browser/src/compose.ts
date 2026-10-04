// FFmpeg filter graphs for composition. Graph text is built only from validated numbers,
// fixed filter names and stream labels; no plan, transcript or path string ever enters it.
// Paths go in as separate `-i file:<abs>` arguments.
import { resolve } from 'node:path';
import { easeInOutCubic, frameProgress, platformSafeArea } from '@takeoff/renderer-api';
import { framesToSamples, frameToUs, usToSamples } from '@takeoff/compiler';
import type { BrollVisual, CompiledSegment, CompiledTimeline, CropTransform, EditPlan, Id, PunchTransform, Rational } from '@takeoff/contracts';
import type { ColorCorrection } from '@takeoff/media';
import type { FaceTrack, Rect, ResolvedAsset } from '@takeoff/renderer-api';

export type BrowserResolvedAsset = ResolvedAsset & { /** CFR proxy used for draft video; original otherwise. */ proxyPath?: string };

export interface Graph {
  args: string[];
  inputs: number;
  filters: string[];
  labels: number;
}
export const newGraph = (): Graph => ({ args: [], inputs: 0, filters: [], labels: 0 });
export function addInput(g: Graph, ...args: string[]): number {
  g.args.push(...args);
  return g.inputs++;
}
const label = (g: Graph, p: string) => `${p}${g.labels++}`;

export function int(v: number, min = 0, max = Number.MAX_SAFE_INTEGER): string {
  if (!Number.isSafeInteger(v) || v < min || v > max) throw new RangeError(`expected an integer in [${min}, ${max}], got ${v}`);
  return String(v);
}
export function dec(v: number, min = -1e9, max = 1e9): string {
  if (!Number.isFinite(v) || v < min || v > max) throw new RangeError(`expected a number in [${min}, ${max}], got ${v}`);
  return v.toFixed(6);
}
const rate = (fps: Rational) => `${int(fps.num, 1)}/${int(fps.den, 1)}`;
export const ffFile = (p: string) => `file:${resolve(p)}`;
const sec = (us: number) => (us / 1e6).toFixed(6);
const even = (v: number) => Math.max(2, Math.floor(v / 2) * 2);

export interface ComposeContext {
  compiled: CompiledTimeline;
  plan: EditPlan;
  assets: Record<Id, BrowserResolvedAsset>;
  /** Render size (draft or final). */
  width: number;
  height: number;
  draft: boolean;
  /** Per-asset F12 corrections; absent when auto colour is off or the source is HDR. */
  colors: Map<Id, ColorCorrection>;
  /** F06/F08 face tracks per asset (RenderInput.faceTracks); absent = centre framing. */
  faceTracks?: Record<Id, FaceTrack>;
  /** RenderInput.faceZoomMaxUpscale; default 1. */
  faceZoomMaxUpscale?: number;
  /** F17 brand logo (PNG/JPEG, hash-verified by the caller); drawn in the safe area's top-right corner. */
  logo?: { path: string };
}
/** What face framing needs; a RenderInput satisfies it too. */
export type FaceContext = Pick<ComposeContext, 'compiled' | 'plan' | 'assets' | 'faceTracks'>;

function asset(c: Pick<ComposeContext, 'assets'>, id: Id): BrowserResolvedAsset {
  if (!Object.hasOwn(c.assets, id)) throw new RangeError(`asset ${id} is not resolved`);
  return c.assets[id]!;
}

/** Displayed source size after rotation (FFmpeg autorotates). */
export function displayDims(a: ResolvedAsset): { w: number; h: number } {
  const v = a.manifest.probe.video;
  if (!v) throw new RangeError(`asset ${a.manifest.id} has no video`);
  return v.rotation === 90 || v.rotation === 270 ? { w: v.height, h: v.width } : { w: v.width, h: v.height };
}

/**
 * F08: the face for a compiled segment as fractions of the displayed source: the track entry overlapping most of
 * the segment's source range. Null without a track or below confidence 0.5 (multiple faces, lost): keep the centre.
 * ponytail: one framing per segment (no pan inside a cut); a per-frame x expression if speakers move mid-segment.
 */
export function segmentFace(c: Pick<ComposeContext, 'faceTracks'>, s: CompiledSegment): Rect | null {
  const t = c.faceTracks && Object.hasOwn(c.faceTracks, s.assetId) ? c.faceTracks[s.assetId]! : null;
  let best: FaceTrack['track'][number] | null = null, most = 0;
  for (const e of t?.track ?? []) {
    const overlap = Math.min(e.endUs, s.sourceEndUs) - Math.max(e.startUs, s.sourceStartUs);
    if (overlap > most) [best, most] = [e, overlap];
  }
  if (!t || !best || best.confidence < 0.5) return null;
  return { x: best.x / t.width, y: best.y / t.height, w: best.w / t.width, h: best.h / t.height };
}

/**
 * Crop as fractions of the displayed source: the largest output-aspect rect inside the plan crop
 * (or the whole frame), centred, or centred on `face` horizontally and clamped inside the plan crop.
 * Fractions apply to the proxy and the original alike; never outside the source.
 */
export function cropFractions(c: Pick<ComposeContext, 'plan' | 'compiled'>, segmentId: Id, src: { w: number; h: number }, face: Rect | null = null) {
  const t = c.plan.transforms.find((x): x is CropTransform => x.kind === 'crop' && x.segmentId === segmentId);
  const r = t ? t.rect : { x: 0, y: 0, width: 1, height: 1 };
  const rw = r.width * src.w, rh = r.height * src.h;
  const aspect = c.compiled.width / c.compiled.height;
  const cw = Math.min(rw, rh * aspect), ch = cw / aspect;
  const fw = cw / src.w, fy = (r.y * src.h + (rh - ch) / 2) / src.h;
  const fx = face ? Math.max(r.x, Math.min(r.x + r.width - fw, face.x + face.w / 2 - fw / 2)) : (r.x * src.w + (rw - cw) / 2) / src.w;
  return { fw, fh: ch / src.h, fx, fy };
}

/** The segment's face in output pixels (render size W x H) after its crop, the crop, and the source size; null without a face. */
export function faceInOutput(c: FaceContext, s: CompiledSegment, W: number, H: number) {
  const face = segmentFace(c, s);
  if (!face) return null;
  const src = displayDims(asset(c, s.assetId));
  const f = cropFractions(c, s.segmentId, src, face);
  const rect = { x: Math.round(((face.x - f.fx) / f.fw) * W), y: Math.round(((face.y - f.fy) / f.fh) * H), w: Math.round((face.w / f.fw) * W), h: Math.round((face.h / f.fh) * H) };
  return { rect, crop: f, src };
}

/**
 * F08 tracked_face punch at `frame`: zoom centre in render pixels and the largest scale that keeps output pixels per
 * source pixel <= faceZoomMaxUpscale. Null when no face is tracked there (the punch zooms on the centre, uncapped as before).
 */
function facePunch(c: ComposeContext, frame: number): { cx: number; cy: number; maxScale: number } | null {
  const s = c.compiled.segments.find((x) => frame >= x.outputStartFrame && frame < x.outputEndFrame);
  const f = s && faceInOutput(c, s, c.width, c.height);
  if (!f) return null;
  return { cx: f.rect.x + f.rect.w / 2, cy: f.rect.y + f.rect.h / 2, maxScale: ((c.faceZoomMaxUpscale ?? 1) * f.crop.fw * f.src.w) / c.compiled.width };
}
function cropFilter(f: { fw: number; fh: number; fx: number; fy: number }): string {
  const [fw, fh, fx, fy] = [dec(f.fw, 0, 1), dec(f.fh, 0, 1), dec(f.fx, 0, 1), dec(f.fy, 0, 1)];
  return `crop=w='trunc(iw*${fw}/2)*2':h='trunc(ih*${fh}/2)*2':x='min(trunc(iw*${fx}),iw-ow)':y='min(trunc(ih*${fy}),ih-oh)'`;
}
function colorFilter(k: ColorCorrection | undefined): string {
  if (!k) return '';
  const cb = k.colorbalance;
  return `,eq=brightness=${dec(k.brightness, -0.08, 0.08)}:contrast=${dec(k.contrast, 1, 1.15)}:saturation=${dec(k.saturation, 1, 1.1)}` +
    `,colorbalance=rm=${dec(cb.rm, -0.1, 0.1)}:gm=${dec(cb.gm, -0.1, 0.1)}:bm=${dec(cb.bm, -0.1, 0.1)}`;
}

/**
 * Frames [0, n) starting at source instant `srcUs`, sampled on the output grid: output frame k shows the source
 * frame whose span contains srcUs + k/fps (fps round=up), padded by repeating the last frame if the source runs short.
 */
function videoAt(g: Graph, path: string, srcUs: number, n: number, fps: Rational, chain: string): string {
  const seekUs = Math.max(0, srcUs - 1_000_000);
  const i = addInput(g, '-ss', sec(seekUs), '-i', ffFile(path));
  const out = label(g, 'v');
  g.filters.push(`[${i}:v]fps=fps=${rate(fps)}:start_time=${sec(srcUs - seekUs)}:round=up,setpts=PTS-STARTPTS,${chain},tpad=stop_mode=clone:stop=${int(n, 1)},trim=end_frame=${int(n, 1)},setpts=PTS-STARTPTS[${out}]`);
  return out;
}

/**
 * Per-frame punch zoom (F08): eased in over transitionFrames, held to the transform's end. 1 = no zoom.
 * `center` is the render-pixel zoom centre for a tracked_face punch on a tracked face; null zooms on the frame centre.
 */
export function punchAt(c: ComposeContext, frame: number): { z: number; center: { x: number; y: number } | null } {
  let z = 1, center: { x: number; y: number } | null = null;
  for (const ct of c.compiled.transforms) {
    if (ct.kind !== 'punch' || frame < ct.startFrame || frame >= ct.endFrame) continue;
    const t = c.plan.transforms.find((x): x is PunchTransform => x.id === ct.transformId && x.kind === 'punch');
    if (!t) continue;
    const fp = t.centerPolicy === 'tracked_face' ? facePunch(c, frame) : null;
    const e = easeInOutCubic(frameProgress(frame - ct.startFrame, 0, t.transitionFrames));
    z = Math.max(z, 1 + (Math.min(t.scale, 1.25, fp?.maxScale ?? 1.25) - 1) * e);
    if (fp) center = { x: fp.cx, y: fp.cy };
  }
  z = Math.round(z * 1e4) / 1e4;
  return { z, center: z === 1 ? null : center };
}
export const zoomAt = (c: ComposeContext, frame: number): number => punchAt(c, frame).z;

/**
 * Video for output frames [from, to) at render size, with B-roll; the caller overlays the PNG stream.
 * Returns the output label.
 */
export function videoGraph(g: Graph, c: ComposeContext, from: number, to: number): string {
  const { compiled: tl, width: W, height: H } = c;
  const fps = tl.fps;
  const parts: string[] = [];
  for (const s of tl.segments) {
    const a = Math.max(s.outputStartFrame, from), b = Math.min(s.outputEndFrame, to);
    if (b <= a) continue;
    const as = asset(c, s.assetId);
    const path = c.draft && as.proxyPath ? as.proxyPath : as.path;
    const chain = `${cropFilter(cropFractions(c, s.segmentId, displayDims(as), segmentFace(c, s)))},scale=${int(W, 2)}:${int(H, 2)}:flags=bicubic,setsar=1${colorFilter(c.colors.get(s.assetId))}`;
    parts.push(videoAt(g, path, s.sourceStartUs + frameToUs(a - s.outputStartFrame, fps), b - a, fps, chain));
  }
  if (!parts.length) throw new RangeError(`no segment covers frames [${from}, ${to})`);
  // Concat of short pieces can repeat timestamps; restamp every frame onto the output grid.
  const restamp = `setpts=N*${int(fps.den, 1)}/(${int(fps.num, 1)}*TB)`;
  let cur = label(g, 'base');
  g.filters.push(`${parts.map((p) => `[${p}]`).join('')}concat=n=${parts.length}:v=1:a=0,${restamp}[${cur}]`);

  // Punch zoom as runs of equal zoom and centre: crop by 1/z (around the frame or face centre), scale back.
  // Constant-size crops, no zoompan jitter; a face-centred crop is clamped inside the frame.
  const runs: Array<{ a: number; b: number; z: number; at: string }> = [];
  for (let f = from; f < to; f++) {
    const { z, center } = punchAt(c, f);
    let at = '';
    if (center) {
      const cw = even(W / z), ch = even(H / z);
      at = `:${int(Math.max(0, Math.min(W - cw, Math.round(center.x - cw / 2))), 0, W - cw)}:${int(Math.max(0, Math.min(H - ch, Math.round(center.y - ch / 2))), 0, H - ch)}`;
    }
    const last = runs.at(-1);
    if (last && last.z === z && last.at === at) last.b = f + 1;
    else runs.push({ a: f, b: f + 1, z, at });
  }
  if (runs.some((r) => r.z !== 1)) {
    const outs = runs.map(() => label(g, 'z'));
    g.filters.push(`[${cur}]split=${runs.length}${outs.map((o) => `[${o}i]`).join('')}`);
    runs.forEach((r, i) => {
      const zoom = r.z === 1 ? '' : `,crop=${even(W / r.z)}:${even(H / r.z)}${r.at},scale=${int(W, 2)}:${int(H, 2)}:flags=bicubic,setsar=1`;
      g.filters.push(`[${outs[i]}i]trim=start_frame=${int(r.a - from)}:end_frame=${int(r.b - from)},setpts=PTS-STARTPTS${zoom}[${outs[i]}]`);
    });
    const z = label(g, 'zoomed');
    g.filters.push(`${outs.map((o) => `[${o}]`).join('')}concat=n=${runs.length}:v=1:a=0,${restamp}[${z}]`);
    cur = z;
  }

  // B-roll (F07): full, inset or split, from its own source range.
  const safe = platformSafeArea(W, H);
  for (const cv of tl.visuals) {
    if (cv.kind !== 'broll') continue;
    const v = c.plan.visuals.find((x): x is BrollVisual => x.id === cv.visualId && x.kind === 'broll');
    const a = Math.max(cv.startFrame, from), b = Math.min(cv.endFrame, to);
    if (!v || b <= a) continue;
    const as = asset(c, v.assetId);
    const box = v.layout === 'full' ? { w: W, h: H, x: 0, y: 0 }
      : v.layout === 'split' ? { w: W, h: even(H / 2), x: 0, y: 0 }
      : { w: even(W * 0.7), h: even(H * 0.3), x: even((W - even(W * 0.7)) / 2), y: safe.y };
    const fit = `scale=${int(box.w, 2)}:${int(box.h, 2)}:force_original_aspect_ratio=increase:flags=bicubic,crop=${int(box.w, 2)}:${int(box.h, 2)},setsar=1`;
    const n = b - a;
    let br: string;
    if (as.manifest.kind === 'image') {
      const i = addInput(g, '-loop', '1', '-framerate', rate(fps), '-i', ffFile(as.path));
      br = label(g, 'b');
      g.filters.push(`[${i}:v]${fit},trim=end_frame=${int(n, 1)},setpts=PTS-STARTPTS[${br}]`);
    } else {
      br = videoAt(g, as.path, v.sourceStartUs + frameToUs(a - cv.startFrame, fps), n, fps, fit);
    }
    const shifted = label(g, 'bs');
    g.filters.push(`[${br}]setpts=PTS+${int(a - from)}*${int(fps.den, 1)}/(${int(fps.num, 1)}*TB)[${shifted}]`);
    const out = label(g, 'vb');
    g.filters.push(`[${cur}][${shifted}]overlay=x=${int(box.x)}:y=${int(box.y)}:eof_action=pass:enable='between(n,${int(a - from)},${int(b - from - 1)})'[${out}]`);
    cur = out;
  }

  // F17 logo: aspect preserved inside a box of 20% width x 6% height, top-right corner of the safe area.
  if (c.logo) {
    const i = addInput(g, '-loop', '1', '-framerate', rate(fps), '-i', ffFile(c.logo.path));
    const lg = label(g, 'lg'), out = label(g, 'vl');
    g.filters.push(`[${i}:v]scale=${int(even(W * 0.2), 2)}:${int(even(H * 0.06), 2)}:force_original_aspect_ratio=decrease:flags=bicubic,format=rgba,setsar=1,trim=end_frame=${int(to - from, 1)},setpts=PTS-STARTPTS[${lg}]`);
    g.filters.push(`[${cur}][${lg}]overlay=x=${int(safe.x + safe.w)}-w:y=${int(safe.y)}:format=auto:eof_action=pass[${out}]`);
    cur = out;
  }
  return cur;
}

/**
 * QA face_crop samples: the mid frame of every segment with a confident face, and the face rect there in render
 * pixels after the crop and any punch zoom (the same math as the graph). Empty without face tracks.
 */
export function faceSamples(c: ComposeContext): Array<{ frame: number; rect: Rect }> {
  const out: Array<{ frame: number; rect: Rect }> = [];
  const { width: W, height: H } = c;
  for (const s of c.compiled.segments) {
    const f = faceInOutput(c, s, W, H);
    if (!f) continue;
    const frame = Math.floor((s.outputStartFrame + s.outputEndFrame - 1) / 2);
    const { z, center } = punchAt(c, frame);
    const cw = z === 1 ? W : even(W / z), ch = z === 1 ? H : even(H / z);
    const x0 = center ? Math.max(0, Math.min(W - cw, Math.round(center.x - cw / 2))) : Math.floor((W - cw) / 2);
    const y0 = center ? Math.max(0, Math.min(H - ch, Math.round(center.y - ch / 2))) : Math.floor((H - ch) / 2);
    const k = W / cw;
    out.push({ frame, rect: { x: Math.round((f.rect.x - x0) * k), y: Math.round((f.rect.y - y0) * (H / ch)), w: Math.round(f.rect.w * k), h: Math.round(f.rect.h * (H / ch)) } });
  }
  return out;
}

/** Overlay the RGBA PNG input; convert to BT.709 4:2:0 for video, or RGB for a still PNG. */
export function finishVideo(g: Graph, cur: string, overlayInput: number, still: boolean): string {
  const out = label(g, 'vout');
  const tail = still ? 'format=rgb24' : 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709';
  g.filters.push(`[${cur}][${overlayInput}:v]overlay=0:0:format=auto:eof_action=pass,${tail}[${out}]`);
  return out;
}

export interface LoudnormMeasure {
  input_i: number;
  input_tp: number;
  input_lra: number;
  input_thresh: number;
  target_offset: number;
}

const AFMT = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';
const DENOISE = { studio_conservative: 10, studio_strong: 20 } as const;

export interface Buses {
  /** Dialogue after seam fades and (when on) the Studio voice chain. */
  dialogue: string;
  /** Music after fades and gain, ducked under dialogue when the cue asks; null without music. */
  music: string | null;
  sfx: string[];
}

/**
 * The mix buses up to (not including) loudness normalisation. `voice` = Studio voice active (F11).
 * The mix and the export stems are both built from these labels, so they share every audio decision.
 */
function buses(g: Graph, c: ComposeContext, voice: boolean): Buses {
  const { compiled: tl, plan } = c;
  const fps = tl.fps;
  const fade = Math.round((plan.audio.dialogue.seamFadeMs * 48000) / 1000);
  const parts = tl.segments.map((s, idx) => {
    const n = s.outputEndSample - s.outputStartSample;
    const out = label(g, 'd');
    if (n <= 0) return null;
    const as = asset(c, s.assetId);
    const f = Math.min(fade, Math.floor(n / 2));
    const fades = (idx > 0 && f > 0 ? `,afade=t=in:start_sample=0:nb_samples=${int(f)}` : '') +
      (idx < tl.segments.length - 1 && f > 0 ? `,afade=t=out:start_sample=${int(n - f)}:nb_samples=${int(f)}` : '');
    if (!as.manifest.probe.audio) {
      g.filters.push(`anullsrc=r=48000:cl=stereo,atrim=end_sample=${int(n, 1)}${fades}[${out}]`);
      return out;
    }
    const seekUs = Math.max(0, s.sourceStartUs - 1_000_000);
    const i = addInput(g, '-ss', sec(seekUs), '-i', ffFile(as.path));
    const pre = usToSamples(s.sourceStartUs - seekUs);
    g.filters.push(`[${i}:a]aresample=48000,${AFMT},atrim=start_sample=${int(pre)}:end_sample=${int(pre + n)},asetpts=PTS-STARTPTS,apad=whole_len=${int(n, 1)},atrim=end_sample=${int(n, 1)}${fades}[${out}]`);
    return out;
  }).filter((x): x is string => x !== null);
  let dlg = label(g, 'dlg');
  g.filters.push(`${parts.map((p) => `[${p}]`).join('')}concat=n=${parts.length}:v=0:a=1[${dlg}]`);
  if (voice) {
    const nr = DENOISE[plan.audio.dialogue.profile as keyof typeof DENOISE] ?? 10;
    const out = label(g, 'voice');
    g.filters.push(`[${dlg}]highpass=f=80,afftdn=nr=${int(nr)}:nf=-40,deesser,acompressor=threshold=0.125:ratio=2.5:attack=20:release=250:makeup=1[${out}]`);
    dlg = out;
  }

  let musicOut: string | null = null;
  const music = tl.audioEvents.find((e) => e.kind === 'music');
  const cue = plan.audio.music;
  let sidechain: string | null = null;
  if (music && cue) {
    if (cue.duckUnderDialogue) {
      const keep = label(g, 'dk'), sc = label(g, 'sc');
      g.filters.push(`[${dlg}]asplit=2[${keep}][${sc}]`);
      dlg = keep;
      sidechain = sc;
    }
    const len = music.endSample - music.startSample;
    const fi = Math.min(framesToSamples(cue.fadeInFrames, fps), len), fo = Math.min(framesToSamples(cue.fadeOutFrames, fps), len);
    const i = addInput(g, '-stream_loop', '-1', '-i', ffFile(asset(c, music.assetId).path));
    let m = label(g, 'm');
    g.filters.push(`[${i}:a]aresample=48000,${AFMT},atrim=end_sample=${int(len, 1)},asetpts=PTS-STARTPTS` +
      `${fi > 0 ? `,afade=t=in:start_sample=0:nb_samples=${int(fi)}` : ''}${fo > 0 ? `,afade=t=out:start_sample=${int(len - fo)}:nb_samples=${int(fo)}` : ''}` +
      `,volume=${dec(music.gainDb, -60, 12)}dB,adelay=delays=${int(music.startSample)}S:all=1[${m}]`);
    if (sidechain) {
      const ducked = label(g, 'md');
      g.filters.push(`[${m}][${sidechain}]sidechaincompress=threshold=0.03:ratio=8:attack=15:release=300[${ducked}]`);
      m = ducked;
    }
    musicOut = m;
  }
  const sfx: string[] = [];
  for (const e of tl.audioEvents) {
    if (e.kind !== 'sfx') continue;
    const i = addInput(g, '-i', ffFile(asset(c, e.assetId).path));
    const out = label(g, 'sx');
    g.filters.push(`[${i}:a]aresample=48000,${AFMT},atrim=end_sample=${int(e.endSample - e.startSample, 1)},volume=${dec(e.gainDb, -60, 12)}dB,adelay=delays=${int(e.startSample)}S:all=1[${out}]`);
    sfx.push(out);
  }
  return { dialogue: dlg, music: musicOut, sfx };
}

/** The full mix up to (not including) loudness normalisation. Returns the label of the summed mix. */
function mixGraph(g: Graph, c: ComposeContext, voice: boolean): string {
  const b = buses(g, c, voice);
  const mix = [...(b.music ? [b.music] : []), ...b.sfx];
  if (!mix.length) return b.dialogue;
  const out = label(g, 'mix');
  g.filters.push(`[${b.dialogue}]${mix.map((m) => `[${m}]`).join('')}amix=inputs=${mix.length + 1}:duration=first:normalize=0:dropout_transition=0[${out}]`);
  return out;
}

export type Stem = 'dialogue' | 'music' | 'sfx';

/**
 * One export stem with the mix's own decisions (seam fades, Studio voice chain, music fades/gain/ducking, SFX
 * placement), before loudness normalisation, padded/trimmed to exactly totalSamples. Other buses are sunk.
 */
export function stemGraph(g: Graph, c: ComposeContext, stem: Stem): string {
  const b = buses(g, c, voiceOn(c));
  const total = c.compiled.totalSamples;
  const pick = stem === 'dialogue' ? [b.dialogue] : stem === 'music' ? (b.music ? [b.music] : []) : b.sfx;
  for (const l of [b.dialogue, ...(b.music ? [b.music] : []), ...b.sfx]) if (!pick.includes(l)) g.filters.push(`[${l}]anullsink`);
  let src: string;
  if (!pick.length) {
    src = label(g, 'silent');
    g.filters.push(`anullsrc=r=48000:cl=stereo,atrim=end_sample=${int(total, 1)}[${src}]`);
  } else if (pick.length === 1) src = pick[0]!;
  else {
    src = label(g, 'sum');
    g.filters.push(`${pick.map((p) => `[${p}]`).join('')}amix=inputs=${pick.length}:normalize=0:dropout_transition=0[${src}]`);
  }
  const out = label(g, 'stem');
  g.filters.push(`[${src}]${AFMT},apad=whole_len=${int(total, 1)},atrim=end_sample=${int(total, 1)},asetpts=N/SR/TB[${out}]`);
  return out;
}

const voiceOn = (c: ComposeContext) => c.plan.settings.studioVoice && c.plan.audio.dialogue.profile !== 'bypass';

/** First loudnorm pass: measures the mix. Null when Studio voice is off (no normalisation). */
export function measureGraph(c: ComposeContext): { g: Graph; out: string } | null {
  if (!voiceOn(c)) return null;
  const g = newGraph();
  const mix = mixGraph(g, c, true);
  const t = c.plan.audio.mixTarget;
  const out = label(g, 'meas');
  g.filters.push(`[${mix}]loudnorm=I=${dec(t.integratedLufs, -70, -5)}:TP=${dec(t.truePeakDbtp, -9, 0)}:LRA=11:print_format=json[${out}]`);
  return { g, out };
}

export function parseLoudnorm(stderr: string): LoudnormMeasure | null {
  const m = /\{[^{}]*"input_i"[^{}]*\}/.exec(stderr);
  if (!m) return null;
  const j = JSON.parse(m[0]) as Record<string, string>;
  const v = { input_i: +j.input_i!, input_tp: +j.input_tp!, input_lra: +j.input_lra!, input_thresh: +j.input_thresh!, target_offset: +j.target_offset! };
  // Silence measures -inf: there is nothing to normalise, and amplifying it is wrong (F11).
  return Object.values(v).every(Number.isFinite) && v.input_i > -70 ? v : null;
}

export const TP_MARGIN_DB = 1;

/** Final audio: mix, second-pass loudnorm (when measured), true-peak limiter, exact sample count. */
export function audioGraph(g: Graph, c: ComposeContext, measured: LoudnormMeasure | null): string {
  let cur = mixGraph(g, c, voiceOn(c));
  const t = c.plan.audio.mixTarget;
  if (measured) {
    const out = label(g, 'ln');
    g.filters.push(`[${cur}]loudnorm=I=${dec(t.integratedLufs, -70, -5)}:TP=${dec(t.truePeakDbtp, -9, 0)}:LRA=11` +
      `:measured_I=${dec(measured.input_i)}:measured_TP=${dec(measured.input_tp)}:measured_LRA=${dec(measured.input_lra)}` +
      `:measured_thresh=${dec(measured.input_thresh)}:offset=${dec(measured.target_offset)}:linear=true,aresample=48000[${out}]`);
    cur = out;
  }
  const total = c.compiled.totalSamples;
  const out = label(g, 'aout');
  // alimiter is sample-peak: it sits TP_MARGIN_DB under the true-peak target so inter-sample peaks and
  // AAC overshoot stay under it (at the target exactly, speech measured -0.96 dBTP against -1).
  g.filters.push(`[${cur}]alimiter=limit=${dec(10 ** ((t.truePeakDbtp - TP_MARGIN_DB) / 20), 0.0625, 1)}:level=disabled:attack=5:release=50,${AFMT},apad=whole_len=${int(total, 1)},atrim=end_sample=${int(total, 1)},asetpts=N/SR/TB[${out}]`);
  return out;
}
