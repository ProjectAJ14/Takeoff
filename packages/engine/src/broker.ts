// ProviderBroker (PRD §8, §14): the only path content takes off the machine.
// Policy is per project, per provider, per data type, with a budget cap; every transfer is receipted.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { NetworkPolicy, ProviderDataType, ProviderReceipt } from '@takeoff/contracts';
import type { ProjectStore } from '@takeoff/project-store';
import { EngineError } from './errors.ts';

export interface ProviderApproval {
  provider: string;
  dataTypes: ProviderDataType[];
  budgetUsd: number;
}
export interface ProviderPolicy {
  networkPolicy: NetworkPolicy;
  approvals: ProviderApproval[];
}
export interface SendOptions {
  jobId?: string | null;
  estimatedCostUsd?: number;
}
export type KeyLookup = (provider: string) => Promise<string>;

/** Known endpoints. A provider not listed here cannot be called, whatever the policy says. */
export const PROVIDERS: Record<string, { url: string; headers: (key: string) => Record<string, string>; retentionPolicyUrl: string; estimateUsd: (bodyBytes: number, request: unknown) => number }> = {
  anthropic: {
    url: 'https://api.anthropic.com/v1/messages',
    headers: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }),
    retentionPolicyUrl: 'https://privacy.anthropic.com/',
    // ponytail: deliberate over-estimate (3 bytes/token, $15/M in, $75/M out, max_tokens or 4096 out) so the
    // budget cap binds without a price table; replace with per-model prices when billing data matters.
    estimateUsd: (bytes, req) => (bytes / 3) * 15e-6 + (maxTokens(req) ?? 4096) * 75e-6,
  },
};
const maxTokens = (req: unknown): number | undefined => {
  const n = (req as { max_tokens?: unknown } | null)?.max_tokens;
  return Number.isSafeInteger(n) && (n as number) > 0 ? (n as number) : undefined;
};
const endpointOf = (id: string) => (PROVIDER_ID.test(id) && Object.hasOwn(PROVIDERS, id) ? PROVIDERS[id] : undefined);

const PROVIDER_ID = /^[a-z][a-z0-9_]{0,63}$/;
const POLICY_KEY = 'providerPolicy';
const DATA_TYPES: readonly ProviderDataType[] = ['transcript', 'frames', 'audio', 'video', 'asset_query', 'asset_download', 'prompt', 'brand_page'];

export const LOCAL_ONLY: ProviderPolicy = { networkPolicy: 'local_only', approvals: [] };

/** macOS Keychain via `security` with an argument array. The key is never logged or written anywhere. */
export const keychainKey: KeyLookup = (provider) => {
  if (!PROVIDER_ID.test(provider)) return Promise.reject(new EngineError('invalid_provider', 'unknown provider id', 'Use a provider id such as anthropic.'));
  if (process.platform !== 'darwin') {
    return Promise.reject(new EngineError('credentials_unavailable', 'OS credential storage is only supported on macOS in this build', 'Use the local director, or run Takeoff on macOS to use external providers.'));
  }
  return new Promise((ok, fail) => {
    execFile('security', ['find-generic-password', '-s', `takeoff.${provider}`, '-w'], { timeout: 10_000 }, (err, stdout) => {
      const key = String(stdout).trim();
      if (err || !key) fail(new EngineError('credentials_missing', `no ${provider} key in the Keychain`, `Add it with: security add-generic-password -s takeoff.${provider} -a takeoff -w`));
      else ok(key);
    });
  });
};

export function validatePolicy(p: ProviderPolicy): ProviderPolicy {
  const bad = (m: string) => new EngineError('invalid_policy', m, 'Fix the provider policy and save it again.');
  if (p?.networkPolicy !== 'local_only' && p?.networkPolicy !== 'approved_providers') throw bad('networkPolicy must be local_only or approved_providers');
  if (!Array.isArray(p.approvals)) throw bad('approvals must be a list');
  for (const a of p.approvals) {
    if (typeof a?.provider !== 'string' || !endpointOf(a.provider)) throw bad('approval names an unknown provider');
    if (!Array.isArray(a.dataTypes) || a.dataTypes.some((d) => !DATA_TYPES.includes(d))) throw bad('approval has an unknown data type');
    if (!(Number.isFinite(a.budgetUsd) && a.budgetUsd >= 0)) throw bad('budgetUsd must be a number ≥ 0');
  }
  return { networkPolicy: p.networkPolicy, approvals: p.approvals.map((a) => ({ provider: a.provider, dataTypes: [...new Set(a.dataTypes)], budgetUsd: a.budgetUsd })) };
}

