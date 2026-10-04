import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validate } from '@takeoff/contracts';
import { fixture, pipeline, run } from './helpers.ts';

test('export writes MP4, captions, stems and a bundle with relative paths, all hashed in a valid manifest', async () => {
  const f = await fixture();
  try {
    await pipeline(f, 'export-ok');
    const dest = join(f.root, '..', 'out');
    await mkdir(dest);
    const r = await f.engine.exportProject({ profile: 'final_1080', destinationDir: dest, burnCaptions: true });
    assert.equal(r.job.state, 'succeeded', JSON.stringify(r.error));
    assert.ok(r.manifest && validate('export-manifest', r.manifest).ok);
    assert.ok(r.dir && existsSync(join(r.dir, 'export-manifest.json')));
    const kinds = r.manifest!.outputs.map((o) => o.kind);
    for (const k of ['video', 'srt', 'vtt', 'caption_json', 'project_bundle', 'stem']) assert.ok(kinds.includes(k as never), k);
    assert.equal(r.manifest!.checks.find((c) => c.name === 'caption_bounds')?.status, 'not_run', 'unmeasured checks are never reported as passed');
    const srt = await readFile(join(r.dir!, 'captions.srt'), 'utf8');
    assert.match(srt, /^1\n00:00:\d\d,\d{3} --> 00:00:\d\d,\d{3}\n/);
    assert.match(await readFile(join(r.dir!, 'captions.vtt'), 'utf8'), /^WEBVTT\n/);
    const words = JSON.parse(await readFile(join(r.dir!, 'captions.json'), 'utf8'));
    assert.ok(words.captions[0].words.length > 0 && typeof words.captions[0].words[0].text === 'string');
    // Stems are exactly the timeline's sample count.
    const compiledSamples = Math.floor((r.manifest!.durationFrames * 48000) / 30);
    for (const s of ['dialogue', 'music', 'sfx']) {
      const { stdout }: { stdout: string } = await run('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', join(r.dir!, 'stems', `${s}.wav`)]);
      const st = JSON.parse(stdout).streams[0] as { sample_rate: string; duration_ts: number };
      assert.equal(Number(st.sample_rate), 48000);
      assert.equal(Number(st.duration_ts), compiledSamples, s);
    }
    // The bundle carries no absolute paths and no originals.
    const bundle = join(r.dir!, 'bundle');
    const files = (await readdir(bundle, { recursive: true })).map(String);
    assert.ok(files.includes('plan.json') && files.includes('qa-report.json') && files.some((x) => x.startsWith('transcripts')));
    for (const x of files.filter((n) => n.endsWith('.json'))) {
      const text = await readFile(join(bundle, x), 'utf8');
      assert.ok(!text.includes(f.root) && !text.includes('/Users/') && !text.includes('/tmp/') && !text.includes('/var/'), x);
    }
    assert.ok(!files.some((n) => n.endsWith('.mp4')), 'no media in the bundle');
  } finally {
    await f.cleanup();
  }
});

test('export refuses on a critical QA issue and writes nothing to the destination', async () => {
  // Final renders come back one frame long: duration check is critical.
  const f = await fixture({ renderer: { extraFrames: (profile) => (profile === 'final' ? 1 : 0) } });
  try {
    await pipeline(f, 'export-bad');
    const dest = join(f.root, '..', 'out-bad');
    await mkdir(dest);
    const r = await f.engine.exportProject({ profile: 'final_1080', destinationDir: dest, burnCaptions: true });
    assert.equal(r.job.state, 'failed');
    assert.equal(r.error?.code, 'qa_critical');
    assert.equal(r.manifest, null);
    assert.equal(r.dir, null);
    assert.ok(r.qa?.issues.some((i) => i.check === 'duration_frames' && i.severity === 'critical'));
    assert.deepEqual(await readdir(dest), []);
  } finally {
    await f.cleanup();
  }
});

test('export destination must be under an approved root', async () => {
  const f = await fixture();
  try {
    await pipeline(f, 'export-where');
    assert.throws(() => f.engine.exportProject({ profile: 'draft_720', destinationDir: '/etc', burnCaptions: false }), { code: 'path_not_approved' });
  } finally {
    await f.cleanup();
  }
});

test('stems: several segments and events map each to its own ffmpeg input (regression: input index counted -i args)', async () => {
  const { writeStems } = await import('../src/export.ts');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'takeoff-stems-'));
  try {
    const wav = join(dir, 'a.wav');
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', wav]);
    const tl = {
      totalSamples: 96000,
      segments: [
        { assetId: 'a1', sourceStartUs: 0, outputStartSample: 0, outputEndSample: 48000 },
        { assetId: 'a2', sourceStartUs: 1_000_000, outputStartSample: 48000, outputEndSample: 96000 },
      ],
      audioEvents: [
        { kind: 'sfx', assetId: 'a1', startSample: 0, endSample: 4800, gainDb: -12 },
        { kind: 'sfx', assetId: 'a2', startSample: 48000, endSample: 52800, gainDb: -12 },
      ],
    } as never;
    const out = await writeStems(tl, () => ({ wav, startUs: 0 }), dir);
    for (const p of Object.values(out)) {
      const { stdout }: { stdout: string } = await run('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', p]);
      assert.equal(Number(JSON.parse(stdout).streams[0].duration_ts), 96000);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
