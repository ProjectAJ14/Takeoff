// Minimal MCP server over stdio (JSON-RPC 2.0, one message per line). The tools mirror the HTTP API
// (PRD §8) and enforce the same rules: projects resolve under the approved roots given at start,
// patches need baseRevision, every plan is validated. There is no shell tool.
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { ENGINE_VERSION, type PipelineResult } from './engine.ts';
import { EngineError, toErrorInfo } from './errors.ts';
import { checkPlan, inspectFrames, setEditDefaults, snapshot, type Workspace } from './workspace.ts';

export const MCP_PROTOCOL_VERSION = '2025-06-18';

const project = { type: 'string', minLength: 1, maxLength: 4096, description: 'Project folder (must be under an approved root).' };
const key = { type: 'string', pattern: '^[A-Za-z0-9_-]{8,128}$', description: 'Idempotency key; the same key returns the same job.' };
const rev = { type: 'integer', minimum: 0 };
const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });

export const TOOLS = [
  { name: 'inspect_project', description: 'Assets, transcript words, current plan and revision, history, latest job and artifacts.', inputSchema: obj({ project }, ['project']) },
  { name: 'import_assets', description: 'Import media files (each under an approved root) into a pool. Each file succeeds or fails on its own.', inputSchema: obj({ project, paths: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 4096 }, minItems: 1, maxItems: 100 }, pool: { enum: ['takes', 'broll', 'music', 'sfx'] } }, ['project', 'paths', 'pool']) },
  { name: 'transcribe', description: 'Transcribe every take locally (cached by source hash). Returns the job.', inputSchema: obj({ project, idempotencyKey: key }, ['project']) },
  {
    name: 'propose_edit',
    description: 'Run the full edit pipeline (clean speech, plan, render a draft, QA). Settings merge over the project\'s stored toggles; the first call must set every toggle.',
    inputSchema: obj({ project, baseRevision: rev, settings: { type: 'object' }, targetSeconds: { type: ['integer', 'null'], minimum: 10, maximum: 180 }, lengthPolicy: { enum: ['hard_max', 'soft_target', 'none'] }, idempotencyKey: key }, ['project', 'baseRevision']),
  },
  { name: 'validate_plan', description: 'Validate an edit plan: schema always, semantic checks when a project is given.', inputSchema: obj({ plan: { type: 'object' }, project }, ['plan']) },
  { name: 'apply_patch', description: 'Apply allowlisted patch ops to the current plan. patch.baseRevision must equal the current revision, otherwise stale_revision.', inputSchema: obj({ project, patch: { type: 'object', required: ['schemaVersion', 'baseRevision', 'ops'] } }, ['project', 'patch']) },
  { name: 'render_draft', description: 'Render the current revision as a draft and run QA on it.', inputSchema: obj({ project, idempotencyKey: key }, ['project']) },
  {
    name: 'inspect_frames',
    description: 'Extract up to 16 frames: {clock:"source", assetId, us} from a take, or {clock:"output", frame} from the current draft render. Returns local artifact references.',
    inputSchema: obj({ project, frames: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'object' } }, width: { type: 'integer', minimum: 16, maximum: 1920 } }, ['project', 'frames']),
  },
  { name: 'run_qa', description: 'QA the current revision (renders it first if needed). planHash, if given, must match the current plan.', inputSchema: obj({ project, planHash: { type: 'string', pattern: '^[0-9a-f]{64}$' } }, ['project']) },
  {
    name: 'export_project',
    description: 'Render, run full QA and write video, captions, stems and bundle into destination (under an approved root). Nothing is written if a critical issue remains.',
    inputSchema: obj({ project, destination: { type: 'string', minLength: 1, maxLength: 4096 }, profile: { enum: ['final_1080', 'draft_720'] }, burnCaptions: { type: 'boolean' }, idempotencyKey: key }, ['project', 'destination', 'profile']),
  },
] as const;

type Args = Record<string, any>;
const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true });
const checks = Object.fromEntries(TOOLS.map((t) => [t.name, ajv.compile(t.inputSchema)]));

const summary = (r: PipelineResult) => ({ job: r.job, error: r.error, revision: r.revision, warnings: r.warnings, qa: r.qa });

