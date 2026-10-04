import type { ErrorInfo } from '@takeoff/contracts';

/** Typed engine failure, shaped like contracts `ErrorInfo`. Messages never carry paths, transcript text or secrets. */
export class EngineError extends Error {
  code: string;
  remedy: string;
  constructor(code: string, message: string, remedy: string) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.remedy = remedy;
  }
  get info(): ErrorInfo {
    return { code: this.code, message: this.message, remedy: this.remedy };
  }
}

const CODE = /^[a-z][a-z0-9_]{0,63}$/;

/** Any thrown value as an ErrorInfo. Untyped errors keep only their class name: their text may hold paths. */
export function toErrorInfo(e: unknown): ErrorInfo {
  const x = e as { code?: unknown; message?: unknown; remedy?: unknown; name?: unknown };
  if (e instanceof Error && typeof x.code === 'string' && CODE.test(x.code) && typeof x.remedy === 'string' && x.remedy) {
    return { code: x.code, message: String(x.message || x.code).slice(0, 2000), remedy: x.remedy.slice(0, 2000) };
  }
  if (e instanceof Error && e.name === 'StaleRevisionError') return { code: 'stale_revision', message: e.message, remedy: 'Reload the plan and apply the change to the current revision.' };
  const name = e instanceof Error ? e.name : 'Error';
  return { code: 'internal', message: `internal error (${name})`, remedy: 'Retry; if it repeats, create a diagnostic bundle.' };
}

export const isAbort = (e: unknown): boolean => e instanceof Error && (e.name === 'AbortError' || (e as { code?: string }).code === 'ABORT_ERR');
