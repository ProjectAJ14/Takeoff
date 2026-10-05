// DirectorAdapter, the rules/Ollama/external adapters and the propose → validate → repair → fallback loop.
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type { DirectorRequest, EditPlan, ValidationIssue } from '@takeoff/contracts';
import { buildPlan, candidatesFor, hookOptionsFor, type DirectorChoices, type DirectorContext } from './plan.ts';

export interface DirectorCapabilities {
  available: boolean;
  semantic: boolean;
  imageReview: boolean;
  reason?: string;
}

export interface DirectorAdapter {
  id: string;
  capabilities(): Promise<DirectorCapabilities>;
  propose(req: DirectorRequest, ctx?: DirectorContext): Promise<EditPlan>;
  repair(req: DirectorRequest, plan: EditPlan, errors: ValidationIssue[], ctx?: DirectorContext): Promise<EditPlan>;
}

export class RulesDirector implements DirectorAdapter {
  readonly id = 'rules';
  async capabilities(): Promise<DirectorCapabilities> {
    return { available: true, semantic: false, imageReview: false };
  }
  async propose(req: DirectorRequest, ctx: DirectorContext = {}): Promise<EditPlan> {
    return buildPlan(req, ctx);
  }
  /** Deterministic: the same request rebuilds the same plan. */
  async repair(req: DirectorRequest, _plan: EditPlan, _errors: ValidationIssue[], ctx: DirectorContext = {}): Promise<EditPlan> {
    return buildPlan(req, ctx);
  }
}

// ---------- Model-backed directors: choices only, merged onto the rules plan ----------

export const PROMPT_VERSION = 'director_v1';
export const DIRECTOR_PROMPT = readFileSync(new URL('./prompts/director_v1.md', import.meta.url), 'utf8');
const MAX_REPLY_CHARS = 1_000_000;

/** `complete(system, user)` returns the model's raw text reply. */
type Complete = (system: string, user: string, seed: number) => Promise<string>;

