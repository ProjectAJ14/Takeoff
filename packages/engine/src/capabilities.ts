// First-run capability check (PRD §5.1): what this machine can do, feature by feature, with reasons.
import { existsSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { validate, type Capabilities, type FeatureId } from '@takeoff/contracts';
import { OLLAMA_DEFAULT_PORT, OLLAMA_HOST } from '@takeoff/director';
import { capabilities as mediaCapabilities, type MediaCapabilities } from '@takeoff/media';
import type { Engine } from './engine.ts';
import type { WorkerProbe } from './transcribe.ts';
import type { ProviderPolicy } from './broker.ts';

/** What capabilities needs: an Engine, or the app-level Workspace when no project is open. */
export type CapabilitySource = Pick<Engine, 'transcriber' | 'opts' | 'root' | 'fonts' | 'library'> & { broker: { policy(): ProviderPolicy } };

export interface EngineCapabilities {
  /** The contracts `capabilities` DTO. Degraded features are reported as `experimental` with a reason. */
  dto: Capabilities;
  diskFreeBytes: number | null;
  ffmpeg: boolean;
  renderer: boolean;
  fonts: boolean;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/**
 * Renders launch Playwright's Chromium *headless shell* (`chromium.launch({ headless: true })`), not the full browser
 * `chromium.executablePath()` names, so that is the binary to look for. Playwright's registry resolves its path.
 */
export async function chromiumPresent(): Promise<boolean> {
  try {
    const core = (await import('playwright-core/lib/coreBundle' as string)) as { registry: { registry: { findExecutable(n: string): { executablePath(sdk: string): string | undefined } | undefined } } };
    const p = core.registry.registry.findExecutable('chromium-headless-shell')?.executablePath('javascript');
    return !!p && existsSync(p);
  } catch {
    return false;
  }
}

/** Ollama model tags on loopback; [] when Ollama is not running. Never leaves 127.0.0.1. */
async function ollamaModels(port = OLLAMA_DEFAULT_PORT): Promise<string[]> {
  try {
    const res = await fetch(`http://${OLLAMA_HOST}:${port}/api/tags`, { redirect: 'error', signal: AbortSignal.timeout(1500) });
    const j = (await res.json()) as { models?: Array<{ name?: unknown }> };
    return (j.models ?? []).map((m) => m.name).filter((n): n is string => typeof n === 'string' && ID.test(n));
  } catch {
    return [];
  }
}

export async function engineCapabilities(engine: CapabilitySource): Promise<EngineCapabilities> {
  const [media, worker, ollama, chromium, disk] = await Promise.all([
    mediaCapabilities().catch((): MediaCapabilities | null => null),
    engine.transcriber.probe().catch((): WorkerProbe | null => null),
    ollamaModels(engine.opts.director && engine.opts.director !== 'rules' && engine.opts.director.kind === 'ollama' ? engine.opts.director.port : undefined),
    chromiumPresent(),
    statfs(engine.root).then((s) => s.bavail * s.bsize, () => null),
  ]);
  const ffmpeg = !!media && media.missing.length === 0;
  const asr = worker?.models ?? [];
  const fonts = engine.fonts().length > 0;
  const renderer = chromium && ffmpeg;
  const library = engine.library();
  const policy = engine.broker.policy();

  type F = Capabilities['features'][number];
  const on = (id: FeatureId, reason: string | null = null): F => ({ id, status: 'available', reason });
  const off = (id: FeatureId, reason: string): F => ({ id, status: 'unavailable', reason });
  const degraded = (id: FeatureId, reason: string): F => ({ id, status: 'experimental', reason });
  const needs = (id: FeatureId, ok: boolean, reason: string, then: () => F = () => on(id)) => (ok ? then() : off(id, reason));
  const noFfmpeg = media ? `FFmpeg is missing ${media.missing.join(', ')}` : 'FFmpeg/ffprobe were not found; install FFmpeg';
  const noAsr = worker ? 'No transcription model is installed; install the starter pack' : 'The transcription worker is not set up; run uv sync in workers/transcribe';
  const noRender = !ffmpeg ? noFfmpeg : 'Chromium for the renderer is not installed';
  const hasAsr = asr.length > 0;

  const features: F[] = [
    needs('F01', ffmpeg, noFfmpeg),
    needs('F02', hasAsr, noAsr, () => on('F02', 'English is validated; other languages are experimental')),
    needs('F03', hasAsr, noAsr, () => (ollama.length ? on('F03') : degraded('F03', 'Rules-based retake detection only; install a local Ollama model for semantic review'))),
    needs('F04', hasAsr, noAsr),
    needs('F05', hasAsr, noAsr),
    needs('F06', hasAsr && renderer && fonts, !hasAsr ? noAsr : !fonts ? 'Bundled caption fonts are missing' : noRender),
    needs('F07', renderer, noRender, () => on('F07', 'Your own B-roll, placed where its tags match spoken words; AI B-roll is P1')),
    needs('F08', renderer, noRender, () => (worker ? on('F08', 'Local face tracking centres the crop; generated zooms stay centred, and a face zoom never exceeds source resolution') : degraded('F08', 'Centre punch zooms only: the face tracking worker is not set up'))),
    needs('F09', renderer && library.some((e) => e.kind === 'music'), !renderer ? noRender : 'No licensed music installed; install the starter pack or import your own track'),
    needs('F10', renderer && library.some((e) => e.kind === 'sfx'), !renderer ? noRender : 'No sound effects installed; install the starter pack'),
    needs('F11', renderer, noRender),
    needs('F12', renderer, noRender, () => on('F12', 'SDR only; HDR sources are reported as unsupported')),
    needs('F13', hasAsr && renderer, !hasAsr ? noAsr : noRender),
    needs('F14', hasAsr, noAsr),
    needs('F15', renderer, noRender, () => on('F15', 'Three P0 templates; generated scenes are P1')),
    off('F16', 'Reference style analysis is P1'),
    on('F17', 'Manual brand profiles; website analysis is P1'),
  ];

  const dto: Capabilities = {
    schemaVersion: '1.0',
    appVersion: '0.1.0',
    networkPolicy: policy.networkPolicy,
    models: [
      ...asr.filter((m) => ID.test(m)).map((id) => ({ id, kind: 'asr' as const, backend: 'faster_whisper', installed: true, device: worker?.defaultDevice && ID.test(worker.defaultDevice) ? worker.defaultDevice : null })),
      { id: 'rules', kind: 'director' as const, backend: 'rules', installed: true, device: null },
      ...ollama.slice(0, 50).map((id) => ({ id, kind: 'director' as const, backend: 'ollama', installed: true, device: null })),
    ],
    devices: (worker?.devices ?? ['cpu']).filter((d) => d === 'cpu' || d === 'cuda').map((d) => ({ id: d, kind: d as 'cpu' | 'cuda', name: d === 'cpu' ? `CPU (${process.arch})` : 'CUDA GPU' })),
    codecs: {
      decode: (media?.decoders ?? []).filter((d) => d.length <= 32).slice(0, 200),
      encode: media ? [...(media.encoders.libx264 ? ['h264'] : []), ...(media.encoders.aac ? ['aac'] : [])] : [],
    },
    providers: policy.approvals.map((a) => ({ id: a.provider, enabled: policy.networkPolicy === 'approved_providers', dataTypes: a.dataTypes })),
    features,
  };
  const v = validate('capabilities', dto);
  if (!v.ok) throw new Error(`capabilities DTO invalid: ${v.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`);
  return { dto, diskFreeBytes: disk, ffmpeg, renderer, fonts };
}
