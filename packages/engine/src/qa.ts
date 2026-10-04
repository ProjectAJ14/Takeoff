// QAService (PRD §11): file-level checks on a rendered MP4 against the compiled timeline.
// A check that did not run is `not_run` (or `skipped` with a reason), never `passed`.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { CompiledTimeline, EditPlan, PlanPatch, QACheck, QAIssue, QAReport, Severity } from '@takeoff/contracts';
import { extractFrame, hashFile, measureLoudness } from '@takeoff/media';
import { platformSafeArea, rectInside, type Rect } from '@takeoff/renderer-api';

const FFMPEG = process.env.TAKEOFF_FFMPEG ?? 'ffmpeg';
const FFPROBE = process.env.TAKEOFF_FFPROBE ?? 'ffprobe';
const MAX_CONTACT_FRAMES = 60;

/** What the renderer saw while drawing overlays. Every field is optional; a missing field means that check is `not_run`. */
export interface OverlayReport {
  /** Measured caption boxes in rendered pixels (a frame when known, else the union over the render). */
  captions?: Array<{ captionId: string; frame?: number; rect: Rect }>;
  /** Captions whose text overflowed its box. */
  captionFailures?: Array<{ captionId: string; code: string }>;
  /** Visuals whose scene failed to load, seek or fit. */
  visualFailures?: Array<{ visualId: string; code: string }>;
  /** Network requests a sandboxed scene attempted that were not declared. */
  undeclaredRequests?: number;
  /** Fonts the overlay page could not load. */
  missingFonts?: number;
  /** F08 face_crop samples: a confidently tracked face in rendered pixels, after crop and punch (renderer math). */
  faces?: Array<{ frame: number; rect: Rect }>;
}

export interface QaInput {
  renderPath: string;
  compiled: CompiledTimeline;
  plan: EditPlan;
  /** Dimensions the renderer declared for this file (a draft may be smaller than the plan's output). */
  width: number;
  height: number;
  overlay?: OverlayReport | null;
  /** Why no face was tracked (face_crop is then not_run with this reason). */
  faceNote?: string;
  /** Absolute directory for contact-sheet PNGs; omitted = contact sheet not_run. */
  framesDir?: string;
  signal?: AbortSignal;
}
export interface QaResult {
  report: QAReport;
  /** Contact-sheet output frames that were extracted, with their PNG file names inside framesDir. */
  frames: Array<{ frame: number; file: string }>;
}

