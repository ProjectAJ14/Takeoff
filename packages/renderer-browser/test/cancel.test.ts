import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { BrowserRenderer } from '../src/index.ts';
import { fixture, tempDir } from './helpers.ts';

test('aborting mid-render rejects with AbortError and leaves no output or partial', async () => {
  const dir = await tempDir();
  const { input } = await fixture(dir);
  const out = join(dir, 'out.mp4');
  const ac = new AbortController();
  let sawPartial = false;
  // Abort only once FFmpeg has created the partial (it appears late, while encoding flushes and the output is
  // validated), so the deletion is actually exercised rather than passing because no partial ever existed.
  const poll = setInterval(() => {
    if (!ac.signal.aborted && existsSync(`${out}.partial.mp4`)) { sawPartial = true; ac.abort(); }
  }, 1);
  try {
    await assert.rejects(
      new BrowserRenderer().render(input, { outPath: out, profile: 'draft', signal: ac.signal }),
      (e: Error) => e.name === 'AbortError',
    );
  } finally {
    clearInterval(poll);
  }
  assert.ok(sawPartial, 'the partial never appeared before the render ended');
  assert.ok(!existsSync(out));
  assert.ok(!existsSync(`${out}.partial.mp4`));
});

test('an already-aborted signal starts nothing', async () => {
  const dir = await tempDir();
  const { input } = await fixture(dir);
  const out = join(dir, 'out.mp4');
  await assert.rejects(new BrowserRenderer().render(input, { outPath: out, profile: 'draft', signal: AbortSignal.abort() }), (e: Error) => e.name === 'AbortError');
  assert.ok(!existsSync(out) && !existsSync(`${out}.partial.mp4`));
});
