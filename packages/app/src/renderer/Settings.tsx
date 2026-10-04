// Settings: ground, providers (off by default; per project, per data type) and diagnostics.
import { useEffect, useState } from 'react';
import { Bug, FolderOpen } from 'lucide-react';
import type { ProviderDataType } from '@takeoff/contracts';
import { api, bridge, describe } from './api.ts';
import type { AppCtx, Ground } from './App.tsx';
import { CapabilityPanel, StarterPack } from './FirstRun.tsx';
import { BrandLibrary } from './Brand.tsx';
import { ErrorNote, Label } from './ui.tsx';

interface Policy {
  networkPolicy: 'local_only' | 'approved_providers';
  approvals: Array<{ provider: string; dataTypes: ProviderDataType[]; budgetUsd: number }>;
}
const DATA_TYPES: Array<[ProviderDataType, string]> = [
  ['transcript', 'Transcript text'],
  ['frames', 'Sampled frames'],
  ['audio', 'Audio'],
  ['video', 'Full media'],
];
const PROVIDERS = [{ id: 'anthropic', name: 'Anthropic', retention: 'https://privacy.anthropic.com/' }];

export function Settings({ ctx, onFirstRun }: { ctx: AppCtx; onFirstRun(): void }) {
  return (
    <div className="settings">
      <h1 className="h1">Settings</h1>
      <section className="card" aria-labelledby="ground-h">
        <h2 id="ground-h" className="card__head">
          Ground
        </h2>
        <div className="ground" role="group" aria-labelledby="ground-h">
          {(['ink', 'paper'] as Ground[]).map((g) => (
            <button key={g} type="button" aria-pressed={ctx.ground === g} onClick={() => ctx.setGround(g)}>
              {g}
            </button>
          ))}
        </div>
        <p className="hint">The preview stays dark on both grounds so you judge your video against black.</p>
      </section>
      <BrandLibrary ctx={ctx} />
      <Providers ctx={ctx} />
      <Diagnostics ctx={ctx} />
      <CapabilityPanel ctx={ctx} />
      <StarterPack ctx={ctx} />
      <button type="button" className="btn btn--quiet" onClick={onFirstRun}>
        Show first run again
      </button>
    </div>
  );
}

function Providers({ ctx }: { ctx: AppCtx }) {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [error, setError] = useState<ReturnType<typeof describe> | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!ctx.projectId) return;
    api<{ policy: Policy }>('GET', `/v1/projects/${ctx.projectId}/providers`)
      .then((r) => setPolicy(r.policy))
      .catch((e) => setError(describe(e)));
  }, [ctx.projectId]);
  const approval = (id: string) => policy?.approvals.find((a) => a.provider === id) ?? { provider: id, dataTypes: [], budgetUsd: 0 };
  const update = (id: string, next: Partial<Policy['approvals'][number]>) => {
    if (!policy) return;
    const a = { ...approval(id), ...next };
    setPolicy({ ...policy, approvals: [...policy.approvals.filter((x) => x.provider !== id), a].filter((x) => x.dataTypes.length) });
    setSaved(false);
  };
  const save = async () => {
    setError(null);
    try {
      const r = await bridge().setProviders(ctx.projectId!, policy);
      if (r.error) return setError(r.error);
      setPolicy(r.policy as Policy);
      setSaved(true);
    } catch (e) {
      setError(describe(e));
    }
  };
  return (
    <section className="card" aria-labelledby="prov-h">
      <h2 id="prov-h" className="card__head">
        Providers
      </h2>
      {!ctx.projectId || !policy ? (
        <p className="muted">Providers are approved per project. Open a project to change its permissions. Every project starts Local only.</p>
      ) : (
        <form className="form" onSubmit={(e) => (e.preventDefault(), void save())}>
          <fieldset className="radios">
            <legend>This project</legend>
            <label>
              <input type="radio" name="np" checked={policy.networkPolicy === 'local_only'} onChange={() => (setPolicy({ ...policy, networkPolicy: 'local_only' }), setSaved(false))} /> Local only
            </label>
            <label>
              <input type="radio" name="np" checked={policy.networkPolicy === 'approved_providers'} onChange={() => (setPolicy({ ...policy, networkPolicy: 'approved_providers' }), setSaved(false))} /> Approved providers only
            </label>
          </fieldset>
          {PROVIDERS.map((p) => {
            const a = approval(p.id);
            const off = policy.networkPolicy === 'local_only';
            return (
              <fieldset key={p.id} className="field" disabled={off}>
                <legend>{p.name}</legend>
                <p className="hint">
                  Key from the macOS Keychain (service <span className="mono">takeoff.{p.id}</span>). Retention policy: <span className="mono">{p.retention}</span>
                </p>
                {DATA_TYPES.map(([dt, label]) => (
                  <label key={dt} className="check">
                    <input type="checkbox" checked={a.dataTypes.includes(dt)} onChange={(e) => update(p.id, { dataTypes: e.target.checked ? [...a.dataTypes, dt] : a.dataTypes.filter((x) => x !== dt) })} /> {label}
                  </label>
                ))}
                <label className="field field--sm">
                  <span>Budget (USD)</span>
                  <input type="number" min={0} step={0.5} value={a.budgetUsd} onChange={(e) => update(p.id, { budgetUsd: Math.max(0, Number(e.target.value)) })} />
                </label>
              </fieldset>
            );
          })}
          <div className="row">
            <button type="submit" className="btn btn--ghost">
              Save permissions
            </button>
            {saved && <span role="status" className="muted">Saved.</span>}
          </div>
        </form>
      )}
      <ErrorNote error={error} />
    </section>
  );
}

function Diagnostics({ ctx }: { ctx: AppCtx }) {
  const [dir, setDir] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReturnType<typeof describe> | null>(null);
  const versions = (navigator.userAgent.match(/(Electron|Chrome)\/[\d.]+/g) ?? []).join(' · ');
  const generate = async () => {
    setError(null);
    const dest = await bridge().pickFolder();
    if (!dest) return;
    setBusy(true);
    try {
      setDir((await api<{ dir: string }>('POST', '/v1/diagnostics', { destinationDir: dest })).dir);
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card" aria-labelledby="diag-h">
      <h2 id="diag-h" className="card__head">
        Diagnostics
      </h2>
      <table className="kv">
        <tbody>
          <tr>
            <th scope="row">Takeoff</th>
            <td className="mono">{ctx.caps?.appVersion ?? '…'}</td>
          </tr>
          <tr>
            <th scope="row">Shell</th>
            <td className="mono">{versions || 'unknown'}</td>
          </tr>
        </tbody>
      </table>
      <p className="hint">The bundle holds versions, capabilities and redacted logs: no transcripts, frames, prompts, paths or keys. Inspect it before sharing.</p>
      <div className="row">
        <button type="button" className="btn btn--ghost" onClick={generate} disabled={busy}>
          <Bug size={16} aria-hidden="true" /> {busy ? 'Generating…' : 'Generate redacted bundle'}
        </button>
        <button type="button" className="btn btn--quiet" onClick={() => void bridge().revealInFolder()}>
          <FolderOpen size={16} aria-hidden="true" /> Reveal logs
        </button>
      </div>
      {dir && (
        <p role="status">
          <Label>Written</Label> <span className="mono path">{dir}</span>{' '}
          <button type="button" className="btn btn--quiet btn--sm" onClick={() => void bridge().revealInFolder(dir)}>
            Reveal
          </button>
        </p>
      )}
      <ErrorNote error={error} />
    </section>
  );
}
