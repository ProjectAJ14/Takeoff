import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validate } from '@takeoff/contracts';
import { readFile } from 'node:fs/promises';
import { fakeTranscriber, fixture, makeVideo, pipeline, run, tmp } from './helpers.ts';
import { StaleRevisionError, runQa } from '../src/index.ts';

test('pipeline runs every stage, commits a validated plan and a QA report with honest statuses', async () => {
  const f = await fixture();
  try {
    const r = await pipeline(f, 'run-1');
    assert.equal(r.error, null, JSON.stringify(r.error));
    assert.equal(r.job.state, 'succeeded');
    assert.equal(r.job.stage, 'Check quality');
    assert.ok(validate('job', r.job).ok);
    assert.equal(r.revision, 1);
    assert.ok(r.qa && validate('qa-report', r.qa).ok);
    const status = Object.fromEntries(r.qa!.checks.map((c) => [c.name, c.status]));
    assert.equal(status.decode, 'passed');
    assert.equal(status.duration_frames, 'passed');
    assert.equal(status.audio_samples, 'passed');
    assert.equal(status.color_tags, 'passed');
    assert.equal(status.caption_bounds, 'not_run'); // fake renderer reports no overlay measurements
    assert.equal(status.undeclared_network, 'not_run');
    assert.equal(status.contact_sheet, 'passed');
    assert.ok(r.job.artifacts.some((a) => a.kind === 'render_draft'));
    const plan = f.engine.getPlan()!.plan;
    assert.ok(plan.captions.length > 0);
    assert.ok(plan.segments.every((s) => s.wordIds.every((w) => w.startsWith(`${s.assetId}.`))), 'word ids are namespaced per asset');
    // Each stage committed a checkpoint.
    const names = f.engine.store.getCheckpoints(r.job.id).map((c) => c.name);
    for (const n of ['request', 'prepare', 'transcribe', 'clean_speech', 'plan', 'build_graphics', 'render_preview', 'check_quality']) assert.ok(names.includes(n), n);
  } finally {
    await f.cleanup();
  }
});

test('job creation is idempotent: the same key returns the same job and does no work twice', async () => {
  const f = await fixture();
  try {
    const [a, b] = await Promise.all([pipeline(f, 'same'), pipeline(f, 'same')]);
    assert.equal(a.job.id, b.job.id);
    const c = await pipeline(f, 'same');
    assert.equal(c.job.id, a.job.id);
    assert.equal(c.job.state, 'succeeded');
    assert.equal(c.revision, a.revision);
    assert.equal(f.transcriber.calls, 1);
    assert.equal(f.renderer.renders.length, 1);
    assert.equal(f.engine.store.currentRevision(), 1);
  } finally {
    await f.cleanup();
  }
});

test('cancel is acknowledged within 2 s, the job ends canceled and checkpoints are kept', async () => {
  const f = await fixture({ transcriber: fakeTranscriber('hang') });
  try {
    const p = pipeline(f, 'cancel-me');
    const id = f.engine.store.listJobs()[0]!.id;
    while (f.engine.getJob(id)!.stage !== 'Transcribe') await new Promise((r) => setTimeout(r, 10));
    const t0 = Date.now();
    assert.equal(f.engine.cancel(id), true);
    assert.equal(f.engine.getJob(id)!.state, 'canceled', 'cancel is acknowledged synchronously (HTTP returns the job right after)');
    const r = await p;
    assert.ok(Date.now() - t0 < 2000, `ack took ${Date.now() - t0} ms`);
    assert.equal(r.job.state, 'canceled');
    assert.equal(r.error, null);
    assert.ok(f.engine.store.getCheckpoints(id).some((c) => c.name === 'prepare'), 'completed checkpoint kept');
    assert.equal(f.engine.store.currentRevision(), 0, 'no plan committed after cancel');
  } finally {
    await f.cleanup();
  }
});

