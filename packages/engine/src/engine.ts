// Engine: the local job coordinator (PRD §7.2, §8, §13). It owns jobs, state, validation, files and
// permissions; the director only proposes plans, the renderer only renders validated compiled plans.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  validate,
  type AssetManifest,
  type BrandProfile,
  type CompiledTimeline,
  type DirectorRequest,
  type EditPlan,
  type ErrorInfo,
  type ExportManifest,
  type Id,
  type Job,
  type JobStage,
  type OutputSpec,
  type PlanAssetRef,
  type PlanPatch,
  type QAReport,
  type Settings,
  type Transcript,
  type Warning,
} from '@takeoff/contracts';
import { COMPILER_VERSION, PatchError, applyPatch, compile, validatePlan, type PlanContext } from '@takeoff/compiler';
import {
  ExternalDirector,
  OllamaDirector,
  PROMPT_VERSION,
  RulesDirector,
  buildPlan,
  detectCandidates,
  directPlan,
  type DirectorAdapter,
  type DirectorContext,
  type SpeechInterval,
} from '@takeoff/director';
import { diskPreflight as mediaDiskPreflight, hashFile, ingest, type DiskPreflight } from '@takeoff/media';
import { atomicWrite, canonicalJson, createProject, openProject, resolveUnderRoot, StaleRevisionError, type PlanSnapshot, type ProjectStore } from '@takeoff/project-store';
import type { RenderArtifact, Renderer, ResolvedAsset, ResolvedFont } from '@takeoff/renderer-api';
import { ProviderBroker, type KeyLookup } from './broker.ts';
import { EngineError, isAbort, toErrorInfo } from './errors.ts';
import { toCaptionJson, toSrt, toVtt, writeStems } from './export.ts';
import { Logger, redact } from './log.ts';
import { hasCritical, runQa, type OverlayReport } from './qa.ts';
import { validateAsrConfig, workerTranscriber, type AsrConfig, type Transcriber } from './transcribe.ts';
import { engineCapabilities, type EngineCapabilities } from './capabilities.ts';

export const ENGINE_VERSION = '0.1.0';
export const IMPORTER = `takeoff-engine-${ENGINE_VERSION}`;

export type Pool = 'takes' | 'broll' | 'music' | 'sfx';
export type DirectorChoice = 'rules' | { kind: 'ollama'; model: string; port?: number; timeoutMs?: number } | { kind: 'external'; provider: string; model: string };
export type LengthPolicy = OutputSpec['lengthPolicy'];

export interface LibraryEntry {
  id: string;
  kind: 'music' | 'sfx';
  /** Absolute, or relative to the library directory. */
  path: string;
  category?: string;
  license: string;
}
/** What `@takeoff/renderer-browser` must export. Loaded lazily by `loadBrowserRenderer`, injectable for tests. */
export interface RendererModule {
  createRenderer(): Renderer | Promise<Renderer>;
  generateLibraryAudio?(outDir: string): Promise<LibraryEntry[]>;
}
/** A renderer may attach its overlay measurements to the artifact; absent = those QA checks are not_run. */
export type RenderResult = RenderArtifact & { overlayReport?: OverlayReport };

export interface EngineOptions {
  /** App-level data: logs, model/library pointers, credential index (never secrets). */
  appDataDir: string;
  /** Directories the user authorised through a picker; imports and exports must resolve under one. */
  approvedRoots: string[];
  transcriber?: Transcriber;
  loadRenderer?: () => Promise<RendererModule>;
  fetch?: typeof fetch;
  getKey?: KeyLookup;
  diskPreflight?: (root: string, bytes: number) => Promise<DiskPreflight>;
  asr?: Partial<AsrConfig>;
  director?: DirectorChoice;
}

export interface PipelineOptions {
  settings: Settings;
  /** null = automatic length. Integer seconds 10–180. */
  targetSeconds: number | null;
  lengthPolicy: LengthPolicy;
  brandProfileId?: string;
  /** Creative brief. Kept in the job snapshot; the DirectorRequest DTO has no field for it yet. */
  brief?: string;
  idempotencyKey: string;
  baseRevision: number;
  director?: DirectorChoice;
}
export interface PipelineResult {
  job: Job;
  error: ErrorInfo | null;
  revision: number | null;
  qa: QAReport | null;
  warnings: Warning[];
}
export interface ExportOptions {
  profile: 'final_1080' | 'draft_720';
  destinationDir: string;
  burnCaptions: boolean;
  idempotencyKey?: string;
}
export interface ExportResult extends PipelineResult {
  manifest: ExportManifest | null;
  /** Absolute folder the export was written to; null unless the export succeeded. */
  dir: string | null;
}
export interface ImportItemResult {
  index: number;
  assetId?: Id;
  pool?: Pool;
  reused?: boolean;
  error?: ErrorInfo;
}

/** The slice of `@takeoff/renderer-browser` the engine uses (structural: the package is loaded lazily). */
interface BrowserModule {
  BrowserRenderer: new () => Renderer;
  generateLibraryAudio(outDir: string): Promise<{ items: Array<{ id: string; file: string; kind: 'music' | 'sfx'; category: string; license: string }> }>;
}
type BrowserOverlay = { captionBounds: Array<{ captionId: string; rect: { x: number; y: number; w: number; h: number } }>; violations: Array<{ code: string; ref: string }> };

/** Browser renderer overlay measurements in the engine's QA shape. */
export function overlayFromBrowser(o: BrowserOverlay): OverlayReport {
  const v = o.violations;
  return {
    captions: o.captionBounds.map((b) => ({ captionId: b.captionId, rect: b.rect })),
    captionFailures: v.filter((x) => x.code === 'caption_overflow').map((x) => ({ captionId: x.ref, code: x.code })),
    visualFailures: v.filter((x) => x.code.startsWith('scene_')).map((x) => ({ visualId: x.ref, code: x.code })),
    undeclaredRequests: v.filter((x) => x.code === 'undeclared_network').length,
    missingFonts: v.filter((x) => x.code === 'font_missing').length,
  };
}

const RENDERER_BROWSER = '@takeoff/renderer-browser';
/** The single place the browser renderer is loaded; lazy so the engine runs (and tests run) without Chromium. */
export async function loadBrowserRenderer(specifier = RENDERER_BROWSER): Promise<RendererModule> {
  let mod: BrowserModule;
  try {
    mod = (await import(specifier)) as BrowserModule;
  } catch {
    throw new EngineError('renderer_unavailable', 'the browser renderer is not installed', 'Install the app components, then retry.');
  }
  return {
    createRenderer() {
      const r = new mod.BrowserRenderer();
      return {
        id: r.id,
        async render(input, opts) {
          const a = (await r.render(input, opts)) as RenderArtifact & { overlay?: BrowserOverlay };
          return { ...a, overlayReport: a.overlay ? overlayFromBrowser(a.overlay) : undefined } as RenderResult;
        },
      };
    },
    async generateLibraryAudio(outDir) {
      return (await mod.generateLibraryAudio(outDir)).items.map((i) => ({ id: i.id, kind: i.kind, path: i.file, category: i.category, license: i.license }));
    },
  };
}

const OUTPUT_BASE = { width: 1080, height: 1920, fps: { num: 30, den: 1 }, audioSampleRate: 48000 as const, colorSpace: 'bt709' as const };
const DRAFT_BYTES_PER_SEC = 2 * (4_000_000 / 8); // render + temp at ~4 Mb/s
const STAGES: JobStage[] = ['Prepare', 'Transcribe', 'Clean speech', 'Plan visuals/audio', 'Build graphics', 'Render preview', 'Check quality'];
const SLUG: Record<JobStage, string> = {
  Prepare: 'prepare', Transcribe: 'transcribe', 'Clean speech': 'clean_speech', 'Plan visuals/audio': 'plan',
  'Build graphics': 'build_graphics', 'Render preview': 'render_preview', 'Check quality': 'check_quality', Export: 'export',
};
const WAIT_CODES = new Set(['model_missing']);
const MAX_REPAIRS_PER_GROUP = 3;
const MAX_REPAIR_ROUNDS = 6;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const VERSIONS = { engine: ENGINE_VERSION, compiler: COMPILER_VERSION, prompt: PROMPT_VERSION };

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const now = () => new Date().toISOString();

