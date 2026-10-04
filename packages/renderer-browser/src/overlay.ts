// Overlay pass: a sandboxed Chromium page that seeks scenes frame by frame (PRD §7.4, §15).
// The page gets a static document and an allowlisted in-memory asset map; every other request is aborted and reported.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';
import { captionBox, platformSafeArea, rectInside, type Rect } from '@takeoff/renderer-api';
import type { BrandProfile, RenderProfile } from '@takeoff/contracts';
import type { RenderInput } from '@takeoff/renderer-api';
import type { CaptionSpec, OverlayBrand, OverlaySpec, PageViolation, SceneSpec, SeekResult } from './spec.ts';
import { faceInOutput } from './compose.ts';

export type ViolationCode = PageViolation['code'] | 'undeclared_network' | 'caption_outside_safe_area' | 'scene_outside_safe_area';
export interface OverlayViolation {
  code: ViolationCode;
  ref: string;
  detail: string;
}

/** Neutral default palette, used when the project has no brand profile. Owned here, not by app chrome tokens. */
export const DEFAULT_PALETTE = Object.freeze({ text: '#FFFFFF', highlight: '#FFD23F', accent: '#2F6FEB', background: '#111111' });

const ORIGIN = 'http://takeoff.scene';
const HEX = /^#[0-9a-fA-F]{6}$/;
const FONT_TYPES: Record<string, string> = { '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf' };

let runtimeJs: string | undefined;
/** The bundled scene runtime (renderer-api scene kit + scenes), built once per process. */
export function sceneRuntime(): string {
  runtimeJs ??= buildSync({
    entryPoints: [fileURLToPath(new URL('./runtime.ts', import.meta.url))],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    write: false,
    legalComments: 'none',
  }).outputFiles[0]!.text;
  return runtimeJs;
}
export const sceneRuntimeHash = () => createHash('sha256').update(sceneRuntime()).digest('hex');

const interDir = join(dirname(createRequire(import.meta.url).resolve('@fontsource/inter')), 'files');

/** Render size: draft is 540 px wide at the compiled aspect, final is the compiled size. */
export function renderSize(compiled: { width: number; height: number }, profile: RenderProfile): { width: number; height: number } {
  if (profile === 'final') return { width: compiled.width, height: compiled.height };
  return { width: 540, height: Math.max(2, Math.round((540 * compiled.height) / compiled.width / 2) * 2) };
}

interface Built {
  spec: OverlaySpec;
  /** Allowlisted page resources by pathname. */
  files: Map<string, { body: Buffer | string; type: string }>;
}

function colour(brand: BrandProfile | null, role: BrandProfile['palette'][number]['role'], fallback: string): string {
  const c = brand?.palette.find((p) => p.role === role)?.color;
  return c && HEX.test(c) ? c : fallback;
}