test('an unchanged take is never re-transcribed: the second run hits the transcript cache', async () => {
  const f = await fixture();
  try {
    await pipeline(f, 'first');
    assert.equal(f.transcriber.calls, 1);
    const r = await pipeline(f, 'second', { settings: { ...(await import('./helpers.ts')).settings, zoom: false } });
    assert.equal(r.job.state, 'succeeded', JSON.stringify(r.error));
    assert.equal(f.transcriber.calls, 1, 'worker not called again');
    assert.equal(r.revision, 2);
  } finally {
    await f.cleanup();
  }
});

test('a user lock survives regeneration', async () => {
  const f = await fixture();
  try {
    await pipeline(f, 'gen-1');
    const head = f.engine.getPlan()!;
    const cap = head.plan.captions[0]!;
    f.engine.applyPatch({
      schemaVersion: '1.0',
      baseRevision: head.revision,
      ops: [
        { op: 'set_caption', captionId: cap.id, template: 'static', emphasisWordIds: [] },
        { op: 'lock_object', objectId: cap.id },
      ],
    });
    const r = await pipeline(f, 'gen-2');
    assert.equal(r.job.state, 'succeeded', JSON.stringify(r.error));
    const after = f.engine.getPlan()!.plan.captions.find((c) => c.id === cap.id)!;
    assert.equal(after.locked, true);
    assert.equal(after.template, 'static');
    assert.deepEqual(after.emphasisWordIds, []);
  } finally {
    await f.cleanup();
  }
});

test('a patch against a stale revision is rejected and nothing is committed', async () => {
  const f = await fixture();
  try {
    await pipeline(f, 'gen');
    const head = f.engine.getPlan()!;
    const capId = head.plan.captions[0]!.id;
    f.engine.applyPatch({ schemaVersion: '1.0', baseRevision: head.revision, ops: [{ op: 'set_caption', captionId: capId, template: 'energetic' }] });
    assert.throws(
      () => f.engine.applyPatch({ schemaVersion: '1.0', baseRevision: head.revision, ops: [{ op: 'set_caption', captionId: capId, template: 'static' }] }),
      StaleRevisionError,
    );
    assert.equal(f.engine.store.currentRevision(), head.revision + 1);
    // undo/redo/revert are revisions too
    assert.equal(f.engine.undo().plan.captions[0]!.template, head.plan.captions[0]!.template);
    assert.equal(f.engine.redo().plan.captions[0]!.template, 'energetic');
    assert.equal(f.engine.revert(head.revision).revision, head.revision + 4);
  } finally {
    await f.cleanup();
  }
});

test('disk preflight failure fails the job with a typed disk_full error', async () => {
  const f = await fixture({ engine: { diskPreflight: async () => ({ ok: false, availableBytes: 10, requiredBytes: 1_000_000 }) } });
  try {
    const r = await pipeline(f, 'full');
    assert.equal(r.job.state, 'failed');
    assert.equal(r.error?.code, 'disk_full');
    assert.equal(r.job.error?.code, 'disk_full');
    assert.ok(r.job.error?.remedy);
    assert.equal(f.transcriber.calls, 0);
  } finally {
    await f.cleanup();
  }
});

test('model_missing pauses the job for the user with a remedy; no_speech yields a visual-only plan with a marker', async () => {
  const a = await fixture({ transcriber: fakeTranscriber('model_missing') });
  try {
    const r = await pipeline(a, 'needs-model');
    assert.equal(r.job.state, 'waiting_for_user');
    assert.equal(r.error?.code, 'model_missing');
    assert.ok(r.error?.remedy);
  } finally {
    await a.cleanup();
  }
  const b = await fixture({ transcriber: fakeTranscriber('no_speech') });
  try {
    const r = await pipeline(b, 'silent');
    assert.equal(r.job.state, 'succeeded', JSON.stringify(r.error));
    const plan = b.engine.getPlan()!.plan;
    assert.equal(plan.captions.length, 0);
    assert.equal(plan.decisions.length, 0);
    assert.equal(plan.segments.length, 1);
    assert.deepEqual(plan.segments[0]!.wordIds, []);
    assert.ok(plan.reviewMarkers.some((m) => m.id === 'marker_no_speech'));
  } finally {
    await b.cleanup();
  }
});

