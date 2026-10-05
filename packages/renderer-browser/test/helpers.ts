// Synthetic fixture: lavfi media generated at test time in a temp dir, a hand-made plan and transcript,
// compiled with @takeoff/compiler. Nothing here is committed media.
import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile, type PlanContext } from '@takeoff/compiler';
import { hashFile, probe } from '@takeoff/media';
import type { AssetManifest, EditPlan, Transcript, TranscriptWord } from '@takeoff/contracts';
import type { BrowserRenderInput } from '../src/index.ts';
import { generateLibraryAudio } from '../src/index.ts';

export const tempDir = () => mkdtemp(join(tmpdir(), 'takeoff-rb-'));

export function gen(...args: string[]): void {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
}

export function ffprobeJson(path: string, ...args: string[]): Record<string, unknown> {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', ...args, '-of', 'json', path]).toString()) as Record<string, unknown>;
}

/** RGBA bytes of a PNG, decoded by FFmpeg. */
export function rgba(png: Buffer): Buffer {
  return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'png_pipe', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { input: png, maxBuffer: 64 << 20 });
}
export function meanAbsDiff(a: Buffer, b: Buffer): number {
  if (a.length !== b.length) return Infinity;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!);
  return s / a.length;
}

async function manifest(id: string, path: string): Promise<AssetManifest> {
  const p = await probe(path);
  return {
    schemaVersion: '1.0',
    id,
    kind: p.kind,
    contentHash: await hashFile(path),
    relativePath: `media/${id}`,
    probe: { durationUs: p.durationUs, video: p.video, audio: p.audio },
    derived: { proxy: null, analysisWav: null },
    rights: { origin: 'generated', license: 'Takeoff test fixture', attribution: null, sourceUrl: null },
    provenance: { importedAt: '2026-10-05T00:00:00Z', importer: 'test' },
    permissionScope: 'local_only',
  };
}

function transcript(assetId: string, words: Array<[string, number]>): Transcript {
  const ws: TranscriptWord[] = words.map(([id, s]) => ({ id, text: id, correctedText: null, sourceStartUs: s, sourceEndUs: s + 250_000, score: null, alignment: 'aligned', speaker: null }));
  return {
    schemaVersion: '1.0', assetId, sourceHash: '0'.repeat(64), backend: 'manual', model: 'none', version: '0', configHash: '0'.repeat(64),
    language: 'en', words: ws, sentences: [], provenance: { createdAt: '2026-10-05T00:00:00Z', glossaryHash: null, vad: null, alignment: null },
  };
}

export const HOOK_TEXT = '<img src=http://example.com/x>';

/**
 * Three segments (landscape 1920x1080 cut twice, then portrait 1080x1920) = 117 frames at 30 fps.
 * Captions in all three templates, a hook, request_flow_v1, kinetic_text_v1, comparison_list_v1, a punch zoom,
 * ducked music and one SFX from the generated library, Studio voice and auto colour on.
 */
