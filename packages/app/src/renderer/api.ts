// The renderer's only data path: fetch to the engine's loopback API with the session bearer token, and job
// progress as server-sent events read from a fetch stream (EventSource cannot send the token header).
import type { Capabilities, EditPlan, ErrorInfo, Job, PatchOp, Settings, Transcript } from '@takeoff/contracts';

export interface Bridge {
  apiBase: string;
  token: string;
  pickFolder(): Promise<string | null>;
  pickFiles(kind: 'takes' | 'broll'): Promise<string[]>;
  dropFiles(files: File[], kind: 'takes' | 'broll'): Promise<string[]>;
  revealInFolder(path?: string): Promise<boolean>;
  setProviders(projectId: string, policy: unknown): Promise<{ policy?: any; error?: ErrorInfo }>;
}
declare global {
  interface Window {
    takeoff?: Bridge;
  }
}

export const bridge = (): Bridge => {
  if (!window.takeoff?.apiBase) throw new ApiError({ code: 'no_bridge', message: 'the app shell is not connected', remedy: 'Restart Takeoff.' });
  return window.takeoff;
};

export class ApiError extends Error {
  info: ErrorInfo;
  status: number;
  constructor(info: ErrorInfo, status = 0) {
    super(info.message);
    this.info = info;
    this.status = status;
  }
}

export async function api<T = any>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const b = bridge();
  let res: Response;
  try {
    res = await fetch(`${b.apiBase}${path}`, {
      method,
      signal,
      headers: { Authorization: `Bearer ${b.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new ApiError({ code: 'engine_unreachable', message: 'the local engine did not answer', remedy: 'Restart Takeoff.' });
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(json && typeof json.code === 'string' ? json : { code: `http_${res.status}`, message: 'the request failed', remedy: 'Try again.' }, res.status);
  return json as T;
}

/** Streams a job until it is terminal; resolves with the last job seen. */
export async function watchJob(jobId: string, onJob: (j: Job) => void, signal: AbortSignal): Promise<Job | null> {
  const b = bridge();
  const res = await fetch(`${b.apiBase}/v1/jobs/${encodeURIComponent(jobId)}/events`, { headers: { Authorization: `Bearer ${b.token}` }, signal });
  if (!res.ok || !res.body) throw new ApiError({ code: `http_${res.status}`, message: 'job progress is unavailable', remedy: 'Reopen the project.' }, res.status);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  let last: Job | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return last;
    buf += value;
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const data = buf.slice(0, i).split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
      buf = buf.slice(i + 2);
      if (data) onJob((last = JSON.parse(data) as Job));
    }
  }
}

export const mediaUrl = (projectId: string, artifactId: string) => `${bridge().apiBase}/v1/projects/${encodeURIComponent(projectId)}/media/${artifactId}`;

// ---------- DTO shapes the engine returns (snapshot is engine-defined, not a contracts kind) ----------

export interface AssetView {
  id: string;
  kind: 'video' | 'audio' | 'image';
  relativePath: string;
  pool: string | null;
  probe: { durationUs: number | null };
  derived: { proxy: string | null };
}
export interface ArtifactView {
  id: string;
  kind: string;
  ref: string;
  jobId?: string;
  assetId?: string;
}
export interface EditDefaultsView {
  settings: Settings;
  targetSeconds: number | null;
  lengthPolicy: string;
  takes?: string[];
}
export interface Snapshot {
  project: { id: string; name: string; revision: number };
  assets: AssetView[];
  transcripts: Pick<Transcript, 'assetId' | 'words'>[];
  plan: { revision: number; planHash: string; plan: EditPlan } | null;
  revisions: Array<{ revision: number; author: string; op: string | null; createdAt: string }>;
  latestJob: Job | null;
  artifacts: ArtifactView[];
  editDefaults: EditDefaultsView | null;
}
export interface SystemInfo {
  diskFreeBytes: number | null;
  ffmpeg: boolean;
  renderer: boolean;
  fonts: boolean;
}
export type { Capabilities, Job, PatchOp };

export const patchPlan = (projectId: string, baseRevision: number, ops: PatchOp[]) =>
  api<{ revision: number }>('PATCH', `/v1/projects/${encodeURIComponent(projectId)}/plan`, { schemaVersion: '1.0', baseRevision, ops });

export const newKey = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

/** Message + remedy for display. */
export const describe = (e: unknown): ErrorInfo =>
  e instanceof ApiError ? e.info : { code: 'error', message: e instanceof Error ? e.message : 'something went wrong', remedy: 'Try again.' };
