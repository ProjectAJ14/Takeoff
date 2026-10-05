// PRD §13/§18 recovery fixtures.
//
// Crash: the real `takeoff edit` CLI runs in a child process group and is SIGKILLed while its job is in
// Transcribe, and again while it is in Render preview (job state polled from project.db). Each time a
// fresh `edit` must complete, valid analysis is not redone (transcript cache hit in the engine log),
// no partial MP4 is ever recorded as an artifact, and the source's checksum never changes. Then
// Engine.recover() requeues the killed render job, deletes the leftover partials, and the resumed job
// skips its completed stages. Needs `say`, uv and the cached `base` model (the CLI's default ASR model).
//
// Cancel and disk-full run in process with fakes (no model needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import type { RenderArtifact, RenderInput, RenderOptions, Renderer } from '@takeoff/renderer-api';
import { Engine, workerTranscriber } from '../src/index.ts';
import { fixture, pipeline, run, tmp } from './helpers.ts';

const BIN = join(import.meta.dirname, '..', 'bin', 'takeoff.js');
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const has = (bin: string) => {
  try {
    execFileSync('which', [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const base = has('say') && has('uv') ? await workerTranscriber().probe().then((p) => p.models.includes('base'), () => false) : false;

const TOGGLES = {
  badTakes: true, fillers: true, silence: true, captions: true, userBroll: false, aiBroll: false, zoom: true, music: false, sfx: false,
  studioVoice: true, autoColor: true, textHook: false, motionGraphics: true, networkPolicy: 'local_only', fillerStrength: 'normal',
};

type JobRow = { id: string; stage: string; state: string; idempotency_key: string };
const query = <T>(db: string, sql: string): T[] => {
  const d = new DatabaseSync(db, { readOnly: true });
  try {
    return d.prepare(sql).all() as T[];
  } finally {
    d.close();
  }
};
const partials = async (root: string) => (await readdir(root, { recursive: true }).catch(() => [])).map(String).filter((f) => /\.partial(\.|$)/.test(f));

test('crash recovery: SIGKILL during Transcribe and Render preview, rerun completes from cache, no partial is final', { skip: !base && 'needs say, uv and the cached base model', timeout: 900_000 }, async () => {
  const { dir, cleanup } = await tmp('takeoff-recovery-');
  const env = { ...process.env, TAKEOFF_APP_DATA: join(dir, 'appdata'), HF_HUB_OFFLINE: '1' };
  const cli = async (...args: string[]) => JSON.parse((await run(process.execPath, [BIN, ...args, '--json'], { cwd: dir, env, maxBuffer: 64 << 20, timeout: 600_000 })).stdout);
  const proj = join(dir, 'proj');
  const db = join(proj, 'project.db');
  try {
    await run('say', ['-v', 'Samantha', '-o', join(dir, 's.aiff'), 'So today I want to show you how Flutter sends a request through Dio to the server. Um, it is really simple. The client builds the request, the server answers, and the widget rebuilds with the data. That is the whole flow, and thanks for watching.']);
    await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30', '-i', join(dir, 's.aiff'), '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', join(dir, 'take.mp4')]);
    const take = join(dir, 'take.mp4');
    const before = sha(take);
    await cli('init', proj, '--name', 'Recovery', '--toggles', JSON.stringify(TOGGLES), '--target', 'auto');
    await cli('import', proj, take);

    /** Starts `edit`, waits until a running job reaches `stage` (and, for renders, until a partial appears or 1.5 s pass), then SIGKILLs the whole process group. */
    const killDuring = async (stage: string): Promise<JobRow> => {
      const child = spawn(process.execPath, [BIN, 'edit', proj, '--json'], { cwd: dir, env, detached: true, stdio: 'ignore' });
      const exited = new Promise((r) => child.once('exit', r));
      let job: JobRow | undefined;
      for (let t = 0; !job; t++) {
        assert.ok(t < 2400 && child.exitCode === null, `edit never reached ${stage}`);
        await sleep(50);
        if (existsSync(db)) job = query<JobRow>(db, "SELECT * FROM jobs WHERE state = 'running'").find((j) => j.stage === stage);
      }
      for (let t = 0; stage === 'Render preview' && t < 30 && !(await partials(join(proj, 'renders'))).length; t++) await sleep(50);
      process.kill(-child.pid!, 'SIGKILL');
      await exited;
      return query<JobRow>(db, `SELECT * FROM jobs WHERE id = '${job.id}'`)[0]!;
    };
    const logs = () => readFileSync(join(dir, 'appdata', 'logs', 'engine.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const transcribeHit = (jobId: string) => logs().find((l) => l.event === 'transcribe' && l.jobId === jobId)?.cacheHit;
    const transcripts = () => query<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM transcripts')[0]!.n;

    // 1. Killed in Transcribe: no transcript was committed, so the rerun transcribes once and completes.
    const k1 = await killDuring('Transcribe');
    assert.equal(k1.state, 'running', 'a SIGKILLed job is left running until recovery');
    assert.equal(transcripts(), 0);
    const r2 = await cli('edit', proj);
    assert.equal(r2.job.state, 'succeeded', JSON.stringify(r2.error));
    assert.equal(transcribeHit(r2.job.id), false);
    assert.equal(transcripts(), 1);
    // Opening the project (Workspace.open) recovered the killed job: it no longer claims to be running.
    assert.notEqual(query<JobRow>(db, `SELECT * FROM jobs WHERE id = '${k1.id}'`)[0]!.state, 'running');

    // 2. Killed in Render preview: the rerun reuses the transcript (no repeated valid analysis).
    const k3 = await killDuring('Render preview');
    assert.equal(transcribeHit(k3.id), true);
    const r4 = await cli('edit', proj);
    assert.equal(r4.job.state, 'succeeded', JSON.stringify(r4.error));
    assert.equal(transcribeHit(r4.job.id), true);
    assert.equal(transcripts(), 1, 'transcribed exactly once across four runs');

    // No partial is ever an artifact; the killed jobs recorded no render; the final render verifies.
    const arts = query<{ job_id: string; kind: string; path: string; hash: string }>(db, 'SELECT * FROM artifacts');
    assert.ok(!arts.some((a) => a.path.includes('.partial')), JSON.stringify(arts));
    assert.ok(!arts.some((a) => a.job_id === k1.id || a.job_id === k3.id));
    const draft = arts.filter((a) => a.job_id === r4.job.id && a.kind === 'render_draft').at(-1)!;
    assert.equal(sha(join(proj, draft.path)), draft.hash);

    // 3. Recovery ran when the next `edit` opened the project: interrupted jobs left `running`, partials are gone,
    // and the render job (it had checkpoints) is requeued and resumes past its done stages.
    const e = Engine.open(proj, { appDataDir: join(dir, 'appdata'), approvedRoots: [dir] });
    try {
      const rec = await e.recover();
      assert.deepEqual([...rec.requeued, ...rec.failed], [], 'nothing left to recover');
      assert.equal(e.getJob(k3.id)!.state, 'queued', 'the render-killed job had checkpoints and is requeued');
      assert.notEqual(e.getJob(k1.id)!.state, 'running');
      assert.deepEqual(await partials(proj), []);
      const seenBefore = logs().length;
      const resumed = await e.runPipeline({ settings: TOGGLES as never, targetSeconds: null, lengthPolicy: 'none', idempotencyKey: k3.idempotency_key, baseRevision: e.store.currentRevision() });
      assert.equal(resumed.job.id, k3.id);
      assert.equal(resumed.job.state, 'succeeded', JSON.stringify(resumed.error));
      const stages = logs().slice(seenBefore).filter((l) => l.event === 'stage' && l.jobId === k3.id);
      assert.ok(stages.find((l) => l.stage === 'Transcribe')?.cacheHit, 'Transcribe resumed from its checkpoint');
      assert.equal(stages.find((l) => l.stage === 'Render preview')?.cacheHit, false);
    } finally {
      e.close();
    }
    assert.equal(transcripts(), 1);
    assert.equal(sha(take), before, 'source media is immutable');
  } finally {
    await cleanup();
  }
});

/** Hangs its first render until aborted (after writing a partial), so cancel lands mid-render; later renders use `next`. */
function hangingRenderer(next: () => Renderer) {
  let started!: () => void;
  const inRender = new Promise<void>((r) => (started = r));
  let calls = 0;
  const renderer: Renderer = {
    id: 'hang',
    async render(input: RenderInput, opts: RenderOptions): Promise<RenderArtifact> {
      if (calls++) return next().render(input, opts);
      await writeFile(`${opts.outPath}.partial`, 'half');
      started();
      return new Promise((_, rej) => opts.signal?.addEventListener('abort', () => rej(opts.signal!.reason), { once: true }));
    },
  };
  return { inRender, renderer };
}

test('cancel during Render preview: canceled at once, nothing committed, a new run reuses the transcript', async () => {
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  const h = hangingRenderer(() => f!.renderer);
  f = await fixture({ engine: { loadRenderer: async () => ({ createRenderer: () => h.renderer }) } });
  try {
    const p = pipeline(f, 'cancel-render');
    await h.inRender;
    const id = await waitRunning(f.engine);
    assert.equal(f.engine.cancel(id), true);
    const r = await p;
    assert.equal(r.job.state, 'canceled');
    assert.equal(f.engine.store.getJob(id)!.state, 'canceled');
    const db = join(f.root, 'project.db');
    assert.deepEqual(query(db, `SELECT * FROM artifacts WHERE job_id = '${id}'`), [], 'nothing committed after abort');
    assert.ok(f.engine.store.getCheckpoints(id).some((c) => c.name === 'transcribe'), 'completed stages keep their checkpoints');
    const again = await pipeline(f, 'cancel-render-2');
    assert.equal(again.job.state, 'succeeded', JSON.stringify(again.error));
    assert.equal(f.transcriber.calls, 1, 'transcript reused after cancel');
  } finally {
    await f.cleanup();
  }
});

async function waitRunning(e: Engine): Promise<string> {
  const db = join(e.root, 'project.db');
  for (;;) {
    const j = query<JobRow>(db, "SELECT * FROM jobs WHERE state = 'running'")[0];
    if (j) return j.id;
    await sleep(10);
  }
}

test('disk full at export: typed disk_full with a remedy, nothing reaches the destination, the draft stays', async () => {
  // The injectable preflight passes the draft budget and fails the export's (3x draft) estimate.
  let limit = Infinity;
  const f = await fixture({ engine: { diskPreflight: async (_root, bytes) => ({ ok: bytes * 1.2 <= limit, availableBytes: limit, requiredBytes: Math.ceil(bytes * 1.2) }) } });
  try {
    const r = await pipeline(f, 'disk-draft');
    assert.equal(r.job.state, 'succeeded', JSON.stringify(r.error));
    limit = 1024;
    const dest = join(f.root, '..', 'dest');
    await mkdir(dest);
    const x = await f.engine.exportProject({ profile: 'final_1080', destinationDir: dest, burnCaptions: true, idempotencyKey: 'disk-export' });
    assert.equal(x.job.state, 'failed');
    assert.equal(x.error?.code, 'disk_full');
    assert.match(x.error!.remedy, /Free disk space/);
    assert.deepEqual(readdirSync(dest), [], 'nothing written to the destination');
    assert.equal(f.engine.getPlan()!.revision, r.revision, 'the draft plan is untouched');
  } finally {
    await f.cleanup();
  }
});