interface AssetMeta {
  pool: Pool;
  startUs: number;
  hdr: boolean;
}
interface TranscriptKey {
  sourceHash: string;
  configHash: string;
  model: string;
}
/** Mutable state of one job run; each stage's output slice is its checkpoint. */
interface RunState {
  jobId: string;
  opts: Record<string, any>;
  signal: AbortSignal;
  warnings: Warning[];
  takes?: Id[];
  transcriptKeys?: Record<Id, TranscriptKey>;
  noSpeech?: Id[];
  request?: DirectorRequest;
  dctx?: DirectorContext;
  revision?: number;
  compiledRef?: string;
  render?: { ref: string; width: number; height: number; overlay: OverlayReport | null; profile: 'draft' | 'final' };
  qaRef?: string;
  qa?: QAReport;
  exportDir?: string;
  manifest?: ExportManifest;
}

/** Prefix word/sentence ids with the asset id so several takes never share a word id (worker ids restart at w0001). */
function namespaced(t: Transcript): Transcript {
  const p = (id: string) => (id.startsWith(`${t.assetId}.`) ? id : `${t.assetId}.${id}`);
  return {
    ...t,
    words: t.words.map((w) => ({ ...w, id: p(w.id) })),
    sentences: t.sentences.map((s) => ({ ...s, id: p(s.id), startWordId: p(s.startWordId), endWordId: p(s.endWordId) })),
  };
}

/** Copies every locked object of `prev` into `next` unchanged: regeneration never overwrites a lock. */
export function mergeLocks(next: EditPlan, prev: EditPlan | undefined): EditPlan {
  if (!prev) return next;
  const out = structuredClone(next);
  const put = <T extends { id: Id; locked?: boolean }>(dst: T[], src: T[]) => {
    for (const o of src) {
      if (o.locked !== true) continue;
      const i = dst.findIndex((x) => x.id === o.id);
      // ponytail: a locked object the new plan dropped is appended; segment order is then the lock's, not chronology.
      if (i >= 0) dst[i] = o;
      else dst.push(o);
    }
  };
  put(out.decisions, prev.decisions);
  put(out.segments, prev.segments);
  put(out.captions, prev.captions);
  put(out.visuals, prev.visuals);
  put(out.transforms, prev.transforms);
  put(out.audio.sfx, prev.audio.sfx);
  if (prev.audio.music?.locked) out.audio.music = prev.audio.music;
  return out;
}

const notApproved = () => new EngineError('path_not_approved', 'that location is outside the folders you approved', 'Choose the file or folder with the picker so Takeoff may use it.');

/** Absolute real path of `p` if it lies under one of `realRoots` (already realpath'd); symlinks resolved on the existing prefix. */
export function approvedPath(p: string, realRoots: readonly string[]): string {
  if (typeof p !== 'string' || !p || p.includes('\0')) throw notApproved();
  const abs = resolve(p);
  let probe = abs;
  while (!lstatSync(probe, { throwIfNoEntry: false })) probe = dirname(probe);
  let real: string;
  try {
    real = realpathSync(probe);
  } catch {
    throw notApproved();
  }
  const inside = realRoots.some((r) => {
    const back = relative(r, real);
    return back === '' || (!back.startsWith('..' + sep) && back !== '..' && !isAbsolute(back));
  });
  if (!inside) throw notApproved();
  return resolve(real, relative(probe, abs));
}

/** The installed music/SFX library index under `appDataDir`, [] when the starter pack is not installed. */
export function readLibrary(appDataDir: string): LibraryEntry[] {
  try {
    return JSON.parse(readFileSync(join(appDataDir, 'library', 'library.json'), 'utf8')).entries as LibraryEntry[];
  } catch {
    return [];
  }
}

let fontsCache: ResolvedFont[] | undefined;
/** Bundled caption/UI fonts from @fontsource packages (no network). Missing files are left out. */
export function bundledFonts(): ResolvedFont[] {
  if (fontsCache) return fontsCache;
  const req = createRequire(import.meta.url);
  const files: Array<[string, string, string]> = [
    ['Inter', '@fontsource/inter', 'inter-latin-400-normal.woff2'],
    ['Inter', '@fontsource/inter', 'inter-latin-700-normal.woff2'],
    ['Archivo', '@fontsource/archivo', 'archivo-latin-700-normal.woff2'],
    ['JetBrains Mono', '@fontsource/jetbrains-mono', 'jetbrains-mono-latin-400-normal.woff2'],
  ];
  const out: ResolvedFont[] = [];
  for (const [family, pkg, file] of files) {
    try {
      const path = join(dirname(req.resolve(`${pkg}/LICENSE`)), 'files', file);
      out.push({ family, path, hash: sha256File(path) });
    } catch {
      // missing font: capabilities reports it; the renderer falls back
    }
  }
  return (fontsCache = out);
}

/** Explicit user action only: downloads the base ASR model (unless cached) and generates the local music/SFX library. App-level, not per project. */
export async function installStarterPack(
  deps: { appDataDir: string; transcriber: Transcriber; loadRenderer?: () => Promise<RendererModule>; logger: Logger },
  opts: { allowNetwork: boolean; signal?: AbortSignal },
): Promise<{ model: string; library: LibraryEntry[]; licenses: Array<{ item: string; license: string }> }> {
  // The network grant covers only the model download; a cached model makes the pack fully offline.
  const cached = (await deps.transcriber.probe()).models.includes('base');
  if (!cached && opts.allowNetwork !== true) throw new EngineError('network_denied', 'the starter pack needs a one-time download', 'Confirm the download to continue.');
  if (!cached) await deps.transcriber.downloadModel('base', opts.signal);
  const mod = await (deps.loadRenderer ?? loadBrowserRenderer)();
  if (!mod.generateLibraryAudio) throw new EngineError('renderer_unavailable', 'this renderer cannot generate the audio library', 'Update the app components.');
  const dir = join(deps.appDataDir, 'library');
  await mkdir(dir, { recursive: true });
  const entries: LibraryEntry[] = [];
  for (const e of await mod.generateLibraryAudio(dir)) {
    const rel = relative(dir, resolve(dir, e.path));
    if (!ID.test(e.id) || (e.kind !== 'music' && e.kind !== 'sfx') || rel.startsWith('..') || isAbsolute(rel) || !existsSync(join(dir, rel))) continue;
    entries.push({ id: e.id, kind: e.kind, path: rel.split(sep).join('/'), category: e.category, license: String(e.license).slice(0, 100) });
  }
  await writeFile(join(dir, 'library.json'), JSON.stringify({ schemaVersion: '1.0', entries }, null, 2));
  const licenses = [
    { item: 'Whisper base model weights (via faster-whisper)', license: 'MIT' },
    ...[...new Set(entries.map((e) => e.license))].map((license) => ({ item: 'Takeoff generated music/SFX library', license })),
  ];
  deps.logger.log('starter_pack', { counts: { library: entries.length } });
  return { model: 'base', library: entries, licenses };
}

/** Store history errors (plain Errors) as typed engine errors. */
function history<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof StaleRevisionError || !(e instanceof Error) || e.name !== 'Error') throw e;
    if (e.message === 'nothing to undo') throw new EngineError('nothing_to_undo', 'there is no earlier change to undo', 'Make an edit first.');
    if (e.message === 'nothing to redo') throw new EngineError('nothing_to_redo', 'there is no undone change to redo', 'Undo a change first.');
    if (e.message.startsWith('no revision')) throw new EngineError('revision_not_found', 'that revision does not exist', 'Pick a revision from the history.');
    throw e;
  }
}

