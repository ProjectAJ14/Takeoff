// Overlay page runtime. Bundled (esbuild, IIFE) and served into the sandboxed Chromium page; never runs in Node.
// Every scene is a pure function of (spec, env, frame): no timers, clocks, CSS transitions or network.
// Untrusted strings reach the DOM through textContent only; styles carry product numbers and validated colours.
import { captionBox, clamp, easeInOutCubic, easeOutBack, frameProgress, mulberry32, platformSafeArea } from '@takeoff/renderer-api';
import type { Rect, Scene, SceneEnv } from '@takeoff/renderer-api';
import type { CaptionSpec, OverlayBrand, OverlaySpec, PageViolation, SceneSpec, SeekResult } from './spec.ts';

const SVGNS = 'http://www.w3.org/2000/svg';
const violations: PageViolation[] = [];

function div(parent: Element, css: string, text?: string): HTMLDivElement {
  const d = document.createElement('div');
  d.style.cssText = css;
  if (text !== undefined) d.textContent = text;
  parent.appendChild(d);
  return d;
}
function svg<K extends keyof SVGElementTagNameMap>(parent: Element, tag: K, attrs: Record<string, string | number>, text?: string): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  parent.appendChild(e);
  return e;
}
const px = (v: number) => `${Math.round(v * 100) / 100}px`;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

function toRect(rs: DOMRect[]): Rect {
  const live = rs.filter((r) => r.width > 0 && r.height > 0);
  if (!live.length) return { x: 0, y: 0, w: 0, h: 0 };
  const x = Math.floor(Math.min(...live.map((r) => r.left)));
  const y = Math.floor(Math.min(...live.map((r) => r.top)));
  return { x, y, w: Math.ceil(Math.max(...live.map((r) => r.right))) - x, h: Math.ceil(Math.max(...live.map((r) => r.bottom))) - y };
}

/** Largest integer size in [min, start] for which `fits` holds after `apply`; min when none does. */
function shrink(start: number, min: number, apply: (size: number) => void, fits: () => boolean): boolean {
  for (let s = Math.round(start); s >= Math.round(min); s--) {
    apply(s);
    if (fits()) return true;
  }
  return false;
}

function lineCount(spans: HTMLElement[]): number {
  const tops = new Set<number>();
  for (const s of spans) for (const r of s.getClientRects()) tops.add(Math.round(r.top));
  return tops.size;
}

