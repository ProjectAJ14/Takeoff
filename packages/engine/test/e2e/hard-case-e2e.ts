// Harder editorial end-to-end through the real `takeoff` CLI, on synthetic `say` speech:
// - take 1 holds an abandoned attempt at an idea that take 2 says completely (cross-file retake),
// - a purposeful 1.2 s pause before a punchline ("And the answer is ... nothing."),
// - "I like this approach" (a verb 'like' that must stay), a negation ("this is not slow") and a number ("3 seconds"),
// - a 30 s hard max.
// Checks: negation, number and 'like' survive verbatim in the captions; the pause is kept or flagged; no cut edge
// falls inside a word; duration ≤ hard max or an explicit duration conflict; no sample discontinuity (pop) at any
// seam of the dialogue stem or the exported mix. Writes a contact sheet of the frames on both sides of every cut.
// Slow (real ASR, Chromium, FFmpeg), so it is not part of `npm test`.
//
//   node packages/engine/test/e2e/hard-case-e2e.ts
//   TAKEOFF_E2E_KEEP=1 node ...     # keep the temp dir (seams.png, report.json)
//
// Needs macOS `say`, ffmpeg/ffprobe, uv with the cached `base` model, and Chromium for Playwright.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const BIN = fileURLToPath(new URL('../../bin/takeoff.js', import.meta.url));
const dir = await mkdtemp(join(tmpdir(), 'takeoff-hard-e2e-'));
const env = { ...process.env, TAKEOFF_APP_DATA: join(dir, 'appdata') };
const step = (m: string) => process.stdout.write(`- ${m}\n`);
async function takeoff(...args: string[]): Promise<any> {
  try {
    const { stdout } = await run(process.execPath, [BIN, ...args, '--json'], { cwd: dir, env, maxBuffer: 64 << 20, timeout: 600_000 });
    return JSON.parse(stdout);
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string };
    throw new Error(`takeoff ${args[0]} failed: ${x.stderr || x.stdout?.slice(0, 2000) || String(e)}`);
  }
}
const ff = (args: string[]) => run('ffmpeg', ['-v', 'error', '-y', ...args], { cwd: dir, maxBuffer: 256 << 20 });
const pcm = async (file: string) => {
  const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'], { encoding: 'buffer', maxBuffer: 1 << 30 });
  const b = stdout as Buffer;
  return new Float32Array(b.buffer, b.byteOffset, b.length / 4);
};
const TOGGLES = {
  badTakes: true, fillers: true, silence: true, captions: true, userBroll: false, aiBroll: false, zoom: true, music: false, sfx: false,
  studioVoice: true, autoColor: true, textHook: true, motionGraphics: true, networkPolicy: 'local_only', fillerStrength: 'normal',
};
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
const report: Record<string, unknown> = {};

