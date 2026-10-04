// Pure UI logic: toggle catalogue and defaults (PRD 5.2, §6), target length, Edit Video blockers, stage
// timing, announcement throttling and plan read-outs. No DOM, no fetch: unit-tested under node:test.
import type { BooleanSettingKey, Capabilities, CaptionTemplate, Decision, EditPlan, FeatureId, FillerStrength, Job, JobStage, Settings, Transcript } from '@takeoff/contracts';

export type FeatureStatus = Capabilities['features'][number]['status'];
export type Availability = { status: FeatureStatus; reason: string | null };

export interface ToggleDef {
  key: BooleanSettingKey;
  /** Product toggle name, verbatim (PRD 5.2; F11 is labelled Studio voice). */
  name: string;
  feature: FeatureId;
  info: string;
  /** Recommended new-product default (PRD 5.2). */
  on: boolean;
  /** P1 features ship visibly unavailable whatever the machine can do. */
  unshipped?: string;
}

export const TOGGLES: readonly ToggleDef[] = [
  { key: 'badTakes', name: 'Bad takes', feature: 'F03', on: true, info: 'Removes false starts and repeated attempts, keeping the complete take. Ambiguous takes stay in with a review marker.' },
  { key: 'fillers', name: 'Fillers', feature: 'F04', on: true, info: 'Removes “um”, “uh” and empty discourse markers. Fillers that overlap real words or have uncertain timing are kept.' },
  { key: 'silence', name: 'Silence/dead air', feature: 'F05', on: true, info: 'Shortens pauses of 0.7 s or more to about 0.3 s and trims dead air at the start and end. It never cuts into speech.' },
  { key: 'captions', name: 'Animated captions', feature: 'F06', on: true, info: 'Adds 2–7 word captions timed to your speech, inside the platform safe area. Exports also get SRT, VTT and word-timed JSON.' },
  { key: 'aiBroll', name: 'AI-found B-roll', feature: 'F07', on: false, unshipped: 'AI-found B-roll is planned for a later release (P1).', info: 'Would select stock or local footage that matches what you say.' },
  { key: 'userBroll', name: 'Own B-roll', feature: 'F07', on: false, info: 'Places clips from your own B-roll pool over matching moments without muting you.' },
  { key: 'zoom', name: 'Zooms', feature: 'F08', on: true, info: 'Gentle punch-in zooms on emphasised words, at most about four per 30 seconds, never past your maximum.' },
  { key: 'music', name: 'Background music', feature: 'F09', on: false, info: 'Adds a licensed local track, ducked under your voice. Nothing is downloaded while editing.' },
  { key: 'sfx', name: 'Sound effects', feature: 'F10', on: false, info: 'Adds restrained clicks, hits or whooshes to visual moments. Never one per word.' },
  { key: 'studioVoice', name: 'Studio voice', feature: 'F11', on: true, info: 'Cleans up your dialogue: gentle EQ, noise reduction, compression and loudness to −14 LUFS. Cleanup, not restoration.' },
  { key: 'autoColor', name: 'Auto color', feature: 'F12', on: true, info: 'Subtle exposure, white balance and contrast correction per take. SDR only.' },
  { key: 'textHook', name: 'Text hook', feature: 'F13', on: false, info: 'Adds a short title in the first three seconds, taken from what you actually say.' },
  { key: 'motionGraphics', name: 'Motion graphics', feature: 'F15', on: false, info: 'Adds kinetic text, flow diagrams or lists where they help explain, labelled with your own words.' },
];

export const CREATOR_POLISH: readonly BooleanSettingKey[] = ['music', 'sfx', 'motionGraphics'];

export interface EditOptions {
  settings: Settings;
  captionTemplate: CaptionTemplate;
  zoomMaxScale: number;
}

export const ZOOM_MAX_OPTIONS = [1.1, 1.15, 1.2, 1.25] as const;
export const FILLER_STRENGTHS: readonly FillerStrength[] = ['conservative', 'normal', 'aggressive'];
export const CAPTION_STYLES: readonly CaptionTemplate[] = ['restrained', 'energetic', 'static'];

