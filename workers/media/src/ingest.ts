import { copyFile, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import { diskPreflight } from './capabilities.ts';
import { probe, type ProbeResult } from './probe.ts';
import { MediaError, ffInput, ffmpeg, hashFile } from './run.ts';

export interface Derivative {
  /** Project-relative, `/`-separated. */
  path: string;
  sha256: string;
  /** True when a verified final file from an earlier run was reused. */
  reused: boolean;
}

export interface IngestResult {
  contentHash: string;
  /** Project-relative path of the original (in place, or the copy under media/originals). */
  relativePath: string;
  copied: boolean;
  probe: ProbeResult;
  /** Proxy frame rate (integer, CFR). Proxy frame i maps to source time probe.startUs + i/proxyFps s. */
  proxyFps: number | null;
  derived: {
    /** H.264 CFR MP4, short side ≤540 px, rotation applied. Null for audio-only sources. */
    proxy: Derivative | null;
    /** Mono 16 kHz s16 WAV for VAD/ASR/silence analysis. Null when there is no audio. */
    analysisWav: Derivative | null;
    /** Stereo 48 kHz s16 WAV, the dialogue master for the mix. Null when there is no audio. */
    masterWav: Derivative | null;
  };
}

export interface IngestOptions {
  signal?: AbortSignal;
}

/** Same rule as contracts `relPath` (which also caps length at 512). */
const REL_PATH = /^(?!\/)(?![A-Za-z]:)(?!(?:.*\/)?\.\.(?:\/|$))[A-Za-z0-9._/-]+$/;
// ponytail: flat bitrate guesses for preflight; replace with measured sizes once benchmarks exist.
const PROXY_BYTES_PER_SEC = 2_500_000 / 8;
const WAV_BYTES_PER_SEC = 16000 * 2 + 48000 * 2 * 2;
// Short side to 540 px, never upscaled, even dimensions. Constant: no untrusted text reaches the filter graph.
const PROXY_SCALE = "scale=w='if(gt(iw,ih),-2,trunc(min(540,iw)/2)*2)':h='if(gt(iw,ih),trunc(min(540,ih)/2)*2,-2)'";

/** Source rate rounded to an integer and capped at 30; 30 when unknown. */
export const proxyFpsFor = (p: ProbeResult): number =>
  p.video?.fpsNum && p.video.fpsDen ? Math.min(30, Math.max(1, Math.round(p.video.fpsNum / p.video.fpsDen))) : 30;

async function atomicWrite(path: string, data: string): Promise<void> {
  await writeFile(`${path}.partial`, data);
  await rename(`${path}.partial`, path);
}

const exists = (p: string) => stat(p).then(() => true, () => false);

/**
 * Imports one source into a project without modifying it.
 *
 * Originals: a file already inside `projectRoot` whose relative path is portable is referenced
 * in place. Anything else is copied to `media/originals/<sha256><ext>` (the manifest needs a
 * project-relative path) and the copy is hash-verified. The source is only ever read.
 *
 * Derivatives go to `media/derived/<sha256>/`, each written as `<name>.partial` then renamed.
 * `derived.json` records each final's hash; a rerun reuses a final whose hash still matches and
 * deletes leftover partials. Aborting `signal` kills FFmpeg and removes the partial.
 */
export async function ingest(srcPath: string, projectRoot: string, opts: IngestOptions = {}): Promise<IngestResult> {
  const { signal } = opts;
  const root = await realpath(projectRoot);
  const src = await realpath(srcPath).catch(() => {
    throw new MediaError('not_found', 'the source file is missing', 'Relink the file from its new location.');
  });
  const p = await probe(src, signal);
  const contentHash = await hashFile(src);
  signal?.throwIfAborted();

  const rel = relative(root, src).split(sep).join('/');
  const inPlace = !isAbsolute(rel) && rel.length <= 512 && REL_PATH.test(rel);
  const ext = /^\.[A-Za-z0-9]{1,8}$/.test(extname(src)) ? extname(src).toLowerCase() : '';
  const relativePath = inPlace ? rel : `media/originals/${contentHash}${ext}`;

  const sizeBytes = (await stat(src)).size;
  const sec = (p.durationUs ?? 0) / 1e6;
  const need = (inPlace ? 0 : sizeBytes) + sec * ((p.video ? PROXY_BYTES_PER_SEC : 0) + (p.audio ? WAV_BYTES_PER_SEC : 0));
  const disk = await diskPreflight(root, need);
  if (!disk.ok)
    throw new MediaError('disk_full', `import needs about ${disk.requiredBytes} bytes free (with 20% headroom); ${disk.availableBytes} are available`, 'Free disk space or purge the project cache, then retry; completed files are kept.');

  let copied = false;
  if (!inPlace) {
    const dest = join(root, relativePath);
    if (!((await exists(dest)) && (await hashFile(dest)) === contentHash)) {
      await mkdir(join(root, 'media/originals'), { recursive: true });
      await rm(`${dest}.partial`, { force: true });
      await copyFile(src, `${dest}.partial`);
      if ((await hashFile(`${dest}.partial`)) !== contentHash) {
        await rm(`${dest}.partial`, { force: true });
        throw new MediaError('ffmpeg_failed', 'the copied original does not match the source hash', 'Check the disk for errors and retry the import.');
      }
      await rename(`${dest}.partial`, dest);
      copied = true;
    }
  }

  const dirRel = `media/derived/${contentHash}`;
  const dir = join(root, dirRel);
  await mkdir(dir, { recursive: true });
  for (const f of await readdir(dir)) if (f.endsWith('.partial')) await rm(join(dir, f), { force: true });
  const recordPath = join(dir, 'derived.json');
  const record: Record<string, string> = await readFile(recordPath, 'utf8').then((s) => JSON.parse(s) as Record<string, string>, () => ({}));

  const derive = async (name: string, outArgs: string[]): Promise<Derivative> => {
    const final = join(dir, name);
    const path = `${dirRel}/${name}`;
    if (record[name] && (await exists(final)) && (await hashFile(final)) === record[name]) return { path, sha256: record[name], reused: true };
    const partial = `${final}.partial`;
    try {
      await ffmpeg(['-y', '-i', ffInput(src), ...outArgs, ffInput(partial)], signal);
      const sha256 = await hashFile(partial);
      await rename(partial, final);
      record[name] = sha256;
      await atomicWrite(recordPath, JSON.stringify(record, null, 2));
      return { path, sha256, reused: false };
    } finally {
      await rm(partial, { force: true });
    }
  };

  const fps = p.video && p.kind === 'video' ? proxyFpsFor(p) : null;
  const audioOut = p.audio ? ['-map', '0:a:0', '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000'] : ['-an'];
  // FFmpeg autorotate (on by default) applies the display matrix once and drops it from the output.
  const proxy = fps
    ? await derive('proxy.mp4', [
        '-map', '0:v:0', '-vf', `fps=${fps},${PROXY_SCALE}`, '-fps_mode', 'cfr',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-g', String(fps * 2),
        ...audioOut, '-sn', '-dn', '-map_metadata', '-1', '-movflags', '+faststart', '-f', 'mp4',
      ])
    : null;
  const wav = (ch: number, rate: number) => ['-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', String(ch), '-ar', String(rate), '-c:a', 'pcm_s16le', '-map_metadata', '-1', '-f', 'wav'];
  const analysisWav = p.audio ? await derive('analysis.wav', wav(1, 16000)) : null;
  const masterWav = p.audio ? await derive('master.wav', wav(2, 48000)) : null;

  return { contentHash, relativePath, copied, probe: p, proxyFps: fps, derived: { proxy, analysisWav, masterWav } };
}