/** Builds the page spec and its allowlisted resources from a render input. Pure apart from reading pinned font files. */
export function buildOverlay(input: RenderInput, profile: RenderProfile): Built {
  const { compiled, plan, brand } = input;
  const { width, height } = renderSize(compiled, profile);
  const files: Built['files'] = new Map();
  const faces: string[] = [];
  const fontLoads: string[] = [];

  const sans = 'TakeoffSans';
  for (const wt of [600, 800]) {
    files.set(`/fonts/inter-${wt}.woff2`, { body: readFileSync(join(interDir, `inter-latin-${wt}-normal.woff2`)), type: 'font/woff2' });
    faces.push(`@font-face{font-family:${sans};font-weight:${wt};src:url(/fonts/inter-${wt}.woff2) format("woff2")}`);
    fontLoads.push(`${wt} 32px ${sans}`);
  }
  // Brand fonts are pinned files from RenderInput.fonts, verified by hash; CSS uses internal family names only.
  const brandFont = (role: 'caption' | 'heading'): string | null => {
    const family = brand?.fonts.find((f) => f.role === role)?.family ?? (role === 'caption' ? brand?.fonts.find((f) => f.role === 'body')?.family : undefined);
    const i = family === undefined ? -1 : input.fonts.findIndex((f) => f.family === family);
    if (i < 0) return null;
    const f = input.fonts[i]!;
    const type = FONT_TYPES[extname(f.path).toLowerCase()];
    if (!type) throw new RangeError(`font ${i} has an unsupported file type`);
    const body = readFileSync(f.path);
    if (createHash('sha256').update(body).digest('hex') !== f.hash) throw new RangeError(`font ${i} does not match its pinned hash`);
    const name = `TakeoffBrand${i}`;
    if (!files.has(`/fonts/brand-${i}`)) {
      files.set(`/fonts/brand-${i}`, { body, type });
      faces.push(`@font-face{font-family:${name};font-weight:100 900;src:url(/fonts/brand-${i})}`);
      fontLoads.push(`800 32px ${name}`);
    }
    return name;
  };

  const ob: OverlayBrand = {
    text: colour(brand, 'text', DEFAULT_PALETTE.text),
    highlight: brand && HEX.test(brand.captionStyle.highlightColor) ? brand.captionStyle.highlightColor : colour(brand, 'highlight', DEFAULT_PALETTE.highlight),
    accent: colour(brand, 'accent', DEFAULT_PALETTE.accent),
    background: colour(brand, 'background', DEFAULT_PALETTE.background),
    captionFont: brandFont('caption') ?? sans,
    headingFont: brandFont('heading') ?? sans,
  };

  const captions: CaptionSpec[] = [];
  for (const cc of compiled.captions) {
    const c = plan.captions.find((x) => x.id === cc.captionId);
    if (!c) continue;
    const tokens = c.text.trim().split(/\s+/);
    // Word-level timing only while the caption text still lines up with its word ids (a user edit may merge words).
    const words = tokens.length === cc.words.length
      ? cc.words.map((w, i) => ({ text: tokens[i]!, startFrame: w.startFrame - cc.startFrame, endFrame: w.endFrame - cc.startFrame, emphasis: c.emphasisWordIds.includes(w.wordId) }))
      : null;
    captions.push({ id: c.id, startFrame: cc.startFrame, endFrame: cc.endFrame, template: c.template, position: captionSlot(input, cc, c.positionPolicy, width, height), words, text: c.text });
  }
  const scenes: SceneSpec[] = [];
  for (const cv of compiled.visuals) {
    const v = plan.visuals.find((x) => x.id === cv.visualId);
    if (!v || v.kind === 'broll') continue;
    const span = { id: v.id, startFrame: cv.startFrame, endFrame: cv.endFrame };
    if (v.kind === 'hook_text') scenes.push({ ...span, kind: 'hook_text', params: { text: v.text } });
    else if (v.template === 'kinetic_text_v1') scenes.push({ ...span, kind: v.template, params: { lines: [...v.params.lines] } });
    else if (v.template === 'request_flow_v1') scenes.push({ ...span, kind: v.template, params: { ...v.params } });
    else scenes.push({ ...span, kind: v.template, params: { title: v.params.title, items: [...v.params.items] } });
  }

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${faces.join('')}html,body{margin:0;padding:0;background:transparent;overflow:hidden}</style></head><body><script src="/runtime.js"></script></body></html>`;
  files.set('/index.html', { body: html, type: 'text/html; charset=utf-8' });
  files.set('/runtime.js', { body: sceneRuntime(), type: 'text/javascript; charset=utf-8' });
  return { spec: { width, height, fps: compiled.fps, seed: input.seed, brand: ob, fontLoads, captions, scenes }, files };
}

/**
 * F06: `safe_face_aware` resolves to `safe_top` when the face (union over the segments the caption spans, in render
 * pixels) overlaps the bottom slot but not the top one; otherwise the slot is unchanged (bottom without a face).
 * ponytail: face box before punch zoom; a tracked punch grows it by at most its scale around its own centre.
 */
function captionSlot(input: RenderInput, cc: { startFrame: number; endFrame: number }, position: CaptionSpec['position'], width: number, height: number): CaptionSpec['position'] {
  if (position !== 'safe_face_aware' || !input.faceTracks) return position;
  let face: Rect | null = null;
  for (const s of input.compiled.segments) {
    if (s.outputEndFrame <= cc.startFrame || s.outputStartFrame >= cc.endFrame) continue;
    const r = faceInOutput(input, s, width, height)?.rect;
    if (r) face = face ? union(face, r) : r;
  }
  const box = captionBox(width, height, position, face);
  return face && box.y === captionBox(width, height, 'safe_top').y ? 'safe_top' : position;
}

export interface OverlayFrame {
  png: Buffer;
  /** True when no overlay is visible (fully transparent frame). */
  empty: boolean;
  bounds: SeekResult['bounds'];
}

export interface OverlaySession {
  readonly width: number;
  readonly height: number;
  readonly chromiumVersion: string;
  /** Live list: network attempts are appended as they happen. */
  readonly violations: OverlayViolation[];
  /** Per-caption union of rendered bounds over every frame sought so far. */
  readonly captionBounds: Map<string, Rect>;
  /** Seek and capture; consecutive frames with the same DOM state reuse one PNG. */
  frame(f: number): Promise<OverlayFrame>;
  /** For sandbox tests only: the page itself. */
  readonly page: Page;
  close(): Promise<void>;
}

// Software raster, fixed colour profile and no LCD text; every compositor stage (raster included) completes before a
// frame is drawn, so a screenshot never catches tiles from an earlier state (seek order must not change pixels).
const LAUNCH_ARGS = [
  '--disable-gpu', '--font-render-hinting=none', '--disable-lcd-text', '--force-color-profile=srgb', '--disable-skia-runtime-opts',
  '--run-all-compositor-stages-before-draw', '--disable-checker-imaging', '--disable-threaded-animation', '--disable-threaded-scrolling',
  '--disable-new-content-rendering-timeout', '--disable-partial-raster',
];

function union(a: Rect | undefined, b: Rect): Rect {
  if (!a) return b;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export async function openOverlay(input: RenderInput, profile: RenderProfile, signal?: AbortSignal): Promise<OverlaySession> {
  signal?.throwIfAborted();
  const { spec, files } = buildOverlay(input, profile);
  // OS sandbox on (Playwright's default is --no-sandbox). Linux needs unprivileged user namespaces (see .github/workflows/test.yml).
  const browser: Browser = await chromium.launch({ headless: true, chromiumSandbox: true, args: LAUNCH_ARGS });
  const onAbort = () => void browser.close().catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const context = await browser.newContext({
      viewport: { width: spec.width, height: spec.height },
      deviceScaleFactor: 1,
      offline: true,
      serviceWorkers: 'block',
      acceptDownloads: false,
      javaScriptEnabled: true,
      colorScheme: 'light',
      reducedMotion: 'reduce',
      locale: 'en-US',
      timezoneId: 'UTC',
    });
    const violations: OverlayViolation[] = [];
    const blocked = (url: string) => {
      let origin = 'unparseable';
      try { origin = new URL(url).origin; } catch { /* keep placeholder */ }
      // Report the origin only: a full URL could carry transcript text.
      violations.push({ code: 'undeclared_network', ref: origin, detail: 'the overlay page attempted a request outside its allowlist; it was aborted' });
    };
    await context.route('**/*', (route) => {
      const url = route.request().url();
      const u = URL.canParse(url) ? new URL(url) : null;
      const file = u && u.origin === ORIGIN && route.request().method() === 'GET' ? files.get(u.pathname) : undefined;
      if (file) return route.fulfill({ status: 200, contentType: file.type, body: file.body });
      blocked(url);
      return route.abort('blockedbyclient');
    });
    await context.routeWebSocket(/.*/, (ws) => {
      blocked(ws.url());
      void ws.close();
    });
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/index.html`, { waitUntil: 'load' });
    const pageViolations = await page.evaluate((s) => (globalThis as unknown as { takeoff: { init(s: OverlaySpec): Promise<PageViolation[]> } }).takeoff.init(s), spec);
    violations.push(...pageViolations);

    const clip = { x: 0, y: 0, width: spec.width, height: spec.height };
    const shot = () => page.screenshot({ type: 'png', omitBackground: true, clip, animations: 'disabled', caret: 'hide' });
    await page.evaluate(() => (globalThis as unknown as { takeoff: { seek(f: number): SeekResult } }).takeoff.seek(-1));
    const transparent = await shot();
    const safe = platformSafeArea(spec.width, spec.height);
    const captionBounds = new Map<string, Rect>();
    const flagged = new Set<string>();
    let lastKey = '';
    let lastPng = transparent;

    return {
      width: spec.width,
      height: spec.height,
      chromiumVersion: browser.version(),
      violations,
      captionBounds,
      page,
      async frame(f) {
        signal?.throwIfAborted();
        const r = await page.evaluate((n) => (globalThis as unknown as { takeoff: { seek(f: number): SeekResult } }).takeoff.seek(n), f);
        for (const b of r.bounds) {
          if (b.kind === 'caption') captionBounds.set(b.id, union(captionBounds.get(b.id), b.rect));
          const c = spec.captions.find((x) => x.id === b.id);
          const inside = b.kind === 'caption' && c ? rectInside(b.rect, captionBox(spec.width, spec.height, c.position)) : rectInside(b.rect, safe);
          if (!inside && !flagged.has(b.id)) {
            flagged.add(b.id);
            violations.push({ code: b.kind === 'caption' ? 'caption_outside_safe_area' : 'scene_outside_safe_area', ref: b.id, detail: `rendered bounds leave the safe area at frame ${f}` });
          }
        }
        if (!r.key) return { png: transparent, empty: true, bounds: r.bounds };
        if (r.key !== lastKey) {
          lastPng = await shot();
          lastKey = r.key;
        }
        return { png: lastPng, empty: false, bounds: r.bounds };
      },
      async close() {
        signal?.removeEventListener('abort', onAbort);
        await browser.close();
      },
    };
  } catch (e) {
    signal?.removeEventListener('abort', onAbort);
    await browser.close().catch(() => {});
    throw signal?.aborted ? (signal.reason ?? e) : e;
  }
}
