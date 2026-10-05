import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  captionBox,
  easeInOutCubic,
  easeOutBack,
  escapeHtml,
  frameProgress,
  linear,
  mulberry32,
  platformSafeArea,
  rectInside,
  rectsOverlap,
} from '../src/index.ts';

const take = (seed: number, n: number) => Array.from({ length: n }, mulberry32(seed));

test('mulberry32 is deterministic per seed, in [0,1), and seed-sensitive', () => {
  assert.deepEqual(take(42, 50), take(42, 50));
  assert.notDeepEqual(take(42, 5), take(43, 5));
  for (const v of take(7, 10_000)) assert.ok(v >= 0 && v < 1);
  // Golden: changing the generator changes every rendered scene.
  assert.deepEqual(take(1, 3).map((v) => v.toFixed(10)), GOLDEN_SEED_1);
});
// Matches the reference mulberry32 (first value for seed 1 is 0.6270739405881613).
const GOLDEN_SEED_1 = ['0.6270739406', '0.0027357212', '0.5274470400'];

test('easings hit exact endpoints and clamp out-of-range t', () => {
  for (const ease of [linear, easeInOutCubic, easeOutBack]) {
    assert.equal(ease(0), 0, ease.name);
    assert.equal(ease(1), 1, ease.name);
    assert.equal(ease(-3), 0, ease.name);
    assert.equal(ease(9), 1, ease.name);
  }
  assert.equal(easeInOutCubic(0.5), 0.5);
  assert.ok(easeOutBack(0.7) > 1, 'easeOutBack overshoots mid-way');
});

test('frameProgress is clamped and handles zero duration', () => {
  assert.equal(frameProgress(5, 10, 20), 0);
  assert.equal(frameProgress(20, 10, 20), 0.5);
  assert.equal(frameProgress(99, 10, 20), 1);
  assert.equal(frameProgress(10, 10, 0), 1);
  assert.equal(frameProgress(9, 10, 0), 0);
});

test('platformSafeArea reserves Reels/Shorts UI and stays inside the frame', () => {
  const frame = { x: 0, y: 0, w: 1080, h: 1920 };
  const safe = platformSafeArea(1080, 1920);
  assert.ok(rectInside(safe, frame));
  assert.ok(safe.y >= 1920 * 0.12);
  assert.ok(safe.y + safe.h <= 1920 * 0.8);
  assert.ok(safe.x + safe.w <= 1080 * 0.88);
  for (const v of Object.values(safe)) assert.ok(Number.isInteger(v));
  for (const [w, h] of [[720, 1280], [1081, 1921], [9, 16]] as const) {
    assert.ok(rectInside(platformSafeArea(w, h), { x: 0, y: 0, w, h }), `${w}x${h}`);
  }
  assert.throws(() => platformSafeArea(0, 1920), RangeError);
  assert.throws(() => platformSafeArea(1080.5, 1920), RangeError);
  assert.throws(() => platformSafeArea(1080, 1920, { top: 0.6, bottom: 0.5, left: 0, right: 0 }), RangeError);
});

test('captionBox stays in the safe area and avoids a tracked face', () => {
  const safe = platformSafeArea(1080, 1920);
  const bottom = captionBox(1080, 1920, 'safe_bottom');
  const top = captionBox(1080, 1920, 'safe_top');
  for (const box of [bottom, top]) assert.ok(rectInside(box, safe));
  assert.equal(bottom.y + bottom.h, safe.y + safe.h);
  assert.equal(top.y, safe.y);

  assert.deepEqual(captionBox(1080, 1920, 'safe_face_aware', null), bottom, 'no tracking -> stable bottom');
  const lowFace = { x: 300, y: 1300, w: 400, h: 200 };
  assert.ok(rectsOverlap(bottom, lowFace));
  assert.deepEqual(captionBox(1080, 1920, 'safe_face_aware', lowFace), top);
  const highFace = { x: 300, y: 400, w: 400, h: 400 };
  assert.deepEqual(captionBox(1080, 1920, 'safe_face_aware', highFace), bottom);
  const hugeFace = { x: 0, y: 0, w: 1080, h: 1920 };
  assert.deepEqual(captionBox(1080, 1920, 'safe_face_aware', hugeFace), bottom, 'both overlap -> stable bottom');
});

test('rectsOverlap treats touching edges as not overlapping', () => {
  assert.equal(rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 5, h: 5 }), false);
  assert.equal(rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 9, y: 9, w: 5, h: 5 }), true);
});

test('escapeHtml neutralises markup and attribute breakout', () => {
  assert.equal(escapeHtml(`<img src=x onerror="alert('1')">&`), '&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;');
  assert.equal(escapeHtml('Flutter → Dio'), 'Flutter → Dio');
  assert.equal(escapeHtml('&amp;'), '&amp;amp;');
});

// Regressions found in review.
test('platformSafeArea does not lose a pixel to float noise', () => {
  // 100 * 0.07 === 7.000000000000001; plain Math.ceil gave x = 8.
  assert.equal(platformSafeArea(100, 100, { top: 0, right: 0, bottom: 0, left: 0.07 }).x, 7);
  assert.equal(platformSafeArea(1080, 1920).y, 231, '230.4 still rounds outward');
});

test('empty rects overlap nothing, so an empty face box keeps captions at the bottom', () => {
  const frame = { x: 0, y: 0, w: 1080, h: 1920 };
  assert.equal(rectsOverlap({ x: 500, y: 1500, w: 0, h: 0 }, frame), false);
  assert.equal(rectsOverlap(frame, { x: 500, y: 1500, w: 100, h: -10 }), false);
  const bottom = captionBox(1080, 1920, 'safe_bottom');
  assert.deepEqual(captionBox(1080, 1920, 'safe_face_aware', { x: 500, y: bottom.y + 10, w: 0, h: 0 }), bottom);
});

test('mulberry32 rejects seeds that would silently collide', () => {
  for (const bad of [1.5, -1, 2 ** 32, Number.NaN]) assert.throws(() => mulberry32(bad), RangeError, String(bad));
  assert.doesNotThrow(() => mulberry32(0xffffffff));
});

test('easings and frameProgress never return NaN', () => {
  for (const ease of [linear, easeInOutCubic, easeOutBack]) assert.equal(ease(Number.NaN), 0, ease.name);
  assert.equal(frameProgress(Number.NaN, 0, 10), 0);
});
