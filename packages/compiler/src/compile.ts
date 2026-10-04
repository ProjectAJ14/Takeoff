// Plan validation (PRD 9.2) and the source -> output compiler (PRD 7.4).
import { createHash } from 'node:crypto';
import {
  validate,
  type Anchor,
  type AssetKind,
  type AssetManifest,
  type CompiledTimeline,
  type EditPlan,
  type Id,
  type Rational,
  type Segment,
  type Settings,
  type Transcript,
  type TranscriptWord,
  type Visual,
  type Warning,
} from '@takeoff/contracts';
import { framesToSamples, frameToUs, SAMPLE_RATE, usToFrames, usToSamples } from './clock.ts';

export const COMPILER_VERSION = '0.1.0';
/** PRD F08: punch zooms never exceed 1.25. */
export const MAX_PUNCH_SCALE = 1.25;

export interface Limits {
  /** Clamped to MAX_PUNCH_SCALE. */
  maxPunchScale?: number;
  minGainDb?: number;
  maxGainDb?: number;
}
export interface PlanContext {
  /** Transcripts keyed by assetId. */
  transcripts: Readonly<Record<Id, Transcript>>;
  /** Asset manifests keyed by asset id. */
  manifests: Readonly<Record<Id, AssetManifest>>;
  limits?: Limits;
}
/** Same shape as a contracts Warning; `code` is stable, `refs` are object ids. Messages never carry transcript text or paths. */
export type Issue = Warning;
export interface ValidationReport {
  errors: Issue[];
  warnings: Issue[];
}

export class CompileError extends Error {
  code = 'invalid_plan';
  issues: Issue[];
  constructor(issues: Issue[]) {
    super(`plan has ${issues.length} error(s): ${issues.map((i) => i.code).join(', ')}`);
    this.name = 'CompileError';
    this.issues = issues;
  }
}

/** Own-property lookup, so an id like "constructor" never resolves to Object.prototype. */
export const own = <V>(rec: Readonly<Record<string, V>>, key: string): V | undefined =>
  Object.hasOwn(rec, key) ? rec[key] : undefined;

// ---------- placement: shared by compile and the mapping functions ----------

interface Placed {
  seg: Segment;
  /** floor of the cumulative retained duration before this segment, so rounding never accumulates. */
  startFrame: number;
  endFrame: number;
}

function place(segments: Segment[], fps: Rational): { placed: Placed[]; totalFrames: number } {
  // BigInt: schema spans reach 2^53 - 1 each, so a Number sum over many segments could lose precision.
  let cum = 0n;
  const placed = segments.map((seg) => {
    const startUs = cum;
    cum += BigInt(seg.sourceEndUs - seg.sourceStartUs);
    return { seg, startFrame: usToFrames(startUs, fps), endFrame: usToFrames(cum, fps) };
  });
  return { placed, totalFrames: usToFrames(cum, fps) };
}

/**
 * Frame for a source instant inside [sourceStartUs, sourceEndUs] of a placed segment.
 * Each segment starts on its frame boundary and plays from sourceStartUs (video and audio alike),
 * so its frame count is within one frame of its source duration and never drifts across cuts.
 * Never exceeds the segment's endFrame: floor(d') <= floor(a + d) - floor(a) for d' <= d.
 */
const boundary = (pl: Placed, us: number, fps: Rational): number =>
  pl.startFrame + usToFrames(us - pl.seg.sourceStartUs, fps);

type Timed = Pick<EditPlan, 'segments' | 'output'>;

/** Output frame showing source instant `us` of `assetId`, or null when that instant is not shown. First matching segment wins. */
export function sourceToOutput(plan: Timed, assetId: Id, us: number): number | null {
  const fps = plan.output.fps;
  for (const pl of place(plan.segments, fps).placed) {
    const { seg } = pl;
    if (seg.assetId !== assetId || us < seg.sourceStartUs || us >= seg.sourceEndUs) continue;
    // A sub-frame tail that falls where the next segment's first frame begins is not shown.
    const f = boundary(pl, us, fps);
    if (f < pl.endFrame) return f;
  }
  return null;
}

