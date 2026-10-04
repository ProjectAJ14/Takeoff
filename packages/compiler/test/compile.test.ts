import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, type EditPlan } from '@takeoff/contracts';
import { compile, CompileError, isExportBlocking, framesToSamples, frameToUs, merge, outputToSource, planHash, sourceToOutput, subtract, usToFrames, validatePlan } from '../src/index.ts';
import { examplePlan, exampleCtx, manifest } from './helpers.ts';

const codes = (plan: unknown, ctx = exampleCtx()) => validatePlan(plan, ctx);
const errorCodes = (plan: unknown, ctx = exampleCtx()) => codes(plan, ctx).errors.map((e) => e.code);

test('clock: rational fps and 48 kHz samples', () => {
  assert.equal(usToFrames(3_000_000, { num: 30, den: 1 }), 90);
  assert.equal(usToFrames(1_000_000, { num: 30000, den: 1001 }), 29); // 29.97
  assert.equal(framesToSamples(90, { num: 30, den: 1 }), 144000);
  assert.equal(framesToSamples(1, { num: 30000, den: 1001 }), 1601); // 1601.6 floored
  assert.equal(frameToUs(1, { num: 30, den: 1 }), 33334); // ceil(33333.3)
  assert.deepEqual(subtract({ start: 0, end: 10 }, { start: 3, end: 5 }), [{ start: 0, end: 3 }, { start: 5, end: 10 }]);
  assert.deepEqual(merge([{ start: 5, end: 9 }, { start: 0, end: 5 }, { start: 12, end: 12 }]), [{ start: 0, end: 9 }]);
});

test('PRD 9.3 fixture compiles to frames [0,90) and samples [0,144000)', () => {
  const tl = compile(examplePlan(), exampleCtx());
  assert.ok(validate('compiled-timeline', tl).ok);
  assert.equal(tl.totalFrames, 90);
  assert.equal(tl.totalSamples, 144000);
  assert.deepEqual(tl.segments, [
    { segmentId: 'speech_01', assetId: 'take_a', sourceStartUs: 1000000, sourceEndUs: 4000000, outputStartFrame: 0, outputEndFrame: 90, outputStartSample: 0, outputEndSample: 144000 },
  ]);
  // Caption groups use final word timing: w01 [1.00s) -> frame 0; w05 ends 2.33s -> frame 39; w06 starts 2.35s -> 40.
  assert.deepEqual(tl.captions.map((c) => [c.captionId, c.startFrame, c.endFrame]), [['caption_01', 0, 39], ['caption_02', 40, 88]]);
  assert.deepEqual(tl.visuals, [{ visualId: 'flow_01', kind: 'motion_template', startFrame: 0, endFrame: 90 }]);
  assert.deepEqual(tl.transforms, [{ transformId: 'zoom_01', kind: 'punch', startFrame: 40, endFrame: 90 }]);
  assert.deepEqual(tl.audioEvents.map((a) => [a.kind, a.startSample, a.endSample]), [['dialogue', 0, 144000], ['music', 0, 144000]]);
});

test('compile is deterministic and planHash ignores key order', () => {
  const a = compile(examplePlan(), exampleCtx());
  const b = compile(examplePlan(), exampleCtx());
  assert.deepEqual(a, b);
  const p = examplePlan();
  const reordered = Object.fromEntries(Object.entries(p).reverse()) as unknown as EditPlan;
  assert.equal(planHash(reordered), planHash(p));
  assert.match(a.planHash, /^[0-9a-f]{64}$/);
});

test('source/output mapping on the fixture', () => {
  const p = examplePlan();
  assert.equal(sourceToOutput(p, 'take_a', 999_999), null); // cut by decision_01
  assert.equal(sourceToOutput(p, 'take_a', 1_000_000), 0);
  assert.equal(sourceToOutput(p, 'take_a', 3_999_999), 89);
  assert.equal(sourceToOutput(p, 'take_a', 4_000_000), null); // half-open end
  assert.deepEqual(outputToSource(p, 45), { segmentId: 'speech_01', assetId: 'take_a', us: 2_500_000 });
  assert.equal(outputToSource(p, 90), null);
});

