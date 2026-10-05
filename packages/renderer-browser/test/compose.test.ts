import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compile } from '@takeoff/compiler';
import { cropFractions, zoomAt } from '../src/index.ts';
import { TP_MARGIN_DB, audioGraph, newGraph, videoGraph, type ComposeContext } from '../src/compose.ts';
import { fixture, tempDir } from './helpers.ts';

const { input, plan, ctx } = await fixture(await tempDir());
const c: ComposeContext = { compiled: input.compiled, plan, assets: input.assets, width: 540, height: 960, draft: true, colors: new Map() };

test('punch zoom eases in over transitionFrames, holds at scale, and ends with its span', () => {
  const z = input.compiled.transforms.find((t) => t.kind === 'punch')!;
  assert.equal(zoomAt(c, z.startFrame - 1), 1);
  assert.equal(zoomAt(c, z.startFrame), 1);
  const ramp = [1, 2, 3, 4].map((k) => zoomAt(c, z.startFrame + k));
  for (let i = 1; i < ramp.length; i++) assert.ok(ramp[i]! >= ramp[i - 1]!);
  assert.equal(zoomAt(c, z.startFrame + 4), 1.15);
  assert.equal(zoomAt(c, z.endFrame - 1), 1.15);
  assert.equal(zoomAt(c, z.endFrame), 1);
});

test('crops keep the output aspect and never leave the source, for any plan crop rect', () => {
  for (const rect of [{ x: 0, y: 0, width: 1, height: 1 }, { x: 0.9, y: 0, width: 0.1, height: 1 }, { x: 0, y: 0.7, width: 1, height: 0.3 }, { x: 0.25, y: 0.1, width: 0.5, height: 0.9 }]) {
    const p = { ...plan, transforms: [{ id: 'cr', segmentId: 's1', kind: 'crop' as const, rect, locked: false }] };
    for (const src of [{ w: 1920, h: 1080 }, { w: 1080, h: 1920 }]) {
      const f = cropFractions({ ...c, plan: p }, 's1', src);
      assert.ok(f.fx >= 0 && f.fy >= 0 && f.fx + f.fw <= 1 + 1e-9 && f.fy + f.fh <= 1 + 1e-9, JSON.stringify({ rect, src, f }));
      assert.ok(Math.abs((f.fw * src.w) / (f.fh * src.h) - 1080 / 1920) < 1e-9);
    }
  }
});

test('filter graph text carries numbers and labels only: no paths, captions or labels from the plan', () => {
  const evil = structuredClone(plan);
  evil.captions[0]!.text = "a';[0:v]drawtext=text=x[o]; b c d e";
  const flow = evil.visuals.find((v) => v.id === 'flow')!;
  if (flow.kind === 'motion_template' && flow.template === 'request_flow_v1') flow.params.edgeLabel = "'[x]amovie=/etc/passwd";
  const compiled = compile(evil, ctx);
  const g = newGraph();
  videoGraph(g, { ...c, plan: evil, compiled }, 0, compiled.totalFrames);
  audioGraph(g, { ...c, plan: evil, compiled }, null);
  const text = g.filters.join(';');
  for (const bad of ['drawtext', 'amovie', 'passwd', ...Object.values(input.assets).map((a) => a.path)]) assert.ok(!text.includes(bad), bad);
  // Paths only ever appear as `file:` input arguments.
  for (const a of Object.values(input.assets)) if (g.args.some((x) => x.includes(a.path))) assert.ok(g.args.includes(`file:${a.path}`));
});

test('the sample-peak limiter sits under the true-peak target, leaving codec/inter-sample margin', () => {
  const g = newGraph();
  audioGraph(g, c, null);
  const limit = Number(/alimiter=limit=([0-9.]+)/.exec(g.filters.join(';'))![1]);
  assert.ok(TP_MARGIN_DB >= 1);
  assert.ok(20 * Math.log10(limit) <= plan.audio.mixTarget.truePeakDbtp - TP_MARGIN_DB + 0.01, String(limit));
});
