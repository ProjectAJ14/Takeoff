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

async function setup() {
  const { dir, cleanup } = await tmp('takeoff-server-');
  const media = join(dir, 'media');
  await mkdir(media);
  const take = await makeVideo(join(media, 'take.mp4'));
  const renderer = fakeRenderer();
  const mod: RendererModule = { createRenderer: () => renderer };
  const ws = new Workspace({ appDataDir: join(dir, 'appdata'), approvedRoots: [dir], transcriber: fakeTranscriber(), loadRenderer: async () => mod, asr: { model: 'tiny', language: 'en' } });
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
  } finally {
    await t.cleanup();
  }
});
