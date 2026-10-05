// Product-owned audio library (F09 music beds, F10 SFX), synthesized by FFmpeg lavfi from fixed arguments.
// Deterministic: seeded noise and bit-exact WAV muxing, so the same FFmpeg build yields the same bytes.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { SfxCategory } from '@takeoff/contracts';

const FFMPEG = process.env.TAKEOFF_FFMPEG ?? 'ffmpeg';
export const LIBRARY_LICENSE = 'Takeoff original, generated';

export interface LibraryItem {
  id: string;
  file: string;
  kind: 'music' | 'sfx';
  /** Music mood or SFX category. */
  category: string;
  durationUs: number;
  sha256: string;
  license: typeof LIBRARY_LICENSE;
}
export interface LibraryManifest {
  version: 1;
  generator: string;
  items: LibraryItem[];
}

const trimTo = (seconds: number) => `,atrim=end_sample=${Math.round(seconds * 48000)}[out]`;
const sine = (f: number, d: number, amp: number) => `sine=f=${f}:r=48000:d=${d},volume=${amp}`;
const noise = (color: string, d: number, amp: number, seed: number) => `anoisesrc=c=${color}:r=48000:d=${d}:a=${amp}:seed=${seed}`;

/** id, kind, category, seconds, filtergraph ending in [out]. Fixed product strings only. */
const RECIPES: Array<[string, 'music' | 'sfx', string, number, string]> = [
  ['bed_calm', 'music', 'calm', 40,
    `${sine(220, 40, 0.25)}[a];${sine(277.18, 40, 0.2)}[b];${sine(329.63, 40, 0.18)}[c];[a][b][c]amix=inputs=3:normalize=0,tremolo=f=0.5:d=0.35,lowpass=f=1400,aecho=0.8:0.6:320:0.3,afade=t=in:d=1.5,afade=t=out:st=38:d=2[out]`],
  ['bed_pulse', 'music', 'focused', 45,
    `${sine(110, 45, 0.3)}[a];${sine(164.81, 45, 0.15)}[b];${noise('pink', 45, 0.04, 7)}[n];[a][b][n]amix=inputs=3:normalize=0,tremolo=f=2:d=0.6,lowpass=f=900,afade=t=in:d=1,afade=t=out:st=43:d=2[out]`],
  ['bed_bright', 'music', 'upbeat', 32,
    `${sine(440, 32, 0.15)}[a];${sine(554.37, 32, 0.12)}[b];${sine(659.25, 32, 0.1)}[c];[a][b][c]amix=inputs=3:normalize=0,tremolo=f=4:d=0.4,aecho=0.8:0.5:180:0.25,lowpass=f=3000,afade=t=in:d=0.5,afade=t=out:st=30:d=2[out]`],
  ['sfx_ui_click', 'sfx', 'ui_click' satisfies SfxCategory, 0.06,
    `${sine(2200, 0.06, 0.5)},afade=t=out:st=0.005:d=0.05:curve=exp[out]`],
  ['sfx_hit', 'sfx', 'hit' satisfies SfxCategory, 0.45,
    `${sine(60, 0.45, 0.7)}[a];${noise('brown', 0.45, 0.3, 11)}[n];[a][n]amix=inputs=2:normalize=0,lowpass=f=400,afade=t=out:st=0.02:d=0.43:curve=exp[out]`],
  ['sfx_whoosh', 'sfx', 'whoosh' satisfies SfxCategory, 0.7,
    `${noise('pink', 0.7, 0.5, 23)},highpass=f=300,lowpass=f=4000,afade=t=in:d=0.35:curve=qsin,afade=t=out:st=0.35:d=0.35:curve=qsin[out]`],
];

function run(args: string[]): Promise<void> {
  return new Promise((ok, fail) => {
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    p.on('error', fail);
    p.on('close', (code) => (code === 0 ? ok() : fail(new Error(`ffmpeg exited with code ${code}`))));
  });
}

/** Writes the music beds and SFX as 48 kHz stereo 16-bit WAV plus `library.json` into `outDir`. */
export async function generateLibraryAudio(outDir: string): Promise<LibraryManifest> {
  await mkdir(outDir, { recursive: true });
  const items: LibraryItem[] = [];
  for (const [id, kind, category, seconds, recipe] of RECIPES) {
    // Echo and fades can run past the nominal length; every file is cut to exactly `seconds`.
    const graph = recipe.replace(/\[out\]$/, trimTo(seconds));
    const file = `${id}.wav`;
    const dest = join(outDir, file);
    const partial = `${dest}.partial`;
    try {
      await run(['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-filter_complex', graph, '-map', '[out]',
        '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', '-fflags', '+bitexact', '-flags:a', '+bitexact', '-f', 'wav', `file:${partial}`]);
      await rename(partial, dest);
    } catch (e) {
      await rm(partial, { force: true });
      throw e;
    }
    const sha256 = createHash('sha256').update(await readFile(dest)).digest('hex');
    items.push({ id, file, kind, category, durationUs: Math.round(seconds * 1e6), sha256, license: LIBRARY_LICENSE });
  }
  const manifest: LibraryManifest = { version: 1, generator: '@takeoff/renderer-browser generateLibraryAudio', items };
  await writeFile(join(outDir, 'library.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