try {
  step(`synthesising media in ${dir}`);
  const say = (f: string, text: string) => run('say', ['-v', 'Samantha', '-o', join(dir, f), text]);
  await say('t1.aiff', 'The secret to fast builds is, um, the secret is, uh. Hmm. Let me start again.');
  // Take 2: [text, silence after (s)]. Real silences between sentences give the silence rule seams to cut; the
  // middle sentences push the cleaned edit past the 30 s hard max so whole sentences must be dropped.
  const script2: Array<[string, number]> = [
    ['The secret to fast builds is caching every step.', 1.0],
    ['I like this approach because this is not slow.', 1.0],
    ['It takes 3 seconds.', 1.0],
    ['We store every result by its, um, content hash, so a step that did not change is skipped.', 1.0], // a filler cut inside running speech: a seam with speech on both sides
    ['Remote caching shares those results with the whole team.', 1.0],
    ['Your continuous integration runs get faster as well.', 1.0],
    ['Cold builds still take the full time, of course.', 1.0],
    ['This works the same on every machine in the team.', 1.0],
    ['So what does it cost? And the answer is', 1.2],
    ['nothing.', 0.8],
    ['Thanks for watching.', 0],
  ];
  const parts: string[] = [];
  for (const [i, [text, gap]] of script2.entries()) {
    await say(`t2_${i}.aiff`, text);
    await ff(['-i', `t2_${i}.aiff`, ...(gap ? ['-af', `apad=pad_dur=${gap}`] : []), '-ar', '48000', '-ac', '1', `t2_${i}.wav`]);
    parts.push(`file 't2_${i}.wav'`);
  }
  writeFileSync(join(dir, 'parts.txt'), parts.join('\n'));
  await ff(['-i', 't1.aiff', '-af', 'aresample=48000', '-ac', '1', 'speech1.wav']);
  await ff(['-f', 'concat', '-safe', '0', '-i', 'parts.txt', '-c:a', 'pcm_s16le', 'speech2.wav']);
  for (const k of [1, 2]) {
    await ff(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-i', `speech${k}.wav`, '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', `take${k}.mov`]);
  }

  const proj = join(dir, 'proj');
  await takeoff('init', proj, '--name', 'Hard', '--toggles', JSON.stringify(TOGGLES));
  step('import');
  const imp = await takeoff('import', proj, join(dir, 'take1.mov'), join(dir, 'take2.mov'));
  assert.ok(imp.items.every((i: any) => i.assetId && !i.error), JSON.stringify(imp));
  const [take1, take2] = imp.items.map((i: any) => i.assetId as string);
  step('edit (target 30 s, hard max)');
  const edit = await takeoff('edit', proj, '--toggles', JSON.stringify(TOGGLES), '--target', '30', '--policy', 'hard_max');
  assert.equal(edit.job.state, 'succeeded', JSON.stringify(edit.error));
  const { plan } = await takeoff('plan', proj);
  step('render --final, export');
  const final = await takeoff('render', proj, '--final');
  assert.equal(final.job.state, 'succeeded', JSON.stringify(final.error));
  const dest = join(dir, 'dest');
  await mkdir(dest);
  const exp = await takeoff('export', proj, dest);
  assert.equal(exp.job.state, 'succeeded', JSON.stringify(exp.error));
  const out = exp.dir as string;

  const transcripts = readdirSync(join(out, 'bundle', 'transcripts')).map((f) => JSON.parse(readFileSync(join(out, 'bundle', 'transcripts', f), 'utf8')));
  const words = (a: string) => transcripts.find((t: any) => t.assetId === a)!.words as Array<{ id: string; text: string; sourceStartUs: number; sourceEndUs: number }>;
  report.transcript = Object.fromEntries([take1, take2].map((a) => [a, words(a).map((w) => w.text).join(' ')]));
  const srt = readFileSync(join(out, 'captions.srt'), 'utf8');
  const capText = norm(srt.split('\n').filter((l) => l && !/^\d+$/.test(l) && !l.includes('-->')).join(' '));
  report.captions = capText;
  report.decisions = plan.decisions.map((d: any) => `${d.action}:${d.reason}:${d.confidenceTier ?? ''}`);
  report.markers = plan.reviewMarkers?.map((m: any) => `${m.kind}/${m.severity}`) ?? [];
  report.segments = plan.segments.map((s: any) => [s.assetId === take1 ? 't1' : 't2', s.sourceStartUs, s.sourceEndUs]);

  // ---- meaning preserved verbatim ----
  step('negation, number and "like"');
  const said2 = norm(words(take2).map((w) => w.text).join(' '));
  for (const phrase of ['i like this approach', 'this is not slow']) {
    assert.ok(said2.includes(phrase), `ASR heard "${phrase}": ${said2}`);
    assert.ok(capText.includes(phrase), `"${phrase}" kept verbatim in captions: ${capText}`);
  }
  const num = /it takes (3|three) seconds/.exec(said2)?.[0];
  assert.ok(num, `ASR heard the number: ${said2}`);
  assert.ok(capText.includes(num), `"${num}" kept verbatim in captions: ${capText}`);

  // ---- no cut edge inside a word; every retained word whole ----
  step('cut edges against word timings');
  for (const s of plan.segments) {
    for (const w of words(s.assetId)) {
      for (const edge of [s.sourceStartUs, s.sourceEndUs]) assert.ok(!(w.sourceStartUs < edge && edge < w.sourceEndUs), `segment ${s.id} edge ${edge} inside word ${w.id} [${w.sourceStartUs},${w.sourceEndUs})`);
    }
  }

  // ---- the purposeful pause ----
  step('purposeful pause before the punchline');
  // Measured on the source audio, not word gaps: the ASR may stretch "is..." over the pause.
  const sd = (await run('ffmpeg', ['-hide_banner', '-i', join(dir, 'speech2.wav'), '-af', 'silencedetect=n=-50dB:d=0.5', '-f', 'null', '-'])).stderr;
  const sil = [...sd.matchAll(/silence_end: ([\d.]+) \| silence_duration: ([\d.]+)/g)].map((m) => [(Number(m[1]) - Number(m[2])) * 1e6, Number(m[1]) * 1e6] as const);
  const gap = sil.filter(([s0, s1]) => s1 - s0 > 1.15e6 && s1 - s0 < 1.4e6 && s0 > 20e6).at(-1)!; // the 1.2 s beat, near the end
  assert.ok(gap, `found the 1.2 s pause in the source: ${JSON.stringify(sil)}`);
  const kept = plan.segments.filter((s: any) => s.assetId === take2).reduce((n: number, s: any) => n + Math.max(0, Math.min(s.sourceEndUs, gap[1]) - Math.max(s.sourceStartUs, gap[0])), 0);
  const flagged = plan.decisions.some((d: any) => d.assetId === take2 && d.action === 'review' && /purposeful/.test(d.reason) && d.sourceStartUs < gap[1] && gap[0] < d.sourceEndUs);
  // Or the target length dropped the whole setup + punchline: then no beat is left to protect, and neither half is.
  const lengthDrops = plan.decisions.filter((d: any) => d.detector === 'rules.target_length.v1' && d.assetId === take2);
  const droppedWhole = lengthDrops.some((d: any) => d.sourceStartUs <= gap[0] && gap[1] <= d.sourceEndUs);
  report.pause = { sourceUs: gap.map(Math.round), keptUs: Math.round(kept), flagged, droppedWhole };
  assert.ok(kept >= 0.8 * (gap[1] - gap[0]) || flagged || droppedWhole, `purposeful pause kept, flagged or dropped with its sentence: ${JSON.stringify(report.pause)}`);
  // Setup and payoff are never separated.
  assert.equal(capText.includes('what does it cost'), capText.includes('nothing'), `setup and punchline stay together: ${capText}`);

  // ---- the abandoned attempt in take 1 ----
  const t1Kept = plan.segments.filter((s: any) => s.assetId === take1);
  const t1Reviewed = plan.decisions.some((d: any) => d.assetId === take1 && /retake|false_start/.test(d.reason));
  report.take1 = { keptSegments: t1Kept.length, retakeDecision: t1Reviewed };
  assert.ok(t1Kept.length === 0 || t1Reviewed, `abandoned take 1 attempt is cut or under review: ${JSON.stringify(report.take1)}`);

  // ---- duration ----
  const frames = exp.manifest.durationFrames as number;
  const conflict = (plan.reviewMarkers ?? []).some((m: any) => m.kind === 'duration_conflict');
  report.durationS = frames / 30;
  assert.ok(frames <= 30 * 30 || conflict, `duration ${frames / 30}s ≤ 30 s hard max or explicit conflict`);

  // ---- seams: frames and pops ----
  const compiledFile = readdirSync(join(proj, 'jobs')).map((j) => join(proj, 'jobs', j, `compiled-r${exp.revision}.json`)).find(existsSync)!;
  const tl = JSON.parse(readFileSync(compiledFile, 'utf8'));
  const seams = tl.segments.slice(1).map((s: any) => ({ frame: s.outputStartFrame as number, sample: s.outputStartSample as number }));
  report.seams = seams.length;
  step(`${seams.length} seams: contact sheet`);
  const picks = seams.flatMap((s: any) => [s.frame - 1, s.frame]);
  if (picks.length) {
    const sel = picks.map((n: number) => `eq(n\\,${n})`).join('+');
    await ff(['-i', join(out, 'video.mp4'), '-vf', `select='${sel}',scale=270:480,tile=2x${seams.length}`, '-frames:v', '1', '-fps_mode', 'passthrough', join(dir, 'seams.png')]);
    step(`contact sheet (left: last frame before a cut, right: first after): ${join(dir, 'seams.png')}`);
  }
  step('pops at seams');
  const pops: Array<Record<string, number | string>> = [];
  for (const [name, file] of [['dialogue stem', join(out, 'stems', 'dialogue.wav')], ['mix', join(out, 'video.mp4')]] as const) {
    const x = await pcm(file);
    for (const s of seams) {
      const d = (a: number, b: number) => { let m = 0; for (let n = Math.max(1, a); n < Math.min(x.length, b); n++) m = Math.max(m, Math.abs(x[n]! - x[n - 1]!)); return m; };
      const rms = (a: number, b: number) => { let t = 0; for (let n = a; n < b; n++) t += x[n]! ** 2; return Math.sqrt(t / Math.max(1, b - a)); };
      const near = d(s.sample - 96, s.sample + 96); // ±2 ms
      const around = Math.max(d(s.sample - 4800, s.sample - 480), d(s.sample + 480, s.sample + 4800)); // 10–100 ms away
      const entry = { file: name, sample: s.sample, near: +near.toFixed(4), around: +around.toFixed(4), rmsBefore: +rms(s.sample - 480, s.sample).toFixed(4), rmsAfter: +rms(s.sample, s.sample + 480).toFixed(4) };
      pops.push(entry);
      // A pop is a step at the seam well above the signal's own sample-to-sample motion nearby.
      assert.ok(near <= Math.max(0.02, 1.5 * around), `pop at ${name} seam ${s.sample}: ${JSON.stringify(entry)}`);
    }
  }
  report.pops = pops;
  step('PASS');
} finally {
  writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (process.env.TAKEOFF_E2E_KEEP) step(`kept ${dir}`);
  else await rm(dir, { recursive: true, force: true });
}