test('disabled toggles produce no layer', () => {
  const p = examplePlan();
  Object.assign(p.settings, { captions: false, zoom: false, music: false, motionGraphics: false });
  const tl = compile(p, exampleCtx());
  assert.deepEqual([tl.captions, tl.visuals, tl.transforms], [[], [], []]);
  assert.deepEqual(tl.audioEvents.map((a) => a.kind), ['dialogue']);
});

test('hard errors: PRD 9.2', async (t) => {
  const cases: Array<[string, (p: EditPlan) => void, string]> = [
    ['unknown version', (p) => ((p as { schemaVersion: string }).schemaVersion = '2.0'), 'schema'],
    ['unknown enum', (p) => ((p.output as { lengthPolicy: string }).lengthPolicy = 'roughly'), 'schema'],
    ['asset not in plan', (p) => (p.segments[0]!.assetId = 'take_z'), 'asset_unresolved'],
    ['span beyond source', (p) => (p.segments[0]!.sourceEndUs = 13_000_000), 'source_bounds'],
    ['reversed span', (p) => (p.decisions[0]!.sourceEndUs = 0), 'impossible_range'],
    ['segment word missing', (p) => p.segments[0]!.wordIds.push('w99'), 'word_unresolved'],
    ['segment word outside span', (p) => (p.segments[0]!.sourceEndUs = 3_000_000), 'word_outside_segment'],
    ['caption word cut', (p) => p.segments[0]!.wordIds.splice(2, 1), 'caption_word_removed'],
    ['visual past timeline end', (p) => (p.visuals[0]!.durationFrames = 91), 'track_exceeds_timeline'],
    ['visual before timeline start', (p) => (p.visuals[0]!.anchor.offsetFrames = -1), 'track_exceeds_timeline'],
    ['music past timeline end', (p) => (p.audio.music!.durationFrames = 91), 'track_exceeds_timeline'],
    ['speed change', (p) => (p.segments[0]!.speed = { num: 2, den: 1 }), 'speed_unsupported'],
    ['duplicate id', (p) => (p.captions[1]!.id = 'caption_01'), 'duplicate_id'],
    ['hard max exceeded', (p) => (p.output.targetFrames = 60), 'hard_max_exceeded'],
    ['declared conflict that is only a warning-level marker', (p) => ((p.output.targetFrames = 60), p.reviewMarkers.push({ id: 'm1', kind: 'duration_conflict', severity: 'warning', message: 'x', refs: [] })), 'hard_max_exceeded'],
  ];
  for (const [name, mutate, code] of cases) {
    await t.test(name, () => {
      const p = examplePlan();
      mutate(p);
      assert.ok(errorCodes(p).includes(code), `${code} not in ${errorCodes(p).join(',')}`);
      assert.throws(() => compile(p, exampleCtx()), CompileError);
    });
  }
});

test('configured limits: zoom scale and gain', () => {
  const ctx = { ...exampleCtx(), limits: { maxPunchScale: 1.1, maxGainDb: -30 } };
  const errs = validatePlan(examplePlan(), ctx).errors;
  assert.deepEqual(errs.map((e) => [e.code, e.refs[0]]), [['limit_exceeded', 'zoom_01'], ['limit_exceeded', 'music_a']]);
  // A limit looser than 1.25 is clamped to the PRD ceiling.
  const p = examplePlan();
  (p.transforms[0] as { scale: number }).scale = 1.25;
  assert.deepEqual(validatePlan(p, { ...exampleCtx(), limits: { maxPunchScale: 3 } }).errors, []);
});

test('missing manifest and manifest kind mismatch are errors', () => {
  const ctx = exampleCtx();
  assert.ok(errorCodes(examplePlan(), { ...ctx, manifests: { take_a: ctx.manifests.take_a! } }).includes('asset_unresolved'));
  assert.ok(errorCodes(examplePlan(), { ...ctx, manifests: { ...ctx.manifests, take_a: manifest('take_a', 'audio', 12_000_000) } }).includes('asset_unresolved'));
  // An id that names an Object.prototype member never resolves.
  const p = examplePlan();
  p.segments[0]!.assetId = 'constructor';
  assert.ok(errorCodes(p).includes('asset_unresolved'));
});