export function defaultEdits(): EditOptions {
  const settings = Object.fromEntries(TOGGLES.map((t) => [t.key, t.on])) as Record<BooleanSettingKey, boolean>;
  return { settings: { ...settings, networkPolicy: 'local_only', fillerStrength: 'normal' }, captionTemplate: 'restrained', zoomMaxScale: 1.15 };
}

/** Creator polish: the recommended defaults plus licensed local music, SFX and template motion. */
export function creatorPolish(e: EditOptions): EditOptions {
  return { ...e, settings: { ...e.settings, ...Object.fromEntries(CREATOR_POLISH.map((k) => [k, true])) } };
}

export function availability(t: ToggleDef, caps: Capabilities | null): Availability {
  if (t.unshipped) return { status: 'unavailable', reason: t.unshipped };
  const f = caps?.features.find((x) => x.id === t.feature);
  if (!f) return { status: 'unavailable', reason: caps ? 'This build does not report this feature.' : 'Checking what this computer can do…' };
  return { status: f.status, reason: f.reason };
}

/** What Edit Video sends: an unavailable toggle is off, never silently "on but ignored". */
export function effectiveSettings(s: Settings, caps: Capabilities | null): Settings {
  const out = { ...s };
  for (const t of TOGGLES) if (availability(t, caps).status === 'unavailable') out[t.key] = false;
  return out;
}

// ---------- target length (PRD 5.2, F14) ----------

export const TARGET_CHOICES = ['auto', '15', '30', '45', '60', '90', 'custom'] as const;
export type TargetChoice = (typeof TARGET_CHOICES)[number];
export const targetLabel = (c: TargetChoice) => (c === 'auto' ? 'Auto' : c === 'custom' ? 'Custom' : `${c}s`);

export function parseTarget(choice: TargetChoice, custom: string): { seconds: number | null; error: string | null } {
  if (choice === 'auto') return { seconds: null, error: null };
  if (choice !== 'custom') return { seconds: Number(choice), error: null };
  const n = Number(custom.trim());
  if (!custom.trim() || !Number.isInteger(n) || n < 10 || n > 180) return { seconds: null, error: 'Enter a whole number of seconds from 10 to 180.' };
  return { seconds: n, error: null };
}

export function lengthPolicy(seconds: number | null, hardMax: boolean): 'none' | 'hard_max' | 'soft_target' {
  return seconds === null ? 'none' : hardMax ? 'hard_max' : 'soft_target';
}

// ---------- Edit Video blockers ----------

export interface CreateState {
  projectFolder: string | null;
  selectedTakes: number;
  importing: boolean;
  targetError: string | null;
  caps: Capabilities | null;
}

/** The one concrete blocking issue and its remedy, or null when Edit Video can run (PRD 5.2). */
export function editBlocker(s: CreateState): string | null {
  if (!s.caps) return 'Checking what this computer can do. This takes a few seconds.';
  const f = (id: FeatureId) => s.caps!.features.find((x) => x.id === id);
  if (f('F01')?.status === 'unavailable') return `Footage can't be read: ${f('F01')!.reason ?? 'FFmpeg is missing'}. Install FFmpeg, then reopen Takeoff.`;
  if (f('F02')?.status === 'unavailable') return `Transcription isn't set up: ${f('F02')!.reason ?? 'no model'}. Install the starter pack in Settings › First run.`;
  if (!s.projectFolder) return 'Choose a project folder first.';
  if (s.importing) return 'Wait for the import to finish.';
  if (s.selectedTakes === 0) return 'Add at least one take and keep it selected.';
  if (s.targetError) return s.targetError;
  return null;
}

// ---------- take order ----------

export function move<T>(list: readonly T[], index: number, delta: -1 | 1): T[] {
  const to = index + delta;
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return [...list];
  const out = [...list];
  [out[index], out[to]] = [out[to]!, out[index]!];
  return out;
}

// ---------- processing ----------

export const STAGES: readonly JobStage[] = ['Prepare', 'Transcribe', 'Clean speech', 'Plan visuals/audio', 'Build graphics', 'Render preview', 'Check quality'];

