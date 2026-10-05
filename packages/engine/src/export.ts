// Export sidecars: SRT/VTT/word-timed JSON captions and audio stems (PRD §5.5, F06).
import { execFile } from 'node:child_process';
import { rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { CompiledTimeline, EditPlan, Id, Transcript } from '@takeoff/contracts';
import { usToSamples } from '@takeoff/compiler';
import { EngineError } from './errors.ts';

const FFMPEG = process.env.TAKEOFF_FFMPEG ?? 'ffmpeg';

const ms = (frame: number, tl: CompiledTimeline) => Math.floor((frame * tl.fps.den * 1000) / tl.fps.num);
function stamp(t: number, sep: ',' | '.'): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(t / 3_600_000))}:${p(Math.floor(t / 60_000) % 60)}:${p(Math.floor(t / 1000) % 60)}${sep}${p(t % 1000, 3)}`;
}
const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();

function cues(tl: CompiledTimeline, plan: EditPlan) {
  const text = new Map(plan.captions.map((c) => [c.id, c.text]));
  return tl.captions.map((c) => ({ c, start: ms(c.startFrame, tl), end: ms(c.endFrame, tl), text: oneLine(text.get(c.captionId) ?? '') }));
}

export function toSrt(tl: CompiledTimeline, plan: EditPlan): string {
  return cues(tl, plan).map((q, i) => `${i + 1}\n${stamp(q.start, ',')} --> ${stamp(q.end, ',')}\n${q.text}\n`).join('\n');
}

export function toVtt(tl: CompiledTimeline, plan: EditPlan): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `WEBVTT\n\n${cues(tl, plan).map((q) => `${stamp(q.start, '.')} --> ${stamp(q.end, '.')}\n${esc(q.text)}\n`).join('\n')}`;
}

/** Word-timed captions in output frames and milliseconds; word text is the transcript's (corrected if set). */
export function toCaptionJson(tl: CompiledTimeline, plan: EditPlan, transcripts: Record<Id, Transcript>): string {
  const words = new Map(Object.values(transcripts).flatMap((t) => t.words.map((w) => [w.id, w.correctedText ?? w.text] as const)));
  return JSON.stringify(
    {
      schemaVersion: '1.0',
      fps: tl.fps,
      captions: cues(tl, plan).map((q) => ({
        captionId: q.c.captionId,
        text: q.text,
        startFrame: q.c.startFrame,
        endFrame: q.c.endFrame,
        startMs: q.start,
        endMs: q.end,
        words: q.c.words.map((w) => ({ wordId: w.wordId, text: words.get(w.wordId) ?? null, startFrame: w.startFrame, endFrame: w.endFrame, startMs: ms(w.startFrame, tl), endMs: ms(w.endFrame, tl) })),
      })),
    },
    null,
    2,
  );
}

export interface StemSource {
  /** Absolute path of the asset's 48 kHz master WAV. */
  wav: string;
  /** Source time of WAV sample 0 (probe startUs). */
  startUs: number;
}

const int = (v: number) => {
  if (!Number.isSafeInteger(v) || v < 0) throw new EngineError('invalid_timeline', 'stem timing is not a non-negative integer', 'Recompile the plan.');
  return v;
};
const db = (v: number) => {
  if (!Number.isFinite(v) || v < -60 || v > 12) throw new EngineError('invalid_timeline', 'gain out of range', 'Recompile the plan.');
  return v.toFixed(2);
};

function ff(args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((ok, fail) =>
    execFile(FFMPEG, ['-hide_banner', '-nostdin', '-v', 'error', ...args], { signal, maxBuffer: 16 * 1024 * 1024 }, (err) => {
      if (signal?.aborted) return fail(signal.reason);
      if (err) return fail(new EngineError('stem_failed', 'ffmpeg could not write an audio stem', 'Check free disk space and retry the export.'));
      ok();
    }),
  );
}

/**
 * Writes dialogue/music/sfx stems as 48 kHz stereo WAVs of exactly `totalSamples`, from the compiled
 * schedule. Filter graphs hold only validated integers and gains.
 * ponytail: plain cuts, gains and placement; studio voice, seam fades and ducking live in the renderer's mix.
 * Make stems from the renderer's own mix graph once it exposes per-bus outputs.
 */
export async function writeStems(tl: CompiledTimeline, sources: (assetId: Id) => StemSource, outDir: string, signal?: AbortSignal): Promise<Record<'dialogue' | 'music' | 'sfx', string>> {
  const total = int(tl.totalSamples);
  const out = {} as Record<'dialogue' | 'music' | 'sfx', string>;
  const fin = `apad=whole_len=${total},atrim=end_sample=${total},aformat=sample_rates=48000:channel_layouts=stereo`;
  for (const kind of ['dialogue', 'music', 'sfx'] as const) {
    const inputs: string[] = [];
    const parts: string[] = [];
    if (kind === 'dialogue') {
      for (const s of tl.segments) {
        const src = sources(s.assetId);
        const from = int(usToSamples(s.sourceStartUs - src.startUs < 0 ? 0 : s.sourceStartUs - src.startUs));
        const len = int(s.outputEndSample - s.outputStartSample);
        parts.push(`[${parts.length}:a]aformat=sample_rates=48000:channel_layouts=stereo,atrim=start_sample=${from}:end_sample=${from + len},asetpts=N/SR/TB,apad=whole_len=${len},atrim=end_sample=${len}[s${parts.length}]`);
        inputs.push('-i', `file:${resolve(src.wav)}`);
      }
      if (parts.length) parts.push(`${parts.map((_, i) => `[s${i}]`).join('')}concat=n=${parts.length}:v=0:a=1,${fin}[out]`);
    } else {
      for (const e of tl.audioEvents.filter((x) => x.kind === kind)) {
        const src = sources(e.assetId);
        const len = int(e.endSample - e.startSample);
        parts.push(`[${parts.length}:a]aformat=sample_rates=48000:channel_layouts=stereo,atrim=end_sample=${len},asetpts=N/SR/TB,volume=${db(e.gainDb)}dB,adelay=delays=${int(e.startSample)}S:all=1[s${parts.length}]`);
        inputs.push('-i', `file:${resolve(src.wav)}`);
      }
      if (parts.length) parts.push(`${parts.map((_, i) => `[s${i}]`).join('')}amix=inputs=${parts.length}:normalize=0,${fin}[out]`);
    }
    if (!parts.length) {
      inputs.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
      parts.push(`[0:a]atrim=end_sample=${total}[out]`);
    }
    const final = resolve(outDir, `${kind}.wav`);
    const partial = `${final}.partial`;
    try {
      await ff(['-y', ...inputs, '-filter_complex', parts.join(';'), '-map', '[out]', '-c:a', 'pcm_s16le', '-f', 'wav', `file:${partial}`], signal);
      await rename(partial, final);
    } finally {
      await rm(partial, { force: true });
    }
    out[kind] = final;
  }
  return out;
}