/** Untrusted transcript and candidates as JSON inside a fence the data cannot close (`<` is escaped). */
export function buildUserPrompt(req: DirectorRequest, ctx: DirectorContext, base: EditPlan): string {
  const data = {
    candidates: candidatesFor(req, ctx).map((c) => ({ id: c.id, kind: c.kind, tier: c.confidenceTier, wordIds: c.wordIds, evidence: c.evidence })),
    words: req.words.map((w) => ({ id: w.id, text: w.text })),
    hookOptions: hookOptionsFor(req, base, ctx.speech).map((o, index) => ({ index, text: o.text })),
  };
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<untrusted_data>\n${json}\n</untrusted_data>\nReply with the JSON object only.`;
}

/** Parse a model reply into choices over ids that exist. Anything else is dropped; non-JSON throws. */
export function parseChoices(raw: string, req: DirectorRequest, ctx: DirectorContext, base: EditPlan): DirectorChoices {
  if (raw.length > MAX_REPLY_CHARS) throw new Error('director reply too large');
  const text = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('director reply is not JSON'); // never echo model text: it can carry transcript content
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('director reply is not a JSON object');
  const v = value as Record<string, unknown>;
  const candidates = new Set(candidatesFor(req, ctx).map((c) => c.id));
  const words = new Set(req.words.map((w) => w.id));
  const ids = (x: unknown, known: Set<string>) => (Array.isArray(x) ? [...new Set(x.filter((i): i is string => typeof i === 'string' && known.has(i)))] : []);
  const hookOptions = hookOptionsFor(req, base, ctx.speech);
  const choices: DirectorChoices = {
    acceptCandidateIds: ids(v.acceptCandidateIds, candidates),
    rejectCandidateIds: ids(v.rejectCandidateIds, candidates),
  };
  // Resolve the index here, against the options the model was shown; buildPlan recomputes options after cuts.
  if (v.hookOption === null) choices.hookEvidenceIds = null;
  else if (Number.isInteger(v.hookOption)) choices.hookEvidenceIds = hookOptions[v.hookOption as number]?.evidenceIds;
  if (Array.isArray(v.emphasisWordIds)) choices.emphasisWordIds = ids(v.emphasisWordIds, words);
  return choices;
}

async function llmPlan(req: DirectorRequest, ctx: DirectorContext, director: string, complete: Complete, errors: ValidationIssue[] = []): Promise<EditPlan> {
  const seed = ctx.seed ?? 0;
  const base = buildPlan(req, ctx);
  const repairNote = errors.length
    ? `\n\nYour previous choices produced a plan that failed validation:\n${errors.slice(0, 20).map((e) => `- ${e.path || '/'}: ${e.message.slice(0, 200)}`).join('\n')}\nChoose again; when unsure, accept fewer candidates.`
    : '';
  const raw = await complete(DIRECTOR_PROMPT + repairNote, buildUserPrompt(req, ctx, base), seed);
  const choices = parseChoices(raw, req, ctx, base);
  return buildPlan(req, ctx, choices, { director, seed, promptVersion: PROMPT_VERSION });
}

const versionId = (prefix: string, model: string) => `${prefix}-${model.replace(/[^A-Za-z0-9_.+-]/g, '-')}`.slice(0, 64);

/** Loopback only. The host is a constant; only the port is configurable (for tests and non-default installs). */
export const OLLAMA_HOST = '127.0.0.1';
export const OLLAMA_DEFAULT_PORT = 11434;

export interface OllamaOptions {
  model: string;
  port?: number;
  timeoutMs?: number;
}

export class OllamaDirector implements DirectorAdapter {
  readonly id = 'ollama';
  readonly model: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  constructor(opts: OllamaOptions) {
    const port = opts.port ?? OLLAMA_DEFAULT_PORT;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid Ollama port');
    if (!opts.model) throw new Error('Ollama model required');
    this.model = opts.model;
    this.baseUrl = `http://${OLLAMA_HOST}:${port}`;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  async #fetchJson(path: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`Ollama ${path} returned HTTP ${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new Error(`Ollama ${path} returned a non-JSON body`); // SyntaxError would quote the body (model text)
    }
  }

  async capabilities(): Promise<DirectorCapabilities> {
    const off = (reason: string) => ({ available: false, semantic: false, imageReview: false, reason });
    try {
      const tags = (await this.#fetchJson('/api/tags', {}, 2_000)) as { models?: Array<{ name?: string }> };
      const names = (tags.models ?? []).map((m) => m.name);
      if (!names.some((n) => n === this.model || n === `${this.model}:latest`)) return off(`model ${this.model} is not installed in Ollama`);
      return { available: true, semantic: true, imageReview: false };
    } catch {
      return off('Ollama is not reachable on 127.0.0.1');
    }
  }

  #complete: Complete = async (system, user, seed) => {
    const body = {
      model: this.model,
      stream: false,
      format: 'json',
      options: { temperature: 0, seed },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    };
    const r = (await this.#fetchJson('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, this.timeoutMs)) as {
      message?: { content?: unknown };
    };
    if (typeof r.message?.content !== 'string') throw new Error('Ollama reply has no message content');
    return r.message.content;
  };

  propose(req: DirectorRequest, ctx: DirectorContext = {}): Promise<EditPlan> {
    return llmPlan(req, ctx, versionId('ollama', this.model), this.#complete);
  }
  repair(req: DirectorRequest, _plan: EditPlan, errors: ValidationIssue[], ctx: DirectorContext = {}): Promise<EditPlan> {
    return llmPlan(req, ctx, versionId('ollama', this.model), this.#complete, errors);
  }
}

/** Anthropic Messages API request body. The engine's ProviderBroker owns transport, credentials and egress checks. */
export interface MessagesRequest {
  model: string;
  max_tokens: number;
  temperature: number;
  system: string;
  messages: Array<{ role: 'user'; content: string }>;
}
export type MessagesSend = (body: MessagesRequest) => Promise<unknown>;

export interface ExternalOptions {
  /** Provider id for provenance, e.g. "anthropic". */
  provider: string;
  model: string;
  send: MessagesSend;
  maxTokens?: number;
}

/** Messages-API adapter. Makes no network call itself; refuses local_only projects before calling `send`. */
export class ExternalDirector implements DirectorAdapter {
  readonly id: string;
  readonly opts: ExternalOptions;
  constructor(opts: ExternalOptions) {
    this.opts = opts;
    this.id = versionId('external', opts.provider);
  }
  async capabilities(): Promise<DirectorCapabilities> {
    return { available: true, semantic: true, imageReview: false };
  }
  #complete: Complete = async (system, user) => {
    const res = (await this.opts.send({
      model: this.opts.model,
      max_tokens: this.opts.maxTokens ?? 2048,
      temperature: 0,
      system,
      messages: [{ role: 'user', content: user }],
    })) as { content?: Array<{ type?: string; text?: unknown }> };
    const text = (res?.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('');
    if (!text) throw new Error('provider reply has no text content');
    return text;
  };
  #guard(req: DirectorRequest) {
    if (req.settings.networkPolicy === 'local_only') throw new Error('external director refused: project is local_only');
  }
  async propose(req: DirectorRequest, ctx: DirectorContext = {}): Promise<EditPlan> {
    this.#guard(req);
    return llmPlan(req, ctx, versionId(this.id, this.opts.model), this.#complete);
  }
  async repair(req: DirectorRequest, _plan: EditPlan, errors: ValidationIssue[], ctx: DirectorContext = {}): Promise<EditPlan> {
    this.#guard(req);
    return llmPlan(req, ctx, versionId(this.id, this.opts.model), this.#complete, errors);
  }
}

// ---------- Orchestration ----------

export type PlanValidator = (plan: EditPlan) => ValidationIssue[] | Promise<ValidationIssue[]>;
export interface DirectAttempt {
  director: string;
  stage: 'propose' | 'repair' | 'fallback';
  errors: ValidationIssue[];
}
export interface DirectResult {
  plan: EditPlan;
  director: string;
  fallback: boolean;
  /** Validation issues of the returned plan; empty when it passed. */
  errors: ValidationIssue[];
  attempts: DirectAttempt[];
}

/** Product invariants a director can never change, checked before the injected validator. */
function boundaryIssues(req: DirectorRequest, plan: EditPlan): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  if (plan.projectId !== req.projectId) out.push({ path: '/projectId', message: 'director changed the project id' });
  if (plan.revision !== req.revision) out.push({ path: '/revision', message: 'director changed the revision' });
  if (!isDeepStrictEqual(plan.settings, req.settings)) out.push({ path: '/settings', message: 'director changed settings' });
  if (!isDeepStrictEqual(plan.output, req.output)) out.push({ path: '/output', message: 'director changed the output spec' });
  return out;
}

const failure = (e: unknown): ValidationIssue[] => [{ path: '', message: e instanceof Error ? e.message.slice(0, 200) : 'director failed' }];

/**
 * First available adapter proposes; the plan is validated; one structured repair; then the rules baseline.
 * PRD §13: invalid director plan → repair once → safe baseline fallback.
 */
export async function directPlan(
  req: DirectorRequest,
  adapters: DirectorAdapter[],
  validate: PlanValidator,
  ctx: DirectorContext = {},
): Promise<DirectResult> {
  const attempts: DirectAttempt[] = [];
  const check = async (plan: EditPlan) => {
    const b = boundaryIssues(req, plan);
    return b.length ? b : await validate(plan);
  };
  let preferred: DirectorAdapter | undefined;
  for (const a of adapters) {
    try {
      if ((await a.capabilities()).available) {
        preferred = a;
        break;
      }
    } catch {
      // unavailable
    }
  }
  if (preferred && preferred.id !== 'rules') {
    let plan: EditPlan | undefined;
    for (const stage of ['propose', 'repair'] as const) {
      try {
        plan = stage === 'propose' ? await preferred.propose(req, ctx) : await preferred.repair(req, plan!, attempts.at(-1)!.errors, ctx);
        const errors = await check(plan);
        attempts.push({ director: preferred.id, stage, errors });
        if (!errors.length) return { plan, director: preferred.id, fallback: false, errors, attempts };
      } catch (e) {
        attempts.push({ director: preferred.id, stage, errors: failure(e) });
        if (!plan) break; // propose threw: nothing to repair
      }
    }
  }
  const plan = buildPlan(req, ctx);
  let errors: ValidationIssue[];
  try {
    errors = await check(plan);
  } catch (e) {
    errors = failure(e);
  }
  attempts.push({ director: 'rules', stage: 'fallback', errors });
  return { plan, director: 'rules', fallback: !!preferred && preferred.id !== 'rules', errors, attempts };
}
