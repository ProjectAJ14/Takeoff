import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EditPlan, PatchOp } from '@takeoff/contracts';
import { applyPatch, compile, PatchError } from '../src/index.ts';
import { examplePlan, exampleCtx } from './helpers.ts';

/** Fixture with short tracks and no length cap, so cuts and restores stay valid. */
function plan(): EditPlan {
  const p = examplePlan();
  p.visuals[0]!.durationFrames = 30;
  p.audio.music!.durationFrames = 30;
  p.output.lengthPolicy = 'none';
  return p;
}
const patch = (p: EditPlan, ...ops: PatchOp[]) => applyPatch(p, { schemaVersion: '1.0', baseRevision: p.revision, ops }, exampleCtx());
const rejects = (fn: () => unknown, code: string) =>
  assert.throws(fn, (e: unknown) => e instanceof PatchError && e.code === code);

test('stale baseRevision is rejected with stale_revision', () => {
  const p = plan();
  rejects(() => applyPatch(p, { schemaVersion: '1.0', baseRevision: 6, ops: [{ op: 'lock_object', objectId: 'zoom_01' }] }, exampleCtx()), 'stale_revision');
});

test('ops outside the allowlist fail the patch schema', () => {
  rejects(() => applyPatch(plan(), { schemaVersion: '1.0', baseRevision: 7, ops: [{ op: 'run_shell', cmd: 'rm -rf /' }] }, exampleCtx()), 'invalid_patch');
});

test('a successful patch bumps the revision and never mutates the input', () => {
  const p = plan();
  const snapshot = structuredClone(p);
  const next = patch(p, { op: 'set_setting', key: 'targetSeconds', value: 2 });
  assert.equal(next.revision, 8);
  assert.equal(next.settings.targetSeconds, 2);
  assert.equal(next.output.targetFrames, 60);
  assert.deepEqual(p, snapshot);
});

test('locked objects refuse edits; lock and unlock still work', () => {
  const p = plan();
  p.captions[0]!.locked = true;
  p.audio.music!.locked = true;
  rejects(() => patch(p, { op: 'set_caption', captionId: 'caption_01', text: 'x' }), 'locked_object');
  rejects(() => patch(p, { op: 'set_gain', targetId: 'music_a', gainDb: -20 }), 'locked_object');
  // Cutting w03 would rewrite the locked caption's words.
  rejects(() => patch(p, { op: 'remove_span', assetId: 'take_a', sourceStartUs: 1_540_000, sourceEndUs: 1_790_000, reason: 'user' }), 'locked_object');
  const unlocked = patch(p, { op: 'unlock_object', objectId: 'caption_01' }, { op: 'set_caption', captionId: 'caption_01', text: 'Flutter sends' });
  assert.equal(unlocked.captions[0]!.text, 'Flutter sends');
  assert.equal(unlocked.captions[0]!.locked, false);
  assert.equal(patch(p, { op: 'lock_object', objectId: 'speech_01' }).segments[0]!.locked, true);
});

test('remove_span inside a segment splits it; captions keep surviving words with final timing', () => {
  const next = patch(plan(), { op: 'remove_span', assetId: 'take_a', sourceStartUs: 1_540_000, sourceEndUs: 1_790_000, reason: 'filler' });
  assert.deepEqual(next.segments.map((g) => [g.id, g.sourceStartUs, g.sourceEndUs]), [['speech_01', 1_000_000, 1_540_000], ['speech_01_1790000', 1_790_000, 4_000_000]]);
  assert.deepEqual(next.captions.map((c) => [c.id, c.segmentId, c.wordIds.join(' ')]), [
    ['caption_01', 'speech_01', 'w01 w02'],
    ['caption_01_1', 'speech_01_1790000', 'w04 w05'],
    ['caption_02', 'speech_01_1790000', 'w06 w07 w08 w09 w10 w11'],
  ]);
  assert.equal(next.captions[2]!.text, 'Dio to the server in seconds.'); // re-homed only: text untouched
  assert.equal(next.transforms[0]!.segmentId, 'speech_01_1790000'); // zoom anchor w06 followed its word
  assert.equal(next.decisions.at(-1)!.reason, 'filler');
  const tl = compile(next, exampleCtx());
  assert.equal(tl.totalFrames, 82); // 2.75 s retained -> floor(82.5)
  // Captions are recomputed from words, not shifted by an assumed offset: the second piece starts on
  // frame floor(0.54 s * 30) = 16 and w06 is 0.56 s into it, so w06 lands on 16 + floor(16.8) = 32.
  assert.equal(tl.captions.find((c) => c.captionId === 'caption_02')!.startFrame, 32);
});

test('a patch that makes the plan invalid is rejected whole', () => {
  // Cutting 0.86 s leaves 64 frames; the 90-frame visual of the original fixture would overflow.
  const p = examplePlan();
  p.output.lengthPolicy = 'none';
  rejects(() => patch(p, { op: 'remove_span', assetId: 'take_a', sourceStartUs: 3_140_000, sourceEndUs: 4_000_000, reason: 'tail' }), 'invalid_result');
});

test('restore_span re-adds removed ranges as segments in chronological order', () => {
  const cut = patch(plan(), { op: 'remove_span', assetId: 'take_a', sourceStartUs: 2_330_000, sourceEndUs: 2_350_000, reason: 'gap' });
  const back = patch(cut, { op: 'restore_span', assetId: 'take_a', sourceStartUs: 0, sourceEndUs: 4_000_000 });
  assert.equal(back.revision, 9);
  assert.deepEqual(back.segments.map((g) => [g.sourceStartUs, g.sourceEndUs]), [
    [0, 1_000_000],
    [1_000_000, 2_330_000],
    [2_330_000, 2_350_000],
    [2_350_000, 4_000_000],
  ]);
  assert.equal(compile(back, exampleCtx()).totalFrames, 120);
});

