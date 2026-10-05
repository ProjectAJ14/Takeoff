// F06/F08 face awareness: crop follows the tracked face, tracked_face punches zoom on it (capped by source
// resolution), safe_face_aware captions flip to the top slot. Nothing ever leaves the source or the frame.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compile } from '@takeoff/compiler';
import type { EditPlan } from '@takeoff/contracts';
import type { FaceTrack } from '@takeoff/renderer-api';
import { buildOverlay, cropFractions, renderStill, RenderError, zoomAt } from '../src/index.ts';
import { newGraph, videoGraph, type ComposeContext } from '../src/compose.ts';
import { fixture, tempDir } from './helpers.ts';

const { input, plan, ctx } = await fixture(await tempDir());
const base: ComposeContext = { compiled: input.compiled, plan, assets: input.assets, width: 540, height: 960, draft: true, colors: new Map() };
// `land` is 1920x1080; s1 and s2 cut it, s3 is the portrait asset.
const track = (x: number, y: number, confidence = 1): Record<string, FaceTrack> =>
  ({ land: { width: 1920, height: 1080, track: [{ startUs: 0, endUs: 6_000_000, x, y, w: 200, h: 200, confidence }] } });
const graph = (c: ComposeContext) => {
  const g = newGraph();
  videoGraph(g, c, 0, c.compiled.totalFrames);
  return g.filters.join(';');
};
const cropX = (text: string) => [...text.matchAll(/x='min\(trunc\(iw\*([0-9.]+)\)/g)].map((m) => Number(m[1]));

test('crop centre follows the face and clamps inside the source and the plan crop', () => {
  const fw = (1080 / 1920) * 1080 / 1920; // 9:16 width out of a 16:9 source, as a fraction
  const at = (x: number, rect = { x: 0, y: 0, width: 1, height: 1 }) => {
    const p = { ...plan, transforms: [{ id: 'cr', segmentId: 's1', kind: 'crop' as const, rect, locked: false }] };
    return cropFractions({ ...base, plan: p }, 's1', { w: 1920, h: 1080 }, { x: x / 1920, y: 0.3, w: 200 / 1920, h: 0.2 });
  };
  assert.ok(Math.abs(at(860).fx - (960 / 1920 - fw / 2)) < 1e-9); // face centred at 960 -> centred crop
  assert.ok(Math.abs(at(1300).fx - (1400 / 1920 - fw / 2)) < 1e-9);
  assert.ok(Math.abs(at(1720).fx + at(1720).fw - 1) < 1e-9); // far right: flush with the edge, not past it
  assert.equal(at(0).fx, 0); // far left
  const inner = at(1720, { x: 0.1, y: 0, width: 0.6, height: 1 });
  assert.ok(inner.fx >= 0.1 && inner.fx + inner.fw <= 0.7 + 1e-9, JSON.stringify(inner));
});

test('without faceTracks (or below confidence 0.5) the graph is unchanged', () => {
  const plain = graph(base);
  assert.equal(graph({ ...base, faceTracks: {} }), plain);
  assert.equal(graph({ ...base, faceTracks: track(1700, 300, 0.4) }), plain);
  assert.notEqual(graph({ ...base, faceTracks: track(1700, 300) }), plain);
  // s1 and s2 (land) follow the face to the right edge; s3 (portrait, no track) stays centred.
  const xs = cropX(graph({ ...base, faceTracks: track(1700, 300) }));
  assert.equal(xs.length, 3);
  assert.ok(xs[0]! > 0.4 && xs[1]! > 0.4 && xs[0]! <= 1 - (1080 / 1920) * 1080 / 1920 + 1e-6, String(xs));
});

const tracked: EditPlan = { ...plan, transforms: plan.transforms.map((t) => (t.kind === 'punch' ? { ...t, centerPolicy: 'tracked_face' as const } : t)) };
const z1 = input.compiled.transforms.find((t) => t.kind === 'punch')!;

test('tracked_face punch never magnifies beyond source resolution (default 1 output px per source px)', () => {
  // 1080p landscape into 1080x1920: the 9:16 crop is already upscaled ~1.78x, so a face zoom is capped to none.
  assert.equal(zoomAt({ ...base, plan: tracked, faceTracks: track(1300, 300) }, z1.endFrame - 1), 1);
  // A centre punch keeps its behaviour; so does tracked_face with no face.
  assert.equal(zoomAt({ ...base, plan: tracked }, z1.endFrame - 1), 1.15);
  // Allowing upscale (configurable) lets it zoom, at most to the cap it allows.
  assert.equal(zoomAt({ ...base, plan: tracked, faceTracks: track(1300, 300), faceZoomMaxUpscale: 2 }, z1.endFrame - 1), 1.125);
});

test('tracked_face punch zooms around the face, clamped inside the frame', () => {
  const crops = (x: number) => [...graph({ ...base, plan: tracked, faceTracks: track(x, 300), faceZoomMaxUpscale: 4 })
    .matchAll(/crop=(\d+):(\d+):(\d+):(\d+),scale/g)].map((m) => m.slice(1).map(Number));
  for (const x of [0, 1300, 1720]) {
    const cs = crops(x);
    assert.ok(cs.length > 0);
    for (const [cw, ch, cx, cy] of cs) assert.ok(cx! >= 0 && cy! >= 0 && cx! + cw! <= 540 && cy! + ch! <= 960, JSON.stringify({ x, cw, ch, cx, cy }));
  }
  // Face at the right edge of the 9:16 crop: the zoom window is flush right.
  const [cw, , cx] = crops(1720).at(-1)!;
  assert.equal(cx! + cw!, 540);
});

test('safe_face_aware caption flips to the top slot when the face is in the bottom area', () => {
  const pos = (y: number | null) => buildOverlay({ ...input, faceTracks: y === null ? undefined : track(1300, y) }, 'draft').spec.captions.find((c) => c.id === 'c1')!.position;
  assert.equal(pos(null), 'safe_face_aware'); // no tracks: bottom slot, unchanged
  assert.equal(pos(800), 'safe_top'); // face low in frame -> captions go up
  assert.equal(pos(100), 'safe_face_aware'); // face high -> bottom slot
  // c3 sits on the portrait asset, which has no track.
  assert.equal(buildOverlay({ ...input, faceTracks: track(1300, 800) }, 'draft').spec.captions.find((c) => c.id === 'c3')!.position, 'safe_face_aware');
});

test('malformed face tracks are invalid_input', async () => {
  const bad = [
    track(1800, 300), // box past the right edge
    { land: { width: 1080, height: 1920, track: [] } }, // wrong orientation for the asset
    { land: { width: 1920, height: 1080, track: [{ startUs: 5, endUs: 5, x: 0, y: 0, w: 1, h: 1, confidence: 1 }] } },
    { ghost: { width: 1920, height: 1080, track: [] } },
  ];
  for (const faceTracks of bad) {
    await assert.rejects(renderStill({ ...input, faceTracks }, 0), (e) => e instanceof RenderError && e.code === 'invalid_input' && /face/i.test(e.message), JSON.stringify(faceTracks));
  }
  await assert.rejects(renderStill({ ...input, faceZoomMaxUpscale: 0 }, 0), (e) => e instanceof RenderError && e.code === 'invalid_input' && /face/i.test(e.message));
});

test('FFmpeg accepts a face-centred crop and zoom (still at the held punch)', async () => {
  const png = await renderStill({ ...input, plan: tracked, compiled: compile(tracked, ctx), faceTracks: track(1300, 800), faceZoomMaxUpscale: 4 }, z1.endFrame - 1);
  assert.deepEqual([...png.subarray(1, 4)].map((b) => String.fromCharCode(b)).join(''), 'PNG');
});
