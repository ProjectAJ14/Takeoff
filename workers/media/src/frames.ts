import { rename, rm } from 'node:fs/promises';
import { MediaError, assertInt, ffInput, ffmpeg, usToSec } from './run.ts';

async function writePng(outPng: string, args: string[], signal?: AbortSignal): Promise<void> {
  const partial = `${outPng}.partial`;
  try {
    await ffmpeg(['-y', ...args, '-frames:v', '1', '-update', '1', '-f', 'image2', '-c:v', 'png', ffInput(partial)], signal);
    // FFmpeg exits 0 with no output when no frame qualifies (e.g. a time at or past the end).
    await rename(partial, outPng).catch((e: NodeJS.ErrnoException) => {
      throw e.code === 'ENOENT' ? new MediaError('invalid_argument', 'no video frame is displayed at that time', 'Pick a time inside the clip.') : e;
    });
  } finally {
    await rm(partial, { force: true });
  }
}

/**
 * Writes the frame displayed at source time `us` (integer microseconds) as PNG, rotation applied:
 * the frame whose half-open interval [pts, next pts) contains `us`, to the source time base's
 * precision. At or past the end of the last frame there is none (`invalid_argument`). Accurate
 * input seek alone returns the first frame *starting* at or after `us` (one frame late mid-frame),
 * so seek to the keyframe before `us` and let `fps` (start_time=0, pts rounded up) emit the latest
 * frame with pts <= `us`.
 */
export async function extractFrame(path: string, us: number, outPng: string, opts: { width?: number; signal?: AbortSignal } = {}): Promise<void> {
  assertInt('us', us, 0, Number.MAX_SAFE_INTEGER);
  if (opts.width !== undefined) assertInt('width', opts.width, 16, 7680);
  const vf = opts.width ? [`scale=${opts.width}:-2`] : [];
  await writePng(outPng, ['-noaccurate_seek', '-ss', usToSec(us), '-i', ffInput(path), '-an', '-vf', ['fps=1:start_time=0:round=up', ...vf].join(',')], opts.signal);
}

/** A representative early frame (FFmpeg `thumbnail` over the first 60 frames), `width` px wide. */
export async function thumbnail(path: string, outPng: string, opts: { width?: number; signal?: AbortSignal } = {}): Promise<void> {
  const { width = 320 } = opts;
  assertInt('width', width, 16, 7680);
  await writePng(outPng, ['-i', ffInput(path), '-an', '-vf', `thumbnail=60,scale=${width}:-2`], opts.signal);
}
