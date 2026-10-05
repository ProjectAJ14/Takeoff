import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderStill } from '../src/index.ts';
import { fixture, tempDir } from './helpers.ts';

const { input } = await fixture(await tempDir());

test('renderStill composes source, zoom and overlay; out-of-order stills equal sequential ones', async () => {
  const order = [40, 3, 77, 3, 40];
  const shuffled: Buffer[] = [];
  for (const f of order) shuffled.push(await renderStill(input, f));
  const seq = new Map<number, Buffer>();
  for (const f of [3, 40, 77]) seq.set(f, await renderStill(input, f));
  order.forEach((f, i) => assert.ok(shuffled[i]!.equals(seq.get(f)!), `frame ${f} differs`));
  const png = seq.get(3)!;
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [540, 960]);
  assert.ok(!seq.get(3)!.equals(seq.get(77)!));
});

test('renderStill refuses a frame outside the timeline', async () => {
  await assert.rejects(renderStill(input, input.compiled.totalFrames), RangeError);
});
