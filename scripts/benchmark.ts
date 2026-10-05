// PRD §12 benchmark: times the local route on a synthetic 5-minute 1080p30 take and prints a markdown
// table with the machine, model, versions and PASS/FAIL against the laptop targets.
//
//   node scripts/benchmark.ts            # ~10–20 min on an Apple Silicon laptop
//   TAKEOFF_BENCH_KEEP=1 node ...        # keep the temp folder
//
// Needs macOS `say`, ffmpeg/ffprobe, uv with the cached `base` model (CPU) and the Playwright Chromium.
// Runs offline (HF_HUB_OFFLINE=1). Any step over 20 min is abandoned and reported; the run then stops.
// Not part of CI: timings depend on the machine and its thermal state.
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { cpus, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Settings } from '@takeoff/contracts';
import { ENGINE_VERSION, Engine, workerTranscriber, type PipelineResult, type Transcriber } from '@takeoff/engine';

process.env.HF_HUB_OFFLINE = '1';
const run = promisify(execFile);
const STEP_LIMIT_MS = 20 * 60_000;
const dir = await mkdtemp(join(tmpdir(), 'takeoff-bench-'));
const say = (m: string) => process.stdout.write(`- ${m}\n`);
const sh = (cmd: string, args: string[]) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
};

const OFF: Settings = {
  badTakes: true, fillers: true, silence: true, captions: false, userBroll: false, aiBroll: false, zoom: false, music: false, sfx: false,
  studioVoice: false, autoColor: false, textHook: false, motionGraphics: false, networkPolicy: 'local_only', fillerStrength: 'normal',
};
const POLISH: Settings = { ...OFF, captions: true, zoom: true, studioVoice: true, autoColor: true, textHook: true, motionGraphics: true };

interface Row { scenario: string; target: string; seconds: number | null; pass: boolean | null; note: string }
const rows: Row[] = [];

