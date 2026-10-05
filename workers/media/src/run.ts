import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';

export const FFMPEG = process.env.TAKEOFF_FFMPEG ?? 'ffmpeg';
export const FFPROBE = process.env.TAKEOFF_FFPROBE ?? 'ffprobe';

export type MediaErrorCode =
  | 'not_found'
  | 'corrupt'
  | 'no_streams'
  | 'unsupported_codec'
  | 'unsupported_dimensions'
  | 'disk_full'
  | 'ffmpeg_missing'
  | 'ffmpeg_failed'
  | 'invalid_argument';

/** Shaped like contracts `ErrorInfo`: a stable code, a message and a user remedy. Messages never carry paths. */
export class MediaError extends Error {
  code: MediaErrorCode;
  remedy: string;
  constructor(code: MediaErrorCode, message: string, remedy: string) {
    super(message);
    this.name = 'MediaError';
    this.code = code;
    this.remedy = remedy;
  }
}

export interface RunResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

const STDERR_CAP = 32 * 1024 * 1024;

/** Spawns a binary with an argument array (never a shell). Aborting the signal kills the child and rejects with an AbortError. */
export function run(bin: string, args: string[], signal?: AbortSignal): Promise<RunResult> {
  return new Promise((ok, fail) => {
    const child = spawn(bin, args, { signal, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => {
      if (err.length < STDERR_CAP) err += c.toString('utf8');
    });
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') fail(new MediaError('ffmpeg_missing', `${bin} was not found`, 'Install FFmpeg (ffmpeg and ffprobe) or set TAKEOFF_FFMPEG / TAKEOFF_FFPROBE.'));
      else fail(e);
    });
    child.on('close', (code) => {
      if (signal?.aborted) return fail(signal.reason ?? new DOMException('aborted', 'AbortError'));
      ok({ code: code ?? -1, stdout: Buffer.concat(out), stderr: err });
    });
  });
}

/** Runs ffmpeg and throws `ffmpeg_failed` on a non-zero exit. The stderr tail is kept off the message (it may hold paths). */
export async function ffmpeg(args: string[], signal?: AbortSignal): Promise<RunResult> {
  const r = await run(FFMPEG, ['-hide_banner', '-nostdin', '-nostats', ...args], signal);
  if (r.code !== 0) throw new MediaError('ffmpeg_failed', `ffmpeg exited with code ${r.code}`, 'The file may be damaged or use an unsupported feature; try re-exporting it as H.264/AAC MP4.');
  return r;
}

/** `file:` prefix stops FFmpeg reading a name as a protocol (`http:`, `concat:`) or an option (`-x`). */
export const ffInput = (path: string): string => `file:${resolve(path)}`;

/** Integer microseconds to an exact decimal-seconds string. */
export const usToSec = (us: number): string => (us / 1e6).toFixed(6);

export async function hashFile(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

export function assertInt(name: string, v: number, min: number, max: number): void {
  if (!Number.isSafeInteger(v) || v < min || v > max) throw new MediaError('invalid_argument', `${name} must be an integer in [${min}, ${max}]`, 'Pass a value in range.');
}

export function assertNum(name: string, v: number, min: number, max: number): void {
  if (!Number.isFinite(v) || v < min || v > max) throw new MediaError('invalid_argument', `${name} must be a number in [${min}, ${max}]`, 'Pass a value in range.');
}
