// PRD 19 property tests: half-open intervals, rounding, rational rates, source/output mapping.
// Hand-rolled seeded PRNG; a failure message names the seed so it can be replayed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EditPlan, Rational, Segment } from '@takeoff/contracts';
import { compile, contains, framesToSamples, frameToUs, usToFrames, intersect, merge, outputToSource, sourceToOutput, subtract, type Interval } from '../src/index.ts';
import { examplePlan, manifest, rng } from './helpers.ts';

const RUNS = 300;
const FPS: Rational[] = [{ num: 30, den: 1 }, { num: 30000, den: 1001 }, { num: 24000, den: 1001 }, { num: 25, den: 1 }, { num: 60, den: 1 }, { num: 24, den: 1 }];

const randInterval = (r: (n: number) => number): Interval => {
  const a = r(60), b = r(60);
  return { start: Math.min(a, b), end: Math.max(a, b) };
};

test('half-open interval invariants', () => {
  for (let seed = 1; seed <= RUNS; seed++) {
    const r = rng(seed);
    const a = randInterval(r), b = randInterval(r);
    const list = Array.from({ length: r(6) }, () => randInterval(r));
    const pieces = subtract(a, b);
    const merged = merge(list);
    const i = intersect(a, b);
    for (let x = -1; x <= 61; x++) {
      const msg = `seed ${seed} x ${x}`;
      assert.equal(i !== null && contains(i, x), contains(a, x) && contains(b, x), msg);
      assert.equal(pieces.some((p) => contains(p, x)), contains(a, x) && !contains(b, x), msg);
      assert.equal(merged.some((m) => contains(m, x)), list.some((l) => contains(l, x)), msg);
    }
    assert.equal(contains(a, a.end), false); // end is exclusive
    assert.ok(pieces.every((p) => p.start < p.end));
    for (let k = 1; k < merged.length; k++) assert.ok(merged[k]!.start > merged[k - 1]!.end, `seed ${seed}: merged pieces touch or overlap`);
  }
});

/** Disjoint chronological spans of one asset, some shorter than a frame. */
function randomPlan(r: (n: number) => number): { plan: EditPlan; durationUs: number } {
  const durationUs = 1 + r(600_000_000);
  const cuts = [...new Set(Array.from({ length: 2 + 2 * r(10) }, () => r(durationUs + 1)))].sort((x, y) => x - y);
  const segments: Segment[] = [];
  for (let k = 0; k + 1 < cuts.length; k += 2) {
    segments.push({ id: `s${k}`, assetId: 'take_a', sourceStartUs: cuts[k]!, sourceEndUs: cuts[k + 1]!, wordIds: [], speed: { num: 1, den: 1 }, cropPolicy: 'center', locked: false });
  }
  const plan = examplePlan();
  Object.assign(plan, { segments, decisions: [], captions: [], visuals: [], transforms: [] });
  Object.assign(plan.output, { fps: FPS[r(FPS.length)]!, targetFrames: null, lengthPolicy: 'none' });
  plan.audio.music = null;
  return { plan, durationUs };
}

test('compiled output: no gaps or overlaps, totals floor the retained duration', () => {
  for (let seed = 1; seed <= RUNS; seed++) {
    const r = rng(seed);
    const { plan, durationUs } = randomPlan(r);
    if (!plan.segments.length) continue;
    if (r(2)) plan.segments.reverse(); // output order need not be source order
    const fps = plan.output.fps;
    const tl = compile(plan, { transcripts: {}, manifests: { take_a: manifest('take_a', 'video', durationUs), music_a: manifest('music_a', 'audio', 1) } });
    const msg = `seed ${seed}`;
    let frame = 0, sample = 0;
    for (const s of tl.segments) {
      assert.equal(s.outputStartFrame, frame, msg);
      assert.equal(s.outputStartSample, sample, msg);
      assert.ok(s.outputEndFrame >= s.outputStartFrame && s.outputEndSample >= s.outputStartSample, msg);
      // Each segment's frame count is within one frame of its own source length.
      const own = (s.sourceEndUs - s.sourceStartUs) * fps.num / (fps.den * 1e6);
      assert.ok(Math.abs(s.outputEndFrame - s.outputStartFrame - own) < 1, `${msg}: segment ${s.segmentId} drifts`);
      frame = s.outputEndFrame;
      sample = s.outputEndSample;
    }
    assert.equal(frame, tl.totalFrames, msg);
    assert.equal(sample, tl.totalSamples, msg);
    const retained = plan.segments.reduce((n, g) => n + BigInt(g.sourceEndUs - g.sourceStartUs), 0n);
    assert.equal(tl.totalFrames, Number((retained * BigInt(fps.num)) / (BigInt(fps.den) * 1_000_000n)), msg);
    assert.equal(tl.totalSamples, framesToSamples(tl.totalFrames, fps), msg);
  }
});

test('mapping: monotonic, half-open, and roundtrips within one frame', () => {
  for (let seed = 1; seed <= RUNS; seed++) {
    const r = rng(seed);
    const { plan, durationUs } = randomPlan(r);
    const fps = plan.output.fps;
    const frameUs = Math.ceil((fps.den * 1e6) / fps.num);
    const msg = `seed ${seed}`;
    const probes = Array.from({ length: 60 }, () => r(durationUs + 1)).concat(plan.segments.flatMap((g) => [g.sourceStartUs, g.sourceEndUs]));
    probes.sort((x, y) => x - y);
    let last = -1;
    for (const us of probes) {
      const f = sourceToOutput(plan, 'take_a', us);
      const inside = plan.segments.some((g) => us >= g.sourceStartUs && us < g.sourceEndUs);
      if (!inside) {
        assert.equal(f, null, `${msg}: cut instant ${us} mapped`);
        continue;
      }
      if (f === null) {
        // Only a sub-frame tail that the next frame boundary swallows may be unshown.
        const g = plan.segments.find((s) => us >= s.sourceStartUs && us < s.sourceEndUs)!;
        assert.ok(us - g.sourceStartUs >= frameToUs(usToFrames(g.sourceEndUs - g.sourceStartUs, fps), fps), `${msg}: ${us} unshown`);
        continue;
      }
      assert.ok(f >= last, `${msg}: mapping went backwards at ${us}`);
      last = f;
      const back = outputToSource(plan, f)!;
      assert.equal(back.assetId, 'take_a', msg);
      assert.ok(Math.abs(back.us - us) < frameUs, `${msg}: ${us} -> ${f} -> ${back.us}`);
      assert.equal(sourceToOutput(plan, 'take_a', back.us), f, msg);
    }
    assert.equal(sourceToOutput(plan, 'take_b', 0), null);
  }
});