/** Source instant shown at the start of output `frame`, or null past the end. */
export function outputToSource(plan: Timed, frame: number): { segmentId: Id; assetId: Id; us: number } | null {
  const fps = plan.output.fps;
  const pl = place(plan.segments, fps).placed.find((p) => frame >= p.startFrame && frame < p.endFrame);
  if (!pl) return null;
  const us = pl.seg.sourceStartUs + frameToUs(frame - pl.startFrame, fps);
  return { segmentId: pl.seg.id, assetId: pl.seg.assetId, us: Math.min(us, pl.seg.sourceEndUs - 1) };
}

// ---------- canonical hash ----------

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}
export const planHash = (plan: EditPlan): string => createHash('sha256').update(canonical(plan)).digest('hex');

// ---------- validation + compilation ----------

function visualEnabled(v: Visual, s: Settings): boolean {
  if (v.kind === 'motion_template') return s.motionGraphics;
  if (v.kind === 'broll') return s.userBroll || s.aiBroll;
  return s.textHook;
}

function analyze(input: unknown, ctx: PlanContext): ValidationReport & { timeline?: CompiledTimeline } {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const err = (code: string, message: string, ...refs: Id[]) => void errors.push({ code, message, refs });
  const warn = (code: string, message: string, ...refs: Id[]) => void warnings.push({ code, message, refs });

  // Schema first: nothing below is safe on a malformed document (unknown versions and enums fail here).
  const schema = validate('edit-plan', input);
  if (!schema.ok) {
    for (const e of schema.errors) err('schema', `${e.path || '/'}: ${e.message}`);
    return { errors, warnings };
  }
  for (const [key, t] of Object.entries(ctx.transcripts)) {
    const r = validate('transcript', t);
    if (!r.ok) err('context_schema', `transcript for ${key} is malformed`, key);
    else if (t.assetId !== key) err('context_schema', `transcript keyed ${key} belongs to ${t.assetId}`, key);
  }
  for (const [key, m] of Object.entries(ctx.manifests)) {
    const r = validate('asset-manifest', m);
    if (!r.ok) err('context_schema', `manifest for ${key} is malformed`, key);
    else if (m.id !== key) err('context_schema', `manifest keyed ${key} belongs to ${m.id}`, key);
  }
  if (errors.length) return { errors, warnings };

  const p = schema.value;
  const fps = p.output.fps;
  const s = p.settings;
  const maxScale = Math.min(MAX_PUNCH_SCALE, ctx.limits?.maxPunchScale ?? MAX_PUNCH_SCALE);
  const minGain = ctx.limits?.minGainDb ?? -60;
  const maxGain = ctx.limits?.maxGainDb ?? 12;

  // Object ids must be unique: locks and patches address objects by id.
  const seen = new Set<Id>();
  const objects = [...p.decisions, ...p.segments, ...p.captions, ...p.visuals, ...p.transforms, ...p.audio.sfx, ...p.reviewMarkers];
  for (const { id } of objects) {
    if (seen.has(id)) err('duplicate_id', `id ${id} is used more than once`, id);
    seen.add(id);
  }
  const planAssets = new Map(p.assets.map((a) => [a.id, a]));
  if (planAssets.size !== p.assets.length) err('duplicate_id', 'asset ids repeat');

  // `kinds` is the role's allowed asset kinds: an image has no duration, so it must never stand in for speech or audio.
  const asset = (id: Id, ref: Id, kinds: readonly AssetKind[] = ['video', 'audio', 'image']): AssetManifest | null => {
    const a = planAssets.get(id);
    const m = own(ctx.manifests, id);
    if (!a || !m) return err('asset_unresolved', `asset ${id} is not in the plan or has no manifest`, ref, id), null;
    if (m.kind !== a.kind) return err('asset_unresolved', `asset ${id} is ${m.kind}, plan says ${a.kind}`, ref, id), null;
    if (!kinds.includes(m.kind)) return err('asset_unresolved', `${ref} cannot use ${m.kind} asset ${id}`, ref, id), null;
    return m;
  };
  const MEDIA: readonly AssetKind[] = ['video', 'audio'];
  const span = (ref: Id, assetId: Id, start: number, end: number, kinds = MEDIA): boolean => {
    const m = asset(assetId, ref, kinds);
    if (start >= end) return err('impossible_range', `${ref} has an empty or reversed source span`, ref), false;
    if (!m) return false;
    const d = m.probe.durationUs;
    if (m.kind !== 'image' && (d === null || end > d)) return err('source_bounds', `${ref} exceeds the source duration of ${assetId}`, ref, assetId), false;
    return true;
  };
  for (const a of p.assets) asset(a.id, a.id);

  const words = new Map<Id, Map<Id, TranscriptWord>>();
  for (const t of Object.values(ctx.transcripts)) words.set(t.assetId, new Map(t.words.map((w) => [w.id, w])));
  const word = (assetId: Id, id: Id) => words.get(assetId)?.get(id);

  for (const d of p.decisions) {
    span(d.id, d.assetId, d.sourceStartUs, d.sourceEndUs);
    if (d.action === 'review') warn('uncertain_retake', `decision ${d.id} needs review`, d.id);
  }

  const segById = new Map(p.segments.map((g) => [g.id, g]));
  for (const g of p.segments) {
    span(g.id, g.assetId, g.sourceStartUs, g.sourceEndUs);
    // PRD F14: no speech acceleration unless separately enabled; no setting enables it yet.
    if (g.speed.num !== g.speed.den) err('speed_unsupported', `segment ${g.id} changes speed`, g.id);
    for (const id of g.wordIds) {
      const w = word(g.assetId, id);
      if (!w) err('word_unresolved', `segment ${g.id} word ${id} is not in the transcript of ${g.assetId}`, g.id, id);
      else if (w.sourceStartUs < g.sourceStartUs || w.sourceEndUs > g.sourceEndUs) err('word_outside_segment', `word ${id} lies outside segment ${g.id}`, g.id, id);
    }
  }
  for (const c of p.captions) {
    const g = segById.get(c.segmentId);
    if (!g) {
      err('segment_unresolved', `caption ${c.id} names missing segment ${c.segmentId}`, c.id);
      continue;
    }
    const kept = new Set(g.wordIds);
    for (const id of c.wordIds) if (!kept.has(id)) err('caption_word_removed', `caption ${c.id} word ${id} does not survive the edit`, c.id, id);
    for (const id of c.emphasisWordIds) if (!c.wordIds.includes(id)) err('emphasis_word_missing', `caption ${c.id} emphasises ${id}, which it does not show`, c.id, id);
  }

  // Anchored objects whose word was cut are orphaned: warned and left out of the timeline, never guessed.
  const anchorTarget = (ref: Id, segmentId: Id | null, a: Anchor): { seg: Segment; w: TranscriptWord } | null => {
    const seg = segmentId === null ? p.segments.find((g) => g.wordIds.includes(a.wordId)) : segById.get(segmentId);
    const w = seg && seg.wordIds.includes(a.wordId) ? word(seg.assetId, a.wordId) : undefined;
    if (!seg || !w) return warn('orphaned_anchor', `${ref} is anchored to word ${a.wordId}, which is not in its segment`, ref, a.wordId), null;
    return { seg, w };
  };
  for (const v of p.visuals) if (v.kind === 'broll') span(v.id, v.assetId, v.sourceStartUs, v.sourceEndUs, ['video', 'image']);
  for (const t of p.transforms) {
    if (t.kind === 'punch' && t.scale > maxScale) err('limit_exceeded', `transform ${t.id} scale exceeds ${maxScale}`, t.id);
    if (t.kind === 'crop') {
      const r = t.rect;
      if (r.width <= 0 || r.height <= 0 || r.x + r.width > 1 || r.y + r.height > 1) err('limit_exceeded', `crop ${t.id} leaves the source frame`, t.id);
    }
  }
  const gain = (ref: Id, g: number) => {
    if (g < minGain || g > maxGain) err('limit_exceeded', `${ref} gain ${g} dB is outside [${minGain}, ${maxGain}]`, ref);
  };
  const music = p.audio.music;
  if (music) {
    asset(music.assetId, music.assetId, ['audio']);
    gain(music.assetId, music.gainDb);
  }
  for (const x of p.audio.sfx) {
    const m = asset(x.assetId, x.id, ['audio']);
    if (m && m.probe.durationUs === null) err('source_bounds', `sfx ${x.id} asset has no duration`, x.id, x.assetId);
    gain(x.id, x.gainDb);
  }
  for (const r of p.reviewMarkers) warn(r.kind, r.message, r.id, ...r.refs);

  if (errors.length) return { errors, warnings };

  // ---- output time: everything below is in frames/samples of the compiled timeline ----
  const { placed, totalFrames } = place(p.segments, fps);
  const placedById = new Map(placed.map((pl) => [pl.seg.id, pl]));
  const totalSamples = framesToSamples(totalFrames, fps);
  for (const pl of placed) if (pl.startFrame === pl.endFrame) warn('segment_below_one_frame', `segment ${pl.seg.id} is shorter than one frame`, pl.seg.id);

  const at = (seg: Segment, w: TranscriptWord, a: Anchor) => {
    const pl = placedById.get(seg.id)!;
    return boundary(pl, a.edge === 'start' ? w.sourceStartUs : w.sourceEndUs, fps) + a.offsetFrames;
  };
  const fits = (ref: Id, start: number, end: number): boolean => {
    if (start < 0 || end > totalFrames || start >= end) return err('track_exceeds_timeline', `${ref} spans frames [${start},${end}) outside [0,${totalFrames})`, ref), false;
    return true;
  };

  const tl: CompiledTimeline = {
    schemaVersion: '1.0',
    planHash: planHash(p),
    compilerVersion: COMPILER_VERSION,
    fps,
    width: p.output.width,
    height: p.output.height,
    totalFrames,
    sampleRate: SAMPLE_RATE,
    totalSamples,
    segments: placed.map((pl) => ({
      segmentId: pl.seg.id,
      assetId: pl.seg.assetId,
      sourceStartUs: pl.seg.sourceStartUs,
      sourceEndUs: pl.seg.sourceEndUs,
      outputStartFrame: pl.startFrame,
      outputEndFrame: pl.endFrame,
      outputStartSample: framesToSamples(pl.startFrame, fps),
      outputEndSample: framesToSamples(pl.endFrame, fps),
    })),
    captions: [],
    visuals: [],
    transforms: [],
    audioEvents: placed.map((pl) => ({
      id: pl.seg.id,
      kind: 'dialogue' as const,
      assetId: pl.seg.assetId,
      startSample: framesToSamples(pl.startFrame, fps),
      endSample: framesToSamples(pl.endFrame, fps),
      gainDb: 0,
    })),
    warnings,
  };

  // PRD F06: caption timing comes from the final word mapping; disabled captions produce no layer.
  if (s.captions) {
    for (const c of p.captions) {
      const pl = placedById.get(c.segmentId)!;
      const ws = c.wordIds.map((id) => {
        const w = word(pl.seg.assetId, id)!;
        return { wordId: id, startFrame: boundary(pl, w.sourceStartUs, fps), endFrame: boundary(pl, w.sourceEndUs, fps) };
      });
      if (!ws.length) continue;
      tl.captions.push({
        captionId: c.id,
        startFrame: Math.min(...ws.map((w) => w.startFrame)),
        endFrame: Math.max(...ws.map((w) => w.endFrame)),
        words: ws,
      });
    }
  }
  for (const v of p.visuals) {
    const hit = anchorTarget(v.id, v.segmentId, v.anchor);
    if (!hit || !visualEnabled(v, s)) continue;
    const start = at(hit.seg, hit.w, v.anchor);
    if (fits(v.id, start, start + v.durationFrames)) tl.visuals.push({ visualId: v.id, kind: v.kind, startFrame: start, endFrame: start + v.durationFrames });
  }
  for (const t of p.transforms) {
    if (t.kind === 'crop') {
      const pl = placedById.get(t.segmentId);
      if (!pl) warn('orphaned_anchor', `crop ${t.id} names missing segment ${t.segmentId}`, t.id);
      else if (pl.endFrame > pl.startFrame) tl.transforms.push({ transformId: t.id, kind: 'crop', startFrame: pl.startFrame, endFrame: pl.endFrame });
      continue;
    }
    const hit = anchorTarget(t.id, t.segmentId, t.anchor);
    if (!hit || !s.zoom) continue;
    const start = at(hit.seg, hit.w, t.anchor);
    // Without an explicit duration a punch holds to the end of its segment.
    const end = t.durationFrames !== undefined ? start + t.durationFrames : placedById.get(hit.seg.id)!.endFrame;
    if (fits(t.id, start, end)) tl.transforms.push({ transformId: t.id, kind: 'punch', startFrame: start, endFrame: end });
  }
  if (music && s.music && fits(music.assetId, music.startFrame, music.startFrame + music.durationFrames)) {
    tl.audioEvents.push({
      id: music.assetId,
      kind: 'music',
      assetId: music.assetId,
      startSample: framesToSamples(music.startFrame, fps),
      endSample: framesToSamples(music.startFrame + music.durationFrames, fps),
      gainDb: music.gainDb,
    });
  }
  for (const x of p.audio.sfx) {
    const hit = anchorTarget(x.id, null, x.anchor);
    if (!hit || !s.sfx) continue;
    const start = at(hit.seg, hit.w, x.anchor);
    if (!fits(x.id, start, start + 1)) continue;
    const startSample = framesToSamples(start, fps);
    const len = usToSamples(own(ctx.manifests, x.assetId)!.probe.durationUs!);
    tl.audioEvents.push({ id: x.id, kind: 'sfx', assetId: x.assetId, startSample, endSample: Math.min(totalSamples, startSample + len), gainDb: x.gainDb });
  }

  // PRD F14: duration is measured after compilation; a hard maximum is never exceeded in frames.
  const target = p.output.targetFrames;
  if (target !== null && p.output.lengthPolicy === 'hard_max' && totalFrames > target) {
    const lockedFrames = usToFrames(p.segments.filter((g) => g.locked).reduce((n, g) => n + BigInt(g.sourceEndUs - g.sourceStartUs), 0n), fps);
    // Essential speech that cannot fit (locked by the user, or declared by the director with a critical
    // duration_conflict marker) yields a longer draft with an explicit conflict; final export stays blocked.
    const declared = p.reviewMarkers.some((r) => r.kind === 'duration_conflict' && r.severity === 'critical');
    if (lockedFrames > target || declared) {
      warn('locked_duration_conflict', `essential speech needs ${totalFrames} frames (${lockedFrames} locked); hard maximum is ${target}`, ...p.segments.filter((g) => g.locked).map((g) => g.id));
    } else err('hard_max_exceeded', `timeline is ${totalFrames} frames; hard maximum is ${target}`);
  }
  if (target !== null && p.output.lengthPolicy === 'soft_target') {
    // PRD F14: ±10% or ±2 s, whichever is greater. Exact integer test; rounding 10% up would admit a miss.
    const miss = Math.abs(totalFrames - target);
    if (miss * 10 > target && miss > usToFrames(2_000_000, fps)) warn('soft_target_missed', `timeline is ${totalFrames} frames; target is ${target}`);
  }

  return errors.length ? { errors, warnings } : { errors, warnings, timeline: tl };
}

/** Warnings that allow a draft but block a final export (PRD F14: never a falsely compliant export). */
const EXPORT_BLOCKING = new Set(['locked_duration_conflict']);
export const isExportBlocking = (issue: Pick<Issue, 'code'>): boolean => EXPORT_BLOCKING.has(issue.code);

/** PRD 9.2 rules. Errors block render; warnings allow a draft and travel into the compiled timeline. */
export function validatePlan(plan: unknown, ctx: PlanContext): ValidationReport {
  const { errors, warnings } = analyze(plan, ctx);
  return { errors, warnings };
}

/** Deterministic: the same plan and context always produce the same timeline. Throws CompileError on any hard error. */
export function compile(plan: unknown, ctx: PlanContext): CompiledTimeline {
  const r = analyze(plan, ctx);
  if (!r.timeline) throw new CompileError(r.errors);
  return r.timeline;
}
