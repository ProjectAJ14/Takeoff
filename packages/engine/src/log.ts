// Structured JSONL logs (PRD §14). Only allowlisted keys survive; strings must look like ids or codes.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const LOG_KEYS = new Set([
  'projectId', 'jobId', 'stage', 'durationMs', 'cacheHit', 'counts', 'codes', 'code', 'fps',
  'qaOutcome', 'fallbackCount', 'retryCount', 'state', 'revision', 'attempt',
]);
/** Ids (UUIDs fit), codes and stage names: no `/` or `\` (paths), no spaces (text), ≤40 chars (API keys are longer). */
const SAFE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,39}$/;
const STAGE = /^(Prepare|Transcribe|Clean speech|Plan visuals\/audio|Build graphics|Render preview|Check quality|Export)$/;

function clean(v: unknown, depth = 0): unknown {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'boolean' || v === null) return v;
  if (typeof v === 'string') return SAFE.test(v) || STAGE.test(v) ? v : undefined;
  if (depth > 1) return undefined;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => clean(x, depth + 1)).filter((x) => x !== undefined);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const c = SAFE.test(k) ? clean(x, depth + 1) : undefined;
      if (c !== undefined) out[k] = c;
    }
    return out;
  }
  return undefined;
}

/** Drops every key not in LOG_KEYS and every string that is not an id/code (paths, transcript text, keys). */
export function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!LOG_KEYS.has(k)) continue;
    const c = clean(v);
    if (c !== undefined) out[k] = c;
  }
  return out;
}

export class Logger {
  readonly file: string;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'engine.jsonl');
  }
  log(event: string, fields: Record<string, unknown> = {}): void {
    const line = { ts: new Date().toISOString(), event: SAFE.test(event) ? event : 'event', ...redact(fields) };
    try {
      appendFileSync(this.file, JSON.stringify(line) + '\n');
    } catch {
      // logging never fails a job
    }
  }
}
