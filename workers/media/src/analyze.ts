import { probe } from './probe.ts';
import { MediaError, assertInt, assertNum, ffInput, ffmpeg } from './run.ts';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round4 = (v: number) => Math.round(v * 1e4) / 1e4;
const finite = (v: number): number | null => (Number.isFinite(v) ? v : null);

export interface SilenceSpan {
  startUs: number;
  endUs: number;
}

/** Silent spans via silencedetect, in source microseconds of the given file. A trailing silence ends at EOF. */
export async function detectSilence(
  path: string,
  opts: { thresholdDb?: number; minDurationUs?: number; signal?: AbortSignal } = {},
): Promise<SilenceSpan[]> {
  const { thresholdDb = -35, minDurationUs = 300_000 } = opts;
  assertNum('thresholdDb', thresholdDb, -100, 0);
  assertInt('minDurationUs', minDurationUs, 10_000, 600_000_000);
  const r = await ffmpeg(['-i', ffInput(path), '-vn', '-af', `silencedetect=n=${thresholdDb}dB:d=${minDurationUs / 1e6}`, '-f', 'null', '-'], opts.signal);
  const spans: SilenceSpan[] = [];
  let start: number | null = null;
  for (const m of r.stderr.matchAll(/silence_(start|end): (-?[\d.]+(?:e[-+]?\d+)?)/g)) {
    const us = Math.max(0, Math.round(Number(m[2]) * 1e6));
    if (m[1] === 'start') start = us;
    else if (start !== null) {
      if (us > start) spans.push({ startUs: start, endUs: us });
      start = null;
    }
  }
  return spans;
}

export interface Loudness {
  /** Integrated loudness, LUFS. Null for digital silence. */
  integratedLufs: number | null;
  truePeakDbtp: number | null;
  lraLu: number | null;
  thresholdLufs: number | null;
}

/** EBU R128 measurement (loudnorm first pass, print_format=json). */
export async function measureLoudness(path: string, signal?: AbortSignal): Promise<Loudness> {
  const r = await ffmpeg(['-i', ffInput(path), '-vn', '-af', 'loudnorm=print_format=json', '-f', 'null', '-'], signal);
  const json = /\{[^{}]*"input_i"[^{}]*\}/.exec(r.stderr)?.[0];
  if (!json) throw new MediaError('ffmpeg_failed', 'loudnorm produced no measurement', 'Check that the file has an audio stream.');
  const j = JSON.parse(json) as Record<string, string>;
  const n = (k: string) => finite(Number(j[k]));
  return { integratedLufs: n('input_i'), truePeakDbtp: n('input_tp'), lraLu: n('input_lra'), thresholdLufs: n('input_thresh') };
}

export interface VoiceAnalysis {
  /** Fraction of samples sitting at full scale (≥ -0.1 dBFS peak), 0 when the peak is below that. */
  clippingRatio: number;
  /** Mean sample value as a fraction of full scale. */
  dcOffset: number;
  peakDb: number | null;
  rmsDb: number | null;
  /** astats noise-floor estimate (quietest short-window RMS). Null when the floor is digital silence. */
  noiseFloorDb: number | null;
}

/** Clipping, DC offset and noise floor from astats (overall, all channels). */
export async function analyzeVoice(path: string, signal?: AbortSignal): Promise<VoiceAnalysis> {
  const r = await ffmpeg(['-i', ffInput(path), '-vn', '-af', 'astats=measure_perchannel=none', '-f', 'null', '-'], signal);
  const at = r.stderr.lastIndexOf('] Overall');
  if (at < 0) throw new MediaError('ffmpeg_failed', 'astats produced no measurement', 'Check that the file has an audio stream.');
  const overall = r.stderr.slice(at);
  const get = (key: string) => Number(new RegExp(`\\] ${key}: (\\S+)`).exec(overall)?.[1]);
  const peakDb = get('Peak level dB');
  const samples = get('Number of samples');
  // `Abs Peak count` is FFmpeg 6+; older builds only print `Peak count`.
  const peakCount = finite(get('Abs Peak count')) ?? get('Peak count');
  const clipped = Number.isFinite(peakDb) && peakDb >= -0.1 && samples > 0 ? peakCount / samples : 0;
  return {
    clippingRatio: round4(clamp(clipped, 0, 1)),
    dcOffset: finite(get('DC offset')) ?? 0,
    peakDb: finite(peakDb),
    rmsDb: finite(get('RMS level dB')),
    noiseFloorDb: finite(get('Noise floor dB')),
  };
}

