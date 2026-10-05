// Pure, deterministic helpers shared by scenes and layout QA.
// No imports, no I/O, no clocks: this file is bundled into sandboxed scene pages.

type Box = { x: number; y: number; w: number; h: number };
type CaptionPosition = 'safe_face_aware' | 'safe_bottom' | 'safe_top';

/** Fractions of the frame reserved for platform UI. */
export interface SafeInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Reels/Shorts 9:16: status/title bar on top, action rail on the right, caption/CTA on the bottom. */
export const REELS_SHORTS_INSETS: Readonly<SafeInsets> = Object.freeze({ top: 0.12, right: 0.12, bottom: 0.2, left: 0.06 });

function checkDims(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError(`frame size must be positive integers, got ${width}x${height}`);
  }
}

// ponytail: 1e-9 epsilon absorbs float noise (100*0.07 = 7.000000000000001) so outward rounding
// never steals a whole pixel; exact products still round up.
const ceilPx = (v: number): number => Math.ceil(v - 1e-9);

/** Largest integer rect clear of platform UI; insets round outward so the area never grows. */
export function platformSafeArea(width: number, height: number, insets: SafeInsets = REELS_SHORTS_INSETS): Box {
  checkDims(width, height);
  for (const v of [insets.top, insets.right, insets.bottom, insets.left]) {
    if (!(v >= 0 && v < 1)) throw new RangeError(`inset must be in [0,1), got ${v}`);
  }
  const x = ceilPx(width * insets.left);
  const y = ceilPx(height * insets.top);
  const right = width - ceilPx(width * insets.right);
  const bottom = height - ceilPx(height * insets.bottom);
  if (right <= x || bottom <= y) throw new RangeError('insets leave no safe area');
  return { x, y, w: right - x, h: bottom - y };
}

/** Fraction of frame height a caption block may occupy (two lines plus padding). */
export const CAPTION_BOX_HEIGHT = 0.16;

/**
 * Caption block inside the safe area. `safe_face_aware` uses the bottom slot unless it
 * overlaps `face`, then the top slot; with no face (tracking unreliable) it falls back to bottom.
 */
export function captionBox(
  width: number,
  height: number,
  position: CaptionPosition,
  face: Box | null = null,
  insets: SafeInsets = REELS_SHORTS_INSETS,
): Box {
  const safe = platformSafeArea(width, height, insets);
  const h = Math.min(safe.h, Math.round(height * CAPTION_BOX_HEIGHT));
  const top = { x: safe.x, y: safe.y, w: safe.w, h };
  const bottom = { x: safe.x, y: safe.y + safe.h - h, w: safe.w, h };
  if (position === 'safe_top') return top;
  if (position === 'safe_face_aware' && face && rectsOverlap(bottom, face) && !rectsOverlap(top, face)) return top;
  return bottom;
}

export function rectInside(inner: Box, outer: Box): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

/** Half-open overlap: touching edges do not overlap, and an empty rect overlaps nothing. */
export function rectsOverlap(a: Box, b: Box): boolean {
  if (!(a.w > 0 && a.h > 0 && b.w > 0 && b.h > 0)) return false;
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Seeded PRNG (mulberry32). Same seed, same sequence; values in [0, 1). */
export function mulberry32(seed: number): () => number {
  // Silent truncation would make seeds 1 and 1.5 (or 0 and 2**32) collide.
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError(`seed must be a uint32, got ${seed}`);
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Clamp to [lo, hi]; NaN maps to lo so a bad frame never yields NaN opacity/position. */
export const clamp = (v: number, lo = 0, hi = 1): number => (v >= lo ? (v <= hi ? v : hi) : lo);

/** Animation progress at `frame` for an animation starting at `startFrame` lasting `durationFrames`, clamped to [0,1]. */
export function frameProgress(frame: number, startFrame: number, durationFrames: number): number {
  return durationFrames <= 0 ? (frame >= startFrame ? 1 : 0) : clamp((frame - startFrame) / durationFrames);
}

// Easings take t clamped to [0,1] and return 0 at t=0 and 1 at t=1.
export const linear = (t: number): number => clamp(t);

export function easeInOutCubic(t: number): number {
  const x = clamp(t);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

/** Overshoots past 1 mid-way (by ~10% at default), settles at exactly 1. */
export function easeOutBack(t: number, overshoot = 1.70158): number {
  const x = clamp(t);
  if (x === 0) return 0; // the polynomial leaves 2e-16 here; endpoints must be exact
  const c3 = overshoot + 1;
  return 1 + c3 * (x - 1) ** 3 + overshoot * (x - 1) ** 2;
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape untrusted text (captions, hooks, labels) for HTML/SVG text and quoted attributes. */
export function escapeHtml(text: string): string {
  return String(text).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);
}
