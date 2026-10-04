// Versioned loopback HTTP API (PRD §8, §14). Bound to 127.0.0.1 only; every request needs the
// session bearer token and a loopback Host header (DNS-rebinding guard); browsers may call it only
// from the app's own origin. Bodies are JSON, capped at 1 MB, validated before anything runs.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { validate, type ErrorInfo } from '@takeoff/contracts';
import { StaleRevisionError } from '@takeoff/project-store';
import type { Engine } from './engine.ts';
import { EngineError, toErrorInfo } from './errors.ts';
import { planRequest } from './requests.ts';
import { badRequest, inspectFrames, isTerminal, mediaFile, requireEditDefaults, setEditDefaults, snapshot, startJob, type Workspace } from './workspace.ts';

export const MAX_BODY_BYTES = 1024 * 1024;
const SSE_INTERVAL_MS = 250;

export interface ServerOptions {
  /** 0 (default) picks a free port. */
  port?: number;
  /** Session token; generated (32 random bytes) when omitted. */
  token?: string;
  /** The packaged app's origin, if it is not `null` (file://). Exact match. */
  appOrigin?: string;
}
export interface RunningServer {
  url: string;
  port: number;
  host: '127.0.0.1';
  token: string;
  close(): Promise<void>;
}

class HttpError extends Error {
  status: number;
  info: ErrorInfo;
  constructor(status: number, code: string, message: string, remedy: string) {
    super(message);
    this.status = status;
    this.info = { code, message, remedy };
  }
}

const STATUS: Record<string, number> = {
  not_found: 404, path_not_approved: 403, stale_revision: 409, project_exists: 409, locked_object: 409, nothing_to_undo: 409, nothing_to_redo: 409,
  revision_not_found: 404, internal: 500, renderer_unavailable: 503, egress_denied: 403, network_denied: 403, director_unavailable: 503, brand_not_found: 404,
};
const statusOf = (code: string) => STATUS[code] ?? (code.startsWith('invalid') ? 400 : 422);

const digest = (s: string) => createHash('sha256').update(s).digest();