export interface ColorStats {
  yavg: number;
  uavg: number;
  vavg: number;
  ymin: number;
  ymax: number;
  satavg: number;
}
/** Parameters for FFmpeg `eq` (brightness, contrast, saturation) and `colorbalance` midtones (rm, gm, bm). */
export interface ColorCorrection {
  brightness: number;
  contrast: number;
  saturation: number;
  colorbalance: { rm: number; gm: number; bm: number };
}

/**
 * One per-source correction from evenly sampled frames (signalstats on frames converted to 8-bit limited range, so 10-bit sources read on the same scale).
 * Deliberately modest: brightness ±0.08, contrast 1–1.15 only when both ends have headroom
 * (no crushed blacks or clipped highlights), saturation 1–1.1, midtone balance ±0.1.
 * The caller must not apply it to HDR sources (probe().hdr).
 */
export async function analyzeColor(path: string, opts: { samples?: number; signal?: AbortSignal } = {}): Promise<{ stats: ColorStats; correction: ColorCorrection }> {
  const { samples = 8 } = opts;
  assertInt('samples', samples, 1, 120);
  const p = await probe(path, opts.signal);
  if (!p.video) throw new MediaError('no_streams', 'the file has no video stream', 'Color correction needs video.');
  const sec = (p.durationUs ?? 0) / 1e6;
  const rate = sec > 0 ? Math.max(samples / sec, 0.001) : 1;
  // ponytail: decodes every frame to sample a few; seek-per-sample is the upgrade for long takes.
  const r = await ffmpeg(['-i', ffInput(path), '-an', '-vf', `fps=${rate.toFixed(6)},scale=640:-2,format=yuv420p,signalstats,metadata=mode=print`, '-frames:v', String(samples), '-f', 'null', '-'], opts.signal);
  const mean = (key: string) => {
    const vals = [...r.stderr.matchAll(new RegExp(`lavfi\\.signalstats\\.${key}=([\\d.]+)`, 'g'))].map((m) => Number(m[1]));
    if (!vals.length) throw new MediaError('ffmpeg_failed', 'no frames could be sampled', 'Check that the video decodes.');
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  };
  const stats: ColorStats = { yavg: mean('YAVG'), uavg: mean('UAVG'), vavg: mean('VAVG'), ymin: mean('YMIN'), ymax: mean('YMAX'), satavg: mean('SATAVG') };

  const yMean = (stats.yavg - 16) / 219;
  const spread = (stats.ymax - stats.ymin) / 219;
  const headroom = stats.ymin > 24 && stats.ymax < 226;
  const correction: ColorCorrection = {
    brightness: round4(clamp((0.45 - yMean) * 0.5, -0.08, 0.08)),
    contrast: round4(headroom ? clamp(1 + (0.85 - spread) * 0.5, 1, 1.15) : 1),
    saturation: round4(clamp(1 + (12 - stats.satavg) / 40, 1, 1.1)),
    colorbalance: {
      // V above 128 = red cast, U above 128 = blue cast, both below = green cast.
      rm: round4(clamp(-(stats.vavg - 128) / 128, -0.1, 0.1)),
      gm: round4(clamp((stats.uavg + stats.vavg - 256) / 256, -0.1, 0.1)),
      bm: round4(clamp(-(stats.uavg - 128) / 128, -0.1, 0.1)),
    },
  };
  return { stats, correction };
}

/** Peak envelope for the UI: `buckets` values in 0..1, decoded mono at 8 kHz. */
export async function waveformPeaks(path: string, opts: { buckets?: number; signal?: AbortSignal } = {}): Promise<number[]> {
  const { buckets = 800 } = opts;
  assertInt('buckets', buckets, 1, 100_000);
  // ponytail: buffers the whole 8 kHz decode (~58 MB/h); stream into buckets if hour-long sources matter.
  const r = await ffmpeg(['-i', ffInput(path), '-vn', '-ac', '1', '-ar', '8000', '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'], opts.signal);
  const n = Math.floor(r.stdout.length / 2);
  if (n === 0) return [];
  const peaks = new Array<number>(Math.min(buckets, n)).fill(0);
  for (let i = 0; i < n; i++) {
    const b = Math.floor((i * peaks.length) / n);
    const v = Math.abs(r.stdout.readInt16LE(i * 2)) / 32768;
    if (v > peaks[b]!) peaks[b] = v;
  }
  return peaks.map(round4);
}
