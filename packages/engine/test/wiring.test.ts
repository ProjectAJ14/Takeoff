// Engine wiring: face tracks (cache, render input, QA face_crop), brand versions frozen into plans and renders,
// prohibited claims, director context (B-roll, music/SFX picks, filler dictionary, voice analysis, hook options),
// final-render reuse by export, renderer-built stems, asset tags over HTTP and recovery on open.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { BrandProfile } from '@takeoff/contracts';
import type { RenderInput } from '@takeoff/renderer-api';
import { importBrandFile, libraryDir, prohibitedVisuals, saveLibraryBrand, snapshot, startServer, Workspace, type FacesRequest } from '../src/index.ts';
import { fakeTranscriber, fixture, pipeline, run, settings } from './helpers.ts';

const brandJson = (over: Partial<BrandProfile> = {}): BrandProfile => ({
  ...(JSON.parse(readFileSync(new URL('../../contracts/fixtures/valid/brand-profile/manual.json', import.meta.url), 'utf8')) as BrandProfile),
  id: 'acme', version: 1, fonts: [], logos: [], prohibitedClaims: [], ...over,
});
const withFaces = (calls: FacesRequest[], box = { x: 120, y: 60, w: 80, h: 80 }) => {
  const t = fakeTranscriber();
  t.faces = async (req) => {
    calls.push(req);
    const track = { width: 320, height: 240, status: 'tracked' as const, track: [{ startUs: 0, endUs: 7_000_000, ...box, confidence: 0.9 }] };
    writeFileSync(req.outPath, JSON.stringify(track));
    return track;
  };
  return t;
};

test('faces: tracked once per source (cached), passed to the renderer, and checked by QA face_crop', async () => {
  const calls: FacesRequest[] = [];
  const f = await fixture({ transcriber: withFaces(calls), renderer: { overlay: () => ({ faces: [{ frame: 10, rect: { x: 40, y: 50, w: 60, h: 60 } }] }) } });
  try {
    const r = await pipeline(f, 'faces-1');
    assert.equal(r.job.state, 'succeeded', JSON.stringify(r.error));
    assert.equal(calls.length, 1);
    const input = f.renderer.renders.at(-1)!;
    assert.deepEqual(Object.values(input.faceTracks ?? {}).map((t) => [t.width, t.height, t.track.length]), [[320, 240, 1]]);
    assert.equal(r.qa!.checks.find((c) => c.name === 'face_crop')!.status, 'passed');
    await pipeline(f, 'faces-2');
    assert.equal(calls.length, 1, 'unchanged footage is never re-tracked');
  } finally {
    await f.cleanup();
  }
  // A face outside the frame fails the check; no tracker → not_run with the reason, never passed.
  const g = await fixture({ transcriber: withFaces([]), renderer: { overlay: () => ({ faces: [{ frame: 3, rect: { x: 150, y: 10, w: 80, h: 60 } }] }) } });
  try {
    const r = await pipeline(g, 'faces-3');
    assert.equal(r.qa!.checks.find((c) => c.name === 'face_crop')!.status, 'failed');
  } finally {
    await g.cleanup();
  }
  const h = await fixture();
  try {
    const c = (await pipeline(h, 'faces-4')).qa!.checks.find((x) => x.name === 'face_crop')!;
    assert.equal(c.status, 'not_run');
    assert.match(c.detail ?? '', /not available/);
  } finally {
    await h.cleanup();
  }
});

test('brands: plans reference an immutable version; a later version never changes a re-render of the old plan', async () => {
  const f = await fixture();
  try {
    const app = f.engine.appDataDir;
    const png = join(f.root, '..', 'media', 'logo.png');
    await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x32', '-frames:v', '1', png]);
    const logo = importBrandFile(libraryDir(app), png, 'logo');
    const v1 = saveLibraryBrand(app, brandJson({ logos: [{ assetId: logo.assetId, role: 'primary' }], captionStyle: { template: 'restrained', highlightColor: '#00FF00', positionPolicy: 'safe_bottom' }, fonts: [{ role: 'caption', family: 'Missing Sans', assetId: null, license: 'n/a' }] }));
    assert.equal(v1.version, 1);
    assert.equal(await f.engine.saveBrandProfile(v1), 'brands/acme@1');
    const r = await pipeline(f, 'brand-1', { brandProfileId: 'acme' });
    assert.equal(r.job.state, 'succeeded', JSON.stringify(r.error));
    assert.equal(f.engine.getPlan()!.plan.brandProfileRef, 'brands/acme@1');
    const first = f.renderer.renders.at(-1)! as RenderInput & { logo?: { path: string; hash: string } };
    assert.equal(first.brand!.captionStyle.highlightColor, '#00FF00');
    assert.equal(first.logo?.hash, logo.sha256);
    // Render report: frozen brand, explicit Inter fallback for the missing font, logo drawn.
    const reportRef = r.job.artifacts.find((a) => a.kind === 'render_report')!.ref;
    const report = JSON.parse(await readFile(join(f.root, reportRef), 'utf8'));
    assert.equal(report.brandProfileRef, 'brands/acme@1');
    assert.deepEqual(report.fonts, [{ role: 'caption', family: 'Missing Sans', sha256: null, fallback: 'Inter' }]);
    assert.equal(report.logo.drawn, true);

    // v2 changes the colour; the stored v1 cannot be overwritten.
    const v2 = saveLibraryBrand(app, { ...v1, captionStyle: { ...v1.captionStyle, highlightColor: '#0000FF' } });
    assert.equal(v2.version, 2);
    await f.engine.saveBrandProfile(v2);
    await assert.rejects(f.engine.saveBrandProfile({ ...v1, name: 'Changed' }), (e: { code?: string }) => e.code === 'brand_version_exists');
    const again = await f.engine.renderAffected('rerender-old-plan');
    assert.equal(again.job.state, 'succeeded', JSON.stringify(again.error));
    assert.equal(f.renderer.renders.at(-1)!.brand!.captionStyle.highlightColor, '#00FF00', 'the old plan still renders v1');
  } finally {
    await f.cleanup();
  }
});

