// Pure request and content policy for the desktop shell, unit-tested without Electron.

export const ORIGIN = 'app://takeoff';

const isLoopback = (u: URL) => u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';

/** Requests any web contents may make: the app's own files, in-memory media and loopback. Everything else is cancelled (PRD §14). */
export function allowedRequest(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol === 'app:') return u.host === 'takeoff';
  if (u.protocol === 'blob:' || u.protocol === 'data:' || u.protocol === 'devtools:') return true;
  return u.protocol === 'http:' && isLoopback(u);
}

/** The renderer's Content-Security-Policy: own files, plus the engine API on its port. */
export function csp(port: number): string {
  const api = `http://127.0.0.1:${port}`;
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "font-src 'self'",
    `connect-src ${api}`,
    `img-src 'self' ${api} blob: data:`,
    `media-src 'self' ${api} blob: data:`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** The only API path main attaches the token to on the renderer's behalf (media elements cannot send headers). */
export const isMediaPath = (pathname: string) => /^\/v1\/projects\/[^/]+\/media\/[0-9a-f]{64}$/.test(pathname);

export const POOLS = { takes: ['mp4', 'mov', 'm4v'], broll: ['mp4', 'mov', 'm4v', 'png', 'jpg', 'jpeg'] } as const;
export type PoolKind = keyof typeof POOLS;
export const isPool = (k: unknown): k is PoolKind => typeof k === 'string' && Object.hasOwn(POOLS, k);

/** Test hooks (temp userData, stubbed pickers) never run in a packaged app, whatever the env or argv. */
export const testHooksEnabled = (isPackaged: boolean, nodeEnv: string | undefined, argv: readonly string[]) => !isPackaged && (nodeEnv === 'test' || argv.includes('--test'));
