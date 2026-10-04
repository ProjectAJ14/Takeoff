// Renderer-neutral contract (PRD §7.4, §9.1 ScenePackage). Types only.
// A renderer receives a validated compiled plan plus resolved, hashed inputs and
// nothing else: no network, no wall clock, no unseeded randomness.
import type {
  AssetManifest,
  BrandProfile,
  CompiledTimeline,
  EditPlan,
  Id,
  Rational,
  RenderProfile,
  Sha256,
  VisualFallback,
} from '@takeoff/contracts';

/** Integer output pixels, origin top-left. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ResolvedAsset {
  /** Absolute path, already resolved under an approved root by the engine. */
  path: string;
  hash: Sha256;
  manifest: AssetManifest;
}

export interface ResolvedFont {
  family: string;
  /** Absolute path to a pinned font file; renderers never fetch fonts. */
  path: string;
  hash: Sha256;
}

export interface RenderInput {
  compiled: CompiledTimeline;
  plan: EditPlan;
  assets: Record<Id, ResolvedAsset>;
  fonts: ResolvedFont[];
  brand: BrandProfile | null;
  seed: number;
  /** Pinned component versions, e.g. { compiler: '1.0.0', chromium: '131.0', ffmpeg: '7.1' }. */
  versions: Record<string, string>;
}

export interface RenderProgress {
  /** Frames completed, 0..totalFrames. */
  frame: number;
  totalFrames: number;
}

export interface RenderOptions {
  outPath: string;
  profile: RenderProfile;
  signal?: AbortSignal;
  onProgress?: (progress: RenderProgress) => void;
}

/** PRD §9.1 Job/RenderArtifact: output identity plus the inputs and environment that produced it. */
export interface RenderArtifact {
  path: string;
  sha256: Sha256;
  bytes: number;
  profile: RenderProfile;
  planHash: Sha256;
  width: number;
  height: number;
  fps: Rational;
  durationFrames: number;
  rendererId: string;
  seed: number;
  versions: Record<string, string>;
}

export interface Renderer {
  readonly id: string;
  /** Rejects with an AbortError when `signal` aborts; never leaves a partial file at `outPath`. */
  render(input: RenderInput, opts: RenderOptions): Promise<RenderArtifact>;
}

// ---------- Browser scenes (PRD §7.4, §15) ----------

export interface SceneEnv {
  width: number;
  height: number;
  fps: Rational;
  seed: number;
}

/**
 * A scene is a pure function of (params, env, frame). It runs sandboxed with no
 * Node, filesystem, IPC or network; it must not use timers, live CSS transitions,
 * Date/performance clocks or Math.random. `seek` may be called in any order.
 */
export interface Scene<P = unknown> {
  initialize(params: P, env: SceneEnv): void;
  /** Resolves once fonts and local assets are decoded; the renderer awaits it before the first seek. */
  assetsReady(): Promise<void>;
  /** Draw the state at integer output frame `frame` (scene-relative, 0-based). */
  seek(frame: number): void;
  /** Bounding boxes of visible text/graphics at the last sought frame, for safe-area QA. */
  bounds(): Rect[];
  dispose(): void;
}

/** PRD §9.1 ScenePackage: everything needed to reproduce one scene render. */
export interface ScenePackage {
  /** Template id (e.g. 'kinetic_text_v1') or 'generated' for P1 scenes. */
  template: string;
  /** SHA-256 of the scene code. */
  codeHash: Sha256;
  assets: Array<{ id: Id; hash: Sha256 }>;
  fonts: Array<{ family: string; hash: Sha256 }>;
  params: Record<string, unknown>;
  durationFrames: number;
  width: number;
  height: number;
  seed: number;
  /** Factual claims the scene makes, each checked against transcript evidence. */
  claims: Array<{ text: string; evidenceIds: Id[] }>;
  expectedBounds: Rect[];
  requirements: { renderer: string; features: string[] };
  fallback: VisualFallback;
}
