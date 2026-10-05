import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  commonSchema,
  validate,
  type AssetManifest,
  type BrandProfile,
  type CreateJobRequest,
  type EditPlan,
  type ErrorInfo,
  type Job,
  type JobState,
  type ProviderReceipt,
  type RelPath,
  type Sha256,
  type Transcript,
} from '@takeoff/contracts';
import { migrations } from './migrations.ts';
import { resolveUnderRoot } from './fs.ts';

export { atomicWrite, resolveUnderRoot } from './fs.ts';
export { migrations } from './migrations.ts';

export type Author = 'agent' | 'user' | 'system';
export type RevisionOp = 'commit' | 'undo' | 'redo' | 'revert';
export interface RevisionInfo {
  revision: number;
  planHash: Sha256;
  author: Author;
  op: RevisionOp;
  /** The revision an undo from here returns to (null: nothing to undo). */
  parent: number | null;
  createdAt: string;
}
export interface PlanSnapshot {
  revision: number;
  planHash: Sha256;
  plan: EditPlan;
}
/** A completed, verifiable stage output a job can resume from. */
export interface Checkpoint {
  name: string;
  ref: RelPath;
  hash: Sha256;
}
export interface StoreEvent {
  seq: number;
  type: string;
  data: unknown;
  createdAt: string;
}

export class StaleRevisionError extends Error {
  expected: number;
  actual: number;
  constructor(expected: number, actual: number) {
    super(`stale revision: based on ${expected}, current is ${actual}`);
    this.name = 'StaleRevisionError';
    this.expected = expected;
    this.actual = actual;
  }
}

const DB_FILE = 'project.db';
const REL_PATH = new RegExp(commonSchema.$defs.relPath.pattern);
const SCHEMA_VERSION = '1.0';

const TRANSITIONS: Record<JobState, readonly JobState[]> = {
  queued: ['running', 'canceled'],
  running: ['succeeded', 'failed', 'canceled', 'waiting_for_user', 'queued'],
  waiting_for_user: ['running', 'canceled'],
  failed: ['queued'],
  succeeded: [],
  canceled: [],
};

const now = () => new Date().toISOString();
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** JSON with sorted object keys, so equal plans hash equally regardless of key order. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonicalJson(x))).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