test('prohibited claims: banned hook/label text is found, and a plan carrying it is refused before render', async () => {
  const plan = { visuals: [{ id: 'hook_0001', kind: 'hook_text', text: 'The BEST app ever', locked: false }, { id: 'm', kind: 'motion_template', params: { title: 'x', items: ['a', 'guaranteed results'] }, locked: true }] };
  assert.deepEqual(prohibitedVisuals(plan as never, ['best app', 'Guaranteed']), [{ id: 'hook_0001', locked: false }, { id: 'm', locked: true }]);
  assert.deepEqual(prohibitedVisuals(plan as never, []), []);
  const f = await fixture();
  try {
    await f.engine.saveBrandProfile(brandJson({ prohibitedClaims: ['rocket science'] }));
    const r = await pipeline(f, 'claims-1', { brandProfileId: 'acme', settings: { ...settings, textHook: true } });
    assert.equal(r.job.state, 'succeeded', JSON.stringify(r.error));
    const head = f.engine.getPlan()!;
    const hook = head.plan.visuals.find((v) => v.kind === 'hook_text')!;
    f.engine.applyPatch({ schemaVersion: '1.0', baseRevision: head.revision, ops: [{ op: 'set_hook', text: 'Not rocket science', evidenceIds: hook.kind === 'hook_text' ? hook.evidenceIds : [] }] });
    const bad = await f.engine.renderAffected('claims-render');
    assert.equal(bad.job.state, 'failed');
    assert.equal(bad.error?.code, 'prohibited_claim');
  } finally {
    await f.cleanup();
  }
});