export interface StageView {
  stage: JobStage;
  state: 'pending' | 'running' | 'done' | 'failed' | 'canceled';
  /** 0..1 only when the engine measured it; otherwise show elapsed time. */
  progress: number | null;
  startedAt: number | null;
  endedAt: number | null;
}

/** Folds a job update into per-stage views. Stage start times come from when the UI first saw the stage. */
export function foldJob(prev: StageView[] | null, job: Job, now: number, stages: readonly JobStage[] = STAGES): StageView[] {
  const views = prev ?? stages.map((stage) => ({ stage, state: 'pending' as const, progress: null, startedAt: null, endedAt: null }));
  const at = stages.indexOf(job.stage);
  return views.map((v, i) => {
    if (job.state === 'succeeded') return { ...v, state: 'done', progress: null, startedAt: v.startedAt ?? now, endedAt: v.endedAt ?? now };
    if (i < at) return { ...v, state: 'done', progress: null, startedAt: v.startedAt ?? now, endedAt: v.endedAt ?? now };
    if (i > at) return v;
    const state = job.state === 'failed' || job.state === 'waiting_for_user' ? 'failed' : job.state === 'canceled' ? 'canceled' : 'running';
    return { ...v, state, progress: state === 'running' ? job.progress : null, startedAt: v.startedAt ?? now, endedAt: state === 'running' ? null : (v.endedAt ?? now) };
  });
}

export const isTerminal = (j: Job) => j.state === 'succeeded' || j.state === 'failed' || j.state === 'canceled' || j.state === 'waiting_for_user';

/** Mono timecode for elapsed time: m:ss. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Screen-reader throttle (PRD 5.6): ms to wait before the next announcement may be spoken. */
export const ANNOUNCE_GAP_MS = 5000;
export function announceDelay(lastAt: number | null, now: number, gap = ANNOUNCE_GAP_MS): number {
  return lastAt === null ? 0 : Math.max(0, lastAt + gap - now);
}

// ---------- plan read-outs ----------

export interface ChangeSummary {
  fillers: number;
  silenceSeconds: number;
  retakes: number;
  falseStarts: number;
  lengthCuts: number;
  review: number;
}

const kindOf = (d: Decision) => /^rules\.([a-z_]+)\.v\d+$/.exec(d.detector ?? '')?.[1] ?? d.detector ?? 'other';

export function summarize(plan: EditPlan): ChangeSummary {
  const removed = plan.decisions.filter((d) => d.action === 'remove');
  const count = (k: string) => removed.filter((d) => kindOf(d) === k).length;
  const silenceUs = removed.filter((d) => kindOf(d) === 'silence').reduce((s, d) => s + d.sourceEndUs - d.sourceStartUs, 0);
  return {
    fillers: count('filler'),
    silenceSeconds: Math.round(silenceUs / 100_000) / 10,
    retakes: count('retake'),
    falseStarts: count('false_start'),
    lengthCuts: count('target_length'),
    review: plan.reviewMarkers.length + plan.decisions.filter((d) => d.action === 'review').length,
  };
}

