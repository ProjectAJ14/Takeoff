// Workspace: the app-level view shared by the HTTP server, CLI and MCP server. It maps project ids to
// roots through a registry under appDataDir, opens each project once, and holds the operations the
// three surfaces share so they enforce the same authorization and revision rules.
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { validate, type Id, type Job, type Settings } from '@takeoff/contracts';
import { frameToUs, validatePlan } from '@takeoff/compiler';
import { extractFrame, hashFile } from '@takeoff/media';
import { atomicWrite } from '@takeoff/project-store';
import { LOCAL_ONLY } from './broker.ts';
import { engineCapabilities, type EngineCapabilities } from './capabilities.ts';
import { Engine, approvedPath, bundledFonts, installStarterPack, readLibrary, type EngineOptions, type LengthPolicy, type LibraryEntry } from './engine.ts';
import { EngineError } from './errors.ts';
import { Logger } from './log.ts';
import { workerTranscriber, type Transcriber } from './transcribe.ts';

export interface RegistryEntry {
  id: Id;
  name: string;
  root: string;
}
export interface EditDefaults {
  settings: Settings;
  targetSeconds: number | null;
  lengthPolicy: LengthPolicy;
}
export type FrameRequest = { clock: 'source'; assetId: Id; us: number } | { clock: 'output'; frame: number };

const EDIT_DEFAULTS = 'editDefaults';
const MAX_FRAMES = 16;
const TERMINAL = new Set<Job['state']>(['succeeded', 'failed', 'canceled']);
export const isTerminal = (j: Job) => TERMINAL.has(j.state);

const notFound = (what: string) => new EngineError('not_found', `${what} was not found`, 'Check the id and try again.');
export const badRequest = (message: string, remedy = 'Fix the request and try again.') => new EngineError('invalid_request', message, remedy);

/** Platform app-data folder (or TAKEOFF_APP_DATA). */
export function defaultAppDataDir(): string {
  if (process.env.TAKEOFF_APP_DATA) return resolve(process.env.TAKEOFF_APP_DATA);
  const home = process.env.HOME ?? '.';
  return process.platform === 'darwin' ? join(home, 'Library', 'Application Support', 'Takeoff') : join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'takeoff');
}

/** Full Settings check through the contracts schema (settings have no schema kind of their own). */
export function validateSettings(settings: unknown): Settings {
  const v = validate('create-project-request', { schemaVersion: '1.0', name: 'x', settings });
  if (!v.ok) throw new EngineError('invalid_settings', `settings are invalid (${v.errors.slice(0, 3).map((e) => e.path || '/').join(', ')})`, 'Set every toggle explicitly; see the edit-plan settings schema.');
  return v.value.settings!;
}

export class Workspace {
  readonly opts: EngineOptions;
  readonly appDataDir: string;
  /** Real paths. Project roots, imports and export destinations must resolve under one. */
  readonly approvedRoots: string[];
  readonly transcriber: Transcriber;
  readonly logger: Logger;
  readonly broker = { policy: () => LOCAL_ONLY };
  #engines = new Map<string, Engine>();

  constructor(opts: EngineOptions) {
    this.appDataDir = resolve(opts.appDataDir);
    mkdirSync(this.appDataDir, { recursive: true });
    this.approvedRoots = opts.approvedRoots.map((r) => realpathSync(r));
    this.transcriber = opts.transcriber ?? workerTranscriber();
    this.opts = { ...opts, appDataDir: this.appDataDir, transcriber: this.transcriber };
    this.logger = new Logger(join(this.appDataDir, 'logs'));
  }
  /** For engineCapabilities when no project is open: statfs runs on appDataDir. */
  get root(): string {
    return this.appDataDir;
  }
  fonts() {
    return bundledFonts();
  }
  library(): LibraryEntry[] {
    return readLibrary(this.appDataDir);
  }
  capabilities(): Promise<EngineCapabilities> {
    return engineCapabilities(this);
  }
  starterPack(opts: { allowNetwork: boolean; signal?: AbortSignal }) {
    return installStarterPack({ appDataDir: this.appDataDir, transcriber: this.transcriber, loadRenderer: this.opts.loadRenderer, logger: this.logger }, opts);
  }

  approved(p: string): string {
    return approvedPath(p, this.approvedRoots);
  }

  // ---------- registry ----------

