import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import type { AssetManifest, CreateJobRequest, ProviderReceipt, Transcript } from '@takeoff/contracts';
import { atomicWrite, canonicalJson, createProject, migrations, openProject, resolveUnderRoot, StaleRevisionError } from '../src/index.ts';
import { fixture, plan, tmp } from './helpers.ts';

const seedOf = (s: { plan: { provenance: { seed: number } } } | undefined) => s?.plan.provenance.seed;
const jobReq = (key: string, baseRevision = 0): CreateJobRequest => ({ schemaVersion: '1.0', stage: 'Transcribe', profile: 'draft', baseRevision, idempotencyKey: key });

test('create, reopen, WAL, migrations applied once', () => {
  const root = tmp();
  const s = createProject(root, 'Demo');
  const id = s.projectId;
  assert.equal(s.currentRevision(), 0);
  assert.equal((s.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');
  s.close();
  assert.throws(() => createProject(root, 'Again'), /already exists/);
  for (let i = 0; i < 3; i++) openProject(root).close();
  const s2 = openProject(root);
  assert.equal(s2.projectId, id);
  const rows = s2.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[];
  assert.deepEqual(rows.map((r) => r.version), migrations.map((_, i) => i + 1));
  s2.close();
  assert.throws(() => openProject(tmp()), /no project/);
});

test('refuses a database migrated by a newer app', () => {
  const root = tmp();
  createProject(root, 'Demo').close();
  const db = new DatabaseSync(join(root, 'project.db'));
  db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(migrations.length + 1, 'x');
  db.close();
  assert.throws(() => openProject(root), /newer than this app/);
});

test('commitPlan validates, bumps revision, rejects stale base', () => {
  const s = createProject(tmp(), 'Demo');
  assert.throws(() => s.commitPlan({ ...plan(s.projectId, 1), revision: -1 }, 0, 'user'), /invalid edit-plan/);
  assert.throws(() => s.commitPlan(plan('other_project', 1), 0, 'user'), /another project/);
  const r1 = s.commitPlan(plan(s.projectId, 1), 0, 'agent');
  assert.equal(r1.revision, 1);
  assert.equal(r1.plan.revision, 1);
  assert.match(r1.planHash, /^[a-f0-9]{64}$/);
  assert.equal(s.info().planHash, r1.planHash);
  assert.throws(() => s.commitPlan(plan(s.projectId, 2), 0, 'user'), (e: unknown) => e instanceof StaleRevisionError && e.expected === 0 && e.actual === 1);
  assert.equal(s.currentRevision(), 1);
  assert.equal(seedOf(s.getPlan()), 1);
  s.close();
});

test('concurrent writers on separate connections: exactly one wins per base revision', async () => {
  const root = tmp();
  const s = createProject(root, 'Demo');
  s.commitPlan(plan(s.projectId, 0), 0, 'user');
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) => new Promise<string>((res, rej) => {
      const w = new Worker(new URL('./commit-worker.ts', import.meta.url), { workerData: { root, base: 1, marker: i + 10 } });
      w.once('message', res);
      w.once('error', rej);
    })),
  );
  assert.equal(results.filter((r) => r === 'ok').length, 1, results.join(','));
  assert.equal(results.filter((r) => r === 'stale').length, 5, results.join(','));
  assert.equal(s.currentRevision(), 2);
  assert.equal(s.listRevisions().length, 2);
  s.close();
});