test('warnings allow a draft: orphaned anchor, review decision, soft target', () => {
  const p = examplePlan();
  p.transforms[0] = { ...p.transforms[0]!, anchor: { wordId: 'w99', edge: 'start', offsetFrames: 0 } } as EditPlan['transforms'][number];
  p.decisions[0]!.action = 'review';
  Object.assign(p.output, { lengthPolicy: 'soft_target', targetFrames: 300 });
  const r = validatePlan(p, exampleCtx());
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings.map((w) => w.code).sort(), ['orphaned_anchor', 'soft_target_missed', 'uncertain_retake']);
  const tl = compile(p, exampleCtx());
  assert.deepEqual(tl.transforms, []);
  assert.equal(tl.warnings.length, 3);
});

test('regression: clock helpers floor (not truncate) negative values', () => {
  const fps = { num: 30, den: 1 };
  assert.equal(usToFrames(-1, fps), -1);
  assert.equal(frameToUs(-1, fps), -33333); // ceil(-33333.3)
  assert.equal(framesToSamples(-1, { num: 30000, den: 1001 }), -1602);
});

test('regression: an asset must fit its role; an image never stands in for speech or audio', () => {
  const ctx = exampleCtx();
  const image = { ...manifest('take_a', 'video', 12_000_000), kind: 'image' as const, probe: { durationUs: null, video: null, audio: null } };
  const p = examplePlan();
  p.assets[0]!.kind = 'image';
  p.segments[0]!.sourceEndUs = 400_000_000_000; // unbounded source span on a still
  assert.ok(errorCodes(p, { ...ctx, manifests: { ...ctx.manifests, take_a: image } }).includes('asset_unresolved'));
  // Music must be audio.
  const m = examplePlan();
  m.assets[1]!.kind = 'video';
  assert.deepEqual(errorCodes(m, { ...ctx, manifests: { ...ctx.manifests, music_a: manifest('music_a', 'video', 60_000_000) } }), ['asset_unresolved']);
});

test('regression: soft target tolerance is exactly 10% (not rounded up) when above 2 s', () => {
  // 662 frames retained; target 601 -> miss 61 > 60.1 (10%) and > 60 (2 s): flagged. ceil(60.1) = 61 used to admit it.
  const ctx = exampleCtx();
  const p = examplePlan();
  p.segments[0]!.sourceEndUs = 1_000_000 + 22_066_667;
  Object.assign(p.output, { lengthPolicy: 'soft_target', targetFrames: 601 });
  const wide = { ...ctx, manifests: { ...ctx.manifests, take_a: manifest('take_a', 'video', 24_000_000) } };
  assert.equal(compile(p, wide).totalFrames, 662);
  assert.deepEqual(validatePlan(p, wide).warnings.map((w) => w.code), ['soft_target_missed']);
  p.output.targetFrames = 602; // miss 60 <= 60.2
  assert.deepEqual(validatePlan(p, wide).warnings, []);
});

test('F14: essential speech over a hard max is a longer draft with an export-blocking conflict', () => {
  const locked = examplePlan();
  locked.output.targetFrames = 60;
  locked.segments[0]!.locked = true;
  const declared = examplePlan();
  declared.output.targetFrames = 60;
  declared.reviewMarkers.push({ id: 'marker_duration_conflict', kind: 'duration_conflict', severity: 'critical', message: 'needs 90 frames', refs: ['speech_01'] });
  for (const p of [locked, declared]) {
    const r = validatePlan(p, exampleCtx());
    assert.deepEqual(r.errors, []);
    const c = r.warnings.find((w) => w.code === 'locked_duration_conflict');
    assert.ok(c && isExportBlocking(c));
    assert.equal(compile(p, exampleCtx()).totalFrames, 90, 'draft compiles longer than the maximum');
  }
  // Ordinary warnings never block export.
  assert.equal(isExportBlocking({ code: 'soft_target_missed' }), false);
  assert.equal(isExportBlocking({ code: 'duration_conflict' }), false);
});