const issuesToValidation = (r: { errors: Warning[] }) => r.errors.map((e) => ({ path: '', message: `${e.code}: ${e.message}` }));

export class Engine {
  readonly root: string;
  readonly store: ProjectStore;
  readonly appDataDir: string;
  readonly approvedRoots: string[];
  readonly logger: Logger;
  readonly broker: ProviderBroker;
  readonly transcriber: Transcriber;
  readonly opts: EngineOptions;
  #controllers = new Map<string, AbortController>();
  #running = new Map<string, Promise<PipelineResult>>();
  #ingests = new Map<string, Promise<{ assetId: Id; reused: boolean }>>();
  #heavy: Promise<unknown> = Promise.resolve();
  #rendererP: Promise<Renderer> | undefined;

  private constructor(store: ProjectStore, opts: EngineOptions) {
    this.store = store;
    this.root = realpathSync(store.root);
    this.opts = opts;
    this.appDataDir = resolve(opts.appDataDir);
    this.approvedRoots = opts.approvedRoots.map((r) => realpathSync(r));
    this.logger = new Logger(join(this.appDataDir, 'logs'));
    this.broker = new ProviderBroker(store, { fetch: opts.fetch, getKey: opts.getKey });
    this.transcriber = opts.transcriber ?? workerTranscriber();
  }