async function call(ws: Workspace, name: string, a: Args): Promise<unknown> {
  const e = () => ws.open(a.project);
  switch (name) {
    case 'inspect_project':
      return snapshot(e());
    case 'import_assets':
      return { items: await e().importAssets(a.paths, { pool: a.pool }) };
    case 'transcribe':
      return summary(await e().transcribe({ idempotencyKey: a.idempotencyKey ?? randomUUID() }));
    case 'propose_edit': {
      const p = e();
      const d = setEditDefaults(p, { settings: a.settings, targetSeconds: a.targetSeconds, lengthPolicy: a.lengthPolicy });
      return summary(await p.runPipeline({ ...d, baseRevision: a.baseRevision, idempotencyKey: a.idempotencyKey ?? randomUUID() }));
    }
    case 'validate_plan':
      return checkPlan(a.plan, a.project ? e() : undefined);
    case 'apply_patch': {
      const s = e().applyPatch(a.patch);
      return { revision: s.revision, planHash: s.planHash };
    }
    case 'render_draft':
      return summary(await e().renderAffected(a.idempotencyKey));
    case 'inspect_frames':
      return inspectFrames(e(), { schemaVersion: '1.0', frames: a.frames, width: a.width });
    case 'run_qa': {
      const p = e();
      const head = p.getPlan();
      if (head && a.planHash && a.planHash !== head.planHash) throw new EngineError('stale_revision', 'the plan changed since that hash', 'Inspect the project and retry with the current planHash.');
      return summary(await p.renderAffected());
    }
    case 'export_project': {
      const r = await e().exportProject({ profile: a.profile, destinationDir: a.destination, burnCaptions: a.burnCaptions ?? true, idempotencyKey: a.idempotencyKey });
      return { ...summary(r), manifest: r.manifest, dir: r.dir };
    }
  }
  throw new EngineError('unknown_tool', 'unknown tool', 'Call tools/list.');
}

/** Serves MCP on `input`/`output` until input ends. Nothing else is written to `output`. */
export async function runMcp(ws: Workspace, input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
  const reply = (id: unknown, r: { result?: unknown; error?: { code: number; message: string } }) => output.write(JSON.stringify({ jsonrpc: '2.0', id, ...r }) + '\n');
  const pending = new Set<Promise<void>>();

  async function handle(msg: { id?: unknown; method?: unknown; params?: any }): Promise<void> {
    const { id, method, params } = msg;
    const isRequest = id !== undefined && id !== null;
    if (!isRequest) return; // notifications (initialized, cancelled) need no answer
    switch (method) {
      case 'initialize':
        return void reply(id, { result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'takeoff', version: ENGINE_VERSION } } });
      case 'ping':
        return void reply(id, { result: {} });
      case 'tools/list':
        return void reply(id, { result: { tools: TOOLS } });
      case 'tools/call': {
        const name = params?.name;
        const args = params?.arguments ?? {};
        const check = typeof name === 'string' && Object.hasOwn(checks, name) ? checks[name] : undefined;
        if (!check) return void reply(id, { error: { code: -32602, message: `unknown tool` } });
        let text: string;
        let isError = false;
        if (!check(args)) {
          isError = true;
          text = JSON.stringify({ code: 'invalid_arguments', message: (check.errors ?? []).map((x) => `${x.instancePath || '/'} ${x.message}`).join('; '), remedy: 'Match the tool input schema.' });
        } else {
          try {
            text = JSON.stringify(await call(ws, name, args));
          } catch (err) {
            isError = true;
            text = JSON.stringify(toErrorInfo(err));
          }
        }
        return void reply(id, { result: { content: [{ type: 'text', text }], isError } });
      }
      default:
        return void reply(id, { error: { code: -32601, message: 'method not found' } });
    }
  }

  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      reply(null, { error: { code: -32700, message: 'parse error' } });
      continue;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      reply(null, { error: { code: -32600, message: 'invalid request' } });
      continue;
    }
    const p = handle(msg as object).catch(() => undefined);
    pending.add(p);
    p.finally(() => pending.delete(p));
  }
  await Promise.all(pending);
}
