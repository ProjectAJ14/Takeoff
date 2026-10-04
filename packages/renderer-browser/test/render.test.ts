import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { hashFile, measureLoudness } from '@takeoff/media';
import { captionBox, rectInside } from '@takeoff/renderer-api';
import { BrowserRenderer, RenderError } from '../src/index.ts';
import { ffprobeJson, fixture, tempDir } from './helpers.ts';

const dir = await tempDir();
const { input } = await fixture(dir);
const out = join(dir, 'out.mp4');
const progress: number[] = [];
const art = await new BrowserRenderer().render(input, { outPath: out, profile: 'draft', onProgress: (p) => progress.push(p.frame) });
type Stream = { codec_type: string; nb_read_frames?: string; duration_ts?: number; time_base?: string; width?: number; height?: number; pix_fmt?: string; color_space?: string; color_primaries?: string; color_transfer?: string };
const streams = (ffprobeJson(out, '-count_frames', '-show_entries', 'stream=codec_type,nb_read_frames,duration_ts,time_base,width,height,pix_fmt,color_space,color_primaries,color_transfer') as { streams: Stream[] }).streams;
const video = streams.find((s) => s.codec_type === 'video')!;
const audio = streams.find((s) => s.codec_type === 'audio')!;

test('draft output decodes to exactly the compiled frame and sample counts', () => {
  assert.equal(input.compiled.totalFrames, 117);
  assert.equal(Number(video.nb_read_frames), input.compiled.totalFrames);
  assert.equal(audio.time_base, '1/48000');
  assert.equal(audio.duration_ts, input.compiled.totalSamples);
});

test('audio and video durations are equal', () => {
  const { num, den } = input.compiled.fps;
  // frames * den / num seconds == samples / 48000 seconds, compared exactly in integers.
  assert.equal(Number(video.nb_read_frames) * den * 48000, audio.duration_ts! * num);
});

test('draft is 540x960 yuv420p tagged BT.709', () => {
  assert.deepEqual([video.width, video.height, video.pix_fmt], [540, 960, 'yuv420p']);
  assert.deepEqual([video.color_space, video.color_primaries, video.color_transfer], ['bt709', 'bt709', 'bt709']);
});

test('artifact names the file, its hash, inputs and environment; no partial is left', async () => {
  assert.equal(art.sha256, await hashFile(out));
  assert.equal(art.durationFrames, 117);
  assert.equal(art.planHash, input.compiled.planHash);
  assert.equal(art.seed, 7);
  assert.equal(art.rendererId, 'browser-chromium');
  for (const k of ['chromium', 'ffmpeg', 'sceneRuntime', 'compiler', 'rendererBrowser']) assert.ok(art.versions[k], k);
  assert.ok(!existsSync(`${out}.partial.mp4`));
  assert.equal(progress.at(-1), 117);
  // Dedupe: held frames (static caption, settled scenes) reuse the previous PNG.
  assert.ok(art.overlayCaptures < 117, String(art.overlayCaptures));
});

test('Studio voice mix lands within ±1 LU of -14 LUFS with true peak at or below -1 dBTP', async () => {
  const l = await measureLoudness(out);
  assert.ok(Math.abs(l.integratedLufs! - -14) <= 1, String(l.integratedLufs));
  assert.ok(l.truePeakDbtp! <= -1, String(l.truePeakDbtp));
});

test('every caption stays inside its safe caption box and the overlay report is clean', () => {
  assert.deepEqual(art.overlay.violations, []);
  assert.equal(art.overlay.captionBounds.length, 3);
  for (const { captionId, rect } of art.overlay.captionBounds) {
    assert.ok(rect.w > 0 && rect.h > 0, captionId);
    assert.ok(rectInside(rect, captionBox(540, 960, 'safe_face_aware')), `${captionId} ${JSON.stringify(rect)}`);
  }
});

test('a timeline not compiled from the plan is refused before anything runs', async () => {
  const plan = { ...input.plan, revision: 2 };
  await assert.rejects(new BrowserRenderer().render({ ...input, plan }, { outPath: join(dir, 'x.mp4'), profile: 'draft' }), (e: unknown) => e instanceof RenderError && e.code === 'invalid_input');
  assert.ok(!existsSync(join(dir, 'x.mp4')));
});

test('an output path that is a render input (or whose partial is one) is refused; the source stays untouched', async () => {
  const src = input.assets.land!.path;
  const before = readFileSync(src);
  const refused = (e: unknown) => e instanceof RenderError && e.code === 'invalid_input';
  await assert.rejects(new BrowserRenderer().render(input, { outPath: src, profile: 'draft' }), refused);
  const extra = { ...input.assets.land!, path: join(dir, 'y.mp4.partial.mp4') };
  await assert.rejects(new BrowserRenderer().render({ ...input, assets: { ...input.assets, extra } }, { outPath: join(dir, 'y.mp4'), profile: 'draft' }), refused);
  assert.ok(readFileSync(src).equals(before));
});