  static create(projectRoot: string, opts: EngineOptions & { name: string }): Engine {
    return new Engine(createProject(projectRoot, opts.name), opts);
  }
  static open(projectRoot: string, opts: EngineOptions): Engine {
    return new Engine(openProject(projectRoot), opts);
  }
  close(): void {
    for (const c of this.#controllers.values()) c.abort();
    this.store.close();
  }

  get projectId(): string {
    return this.store.projectId;
  }

  // ---------- paths ----------

  /** Absolute real path of `p` if it lies under an approved root (symlinks resolved on the existing prefix). */
  approvedPath(p: string): string {
    return approvedPath(p, this.approvedRoots);
  }
  #abs(rel: string): string {
    return resolveUnderRoot(this.root, rel);
  }
  async #writeRel(rel: string, data: string | Uint8Array): Promise<void> {
    const abs = this.#abs(rel);
    await mkdir(dirname(abs), { recursive: true });
    atomicWrite(abs, data);
  }

  // ---------- capabilities, brand ----------

  capabilities(): Promise<EngineCapabilities> {
    return engineCapabilities(this);
  }

  /** Locate the bundled library index, if the starter pack installed one. */
  library(): LibraryEntry[] {
    return readLibrary(this.appDataDir);
  }

  /** Brand profiles are versioned files; a plan references one version, so later edits never change old renders. */
  async saveBrandProfile(profile: BrandProfile): Promise<string> {
    const v = validate('brand-profile', profile);
    if (!v.ok) throw new EngineError('invalid_brand', 'the brand profile does not match the schema', 'Fix the highlighted fields and save again.');
    const rel = `brands/${v.value.id}-v${v.value.version}.json`;
    await this.#writeRel(rel, JSON.stringify(v.value, null, 2));
    this.store.setSetting(`brand:${v.value.id}`, rel);
    return rel;
  }
  #brandRef(id: string | undefined): string | null {
    if (!id) return null;
    const rel = this.store.getSetting<string>(`brand:${id}`);
    if (!rel) throw new EngineError('brand_not_found', 'that brand profile does not exist in this project', 'Create the brand profile first, or run without one.');
    return rel;
  }
  #brand(rel: string | null): BrandProfile | null {
    return rel ? (JSON.parse(readFileSync(this.#abs(rel), 'utf8')) as BrandProfile) : null;
  }

  // ---------- import ----------

  /** Imports each path independently: a bad file yields its own error and never blocks the others. */
  async importAssets(paths: string[], opts: { pool: Pool; signal?: AbortSignal }): Promise<ImportItemResult[]> {
    if (!['takes', 'broll', 'music', 'sfx'].includes(opts.pool)) throw new EngineError('invalid_pool', 'unknown asset pool', 'Use takes, broll or music.');
    const out: ImportItemResult[] = [];
    // ponytail: one file at a time keeps FFmpeg load bounded; parallelise once a resource budget exists.
    for (const [index, p] of paths.entries()) {
      try {
        const r = await this.#importOne(this.approvedPath(p), opts.pool, { origin: 'user', license: null }, opts.signal);
        out.push({ index, assetId: r.assetId, pool: this.#meta(r.assetId)?.pool ?? opts.pool, reused: r.reused });
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        out.push({ index, error: toErrorInfo(e) });
      }
    }
    this.logger.log('import', { projectId: this.projectId, counts: { files: paths.length, failed: out.filter((r) => r.error).length } });
    return out;
  }

  async #importOne(real: string, pool: Pool, rights: { origin: 'user' | 'generated'; license: string | null }, signal?: AbortSignal): Promise<{ assetId: Id; reused: boolean }> {
    const st = await stat(real).catch(() => null);
    if (!st?.isFile()) throw new EngineError('not_found', 'the file is missing or is not a regular file', 'Choose the file again.');
    const hash = await hashFile(real);
    const existing = this.store.listAssets().find((m) => m.contentHash === hash);
    if (existing) return { assetId: existing.id, reused: true };
    // Serialised per content hash: two imports of the same bytes share one ingest.
    const inflight = this.#ingests.get(hash);
    if (inflight) return inflight;
    const p = (async () => {
      const r = await ingest(real, this.root, { signal });
      const kind = r.probe.kind;
      const fit = pool === 'takes' ? kind !== 'image' : pool === 'broll' ? kind !== 'audio' : !!r.probe.audio;
      if (!fit) throw new EngineError('wrong_pool', `a ${kind} file cannot be used as ${pool}`, pool === 'takes' ? 'Add images to the B-roll pool.' : 'Choose a file with the right kind of media.');
      const id = `a_${r.contentHash.slice(0, 16)}`;
      const manifest: AssetManifest = {
        schemaVersion: '1.0',
        id,
        kind,
        contentHash: r.contentHash,
        relativePath: r.relativePath,
        probe: { durationUs: r.probe.durationUs, video: r.probe.video, audio: r.probe.audio },
        derived: { proxy: r.derived.proxy?.sha256 ?? null, analysisWav: r.derived.analysisWav?.sha256 ?? null },
        rights: { origin: rights.origin, license: rights.license, attribution: null, sourceUrl: null },
        provenance: { importedAt: now(), importer: IMPORTER },
        permissionScope: this.broker.policy().networkPolicy,
      };
      this.store.importAsset(manifest);
      await this.#writeRel(`assets/${id}.json`, JSON.stringify(manifest, null, 2));
      this.store.setSetting(`asset:${id}`, { pool, startUs: r.probe.startUs, hdr: r.probe.hdr } satisfies AssetMeta);
      return { assetId: id, reused: false };
    })();
    this.#ingests.set(hash, p);
    try {
      return await p;
    } finally {
      this.#ingests.delete(hash);
    }
  }

  #meta(id: Id): AssetMeta | undefined {
    return this.store.getSetting<AssetMeta>(`asset:${id}`);
  }
  #pool(pool: Pool): AssetManifest[] {
    return this.store.listAssets().filter((m) => this.#meta(m.id)?.pool === pool);
  }

  /** First library track of a kind, imported into the project (engine-owned path, so no picker approval is needed). */
  async #libraryAsset(kind: 'music' | 'sfx', signal: AbortSignal): Promise<Id | undefined> {
    const own = this.#pool(kind)[0];
    if (own) return own.id;
    const e = this.library().find((x) => x.kind === kind);
    if (!e) return undefined;
    const lib = join(this.appDataDir, 'library');
    const p = resolve(lib, e.path);
    if (relative(lib, p).startsWith('..')) return undefined;
    return (await this.#importOne(p, kind, { origin: 'generated', license: e.license }, signal)).assetId;
  }

  // ---------- plan context ----------

  /** Transcripts and manifests for compiler validation, from the store's transcript cache. */
  planContext(): PlanContext {
    const keys = this.store.getSetting<Record<Id, TranscriptKey>>('transcriptKeys') ?? {};
    const transcripts: Record<Id, Transcript> = {};
    for (const [assetId, k] of Object.entries(keys)) {
      const t = this.store.getTranscript(k.sourceHash, k.configHash, k.model);
      if (t) transcripts[assetId] = t;
    }
    return { transcripts, manifests: Object.fromEntries(this.store.listAssets().map((m) => [m.id, m])) };
  }

  // ---------- plan edits ----------

  getPlan(): PlanSnapshot | undefined {
    return this.store.getPlan();
  }

  /** Applies a typed patch as a user edit. A stale baseRevision throws StaleRevisionError (HTTP 409). */
  applyPatch(patch: PlanPatch): PlanSnapshot {
    const v = validate('patch', patch);
    if (!v.ok) throw new EngineError('invalid_patch', 'the patch does not match the schema', 'Send only allowlisted operations.');
    const head = this.store.getPlan();
    if (!head) throw new EngineError('no_plan', 'the project has no plan yet', 'Run Edit Video first.');
    if (v.value.baseRevision !== head.revision) throw new StaleRevisionError(v.value.baseRevision, head.revision);
    let next: EditPlan;
    try {
      next = applyPatch(head.plan, v.value, this.planContext());
    } catch (e) {
      if (e instanceof PatchError) {
        if (e.code === 'stale_revision') throw new StaleRevisionError(v.value.baseRevision, head.revision);
        throw new EngineError(e.code, e.message, e.code === 'locked_object' ? 'Unlock the object first.' : 'Reload the plan and try the edit again.');
      }
      throw e;
    }
    const snap = this.store.commitPlan(next, v.value.baseRevision, 'user');
    this.logger.log('patch', { projectId: this.projectId, revision: snap.revision, counts: { ops: v.value.ops.length } });
    return snap;
  }
  undo(baseRevision?: number): PlanSnapshot {
    return history(() => this.store.undo('user', baseRevision));
  }
  redo(baseRevision?: number): PlanSnapshot {
    return history(() => this.store.redo('user', baseRevision));
  }
  revert(revision: number, baseRevision?: number): PlanSnapshot {
    return history(() => this.store.revertTo(revision, 'user', baseRevision));
  }

  /** Re-renders the head plan as a draft and re-checks it. ponytail: re-renders the whole timeline; per-segment invalidation when renders get slow. */
  renderAffected(idempotencyKey?: string): Promise<PipelineResult> {
    const head = this.store.getPlan();
    if (!head) throw new EngineError('no_plan', 'the project has no plan yet', 'Run Edit Video first.');
    const job = this.#createJob({ schemaVersion: '1.0', stage: 'Build graphics', profile: 'draft', baseRevision: head.revision, idempotencyKey: idempotencyKey ?? `render-${head.revision}-${head.planHash.slice(0, 16)}` });
    return this.#start(job, ['Build graphics', 'Render preview', 'Check quality'], { revision: head.revision });
  }

  // ---------- jobs ----------

  getJob(id: string): Job | undefined {
    return this.store.getJob(id);
  }

  /** Cooperative cancel: the job is `canceled` as soon as the running stage is abandoned; checkpoints stay. */
  cancel(jobId: string): boolean {
    const c = this.#controllers.get(jobId);
    if (c) {
      c.abort(new DOMException('canceled', 'AbortError'));
      // Acknowledge now: the abandoned stage commits nothing (it checks the signal), so the state can say so at once.
      if (this.store.getJob(jobId)?.state === 'running') this.store.transitionJob(jobId, 'canceled');
      return true;
    }
    const job = this.store.getJob(jobId);
    if (job && (job.state === 'queued' || job.state === 'waiting_for_user')) {
      this.store.transitionJob(jobId, 'canceled');
      return true;
    }
    return false;
  }

  runPipeline(opts: PipelineOptions): Promise<PipelineResult> {
    const t = opts.targetSeconds;
    if (t !== null && !(Number.isInteger(t) && t >= 10 && t <= 180)) throw new EngineError('invalid_settings', 'target length must be Auto or 10–180 seconds', 'Choose Auto or a length between 10 and 180 seconds.');
    if (!['hard_max', 'soft_target', 'none'].includes(opts.lengthPolicy)) throw new EngineError('invalid_settings', 'unknown length policy', 'Use hard_max, soft_target or none.');
    const brandProfileRef = this.#brandRef(opts.brandProfileId);
    const job = this.#createJob({ schemaVersion: '1.0', stage: 'Prepare', profile: 'draft', baseRevision: opts.baseRevision, idempotencyKey: opts.idempotencyKey });
    const { idempotencyKey: _k, ...snapshot } = opts;
    return this.#start(job, STAGES, { ...snapshot, brandProfileRef });
  }

  /** Prepare + Transcribe only (MCP/CLI `transcribe`). Same job, idempotency and cache rules as runPipeline. */
  transcribe(opts: { idempotencyKey: string; brandProfileId?: string }): Promise<PipelineResult> {
    const brandProfileRef = this.#brandRef(opts.brandProfileId);
    const job = this.#createJob({ schemaVersion: '1.0', stage: 'Transcribe', profile: 'draft', baseRevision: this.store.currentRevision(), idempotencyKey: opts.idempotencyKey });
    return this.#start(job, ['Prepare', 'Transcribe'], { brandProfileRef });
  }

  exportProject(opts: ExportOptions): Promise<ExportResult> {
    if (opts.profile !== 'final_1080' && opts.profile !== 'draft_720') throw new EngineError('invalid_profile', 'unknown export profile', 'Use final_1080 or draft_720.');
    const dest = this.approvedPath(opts.destinationDir); // before any work: never render for a destination we may not write
    const head = this.store.getPlan();
    if (!head) throw new EngineError('no_plan', 'the project has no plan yet', 'Run Edit Video first.');
    const profile = opts.profile === 'final_1080' ? 'final' : 'draft';
    const job = this.#createJob({ schemaVersion: '1.0', stage: 'Export', profile, baseRevision: head.revision, idempotencyKey: opts.idempotencyKey ?? randomUUID() });
    return this.#start(job, ['Export'], { revision: head.revision, dest, burnCaptions: opts.burnCaptions === true, profile }) as Promise<ExportResult>;
  }

  #createJob(req: Parameters<ProjectStore['createJob']>[0]): Job {
    const v = validate('create-job-request', req);
    if (!v.ok) throw new EngineError('invalid_request', `job request is invalid (${v.errors.map((e) => e.path || '/').join(', ')})`, 'Use an idempotency key of 8–128 letters, digits, _ or -.');
    return this.store.createJob(v.value);
  }

  #start(job: Job, stages: JobStage[], opts: Record<string, any>): Promise<PipelineResult> {
    const inflight = this.#running.get(job.id);
    if (inflight) return inflight;
    if (job.state !== 'queued' && job.state !== 'waiting_for_user') return Promise.resolve(this.#resultOf(job, null));
    const p = this.#execute(job.id, stages, opts).finally(() => this.#running.delete(job.id));
    this.#running.set(job.id, p);
    return p;
  }

  #resultOf(job: Job, st: RunState | null, error: ErrorInfo | null = job.error): PipelineResult & Partial<ExportResult> {
    if (!st) {
      // A finished job: rebuild what it produced from its checkpoints.
      st = { jobId: job.id, opts: {}, signal: AbortSignal.abort(), warnings: [] };
      for (const cp of this.store.getCheckpoints(job.id)) {
        try {
          Object.assign(st, JSON.parse(readFileSync(this.#abs(cp.ref), 'utf8')).data);
        } catch {
          // unreadable checkpoint: report without it
        }
      }
      if (job.state === 'waiting_for_user') {
        const ev = this.store.listEvents('job_waiting').map((e) => e.data as { jobId: string; error: ErrorInfo }).filter((d) => d.jobId === job.id).at(-1);
        error = ev?.error ?? null;
      }
      if (st.qaRef && !st.qa) st.qa = JSON.parse(readFileSync(this.#abs(st.qaRef), 'utf8'));
    }
    return {
      job,
      error,
      revision: st.revision ?? null,
      qa: st.qa ?? null,
      warnings: st.warnings,
      manifest: st.manifest ?? null,
      dir: job.state === 'succeeded' ? (st.exportDir ?? null) : null,
    };
  }

  #setStage(jobId: string, stage: JobStage): void {
    // ponytail: ProjectStore has no setJobStage; written here with a typed constant. Move into the store with its next migration.
    this.store.db.prepare("UPDATE jobs SET stage = ?, progress = NULL, updated_at = ? WHERE id = ? AND state = 'running'").run(stage, now(), jobId);
  }
  #progress(jobId: string, p: number | null): void {
    try {
      this.store.setJobProgress(jobId, p === null ? null : Math.min(1, Math.max(0, p)));
    } catch {
      // job no longer running (canceled): ignore late progress
    }
  }
  /** Serialises model and render work (PRD §12: combinations over the RAM budget run one at a time). */
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#heavy.then(fn, fn);
    this.#heavy = run.catch(() => undefined);
    return run;
  }

  async #execute(jobId: string, stages: JobStage[], input: Record<string, any>): Promise<PipelineResult> {
    const ac = new AbortController();
    this.#controllers.set(jobId, ac);
    const aborted = new Promise<never>((_, rej) => ac.signal.addEventListener('abort', () => rej(ac.signal.reason), { once: true }));
    aborted.catch(() => undefined);
    const st: RunState = { jobId, opts: input, signal: ac.signal, warnings: [] };
    let error: ErrorInfo | null = null;
    try {
      this.store.transitionJob(jobId, 'running');
      st.opts = await this.#snapshot(jobId, input);
      Object.assign(st, { revision: st.opts.revision });
      let prevKey = '';
      for (const stage of stages) {
        ac.signal.throwIfAborted();
        this.#setStage(jobId, stage);
        const key = sha(canonicalJson({ stage, opts: st.opts, versions: VERSIONS, takes: (st.takes ?? []).map((id) => this.store.getAsset(id)?.contentHash), prevKey }));
        prevKey = key;
        const resumed = this.#loadCheckpoint(jobId, stage, key);
        const t0 = Date.now();
        let slice: Partial<RunState>;
        if (resumed) slice = resumed;
        else {
          const work = this.#stage(stage, st);
          work.catch(() => undefined); // abandoned on cancel; its late failure is not an error
          slice = await Promise.race([work, aborted]);
          ac.signal.throwIfAborted();
          const rel = `jobs/${jobId}/${SLUG[stage]}.json`;
          await this.#writeRel(rel, JSON.stringify({ cacheKey: key, data: slice }));
          this.store.addCheckpoint(jobId, SLUG[stage], rel);
        }
        Object.assign(st, slice);
        this.logger.log('stage', { projectId: this.projectId, jobId, stage, durationMs: Date.now() - t0, cacheHit: !!resumed });
      }
      if (st.qa && hasCritical(st.qa)) {
        throw new EngineError('qa_critical', `${st.qa.issues.filter((i) => i.severity === 'critical').length} critical quality issue(s) remain`, 'Open the QA report, fix or undo the flagged objects, and render again.');
      }
      this.store.transitionJob(jobId, 'succeeded');
    } catch (e) {
      const job = this.store.getJob(jobId)!;
      if (ac.signal.aborted || isAbort(e)) {
        if (job.state === 'running' || job.state === 'queued') this.store.transitionJob(jobId, 'canceled');
      } else {
        error = toErrorInfo(e);
        if (WAIT_CODES.has(error.code)) {
          this.store.transitionJob(jobId, 'waiting_for_user');
          this.store.appendEvent('job_waiting', { jobId, error });
        } else if (job.state === 'running') this.store.transitionJob(jobId, 'failed', { error });
      }
      this.logger.log('job_end', { projectId: this.projectId, jobId, state: this.store.getJob(jobId)!.state, code: error?.code ?? null });
    } finally {
      this.#controllers.delete(jobId);
    }
    return this.#resultOf(this.store.getJob(jobId)!, st, error);
  }

  /** The job's immutable input: written once, re-read on resume so a later call cannot change it. */
  async #snapshot(jobId: string, input: Record<string, any>): Promise<Record<string, any>> {
    const cp = this.store.getCheckpoints(jobId).find((c) => c.name === 'request');
    if (cp) return JSON.parse(await readFile(this.#abs(cp.ref), 'utf8'));
    const rel = `jobs/${jobId}/request.json`;
    await this.#writeRel(rel, JSON.stringify(input));
    this.store.addCheckpoint(jobId, 'request', rel);
    return input;
  }

  #loadCheckpoint(jobId: string, stage: JobStage, key: string): Partial<RunState> | null {
    const cp = this.store.getCheckpoints(jobId).find((c) => c.name === SLUG[stage]);
    if (!cp) return null;
    try {
      const j = JSON.parse(readFileSync(this.#abs(cp.ref), 'utf8')) as { cacheKey: string; data: Partial<RunState> };
      return j.cacheKey === key ? j.data : null;
    } catch {
      return null;
    }
  }

  #stage(stage: JobStage, st: RunState): Promise<Partial<RunState>> {
    switch (stage) {
      case 'Prepare': return this.#prepare(st);
      case 'Transcribe': return this.#transcribe(st);
      case 'Clean speech': return this.#cleanSpeech(st);
      case 'Plan visuals/audio': return this.#plan(st);
      case 'Build graphics': return this.#buildGraphics(st);
      case 'Render preview': return this.#renderPreview(st);
      case 'Check quality': return this.#checkQuality(st);
      case 'Export': return this.#export(st);
    }
  }

  // ---------- stages ----------

  async #prepare(st: RunState): Promise<Partial<RunState>> {
    const takes = this.#pool('takes');
    if (!takes.length) throw new EngineError('no_takes', 'there is no footage in the takes pool', 'Add at least one recording as a take.');
    await this.#preflight(takes.reduce((s, m) => s + (m.probe.durationUs ?? 0) / 1e6, 0));
    return { takes: takes.map((m) => m.id) };
  }

  /** PRD §12: estimated render + temp bytes with 20% headroom, checked before work starts. */
  async #preflight(seconds: number, bytesPerSec = DRAFT_BYTES_PER_SEC): Promise<void> {
    const pf = await (this.opts.diskPreflight ?? mediaDiskPreflight)(this.root, Math.ceil(seconds * bytesPerSec));
    if (!pf.ok) throw new EngineError('disk_full', `rendering needs about ${pf.requiredBytes} bytes free (with 20% headroom); ${pf.availableBytes} are available`, 'Free disk space or purge the project cache, then run again; completed stages are kept.');
  }

  #asrConfig(st: RunState): AsrConfig {
    const glossary = this.#brand(st.opts.brandProfileRef ?? null)?.glossary ?? [];
    return validateAsrConfig({ model: this.opts.asr?.model ?? 'base', language: this.opts.asr?.language ?? 'en', glossary: this.opts.asr?.glossary ?? glossary });
  }

  async #transcribe(st: RunState): Promise<Partial<RunState>> {
    const cfg = this.#asrConfig(st);
    const configHash = await this.transcriber.configHash(cfg);
    const transcriptKeys: Record<Id, TranscriptKey> = {};
    const noSpeech: Id[] = [];
    const takes = st.takes!.map((id) => this.store.getAsset(id)!).filter((m) => m.probe.audio);
    let hits = 0;
    for (const [i, m] of takes.entries()) {
      st.signal.throwIfAborted();
      const key = { sourceHash: m.contentHash, configHash, model: cfg.model };
      const silentKey = `nospeech:${m.contentHash}:${configHash}`;
      if (this.store.getTranscript(m.contentHash, configHash, cfg.model)) {
        hits++;
        transcriptKeys[m.id] = key;
      } else if (this.store.getSetting(silentKey)) {
        hits++;
        noSpeech.push(m.id);
      } else {
        const outRel = `cache/transcripts/${m.contentHash}-${configHash.slice(0, 16)}.json`;
        await mkdir(dirname(this.#abs(outRel)), { recursive: true });
        try {
          const r = await this.#serial(() => {
            st.signal.throwIfAborted();
            return this.transcriber.transcribe({
              audioPath: this.#abs(`media/derived/${m.contentHash}/analysis.wav`),
              outPath: this.#abs(outRel),
              assetId: m.id,
              sourceHash: m.contentHash,
              config: cfg,
              signal: st.signal,
              onProgress: (f) => this.#progress(st.jobId, (i + f) / takes.length),
            });
          });
          st.signal.throwIfAborted();
          const t = namespaced({ ...r.transcript, assetId: m.id, sourceHash: m.contentHash });
          this.store.putTranscript(m.contentHash, configHash, cfg.model, t);
          this.store.setSetting(`speech:${m.contentHash}:${configHash}`, r.speech.map((s) => ({ ...s, assetId: m.id })));
          transcriptKeys[m.id] = key;
        } catch (e) {
          if ((e as { code?: string }).code !== 'no_speech') throw e;
          this.store.setSetting(silentKey, true);
          noSpeech.push(m.id);
        }
      }
      this.#progress(st.jobId, (i + 1) / takes.length);
    }
    this.store.setSetting('transcriptKeys', { ...(this.store.getSetting<Record<Id, TranscriptKey>>('transcriptKeys') ?? {}), ...transcriptKeys });
    this.logger.log('transcribe', { projectId: this.projectId, jobId: st.jobId, cacheHit: hits === takes.length, counts: { takes: takes.length, cached: hits, noSpeech: noSpeech.length } });
    return { transcriptKeys, noSpeech };
  }

  async #cleanSpeech(st: RunState): Promise<Partial<RunState>> {
    const o = st.opts;
    const settings: Settings = { ...(o.settings as Settings), targetSeconds: o.targetSeconds };
    const takes = st.takes!.map((id) => this.store.getAsset(id)!);
    const words: DirectorRequest['words'] = [];
    const speech: SpeechInterval[] = [];
    for (const m of takes) {
      const k = st.transcriptKeys?.[m.id];
      const t = k && this.store.getTranscript(k.sourceHash, k.configHash, k.model);
      if (!t) continue;
      for (const w of t.words) words.push({ id: w.id, assetId: m.id, text: w.correctedText ?? w.text, sourceStartUs: w.sourceStartUs, sourceEndUs: w.sourceEndUs, alignment: w.alignment });
      speech.push(...(this.store.getSetting<SpeechInterval[]>(`speech:${k.sourceHash}:${k.configHash}`) ?? []));
    }
    const durationsUs = Object.fromEntries(takes.map((m) => [m.id, m.probe.durationUs ?? 0]));
    const brand = this.#brand(o.brandProfileRef ?? null);
    const policy = o.targetSeconds === null ? 'none' : (o.lengthPolicy as LengthPolicy);
    const request: DirectorRequest = {
      schemaVersion: '1.0',
      projectId: this.projectId,
      revision: o.baseRevision,
      output: { ...OUTPUT_BASE, targetFrames: policy === 'none' ? null : o.targetSeconds * OUTPUT_BASE.fps.num, lengthPolicy: policy },
      settings,
      words,
      // The speech-only assembly: deterministic candidates first, so visual work uses stable timing.
      candidates: words.length ? detectCandidates(words, { fillerStrength: settings.fillerStrength, speech, durationsUs }) : [],
      brand: brand && { name: brand.name, hookTone: brand.hookTone, motionIntensity: brand.motionIntensity, glossary: brand.glossary, prohibitedClaims: brand.prohibitedClaims },
    };
    const v = validate('director-request', request);
    if (!v.ok) throw new EngineError('invalid_settings', `settings are invalid (${v.errors.slice(0, 3).map((e) => e.path || '/').join(', ')})`, 'Fix the highlighted settings and run again.');
    const musicAssetId = settings.music ? await this.#libraryAsset('music', st.signal) : undefined;
    const sfxAssetId = settings.sfx ? await this.#libraryAsset('sfx', st.signal) : undefined;
    const ref = (id: Id): PlanAssetRef => ({ id, kind: this.store.getAsset(id)!.kind, manifestRef: `assets/${id}.json` });
    const wordAssets = [...new Set(words.map((w) => w.assetId))];
    const assets = [...(words.length ? wordAssets : takes.filter((m) => m.kind === 'video').map((m) => m.id)), ...[musicAssetId, sfxAssetId].filter((x): x is Id => !!x)].map(ref);
    const dctx: DirectorContext = { seed: 0, speech, durationsUs, assets, musicAssetId, sfxAssetId };
    return { request, dctx };
  }

  #adapters(st: RunState): DirectorAdapter[] {
    const choice: DirectorChoice = st.opts.director ?? this.opts.director ?? 'rules';
    if (choice === 'rules') return [new RulesDirector()];
    if (choice.kind === 'ollama') return [new OllamaDirector({ model: choice.model, port: choice.port, timeoutMs: choice.timeoutMs }), new RulesDirector()];
    const send = (body: unknown) => this.broker.send(choice.provider, 'transcript', 'edit plan proposal', body, { jobId: st.jobId });
    return [new ExternalDirector({ provider: choice.provider, model: choice.model, send }), new RulesDirector()];
  }

  async #plan(st: RunState): Promise<Partial<RunState>> {
    const req = st.request!;
    const ctx = this.planContext();
    const validator = (p: EditPlan) => issuesToValidation(validatePlan(p, ctx));
    let plan: EditPlan;
    let fallbackCount = 0;
    if (!req.words.length) {
      // No speech: no semantic cleanup, no invented story. A manual, visual-only draft with a review marker.
      plan = buildPlan(req, st.dctx);
      plan.segments = st.dctx!.assets!.filter((a) => a.kind === 'video' && st.takes!.includes(a.id)).map((a) => ({
        id: `seg_${a.id}`, assetId: a.id, sourceStartUs: 0, sourceEndUs: this.store.getAsset(a.id)!.probe.durationUs ?? 0,
        wordIds: [], speed: { num: 1, den: 1 }, cropPolicy: 'face_safe_vertical', locked: false,
      }));
      if (!plan.segments.length) throw new EngineError('no_usable_media', 'no speech was found and there is no video to show', 'Add a take with speech or video.');
      plan.reviewMarkers.push({ id: 'marker_no_speech', kind: 'alignment_uncertain', severity: 'warning', message: 'No speech was detected, so speech cleanup was skipped. This is a manual, visual-only draft.', refs: plan.segments.map((s) => s.id) });
    } else {
      const r = await directPlan(req, this.#adapters(st), validator, st.dctx);
      plan = r.plan;
      fallbackCount = r.fallback ? 1 : 0;
      if (r.errors.length) throw new EngineError('invalid_plan', `the edit plan failed validation (${r.errors.length} issue(s))`, 'Adjust settings or restore spans, then run again.');
    }
    if (st.noSpeech?.length && req.words.length) st.warnings.push({ code: 'no_speech', message: `${st.noSpeech.length} take(s) had no speech and were left out`, refs: st.noSpeech });
    plan.brandProfileRef = st.opts.brandProfileRef ?? null;
    const head = this.store.getPlan();
    plan = mergeLocks(plan, head?.plan);
    const report = validatePlan(plan, ctx);
    if (report.errors.length) {
      throw new EngineError('lock_conflict', `locked objects no longer fit the regenerated plan (${report.errors.map((e) => e.code).slice(0, 3).join(', ')})`, 'Unlock the conflicting objects or restore their spans, then run again.');
    }
    st.signal.throwIfAborted();
    const snap = this.store.commitPlan(plan, req.revision, 'system');
    this.logger.log('plan', { projectId: this.projectId, jobId: st.jobId, revision: snap.revision, fallbackCount, counts: { warnings: report.warnings.length } });
    return { revision: snap.revision };
  }

  #compiledFor(revision: number, burnCaptions = true): { plan: EditPlan; compiled: CompiledTimeline } {
    const snap = this.store.getPlan(revision);
    if (!snap) throw new EngineError('no_plan', `revision ${revision} does not exist`, 'Reload the project.');
    const plan = burnCaptions ? snap.plan : { ...snap.plan, captions: [] };
    try {
      return { plan, compiled: compile(plan, this.planContext()) };
    } catch (e) {
      const codes = ((e as { issues?: Warning[] }).issues ?? []).map((i) => i.code).slice(0, 3).join(', ');
      throw new EngineError('invalid_plan', `the plan does not compile (${codes || 'error'})`, 'Undo the last change or restore the flagged spans.');
    }
  }

  async #buildGraphics(st: RunState): Promise<Partial<RunState>> {
    const { compiled } = this.#compiledFor(st.revision!);
    const compiledRef = `jobs/${st.jobId}/compiled-r${st.revision}.json`;
    await this.#writeRel(compiledRef, JSON.stringify(compiled));
    return { compiledRef };
  }

  #renderer(): Promise<Renderer> {
    this.#rendererP ??= (this.opts.loadRenderer ?? loadBrowserRenderer)().then((m) => m.createRenderer());
    this.#rendererP.catch(() => (this.#rendererP = undefined));
    return this.#rendererP;
  }

  fonts(): ResolvedFont[] {
    return bundledFonts();
  }

  /** Renders `revision` to a project-relative path and records it as a job artifact. */
  async #renderTo(st: RunState, revision: number, rel: string, profile: 'draft' | 'final', kind: string, burnCaptions = true): Promise<NonNullable<RunState['render']>> {
    const { plan, compiled } = this.#compiledFor(revision, burnCaptions);
    const assets: Record<Id, ResolvedAsset & { proxyPath?: string }> = {};
    for (const a of plan.assets) {
      const m = this.store.getAsset(a.id);
      if (!m) throw new EngineError('asset_missing', `asset ${a.id} is not in the project`, 'Relink or re-import the asset.');
      const proxy = `media/derived/${m.contentHash}/proxy.mp4`;
      assets[a.id] = { path: this.#abs(m.relativePath), hash: m.contentHash, manifest: m, ...(m.derived.proxy && existsSync(this.#abs(proxy)) && { proxyPath: this.#abs(proxy) }) };
    }
    const outPath = this.#abs(rel);
    await mkdir(dirname(outPath), { recursive: true });
    const renderer = await this.#renderer();
    const t0 = Date.now();
    const art = (await this.#serial(() => {
      st.signal.throwIfAborted();
      return renderer.render(
        { compiled, plan, assets, fonts: this.fonts(), brand: this.#brand(plan.brandProfileRef), seed: plan.provenance.seed, versions: { ...VERSIONS, renderer: renderer.id } },
        { outPath, profile, signal: st.signal, onProgress: (p) => this.#progress(st.jobId, p.totalFrames ? p.frame / p.totalFrames : null) },
      );
    })) as RenderResult;
    st.signal.throwIfAborted();
    if (resolve(art.path) !== outPath || !existsSync(outPath)) throw new EngineError('render_failed', 'the renderer did not write the requested file', 'Retry the render.');
    this.store.addArtifact(st.jobId, kind, rel);
    const secs = (Date.now() - t0) / 1000;
    this.logger.log('render', { projectId: this.projectId, jobId: st.jobId, durationMs: Date.now() - t0, fps: secs > 0 ? Math.round(compiled.totalFrames / secs) : null });
    return { ref: rel, width: art.width, height: art.height, overlay: art.overlayReport ?? null, profile };
  }

  async #renderPreview(st: RunState): Promise<Partial<RunState>> {
    return { render: await this.#renderTo(st, st.revision!, `renders/${st.jobId}/draft-r${st.revision}.mp4`, 'draft', 'render_draft') };
  }

  async #qa(st: RunState, revision: number, render: NonNullable<RunState['render']>, framesRel: string, burnCaptions = true): Promise<{ report: QAReport; qaRef: string }> {
    const { plan, compiled } = this.#compiledFor(revision, burnCaptions);
    const { report } = await runQa({ renderPath: this.#abs(render.ref), compiled, plan, width: render.width, height: render.height, overlay: render.overlay, framesDir: this.#abs(framesRel), signal: st.signal });
    const v = validate('qa-report', report);
    if (!v.ok) throw new EngineError('internal', 'the QA report is malformed', 'Report this with a diagnostic bundle.');
    const qaRef = `${dirname(render.ref)}/qa-r${revision}.json`;
    await this.#writeRel(qaRef, JSON.stringify(report, null, 2));
    this.store.addArtifact(st.jobId, 'qa_report', qaRef);
    return { report, qaRef };
  }

  /** QA, then bounded repair: ≤3 attempts per issue group via allowlisted patches that respect locks. */
  async #checkQuality(st: RunState): Promise<Partial<RunState>> {
    let revision = st.revision!;
    let render = st.render!;
    let { report, qaRef } = await this.#qa(st, revision, render, `${dirname(render.ref)}/frames-r${revision}`);
    const tries = new Map<string, number>();
    for (let round = 0; round < MAX_REPAIR_ROUNDS; round++) {
      const fixes = report.issues.filter((i) => i.suggestedPatch && (tries.get(`${i.check}:${i.objectRef}`) ?? 0) < MAX_REPAIRS_PER_GROUP);
      if (!fixes.length) break;
      for (const i of fixes) tries.set(`${i.check}:${i.objectRef}`, (tries.get(`${i.check}:${i.objectRef}`) ?? 0) + 1);
      const ops = [...new Map(fixes.flatMap((i) => i.suggestedPatch!.ops).map((op) => [canonicalJson(op), op])).values()];
      const head = this.store.getPlan(revision)!;
      let next: EditPlan;
      try {
        next = applyPatch(head.plan, { schemaVersion: '1.0', baseRevision: revision, ops }, this.planContext());
      } catch {
        break; // locked or no longer applicable: leave the issue for review
      }
      st.signal.throwIfAborted();
      revision = this.store.commitPlan(next, revision, 'system').revision;
      render = await this.#renderTo(st, revision, `renders/${st.jobId}/draft-r${revision}.mp4`, 'draft', 'render_draft');
      ({ report, qaRef } = await this.#qa(st, revision, render, `${dirname(render.ref)}/frames-r${revision}`));
      this.logger.log('repair', { projectId: this.projectId, jobId: st.jobId, retryCount: round + 1, revision });
    }
    const { compiled } = this.#compiledFor(revision);
    const warnings = [
      ...compiled.warnings,
      ...report.issues.filter((i) => i.severity !== 'critical').map((i) => ({ code: i.check, message: i.evidence, refs: i.objectRef ? [i.objectRef] : [] })),
    ];
    st.warnings.push(...warnings);
    this.logger.log('qa', { projectId: this.projectId, jobId: st.jobId, qaOutcome: hasCritical(report) ? 'critical' : warnings.length ? 'warnings' : 'clean', counts: { issues: report.issues.length } });
    return { revision, render, qa: report, qaRef };
  }

  async #export(st: RunState): Promise<Partial<RunState>> {
    const { revision, dest, burnCaptions, profile } = st.opts as { revision: number; dest: string; burnCaptions: boolean; profile: 'draft' | 'final' };
    const base = `exports/${st.jobId}`;
    const pre = this.#compiledFor(revision, burnCaptions).compiled;
    // Final video + stems + bundle, roughly 3x the draft budget.
    await this.#preflight((pre.totalFrames * pre.fps.den) / pre.fps.num, 3 * DRAFT_BYTES_PER_SEC);
    const render = await this.#renderTo(st, revision, `${base}/video.mp4`, profile, profile === 'final' ? 'render_final' : 'render_draft', burnCaptions);
    const { report, qaRef } = await this.#qa(st, revision, render, `${base}/frames`, burnCaptions);
    // Full QA gates the export: nothing is written to the destination when a critical issue remains.
    if (hasCritical(report)) return { qa: report, qaRef };

    const { plan, compiled } = this.#compiledFor(revision);
    const ctx = this.planContext();
    const transcripts = Object.fromEntries(Object.entries(ctx.transcripts).filter(([id]) => plan.assets.some((a) => a.id === id)));
    const name = `takeoff-r${revision}-${st.jobId.slice(0, 8)}`;
    const finalDir = join(dest, name);
    const work = `${finalDir}.partial`;
    await rm(work, { recursive: true, force: true });
    await mkdir(join(work, 'stems'), { recursive: true });
    await mkdir(join(work, 'bundle', 'transcripts'), { recursive: true });
    await mkdir(join(work, 'bundle', 'assets'), { recursive: true });
    try {
      await copyFile(this.#abs(render.ref), join(work, 'video.mp4'));
      const sidecars: Array<[string, string]> = compiled.captions.length
        ? [['captions.srt', toSrt(compiled, plan)], ['captions.vtt', toVtt(compiled, plan)], ['captions.json', toCaptionJson(compiled, plan, transcripts)]]
        : [];
      for (const [f, text] of sidecars) {
        await writeFile(join(work, f), text);
        await writeFile(join(work, 'bundle', f), text);
      }
      await writeStems(compiled, (id) => {
        const m = this.store.getAsset(id);
        if (!m) throw new EngineError('asset_missing', `asset ${id} is not in the project`, 'Relink or re-import the asset.');
        return { wav: this.#abs(`media/derived/${m.contentHash}/master.wav`), startUs: this.#meta(id)?.startUs ?? 0 };
      }, join(work, 'stems'), st.signal);

      // Project bundle: plan, transcripts, manifests (project-relative paths only), captions, QA. No originals, no keys.
      await writeFile(join(work, 'bundle', 'plan.json'), JSON.stringify(plan, null, 2));
      for (const [id, t] of Object.entries(transcripts)) await writeFile(join(work, 'bundle', 'transcripts', `${id}.json`), JSON.stringify(t, null, 2));
      for (const a of plan.assets) await writeFile(join(work, 'bundle', 'assets', `${a.id}.json`), JSON.stringify(this.store.getAsset(a.id), null, 2));
      await writeFile(join(work, 'bundle', 'qa-report.json'), JSON.stringify(report, null, 2));
      const bundleFiles = (await readdir(join(work, 'bundle'), { recursive: true })).map(String).filter((f) => !f.endsWith('bundle.json')).sort();
      const index = [];
      for (const f of bundleFiles) {
        const p = join(work, 'bundle', f);
        if (statSync(p).isFile()) index.push({ path: f.split(sep).join('/'), sha256: await hashFile(p) });
      }
      await writeFile(join(work, 'bundle', 'bundle.json'), JSON.stringify({ schemaVersion: '1.0', projectId: this.projectId, revision, files: index }, null, 2));

      const out = async (kind: ExportManifest['outputs'][number]['kind'], rel: string) => ({ kind, relativePath: rel, sha256: await hashFile(join(work, rel)), bytes: statSync(join(work, rel)).size });
      const outputs = [await out('video', 'video.mp4')];
      if (sidecars.length) outputs.push(await out('srt', 'captions.srt'), await out('vtt', 'captions.vtt'), await out('caption_json', 'captions.json'));
      outputs.push(await out('project_bundle', 'bundle/bundle.json'));
      for (const s of ['dialogue', 'music', 'sfx']) outputs.push(await out('stem', `stems/${s}.wav`));
      const manifest: ExportManifest = {
        schemaVersion: '1.0',
        id: randomUUID(),
        projectId: this.projectId,
        revision,
        planHash: compiled.planHash,
        createdAt: now(),
        preset: { id: profile === 'final' ? 'final_1080' : 'draft_720', version: 1, width: render.width, height: render.height, fps: compiled.fps, container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', colorSpace: 'bt709', burnCaptions },
        durationFrames: compiled.totalFrames,
        outputs,
        checks: report.checks,
        unresolvedWarnings: [...compiled.warnings, ...report.issues.map((i) => ({ code: i.check, message: i.evidence, refs: i.objectRef ? [i.objectRef] : [] }))],
      };
      const v = validate('export-manifest', manifest);
      if (!v.ok) throw new EngineError('internal', 'the export manifest is malformed', 'Report this with a diagnostic bundle.');
      const json = JSON.stringify(manifest, null, 2);
      await writeFile(join(work, 'export-manifest.json'), json);
      await writeFile(join(work, 'bundle', 'export-manifest.json'), json);
      st.signal.throwIfAborted();
      await rm(finalDir, { recursive: true, force: true });
      await rename(work, finalDir);
      await this.#writeRel(`${base}/export-manifest.json`, json);
      this.store.addArtifact(st.jobId, 'export_manifest', `${base}/export-manifest.json`);
      this.logger.log('export', { projectId: this.projectId, jobId: st.jobId, counts: { outputs: outputs.length } });
      return { qa: report, qaRef, manifest, exportDir: finalDir };
    } catch (e) {
      await rm(work, { recursive: true, force: true });
      throw e;
    }
  }

  // ---------- recovery, starter pack, diagnostics ----------

  /** After a crash: requeue/fail interrupted jobs (store re-verifies checkpoints) and delete every partial file. */
  async recover(): Promise<{ requeued: string[]; failed: string[]; removedPartials: number }> {
    const r = this.store.recoverInterruptedJobs();
    let removedPartials = 0;
    for (const f of await readdir(this.root, { recursive: true })) {
      const name = String(f);
      if (!/\.partial(\.|$)/.test(name.split(sep).pop() ?? '')) continue;
      await rm(join(this.root, name), { recursive: true, force: true });
      removedPartials++;
    }
    this.logger.log('recover', { projectId: this.projectId, counts: { requeued: r.requeued.length, failed: r.failed.length, removedPartials } });
    return { ...r, removedPartials };
  }

  /** Explicit user action only: downloads the base ASR model and generates the local music/SFX library. */
  installStarterPack(opts: { allowNetwork: boolean; signal?: AbortSignal }): ReturnType<typeof installStarterPack> {
    return installStarterPack({ appDataDir: this.appDataDir, transcriber: this.transcriber, loadRenderer: this.opts.loadRenderer, logger: this.logger }, opts);
  }

  /** Versions, capabilities and redacted logs in a folder the user can inspect before sharing. */
  async diagnosticBundle(destinationDir: string): Promise<string> {
    const dir = join(this.approvedPath(destinationDir), `takeoff-diagnostics-${Date.now()}`);
    await mkdir(join(dir, 'logs'), { recursive: true });
    await writeFile(join(dir, 'versions.json'), JSON.stringify({ ...VERSIONS, node: process.versions.node, platform: process.platform, arch: process.arch }, null, 2));
    await writeFile(join(dir, 'capabilities.json'), JSON.stringify((await this.capabilities()).dto, null, 2));
    const raw = await readFile(this.logger.file, 'utf8').catch(() => '');
    const lines = raw.split('\n').filter(Boolean).flatMap((l) => {
      try {
        const j = JSON.parse(l) as Record<string, unknown>;
        return [JSON.stringify({ ts: j.ts, event: j.event, ...redact(j) })];
      } catch {
        return [];
      }
    });
    await writeFile(join(dir, 'logs', 'engine.jsonl'), lines.join('\n') + (lines.length ? '\n' : ''));
    return dir;
  }
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