function hashFile(path: string): Sha256 {
  const h = createHash('sha256');
  const buf = Buffer.allocUnsafe(1 << 20);
  const fd = openSync(path, 'r');
  try {
    let n: number;
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return h.digest('hex');
}

function mustValidate<K extends Parameters<typeof validate>[0]>(kind: K, value: unknown) {
  const r = validate(kind, value);
  if (!r.ok) throw new Error(`invalid ${kind}: ${r.errors.map((e) => `${e.path || '/'} ${e.message}`).join('; ')}`);
  return r.value;
}

type Row = Record<string, any>;

/** Objects carrying a `locked` flag, keyed by containing field + id (or the field alone, e.g. `music`), as canonical JSON. */
function lockable(v: unknown, keep: (o: Row) => boolean, key = '', out = new Map<string, string>()): Map<string, string> {
  if (Array.isArray(v)) for (const x of v) lockable(x, keep, key, out);
  else if (v && typeof v === 'object') {
    const o = v as Row;
    if ('locked' in o && keep(o)) out.set(typeof o.id === 'string' ? `${key}/${o.id}` : key, canonicalJson(o));
    for (const k of Object.keys(o)) lockable(o[k], keep, key ? `${key}.${k}` : k, out);
  }
  return out;
}

export function createProject(root: string, name: string): ProjectStore {
  if (typeof name !== 'string' || name.trim() === '' || name.length > 200) throw new Error('project name must be 1-200 characters');
  mkdirSync(root, { recursive: true });
  if (existsSync(join(root, DB_FILE))) throw new Error('a project already exists at this root');
  const store = new ProjectStore(root);
  const t = now();
  store.db.prepare('INSERT INTO project (id, name, schema_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(randomUUID(), name, SCHEMA_VERSION, t, t);
  return store;
}

export function openProject(root: string): ProjectStore {
  if (!existsSync(join(root, DB_FILE))) throw new Error('no project at this root');
  const store = new ProjectStore(root);
  if (!store.db.prepare('SELECT 1 FROM project').get()) throw new Error('project row missing');
  return store;
}

export class ProjectStore {
  readonly root: string;
  readonly db: DatabaseSync;

  constructor(root: string) {
    this.root = root;
    this.db = new DatabaseSync(join(root, DB_FILE));
    try {
      this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;');
      this.migrate();
    } catch (e) {
      this.db.close();
      throw e;
    }
  }

  close(): void {
    this.db.close();
  }

  /** BEGIN IMMEDIATE takes the write lock up front, so read-check-write is atomic across connections and processes. */
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  private migrate(): void {
    this.tx(() => {
      this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
      const { v } = this.db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as Row;
      if (v > migrations.length) throw new Error(`project schema ${v} is newer than this app supports (${migrations.length})`);
      for (let i = v; i < migrations.length; i++) {
        this.db.exec(migrations[i]!);
        this.db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(i + 1, now());
      }
    });
  }

  private project(): Row {
    return this.db.prepare('SELECT * FROM project').get() as Row;
  }

  get projectId(): string {
    return this.project().id;
  }

  info(): { id: string; name: string; schemaVersion: string; revision: number; planHash: Sha256 | null; createdAt: string; updatedAt: string } {
    const p = this.project();
    return { id: p.id, name: p.name, schemaVersion: p.schema_version, revision: p.revision, planHash: p.plan_hash, createdAt: p.created_at, updatedAt: p.updated_at };
  }

  // ---------- events ----------

  /** Append-only audit log. Callers pass ids, revisions and counts, never transcripts, frames, prompts, paths or secrets. */
  appendEvent(type: string, data: unknown): void {
    this.db.prepare('INSERT INTO events (type, data, created_at) VALUES (?, ?, ?)').run(type, JSON.stringify(data ?? null), now());
  }

  listEvents(type?: string): StoreEvent[] {
    const rows = (type ? this.db.prepare('SELECT * FROM events WHERE type = ? ORDER BY seq').all(type) : this.db.prepare('SELECT * FROM events ORDER BY seq').all()) as Row[];
    return rows.map((r) => ({ seq: r.seq, type: r.type, data: JSON.parse(r.data), createdAt: r.created_at }));
  }

  recordProviderReceipt(receipt: ProviderReceipt): void {
    const r = mustValidate('provider-receipt', receipt);
    if (r.projectId !== this.projectId) throw new Error('receipt belongs to another project');
    this.appendEvent('provider_receipt', r);
  }

  // ---------- settings ----------

  getSetting<T = unknown>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }

  setSetting(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  }

  // ---------- assets ----------

  /** Records an asset whose file already sits under the project root. The manifest path stays relative. */
  importAsset(manifest: AssetManifest): AssetManifest {
    const m = mustValidate('asset-manifest', manifest);
    const abs = resolveUnderRoot(this.root, m.relativePath);
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`asset ${m.id}: file not found under project root`);
    this.tx(() => {
      this.db.prepare('INSERT INTO assets (id, kind, content_hash, relative_path, manifest, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(m.id, m.kind, m.contentHash, m.relativePath, JSON.stringify(m), now());
      this.appendEvent('asset_imported', { assetId: m.id, kind: m.kind });
    });
    return m;
  }

  getAsset(id: string): AssetManifest | undefined {
    const row = this.db.prepare('SELECT manifest FROM assets WHERE id = ?').get(id) as Row | undefined;
    return row ? JSON.parse(row.manifest) : undefined;
  }

  listAssets(): AssetManifest[] {
    return (this.db.prepare('SELECT manifest FROM assets ORDER BY created_at, id').all() as Row[]).map((r) => JSON.parse(r.manifest));
  }

  // ---------- transcripts cache ----------

  putTranscript(sourceHash: Sha256, configHash: Sha256, model: string, transcript: Transcript): void {
    const t = mustValidate('transcript', transcript);
    this.db.prepare('INSERT OR REPLACE INTO transcripts (source_hash, config_hash, model, transcript, created_at) VALUES (?, ?, ?, ?, ?)').run(sourceHash, configHash, model, JSON.stringify(t), now());
  }

  getTranscript(sourceHash: Sha256, configHash: Sha256, model: string): Transcript | undefined {
    const row = this.db.prepare('SELECT transcript FROM transcripts WHERE source_hash = ? AND config_hash = ? AND model = ?').get(sourceHash, configHash, model) as Row | undefined;
    return row ? JSON.parse(row.transcript) : undefined;
  }

  // ---------- brand profiles (F17) ----------

  /**
   * Stores one immutable brand version. Re-saving identical content is a no-op; different content under an
   * existing (id, version) throws, so a plan's `brands/<id>@<version>` always means the same profile.
   */
  putBrandProfile(profile: BrandProfile): BrandProfile {
    const b = mustValidate('brand-profile', profile);
    const json = canonicalJson(b);
    this.tx(() => {
      const row = this.db.prepare('SELECT json FROM brand_profiles WHERE id = ? AND version = ?').get(b.id, b.version) as Row | undefined;
      if (row && row.json !== json) throw new Error(`brand ${b.id} version ${b.version} already exists with other content`);
      if (!row) {
        this.db.prepare('INSERT INTO brand_profiles (id, version, json, created_at) VALUES (?, ?, ?, ?)').run(b.id, b.version, json, now());
        this.appendEvent('brand_saved', { brandId: b.id, version: b.version });
      }
    });
    return b;
  }

  /** A brand version, or the latest version when `version` is omitted. */
  getBrandProfile(id: string, version?: number): BrandProfile | undefined {
    const row = (version === undefined
      ? this.db.prepare('SELECT json FROM brand_profiles WHERE id = ? ORDER BY version DESC LIMIT 1').get(id)
      : this.db.prepare('SELECT json FROM brand_profiles WHERE id = ? AND version = ?').get(id, version)) as Row | undefined;
    return row ? JSON.parse(row.json) : undefined;
  }

  /** Latest version of each brand. */
  listBrandProfiles(): BrandProfile[] {
    const rows = this.db.prepare('SELECT json FROM brand_profiles b WHERE version = (SELECT MAX(version) FROM brand_profiles WHERE id = b.id) ORDER BY id').all() as Row[];
    return rows.map((r) => JSON.parse(r.json));
  }

  // ---------- plan revisions ----------

  currentRevision(): number {
    return this.project().revision;
  }

  getPlan(revision?: number): PlanSnapshot | undefined {
    const rev = revision ?? this.currentRevision();
    const row = this.db.prepare('SELECT revision, plan, plan_hash FROM plan_revisions WHERE revision = ?').get(rev) as Row | undefined;
    return row ? { revision: row.revision, planHash: row.plan_hash, plan: JSON.parse(row.plan) } : undefined;
  }

  listRevisions(): RevisionInfo[] {
    return (this.db.prepare('SELECT revision, plan_hash, author, op, parent, created_at FROM plan_revisions ORDER BY revision').all() as Row[]).map((r) => ({
      revision: r.revision, planHash: r.plan_hash, author: r.author, op: r.op, parent: r.parent, createdAt: r.created_at,
    }));
  }

  /** Compare-and-set: commits only if `baseRevision` is still current, else throws StaleRevisionError. */
  commitPlan(plan: EditPlan, baseRevision: number, author: Author): PlanSnapshot {
    const p = mustValidate('edit-plan', plan);
    return this.tx(() => {
      const head = this.checkBase(baseRevision);
      if (p.projectId !== this.projectId) throw new Error('plan belongs to another project');
      return this.writeRevision(p, author, 'commit', head || null, null);
    });
  }

  /** Undo is a new revision copying the plan before the head's change; history is never rewritten. */
  undo(author: Author, baseRevision?: number): PlanSnapshot {
    return this.tx(() => {
      const head = this.headRow(baseRevision);
      if (!head?.parent) throw new Error('nothing to undo');
      const target = this.revRow(head.parent);
      return this.writeRevision(JSON.parse(target.plan), author, 'undo', target.parent, head.revision);
    });
  }

  redo(author: Author, baseRevision?: number): PlanSnapshot {
    return this.tx(() => {
      const head = this.headRow(baseRevision);
      if (!head?.redo_target) throw new Error('nothing to redo');
      const target = this.revRow(head.redo_target);
      return this.writeRevision(JSON.parse(target.plan), author, 'redo', target.parent, target.redo_target);
    });
  }

  /** New revision copying `revision`'s plan; undoable back to the current head. */
  revertTo(revision: number, author: Author, baseRevision?: number): PlanSnapshot {
    return this.tx(() => {
      const head = this.headRow(baseRevision);
      const target = this.revRow(revision);
      return this.writeRevision(JSON.parse(target.plan), author, 'revert', head?.revision ?? null, null);
    });
  }

  private checkBase(baseRevision: number | undefined): number {
    const current = this.currentRevision();
    if (baseRevision !== undefined && baseRevision !== current) throw new StaleRevisionError(baseRevision, current);
    return current;
  }

  private headRow(baseRevision: number | undefined): Row | undefined {
    const current = this.checkBase(baseRevision);
    return current ? this.revRow(current) : undefined;
  }

  private revRow(revision: number): Row {
    const row = this.db.prepare('SELECT * FROM plan_revisions WHERE revision = ?').get(revision) as Row | undefined;
    if (!row) throw new Error(`no revision ${revision}`);
    return row;
  }

  private writeRevision(plan: EditPlan, author: Author, op: RevisionOp, parent: number | null, redoTarget: number | null): PlanSnapshot {
    if (author !== 'agent' && author !== 'user' && author !== 'system') throw new Error('author must be agent, user or system');
    if (author !== 'user') this.checkLocks(plan);
    const revision = this.currentRevision() + 1;
    const stored: EditPlan = { ...plan, revision };
    const json = canonicalJson(stored);
    const planHash = sha256(json);
    const t = now();
    this.db.prepare('INSERT INTO plan_revisions (revision, plan, plan_hash, author, op, parent, redo_target, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(revision, json, planHash, author, op, parent, redoTarget, t);
    this.db.prepare('UPDATE project SET revision = ?, plan_hash = ?, updated_at = ?').run(revision, planHash, t);
    this.appendEvent('plan_revision', { revision, op, author, planHash });
    return { revision, planHash, plan: stored };
  }

  /** Only a user edit may change, unlock or drop an object the head plan has locked. */
  private checkLocks(next: EditPlan): void {
    const head = this.getPlan();
    if (!head) return;
    const locked = lockable(head.plan, (o) => o.locked === true);
    const seen = lockable(next, () => true);
    for (const [key, json] of locked) if (seen.get(key) !== json) throw new Error(`locked object ${key} can only be changed by the user`);
  }

  // ---------- jobs ----------

  /** Idempotent by `idempotencyKey`: a repeated key returns the existing job unchanged. */
  createJob(request: CreateJobRequest, dependsOn: string[] = []): Job {
    const r = mustValidate('create-job-request', request);
    return this.tx(() => {
      const existing = this.db.prepare('SELECT id FROM jobs WHERE idempotency_key = ?').get(r.idempotencyKey) as Row | undefined;
      if (existing) return this.getJob(existing.id)!;
      for (const dep of dependsOn) if (!this.getJob(dep)) throw new Error(`unknown dependency job ${dep}`);
      if (r.baseRevision > this.currentRevision()) throw new Error(`base revision ${r.baseRevision} does not exist`);
      const id = randomUUID();
      const t = now();
      this.db.prepare('INSERT INTO jobs (id, idempotency_key, stage, profile, state, base_revision, depends_on, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, r.idempotencyKey, r.stage, r.profile, 'queued', r.baseRevision, JSON.stringify(dependsOn), t, t);
      this.appendEvent('job_created', { jobId: id, stage: r.stage });
      return this.getJob(id)!;
    });
  }

  getJob(id: string): Job | undefined {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Row | undefined;
    return row && this.toJob(row);
  }

  listJobs(state?: JobState): Job[] {
    const rows = (state ? this.db.prepare('SELECT * FROM jobs WHERE state = ? ORDER BY created_at, id').all(state) : this.db.prepare('SELECT * FROM jobs ORDER BY created_at, id').all()) as Row[];
    return rows.map((r) => this.toJob(r));
  }

  getCheckpoints(id: string): Checkpoint[] {
    return JSON.parse(this.jobRow(id).checkpoints);
  }

  /** Moves a job along a legal edge only. `failed` requires an error; `running` requires every dependency to have succeeded. */
  transitionJob(id: string, to: JobState, opts: { error?: ErrorInfo } = {}): Job {
    return this.tx(() => {
      const row = this.jobRow(id);
      if (!TRANSITIONS[row.state as JobState]?.includes(to)) throw new Error(`illegal job transition ${row.state} -> ${to}`);
      if (to === 'failed' && !opts.error) throw new Error('failed jobs need an error');
      if (to === 'running') {
        for (const dep of JSON.parse(row.depends_on) as string[]) {
          if (this.jobRow(dep).state !== 'succeeded') throw new Error(`dependency ${dep} has not succeeded`);
        }
      }
      const error = to === 'failed' ? JSON.stringify(opts.error) : to === 'queued' || to === 'running' ? null : row.error;
      this.db.prepare('UPDATE jobs SET state = ?, error = ?, attempts = attempts + ?, updated_at = ? WHERE id = ?').run(to, error, to === 'running' ? 1 : 0, now(), id);
      this.appendEvent('job_state', { jobId: id, from: row.state, to });
      return mustValidate('job', this.getJob(id));
    });
  }

  setJobProgress(id: string, progress: number | null): void {
    if (progress !== null && !(progress >= 0 && progress <= 1)) throw new Error('progress must be in [0,1] or null');
    this.runningRow(id);
    this.db.prepare('UPDATE jobs SET progress = ?, updated_at = ? WHERE id = ?').run(progress, now(), id);
  }

  /** Records a completed checkpoint file; the store hashes it, so the hash always describes bytes on disk. */
  addCheckpoint(id: string, name: string, ref: RelPath): Checkpoint {
    return this.tx(() => {
      const row = this.runningRow(id);
      const cp: Checkpoint = { name, ref, hash: this.hashComplete(ref) };
      const list = (JSON.parse(row.checkpoints) as Checkpoint[]).filter((c) => c.name !== name);
      list.push(cp);
      this.db.prepare('UPDATE jobs SET checkpoints = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(list), now(), id);
      return cp;
    });
  }

  /** Records a finished artifact (written with atomicWrite). Partial files are refused. */
  addArtifact(id: string, kind: string, ref: RelPath): { kind: string; ref: RelPath; hash: Sha256 } {
    return this.tx(() => {
      this.runningRow(id);
      const hash = this.hashComplete(ref);
      this.db.prepare('INSERT OR REPLACE INTO artifacts (job_id, kind, path, hash, created_at) VALUES (?, ?, ?, ?, ?)').run(id, kind, ref, hash, now());
      mustValidate('job', this.getJob(id));
      return { kind, ref, hash };
    });
  }

  /**
   * After a crash: each `running` job goes back to `queued` when it has checkpoints that all still
   * verify on disk, otherwise to `failed`. Artifacts whose file is missing or changed are dropped,
   * so a partial output is never reported as done.
   */
  recoverInterruptedJobs(): { requeued: string[]; failed: string[] } {
    return this.tx(() => {
      const out = { requeued: [] as string[], failed: [] as string[] };
      for (const row of this.db.prepare("SELECT * FROM jobs WHERE state = 'running'").all() as Row[]) {
        for (const a of this.db.prepare('SELECT path, hash FROM artifacts WHERE job_id = ?').all(row.id) as Row[]) {
          if (!this.verifies(a.path, a.hash)) this.db.prepare('DELETE FROM artifacts WHERE job_id = ? AND path = ?').run(row.id, a.path);
        }
        const cps = JSON.parse(row.checkpoints) as Checkpoint[];
        const resumable = cps.length > 0 && cps.every((c) => this.verifies(c.ref, c.hash));
        const to: JobState = resumable ? 'queued' : 'failed';
        const error: ErrorInfo | null = resumable ? null : { code: 'interrupted', message: 'The job stopped before it finished and has no usable checkpoint.', remedy: 'Run the stage again.' };
        this.db.prepare('UPDATE jobs SET state = ?, error = ?, checkpoints = ?, updated_at = ? WHERE id = ?').run(to, error && JSON.stringify(error), resumable ? row.checkpoints : '[]', now(), row.id);
        this.appendEvent('job_recovered', { jobId: row.id, to });
        (resumable ? out.requeued : out.failed).push(row.id);
      }
      return out;
    });
  }

  private jobRow(id: string): Row {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new Error(`no job ${id}`);
    return row;
  }

  private runningRow(id: string): Row {
    const row = this.jobRow(id);
    if (row.state !== 'running') throw new Error(`job ${id} is ${row.state}, not running`);
    return row;
  }

  private hashComplete(ref: RelPath): Sha256 {
    if (typeof ref !== 'string' || !REL_PATH.test(ref)) throw new Error('ref must be a portable project-relative path');
    if (ref.endsWith('.partial')) throw new Error('partial files cannot be recorded');
    const abs = resolveUnderRoot(this.root, ref);
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`file not found: ${ref}`);
    return hashFile(abs);
  }

  private verifies(ref: RelPath, hash: Sha256): boolean {
    try {
      return hashFile(resolveUnderRoot(this.root, ref)) === hash;
    } catch {
      return false;
    }
  }

  private toJob(r: Row): Job {
    const artifacts = (this.db.prepare('SELECT kind, path, hash FROM artifacts WHERE job_id = ? ORDER BY created_at, path').all(r.id) as Row[]).map((a) => ({ kind: a.kind, ref: a.path, hash: a.hash }));
    return {
      schemaVersion: SCHEMA_VERSION, id: r.id, projectId: this.projectId, stage: r.stage, profile: r.profile, state: r.state,
      progress: r.progress, baseRevision: r.base_revision, idempotencyKey: r.idempotency_key, attempts: r.attempts,
      createdAt: r.created_at, updatedAt: r.updated_at, error: r.error ? JSON.parse(r.error) : null, artifacts,
    };
  }
}