export async function fixture(dir: string, over: { studioVoice?: boolean } = {}): Promise<{ input: BrowserRenderInput; plan: EditPlan; ctx: PlanContext }> {
  const land = join(dir, 'land.mp4'), port = join(dir, 'port.mp4');
  gen('-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30:d=6', '-f', 'lavfi', '-i', 'sine=f=220:r=48000:d=6,volume=0.2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', land);
  gen('-f', 'lavfi', '-i', 'testsrc2=s=1080x1920:r=30:d=3', '-f', 'lavfi', '-i', 'sine=f=330:r=48000:d=3,volume=0.2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', port);
  const lib = await generateLibraryAudio(join(dir, 'library'));
  const bed = join(dir, 'library', lib.items.find((i) => i.id === 'bed_calm')!.file);
  const whoosh = join(dir, 'library', lib.items.find((i) => i.id === 'sfx_whoosh')!.file);

  const manifests = { land: await manifest('land', land), port: await manifest('port', port), bed: await manifest('bed', bed), whoosh: await manifest('whoosh', whoosh) };
  const ctx: PlanContext = {
    transcripts: {
      land: transcript('land', [['w01', 1_000_000], ['w02', 1_300_000], ['w03', 1_600_000], ['w04', 1_900_000], ['w05', 2_200_000], ['w06', 3_000_000], ['w07', 3_300_000], ['w08', 3_600_000], ['w09', 3_900_000]]),
      port: transcript('port', [['p01', 500_000], ['p02', 900_000], ['p03', 1_300_000]]),
    },
    manifests,
  };
  const seg = (id: string, assetId: string, s: number, e: number, wordIds: string[]) => ({ id, assetId, sourceStartUs: s, sourceEndUs: e, wordIds, speed: { num: 1, den: 1 }, cropPolicy: 'center' as const, locked: false });
  const cap = (id: string, segmentId: string, wordIds: string[], text: string, template: 'restrained' | 'energetic' | 'static', emphasisWordIds: string[]) =>
    ({ id, segmentId, wordIds, text, template, emphasisWordIds, positionPolicy: 'safe_face_aware' as const, locked: false });
  const base = { evidenceIds: ['w01'], fallback: 'omit' as const, locked: false };
  const plan: EditPlan = {
    schemaVersion: '1.0', projectId: 'proj_test', revision: 1,
    output: { width: 1080, height: 1920, fps: { num: 30, den: 1 }, audioSampleRate: 48000, colorSpace: 'bt709', targetFrames: null, lengthPolicy: 'none' },
    settings: {
      badTakes: true, fillers: true, silence: true, captions: true, userBroll: false, aiBroll: false, zoom: true, music: true, sfx: true,
      studioVoice: over.studioVoice ?? true, autoColor: true, textHook: true, motionGraphics: true, networkPolicy: 'local_only',
    },
    assets: [
      { id: 'land', kind: 'video', manifestRef: 'assets/land.json' },
      { id: 'port', kind: 'video', manifestRef: 'assets/port.json' },
      { id: 'bed', kind: 'audio', manifestRef: 'assets/bed.json' },
      { id: 'whoosh', kind: 'audio', manifestRef: 'assets/whoosh.json' },
    ],
    transcriptRef: null, brandProfileRef: null, styleProfileRef: null,
    decisions: [],
    segments: [
      seg('s1', 'land', 1_000_000, 2_500_000, ['w01', 'w02', 'w03', 'w04', 'w05']),
      seg('s2', 'land', 3_000_000, 4_200_000, ['w06', 'w07', 'w08', 'w09']),
      seg('s3', 'port', 500_000, 1_700_000, ['p01', 'p02', 'p03']),
    ],
    captions: [
      cap('c1', 's1', ['w01', 'w02', 'w03', 'w04', 'w05'], 'Flutter sends a request through', 'restrained', ['w01']),
      cap('c2', 's2', ['w06', 'w07', 'w08', 'w09'], 'Dio to the server', 'energetic', ['w06']),
      cap('c3', 's3', ['p01', 'p02', 'p03'], 'Portrait take here.', 'static', ['p02']),
    ],
    visuals: [
      { ...base, id: 'hook', kind: 'hook_text', segmentId: 's1', anchor: { wordId: 'w01', edge: 'start', offsetFrames: 0 }, durationFrames: 40, text: HOOK_TEXT },
      { ...base, id: 'flow', kind: 'motion_template', template: 'request_flow_v1', segmentId: 's1', anchor: { wordId: 'w02', edge: 'start', offsetFrames: 0 }, durationFrames: 60,
        params: { containerLabel: 'Flutter app', internalNode: 'Dio HTTP client', externalNode: 'Server', edgeLabel: 'Request' } },
      { ...base, id: 'kin', kind: 'motion_template', template: 'kinetic_text_v1', segmentId: 's2', anchor: { wordId: 'w08', edge: 'start', offsetFrames: 0 }, durationFrames: 20,
        params: { lines: ['Fast', 'and typed'] } },
      { ...base, id: 'list', kind: 'motion_template', template: 'comparison_list_v1', segmentId: 's3', anchor: { wordId: 'p01', edge: 'start', offsetFrames: 0 }, durationFrames: 34,
        params: { title: 'Dio vs http', items: ['Interceptors', 'Cancel tokens', 'Form data'] } },
    ],
    transforms: [{ id: 'z1', segmentId: 's2', anchor: { wordId: 'w07', edge: 'start', offsetFrames: 0 }, kind: 'punch', scale: 1.15, centerPolicy: 'center', transitionFrames: 4, locked: false }],
    audio: {
      dialogue: { profile: 'studio_conservative', seamFadeMs: 30 },
      music: { assetId: 'bed', startFrame: 0, durationFrames: 117, gainDb: -18, duckUnderDialogue: true, fadeInFrames: 6, fadeOutFrames: 9 },
      sfx: [{ id: 'sx1', assetId: 'whoosh', anchor: { wordId: 'w02', edge: 'start', offsetFrames: 0 }, category: 'whoosh', gainDb: -12, visualId: 'flow', locked: false }],
      mixTarget: { integratedLufs: -14, truePeakDbtp: -1 },
    },
    reviewMarkers: [],
    provenance: { director: 'test', seed: 7, promptVersion: null },
  };
  const compiled = compile(plan, ctx);
  const paths = { land, port, bed, whoosh };
  const assets = Object.fromEntries(Object.entries(manifests).map(([id, m]) => [id, { path: paths[id as keyof typeof paths], hash: m.contentHash, manifest: m }]));
  return { plan, ctx, input: { compiled, plan, assets, fonts: [], brand: null, seed: 7, versions: { compiler: compiled.compilerVersion } } };
}
