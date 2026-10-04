import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { MediaError, analyzeColor, analyzeVoice, detectSilence, extractFrame, measureLoudness, thumbnail, waveformPeaks } from '../src/index.ts';
import { gen, genAv, tempDir } from './helpers.ts';

const dir = await tempDir();

test('loudness of a -20 dBFS 1 kHz stereo sine is -20 LUFS with a -20 dBTP true peak', async () => {
  const f = join(dir, 's20.wav');
  gen('-f', 'lavfi', '-i', 'aevalsrc=0.1*sin(2*PI*1000*t)|0.1*sin(2*PI*1000*t):s=48000:d=5', f);
  const l = await measureLoudness(f);
  assert.ok(Math.abs(l.integratedLufs! - -20) < 0.3, String(l.integratedLufs));
  assert.ok(Math.abs(l.truePeakDbtp! - -20) < 0.3, String(l.truePeakDbtp));
  assert.ok(l.lraLu! < 1);
});

test('detectSilence finds a middle gap and a trailing one that ends at EOF', async () => {
  const f = join(dir, 'gaps.wav');
  gen('-f', 'lavfi', '-i', "aevalsrc='if(between(t,1,2.5)+gt(t,3.5),0,0.3*sin(2*PI*440*t))':s=16000:d=4.5", f);
  const s = await detectSilence(f, { thresholdDb: -40, minDurationUs: 500_000 });
  assert.equal(s.length, 2);
  assert.ok(Math.abs(s[0]!.startUs - 1_000_000) < 20_000 && Math.abs(s[0]!.endUs - 2_500_000) < 20_000);
  assert.ok(Math.abs(s[1]!.endUs - 4_500_000) < 20_000);
  await assert.rejects(detectSilence(f, { thresholdDb: Number.NaN }));
});

test('analyzeVoice reports clipping and DC offset', async () => {
  const clean = join(dir, 'clean.wav');
  const clipped = join(dir, 'clipped.wav');
  gen('-f', 'lavfi', '-i', 'aevalsrc=0.2*sin(2*PI*220*t)+0.1:s=16000:d=2', clean);
  gen('-f', 'lavfi', '-i', 'aevalsrc=clip(2*sin(2*PI*220*t)\\,-1\\,1):s=16000:d=2', clipped);
  const a = await analyzeVoice(clean);
  assert.equal(a.clippingRatio, 0);
  assert.ok(Math.abs(a.dcOffset - 0.1) < 0.01, String(a.dcOffset));
  const b = await analyzeVoice(clipped);
  assert.ok(b.clippingRatio > 0.3, String(b.clippingRatio));
});

test('analyzeColor reads a 10-bit source on the same 8-bit scale', async () => {
  const eight = join(dir, 'c8.mkv');
  const ten = join(dir, 'c10.mkv');
  gen('-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=1', '-c:v', 'ffv1', '-pix_fmt', 'yuv420p', eight);
  gen('-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=1', '-c:v', 'ffv1', '-pix_fmt', 'yuv420p10le', ten);
  const [a, b] = [await analyzeColor(eight, { samples: 2 }), await analyzeColor(ten, { samples: 2 })];
  for (const k of ['yavg', 'uavg', 'vavg', 'ymax'] as const) assert.ok(Math.abs(a.stats[k] - b.stats[k]) < 2, `${k} ${a.stats[k]} vs ${b.stats[k]}`);
  assert.equal(b.correction.brightness, a.correction.brightness);
  for (const k of ['rm', 'gm', 'bm'] as const) assert.ok(Math.abs(a.correction.colorbalance[k] - b.correction.colorbalance[k]) < 0.002);
});

test('analyzeColor brightens dark footage, counters a red cast, and stays within bounds', async () => {
  const dark = join(dir, 'dark.mp4');
  const red = join(dir, 'red.mp4');
  gen('-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=2,eq=brightness=-0.3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', dark);
  gen('-f', 'lavfi', '-i', 'color=c=0xB08070:s=320x240:r=30:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', red);
  const d = await analyzeColor(dark, { samples: 4 });
  assert.ok(d.correction.brightness > 0 && d.correction.brightness <= 0.08);
  const r = await analyzeColor(red, { samples: 4 });
  assert.ok(r.correction.colorbalance.rm < 0);
  for (const c of [d.correction, r.correction]) {
    assert.ok(c.contrast >= 1 && c.contrast <= 1.15 && c.saturation >= 1 && c.saturation <= 1.1);
    for (const v of Object.values(c.colorbalance)) assert.ok(Math.abs(v) <= 0.1);
  }
});

test('waveformPeaks returns the requested bucket count in 0..1', async () => {
  const f = join(dir, 'w.wav');
  gen('-f', 'lavfi', '-i', "aevalsrc='if(lt(t,1),0.5*sin(2*PI*200*t),0)':s=16000:d=2", f);
  const p = await waveformPeaks(f, { buckets: 100 });
  assert.equal(p.length, 100);
  assert.ok(Math.max(...p.slice(0, 45)) > 0.4);
  assert.equal(Math.max(...p.slice(55)), 0);
});

test('extractFrame is frame-exact and thumbnail writes a PNG', async () => {
  const v = genAv(join(dir, 'v.mp4'), 3);
  const atUs = join(dir, 'at.png');
  const frame = async (n: number) => {
    const f = join(dir, `ref${n}.png`);
    gen('-i', v, '-vf', `select=eq(n\\,${n})`, '-frames:v', '1', '-f', 'image2', '-c:v', 'png', f);
    return readFile(f);
  };
  const at = async (us: number) => (await extractFrame(v, us, atUs), readFile(atUs));
  const [f45, f46, f89] = [await frame(45), await frame(46), await frame(89)];
  // Frame 45 occupies [1.5 s, 1.5333 s): its start, its middle and just before its end all show it.
  assert.deepEqual(await at(1_500_000), f45);
  assert.deepEqual(await at(1_520_000), f45);
  assert.deepEqual(await at(1_533_000), f45);
  assert.deepEqual(await at(1_540_000), f46);
  assert.deepEqual(await at(2_990_000), f89);
  // Half-open: the clip's last frame ends at 3.0 s, so 3.0 s and later show nothing.
  await assert.rejects(at(3_000_000), (e: unknown) => e instanceof MediaError && e.code === 'invalid_argument');
  const thumb = join(dir, 'thumb.png');
  await thumbnail(v, thumb, { width: 160 });
  assert.deepEqual([...(await readFile(thumb)).subarray(1, 4)], [...Buffer.from('PNG')]);
  await assert.rejects(extractFrame(v, 1.5, atUs));
});
