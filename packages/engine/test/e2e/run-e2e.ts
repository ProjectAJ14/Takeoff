// End-to-end local route on synthetic footage, through the real `takeoff` CLI:
// starter-pack (offline when the base model is cached) → init → import (landscape MOV + rotated
// portrait MP4) + a B-roll image tagged by its file name + a brand (highlight colour + logo PNG) → edit with every
// P0 toggle → plan → render --final → qa → export (reusing the final render), then checks the exported files:
// B-roll in a frame, a non-silent music stem, the brand colour in the caption highlight and the logo. Slow (real ASR, Chromium, FFmpeg), so it is not part of `npm test`.
//
//   node packages/engine/test/e2e/run-e2e.ts            # rules director
//   TAKEOFF_E2E_OLLAMA=dolphin-llama3:8b node ...       # also the Ollama director (60 s timeout, must fall back cleanly)
//   TAKEOFF_E2E_KEEP=1 node ...                         # keep the temp dir (frames PNGs for inspection)
//
// Needs macOS `say`, ffmpeg/ffprobe, uv with the cached `base` model, and Chromium for Playwright.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const BIN = fileURLToPath(new URL('../../bin/takeoff.js', import.meta.url));
const dir = await mkdtemp(join(tmpdir(), 'takeoff-e2e-'));
const env = { ...process.env, TAKEOFF_APP_DATA: join(dir, 'appdata') };
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
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
const ff = (args: string[]) => run('ffmpeg', ['-v', 'error', '-y', ...args], { cwd: dir, maxBuffer: 64 << 20 });
const probe = async (file: string, extra: string[]) => JSON.parse((await run('ffprobe', ['-v', 'error', ...extra, '-of', 'json', file], { maxBuffer: 64 << 20 })).stdout);

const TOGGLES = {
  badTakes: true, fillers: true, silence: true, captions: true, userBroll: true, aiBroll: false, zoom: true, music: true, sfx: true,
  studioVoice: true, autoColor: true, textHook: true, motionGraphics: true, networkPolicy: 'local_only', fillerStrength: 'normal',
};