export class ProviderBroker {
  readonly store: ProjectStore;
  readonly fetch: typeof fetch;
  readonly getKey: KeyLookup;
  constructor(store: ProjectStore, opts: { fetch?: typeof fetch; getKey?: KeyLookup } = {}) {
    this.store = store;
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.getKey = opts.getKey ?? keychainKey;
  }

  policy(): ProviderPolicy {
    return this.store.getSetting<ProviderPolicy>(POLICY_KEY) ?? LOCAL_ONLY;
  }
  setPolicy(p: ProviderPolicy): ProviderPolicy {
    const v = validatePolicy(p);
    this.store.setSetting(POLICY_KEY, v);
    this.store.appendEvent('provider_policy', { networkPolicy: v.networkPolicy, providers: v.approvals.map((a) => a.provider) });
    return v;
  }

  spentUsd(provider: string): number {
    return this.store
      .listEvents('provider_receipt')
      .map((e) => e.data as ProviderReceipt)
      .filter((r) => r.provider === provider)
      .reduce((s, r) => s + (r.estimatedCostUsd ?? 0), 0);
  }

  /** Checks policy, data type and budget before anything leaves; records a receipt; then sends. */
  async send(provider: string, dataType: ProviderDataType, purpose: string, request: unknown, opts: SendOptions = {}): Promise<unknown> {
    const policy = this.policy();
    const deny = (m: string, remedy: string) => new EngineError('egress_denied', m, remedy);
    if (policy.networkPolicy === 'local_only') throw deny('this project is Local only; nothing may leave the machine', 'Approve a provider for this project in its privacy settings, or keep working locally.');
    const approval = policy.approvals.find((a) => a.provider === provider);
    const endpoint = endpointOf(provider);
    if (!approval || !endpoint) throw deny(`provider ${PROVIDER_ID.test(provider) ? provider : '(invalid)'} is not approved for this project`, 'Approve the provider for this project first.');
    if (!approval.dataTypes.includes(dataType)) throw deny(`${provider} is not approved to receive ${dataType}`, `Approve ${dataType} for ${provider}, or keep this step local.`);
    const body = JSON.stringify(request);
    // Without a caller estimate the provider's conservative one applies: a send never counts as free.
    const cost = opts.estimatedCostUsd ?? endpoint.estimateUsd(Buffer.byteLength(body), request);
    if (!(Number.isFinite(cost) && cost >= 0)) throw new EngineError('invalid_cost', 'estimated cost must be a number ≥ 0', 'Pass a cost estimate.');
    if (this.spentUsd(provider) + cost > approval.budgetUsd) {
      throw new EngineError('budget_exceeded', `the ${provider} budget for this project is used up`, 'Raise the budget cap for this provider or continue locally.');
    }
    if (typeof purpose !== 'string' || !purpose.trim()) throw new EngineError('invalid_purpose', 'a transfer needs a purpose', 'Describe why the data is sent.');
    const key = await this.getKey(provider);
    // Receipt first: if the request reaches the provider and the reply is lost, the transfer is still on record.
    const receipt: ProviderReceipt = {
      schemaVersion: '1.0',
      id: randomUUID(),
      projectId: this.store.projectId,
      jobId: opts.jobId ?? null,
      provider,
      dataType,
      purpose: purpose.slice(0, 2000),
      sentAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      bytes: Buffer.byteLength(body),
      estimatedCostUsd: cost,
      retentionPolicyUrl: endpoint.retentionPolicyUrl,
    };
    this.store.recordProviderReceipt(receipt);
    // ponytail: no retry/backoff yet; add idempotent retries when a provider supports idempotency keys.
    const res = await this.fetch(endpoint.url, { method: 'POST', headers: endpoint.headers(key), body, redirect: 'error', signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new EngineError('provider_error', `${provider} returned HTTP ${res.status}`, 'Retry later or continue with the local director.');
    try {
      return await res.json();
    } catch {
      throw new EngineError('provider_error', `${provider} returned a non-JSON body`, 'Retry later or continue with the local director.');
    }
  }
}
