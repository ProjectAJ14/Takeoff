// Synthetic context for the PRD 9.3 example plan. No media is read or written.
import { readFileSync } from 'node:fs';
import type { AssetManifest, EditPlan, Transcript, TranscriptWord } from '@takeoff/contracts';
import type { PlanContext } from '../src/index.ts';

const contracts = new URL('../../contracts/fixtures/valid/', import.meta.url).pathname;
const read = <T>(rel: string): T => JSON.parse(readFileSync(contracts + rel, 'utf8')) as T;

export const examplePlan = (): EditPlan => read<EditPlan>('edit-plan/example-edit-plan.json');

export function manifest(id: string, kind: 'video' | 'audio', durationUs: number): AssetManifest {
  const m = read<AssetManifest>('asset-manifest/rotated-vfr-video.json');
  return { ...m, id, kind, probe: { ...m.probe, durationUs, video: kind === 'video' ? m.probe.video : null } };
}

export function transcript(assetId: string, words: Array<[string, number, number]>): Transcript {
  const t = read<Transcript>('transcript/words-and-corrections.json');
  const ws: TranscriptWord[] = words.map(([id, s, e]) => ({
    id, text: id, correctedText: null, sourceStartUs: s, sourceEndUs: e, score: null, alignment: 'aligned', speaker: null,
  }));
  return { ...t, assetId, words: ws, sentences: [] };
}

/** w01..w11 inside [1s, 4s): word i starts at 1s + i*270ms and lasts 250ms. */
export const exampleWords: Array<[string, number, number]> = Array.from({ length: 11 }, (_, i) => {
  const s = 1_000_000 + i * 270_000;
  return [`w${String(i + 1).padStart(2, '0')}`, s, s + 250_000];
});

export const exampleCtx = (): PlanContext => ({
  transcripts: { take_a: transcript('take_a', exampleWords) },
  manifests: { take_a: manifest('take_a', 'video', 12_000_000), music_a: manifest('music_a', 'audio', 60_000_000) },
});

/** mulberry32: small seeded PRNG so property runs are reproducible. */
export function rng(seed: number): (n: number) => number {
  let a = seed >>> 0;
  return (n: number) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}