test('director context: B-roll by tag, music by mood, SFX by category, filler dictionary, voice analysis, hook options', async () => {
  const f = await fixture();
  try {
    const media = join(f.root, '..', 'media');
    await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240', '-frames:v', '1', join(media, 'pipes.png')]);
    for (const [n, hz, d] of [['upbeat beat.wav', 330, 12], ['calm bed.wav', 220, 12], ['hit.wav', 880, 1]] as const) {
      await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${hz}:sample_rate=48000:duration=${d}`, join(media, n)]);
    }
    const [img] = await f.engine.importAssets([join(media, 'pipes.png')], { pool: 'broll' });
    f.engine.setAssetTags(img!.assetId!, ['Flutter']); // SCRIPT: "... how Flutter sends a request through Dio."
    assert.throws(() => f.engine.setAssetTags(img!.assetId!, ['../etc']), (e: { code?: string }) => e.code === 'invalid_tags');
    await f.engine.importAssets([join(media, 'upbeat beat.wav'), join(media, 'calm bed.wav')], { pool: 'music' });
    await f.engine.importAssets([join(media, 'hit.wav')], { pool: 'sfx' });
    const s = { ...settings, userBroll: true, music: true, sfx: true, textHook: true, fillerDictionary: { preserve: [], remove: ['really'] } };
    const r = await pipeline(f, 'context-1', { settings: s, brief: 'an energetic explainer' });
    assert.equal(r.job.state, 'succeeded', JSON.stringify(r.error));
    const plan = f.engine.getPlan()!.plan;
    const broll = plan.visuals.find((v) => v.kind === 'broll');
    assert.equal(broll?.kind === 'broll' && broll.assetId, img!.assetId, JSON.stringify(plan.visuals.map((v) => v.kind)));
    const name = (id: string) => f.engine.assetMeta(id)?.name;
    assert.equal(name(plan.audio.music!.assetId), 'upbeat beat.wav', 'energetic brief → upbeat track');
    assert.deepEqual(plan.audio.sfx.map((x) => [x.category, name(x.assetId)]), [['hit', 'hit.wav']]);
    assert.ok(plan.decisions.some((d) => d.action === 'remove' && d.reason.startsWith('filler') && d.reason.toLowerCase().includes('really')), 'remove-list word cut');
    const cp = JSON.parse(await readFile(join(f.root, 'jobs', r.job.id, 'clean_speech.json'), 'utf8'));
    assert.ok(Object.keys(cp.data.dctx.voiceAnalysis).length === 1, 'voice analysis reached the director');
    const snap = snapshot(f.engine);
    assert.ok(snap.hookOptions.length >= 1 && snap.hookOptions.length <= 3);
    assert.deepEqual(snap.assets.find((a) => a.id === img!.assetId)!.tags, ['flutter']);
  } finally {
    await f.cleanup();
  }
});

test('export reuses a verified final render of the same plan; stems come from the renderer module', async () => {
  const stems: string[] = [];
  const f = await fixture();
  try {
    // Swap in a module with renderStems (writes three silent WAVs of the right length).
    const mod = { createRenderer: () => f.renderer, renderStems: async (input: RenderInput, dir: string) => {
      stems.push(input.compiled.planHash);
      for (const s of ['dialogue', 'music', 'sfx']) await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-af', `atrim=end_sample=${input.compiled.totalSamples}`, join(dir, `${s}.wav`)]);
    } };
    (f.engine.opts as { loadRenderer?: unknown }).loadRenderer = async () => mod;
    assert.equal((await pipeline(f, 'reuse-1')).job.state, 'succeeded');
    const fin = await f.engine.renderFinal();
    assert.equal(fin.job.state, 'succeeded', JSON.stringify(fin.error));
    assert.ok(fin.job.artifacts.some((a) => a.kind === 'render_final'));
    const finals = () => f.renderer.renders.length;
    const before = finals();
    const dest = join(f.root, '..', 'dest');
    await mkdir(dest);
    const x = await f.engine.exportProject({ profile: 'final_1080', destinationDir: dest, burnCaptions: true });
    assert.equal(x.job.state, 'succeeded', JSON.stringify(x.error));
    assert.equal(finals(), before, 'export reused the final render');
    assert.equal(stems.length, 1);
    // Tampered bytes are never reused.
    const art = fin.job.artifacts.find((a) => a.kind === 'render_final')!;
    writeFileSync(join(f.root, art.ref), 'not a video');
    const y = await f.engine.exportProject({ profile: 'final_1080', destinationDir: dest, burnCaptions: true });
    assert.equal(y.job.state, 'succeeded', JSON.stringify(y.error));
    assert.equal(finals(), before + 1, 'a final whose hash no longer verifies is rendered again');
    // A changed face track (re-tracked source) is a different render input: the export renders again, not reuses.
    const take = f.engine.store.listAssets().find((m) => m.kind === 'video')!;
    const facesRef = 'cache/faces/test.json';
    await mkdir(join(f.root, 'cache', 'faces'), { recursive: true });
    writeFileSync(join(f.root, facesRef), JSON.stringify({ width: 320, height: 240, status: 'tracked', track: [{ startUs: 0, endUs: 7_000_000, x: 100, y: 60, w: 80, h: 80, confidence: 0.9 }] }));
    f.engine.store.setSetting(`faces:${take.contentHash}`, { key: 'test', ref: facesRef });
    const z = await f.engine.exportProject({ profile: 'final_1080', destinationDir: dest, burnCaptions: true });
    assert.equal(z.job.state, 'succeeded', JSON.stringify(z.error));
    assert.equal(finals(), before + 2, 'a final rendered with other face tracks is not reused');
  } finally {
    await f.cleanup();
  }
});

test('PATCH /v1/projects/{id}/assets/{assetId} sets tags; Workspace.open recovers interrupted jobs', async () => {
  const f = await fixture();
  const root = f.root;
  const app = f.engine.appDataDir;
  const job = f.engine.store.createJob({ schemaVersion: '1.0', stage: 'Prepare', profile: 'draft', baseRevision: 0, idempotencyKey: 'interrupted-1' });
  f.engine.store.transitionJob(job.id, 'running');
  const assetId = f.engine.store.listAssets()[0]!.id;
  f.engine.close();
  const ws = new Workspace({ appDataDir: app, approvedRoots: [join(root, '..')], transcriber: fakeTranscriber() });
  try {
    const e = ws.open(root);
    assert.notEqual(e.getJob(job.id)!.state, 'running', 'interrupted job left running');
    const s = await startServer(ws, { token: 't'.repeat(32) });
    try {
      const call = (body: unknown) => fetch(`${s.url}/v1/projects/${e.projectId}/assets/${assetId}`, { method: 'PATCH', headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const ok = await call({ tags: ['Server', 'network'] });
      assert.equal(ok.status, 200);
      assert.deepEqual((await ok.json()).tags, ['server', 'network']);
      assert.equal((await call({ tags: 'server' })).status, 400);
      assert.equal((await call({ tags: [], extra: 1 })).status, 400);
    } finally {
      await s.close();
    }
  } finally {
    ws.close();
    await f.cleanup().catch(() => undefined);
  }
});
