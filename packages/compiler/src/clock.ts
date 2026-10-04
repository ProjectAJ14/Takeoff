// Clock conversion and half-open interval helpers. The only place source
// microseconds become output frames or samples (docs/architecture.md "Clocks").
import type { Rational } from '@takeoff/contracts';

export const SAMPLE_RATE = 48000;
const US = 1_000_000n;

/** floor(n / d) for d > 0. BigInt `/` truncates toward zero, which is ceil for negatives. */
const floorDiv = (n: bigint, d: bigint): bigint => n / d - (n % d < 0n ? 1n : 0n);

/** Output frame containing output time `us`: floor(us * num / (den * 1e6)). Apply to cumulative time so rounding never accumulates. */
export const usToFrames = (us: number | bigint, fps: Rational): number =>
  Number(floorDiv(BigInt(us) * BigInt(fps.num), BigInt(fps.den) * US));

/** First whole microsecond at or after the start of `frame`: ceil(frame * den * 1e6 / num). */
export const frameToUs = (frame: number, fps: Rational): number =>
  Number(-floorDiv(-BigInt(frame) * BigInt(fps.den) * US, BigInt(fps.num)));

/** First sample of `frame` at 48 kHz: floor(frames * 48000 * den / num). */
export const framesToSamples = (frames: number, fps: Rational): number =>
  Number(floorDiv(BigInt(frames) * BigInt(SAMPLE_RATE) * BigInt(fps.den), BigInt(fps.num)));

/** Whole samples in `us` microseconds at 48 kHz (floor). */
export const usToSamples = (us: number): number => Number(floorDiv(BigInt(us) * BigInt(SAMPLE_RATE), US));

/** Half-open [start, end). Empty when start >= end. */
export interface Interval {
  start: number;
  end: number;
}

export const contains = (a: Interval, x: number): boolean => a.start <= x && x < a.end;

export function intersect(a: Interval, b: Interval): Interval | null {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return start < end ? { start, end } : null;
}

/** a minus b: zero, one or two non-empty pieces, in order. */
export function subtract(a: Interval, b: Interval): Interval[] {
  if (b.start >= b.end) return a.start < a.end ? [a] : [];
  return [
    { start: a.start, end: Math.min(a.end, b.start) },
    { start: Math.max(a.start, b.end), end: a.end },
  ].filter((i) => i.start < i.end);
}

/** Sorted union; touching intervals ([0,5) and [5,9)) join. Empties are dropped. */
export function merge(list: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const i of list.filter((x) => x.start < x.end).sort((x, y) => x.start - y.start)) {
    const last = out.at(-1);
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}
