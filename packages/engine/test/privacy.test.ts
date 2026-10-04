import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validate } from '@takeoff/contracts';
import { createProject } from '@takeoff/project-store';
import { Engine, Logger, ProviderBroker, type KeyLookup } from '../src/index.ts';
import { SCRIPT, fakeTranscriber, fixture, pipeline, tmp } from './helpers.ts';

function fakeFetch() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ content: [{ type: 'text', text: '{}' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const SECRET = 'sk-ant-api03-SECRETSECRETSECRETSECRETSECRETSECRETSECRETSECRETSECRET-abcdefghijklmnop';
const getKey: KeyLookup = async () => SECRET;

test('local_only denies egress in code: typed error and zero fetch calls', async () => {
  const { dir, cleanup } = await tmp();
  const store = createProject(join(dir, 'p'), 'P');
  try {
    const { f, calls } = fakeFetch();
    const broker = new ProviderBroker(store, { fetch: f, getKey });
    await assert.rejects(broker.send('anthropic', 'transcript', 'edit plan proposal', { text: SCRIPT }), { code: 'egress_denied' });
    // Even with an approval on file, local_only wins.
    broker.setPolicy({ networkPolicy: 'local_only', approvals: [{ provider: 'anthropic', dataTypes: ['transcript'], budgetUsd: 5 }] });
    await assert.rejects(broker.send('anthropic', 'transcript', 'edit plan proposal', {}), { code: 'egress_denied' });
    assert.equal(calls.length, 0);
    assert.equal(store.listEvents('provider_receipt').length, 0);
  } finally {
    store.close();
    await cleanup();
  }
});

test('approved providers: data types and budgets are enforced, and every transfer is receipted', async () => {
  const { dir, cleanup } = await tmp();
  const store = createProject(join(dir, 'p'), 'P');
  try {
    const { f, calls } = fakeFetch();
    const broker = new ProviderBroker(store, { fetch: f, getKey });
    broker.setPolicy({ networkPolicy: 'approved_providers', approvals: [{ provider: 'anthropic', dataTypes: ['transcript'], budgetUsd: 1 }] });
    await assert.rejects(broker.send('anthropic', 'frames', 'review frames', {}), { code: 'egress_denied' });
    await assert.rejects(broker.send('openai', 'transcript', 'x', {}), { code: 'egress_denied' });
    await broker.send('anthropic', 'transcript', 'edit plan proposal', { a: 1 }, { estimatedCostUsd: 0.6 });
    await assert.rejects(broker.send('anthropic', 'transcript', 'edit plan proposal', {}, { estimatedCostUsd: 0.6 }), { code: 'budget_exceeded' });
    assert.equal(calls.length, 1);
    assert.equal((calls[0]!.init.headers as Record<string, string>)['x-api-key'], SECRET);
    const receipts = store.listEvents('provider_receipt');
    assert.equal(receipts.length, 1);
    const r = receipts[0]!.data as Record<string, unknown>;
    assert.ok(validate('provider-receipt', r).ok);
    assert.equal(r.dataType, 'transcript');
    assert.equal(r.bytes, 7);
    assert.ok(!JSON.stringify(store.listEvents()).includes(SECRET), 'key never stored');
    // No caller estimate (the director's case): the provider's conservative estimate still counts against the cap.
    // 0.6 spent, cap 0.65: a send counted as free (the old behaviour) would go out.
    broker.setPolicy({ networkPolicy: 'approved_providers', approvals: [{ provider: 'anthropic', dataTypes: ['transcript'], budgetUsd: 0.65 }] });
    await assert.rejects(broker.send('anthropic', 'transcript', 'edit plan proposal', { max_tokens: 4096 }), { code: 'budget_exceeded' });
    assert.throws(() => broker.setPolicy({ networkPolicy: 'approved_providers', approvals: [{ provider: 'constructor', dataTypes: ['transcript'], budgetUsd: 1 }] }), { code: 'invalid_policy' });
    assert.equal(calls.length, 1);
  } finally {
    store.close();
    await cleanup();
  }
});

test('an external director in a local_only project falls back to rules with no fetch', async () => {
  const { f, calls } = fakeFetch();
  const fx = await fixture({ engine: { fetch: f, getKey, director: { kind: 'external', provider: 'anthropic', model: 'claude-x' } } });
  try {
    const r = await pipeline(fx, 'external-local');
    assert.equal(r.job.state, 'succeeded', JSON.stringify(r.error));
    assert.equal(fx.engine.getPlan()!.plan.provenance.director, 'rules');
    assert.equal(calls.length, 0);
  } finally {
    await fx.cleanup();
  }
});

test('logs keep only allowlisted ids and codes: no transcript, path or key ever reaches the file', async () => {
  const { dir, cleanup } = await tmp();
  try {
    const log = new Logger(join(dir, 'logs'));
    log.log('stage', {
      projectId: 'p-123', jobId: 'job_1', stage: 'Clean speech', durationMs: 12, cacheHit: true,
      counts: { words: 3, text: SCRIPT }, codes: ['disk_full', '/Users/me/secret.mp4'],
      code: SECRET, transcript: SCRIPT, path: '/Users/me/take.mp4', prompt: 'system prompt', apiKey: SECRET,
    });
    log.log('/Users/me/evil path', { stage: SCRIPT });
    const text = await readFile(log.file, 'utf8');
    for (const bad of [SCRIPT, 'Flutter', '/Users/me', 'secret.mp4', SECRET, 'sk-ant', 'system prompt']) assert.ok(!text.includes(bad), bad);
    const first = JSON.parse(text.split('\n')[0]!);
    assert.equal(first.projectId, 'p-123');
    assert.equal(first.stage, 'Clean speech');
    assert.deepEqual(first.counts, { words: 3 });
    assert.deepEqual(first.codes, ['disk_full']);
  } finally {
    await cleanup();
  }
});

test('a full pipeline run logs nothing from the transcript or the project path; diagnostics stay redacted', async () => {
  const fx = await fixture();
  try {
    await pipeline(fx, 'logs-run');
    const text = await readFile(fx.engine.logger.file, 'utf8');
    assert.ok(text.length > 0);
    for (const w of ['Flutter', 'Dio', 'today', fx.root, 'take one']) assert.ok(!text.includes(w), w);
    const out = await fx.engine.diagnosticBundle(join(fx.root, '..'));
    const files = (await readdir(out, { recursive: true })).map(String).sort();
    assert.deepEqual(files, ['capabilities.json', 'logs', 'logs/engine.jsonl', 'versions.json']);
    const all = await Promise.all(['capabilities.json', 'logs/engine.jsonl', 'versions.json'].map((x) => readFile(join(out, x), 'utf8')));
    for (const w of ['Flutter', fx.root]) assert.ok(!all.join('\n').includes(w), w);
  } finally {
    await fx.cleanup();
  }
});

test('capabilities returns a valid DTO with a reason for every unavailable feature', async () => {
  const fx = await fixture();
  try {
    const caps = await fx.engine.capabilities();
    assert.ok(validate('capabilities', caps.dto).ok);
    assert.equal(caps.dto.features.length, 17);
    for (const feat of caps.dto.features) if (feat.status !== 'available') assert.ok(feat.reason, feat.id);
    assert.equal(caps.dto.features.find((x) => x.id === 'F16')?.status, 'unavailable');
    assert.equal(caps.dto.networkPolicy, 'local_only');
    assert.ok(caps.dto.models.some((m) => m.kind === 'asr' && m.id === 'tiny'));
    assert.ok(caps.ffmpeg && caps.fonts);
  } finally {
    await fx.cleanup();
  }
});

test('starter pack requires an explicit network grant, then registers the generated library', async () => {
  const { dir, cleanup } = await tmp();
  const t = fakeTranscriber();
  let downloaded = '';
  t.downloadModel = async (m) => void (downloaded = m);
  const engine = Engine.create(join(dir, 'p'), {
    name: 'P', appDataDir: join(dir, 'app'), approvedRoots: [dir], transcriber: t,
    loadRenderer: async () => ({
      createRenderer: () => { throw new Error('unused'); },
      generateLibraryAudio: async (out: string) => {
        await writeFile(join(out, 'calm.wav'), 'x');
        return [{ id: 'music_calm', kind: 'music' as const, path: join(out, 'calm.wav'), license: 'CC0-1.0' }, { id: 'evil', kind: 'sfx' as const, path: '/etc/passwd', license: 'x' }];
      },
    }),
  });
  try {
    await assert.rejects(engine.installStarterPack({ allowNetwork: false as true }), { code: 'network_denied' });
    assert.equal(downloaded, '');
    const r = await engine.installStarterPack({ allowNetwork: true });
    assert.equal(downloaded, 'base');
    assert.deepEqual(r.library.map((e) => e.id), ['music_calm'], 'entries outside the library are dropped');
    assert.ok(r.licenses.some((l) => l.license === 'CC0-1.0'));
    assert.deepEqual(engine.library().map((e) => e.path), ['calm.wav']);
    // A cached base model: no download and no network grant needed (library generation is local).
    downloaded = '';
    t.probe = async () => ({ models: ['base'], devices: ['cpu'], defaultDevice: 'cpu', versions: { fake: '1' } });
    await engine.installStarterPack({ allowNetwork: false as true });
    assert.equal(downloaded, '');
  } finally {
    engine.close();
    await cleanup();
  }
});

test('browser overlay violations map onto QA checks (network, fonts, captions, scenes)', async () => {
  const { overlayFromBrowser } = await import('../src/index.ts');
  const o = overlayFromBrowser({
    captionBounds: [{ captionId: 'caption_0001', rect: { x: 40, y: 200, w: 300, h: 80 } }],
    violations: [
      { code: 'undeclared_network', ref: 'https://evil.example' },
      { code: 'font_missing', ref: 'Inter' },
      { code: 'caption_overflow', ref: 'caption_0002' },
      { code: 'scene_text_overflow', ref: 'motion_0001' },
    ],
  });
  assert.equal(o.undeclaredRequests, 1);
  assert.equal(o.missingFonts, 1);
  assert.deepEqual(o.captionFailures, [{ captionId: 'caption_0002', code: 'caption_overflow' }]);
  assert.deepEqual(o.visualFailures, [{ visualId: 'motion_0001', code: 'scene_text_overflow' }]);
});
