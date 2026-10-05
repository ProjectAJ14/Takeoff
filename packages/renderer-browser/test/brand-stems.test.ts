// F17 logo, export stems from the mix's own buses, and QA face samples.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { platformSafeArea, type FaceTrack } from '@takeoff/renderer-api';
import { RenderError, renderStems, renderStill } from '../src/index.ts';
import { faceSamples, newGraph, stemGraph, type ComposeContext } from '../src/compose.ts';
import { ffprobeJson, fixture, gen, rgba, tempDir } from './helpers.ts';
import { spawnSync } from 'node:child_process';

const dir = await tempDir();
const { input, plan } = await fixture(dir);
const base: ComposeContext = { compiled: input.compiled, plan, assets: input.assets, width: 540, height: 960, draft: true, colors: new Map() };

test('logo: drawn with its aspect in the safe area top-right corner; a hash mismatch is invalid_input', async () => {
  const logo = join(dir, 'logo.png');
  gen('-f', 'lavfi', '-i', 'color=c=0xFF00FF:s=400x100', '-frames:v', '1', logo); // 4:1 magenta
  const hash = createHash('sha256').update(readFileSync(logo)).digest('hex');
  // Frame 100: after the hook, which is drawn over the logo while it shows.
  const png = await renderStill({ ...input, logo: { path: logo, hash } } as typeof input, 100);
  const px = rgba(png);
  const W = 540;
  const at = (x: number, y: number) => [...px.subarray((y * W + x) * 4, (y * W + x) * 4 + 3)];
  // Safe area at 540x960 (platformSafeArea): logo box 108x58 → 108x27 (4:1 kept), right-aligned at the safe edge.
  const safe = platformSafeArea(540, 960);
  const magenta = (p: number[]) => p[0]! > 200 && p[1]! < 60 && p[2]! > 200;
  // Rows where the logo spans its full 108 px width (the test pattern has other magenta blocks, never that wide).
  let rows = 0;
  for (let y = safe.y; y < safe.y + 60; y++) {
    let run = 0;
    for (let x = safe.x + safe.w - 110; x < safe.x + safe.w; x++) run += magenta(at(x, y)) ? 1 : 0;
    if (run >= 104) rows++;
  }
  assert.ok(rows >= 25 && rows <= 28, `logo is ${rows} rows tall; 4:1 at 108 px wide is 27`);
  await assert.rejects(renderStill({ ...input, logo: { path: logo, hash: '0'.repeat(64) } } as typeof input, 3), (e: unknown) => e instanceof RenderError && e.code === 'invalid_input');
});

test('stems: three exact-length WAVs from the mix buses; music is ducked and non-silent; unused buses are sunk', async () => {
  const g = newGraph();
  stemGraph(g, base, 'music');
  const text = g.filters.join(';');
  assert.match(text, /sidechaincompress/, 'music stem keeps the ducking');
  assert.match(text, /anullsink/);
  const out = join(dir, 'stems');
  mkdirSync(out);
  const files = await renderStems(input, out);
  for (const s of ['dialogue', 'music', 'sfx'] as const) {
    const st = (ffprobeJson(files[s], '-show_streams') as { streams: Array<{ duration_ts: number; sample_rate: string; channels: number }> }).streams[0]!;
    assert.deepEqual([st.duration_ts, Number(st.sample_rate), st.channels], [input.compiled.totalSamples, 48000, 2], s);
  }
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', files.music, '-af', 'volumedetect', '-f', 'null', '-']).stderr.toString();
  assert.ok(Number(/max_volume: (-?[\d.]+) dB/.exec(r)![1]) > -60, 'music stem is not silent');
});

test('face samples: a confident face yields an in-frame rect per segment; none without tracks', () => {
  assert.deepEqual(faceSamples(base), []);
  const track: Record<string, FaceTrack> = { land: { width: 1920, height: 1080, track: [{ startUs: 0, endUs: 6_000_000, x: 900, y: 300, w: 200, h: 200, confidence: 0.9 }] } };
  const s = faceSamples({ ...base, faceTracks: track });
  assert.ok(s.length >= 1);
  for (const f of s) assert.ok(f.rect.x >= 0 && f.rect.x + f.rect.w <= 540 && f.rect.y >= 0 && f.rect.y + f.rect.h <= 960, JSON.stringify(f));
});