export function startServer(ws: Workspace, opts: ServerOptions = {}): Promise<RunningServer> {
  const token = opts.token ?? randomBytes(32).toString('base64url');
  if (token.length < 16) throw new EngineError('invalid_token', 'the session token is too short', 'Use at least 16 characters.');
  const want = digest(`Bearer ${token}`);
  let port = 0;

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (res.headersSent) return void res.destroy();
      const info = e instanceof HttpError ? e.info : toErrorInfo(e);
      const status = e instanceof HttpError ? e.status : e instanceof StaleRevisionError ? 409 : statusOf(info.code);
      send(res, status, info);
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Host first: a rebinding page reaching us under another name never gets further.
    const host = req.headers.host;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(421, 'bad_host', 'unexpected Host header', 'Call the API at 127.0.0.1.');
    const origin = req.headers.origin;
    const originOk = origin === undefined || origin === 'null' || (!!opts.appOrigin && origin === opts.appOrigin);
    if (!originOk) throw new HttpError(403, 'bad_origin', 'this origin may not call the Takeoff API', 'Use the Takeoff app.');
    if (origin !== undefined) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, PATCH', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Range', 'Access-Control-Max-Age': '600' });
      return void res.end();
    }
    const got = digest(String(req.headers.authorization ?? ''));
    if (!timingSafeEqual(got, want)) throw new HttpError(401, 'unauthorized', 'missing or wrong session token', 'Send Authorization: Bearer <token>.');
    await route(req, res);
  }

  async function body(req: IncomingMessage): Promise<any> {
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) throw new HttpError(413, 'body_too_large', 'the request body is over 1 MB', 'Send a smaller request.');
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of req as AsyncIterable<Buffer>) {
      n += c.length;
      if (n > MAX_BODY_BYTES) throw new HttpError(413, 'body_too_large', 'the request body is over 1 MB', 'Send a smaller request.');
      chunks.push(c);
    }
    if (!n) return {};
    let v: unknown;
    try {
      v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new HttpError(400, 'invalid_json', 'the body is not JSON', 'Send a JSON body.');
    }
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'invalid_json', 'the body must be a JSON object', 'Send a JSON object.');
    return v;
  }

  const dto = <K extends Parameters<typeof validate>[0]>(kind: K, value: unknown) => {
    const v = validate(kind, value);
    if (!v.ok) throw new HttpError(400, 'invalid_request', `the ${kind} body is invalid (${v.errors.slice(0, 3).map((e) => `${e.path || '/'} ${e.message}`).join('; ')})`, 'Fix the request to match the schema.');
    return v.value;
  };
  const key = (k: unknown) => {
    if (k === undefined) return randomUUID();
    if (typeof k !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(k)) throw badRequest('idempotencyKey must be 8–128 letters, digits, _ or -');
    return k;
  };
  const optInt = (x: unknown, name: string) => {
    if (x !== undefined && !(Number.isSafeInteger(x) && (x as number) >= 0)) throw badRequest(`${name} must be a non-negative integer`);
    return x as number | undefined;
  };
  const revisionOf = (s: { revision: number; planHash: string }) => ({ schemaVersion: '1.0', revision: s.revision, planHash: s.planHash });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let parts: string[];
    try {
      parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    } catch {
      throw new HttpError(400, 'invalid_request', 'the URL is not valid percent-encoding', 'Encode path segments with encodeURIComponent.');
    }
    const m = `${req.method} /${parts.map((p, i) => (i >= 2 && i % 2 === 0 ? ':' : p)).join('/')}`;
    if (parts[0] !== 'v1') throw new HttpError(404, 'not_found', 'unknown route', 'Use a /v1 route.');
    const id = parts[2]!;
    const project = (): Engine => ws.byId(id);

    switch (m) {
      case 'GET /v1/capabilities':
        return send(res, 200, (await ws.capabilities()).dto);
      case 'GET /v1/system': {
        // Machine facts the capabilities DTO has no field for (first-run check, PRD §5.1).
        const { diskFreeBytes, ffmpeg, renderer, fonts } = await ws.capabilities();
        return send(res, 200, { schemaVersion: '1.0', diskFreeBytes, ffmpeg, renderer, fonts });
      }
      case 'GET /v1/projects':
        return send(res, 200, { schemaVersion: '1.0', projects: ws.list() });
      case 'POST /v1/projects': {
        const b = dto('create-project-request', await body(req));
        // The DTO carries no location: a picker-approved ?root= or a new folder under <appData>/projects.
        const root = url.searchParams.get('root') ?? join(ws.appDataDir, 'projects', randomUUID());
        const e = ws.create(root, b.name, b.settings && { settings: b.settings });
        return send(res, 201, { schemaVersion: '1.0', projectId: e.projectId, revision: e.store.currentRevision() });
      }
      case 'GET /v1/projects/:':
        return send(res, 200, snapshot(project()));
      case 'POST /v1/projects/:/assets': {
        const b = dto('import-assets-request', await body(req));
        const pool = (url.searchParams.get('pool') ?? 'takes') as 'takes';
        if (b.items.some((i) => i.source !== 'path')) throw new HttpError(400, 'upload_unsupported', 'uploads are not supported yet', 'Import by picker-authorised path.');
        const items = await project().importAssets(b.items.map((i) => (i as { path: string }).path), { pool });
        // Imports run synchronously per file, so items carry results or per-file errors, not job ids.
        return send(res, 200, { schemaVersion: '1.0', items });
      }
      case 'POST /v1/projects/:/jobs': {
        const b = dto('create-job-request', await body(req));
        const e = project();
        let job;
        if (b.stage === 'Prepare') {
          if (b.profile !== 'draft') throw badRequest('Edit Video renders a draft; use /exports for final output');
          const d = requireEditDefaults(e);
          job = startJob(e, b.idempotencyKey, () => e.runPipeline({ ...d, idempotencyKey: b.idempotencyKey, baseRevision: b.baseRevision }));
        } else if (b.stage === 'Transcribe') {
          job = startJob(e, b.idempotencyKey, () => e.transcribe({ idempotencyKey: b.idempotencyKey }));
        } else if (b.stage === 'Build graphics' || b.stage === 'Render preview' || b.stage === 'Check quality') {
          if (b.profile !== 'draft') throw badRequest('use /exports for final renders');
          if (b.baseRevision !== e.store.currentRevision()) throw new StaleRevisionError(b.baseRevision, e.store.currentRevision());
          job = startJob(e, b.idempotencyKey, () => e.renderAffected(b.idempotencyKey));
        } else throw badRequest(`stage ${b.stage} cannot be started on its own`, b.stage === 'Export' ? 'POST /v1/projects/{id}/exports.' : 'Start Prepare (Edit Video).');
        return send(res, 202, job);
      }
      case 'GET /v1/jobs/:':
        return send(res, 200, ws.findJob(id).job);
      case 'POST /v1/jobs/:/cancel': {
        const { engine } = ws.findJob(id);
        const ok = engine.cancel(id);
        return send(res, ok ? 202 : 409, ok ? engine.getJob(id) : { code: 'not_cancelable', message: 'the job has already finished', remedy: 'Nothing to cancel.' });
      }
      case 'GET /v1/jobs/:/events':
        return events(req, res, id);
      case 'GET /v1/projects/:/plan': {
        const head = project().getPlan();
        if (!head) throw new HttpError(404, 'no_plan', 'the project has no plan yet', 'Run Edit Video first.');
        return send(res, 200, { schemaVersion: '1.0', revision: head.revision, planHash: head.planHash, plan: head.plan });
      }
      case 'PATCH /v1/projects/:/plan':
        return send(res, 200, revisionOf(project().applyPatch(dto('patch', await body(req)))));
      case 'POST /v1/projects/:/undo':
      case 'POST /v1/projects/:/redo': {
        const b = await body(req);
        const e = project();
        const base = optInt(b.baseRevision, 'baseRevision');
        return send(res, 200, revisionOf(parts[3] === 'undo' ? e.undo(base) : e.redo(base)));
      }
      case 'POST /v1/projects/:/revert': {
        const b = await body(req);
        const rev = optInt(b.revision, 'revision');
        if (rev === undefined) throw badRequest('revision is required');
        return send(res, 200, revisionOf(project().revert(rev, optInt(b.baseRevision, 'baseRevision'))));
      }
      case 'POST /v1/projects/:/frames':
        return send(res, 200, await inspectFrames(project(), await body(req)));
      case 'POST /v1/projects/:/qa': {
        const b = await body(req);
        const e = project();
        const head = e.getPlan();
        if (!head) throw new HttpError(404, 'no_plan', 'the project has no plan yet', 'Run Edit Video first.');
        if (b.planHash !== undefined && b.planHash !== head.planHash) throw new HttpError(409, 'stale_revision', 'the plan changed since that hash', 'Reload the plan and run QA again.');
        const k = key(b.idempotencyKey ?? `qa-${head.revision}-${head.planHash.slice(0, 16)}`);
        return send(res, 202, startJob(e, k, () => e.renderAffected(k)));
      }
      case 'POST /v1/projects/:/exports': {
        const b = await body(req);
        if (b.schemaVersion !== '1.0') throw badRequest('schemaVersion must be "1.0"');
        if (typeof b.destinationDir !== 'string') throw badRequest('destinationDir is required');
        if (b.burnCaptions !== undefined && typeof b.burnCaptions !== 'boolean') throw badRequest('burnCaptions must be a boolean');
        const e = project();
        const k = key(b.idempotencyKey);
        const opts = { profile: b.profile, destinationDir: b.destinationDir, burnCaptions: b.burnCaptions ?? true, idempotencyKey: k };
        e.approvedPath(b.destinationDir); // refuse before starting the job
        return send(res, 202, startJob(e, k, () => e.exportProject(opts)));
      }
      case 'POST /v1/projects/:/edit-defaults': {
        const b = await body(req);
        const known = ['settings', 'targetSeconds', 'lengthPolicy', 'takes', 'brandProfileId', 'brief', 'captionTemplate', 'zoomMaxScale'];
        const extra = Object.keys(b).find((k) => !known.includes(k));
        if (extra) throw badRequest(`unknown field ${extra.slice(0, 40)}`);
        if (b.settings !== undefined && (b.settings === null || typeof b.settings !== 'object' || Array.isArray(b.settings))) throw badRequest('settings must be an object');
        return send(res, 200, { schemaVersion: '1.0', editDefaults: setEditDefaults(project(), b) });
      }
      case 'POST /v1/projects/:/brands': {
        const id = await project().saveBrandProfile(await body(req));
        return send(res, 201, { schemaVersion: '1.0', ref: id });
      }
      case 'GET /v1/projects/:/providers':
        return send(res, 200, { schemaVersion: '1.0', policy: project().broker.policy() });
      // No POST: approving a provider widens egress, so only the desktop main process (in-process, after a
      // user action) may call broker.setPolicy. An API caller must not grant itself transfers (PRD §14).
      case 'POST /v1/projects/:/requests': {
        const b = await body(req);
        const e = project();
        const { intents, patch } = await planRequest(e, b.text, b.baseRevision);
        return send(res, 200, { ...revisionOf(e.applyPatch(patch)), intents, ops: patch.ops.length });
      }
      case 'POST /v1/diagnostics': {
        const b = await body(req);
        if (typeof b.destinationDir !== 'string') throw badRequest('destinationDir is required');
        return send(res, 201, { schemaVersion: '1.0', dir: await ws.diagnosticBundle(b.destinationDir) });
      }
      case 'POST /v1/starter-pack': {
        const b = await body(req);
        return send(res, 200, await ws.starterPack({ allowNetwork: b.allowNetwork === true }));
      }
    }
    if (req.method === 'GET' && parts.length === 5 && parts[1] === 'projects' && parts[3] === 'media') return media(req, res, mediaFile(project(), parts[4]!));
    throw new HttpError(404, 'not_found', 'unknown route', 'See the API table in the engine docs.');
  }

  function media(req: IncomingMessage, res: ServerResponse, f: { abs: string; type: string }): void {
    const size = statSync(f.abs).size;
    const range = req.headers.range;
    const headers = { 'Content-Type': f.type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
    if (!range) {
      res.writeHead(200, { ...headers, 'Content-Length': size });
      return void stream(f.abs, res);
    }
    const r = /^bytes=(\d*)-(\d*)$/.exec(range);
    let start = r?.[1] ? Number(r[1]) : NaN;
    let end = r?.[2] ? Number(r[2]) : size - 1;
    if (r && !r[1] && r[2]) [start, end] = [Math.max(0, size - Number(r[2])), size - 1]; // suffix range
    end = Math.min(end, size - 1);
    if (!r || !(start >= 0) || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return void res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}` });
    stream(f.abs, res, { start, end });
  }

  function events(req: IncomingMessage, res: ServerResponse, jobId: string): void {
    const { engine } = ws.findJob(jobId);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    let last = '';
    // Polling the store is the throttle: at most one event per interval, only when the job changed.
    const tick = () => {
      const job = engine.getJob(jobId);
      if (!job) return stop();
      const s = JSON.stringify(job);
      if (s !== last) res.write(`event: job\ndata: ${(last = s)}\n\n`);
      if (isTerminal(job)) stop();
    };
    const timer = setInterval(tick, SSE_INTERVAL_MS);
    const stop = () => (clearInterval(timer), res.end());
    req.on('close', () => clearInterval(timer));
    tick();
  }

  return new Promise((resolveP, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port;
      resolveP({
        url: `http://127.0.0.1:${port}`,
        port,
        host: '127.0.0.1',
        token,
        close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))),
      });
    });
  });
}

/** A file vanishing mid-response ends that response; it must never crash the server. */
function stream(abs: string, res: ServerResponse, range?: { start: number; end: number }): void {
  createReadStream(abs, range).on('error', () => res.destroy()).pipe(res);
}

function send(res: ServerResponse, status: number, value: unknown): void {
  const s = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(s);
}