export function summaryLine(s: ChangeSummary): string {
  const parts = [
    s.fillers && `Removed ${s.fillers} filler${s.fillers === 1 ? '' : 's'}`,
    s.silenceSeconds && `${s.silenceSeconds}s of silence`,
    s.retakes && `${s.retakes} retake${s.retakes === 1 ? '' : 's'}`,
    s.falseStarts && `${s.falseStarts} false start${s.falseStarts === 1 ? '' : 's'}`,
    s.lengthCuts && `${s.lengthCuts} sentence${s.lengthCuts === 1 ? '' : 's'} for length`,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Nothing was removed.';
}

/** Output duration in seconds from retained source spans (speed is 1:1 in P0). */
export const planSeconds = (plan: EditPlan) => plan.segments.reduce((s, g) => s + (g.sourceEndUs - g.sourceStartUs), 0) / 1e6;

export type TranscriptItem =
  | { kind: 'word'; id: string; text: string; startUs: number; endUs: number; lowConfidence: boolean }
  | { kind: 'removed'; key: string; assetId: string; words: string[]; reason: string; startUs: number; endUs: number };

/**
 * Transcript in story order: kept words, and removed runs (a decision's span, or a run of words no segment
 * keeps) with their reason and the exact span Restore sends. Silence cuts with no words show as a run too.
 */
export function transcriptItems(plan: EditPlan, transcripts: Pick<Transcript, 'assetId' | 'words'>[]): TranscriptItem[] {
  const order = [...new Set(plan.segments.map((g) => g.assetId))];
  const items: TranscriptItem[] = [];
  for (const assetId of order) {
    const t = transcripts.find((x) => x.assetId === assetId);
    const kept = new Set(plan.segments.filter((g) => g.assetId === assetId).flatMap((g) => g.wordIds));
    const cuts = plan.decisions.filter((d) => d.assetId === assetId && d.action === 'remove');
    const words = [...(t?.words ?? [])].sort((a, b) => a.sourceStartUs - b.sourceStartUs);
    const events = [
      ...words.map((w) => ({ at: w.sourceStartUs, w })),
      // Wordless cuts (silence) still removed: no retained segment covers them.
      ...cuts
        .filter((d) => !words.some((w) => w.sourceStartUs >= d.sourceStartUs && w.sourceEndUs <= d.sourceEndUs))
        .filter((d) => !plan.segments.some((g) => g.assetId === assetId && g.sourceStartUs <= d.sourceStartUs && d.sourceEndUs <= g.sourceEndUs))
        .map((d) => ({ at: d.sourceStartUs, d })),
    ].sort((a, b) => a.at - b.at);
    // The open run of removed words; a kept word or a wordless cut closes it.
    let run: { item: Extract<TranscriptItem, { kind: 'removed' }>; group: string } | null = null;
    for (const ev of events) {
      if ('d' in ev) {
        run = null;
        items.push({ kind: 'removed', key: ev.d.id, assetId, words: [], reason: ev.d.reason, startUs: ev.d.sourceStartUs, endUs: ev.d.sourceEndUs });
        continue;
      }
      const w = ev.w;
      const text = w.correctedText ?? w.text;
      if (kept.has(w.id)) {
        run = null;
        items.push({ kind: 'word', id: w.id, text, startUs: w.sourceStartUs, endUs: w.sourceEndUs, lowConfidence: w.alignment !== 'aligned' });
        continue;
      }
      const d = cuts.find((c) => c.sourceStartUs <= w.sourceStartUs && w.sourceEndUs <= c.sourceEndUs);
      const group = d?.id ?? '';
      if (run && run.group === group) {
        run.item.words.push(text);
        if (!d) run.item.endUs = w.sourceEndUs;
        continue;
      }
      const item = { kind: 'removed' as const, key: d?.id ?? `${assetId}_${w.id}`, assetId, words: [text], reason: d?.reason ?? 'Not in the edit', startUs: d?.sourceStartUs ?? w.sourceStartUs, endUs: d?.sourceEndUs ?? w.sourceEndUs };
      run = { item, group };
      items.push(item);
    }
  }
  return items;
}

/** Estimated export size: video bitrate by preset plus 192 kb/s AAC. */
export function sizeEstimateBytes(seconds: number, preset: 'final_1080' | 'draft_720'): number {
  const videoBps = preset === 'final_1080' ? 8_000_000 : 2_500_000;
  return Math.round((seconds * (videoBps + 192_000)) / 8);
}
export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}

// ---------- timeline geometry (output seconds; the compiler owns exact frames) ----------

export type LaneId = 'video' | 'captions' | 'broll' | 'motion' | 'music' | 'sfx';
export interface Clip {
  lane: LaneId;
  id: string;
  label: string;
  start: number;
  end: number;
  locked: boolean;
  uncertain: boolean;
}