try {
  // ---- synthetic talking head: fillers, a false start, a 2 s pause, a comparison ----
  step(`synthesising media in ${dir}`);
  await run('say', ['-v', 'Samantha', '-o', join(dir, 'a.aiff'), 'Um, so today I want to explain how Flutter talks to a server. Uh, so the main thing is. So the main thing is that Flutter sends a request through Dio to the server.']);
  await run('say', ['-v', 'Samantha', '-o', join(dir, 'b.aiff'), "Now let's compare REST versus GraphQL. REST uses many endpoints, uh, while GraphQL uses one endpoint and you ask for exactly the fields you need. That is the whole idea."]);
  await run('say', ['-v', 'Samantha', '-o', join(dir, 'c.aiff'), 'And that is how the request flow works. Thanks for watching.']);
  await ff(['-i', 'a.aiff', '-f', 'lavfi', '-t', '2', '-i', 'anullsrc=r=48000:cl=mono', '-i', 'b.aiff', '-filter_complex',
    '[0:a]aresample=48000[a0];[2:a]aresample=48000[a2];[a0][1:a][a2]concat=n=3:v=0:a=1[o]', '-map', '[o]', '-ac', '1', 'speech.wav']);
  // Landscape MOV (video runs ~2 s past the speech: trailing dead air) and a phone-style portrait MP4 (rotation metadata).
  await ff(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-i', 'speech.wav', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', 'take1.mov']);
  await ff(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-i', 'c.aiff', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', 't2.mp4']);
  await ff(['-display_rotation', '90', '-i', 't2.mp4', '-c', 'copy', 'take2.mp4']);
  const sources = ['take1.mov', 'take2.mp4'].map((f) => join(dir, f));
  const before = sources.map(sha);

  // ---- the route ----
  step('starter-pack (no network grant)');
  const pack = await takeoff('starter-pack');
  assert.ok(pack.library.some((e: any) => e.kind === 'music') && pack.library.some((e: any) => e.kind === 'sfx'), 'library generated');
  const proj = join(dir, 'proj');
  await takeoff('init', proj, '--name', 'E2E', '--toggles', JSON.stringify(TOGGLES));
  step('import');
  const imp = await takeoff('import', proj, ...sources);
  assert.ok(imp.items.every((i: any) => i.assetId && !i.error), JSON.stringify(imp));
  // B-roll: a solid magenta image whose file name is its tag ("how Flutter talks to a server").
  await ff(['-f', 'lavfi', '-i', 'color=c=0xFF00FF:s=640x360', '-frames:v', '1', 'server.png']);
  const br = await takeoff('import', proj, join(dir, 'server.png'), '--pool', 'broll');
  assert.ok(br.items[0].assetId, JSON.stringify(br));
  // Brand: an odd highlight colour (not in testsrc2) and a cyan 5:2 logo.
  const HIGHLIGHT = [0x13, 0xf0, 0xa7];
  await ff(['-f', 'lavfi', '-i', 'color=c=0x00FFFF:s=500x200', '-frames:v', '1', 'logo.png']);
  const brandFile = join(dir, 'brand.json');
  writeFileSync(brandFile, JSON.stringify({
    schemaVersion: '1.0', id: 'e2e', version: 1, name: 'E2E brand',
    palette: [{ role: 'highlight', color: '#13F0A7' }, { role: 'text', color: '#FFFFFF' }],
    fonts: [], logos: [], captionStyle: { template: 'restrained', highlightColor: '#13F0A7', positionPolicy: 'safe_bottom' },
    hookTone: 'plain', glossary: ['GraphQL'], prohibitedClaims: ['fastest'], motionIntensity: 'restrained', safeLayouts: ['full', 'inset'],
    music: { moods: ['calm'], bannedCategories: [] }, sfx: { bannedCategories: [] }, ctaTemplates: [], aspectPresets: [{ width: 1080, height: 1920 }],
    provenance: { source: 'manual', sourceUrl: null, createdAt: '2026-10-05T12:00:00Z' },
  }));
  step('brand (colour + logo)');
  const brand = await takeoff('brand', proj, brandFile, '--logo', join(dir, 'logo.png'));
  assert.equal(brand.ref, 'brands/e2e@1');
  step('edit (all P0 toggles, rules director)');
  const edit = await takeoff('edit', proj, '--toggles', JSON.stringify(TOGGLES), '--target', 'auto', '--glossary', 'REST,GraphQL,Flutter,Dio');
  assert.equal(edit.job.state, 'succeeded', JSON.stringify(edit.error));
  const { plan } = await takeoff('plan', proj);
  assert.equal(plan.brandProfileRef, 'brands/e2e@1');
  step('render --final, qa, export');
  const final = await takeoff('render', proj, '--final');
  assert.equal(final.job.state, 'succeeded', JSON.stringify(final.error));
  assert.ok(final.job.artifacts.some((a: any) => a.kind === 'render_final'), 'render --final records a final render');
  const qa = await takeoff('qa', proj);
  assert.equal(qa.job.state, 'succeeded', JSON.stringify(qa.error));
  const dest = join(dir, 'dest');
  await mkdir(dest);
  const exp = await takeoff('export', proj, dest);
  assert.equal(exp.job.state, 'succeeded', JSON.stringify(exp.error));
  const out = exp.dir as string;
  assert.ok(!exp.job.artifacts.some((a: any) => a.kind === 'render_final'), 'export reused the final render instead of rendering again');
  const frames = exp.manifest.durationFrames as number;
  const status = Object.fromEntries(exp.qa.checks.map((c: any) => [c.name, c.status]));
  for (const c of ['decode', 'duration_frames', 'dimensions', 'frame_rate', 'color_tags', 'audio_samples', 'loudness', 'true_peak', 'caption_bounds', 'visual_render', 'undeclared_network', 'fonts']) {
    assert.equal(status[c], 'passed', `QA ${c}: ${JSON.stringify(exp.qa.checks.find((x: any) => x.name === c))}`);
  }

  // ---- the exported MP4 ----
  step('ffprobe export');
  const p = await probe(join(out, 'video.mp4'), ['-count_frames', '-show_streams', '-show_format']);
  const v = p.streams.find((s: any) => s.codec_type === 'video');
  const a = p.streams.find((s: any) => s.codec_type === 'audio');
  assert.deepEqual([v.codec_name, v.width, v.height, v.r_frame_rate, v.pix_fmt, v.color_primaries], ['h264', 1080, 1920, '30/1', 'yuv420p', 'bt709']);
  assert.deepEqual([a.codec_name, Number(a.sample_rate)], ['aac', 48000]);
  assert.equal(Number(v.nb_read_frames), frames, 'decoded frames = compiled frames');
  assert.ok(Math.abs(Number(p.format.duration) - frames / 30) < 0.05, `duration ${p.format.duration} vs ${frames / 30}`);

  step('loudness');
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', join(out, 'video.mp4'), '-af', 'ebur128=peak=true', '-f', 'null', '-'], { maxBuffer: 64 << 20 });
  const lufs = Number(/I:\s+(-?[\d.]+) LUFS/.exec(stderr.slice(stderr.lastIndexOf('Summary')))![1]);
  const tp = Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(stderr.slice(stderr.lastIndexOf('True peak')))![1]);
  assert.ok(Math.abs(lufs + 14) <= 1, `integrated ${lufs} LUFS`);
  assert.ok(tp <= -1, `true peak ${tp} dBTP`);

  // ---- captions vs transcript: fillers and the false start are gone ----
  step('captions and edits');
  for (const f of ['captions.srt', 'captions.vtt', 'captions.json']) assert.ok(existsSync(join(out, f)), f);
  const srt = readFileSync(join(out, 'captions.srt'), 'utf8');
  const capText = srt.split('\n').filter((l) => l && !/^\d+$/.test(l) && !l.includes('-->')).join(' ');
  const said = Object.values(readdirSync(join(out, 'bundle', 'transcripts')).map((f) => JSON.parse(readFileSync(join(out, 'bundle', 'transcripts', f), 'utf8'))))
    .map((t: any) => t.words.map((w: any) => w.text).join(' ')).join(' ');
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z' ]+/g, ' ').replace(/\s+/g, ' ');
  const count = (s: string, needle: string) => norm(s).split(needle).length - 1;
  // Whisper may drop the opening 'Um' under a glossary prompt; any heard filler makes the removal check meaningful.
  assert.ok(/\b(um|uh)\b/.test(norm(said)), `transcript heard no filler: ${said}`);
  assert.ok(!/\b(um|uh)\b/.test(norm(capText)), `fillers in captions: ${capText}`);
  assert.equal(count(said, 'so the main thing is'), 2, 'transcript has the false start');
  assert.equal(count(capText, 'so the main thing is'), 1, 'false start removed');
  assert.match(norm(capText), /flutter sends a request through dio to the server/);
  assert.match(norm(capText), /thanks for watching/);
  const kinds = plan.decisions.filter((d: any) => d.action === 'remove').map((d: any) => d.reason.split(':')[0]);
  for (const k of ['filler', 'false_start', 'silence']) assert.ok(kinds.includes(k), `a ${k} was removed: ${kinds}`);
  // Each SRT cue's words were spoken (captions are verbatim transcript).
  for (const w of norm(capText).split(' ').filter(Boolean)) assert.ok(norm(said).split(' ').includes(w), `caption word not in transcript: ${w}`);

  // ---- graphics labels come from the transcript ----
  const flow = plan.visuals.find((x: any) => x.template === 'request_flow_v1');
  assert.deepEqual(flow && [flow.params.containerLabel, flow.params.internalNode, flow.params.externalNode], ['Flutter', 'Dio', 'server']);
  const cmp = plan.visuals.find((x: any) => x.template === 'comparison_list_v1');
  assert.ok(cmp && cmp.params.items.map(norm).join('|') === 'rest|graphql', `comparison items ${JSON.stringify(cmp?.params)}`);
  assert.ok(plan.visuals.some((x: any) => x.kind === 'hook_text') && plan.transforms.some((x: any) => x.kind === 'punch'), 'hook and zoom');
  assert.ok(plan.audio.music && plan.audio.sfx.length > 0, 'music and sfx');
  const brollV = plan.visuals.find((x: any) => x.kind === 'broll');
  assert.ok(brollV && brollV.assetId === br.items[0].assetId && brollV.layout === 'inset', `B-roll placed: ${JSON.stringify(plan.visuals.map((x: any) => x.kind))}`);

  // ---- stems, sources ----
  for (const s of ['dialogue', 'music', 'sfx']) {
    const st = (await probe(join(out, 'stems', `${s}.wav`), ['-show_streams'])).streams[0];
    assert.equal(Number(st.duration_ts), exp.manifest.durationFrames * 1600, `${s} stem samples`);
  }
  const vd = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', join(out, 'stems', 'music.wav'), '-af', 'volumedetect', '-f', 'null', '-'], { maxBuffer: 64 << 20 });
  const musicMax = Number(/max_volume: (-?[\d.]+) dB/.exec(vd.stderr)![1]);
  // The calm library bed peaks near -33 dBFS and plays at -18 dB: about -51 dB. Digital silence reads -91 dB or -inf.
  assert.ok(musicMax > -70, `music stem is not silent (max ${musicMax} dB)`);
  assert.deepEqual(sources.map(sha), before, 'source media unchanged');
  for (const m of readdirSync(join(proj, 'media', 'originals'))) assert.ok(m.startsWith(sha(join(proj, 'media', 'originals', m))), 'original copy intact');

  // ---- frames for a human look: start, a cut, captions, each motion template ----
  const compiledFile = readdirSync(join(proj, 'jobs')).map((j) => join(proj, 'jobs', j, `compiled-r${exp.revision}.json`)).find(existsSync)!;
  const tl = JSON.parse(readFileSync(compiledFile, 'utf8'));
  const at = (id: string) => tl.visuals.find((x: any) => x.visualId === id);
  const picks = [0, tl.segments[1].outputStartFrame + 3, tl.captions[0].startFrame + 20, at(flow.id).startFrame + 30, at(cmp.id).startFrame + 30, tl.segments.at(-1).outputStartFrame + 20];
  const pngs: string[] = [];
  for (const n of picks) {
    const f = join(dir, `frame-${String(n).padStart(4, '0')}.png`);
    await ff(['-i', join(out, 'video.mp4'), '-vf', `select=eq(n\\,${n})`, '-frames:v', '1', f]);
    assert.ok(existsSync(f));
    pngs.push(f);
  }
  step(`frames: ${pngs.join(' ')}`);

  // ---- pixels: B-roll inset, caption highlight in the brand colour, logo ----
  const rgbAt = async (n: number, name: string) => {
    const f = join(dir, `${name}-${n}.png`);
    await ff(['-i', join(out, 'video.mp4'), '-vf', `select=eq(n\\,${n})`, '-frames:v', '1', f]);
    pngs.push(f);
    return (await run('ffmpeg', ['-v', 'error', '-i', f, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', maxBuffer: 64 << 20 })).stdout as Buffer;
  };
  const near = (px: Buffer, i: number, c: number[], tol: number) => Math.abs(px[i]! - c[0]!) <= tol && Math.abs(px[i + 1]! - c[1]!) <= tol && Math.abs(px[i + 2]! - c[2]!) <= tol;
  const countPx = (px: Buffer, box: { x: number; y: number; w: number; h: number }, c: number[], tol: number) => {
    let n = 0;
    for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) if (near(px, (y * 1080 + x) * 3, c, tol)) n++;
    return n;
  };
  const bv = at(brollV.id);
  const brollPx = await rgbAt(Math.floor((bv.startFrame + bv.endFrame) / 2), 'broll');
  // Inset box: 70% x 30% of the frame, centred, at the top of the safe area.
  assert.ok(countPx(brollPx, { x: 300, y: 300, w: 480, h: 200 }, [255, 0, 255], 40) > 0.9 * 480 * 200, 'B-roll inset visible');
  let green = 0;
  for (const c of tl.captions.slice(0, 6)) {
    // Mid-caption (past the fade-in), where an emphasis or active word carries the highlight.
    const px = await rgbAt(Math.floor((c.startFrame + c.endFrame) / 2), 'caption');
    green = Math.max(green, countPx(px, { x: 0, y: 1300, w: 1080, h: 500 }, HIGHLIGHT, 40));
    if (green > 300) break;
  }
  assert.ok(green > 300, `caption highlight pixels in the brand colour: ${green}`);
  // Logo: 5:2 PNG in a 216x115 box → 216x86 at the safe area's top-right (x 735–951, y 231–317), drawn over the
  // magenta B-roll here, so cyan there is the logo, not the test pattern; just below it is B-roll again.
  assert.ok(countPx(brollPx, { x: 740, y: 236, w: 205, h: 76 }, [0, 255, 255], 30) > 0.95 * 205 * 76, 'logo in the top-right safe corner');
  assert.ok(countPx(brollPx, { x: 740, y: 330, w: 170, h: 40 }, [0, 255, 255], 30) === 0, 'logo keeps its 5:2 aspect');
  step(`pixel frames: ${pngs.slice(-2).join(' ')}`);

  // ---- optional: Ollama director, bounded, falls back to rules on invalid output ----
  const model = process.env.TAKEOFF_E2E_OLLAMA;
  if (model) {
    step(`edit with ollama:${model} (60 s timeout)`);
    const t0 = Date.now();
    const o = await takeoff('edit', proj, '--director', `ollama:${model}`, '--director-timeout', '60');
    assert.equal(o.job.state, 'succeeded', JSON.stringify(o.error));
    const op = (await takeoff('plan', proj)).plan;
    step(`ollama: director=${op.provenance.director} in ${Math.round((Date.now() - t0) / 1000)} s, ${op.segments.length} segments`);
    assert.match(op.provenance.director, /^(rules|ollama-)/);
    // A model Ollama does not have: the job still succeeds, on the rules plan. (Invalid model output →
    // one repair → rules is covered by packages/director tests; a warm 8B model answers in < 1 s, so a
    // short timeout cannot force it here.)
    const missing = await takeoff('edit', proj, '--director', 'ollama:takeoff-e2e-missing-model', '--director-timeout', '60');
    assert.equal(missing.job.state, 'succeeded', JSON.stringify(missing.error));
    assert.equal((await takeoff('plan', proj)).plan.provenance.director, 'rules', 'unavailable model falls back to rules');
  }
  step('PASS');
} finally {
  if (process.env.TAKEOFF_E2E_KEEP) step(`kept ${dir}`);
  else await rm(dir, { recursive: true, force: true });
}