test('QA repairs an overflowing caption by switching it to the static template', async () => {
  const f = await fixture({
    renderer: {
      overlay: (input) => ({
        undeclaredRequests: 0,
        visualFailures: [],
        captions: input.plan.captions.map((c, i) => ({ captionId: c.id, frame: 0, rect: c.template === 'static' || i > 0 ? { x: 20, y: 60, w: 100, h: 20 } : { x: 0, y: 300, w: 180, h: 20 } })),
      }),
    },
  });
  try {
    const r = await pipeline(f, 'repair');
    assert.equal(r.job.state, 'succeeded', JSON.stringify(r.error));
    const status = Object.fromEntries(r.qa!.checks.map((c) => [c.name, c.status]));
    assert.equal(status.caption_bounds, 'passed');
    assert.equal(status.undeclared_network, 'passed');
    assert.equal(r.revision, 2, 'the repair is a new system revision');
    assert.equal(f.engine.getPlan()!.plan.captions[0]!.template, 'static');
  } finally {
    await f.cleanup();
  }
});

test('imports report per-file errors without blocking others, and refuse paths outside approved roots', async () => {
  const f = await fixture();
  const outside = await tmp('takeoff-outside-');
  try {
    const dir = join(f.root, '..', 'media');
    await writeFile(join(dir, 'broken.mp4'), 'not a video');
    const good = await makeVideo(join(dir, 'second.mp4'), 2);
    const away = await makeVideo(join(outside.dir, 'away.mp4'), 1);
    const r = await f.engine.importAssets([join(dir, 'broken.mp4'), good, away, f.take], { pool: 'takes' });
    assert.ok(r[0]!.error && r[0]!.error.code !== 'internal', JSON.stringify(r[0]));
    assert.ok(r[1]!.assetId);
    assert.equal(r[2]!.error?.code, 'path_not_approved');
    assert.equal(r[3]!.reused, true);
    assert.ok(!JSON.stringify(r).includes(dir), 'errors never echo paths');
    assert.ok(existsSync(join(f.root, 'assets', `${r[1]!.assetId}.json`)));
  } finally {
    await outside.cleanup();
    await f.cleanup();
  }
});

test('recover() requeues/fails interrupted jobs and deletes partial files', async () => {
  const f = await fixture();
  try {
    const job = f.engine.store.createJob({ schemaVersion: '1.0', stage: 'Render preview', profile: 'draft', baseRevision: 0, idempotencyKey: 'crash-job' });
    f.engine.store.transitionJob(job.id, 'running');
    await mkdir(join(f.root, 'renders', job.id), { recursive: true });
    await writeFile(join(f.root, 'renders', job.id, 'draft.mp4.partial'), 'half');
    await writeFile(join(f.root, 'renders', job.id, 'x.json.abc123.partial'), 'half');
    const r = await f.engine.recover();
    assert.deepEqual(r.failed, [job.id]);
    assert.equal(r.removedPartials, 2);
    assert.ok(!existsSync(join(f.root, 'renders', job.id, 'draft.mp4.partial')));
  } finally {
    await f.cleanup();
  }
});

test('QA on a silent render reports loudness and true peak as skipped, never passed or missing', async () => {
  const f = await fixture();
  try {
    const r = await pipeline(f, 'silent-qa');
    const cp = f.engine.store.getCheckpoints(r.job.id).find((c) => c.name === 'build_graphics')!;
    const compiled = JSON.parse(await readFile(join(f.root, JSON.parse(await readFile(join(f.root, cp.ref), 'utf8')).data.compiledRef), 'utf8'));
    const silent = join(f.root, 'silent.mp4');
    const { num, den } = compiled.fps;
    await run('ffmpeg', [
      '-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=gray:s=180x320:r=${num}/${den}`, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
      '-frames:v', String(compiled.totalFrames), '-af', `atrim=end_sample=${compiled.totalSamples}`,
      '-vf', 'setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', silent,
    ]);
    const { report } = await runQa({ renderPath: silent, compiled, plan: f.engine.getPlan()!.plan, width: 180, height: 320 });
    const status = Object.fromEntries(report.checks.map((c) => [c.name, c.status]));
    assert.equal(status.loudness, 'skipped');
    assert.equal(status.true_peak, 'skipped');
  } finally {
    await f.cleanup();
  }
});