/** FNV-1a: per-scene seed from the render seed and the object id. */
function seedFor(seed: number, id: string): number {
  let h = 0x811c9dc5 ^ seed;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** Fade in over `inF` frames at the start and out over `outF` frames before `dur`. */
const envelope = (f: number, dur: number, inF: number, outF: number) => Math.min(frameProgress(f, 0, inF), 1 - frameProgress(f, dur - outF, outF));

type Layer = { id: string; kind: 'caption' | 'scene'; start: number; end: number; node: HTMLElement; scene: Scene<unknown> };

// ---------- captions (F06) ----------

function captionScene(stage: HTMLElement, c: CaptionSpec, brand: OverlayBrand): { node: HTMLElement; scene: Scene<unknown> } {
  const node = div(stage, 'position:absolute;display:flex;flex-direction:column;align-items:center');
  const block = div(node, `text-align:center;line-height:1.25;font-family:${brand.captionFont};font-weight:800;color:${brand.text}`);
  const words = c.words ?? [{ text: c.text, startFrame: 0, endFrame: 0, emphasis: false }];
  const spans = words.map((w, i) => {
    if (i) block.appendChild(document.createTextNode(' '));
    const s = document.createElement('span');
    s.textContent = w.text;
    s.style.display = 'inline';
    block.appendChild(s);
    return s;
  });
  let env: SceneEnv;
  let box: Rect;
  const scene: Scene<unknown> = {
    initialize(_p, e) {
      env = e;
      box = captionBox(e.width, e.height, c.position);
      node.style.cssText += `;left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px;justify-content:${c.position === 'safe_top' ? 'flex-start' : 'flex-end'}`;
      if (c.template === 'static') block.style.cssText += `;background:rgba(0,0,0,0.62);padding:0.12em 0.4em;border-radius:0.25em;box-sizing:border-box`;
      else block.style.cssText += `;-webkit-text-stroke:0.14em #000;paint-order:stroke fill`;
    },
    async assetsReady() {
      // Energetic scales the active word and pops the block, so it fits inside a margin.
      const room = c.template === 'energetic' ? 0.9 : 1;
      block.style.maxWidth = px(box.w * room);
      // Fit on measured glyph bounds, not character counts (F06): at most two lines, inside the caption box.
      const ok = shrink(env.height * 0.045, env.height * 0.022, (s) => (block.style.fontSize = `${s}px`), () => {
        const r = toRect(spans.flatMap((s) => [...s.getClientRects()]));
        return lineCount(spans) <= 2 && r.h <= box.h * room && r.w <= box.w * room && r.y >= box.y && r.y + r.h <= box.y + box.h;
      });
      if (!ok) violations.push({ code: 'caption_overflow', ref: c.id, detail: 'caption needs more than two lines at the minimum size' });
    },
    seek(f) {
      const pop = c.template === 'energetic' ? 0.85 + 0.15 * easeOutBack(frameProgress(f, 0, 6)) : 1;
      block.style.transform = `scale(${r3(pop)})`;
      block.style.opacity = String(c.template === 'static' ? 1 : r3(frameProgress(f, 0, 3)));
      words.forEach((w, i) => {
        const active = c.words !== null && c.template !== 'static' && w.startFrame <= f && f < w.endFrame;
        const s = spans[i]!.style;
        s.color = w.emphasis || active ? brand.highlight : brand.text;
        if (c.template === 'energetic' && active) {
          s.background = brand.highlight;
          s.color = brand.background;
          s.boxShadow = `0 0 0 0.1em ${brand.highlight}`;
          s.borderRadius = '0.12em';
          s.webkitTextStroke = '0';
        } else {
          s.background = s.boxShadow = s.borderRadius = s.webkitTextStroke = '';
        }
      });
    },
    bounds: () => [toRect(spans.flatMap((s) => [...s.getClientRects()]))],
    dispose: () => node.remove(),
  };
  return { node, scene };
}

// ---------- hook text (F13) ----------

function hookScene(stage: HTMLElement, sp: Extract<SceneSpec, { kind: 'hook_text' }>, brand: OverlayBrand) {
  const node = div(stage, `position:absolute;box-sizing:border-box;padding:0.35em 0.6em;border-radius:0.3em;text-align:center;line-height:1.15;overflow-wrap:anywhere;font-family:${brand.headingFont};font-weight:800;background:${brand.highlight};color:${brand.background}`, sp.params.text);
  let env: SceneEnv;
  let safe: Rect;
  const dur = sp.endFrame - sp.startFrame;
  const scene: Scene<unknown> = {
    initialize(_p, e) {
      env = e;
      safe = platformSafeArea(e.width, e.height);
      node.style.cssText += `;left:${safe.x}px;top:${safe.y}px;width:${safe.w}px`;
    },
    async assetsReady() {
      const ok = shrink(env.height * 0.04, env.height * 0.02, (s) => (node.style.fontSize = `${s}px`), () => node.getBoundingClientRect().height <= safe.h * 0.25);
      if (!ok) violations.push({ code: 'scene_text_overflow', ref: sp.id, detail: 'hook text does not fit the top safe area' });
    },
    seek(f) {
      node.style.opacity = String(r3(envelope(f, dur, 4, 6)));
      // Settles downward into the top safe area; no overshoot, so it never rises above it.
      node.style.transform = `translateY(${px((1 - easeInOutCubic(frameProgress(f, 0, 8))) * env.height * 0.02)})`;
    },
    bounds: () => [toRect([node.getBoundingClientRect()])],
    dispose: () => node.remove(),
  };
  return { node, scene };
}

// ---------- kinetic_text_v1 ----------

function kineticScene(stage: HTMLElement, sp: Extract<SceneSpec, { kind: 'kinetic_text_v1' }>, brand: OverlayBrand) {
  const node = div(stage, `position:absolute;text-align:center;line-height:1.1;font-family:${brand.headingFont};font-weight:800;-webkit-text-stroke:0.1em #000;paint-order:stroke fill`);
  const lines = sp.params.lines.map((t, i) => div(node, `white-space:nowrap;width:fit-content;margin:0 auto;color:${i === sp.params.lines.length - 1 ? brand.highlight : brand.text}`, t));
  let env: SceneEnv;
  let safe: Rect;
  let tilt: number[] = [];
  const dur = sp.endFrame - sp.startFrame;
  const stagger = Math.max(2, Math.min(8, Math.floor(dur / (lines.length + 2))));
  const scene: Scene<unknown> = {
    initialize(_p, e) {
      env = e;
      safe = platformSafeArea(e.width, e.height);
      node.style.cssText += `;left:${safe.x}px;top:${Math.round(safe.y + safe.h * 0.18)}px;width:${safe.w}px`;
      const rnd = mulberry32(seedFor(e.seed, sp.id));
      tilt = lines.map(() => r3(rnd() * 4 - 2));
    },
    async assetsReady() {
      const ok = shrink(env.height * 0.06, env.height * 0.025, (s) => (node.style.fontSize = `${s}px`), () =>
        // Leave room for the ±2° tilt and the entry overshoot.
        lines.every((l) => l.getBoundingClientRect().width <= safe.w * 0.85) && node.getBoundingClientRect().height <= safe.h * 0.5);
      if (!ok) violations.push({ code: 'scene_text_overflow', ref: sp.id, detail: 'kinetic text lines do not fit the safe area' });
    },
    seek(f) {
      const out = 1 - frameProgress(f, dur - 6, 6);
      lines.forEach((l, i) => {
        const p = easeOutBack(frameProgress(f, i * stagger, 8));
        l.style.opacity = String(r3(Math.min(frameProgress(f, i * stagger, 4), out)));
        l.style.transform = `translateY(${px((1 - p) * env.height * 0.03)}) rotate(${tilt[i]}deg)`;
      });
    },
    bounds: () => [toRect(lines.map((l) => l.getBoundingClientRect()))],
    dispose: () => node.remove(),
  };
  return { node, scene };
}

// ---------- request_flow_v1 ----------

function flowScene(stage: HTMLElement, sp: Extract<SceneSpec, { kind: 'request_flow_v1' }>, brand: OverlayBrand) {
  const node = div(stage, 'position:absolute');
  const root = svg(node, 'svg', {});
  const dur = sp.endFrame - sp.startFrame;
  // Choreography in frames at 60-frame scale; shorter scenes compress it.
  const k = Math.min(1, dur / 60);
  const t = (x: number) => Math.round(x * k);
  let env: SceneEnv;
  let w = 0, h = 0;
  let container: SVGGElement, internal: SVGGElement, external: SVGGElement, edge: SVGLineElement, head: SVGPolygonElement, edgeLabel: SVGTextElement, packet: SVGCircleElement;
  let texts: Array<{ el: SVGTextElement; maxW: number }> = [];
  let y0 = 0, y1 = 0;
  const scene: Scene<unknown> = {
    initialize(_p, e) {
      env = e;
      const safe = platformSafeArea(e.width, e.height);
      w = safe.w;
      h = Math.round(safe.h * 0.56);
      node.style.cssText += `;left:${safe.x}px;top:${Math.round(safe.y + safe.h * 0.04)}px;width:${w}px;height:${h}px`;
      for (const [a, v] of Object.entries({ width: w, height: h, viewBox: `0 0 ${w} ${h}` })) root.setAttribute(a, String(v));
      const fs = h * 0.06;
      const font = { 'font-family': brand.headingFont, 'font-weight': 800, 'font-size': r3(fs), 'text-anchor': 'middle', 'dominant-baseline': 'central' };
      container = svg(root, 'g', {});
      svg(container, 'rect', { x: 2, y: 2, width: w - 4, height: r3(h * 0.56), rx: r3(h * 0.04), fill: 'rgba(0,0,0,0.55)', stroke: brand.text, 'stroke-width': 3 });
      const cl = svg(container, 'text', { ...font, x: w / 2, y: r3(h * 0.09), fill: brand.text }, sp.params.containerLabel);
      internal = svg(root, 'g', {});
      svg(internal, 'rect', { x: r3(w * 0.12), y: r3(h * 0.19), width: r3(w * 0.76), height: r3(h * 0.27), rx: r3(h * 0.03), fill: brand.accent });
      const il = svg(internal, 'text', { ...font, x: w / 2, y: r3(h * 0.325), fill: brand.text }, sp.params.internalNode);
      external = svg(root, 'g', {});
      svg(external, 'rect', { x: r3(w * 0.12), y: r3(h * 0.76), width: r3(w * 0.76), height: r3(h * 0.22), rx: r3(h * 0.03), fill: 'rgba(0,0,0,0.75)', stroke: brand.highlight, 'stroke-width': 4 });
      const el = svg(external, 'text', { ...font, x: w / 2, y: r3(h * 0.87), fill: brand.text }, sp.params.externalNode);
      y0 = h * 0.46;
      y1 = h * 0.76;
      const ah = h * 0.035;
      edge = svg(root, 'line', { x1: w / 2, y1: r3(y0), x2: w / 2, y2: r3(y1 - ah), stroke: brand.highlight, 'stroke-width': 6 });
      head = svg(root, 'polygon', { points: `${r3(w / 2 - ah)},${r3(y1 - ah)} ${r3(w / 2 + ah)},${r3(y1 - ah)} ${r3(w / 2)},${r3(y1)}`, fill: brand.highlight });
      edgeLabel = svg(root, 'text', { ...font, 'text-anchor': 'start', 'font-size': r3(fs * 0.8), x: r3(w / 2 + w * 0.06), y: r3((y0 + y1) / 2 + h * 0.03), fill: brand.highlight }, sp.params.edgeLabel);
      packet = svg(root, 'circle', { cx: w / 2, cy: r3(y0), r: r3(h * 0.025), fill: brand.text, stroke: brand.highlight, 'stroke-width': 4 });
      texts = [{ el: cl, maxW: w * 0.9 }, { el: il, maxW: w * 0.7 }, { el: el, maxW: w * 0.7 }, { el: edgeLabel, maxW: w * 0.4 }];
    },
    async assetsReady() {
      for (const { el, maxW } of texts) {
        const base = Number(el.getAttribute('font-size'));
        const ok = shrink(base, Math.max(env.height * 0.012, base * 0.4), (s) => el.setAttribute('font-size', String(s)), () => el.getComputedTextLength() <= maxW);
        if (!ok) violations.push({ code: 'scene_text_overflow', ref: sp.id, detail: 'a flow label is too long for its box' });
      }
    },
    seek(f) {
      root.setAttribute('opacity', String(r3(1 - frameProgress(f, dur - 6, 6))));
      container.setAttribute('opacity', String(r3(easeInOutCubic(frameProgress(f, 0, t(8))))));
      internal.setAttribute('opacity', String(r3(easeInOutCubic(frameProgress(f, t(6), t(8))))));
      external.setAttribute('opacity', String(r3(easeInOutCubic(frameProgress(f, t(12), t(8))))));
      const draw = easeInOutCubic(frameProgress(f, t(18), t(8)));
      const len = y1 - h * 0.035 - y0;
      edge.setAttribute('stroke-dasharray', String(r3(len)));
      edge.setAttribute('stroke-dashoffset', String(r3(len * (1 - draw))));
      head.setAttribute('opacity', String(draw >= 1 ? 1 : 0));
      edgeLabel.setAttribute('opacity', String(r3(frameProgress(f, t(22), t(6)))));
      // The request packet travels the edge once, then rests at the external node.
      const travel = easeInOutCubic(frameProgress(f, t(28), t(18)));
      packet.setAttribute('cy', String(r3(y0 + (y1 - h * 0.035 - y0) * travel)));
      packet.setAttribute('opacity', String(f >= t(28) ? 1 : 0));
    },
    bounds: () => [toRect([node.getBoundingClientRect()])],
    dispose: () => node.remove(),
  };
  return { node, scene };
}

// ---------- comparison_list_v1 ----------

function listScene(stage: HTMLElement, sp: Extract<SceneSpec, { kind: 'comparison_list_v1' }>, brand: OverlayBrand) {
  const node = div(stage, `position:absolute;box-sizing:border-box;padding:0.6em 0.7em;border-radius:0.4em;background:rgba(0,0,0,0.62);line-height:1.2;font-family:${brand.headingFont};color:${brand.text}`);
  const title = div(node, `font-weight:800;color:${brand.highlight};margin-bottom:0.35em`, sp.params.title);
  const items = sp.params.items.map((t) => {
    const row = div(node, 'display:flex;align-items:baseline;gap:0.45em;margin-top:0.3em;font-weight:600');
    div(row, `flex:none;width:0.5em;height:0.5em;border-radius:0.1em;background:${brand.accent}`);
    div(row, 'overflow-wrap:anywhere', t);
    return row;
  });
  let env: SceneEnv;
  let safe: Rect;
  const dur = sp.endFrame - sp.startFrame;
  const stagger = clamp(Math.floor((dur - 20) / Math.max(1, items.length)), 3, 15);
  const scene: Scene<unknown> = {
    initialize(_p, e) {
      env = e;
      safe = platformSafeArea(e.width, e.height);
      node.style.cssText += `;left:${safe.x}px;top:${Math.round(safe.y + safe.h * 0.06)}px;width:${safe.w}px`;
    },
    async assetsReady() {
      const ok = shrink(env.height * 0.034, env.height * 0.016, (s) => (node.style.fontSize = `${s}px`), () => node.getBoundingClientRect().height <= safe.h * 0.6);
      if (!ok) violations.push({ code: 'scene_text_overflow', ref: sp.id, detail: 'list does not fit the safe area' });
    },
    seek(f) {
      node.style.opacity = String(r3(envelope(f, dur, 5, 6)));
      title.style.transform = `translateY(${px((1 - easeOutBack(frameProgress(f, 0, 8))) * env.height * 0.01)})`;
      items.forEach((row, i) => {
        const p = easeInOutCubic(frameProgress(f, 8 + i * stagger, 6));
        row.style.opacity = String(r3(p));
        row.style.transform = `translateX(${px((1 - p) * -env.height * 0.02)})`;
      });
    },
    bounds: () => [toRect([node.getBoundingClientRect()])],
    dispose: () => node.remove(),
  };
  return { node, scene };
}

// ---------- page API, driven by page.evaluate ----------

let layers: Layer[] = [];

async function init(spec: OverlaySpec): Promise<PageViolation[]> {
  const stage = div(document.body, `position:absolute;left:0;top:0;width:${spec.width}px;height:${spec.height}px;overflow:hidden`);
  await Promise.all(spec.fontLoads.map((f) => document.fonts.load(f).catch(() => [])));
  for (const f of spec.fontLoads) if (!document.fonts.check(f)) violations.push({ code: 'font_missing', ref: f, detail: 'a pinned font did not load' });
  const env: SceneEnv = { width: spec.width, height: spec.height, fps: spec.fps, seed: spec.seed };
  // Each layer sits in its own wrapper, which alone toggles visibility.
  const make = (s: SceneSpec, w: HTMLElement) =>
    s.kind === 'hook_text' ? hookScene(w, s, spec.brand)
    : s.kind === 'kinetic_text_v1' ? kineticScene(w, s, spec.brand)
    : s.kind === 'request_flow_v1' ? flowScene(w, s, spec.brand)
    : listScene(w, s, spec.brand);
  const layer = (id: string, kind: Layer['kind'], start: number, end: number, build: (w: HTMLElement) => { scene: Scene<unknown> }): Layer => {
    const node = div(stage, '');
    return { id, kind, start, end, node, scene: build(node).scene };
  };
  layers = [
    ...spec.scenes.map((s) => layer(s.id, 'scene', s.startFrame, s.endFrame, (w) => make(s, w))),
    // Captions draw above scenes: speech meaning outranks supporting visuals (PRD §10).
    ...spec.captions.map((c) => layer(c.id, 'caption', c.startFrame, c.endFrame, (w) => captionScene(w, c, spec.brand))),
  ];
  for (const l of layers) l.scene.initialize(null, env);
  for (const l of layers) {
    // Fit at full visibility, then hide until sought.
    l.node.style.display = '';
    await l.scene.assetsReady();
    l.node.style.display = 'none';
  }
  return violations;
}

function seek(frame: number): SeekResult {
  const out: SeekResult = { key: '', bounds: [] };
  const keys: string[] = [];
  for (const l of layers) {
    const on = l.start <= frame && frame < l.end;
    l.node.style.display = on ? '' : 'none';
    if (!on) continue;
    l.scene.seek(frame - l.start);
    keys.push(l.node.outerHTML);
    out.bounds.push(...l.scene.bounds().map((rect) => ({ id: l.id, kind: l.kind, rect })));
  }
  out.key = keys.join('\n');
  return out;
}

(globalThis as unknown as { takeoff: unknown }).takeoff = { init, seek };