test('cut edges never land mid-word; split_segment splits between words and splits between words', () => {
  rejects(() => patch(plan(), { op: 'split_segment', segmentId: 'speech_01', atSourceUs: 1_100_000, newSegmentId: 'b' }), 'invalid_op');
  rejects(() => patch(plan(), { op: 'remove_span', assetId: 'take_a', sourceStartUs: 1_100_000, sourceEndUs: 1_540_000, reason: 'x' }), 'invalid_op');
  const next = patch(plan(), { op: 'split_segment', segmentId: 'speech_01', atSourceUs: 2_340_000, newSegmentId: 'speech_02' });
  assert.deepEqual(next.segments.map((g) => [g.id, g.wordIds.length]), [['speech_01', 5], ['speech_02', 6]]);
  assert.equal(next.captions[1]!.segmentId, 'speech_02');
  assert.equal(compile(next, exampleCtx()).totalFrames, 90);
});

test('reorder, trim, crop, remove_visual and hook ops', () => {
  const split = patch(plan(), { op: 'split_segment', segmentId: 'speech_01', atSourceUs: 2_340_000, newSegmentId: 'speech_02' });
  const next = patch(split,
    { op: 'reorder_segment', segmentId: 'speech_02', toIndex: 0 },
    { op: 'set_crop', segmentId: 'speech_01', rect: { x: 0.25, y: 0, width: 0.5, height: 1 } },
    { op: 'remove_visual', visualId: 'flow_01' },
    { op: 'set_hook', text: 'Dio is in-app', evidenceIds: ['w06'] },
  );
  assert.deepEqual(next.segments.map((g) => g.id), ['speech_02', 'speech_01']);
  assert.equal(next.segments[1]!.cropPolicy, 'manual');
  assert.equal(next.transforms.at(-1)!.kind, 'crop');
  assert.deepEqual(next.visuals, []);
  assert.deepEqual(next.settings.hook, { autoSelect: false, text: 'Dio is in-app' });
  rejects(() => patch(next, { op: 'trim_segment', segmentId: 'speech_02', sourceStartUs: 2_350_000, sourceEndUs: 3_000_000 }), 'invalid_op'); // inside w08
  const trimmed = patch(next, { op: 'trim_segment', segmentId: 'speech_02', sourceStartUs: 2_350_000, sourceEndUs: 3_140_000 });
  assert.deepEqual(trimmed.segments[0]!.wordIds, ['w06', 'w07', 'w08']);
  assert.deepEqual(trimmed.captions.find((c) => c.id === 'caption_02')!.wordIds, ['w06', 'w07', 'w08']);
  rejects(() => patch(plan(), { op: 'reorder_segment', segmentId: 'speech_01', toIndex: 3 }), 'invalid_op');
  rejects(() => patch(plan(), { op: 'remove_visual', visualId: 'nope' }), 'not_found');
});

test('regression: restore_span re-homes anchors orphaned by an earlier cut', () => {
  const cut = patch(plan(), { op: 'remove_span', assetId: 'take_a', sourceStartUs: 2_340_000, sourceEndUs: 2_620_000, reason: 'w06' });
  assert.deepEqual(compile(cut, exampleCtx()).transforms, []); // zoom anchor w06 is cut
  const back = patch(cut, { op: 'restore_span', assetId: 'take_a', sourceStartUs: 2_340_000, sourceEndUs: 2_620_000 });
  assert.equal(back.transforms[0]!.segmentId, back.segments[1]!.id);
  assert.deepEqual(compile(back, exampleCtx()).transforms.map((t) => t.transformId), ['zoom_01']);
  // A restore edge inside a word is a new mid-word cut.
  rejects(() => patch(cut, { op: 'restore_span', assetId: 'take_a', sourceStartUs: 2_340_000, sourceEndUs: 2_500_000 }), 'invalid_op');
});

test('regression: generated ids never collide with existing ids', () => {
  const r1 = patch(plan(), { op: 'restore_span', assetId: 'take_a', sourceStartUs: 0, sourceEndUs: 1_000_000 });
  const r2 = patch(r1, { op: 'remove_span', assetId: 'take_a', sourceStartUs: 0, sourceEndUs: 500_000, reason: 'x' });
  assert.deepEqual(r2.segments.map((g) => g.id), ['take_a_restored_0', 'speech_01']); // piece [0.5s,1s) kept the id
  const r3 = patch(r2, { op: 'restore_span', assetId: 'take_a', sourceStartUs: 0, sourceEndUs: 500_000 });
  assert.deepEqual(r3.segments.map((g) => [g.id, g.sourceStartUs]), [['take_a_restored_0_1', 0], ['take_a_restored_0', 500_000], ['speech_01', 1_000_000]]);
});

test('regression: a cut that orphans a locked anchored object is refused', () => {
  const cutW06 = { op: 'remove_span', assetId: 'take_a', sourceStartUs: 2_340_000, sourceEndUs: 2_620_000, reason: 'x' } as const;
  const p = plan();
  p.transforms[0]!.locked = true; // zoom_01 anchored on w06
  rejects(() => patch(p, cutW06), 'locked_object');
  const v = plan();
  v.visuals[0]!.locked = true; // flow_01 anchored on w01
  rejects(() => patch(v, { op: 'remove_span', assetId: 'take_a', sourceStartUs: 1_000_000, sourceEndUs: 1_270_000, reason: 'x' }), 'locked_object');
  // Cutting a word the locked object does not use is still allowed.
  assert.equal(patch(p, { op: 'remove_span', assetId: 'take_a', sourceStartUs: 3_700_000, sourceEndUs: 4_000_000, reason: 'x' }).transforms[0]!.locked, true);
});