test('undo, redo and revert append revisions and never rewrite history', () => {
  const s = createProject(tmp(), 'Demo');
  assert.throws(() => s.undo('user'), /nothing to undo/);
  for (const m of [1, 2, 3]) s.commitPlan(plan(s.projectId, m), m - 1, 'user');
  const before = s.listRevisions().map((r) => r.planHash);

  assert.equal(seedOf(s.undo('user')), 2); // rev 4
  assert.equal(seedOf(s.undo('user', 4)), 1); // rev 5
  assert.throws(() => s.undo('user'), /nothing to undo/);
  assert.equal(seedOf(s.redo('user')), 2); // rev 6
  assert.equal(seedOf(s.redo('user')), 3); // rev 7
  assert.throws(() => s.redo('user'), /nothing to redo/);
  assert.equal(seedOf(s.undo('agent')), 2); // rev 8
  s.commitPlan(plan(s.projectId, 9), 8, 'user'); // rev 9: new edit clears redo
  assert.throws(() => s.redo('user'), /nothing to redo/);
  assert.equal(seedOf(s.undo('user')), 2);
  assert.throws(() => s.undo('user', 3), StaleRevisionError);

  const r = s.revertTo(1, 'user');
  assert.equal(seedOf(r), 1);
  assert.equal(r.plan.revision, r.revision);
  assert.equal(seedOf(s.undo('user')), 2); // revert is undoable
  assert.deepEqual(s.listRevisions().slice(0, 3).map((x) => x.planHash), before);
  assert.deepEqual(s.listRevisions().map((x) => x.op), ['commit', 'commit', 'commit', 'undo', 'undo', 'redo', 'redo', 'undo', 'commit', 'undo', 'revert', 'undo']);
  assert.equal(seedOf(s.getPlan(3)), 3);
  s.close();
});

test('jobs: idempotent create, legal transitions only, dependencies', () => {
  const s = createProject(tmp(), 'Demo');
  const a = s.createJob(jobReq('key-aaaaaaaa'));
  assert.equal(a.state, 'queued');
  assert.equal(s.createJob({ ...jobReq('key-aaaaaaaa'), stage: 'Export' }).id, a.id);
  assert.equal(s.listJobs().length, 1);
  assert.throws(() => s.createJob(jobReq('key-bbbbbbbb', 5)), /does not exist/);
  assert.throws(() => s.createJob(jobReq('key-cccccccc'), ['nope']), /unknown dependency/);

  const b = s.createJob(jobReq('key-dddddddd'), [a.id]);
  assert.throws(() => s.transitionJob(b.id, 'running'), /has not succeeded/);
  assert.throws(() => s.transitionJob(a.id, 'succeeded'), /illegal job transition queued -> succeeded/);
  assert.equal(s.transitionJob(a.id, 'running').attempts, 1);
  s.setJobProgress(a.id, 0.5);
  assert.throws(() => s.setJobProgress(a.id, 2));
  assert.throws(() => s.transitionJob(a.id, 'failed'), /need an error/);
  assert.equal(s.transitionJob(a.id, 'succeeded').state, 'succeeded');
  assert.throws(() => s.transitionJob(a.id, 'running'), /illegal/);
  assert.equal(s.transitionJob(b.id, 'running').state, 'running');
  const f = s.transitionJob(b.id, 'failed', { error: { code: 'x', message: 'boom', remedy: 'retry' } });
  assert.equal(f.error?.code, 'x');
  assert.equal(s.transitionJob(b.id, 'queued').error, null);
  s.close();
});

