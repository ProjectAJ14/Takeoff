import assert from 'node:assert/strict';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { validate, type AssetManifest } from '@takeoff/contracts';
import { MediaError, hashFile, ingest, probe } from '../src/index.ts';
import { gen, genAv, tempDir } from './helpers.ts';

const dir = await tempDir();
const outside = join(dir, 'outside');
await mkdir(outside);
const rotated = join(outside, 'My Take (1).MP4');
gen('-display_rotation:v:0', '-90', '-i', genAv(join(dir, 'plain.mp4')), '-c', 'copy', rotated);

test('ingest leaves the original untouched and copies an outside file by hash', async () => {
  const root = join(dir, 'p1');
  await mkdir(root);
  const before = await hashFile(rotated);
  const mtime = (await stat(rotated)).mtimeMs;
  const r = await ingest(rotated, root);
  assert.equal(await hashFile(rotated), before);
  assert.equal((await stat(rotated)).mtimeMs, mtime);
  assert.equal(r.contentHash, before);
  assert.equal(r.copied, true);
  assert.equal(r.relativePath, `media/originals/${before}.mp4`);
  assert.equal(await hashFile(join(root, r.relativePath)), before);

  // The manifest the engine builds from this result validates against the contract.
  const { durationUs, video, audio } = r.probe;
  const manifest: AssetManifest = {
    schemaVersion: '1.0', id: 'asset_1', kind: r.probe.kind, contentHash: r.contentHash, relativePath: r.relativePath,
    probe: { durationUs, video, audio },
    derived: { proxy: r.derived.proxy!.sha256, analysisWav: r.derived.analysisWav!.sha256 },
    rights: { origin: 'user', license: null, attribution: null, sourceUrl: null },
    provenance: { importedAt: '2026-10-05T00:00:00Z', importer: 'media-0.0.0' },
    permissionScope: 'local_only',
  };
  const v = validate('asset-manifest', manifest);
  assert.ok(v.ok, JSON.stringify(!v.ok && v.errors));
});

test('proxy is CFR H.264 with rotation applied once; WAVs have the right formats', async () => {
  const root = join(dir, 'p2');
  await mkdir(root);
  const r = await ingest(rotated, root);
  const px = await probe(join(root, r.derived.proxy!.path));
  assert.equal(r.proxyFps, 30);
  assert.deepEqual([px.video!.width, px.video!.height, px.video!.rotation], [240, 320, 0]);
  assert.deepEqual([px.video!.fpsNum, px.video!.fpsDen, px.video!.vfr, px.video!.codec], [30, 1, false, 'h264']);
  const a = await probe(join(root, r.derived.analysisWav!.path));
  assert.deepEqual([a.audio!.sampleRate, a.audio!.channels, a.audio!.codec], [16000, 1, 'pcm_s16le']);
  const m = await probe(join(root, r.derived.masterWav!.path));
  assert.deepEqual([m.audio!.sampleRate, m.audio!.channels, m.audio!.codec], [48000, 2, 'pcm_s16le']);
});

test('a VFR source gets a CFR proxy', async () => {
  const root = join(dir, 'p3');
  await mkdir(root);
  const vfr = join(root, 'vfr.mp4');
  gen('-f', 'lavfi', '-i', "testsrc2=s=320x240:r=30:d=3,setpts='if(lt(N,30),N,30+(N-30)*2)/30/TB'", '-c:v', 'libx264', '-fps_mode', 'passthrough', '-an', vfr);
  const r = await ingest(vfr, root);
  assert.equal(r.copied, false);
  assert.equal(r.relativePath, 'vfr.mp4');
  assert.equal(r.derived.analysisWav, null);
  const px = await probe(join(root, r.derived.proxy!.path));
  assert.equal(px.video!.vfr, false);
  // Frames 0-29 last 1/30 s, frames 30-89 last 2/30 s: content ends at 5.0 s. The CFR proxy keeps that timing.
  assert.ok(Math.abs(px.durationUs! - 5_000_000) <= 34_000, String(px.durationUs));
});

test('rerun reuses verified finals and deletes stale partials; a tampered final is rebuilt', async () => {
  const root = join(dir, 'p4');
  await mkdir(root);
  const src = genAv(join(root, 'take.mp4'));
  const first = await ingest(src, root);
  const derivedDir = join(root, 'media/derived', first.contentHash);
  await writeFile(join(derivedDir, 'proxy.mp4.partial'), 'junk from a crash');
  await writeFile(join(root, first.derived.masterWav!.path), 'tampered');
  const second = await ingest(src, root);
  assert.equal(second.derived.proxy!.reused, true);
  assert.equal(second.derived.analysisWav!.reused, true);
  assert.equal(second.derived.masterWav!.reused, false);
  assert.equal(second.derived.masterWav!.sha256, first.derived.masterWav!.sha256);
  assert.deepEqual((await readdir(derivedDir)).filter((f) => f.endsWith('.partial')), []);
});

test('abort kills FFmpeg and leaves no partial', async () => {
  const root = join(dir, 'p5');
  await mkdir(root);
  const src = join(root, 'long.mp4');
  gen('-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=20', '-c:v', 'libx264', '-preset', 'ultrafast', src);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  await assert.rejects(ingest(src, root, { signal: ac.signal }), (e: Error) => e.name === 'AbortError');
  const files = await readdir(join(root, 'media/derived'), { recursive: true });
  assert.deepEqual(files.filter((f) => String(f).endsWith('.partial') || String(f).endsWith('proxy.mp4')), []);
});

test('an in-root file whose relative path exceeds the contract 512-char limit is copied, not referenced', async () => {
  const root = join(dir, 'p6');
  const deep = join(root, 'a'.repeat(200), 'b'.repeat(200), 'c'.repeat(120));
  await mkdir(deep, { recursive: true });
  const src = genAv(join(deep, 'take.mp4'), 1);
  const r = await ingest(src, root);
  assert.equal(r.copied, true);
  assert.equal(r.relativePath, `media/originals/${r.contentHash}.mp4`);
});

test('missing source is not_found', async () => {
  await assert.rejects(ingest(join(dir, 'gone.mp4'), dir), (e: unknown) => e instanceof MediaError && e.code === 'not_found');
});