function exec(bin: string, args: string[], signal?: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((ok, fail) => {
    execFile(bin, args, { signal, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (signal?.aborted) return fail(signal.reason);
      if (err && typeof (err as NodeJS.ErrnoException).code === 'string') return fail(err); // spawn failure (ENOENT)
      ok({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

const input = (p: string) => `file:${resolve(p)}`;
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** Output frames worth inspecting: opening, both sides of every cut, visual start/mid/end, the longest caption. */
export function contactFrames(compiled: CompiledTimeline, plan: EditPlan): number[] {
  const last = compiled.totalFrames - 1;
  if (last < 0) return [];
  const f = new Set<number>([0]);
  for (const s of compiled.segments.slice(1)) f.add(s.outputStartFrame - 1).add(s.outputStartFrame);
  for (const v of compiled.visuals) f.add(v.startFrame).add(Math.floor((v.startFrame + v.endFrame) / 2)).add(v.endFrame - 1);
  const text = new Map(plan.captions.map((c) => [c.id, c.text.length]));
  const longest = [...compiled.captions].sort((a, b) => (text.get(b.captionId) ?? 0) - (text.get(a.captionId) ?? 0))[0];
  if (longest) f.add(Math.floor((longest.startFrame + longest.endFrame) / 2));
  return [...f].filter((x) => x >= 0 && x <= last).sort((a, b) => a - b).slice(0, MAX_CONTACT_FRAMES);
}

export async function runQa(q: QaInput): Promise<QaResult> {
  const { compiled, plan } = q;
  const checks: QACheck[] = [];
  const issues: QAIssue[] = [];
  const check = (name: string, status: QACheck['status'], detail: string | null = null) => checks.push({ name, status, detail });
  const issue = (check: string, severity: Severity, evidence: string, extra: Partial<QAIssue> = {}) =>
    issues.push({ id: `qa_${String(issues.length + 1).padStart(4, '0')}`, severity, check, objectRef: null, frame: null, span: null, evidence, ...extra });
  const fail = (name: string, severity: Severity, evidence: string, extra: Partial<QAIssue> = {}) => {
    check(name, 'failed', evidence);
    issue(name, severity, evidence, extra);
  };

  // Full decode: any decoder error is critical.
  const dec = await exec(FFMPEG, ['-hide_banner', '-nostdin', '-v', 'error', '-i', input(q.renderPath), '-f', 'null', '-'], q.signal);
  if (dec.code !== 0 || dec.stderr.trim()) fail('decode', 'critical', 'the file does not decode cleanly');
  else check('decode', 'passed');

  const pr = await exec(FFPROBE, ['-v', 'error', '-count_packets', '-show_streams', '-of', 'json', input(q.renderPath)], q.signal);
  const streams = pr.code === 0 ? ((JSON.parse(pr.stdout) as { streams?: Array<Record<string, any>> }).streams ?? []) : [];
  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  if (!v) fail('video_stream', 'critical', 'no video stream');
  if (!a) fail('audio_stream', 'critical', 'no audio stream');

  if (v) {
    const frames = Number(v.nb_read_packets);
    if (frames === compiled.totalFrames) check('duration_frames', 'passed', `${frames} frames`);
    else fail('duration_frames', 'critical', `file has ${frames} frames; the timeline has ${compiled.totalFrames}`);
    if (v.width === q.width && v.height === q.height) check('dimensions', 'passed', `${v.width}x${v.height}`);
    else fail('dimensions', 'critical', `file is ${v.width}x${v.height}; expected ${q.width}x${q.height}`);
    const [n, d] = String(v.r_frame_rate).split('/').map(Number) as [number, number];
    const g = gcd(compiled.fps.num, compiled.fps.den);
    const k = n && d ? gcd(n, d) : 1;
    if (n / k === compiled.fps.num / g && d / k === compiled.fps.den / g) check('frame_rate', 'passed', `${n}/${d}`);
    else fail('frame_rate', 'critical', `file is ${v.r_frame_rate} fps; expected ${compiled.fps.num}/${compiled.fps.den}`);
    if (v.pix_fmt === 'yuv420p') check('pix_fmt', 'passed', 'yuv420p');
    else fail('pix_fmt', 'warning', `pixel format is ${String(v.pix_fmt).slice(0, 32)}; expected yuv420p`);
    const tags = [v.color_space, v.color_primaries, v.color_transfer];
    if (tags.every((t) => t === 'bt709')) check('color_tags', 'passed', 'bt709');
    else fail('color_tags', 'warning', `color tags are ${tags.map((t) => String(t ?? 'unset').slice(0, 16)).join('/')}; expected bt709`);
  }
  if (a) {
    const [tn, td] = String(a.time_base).split('/').map(Number) as [number, number];
    const samples = Math.round((Number(a.duration_ts) * tn * 48000) / td);
    const perFrame = Math.ceil((48000 * compiled.fps.den) / compiled.fps.num);
    if (Number(a.sample_rate) !== 48000) fail('audio_samples', 'critical', `audio is ${a.sample_rate} Hz; expected 48000`);
    else if (Math.abs(samples - compiled.totalSamples) <= perFrame) check('audio_samples', 'passed', `${samples} samples`);
    else fail('audio_samples', 'critical', `audio has ${samples} samples; the timeline has ${compiled.totalSamples}`);

    const target = plan.audio.mixTarget;
    const l = await measureLoudness(q.renderPath, q.signal).catch(() => null);
    if (!l) {
      check('loudness', 'not_run', 'loudness measurement failed');
      check('true_peak', 'not_run', 'loudness measurement failed');
    } else if (l.integratedLufs === null) {
      check('loudness', 'skipped', 'digital silence; nothing to measure');
      check('true_peak', 'skipped', 'digital silence; nothing to measure');
    } else {
      const tp = l.truePeakDbtp;
      if (tp === null) check('true_peak', 'not_run', 'true peak was not measured');
      else if (tp > -0.1) fail('true_peak', 'critical', `true peak ${tp.toFixed(1)} dBTP clips`);
      else if (tp > target.truePeakDbtp) fail('true_peak', 'warning', `true peak ${tp.toFixed(1)} dBTP is above the ${target.truePeakDbtp} dBTP target`);
      else check('true_peak', 'passed', `${tp.toFixed(1)} dBTP`);
      const off = l.integratedLufs - target.integratedLufs;
      if (Math.abs(off) > 1) fail('loudness', 'warning', `integrated loudness ${l.integratedLufs.toFixed(1)} LUFS is outside ${target.integratedLufs} ±1 LU`);
      else check('loudness', 'passed', `${l.integratedLufs.toFixed(1)} LUFS`);
    }
  }

  // Overlay checks come from the renderer's own measurements.
  const ov = q.overlay ?? null;
  if (ov?.captions) {
    const safe = platformSafeArea(q.width, q.height);
    const byId = new Map(plan.captions.map((c) => [c.id, c]));
    const bad = [
      ...ov.captions.filter((c) => !rectInside(c.rect, safe)).map((c) => ({ captionId: c.captionId, frame: c.frame ?? null, why: 'caption box leaves the platform safe area' })),
      ...(ov.captionFailures ?? []).map((c) => ({ captionId: c.captionId, frame: null, why: 'caption text overflows its box' })),
    ];
    for (const c of bad) {
      const cap = byId.get(c.captionId);
      const fixable = cap && !cap.locked && cap.template !== 'static';
      const suggestedPatch: PlanPatch | undefined = fixable ? { schemaVersion: '1.0', baseRevision: plan.revision, ops: [{ op: 'set_caption', captionId: c.captionId, template: 'static' }] } : undefined;
      issue('caption_bounds', 'critical', c.why, { objectRef: byId.has(c.captionId) ? c.captionId : null, frame: c.frame, ...(suggestedPatch && { suggestedPatch }) });
    }
    check('caption_bounds', bad.length ? 'failed' : 'passed', `${ov.captions.length} caption boxes measured, ${bad.length} problem(s)`);
  } else check('caption_bounds', 'not_run', 'the renderer reported no caption measurements');

  if (ov?.visualFailures) {
    const byId = new Map(plan.visuals.map((x) => [x.id, x]));
    for (const f of ov.visualFailures) {
      const vis = byId.get(f.visualId);
      const suggestedPatch: PlanPatch | undefined = vis && !vis.locked ? { schemaVersion: '1.0', baseRevision: plan.revision, ops: [{ op: 'remove_visual', visualId: f.visualId }] } : undefined;
      issue('visual_render', 'critical', `visual failed to render (${/^[a-z_]{1,32}$/.test(f.code) ? f.code : 'error'}); fallback ${vis?.fallback ?? 'omit'}`, { objectRef: vis ? f.visualId : null, ...(suggestedPatch && { suggestedPatch }) });
    }
    check('visual_render', ov.visualFailures.length ? 'failed' : 'passed', `${ov.visualFailures.length} failed`);
  } else check('visual_render', 'not_run', 'the renderer reported no scene status');

  if (typeof ov?.undeclaredRequests === 'number') {
    if (ov.undeclaredRequests > 0) fail('undeclared_network', 'critical', `${ov.undeclaredRequests} undeclared network request(s) from scenes`);
    else check('undeclared_network', 'passed');
  } else check('undeclared_network', 'not_run', 'the renderer reported no network audit');
  if (typeof ov?.missingFonts === 'number') {
    if (ov.missingFonts > 0) fail('fonts', 'warning', `${ov.missingFonts} font(s) fell back to a bundled default`);
    else check('fonts', 'passed');
  } else check('fonts', 'not_run', null);
  // F08: every sampled face (confidence ≥ 0.5) must lie inside the frame, padded by 2% for rounding: the crop keeps the face.
  if (ov?.faces?.length) {
    const pad = Math.ceil(q.width * 0.02);
    const out = ov.faces.filter((f) => f.rect.x < -pad || f.rect.y < -pad || f.rect.x + f.rect.w > q.width + pad || f.rect.y + f.rect.h > q.height + pad);
    for (const f of out) issue('face_crop', 'warning', 'the tracked face leaves the crop', { frame: f.frame });
    check('face_crop', out.length ? 'failed' : 'passed', `${ov.faces.length} face sample(s), ${out.length} outside the crop`);
  } else check('face_crop', 'not_run', q.faceNote ?? (ov?.faces ? 'no face was tracked with confidence ≥ 0.5' : 'the renderer reported no face measurements'));

  const frames: QaResult['frames'] = [];
  if (q.framesDir && v) {
    await mkdir(q.framesDir, { recursive: true });
    const { num, den } = compiled.fps;
    let failed = 0;
    for (const frame of contactFrames(compiled, plan)) {
      const file = `f${String(frame).padStart(6, '0')}.png`;
      // Mid-frame instant, so the extractor lands on this frame and never its neighbour.
      const us = Math.floor(((2 * frame + 1) * den * 1e6) / (2 * num));
      try {
        await extractFrame(q.renderPath, us, join(q.framesDir, file), { signal: q.signal });
        frames.push({ frame, file });
      } catch (e) {
        if (q.signal?.aborted) throw e;
        failed++;
      }
    }
    if (failed) fail('contact_sheet', 'warning', `${failed} contact-sheet frame(s) could not be extracted`);
    else check('contact_sheet', 'passed', `${frames.length} frames extracted for inspection`);
  } else check('contact_sheet', 'not_run', null);

  const report: QAReport = {
    schemaVersion: '1.0',
    id: randomUUID(),
    planHash: compiled.planHash,
    artifactHash: await hashFile(q.renderPath).catch(() => null),
    createdAt: new Date().toISOString(),
    issues,
    checks,
  };
  return { report, frames };
}

export const hasCritical = (r: QAReport): boolean => r.issues.some((i) => i.severity === 'critical');
