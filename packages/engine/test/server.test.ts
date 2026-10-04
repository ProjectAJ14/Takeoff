import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { validate } from '@takeoff/contracts';
import { Workspace, startServer, type RendererModule } from '../src/index.ts';
import { fakeRenderer, fakeTranscriber, makeVideo, settings, tmp } from './helpers.ts';

type Res = { status: number; headers: Record<string, string | string[] | undefined>; text: string; json: any };

function call(port: number, method: string, path: string, o: { token?: string | null; host?: string; origin?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}): Promise<Res> {
  const payload = o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body));
  const headers: Record<string, string> = { host: o.host ?? `127.0.0.1:${port}`, ...o.headers };
  if (o.token !== null && o.token !== undefined) headers.authorization = `Bearer ${o.token}`;
  if (o.origin) headers.origin = o.origin;
  if (payload !== undefined) headers['content-type'] = 'application/json';
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: any;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode!, headers: res.headers, text, json });
      });
    });
    r.on('error', reject);
    if (payload !== undefined) r.write(payload);
    r.end();
  });
}

async function setup(extra: { fetch?: typeof fetch } = {}) {
  const { dir, cleanup } = await tmp('takeoff-server-');
  const media = join(dir, 'media');
  await mkdir(media);
  const take = await makeVideo(join(media, 'take.mp4'));
  const renderer = fakeRenderer();
  const mod: RendererModule = { createRenderer: () => renderer };
  const ws = new Workspace({ appDataDir: join(dir, 'appdata'), approvedRoots: [dir], transcriber: fakeTranscriber(), loadRenderer: async () => mod, asr: { model: 'tiny', language: 'en' }, ...extra });
  const token = 't'.repeat(43);
  const s = await startServer(ws, { token, appOrigin: 'app://takeoff' });
  const api = (method: string, path: string, o: Parameters<typeof call>[3] = {}) => call(s.port, method, path, { token, ...o });
  return { dir, take, ws, s, token, api, cleanup: async () => (await s.close(), ws.close(), await cleanup()) };
}

async function waitJob(api: (m: string, p: string) => Promise<Res>, id: string) {
  for (;;) {
    const r = await api('GET', `/v1/jobs/${id}`);
    if (['succeeded', 'failed', 'canceled'].includes(r.json.state)) return r.json;
    await new Promise((x) => setTimeout(x, 50));
  }
}

test('binds to 127.0.0.1 only and rejects missing/wrong tokens, foreign Host and Origin, and oversized bodies', async () => {
  const t = await setup();
  try {
    assert.equal(t.s.host, '127.0.0.1');
    assert.match(t.s.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const none = await t.api('GET', '/v1/projects', { token: null });
    assert.equal(none.status, 401);
    assert.deepEqual(Object.keys(none.json).sort(), ['code', 'message', 'remedy']);
    assert.equal((await t.api('GET', '/v1/projects', { token: 'x'.repeat(43) })).status, 401);
    assert.equal((await t.api('GET', '/v1/projects', { token: t.token.slice(1) })).status, 401);
    assert.equal((await t.api('GET', '/v1/projects', { host: `evil.example:${t.s.port}` })).status, 421);
    assert.equal((await t.api('GET', '/v1/projects', { host: `127.0.0.1:${t.s.port + 1}` })).status, 421);
    assert.equal((await t.api('GET', '/v1/projects', { host: `localhost:${t.s.port}` })).status, 200);
    assert.equal((await t.api('GET', '/v1/projects', { origin: 'https://evil.example' })).status, 403);
    const ok = await t.api('GET', '/v1/projects', { origin: 'app://takeoff' });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['access-control-allow-origin'], 'app://takeoff');
    assert.equal((await t.api('GET', '/v1/projects', { origin: 'null' })).status, 200);
    const badUrl = await t.api('GET', '/v1/projects/%E0%A4%A');
    assert.equal(badUrl.status, 400, 'malformed percent-encoding is a client error, not a 500');
    const big = await t.api('POST', '/v1/projects', { raw: JSON.stringify({ schemaVersion: '1.0', name: 'x'.repeat(1024 * 1024 + 10) }) });
    assert.equal(big.status, 413);
    assert.equal(big.json.code, 'body_too_large');
    const bad = await t.api('POST', '/v1/projects', { body: { schemaVersion: '1.0', name: 'x', extra: 1 } });
    assert.equal(bad.status, 400);
    assert.equal((await t.api('POST', '/v1/projects', { body: { schemaVersion: '1.0', name: 'x' }, headers: {} }).then((r) => r.status)), 201);
    const outside = await t.api('POST', '/v1/projects?root=/etc/takeoff-test', { body: { schemaVersion: '1.0', name: 'x' } });
    assert.equal(outside.status, 403);
    assert.equal(outside.json.code, 'path_not_approved');
  } finally {
    await t.cleanup();
  }
});

