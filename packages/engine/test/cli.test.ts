import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { loadBrowserRenderer, renderTest } from '../src/index.ts';
import { tmp } from './helpers.ts';

const run = promisify(execFile);
const REPO = join(import.meta.dirname, '..', '..', '..');
const BIN = join(REPO, 'packages/engine/bin/takeoff.js');
const cli = (args: string[], env: Record<string, string> = {}) =>
  run(process.execPath, [BIN, ...args], { env: { ...process.env, ...env }, cwd: REPO }).then(
    (r) => ({ code: 0, ...r }),
    (e) => ({ code: e.code as number, stdout: e.stdout as string, stderr: e.stderr as string }),
  );

async function assertFiveSecondMp4(path: string) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,nb_read_frames,duration,color_primaries', '-of', 'json', path]);
  const s = JSON.parse(stdout).streams as Array<{ codec_type: string; nb_read_frames: string; duration: string; color_primaries?: string }>;
  const v = s.find((x) => x.codec_type === 'video')!;
  const a = s.find((x) => x.codec_type === 'audio')!;
  assert.equal(Number(v.nb_read_frames), 150);
  assert.equal(v.color_primaries, 'bt709');
  assert.ok(Math.abs(Number(v.duration) - 5) < 1e-3 && Math.abs(Number(a.duration) - 5) < 1e-3);
}

const RENDERER = '@takeoff/renderer-browser';
const rendererLinked = await import(RENDERER).then(() => true, () => false);
const rendererSrc = pathToFileURL(join(REPO, 'packages/renderer-browser/src/index.ts')).href;

test('renderTest renders the five-second lavfi clip end to end with the real browser renderer', async () => {
  const { dir, cleanup } = await tmp('takeoff-rt-');
  try {
    const r = await renderTest(join(dir, 'out.mp4'), { loadRenderer: () => loadBrowserRenderer(rendererSrc) });
    assert.equal(r.qa.duration_frames, 'passed');
    assert.equal(r.qa.undeclared_network, 'passed');
    await assertFiveSecondMp4(r.out);
  } finally {
    await cleanup();
  }
});

test('takeoff render-test <out.mp4> via the bin', { skip: rendererLinked ? false : '@takeoff/renderer-browser is not linked in node_modules yet' }, async () => {
  const { dir, cleanup } = await tmp('takeoff-rt-bin-');
  try {
    const r = await cli(['render-test', join(dir, 'out.mp4')], { TAKEOFF_APP_DATA: join(dir, 'appdata') });
    assert.equal(r.code, 0, r.stderr);
    await assertFiveSecondMp4(join(dir, 'out.mp4'));
  } finally {
    await cleanup();
  }
});

test('takeoff validate: exit 0 for the example plan, 1 for an invalid one; usage errors exit 2 with JSON on stderr', async () => {
  const ok = await cli(['validate', 'docs/example-edit-plan.json']);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).ok, true);
  const bad = await cli(['validate', 'packages/contracts/fixtures/invalid/edit-plan/absolute-manifest-path.json']);
  assert.equal(bad.code, 1);
  const missing = await cli(['validate', 'no/such/plan.json', '--json']);
  assert.equal(missing.code, 1);
  assert.equal(JSON.parse(missing.stderr).code, 'invalid_json');
  const unknown = await cli(['frobnicate', '--json']);
  assert.equal(unknown.code, 2);
  assert.deepEqual(Object.keys(JSON.parse(unknown.stderr)).sort(), ['code', 'message', 'remedy']);
});

test('takeoff init rejects a target outside 10–180 s instead of storing it', async () => {
  const { dir, cleanup } = await tmp('takeoff-cli-init-');
  try {
    for (const target of ['5', 'abc']) {
      const r = await cli(['init', join(dir, `p${target}`), '--target', target, '--json'], { TAKEOFF_APP_DATA: join(dir, 'appdata') });
      assert.equal(r.code, 1, target);
      assert.equal(JSON.parse(r.stderr).code, 'invalid_settings', target);
    }
  } finally {
    await cleanup();
  }
});