function table(): string {
  const mem = `${Math.round(totalmem() / 2 ** 30)} GB`;
  const head = [
    `Machine: ${sh('sysctl', ['-n', 'hw.model'])}, ${cpus().length} cores (${cpus()[0]?.model ?? '?'}), ${mem} RAM, ${process.platform}/${process.arch}`,
    `Model: faster-whisper base, device auto (CPU/int8 on Apple Silicon) · Engine ${ENGINE_VERSION} · Node ${process.versions.node} · ${sh('ffmpeg', ['-version']).split('\n')[0]}`,
    `Worker: ${JSON.stringify(versions)}`,
    `Corpus: synthetic 5:00 1080p30 H.264/AAC take (macOS say, looped phrases, testsrc2) · laptop column of PRD §12`,
    '',
    '| Scenario | PRD target (laptop) | Measured | Result | Notes |',
    '|---|---|---|---|---|',
  ];
  const fmt = (s: number | null) => (s === null ? '—' : s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${s.toFixed(1)} s`);
  return [...head, ...rows.map((r) => `| ${r.scenario} | ${r.target} | ${fmt(r.seconds)} | ${r.pass === null ? 'n/a' : r.pass ? 'PASS' : 'FAIL'} | ${r.note} |`)].join('\n');
}

async function finish(code: number): Promise<never> {
  process.stdout.write('\n' + table() + '\n');
  if (!process.env.TAKEOFF_BENCH_KEEP) await rm(dir, { recursive: true, force: true });
  else process.stdout.write(`\nkept ${dir}\n`);
  process.exit(code);
}

/** Times `fn`; a step over the PRD target fails, a step over 20 min is abandoned and ends the run. */
async function step<T>(scenario: string, target: string, limitS: number | null, fn: () => Promise<T>, note: (r: T) => string = () => ''): Promise<T> {
  say(scenario);
  const t0 = performance.now();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((r) => (timer = setTimeout(() => r('timeout'), STEP_LIMIT_MS)));
  try {
    const r = await Promise.race([fn(), timeout]);
    const s = (performance.now() - t0) / 1000;
    if (r === 'timeout') {
      rows.push({ scenario, target, seconds: s, pass: false, note: 'abandoned after 20 min' });
      return finish(1);
    }
    rows.push({ scenario, target, seconds: s, pass: limitS === null ? null : s <= limitS, note: note(r as T) });
    return r as T;
  } catch (e) {
    rows.push({ scenario, target, seconds: (performance.now() - t0) / 1000, pass: false, note: `error: ${(e as { code?: string }).code ?? (e as Error).message}` });
    return finish(1);
  } finally {
    clearTimeout(timer);
  }
}

const ok = (r: PipelineResult) => {
  if (r.job.state !== 'succeeded') throw Object.assign(new Error(`job ${r.job.state}`), { code: r.error?.code ?? r.job.state });
  return r;
};

// ---- corpus ----
say(`synthesising a 5-minute 1080p take in ${dir}`);
await run('say', ['-v', 'Samantha', '-o', join(dir, 'p.aiff'), [
  'So today I want to explain how Flutter talks to a server.', 'Um, the main thing is that Flutter sends a request through Dio.',
  'The server answers with JSON, and the widget rebuilds with the new data.', "Now let's compare REST versus GraphQL.",
  'REST uses many endpoints, uh, while GraphQL uses one endpoint and you ask for exactly the fields you need.',
  'Caching matters too, because a fast app never asks twice for the same thing.', 'That is the whole idea, and thanks for watching.',
].join(' ')]);
await run('ffmpeg', ['-v', 'error', '-y', '-stream_loop', '-1', '-i', join(dir, 'p.aiff'), '-t', '300', '-ar', '48000', '-ac', '1', join(dir, 'speech.wav')]);
await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-i', join(dir, 'speech.wav'), '-t', '300',
  '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', join(dir, 'take.mp4')], { maxBuffer: 64 << 20 });
const take = join(dir, 'take.mp4');

const worker = workerTranscriber();
const probe = await worker.probe();
const versions = probe.versions;
if (!probe.models.includes('base')) {
  rows.push({ scenario: 'setup', target: '—', seconds: null, pass: false, note: 'base model not cached: run starter-pack once' });
  await finish(1);
}
let transcribeCalls = 0;
const transcriber: Transcriber = { ...worker, transcribe: (r) => (transcribeCalls++, worker.transcribe(r)) };
const open = (name: string) => Engine.create(join(dir, name), { name, appDataDir: join(dir, 'app'), approvedRoots: [dir], transcriber, asr: { model: 'base', language: 'en' } });
const go = (e: Engine, key: string, settings: Settings) =>
  e.runPipeline({ settings, targetSeconds: 60, lengthPolicy: 'hard_max', idempotencyKey: key, baseRevision: e.store.currentRevision() }).then(ok);
const motionScenes = (e: Engine) => {
  const p = e.getPlan()!.plan as { visuals: Array<{ kind?: string }> };
  return `${p.visuals.filter((v) => v.kind === 'motion_template').length} motion scene(s)`;
};

const e = open('bench');
try {
  await step('First playable proxy, 5-min 1080p take (full import: probe, hash, analysis WAV, proxy)', '≤30 s', 30, async () => {
    const [r] = await e.importAssets([take], { pool: 'takes' });
    if (!r?.assetId) throw Object.assign(new Error('import failed'), { code: r?.error?.code });
  }, () => 'not progressive: whole proxy');
  await step('Transcribe 5 min (base, CPU)', '≤5 min', 300, () => e.transcribe({ idempotencyKey: 'bench-transcribe' }).then(ok));
  await step('Speech-only 60 s draft from cached transcript', '≤60 s', 60, () => go(e, 'bench-speech', OFF), () => `transcribe calls ${transcribeCalls}`);
  await step('720p30 60 s template-polish draft', '≤3 min', 180, () => go(e, 'bench-polish', POLISH), () => motionScenes(e));
  const dest = join(dir, 'dest');
  await mkdir(dest);
  await step('1080p30 60 s final, ≤3 motion scenes', '≤5 min', 300, () => e.exportProject({ profile: 'final_1080', destinationDir: dest, burnCaptions: true, idempotencyKey: 'bench-final' }).then(ok), () => motionScenes(e));
  const before = transcribeCalls;
  await step('Revision: caption template change, re-render', 'never re-transcribe', null, async () => {
    const head = e.getPlan()!;
    const cap = head.plan.captions[0];
    if (!cap) throw new Error('no caption to change');
    e.applyPatch({ schemaVersion: '1.0', baseRevision: head.revision, ops: [{ op: 'set_caption', captionId: cap.id, template: cap.template === 'static' ? 'energetic' : 'static' }] });
    return ok(await e.renderAffected());
  }, () => `transcribe calls during revision: ${transcribeCalls - before}`);
  const last = rows.at(-1)!;
  last.pass = transcribeCalls === before;
} finally {
  e.close();
}

const f = open('bench-full');
try {
  const dest = join(dir, 'dest-full');
  await mkdir(dest);
  await step('Complete 5-min raw → 60 s template short (import, transcribe, polish, 1080p final)', '≤12 min', 720, async () => {
    await f.importAssets([take], { pool: 'takes' });
    await go(f, 'bench-full', POLISH);
    return ok(await f.exportProject({ profile: 'final_1080', destinationDir: dest, burnCaptions: true, idempotencyKey: 'bench-full-final' }));
  }, () => 'warm model, new project (re-transcribes)');
} finally {
  f.close();
}
await finish(rows.some((r) => r.pass === false) ? 1 : 0);