test('recovery requeues verified checkpoints, fails the rest, drops partial artifacts', () => {
  const root = tmp();
  const s = createProject(root, 'Demo');
  mkdirSync(join(root, 'cache'));
  const good = s.createJob(jobReq('key-good0000'));
  const bad = s.createJob(jobReq('key-bad00000'));
  const none = s.createJob(jobReq('key-none0000'));
  for (const j of [good, bad, none]) s.transitionJob(j.id, 'running');

  atomicWrite(join(root, 'cache/good.json'), '{"ok":1}');
  atomicWrite(join(root, 'cache/bad.json'), '{"ok":2}');
  atomicWrite(join(root, 'cache/out.mp4'), 'frames');
  s.addCheckpoint(good.id, 'asr', 'cache/good.json');
  s.addCheckpoint(bad.id, 'asr', 'cache/bad.json');
  s.addArtifact(bad.id, 'video', 'cache/out.mp4');
  writeFileSync(join(root, 'cache/out.mp4.x.partial'), 'half');
  assert.throws(() => s.addArtifact(bad.id, 'video', 'cache/out.mp4.x.partial'), /partial/);
  assert.throws(() => s.addArtifact(good.id, 'video', '../escape.mp4'), /portable/);
  assert.throws(() => s.addCheckpoint(none.id, 'asr', 'cache/missing.json'), /not found/);
  s.close();

  // Simulated crash: the bad job's checkpoint and artifact were overwritten mid-write.
  writeFileSync(join(root, 'cache/bad.json'), '{"ok":');
  writeFileSync(join(root, 'cache/out.mp4'), 'fra');
  const r = openProject(root);
  const out = r.recoverInterruptedJobs();
  assert.deepEqual(out.requeued, [good.id]);
  assert.deepEqual(new Set(out.failed), new Set([bad.id, none.id]));
  assert.equal(r.getJob(good.id)?.state, 'queued');
  assert.equal(r.getCheckpoints(good.id).length, 1);
  const b = r.getJob(bad.id)!;
  assert.equal(b.state, 'failed');
  assert.equal(b.error?.code, 'interrupted');
  assert.deepEqual(b.artifacts, []);
  assert.equal(r.listJobs('succeeded').length, 0);
  assert.deepEqual(r.recoverInterruptedJobs(), { requeued: [], failed: [] });
  r.close();
});

test('assets, transcripts, settings, events and provider receipts', () => {
  const root = tmp();
  const s = createProject(root, 'Demo');
  const m = fixture<AssetManifest>('asset-manifest/rotated-vfr-video.json');
  assert.throws(() => s.importAsset(m), /not found/);
  mkdirSync(join(root, 'media'));
  writeFileSync(join(root, 'media/take_a.mov'), 'x');
  s.importAsset(m);
  assert.deepEqual(s.getAsset('take_a'), m);
  assert.equal(s.listAssets().length, 1);
  assert.throws(() => s.importAsset({ ...m, id: 'take_b', relativePath: '../outside.mov' }), /invalid asset-manifest/);

  const t = fixture<Transcript>('transcript/words-and-corrections.json');
  const h1 = 'a'.repeat(64), h2 = 'b'.repeat(64);
  s.putTranscript(h1, h2, 'whisper-small', t);
  assert.deepEqual(s.getTranscript(h1, h2, 'whisper-small'), t);
  assert.equal(s.getTranscript(h1, h2, 'whisper-large'), undefined);

  s.setSetting('networkPolicy', 'local_only');
  s.setSetting('networkPolicy', 'approved_providers');
  assert.equal(s.getSetting('networkPolicy'), 'approved_providers');

  const receipt = { ...fixture<ProviderReceipt>('provider-receipt/transcript-transfer.json'), projectId: s.projectId };
  s.recordProviderReceipt(receipt);
  assert.throws(() => s.recordProviderReceipt({ ...receipt, projectId: 'someone_else' }), /another project/);
  assert.deepEqual(s.listEvents('provider_receipt').map((e) => e.data), [receipt]);
  assert.throws(() => s.db.exec('DELETE FROM events'), /append-only/);
  assert.throws(() => s.db.exec("UPDATE events SET type = 'x'"), /append-only/);
  s.close();
});

test('resolveUnderRoot rejects traversal, absolute paths and symlink escapes', () => {
  const root = tmp();
  const outside = tmp();
  mkdirSync(join(root, 'media'));
  symlinkSync(outside, join(root, 'media/link'));
  writeFileSync(join(outside, 'secret'), 's');
  symlinkSync(join(outside, 'secret'), join(root, 'file-link'));
  for (const bad of ['../x', 'media/../../x', '/etc/passwd', 'C:/x', 'a\\b', '', 'media/link/secret', 'media/link/new/file', 'file-link']) {
    assert.throws(() => resolveUnderRoot(root, bad), Error, bad);
  }
  assert.ok(resolveUnderRoot(root, 'media/new/file.mov').endsWith('/media/new/file.mov'));
  symlinkSync(join(root, 'media'), join(root, 'inside-link'));
  assert.ok(resolveUnderRoot(root, 'inside-link/x').endsWith('/media/x'));
});

