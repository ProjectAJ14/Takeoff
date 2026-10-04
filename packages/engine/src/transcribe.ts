// The Python transcribe worker as a subprocess (workers/transcribe CLAUDE.md is the CLI contract).
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validate, type Transcript } from '@takeoff/contracts';
import { canonicalJson } from '@takeoff/project-store';
import type { SpeechInterval } from '@takeoff/director';
import { EngineError } from './errors.ts';

export const TRANSCRIBE_DIR = fileURLToPath(new URL('../../../workers/transcribe', import.meta.url));

export interface AsrConfig {
  model: string;
  language: string;
  glossary: string[];
}
export interface WorkerProbe {
  models: string[];
  devices: string[];
  defaultDevice: string;
  versions: Record<string, string>;
}
export interface TranscribeRequest {
  /** Absolute path of the 16 kHz analysis WAV. */
  audioPath: string;
  /** Absolute output path for the transcript JSON. */
  outPath: string;
  assetId: string;
  sourceHash: string;
  config: AsrConfig;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}
export interface TranscribeResult {
  transcript: Transcript;
  speech: SpeechInterval[];
}
export interface FacesRequest {
  /** Absolute path of the video (original take). */
  videoPath: string;
  /** Absolute output path for the face-track JSON. */
  outPath: string;
  sourceHash: string;
  sampleFps: number;
  signal?: AbortSignal;
}
/** The worker's `faces` output (fits renderer-api `FaceTrack` as is). */
export interface FacesResult {
  width: number;
  height: number;
  status: 'tracked' | 'multiple_faces' | 'lost' | 'none';
  track: Array<{ startUs: number; endUs: number; x: number; y: number; w: number; h: number; confidence: number }>;
}
/** Test seam: the engine talks to ASR (and the same worker's face tracking) only through this. */
export interface Transcriber {
  /** F06/F08 local face tracking; absent = face awareness unavailable (centre framing). */
  faces?(req: FacesRequest): Promise<FacesResult>;
  probe(): Promise<WorkerProbe>;
  /** Cache key component; must change whenever the transcript for the same audio could change. */
  configHash(config: AsrConfig): Promise<string>;
  transcribe(req: TranscribeRequest): Promise<TranscribeResult>;
  downloadModel(model: string, signal?: AbortSignal): Promise<void>;
}

const MODELS = /^(tiny|base|small|medium|large|large-v[123]|turbo|distil-[a-z0-9.-]+)(\.en)?$/;
const LANGUAGE = /^(auto|[a-z]{2,3})$/;

export function validateAsrConfig(c: AsrConfig): AsrConfig {
  const bad = (m: string) => new EngineError('invalid_settings', m, 'Choose a listed model and language.');
  if (!MODELS.test(c.model)) throw bad('unknown transcription model');
  if (!LANGUAGE.test(c.language)) throw bad('language must be auto or a language code');
  // Commas separate terms on the CLI; a term containing one is dropped rather than split.
  const glossary = c.glossary.filter((t) => typeof t === 'string' && t.trim() && !t.includes(',') && t.length <= 64).slice(0, 200);
  return { model: c.model, language: c.language, glossary };
}

interface WorkerLine {
  type: string;
  [k: string]: unknown;
}

