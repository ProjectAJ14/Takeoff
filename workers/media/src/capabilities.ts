import { statfs } from 'node:fs/promises';
import { FFMPEG, FFPROBE, run } from './run.ts';

/** Filters later stages rely on. drawtext/subtitles are deliberately absent: captions and text render in Chromium. */
export const REQUIRED_FILTERS = ['loudnorm', 'afftdn', 'sidechaincompress', 'zoompan', 'overlay', 'silencedetect', 'astats', 'signalstats'] as const;
export const REQUIRED_ENCODERS = ['libx264', 'aac'] as const;

export interface MediaCapabilities {
  ffmpegVersion: string;
  ffprobeVersion: string;
  encoders: Record<(typeof REQUIRED_ENCODERS)[number], boolean>;
  filters: Record<(typeof REQUIRED_FILTERS)[number], boolean>;
  /** Codec names FFmpeg can decode (decoder names plus their `(codec x)` aliases). */
  decoders: string[];
  /** Required encoders/filters that are missing; empty means the media pipeline can run. */
  missing: string[];
}

const version = (out: string) => /version (\S+)/.exec(out)?.[1] ?? 'unknown';

/** Rows after the `------` rule of `ffmpeg -encoders|-decoders|-filters`; column 2 is the name. */
function listing(out: string, withCodecAlias: boolean): Set<string> {
  const names = new Set<string>();
  const body = out.includes('------') ? out.slice(out.indexOf('------')) : out;
  for (const line of body.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 2) continue;
    names.add(cols[1]!);
    const alias = withCodecAlias && /\(codec (\S+)\)/.exec(line);
    if (alias) names.add(alias[1]!);
  }
  return names;
}

let cached: Promise<MediaCapabilities> | undefined;

/** FFmpeg/ffprobe versions and the encoders, decoders and filters the pipeline needs. Memoised per process. */
export function capabilities(): Promise<MediaCapabilities> {
  cached ??= (async () => {
    const q = (bin: string, flag: string) => run(bin, ['-hide_banner', flag]).then((r) => r.stdout.toString('utf8'));
    const [ffv, fpv, enc, dec, fil] = await Promise.all([
      q(FFMPEG, '-version'),
      q(FFPROBE, '-version'),
      q(FFMPEG, '-encoders'),
      q(FFMPEG, '-decoders'),
      q(FFMPEG, '-filters'),
    ]);
    // -filters has no `------` rule; its rows are "<flags> <name> <io> <desc>".
    const filterSet = listing(fil, false);
    const encSet = listing(enc, false);
    const encoders = Object.fromEntries(REQUIRED_ENCODERS.map((n) => [n, encSet.has(n)])) as MediaCapabilities['encoders'];
    const filters = Object.fromEntries(REQUIRED_FILTERS.map((n) => [n, filterSet.has(n)])) as MediaCapabilities['filters'];
    return {
      ffmpegVersion: version(ffv),
      ffprobeVersion: version(fpv),
      encoders,
      filters,
      decoders: [...listing(dec, true)].sort(),
      missing: [...Object.entries(encoders), ...Object.entries(filters)].filter(([, ok]) => !ok).map(([n]) => n),
    };
  })();
  cached.catch(() => (cached = undefined));
  return cached;
}

export interface DiskPreflight {
  ok: boolean;
  availableBytes: number;
  /** bytesNeeded plus 20% headroom (PRD §12). */
  requiredBytes: number;
}

export async function diskPreflight(root: string, bytesNeeded: number): Promise<DiskPreflight> {
  const s = await statfs(root);
  const availableBytes = s.bavail * s.bsize;
  const requiredBytes = Math.ceil(Math.max(0, bytesNeeded) * 1.2);
  return { ok: availableBytes >= requiredBytes, availableBytes, requiredBytes };
}
