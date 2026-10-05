import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { MediaError, capabilities, diskPreflight, hashFile, parseProbe, probe } from '../src/index.ts';
import { gen, genAv, tempDir } from './helpers.ts';

const dir = await tempDir();
const plain = genAv(join(dir, 'plain.mp4'));

const isCode = (code: string) => (e: unknown) => e instanceof MediaError && e.code === code && e.remedy.length > 0;

test('probe reads streams, duration and CFR rate', async () => {
  const p = await probe(plain);
  assert.equal(p.kind, 'video');
  assert.ok(Math.abs(p.durationUs! - 2_000_000) < 50_000);
  assert.deepEqual([p.video!.width, p.video!.height, p.video!.rotation, p.video!.vfr], [320, 240, 0, false]);
  assert.deepEqual([p.video!.fpsNum, p.video!.fpsDen, p.video!.codec], [30, 1, 'h264']);
  assert.equal(p.audio!.codec, 'aac');
  assert.equal(p.hdr, false);
});

test('probe reports phone rotation clockwise from the display matrix', async () => {
  const rot = join(dir, 'rot.mp4');
  // A portrait phone clip: display matrix -90 (counter-clockwise) = rotate tag 90 clockwise.
  gen('-display_rotation:v:0', '-90', '-i', plain, '-c', 'copy', rot);
  assert.equal((await probe(rot)).video!.rotation, 90);
});

test('probe flags variable frame rate', async () => {
  const vfr = join(dir, 'vfr.mp4');
  gen('-f', 'lavfi', '-i', "testsrc2=s=320x240:r=30:d=3,setpts='if(lt(N,30),N,30+(N-30)*2)/30/TB'", '-c:v', 'libx264', '-fps_mode', 'passthrough', '-an', vfr);
  assert.equal((await probe(vfr)).video!.vfr, true);
});

test('probe reports a file without audio as visual-only', async () => {
  const na = join(dir, 'noaudio.mp4');
  gen('-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=1', '-c:v', 'libx264', '-an', na);
  const p = await probe(na);
  assert.equal(p.audio, null);
  assert.ok(p.video);
});

test('truncated file is corrupt; missing file is not_found; subtitle-only has no streams', async () => {
  const bad = join(dir, 'corrupt.mp4');
  await writeFile(bad, (await readFile(plain)).subarray(0, 20_000));
  await assert.rejects(probe(bad), isCode('corrupt'));
  await assert.rejects(probe(join(dir, 'nope.mp4')), isCode('not_found'));
  const srt = join(dir, 's.srt');
  await writeFile(srt, '1\n00:00:00,000 --> 00:00:01,000\nhi\n');
  await assert.rejects(probe(srt), isCode('no_streams'));
});

test('parseProbe: undecodable codec names the stream and a remedy; HDR transfer flagged', () => {
  const v = { index: 0, codec_type: 'video', codec_name: 'prores_raw', width: 1920, height: 1080, avg_frame_rate: '30/1', r_frame_rate: '30/1' };
  assert.throws(() => parseProbe({ streams: [v] }, new Set(['h264'])), (e: unknown) => isCode('unsupported_codec')(e) && /stream 0/.test((e as Error).message));
  const p = parseProbe({ streams: [{ ...v, codec_name: 'hevc', color_transfer: 'smpte2084', color_primaries: 'bt2020' }], format: { duration: '1.5' } }, new Set(['hevc']));
  assert.equal(p.hdr, true);
  assert.equal(p.durationUs, 1_500_000);
  assert.throws(() => parseProbe({ streams: [{ ...v, codec_name: 'h264', width: 20000 }] }, new Set(['h264'])), isCode('unsupported_dimensions'));
});

test('capabilities lists versions, required encoders and filters', async () => {
  const c = await capabilities();
  assert.match(c.ffmpegVersion, /\S/);
  assert.equal(c.encoders.libx264, true);
  assert.equal(c.filters.loudnorm, true);
  assert.ok(c.decoders.includes('h264') && c.decoders.includes('aac'));
  assert.deepEqual(c.missing, []);
});

test('diskPreflight adds 20% headroom', async () => {
  const ok = await diskPreflight(dir, 1000);
  assert.equal(ok.requiredBytes, 1200);
  assert.equal(ok.ok, true);
  assert.equal((await diskPreflight(dir, Number.MAX_SAFE_INTEGER / 2)).ok, false);
});

test('hashFile is sha256 hex', async () => {
  const f = join(dir, 'abc.txt');
  await writeFile(f, 'abc');
  assert.equal(await hashFile(f), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
