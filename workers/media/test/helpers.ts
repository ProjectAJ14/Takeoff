import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

/** A temp dir removed after the test file finishes. */
export async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'takeoff-media-'));
  after(() => rm(d, { recursive: true, force: true }));
  return d;
}

/** Runs ffmpeg synchronously for fixture generation (synthetic lavfi media only). */
export function gen(...args: string[]): void {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'pipe' });
}

/** 320x240 30 fps H.264 + AAC sine, `sec` long. */
export function genAv(out: string, sec = 2, extra: string[] = []): string {
  gen('-f', 'lavfi', '-i', `testsrc2=s=320x240:r=30:d=${sec}`, '-f', 'lavfi', '-i', `sine=f=440:d=${sec}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', ...extra, out);
  return out;
}