/** Clip spans in output seconds from retained source spans and word anchors. Approximate: for display only. */
export function timelineClips(plan: EditPlan, transcripts: Pick<Transcript, 'assetId' | 'words'>[]): { clips: Clip[]; total: number; segStart: Map<string, number> } {
  const fps = plan.output.fps.num / plan.output.fps.den;
  const words = new Map(transcripts.flatMap((t) => t.words.map((w) => [w.id, w] as const)));
  const segStart = new Map<string, number>();
  let t = 0;
  for (const g of plan.segments) {
    segStart.set(g.id, t);
    t += (g.sourceEndUs - g.sourceStartUs) / 1e6;
  }
  const total = t;
  const wordAt = (id: string, edge: 'start' | 'end' = 'start'): number | null => {
    const w = words.get(id);
    const g = w && plan.segments.find((s) => s.wordIds.includes(id));
    if (!w || !g) return null;
    return segStart.get(g.id)! + ((edge === 'start' ? w.sourceStartUs : w.sourceEndUs) - g.sourceStartUs) / 1e6;
  };
  const review = new Set(plan.reviewMarkers.flatMap((m) => m.refs));
  const clips: Clip[] = [];
  for (const g of plan.segments) {
    const s = segStart.get(g.id)!;
    const text = g.wordIds.map((id) => { const w = words.get(id); return w ? (w.correctedText ?? w.text) : ''; }).join(' ').trim();
    clips.push({ lane: 'video', id: g.id, label: text.slice(0, 60) || 'Video', start: s, end: s + (g.sourceEndUs - g.sourceStartUs) / 1e6, locked: g.locked, uncertain: review.has(g.id) });
  }
  for (const c of plan.captions) {
    const a = wordAt(c.wordIds[0]!);
    const b = wordAt(c.wordIds.at(-1)!, 'end');
    if (a !== null && b !== null) clips.push({ lane: 'captions', id: c.id, label: c.text, start: a, end: Math.max(b, a + 0.1), locked: c.locked, uncertain: review.has(c.id) });
  }
  for (const v of plan.visuals) {
    const a = wordAt(v.anchor.wordId, v.anchor.edge);
    if (a === null) continue;
    const start = a + v.anchor.offsetFrames / fps;
    const label = v.kind === 'hook_text' ? `Hook: ${v.text}` : v.kind === 'broll' ? 'B-roll' : v.template.replace(/_v\d+$/, '').replace(/_/g, ' ');
    clips.push({ lane: v.kind === 'broll' ? 'broll' : 'motion', id: v.id, label, start, end: start + v.durationFrames / fps, locked: v.locked, uncertain: review.has(v.id) });
  }
  const m = plan.audio.music;
  if (m) clips.push({ lane: 'music', id: m.assetId, label: `Music · ${m.gainDb} dB`, start: m.startFrame / fps, end: (m.startFrame + m.durationFrames) / fps, locked: !!m.locked, uncertain: false });
  for (const x of plan.audio.sfx) {
    const a = wordAt(x.anchor.wordId, x.anchor.edge);
    if (a !== null) clips.push({ lane: 'sfx', id: x.id, label: `${x.category.replace(/_/g, ' ')} · ${x.gainDb} dB`, start: a + x.anchor.offsetFrames / fps, end: a + x.anchor.offsetFrames / fps + 0.3, locked: x.locked, uncertain: false });
  }
  return { clips, total, segStart };
}

/** A cut point at output second `t` inside segment `g`, moved off any word it would split (PRD F14). */
export function sourceCutAt(plan: EditPlan, transcripts: Pick<Transcript, 'assetId' | 'words'>[], segId: string, t: number, segStartSec: number): number | null {
  const g = plan.segments.find((s) => s.id === segId);
  if (!g) return null;
  let us = Math.round(g.sourceStartUs + (t - segStartSec) * 1e6);
  const w = transcripts.find((x) => x.assetId === g.assetId)?.words.find((w) => w.sourceStartUs < us && us < w.sourceEndUs);
  if (w) us = us - w.sourceStartUs < w.sourceEndUs - us ? w.sourceStartUs : w.sourceEndUs;
  return us > g.sourceStartUs && us < g.sourceEndUs ? us : null;
}