test('atomicWrite replaces content and leaves no partial file', () => {
  const dir = tmp();
  const p = join(dir, 'plan.json');
  atomicWrite(p, 'one');
  atomicWrite(p, new Uint8Array([116, 119, 111]));
  assert.equal(readFileSync(p, 'utf8'), 'two');
  assert.deepEqual(readdirSync(dir), ['plan.json']);
  assert.throws(() => atomicWrite(join(dir, 'missing/x'), 'y'));
  assert.ok(!existsSync(join(dir, 'missing')));
});

test('regression: dangling symlink to outside the root is rejected', () => {
  const root = tmp();
  symlinkSync(join(tmp(), 'not-yet'), join(root, 'dangling'));
  assert.throws(() => resolveUnderRoot(root, 'dangling'), /escapes/);
  assert.throws(() => resolveUnderRoot(root, 'dangling/child'), /escapes/);
});

test('regression: optional fields set to undefined still store valid, stable JSON', () => {
  const s = createProject(tmp(), 'Demo');
  const p = plan(s.projectId, 1);
  const withUndef = { ...p, decisions: p.decisions.map((d) => ({ ...d, detector: undefined })) };
  const a = s.commitPlan(withUndef, 0, 'user');
  assert.equal(s.getPlan()!.planHash, a.planHash);
  assert.equal(s.commitPlan(p, 1, 'user').planHash.length, 64);
  assert.equal(canonicalJson({ b: undefined, a: [undefined, 1] }), '{"a":[null,1]}');
  s.close();
});

test('regression: agent and system commits cannot change, unlock or drop a locked object', () => {
  const s = createProject(tmp(), 'Demo');
  const p = plan(s.projectId, 1);
  const locked = { ...p, captions: p.captions.map((c, i) => (i === 0 ? { ...c, locked: true } : c)) };
  s.commitPlan(locked, 0, 'user'); // rev 1
  const cap = locked.captions[0]!;
  const edited = { ...locked, captions: [{ ...cap, text: 'agent rewrite' }, ...locked.captions.slice(1)] };
  assert.throws(() => s.commitPlan(edited, 1, 'agent'), /locked object captions\/.* user/);
  assert.throws(() => s.commitPlan({ ...locked, captions: locked.captions.slice(1) }, 1, 'system'), /locked object/);
  assert.throws(() => s.commitPlan({ ...locked, captions: [{ ...cap, locked: false }, ...locked.captions.slice(1)] }, 1, 'agent'), /locked object/);
  // Unlocked objects and reordering stay free for the agent; the user may change the locked one.
  s.commitPlan({ ...locked, captions: [...locked.captions].reverse(), provenance: { ...locked.provenance, seed: 2 } }, 1, 'agent'); // rev 2
  s.commitPlan(edited, 2, 'user'); // rev 3
  assert.throws(() => s.revertTo(2, 'agent'), /locked object/);
  assert.equal(s.revertTo(2, 'user').revision, 4);
  s.close();
});

test('regression: job transitions and artifacts are validated against the contracts Job schema', () => {
  const root = tmp();
  const s = createProject(root, 'Demo');
  const j = s.createJob(jobReq('key-eeeeeeee'));
  s.transitionJob(j.id, 'running');
  assert.throws(() => s.transitionJob(j.id, 'failed', { error: { code: 'x' } as never }), /invalid job/);
  assert.equal(s.getJob(j.id)?.state, 'running');
  s.close();
});