test('project lifecycle: create, import, Edit Video job, plan, 409 on stale PATCH, undo, media Range, SSE', async () => {
  const t = await setup();
  try {
    const created = await t.api('POST', `/v1/projects?root=${encodeURIComponent(join(t.dir, 'p1'))}`, { body: { schemaVersion: '1.0', name: 'Demo', settings } });
    assert.equal(created.status, 201, created.text);
    assert.ok(validate('create-project-response', created.json).ok);
    const id = created.json.projectId;
    assert.deepEqual((await t.api('GET', '/v1/projects')).json.projects.map((p: { id: string }) => p.id), [id]);

    const imp = await t.api('POST', `/v1/projects/${id}/assets`, { body: { schemaVersion: '1.0', items: [{ source: 'path', path: t.take }, { source: 'path', path: '/etc/hosts' }] } });
    assert.equal(imp.status, 200, imp.text);
    assert.ok(imp.json.items[0].assetId);
    assert.equal(imp.json.items[1].error.code, 'path_not_approved');

    const jobReq = { schemaVersion: '1.0', stage: 'Prepare', profile: 'draft', baseRevision: 0, idempotencyKey: 'edit-video-1' };
    const started = await t.api('POST', `/v1/projects/${id}/jobs`, { body: jobReq });
    assert.equal(started.status, 202, started.text);
    assert.ok(validate('job', started.json).ok);
    const job = await waitJob(t.api, started.json.id);
    assert.equal(job.state, 'succeeded', JSON.stringify(job.error));
    assert.equal((await t.api('POST', `/v1/projects/${id}/jobs`, { body: jobReq })).json.id, job.id, 'idempotent');

    const plan = await t.api('GET', `/v1/projects/${id}/plan`);
    assert.equal(plan.status, 200);
    const rev = plan.json.revision;
    const cap = plan.json.plan.captions[0].id;
    const patch = (baseRevision: number) => ({ schemaVersion: '1.0', baseRevision, ops: [{ op: 'lock_object', objectId: cap }] });
    const stale = await t.api('PATCH', `/v1/projects/${id}/plan`, { body: patch(rev - 1) });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.code, 'stale_revision');
    const okPatch = await t.api('PATCH', `/v1/projects/${id}/plan`, { body: patch(rev) });
    assert.equal(okPatch.status, 200, okPatch.text);
    assert.equal(okPatch.json.revision, rev + 1);
    assert.equal((await t.api('PATCH', `/v1/projects/${id}/plan`, { body: { schemaVersion: '1.0', baseRevision: rev + 1, ops: [{ op: 'run_shell', cmd: 'ls' }] } })).status, 400);
    const undo = await t.api('POST', `/v1/projects/${id}/undo`, { body: { baseRevision: rev + 1 } });
    assert.equal(undo.status, 200, undo.text);
    assert.equal(undo.json.revision, rev + 2);
    assert.notEqual((await t.api('GET', `/v1/projects/${id}/plan`)).json.plan.captions[0].locked, true, 'undo removed the lock');

    const snap = (await t.api('GET', `/v1/projects/${id}`)).json;
    assert.ok(snap.transcripts[0].words.length > 0);
    assert.equal(snap.latestJob.id, job.id);
    const render = snap.artifacts.find((a: { kind: string }) => a.kind === 'render_draft');
    const full = await t.api('GET', `/v1/projects/${id}/media/${render.id}`);
    assert.equal(full.status, 200);
    assert.equal(full.headers['content-type'], 'video/mp4');
    const part = await t.api('GET', `/v1/projects/${id}/media/${render.id}`, { headers: { range: 'bytes=0-9' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers['content-length'], '10');
    assert.match(String(part.headers['content-range']), /^bytes 0-9\/\d+$/);
    assert.equal((await t.api('GET', `/v1/projects/${id}/media/${render.id}`, { headers: { range: 'bytes=999999999-' } })).status, 416);
    assert.equal((await t.api('GET', `/v1/projects/${id}/media/${'0'.repeat(64)}`)).status, 404);

    const frames = await t.api('POST', `/v1/projects/${id}/frames`, { body: { schemaVersion: '1.0', frames: [{ clock: 'source', assetId: snap.assets[0].id, us: 1_000_000 }] } });
    assert.equal(frames.status, 200, frames.text);
    assert.equal((await t.api('GET', `/v1/projects/${id}/media/${frames.json.frames[0].artifactId}`)).headers['content-type'], 'image/png');

    const sse = await t.api('GET', `/v1/jobs/${job.id}/events`);
    assert.equal(sse.headers['content-type'], 'text/event-stream');
    assert.match(sse.text, /^event: job\ndata: \{.*"state":"succeeded"/);

    const caps = await t.api('GET', '/v1/capabilities');
    assert.ok(validate('capabilities', caps.json).ok);
    const sys = (await t.api('GET', '/v1/system')).json;
    assert.equal(typeof sys.ffmpeg, 'boolean');
    assert.ok(sys.diskFreeBytes === null || sys.diskFreeBytes > 0);
  } finally {
    await t.cleanup();
  }
});

test('app routes: runtime approved roots (in-process only), edit defaults with take order, brand, providers, requests, diagnostics', async () => {
  // A fake local director: Ollama tags + a chat reply that names one allowlisted and one unknown intent.
  const seen: string[] = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    seen.push(String(url));
    assert.match(String(url), /^http:\/\/127\.0\.0\.1:11434\//, 'requests only ever reach loopback Ollama');
    if (String(url).endsWith('/api/tags')) return Response.json({ models: [{ name: 'llama3:latest' }] });
    assert.ok(String(init?.body).includes('<untrusted_data>'), 'the request text is fenced');
    return Response.json({ message: { content: JSON.stringify({ intents: ['captions_static', 'run_shell'] }) } });
  }) as typeof fetch;
  const t = await setup({ fetch: fakeFetch });
  try {
    // A folder outside the approved roots is refused until the main process approves it in-process.
    const { dir: other, cleanup: cleanOther } = await tmp('takeoff-picked-');
    try {
      const second = await makeVideo(join(other, 'second.mp4'), 6);
      const created = await t.api('POST', `/v1/projects?root=${encodeURIComponent(join(t.dir, 'p2'))}`, { body: { schemaVersion: '1.0', name: 'App', settings } });
      const id = created.json.projectId;
      const imp = (path: string) => t.api('POST', `/v1/projects/${id}/assets`, { body: { schemaVersion: '1.0', items: [{ source: 'path', path }] } });
      assert.equal((await imp(second)).json.items[0].error.code, 'path_not_approved');
      for (const path of ['/v1/approved-roots', '/v1/roots', '/v1/workspace/roots']) assert.equal((await t.api('POST', path, { body: { path: other } })).status, 404, 'no HTTP route widens access');
      t.ws.addApprovedRoot(second); // a single picked file
      const a2 = (await imp(second)).json.items[0].assetId;
      const a1 = (await imp(t.take)).json.items[0].assetId;
      assert.ok(a1 && a2);

      const bad = await t.api('POST', `/v1/projects/${id}/edit-defaults`, { body: { takes: ['a_nope'] } });
      assert.equal(bad.status, 400);
      assert.equal((await t.api('POST', `/v1/projects/${id}/edit-defaults`, { body: { zoomMaxScale: 2 } })).status, 400);
      assert.equal((await t.api('POST', `/v1/projects/${id}/edit-defaults`, { body: { root: '/' } })).status, 400);
      assert.equal((await t.api('POST', `/v1/projects/${id}/edit-defaults`, { body: { brandProfileId: 'nope' } })).status, 400);

      const brand = { schemaVersion: '1.0', id: 'mine', version: 1, name: 'Mine', palette: [{ role: 'primary', color: '#0A84FF' }], fonts: [{ role: 'caption', family: 'Inter', assetId: null, license: 'OFL-1.1' }], logos: [], captionStyle: { template: 'restrained', highlightColor: '#FFD60A', positionPolicy: 'safe_bottom' }, hookTone: 'plain', glossary: [], prohibitedClaims: [], motionIntensity: 'restrained', safeLayouts: ['full'], music: { moods: [], bannedCategories: [] }, sfx: { bannedCategories: [] }, ctaTemplates: [], aspectPresets: [{ width: 1080, height: 1920 }], provenance: { source: 'manual', sourceUrl: null, createdAt: '2026-10-05T12:00:00Z' } };
      assert.equal((await t.api('POST', `/v1/projects/${id}/brands`, { body: { ...brand, palette: 'x' } })).status, 400);
      assert.equal((await t.api('POST', `/v1/projects/${id}/brands`, { body: brand })).status, 201);

      const set = await t.api('POST', `/v1/projects/${id}/edit-defaults`, { body: { takes: [a1], brandProfileId: 'mine', brief: 'Keep it calm.', captionTemplate: 'static', zoomMaxScale: 1.1, targetSeconds: 30, lengthPolicy: 'hard_max' } });
      assert.equal(set.status, 200, set.text);
      assert.deepEqual(set.json.editDefaults.takes, [a1]);
      assert.equal(set.json.editDefaults.lengthPolicy, 'hard_max');
      // Clearing one field keeps the rest.
      const cleared = await t.api('POST', `/v1/projects/${id}/edit-defaults`, { body: { brief: null, targetSeconds: null } });
      assert.equal(cleared.json.editDefaults.brief, undefined);
      assert.equal(cleared.json.editDefaults.captionTemplate, 'static');

      const started = await t.api('POST', `/v1/projects/${id}/jobs`, { body: { schemaVersion: '1.0', stage: 'Prepare', profile: 'draft', baseRevision: 0, idempotencyKey: 'edit-video-app' } });
      assert.equal((await waitJob(t.api, started.json.id)).state, 'succeeded');
      let plan = (await t.api('GET', `/v1/projects/${id}/plan`)).json;
      assert.deepEqual([...new Set(plan.plan.segments.map((g: { assetId: string }) => g.assetId))], [a1], 'only the selected take is used');
      assert.ok(plan.plan.captions.length && plan.plan.captions.every((c: { template: string }) => c.template === 'static'));
      assert.ok(plan.plan.transforms.every((x: { kind: string; scale?: number }) => x.kind !== 'punch' || x.scale! <= 1.1));
      assert.equal(plan.plan.brandProfileRef, 'brands/mine@1');

      // Order follows the take list.
      await t.api('POST', `/v1/projects/${id}/edit-defaults`, { body: { takes: [a2, a1], captionTemplate: 'energetic' } });
      const again = await t.api('POST', `/v1/projects/${id}/jobs`, { body: { schemaVersion: '1.0', stage: 'Prepare', profile: 'draft', baseRevision: plan.revision, idempotencyKey: 'edit-video-app-2' } });
      assert.equal((await waitJob(t.api, again.json.id)).state, 'succeeded');
      plan = (await t.api('GET', `/v1/projects/${id}/plan`)).json;
      assert.deepEqual([...new Set(plan.plan.segments.map((g: { assetId: string }) => g.assetId))], [a2, a1]);

      // Plain-language request: only the allowlisted intent becomes ops; stale revisions are refused.
      assert.equal((await t.api('POST', `/v1/projects/${id}/requests`, { body: { text: 'static captions please', baseRevision: plan.revision - 1 } })).status, 409);
      assert.equal((await t.api('POST', `/v1/projects/${id}/requests`, { body: { text: 'x'.repeat(501), baseRevision: plan.revision } })).status, 400);
      const r = await t.api('POST', `/v1/projects/${id}/requests`, { body: { text: 'static captions please', baseRevision: plan.revision } });
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.json.intents, ['captions_static']);
      assert.equal(r.json.revision, plan.revision + 1);
      assert.ok(seen.length >= 2);

      // Providers: off by default, readable over HTTP, never writable there (in-process only), validated on save.
      assert.equal((await t.api('GET', `/v1/projects/${id}/providers`)).json.policy.networkPolicy, 'local_only');
      assert.equal((await t.api('POST', `/v1/projects/${id}/providers`, { body: { networkPolicy: 'approved_providers', approvals: [{ provider: 'anthropic', dataTypes: ['transcript'], budgetUsd: 1 }] } })).status, 404);
      assert.equal((await t.api('GET', `/v1/projects/${id}/providers`)).json.policy.networkPolicy, 'local_only');
      const broker = t.ws.byId(id).broker;
      assert.throws(() => broker.setPolicy({ networkPolicy: 'approved_providers', approvals: [{ provider: 'evil', dataTypes: ['video'], budgetUsd: 1 }] } as never));
      assert.deepEqual(broker.setPolicy({ networkPolicy: 'approved_providers', approvals: [{ provider: 'anthropic', dataTypes: ['transcript'], budgetUsd: 1 }] } as never).approvals[0]!.dataTypes, ['transcript']);

      // Diagnostics without a project open, only into an approved folder.
      assert.equal((await t.api('POST', '/v1/diagnostics', { body: { destinationDir: '/etc' } })).status, 403);
      const diag = await t.api('POST', '/v1/diagnostics', { body: { destinationDir: t.dir } });
      assert.equal(diag.status, 201, diag.text);
      assert.ok(diag.json.dir.startsWith(t.dir) || diag.json.dir.includes('takeoff-diagnostics-'));
    } finally {
      await cleanOther();
    }
  } finally {
    await t.cleanup();
  }
});
