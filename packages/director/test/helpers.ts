import type { DirectorRequest, EditPlan, Settings, OutputSpec, ValidationIssue } from '@takeoff/contracts';
import { validate } from '@takeoff/contracts';
import type { Word } from '../src/index.ts';

/**
 * Synthetic words: each token is 300 ms with 50 ms between tokens.
 * `[900]` inserts a 900 ms pause; a token prefixed with `~` gets alignment 'estimated'.
 */
export function words(script: string, assetId = 'take_a', startUs = 1_000_000, prefix = 'w'): Word[] {
  const out: Word[] = [];
  let t = startUs;
  for (const tok of script.split(/\s+/).filter(Boolean)) {
    const pause = /^\[(\d+)\]$/.exec(tok);
    if (pause) {
      t += Number(pause[1]) * 1000;
      continue;
    }
    const estimated = tok.startsWith('~');
    out.push({
      id: `${prefix}${String(out.length + 1).padStart(3, '0')}`,
      assetId,
      text: estimated ? tok.slice(1) : tok,
      sourceStartUs: t,
      sourceEndUs: t + 300_000,
      alignment: estimated ? 'estimated' : 'aligned',
    });
    t += 350_000;
  }
  return out;
}

export const allOn: Settings = {
  badTakes: true,
  fillers: true,
  silence: true,
  captions: true,
  userBroll: false,
  aiBroll: false,
  zoom: true,
  music: true,
  sfx: true,
  studioVoice: true,
  autoColor: false,
  textHook: true,
  motionGraphics: true,
  networkPolicy: 'local_only',
  fillerStrength: 'normal',
};

export function request(ws: Word[], settings: Partial<Settings> = {}, output: Partial<OutputSpec> = {}): DirectorRequest {
  return {
    schemaVersion: '1.0',
    projectId: 'p1',
    revision: 3,
    output: {
      width: 1080,
      height: 1920,
      fps: { num: 30, den: 1 },
      audioSampleRate: 48000,
      colorSpace: 'bt709',
      targetFrames: null,
      lengthPolicy: 'none',
      ...output,
    },
    settings: { ...allOn, ...settings },
    words: ws,
    candidates: [],
    brand: { name: 'Dev', hookTone: 'direct', motionIntensity: 'restrained', glossary: ['Dio'], prohibitedClaims: [] },
  };
}

export const schemaCheck = (plan: EditPlan): ValidationIssue[] => {
  const r = validate('edit-plan', plan);
  return r.ok ? [] : r.errors;
};

export const keptWordIds = (plan: EditPlan) => new Set(plan.segments.flatMap((s) => s.wordIds));