/** Spawns `python -m takeoff_transcribe` with an argument array; resolves with every JSONL line, or throws the typed error line. */
function runWorker(args: string[], signal?: AbortSignal, onLine?: (l: WorkerLine) => void): Promise<WorkerLine[]> {
  return new Promise((ok, fail) => {
    // --directory: the worker is not an installed package, so it runs from its own directory; every path arg is absolute.
    const child = spawn('uv', ['run', '--quiet', '--directory', TRANSCRIBE_DIR, 'python', '-m', 'takeoff_transcribe', ...args], {
      signal,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const lines: WorkerLine[] = [];
    let buf = '';
    child.stdout.on('data', (c: Buffer) => {
      buf += c.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!raw) continue;
        try {
          const l = JSON.parse(raw) as WorkerLine;
          lines.push(l);
          onLine?.(l);
        } catch {
          // not a protocol line; ignore
        }
      }
    });
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (signal?.aborted) return fail(signal.reason);
      fail(e.code === 'ENOENT' ? new EngineError('worker_missing', 'uv was not found', 'Install uv and run `uv sync` in workers/transcribe.') : e);
    });
    child.on('close', (code) => {
      if (signal?.aborted) return fail(signal.reason ?? new DOMException('aborted', 'AbortError'));
      const err = lines.find((l) => l.type === 'error');
      if (err) return fail(new EngineError(String(err.code), String(err.message), String(err.remedy)));
      if (code !== 0) return fail(new EngineError('worker_failed', `transcribe worker exited with code ${code}`, 'Run `uv sync` in workers/transcribe and retry.'));
      ok(lines);
    });
  });
}

export function workerTranscriber(): Transcriber {
  let probed: Promise<WorkerProbe> | undefined;
  const t: Transcriber = {
    probe() {
      probed ??= runWorker(['probe']).then((lines) => {
        const c = lines.find((l) => l.type === 'capabilities');
        if (!c) throw new EngineError('worker_failed', 'transcribe worker gave no capabilities', 'Run `uv sync` in workers/transcribe.');
        return { models: c.models as string[], devices: c.devices as string[], defaultDevice: c.defaultDevice as string, versions: c.versions as Record<string, string> };
      });
      probed.catch(() => (probed = undefined));
      return probed;
    },
    async configHash(config) {
      const { versions } = await t.probe();
      return createHash('sha256').update(canonicalJson({ ...validateAsrConfig(config), versions })).digest('hex');
    },
    async transcribe(req) {
      const c = validateAsrConfig(req.config);
      const args = ['transcribe', '--audio', req.audioPath, '--out', req.outPath, '--model', c.model, '--language', c.language, '--asset-id', req.assetId, '--source-hash', req.sourceHash];
      if (c.glossary.length) args.push('--glossary', c.glossary.join(','));
      const lines = await runWorker(args, req.signal, (l) => {
        if (l.type === 'progress' && l.stage === 'transcribe' && Number(l.total) > 0) req.onProgress?.(Math.min(1, Number(l.done) / Number(l.total)));
      });
      const result = lines.find((l) => l.type === 'result');
      if (!result) throw new EngineError('worker_failed', 'transcribe worker gave no result', 'Retry the stage.');
      const v = validate('transcript', JSON.parse(await readFile(req.outPath, 'utf8')));
      if (!v.ok) throw new EngineError('invalid_transcript', 'the transcribe worker wrote an invalid transcript', 'Update the worker (`uv sync`) and retry.');
      const speech = ((result.speechIntervals as Array<{ startUs: number; endUs: number }>) ?? []).map((s) => ({ assetId: req.assetId, sourceStartUs: s.startUs, sourceEndUs: s.endUs }));
      return { transcript: v.value, speech };
    },
    async faces(req) {
      const args = ['faces', '--video', req.videoPath, '--out', req.outPath, '--sample-fps', String(req.sampleFps), '--source-hash', req.sourceHash];
      const lines = await runWorker(args, req.signal);
      if (!lines.some((l) => l.type === 'result')) throw new EngineError('worker_failed', 'face tracking gave no result', 'Retry the stage.');
      const j = JSON.parse(await readFile(req.outPath, 'utf8')) as FacesResult;
      // Shape check only; the renderer validates spans, bounds and aspect before use.
      if (!Number.isSafeInteger(j.width) || !Number.isSafeInteger(j.height) || !Array.isArray(j.track)) throw new EngineError('worker_failed', 'face tracking wrote an invalid file', 'Update the worker (`uv sync`) and retry.');
      return { width: j.width, height: j.height, status: j.status, track: j.track };
    },
    async downloadModel(model, signal) {
      validateAsrConfig({ model, language: 'auto', glossary: [] });
      await runWorker(['download-model', '--model', model, '--allow-network'], signal);
      probed = undefined;
    },
  };
  return t;
}