  #registryFile() {
    return join(this.appDataDir, 'projects.json');
  }
  list(): RegistryEntry[] {
    try {
      return (JSON.parse(readFileSync(this.#registryFile(), 'utf8')) as { projects: RegistryEntry[] }).projects;
    } catch {
      return [];
    }
  }
  #register(e: Engine): void {
    const others = this.list().filter((p) => p.id !== e.projectId && p.root !== e.root);
    const projects = [...others, { id: e.projectId, name: e.store.info().name, root: e.root }];
    atomicWrite(this.#registryFile(), JSON.stringify({ schemaVersion: '1.0', projects }, null, 2));
  }

  // ---------- projects ----------

  create(root: string, name: string, defaults?: Partial<EditDefaults>): Engine {
    const real = this.approved(root);
    if (existsSync(join(real, 'project.db'))) throw new EngineError('project_exists', 'a project already exists in that folder', 'Open it instead, or choose an empty folder.');
    const e = Engine.create(real, { ...this.opts, name });
    this.#engines.set(e.root, e);
    if (defaults?.settings) setEditDefaults(e, defaults);
    this.#register(e);
    return e;
  }
  open(root: string): Engine {
    const real = this.approved(root);
    const cached = this.#engines.get(real);
    if (cached) return cached;
    if (!existsSync(join(real, 'project.db'))) throw new EngineError('not_a_project', 'that folder is not a Takeoff project', 'Run init on it first.');
    const e = Engine.open(real, this.opts);
    this.#engines.set(e.root, e);
    this.#register(e);
    return e;
  }
  /** Registry id → engine; the registered root is re-checked against the approved roots. */
  byId(id: string): Engine {
    const entry = this.list().find((p) => p.id === id);
    if (!entry) throw notFound('project');
    return this.open(entry.root);
  }
  findJob(jobId: string): { engine: Engine; job: Job } {
    // ponytail: scans every registered project; index job ids in the registry if project counts grow.
    for (const p of this.list()) {
      let e: Engine;
      try {
        e = this.open(p.root);
      } catch {
        continue; // moved or no longer approved
      }
      const job = e.getJob(jobId);
      if (job) return { engine: e, job };
    }
    throw notFound('job');
  }
  close(): void {
    for (const e of this.#engines.values()) e.close();
    this.#engines.clear();
  }
}

// ---------- shared operations ----------

export function editDefaults(e: Engine): EditDefaults | undefined {
  return e.store.getSetting<EditDefaults>(EDIT_DEFAULTS);
}
/** Merges toggles/target over the stored defaults; the merged settings must be complete and valid. */
export function setEditDefaults(e: Engine, o: { settings?: Partial<Settings>; targetSeconds?: number | null; lengthPolicy?: LengthPolicy }): EditDefaults {
  const prev = editDefaults(e);
  const settings = validateSettings({ ...prev?.settings, ...o.settings });
  const targetSeconds = o.targetSeconds !== undefined ? o.targetSeconds : (prev?.targetSeconds ?? null);
  if (targetSeconds !== null && !(Number.isInteger(targetSeconds) && targetSeconds >= 10 && targetSeconds <= 180)) throw new EngineError('invalid_settings', 'target length must be auto or 10–180 seconds', 'Pass --target auto or a whole number of seconds between 10 and 180.');
  if (o.lengthPolicy !== undefined && !['hard_max', 'soft_target', 'none'].includes(o.lengthPolicy)) throw new EngineError('invalid_settings', 'unknown length policy', 'Use hard_max or soft_target.');
  const lengthPolicy = o.lengthPolicy ?? (targetSeconds === null ? 'none' : (prev?.lengthPolicy && prev.lengthPolicy !== 'none' ? prev.lengthPolicy : 'soft_target'));
  const next = { settings, targetSeconds, lengthPolicy };
  e.store.setSetting(EDIT_DEFAULTS, next);
  return next;
}
export function requireEditDefaults(e: Engine): EditDefaults {
  const d = editDefaults(e);
  if (!d) throw new EngineError('settings_required', 'this project has no edit settings yet', 'Create the project with settings, or pass every toggle once.');
  return d;
}

/** Everything a UI or agent needs to show a project. */
export function snapshot(e: Engine) {
  const head = e.getPlan();
  const jobs = e.store.listJobs().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const ctx = e.planContext();
  return {
    schemaVersion: '1.0' as const,
    project: e.store.info(),
    assets: e.store.listAssets().map((m) => ({ ...m, pool: e.store.getSetting<{ pool: string }>(`asset:${m.id}`)?.pool ?? null })),
    transcripts: Object.values(ctx.transcripts).map((t) => ({ assetId: t.assetId, language: t.language, words: t.words, sentences: t.sentences })),
    plan: head ? { revision: head.revision, planHash: head.planHash, plan: head.plan } : null,
    revisions: e.store.listRevisions(),
    latestJob: jobs.at(-1) ?? null,
    artifacts: artifacts(e).map(({ abs: _a, ...x }) => x),
    editDefaults: editDefaults(e) ?? null,
  };
}

/** Files the media route may serve: recorded job artifacts, asset proxies and inspected frames. Id = sha256. */
export function artifacts(e: Engine): Array<{ id: string; kind: string; ref: string; abs: string; jobId?: string; assetId?: string }> {
  const out: Array<{ id: string; kind: string; ref: string; abs: string; jobId?: string; assetId?: string }> = [];
  const abs = (rel: string) => join(e.root, rel);
  for (const j of e.store.listJobs()) for (const a of j.artifacts) out.push({ id: a.hash, kind: a.kind, ref: a.ref, abs: abs(a.ref), jobId: j.id });
  for (const m of e.store.listAssets()) {
    const ref = `media/derived/${m.contentHash}/proxy.mp4`;
    if (m.derived.proxy) out.push({ id: m.derived.proxy, kind: 'proxy', ref, abs: abs(ref), assetId: m.id });
  }
  for (const [id, ref] of Object.entries(e.store.getSetting<Record<string, string>>('frames') ?? {})) out.push({ id, kind: 'frame', ref, abs: abs(ref) });
  return out;
}

const TYPES: Record<string, string> = { '.mp4': 'video/mp4', '.png': 'image/png', '.jpg': 'image/jpeg', '.wav': 'audio/wav', '.json': 'application/json', '.srt': 'text/plain', '.vtt': 'text/vtt' };
export function mediaFile(e: Engine, id: string): { abs: string; type: string } {
  if (!/^[0-9a-f]{64}$/.test(id)) throw badRequest('artifact ids are sha256 hex');
  const a = artifacts(e).find((x) => x.id === id);
  if (!a || !existsSync(a.abs)) throw notFound('artifact');
  return { abs: a.abs, type: TYPES[extname(a.abs)] ?? 'application/octet-stream' };
}

/** Bounded frame extraction: source frames from the original take, output frames from the head revision's draft render. */
export async function inspectFrames(e: Engine, body: unknown, signal?: AbortSignal) {
  const b = body as { schemaVersion?: unknown; frames?: unknown; width?: unknown };
  if (!b || typeof b !== 'object' || b.schemaVersion !== '1.0') throw badRequest('schemaVersion must be "1.0"');
  if (!Array.isArray(b.frames) || b.frames.length < 1 || b.frames.length > MAX_FRAMES) throw badRequest(`frames must hold 1–${MAX_FRAMES} requests`);
  const width = b.width === undefined ? 540 : b.width;
  if (!Number.isInteger(width) || (width as number) < 16 || (width as number) > 1920) throw badRequest('width must be an integer 16–1920');
  const int = (x: unknown) => Number.isSafeInteger(x) && (x as number) >= 0;
  const head = e.getPlan();
  const out: Array<{ request: FrameRequest; artifactId: string; ref: string }> = [];
  const frames = { ...(e.store.getSetting<Record<string, string>>('frames') ?? {}) };
  for (const r of b.frames as FrameRequest[]) {
    let src: string;
    let us: number;
    let key: string;
    if (r?.clock === 'source' && typeof r.assetId === 'string' && int(r.us)) {
      const m = e.store.getAsset(r.assetId);
      if (!m) throw notFound('asset');
      if (r.us >= (m.probe.durationUs ?? 0)) throw badRequest('source time is past the end of the asset');
      src = join(e.root, m.relativePath);
      us = r.us;
      key = `source-${m.id}-${us}`;
    } else if (r?.clock === 'output' && int(r.frame)) {
      if (!head) throw new EngineError('no_plan', 'the project has no plan yet', 'Run Edit Video first.');
      const render = artifacts(e).filter((a) => a.kind === 'render_draft' && a.ref.endsWith(`-r${head.revision}.mp4`)).at(-1);
      if (!render) throw new EngineError('no_render', 'the current revision has not been rendered', 'Render a draft first.');
      const fps = head.plan.output.fps;
      // Middle of the frame's half-open interval, so container rounding never lands on the neighbour.
      us = Math.floor((frameToUs(r.frame, fps) + frameToUs(r.frame + 1, fps)) / 2);
      src = render.abs;
      key = `output-r${head.revision}-${r.frame}`;
    } else throw badRequest('each frame is {clock:"source", assetId, us} or {clock:"output", frame} with non-negative integers');
    const ref = `cache/frames/${key}-w${width}.png`;
    const abs = join(e.root, ref);
    if (!existsSync(abs)) {
      await mkdir(dirname(abs), { recursive: true });
      await extractFrame(src, us, abs, { width: width as number, signal });
    }
    const id = await hashFile(abs);
    frames[id] = ref;
    out.push({ request: r, artifactId: id, ref });
  }
  e.store.setSetting('frames', frames);
  return { schemaVersion: '1.0' as const, revision: head?.revision ?? null, frames: out };
}

/** Schema check always; semantic checks (assets, words, bounds) only with a project's transcripts and manifests. */
export function checkPlan(plan: unknown, e?: Engine) {
  const v = validate('edit-plan', plan);
  if (!v.ok) return { ok: false, schemaErrors: v.errors, errors: [], warnings: [], semantic: 'skipped' as const };
  if (!e) return { ok: true, schemaErrors: [], errors: [], warnings: [], semantic: 'skipped' as const };
  const r = validatePlan(plan, e.planContext());
  return { ok: r.errors.length === 0, schemaErrors: [], errors: r.errors, warnings: r.warnings, semantic: 'run' as const };
}

/** Starts a job in the background and returns it as soon as the store has it. */
export function startJob(e: Engine, idempotencyKey: string, run: () => Promise<unknown>): Job {
  run().catch(() => undefined); // the job row records the outcome
  const job = e.store.listJobs().find((j) => j.idempotencyKey === idempotencyKey);
  if (!job) throw new EngineError('internal', 'the job was not created', 'Retry.');
  return job;
}
