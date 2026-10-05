// Slow: real transcribe worker (tiny model) on synthesised speech, fake renderer. Skips without `say`, uv or the cached model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Engine, workerTranscriber, type RendererModule } from '../src/index.ts';
import { fakeRenderer, run, settings, tmp } from './helpers.ts';

const has = (bin: string) => {
  try {
    execFileSync('which', [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const worker = workerTranscriber();
const tiny = has('say') && has('uv') ? await worker.probe().then((p) => p.models.includes('tiny'), () => false) : false;

test('slow: real worker transcribes once, caches, and the pipeline succeeds', { skip: !tiny && 'needs say, uv and the cached tiny model', timeout: 300_000 }, async () => {
  const { dir, cleanup } = await tmp();
  const media = join(dir, 'media');
  await mkdir(media);
  await run('say', ['-v', 'Samantha', '-o', join(media, 'speech.aiff'), 'So today I want to show you how Flutter sends a request through Dio. It is really simple.']);
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30', '-i', join(media, 'speech.aiff'), '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(media, 'take.mp4')]);
  const renderer = fakeRenderer();
  let calls = 0;
  const transcriber = { ...worker, transcribe: (r: Parameters<typeof worker.transcribe>[0]) => (calls++, worker.transcribe(r)) };
  const engine = Engine.create(join(dir, 'project'), {
    name: 'Slow', appDataDir: join(dir, 'app'), approvedRoots: [media], transcriber,
    loadRenderer: async () => ({ createRenderer: () => renderer }) as RendererModule, asr: { model: 'tiny', language: 'en' },
  });
  try {
    const [imp] = await engine.importAssets([join(media, 'take.mp4')], { pool: 'takes' });
    assert.ok(imp?.assetId, JSON.stringify(imp?.error));
    const go = (key: string) => engine.runPipeline({ settings, targetSeconds: null, lengthPolicy: 'none', idempotencyKey: key, baseRevision: engine.store.currentRevision() });
    const r = await go('slow-run-1');
    assert.equal(r.job.state, 'succeeded', JSON.stringify(r.error));
    const plan = engine.getPlan()!.plan;
    assert.ok(plan.segments.flatMap((s) => s.wordIds).length > 5, 'real words reached the plan');
    const again = await go('slow-run-2');
    assert.equal(again.job.state, 'succeeded', JSON.stringify(again.error));
    assert.equal(calls, 1, 'second run used the transcript cache');
  } finally {
    engine.close();
    await cleanup();
  }
});
