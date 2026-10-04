// First run (PRD 5.1): no account; what this computer can do, an explicit starter-pack download, Local only,
// a project folder, and an optional brand profile that can be skipped without penalty.
import { useState } from 'react';
import { Download, FolderOpen, HardDrive } from 'lucide-react';
import type { BrandProfile, CaptionTemplate } from '@takeoff/contracts';
import { api, bridge, describe } from './api.ts';
import type { AppCtx } from './App.tsx';
import { CAPTION_STYLES, formatBytes, type FeatureStatus } from './logic.ts';
import { ErrorNote, Label } from './ui.tsx';

const STATUS_WORD: Record<FeatureStatus, string> = { available: 'Available', experimental: 'Experimental', unavailable: 'Unavailable' };
const FEATURE_NAMES: Record<string, string> = {
  F01: 'Ingest', F02: 'Transcription', F03: 'Bad takes', F04: 'Fillers', F05: 'Silence/dead air', F06: 'Animated captions', F07: 'B-roll',
  F08: 'Zooms', F09: 'Background music', F10: 'Sound effects', F11: 'Studio voice', F12: 'Auto color', F13: 'Text hook', F14: 'Target length',
  F15: 'Motion graphics', F16: 'Reference style', F17: 'Brand profiles',
};

export function Status({ status }: { status: FeatureStatus }) {
  return <span className={`status status--${status}`}>{STATUS_WORD[status]}</span>;
}

export function CapabilityPanel({ ctx }: { ctx: AppCtx }) {
  const { caps, system } = ctx;
  if (!caps || !system) return <p className="muted" role="status">Checking what this computer can do…</p>;
  const f = (id: string) => caps.features.find((x) => x.id === id);
  const free = system.diskFreeBytes;
  const asr = caps.models.filter((m) => m.kind === 'asr').map((m) => m.id);
  const ollama = caps.models.filter((m) => m.kind === 'director' && m.backend === 'ollama').map((m) => m.id);
  const rows: Array<[string, FeatureStatus, string]> = [
    ['Disk', free === null ? 'experimental' : free < 5e9 ? 'experimental' : 'available', free === null ? 'Free space could not be measured.' : `${formatBytes(free)} free${free < 5e9 ? '. Under 5 GB: long renders may not fit.' : ''}`],
    ['Codecs', f('F01')?.status ?? 'unavailable', f('F01')?.status === 'unavailable' ? (f('F01')!.reason ?? '') : `Decodes ${caps.codecs.decode.length} formats; encodes ${caps.codecs.encode.join(', ') || 'nothing'}.`],
    ['CPU/GPU', 'available', caps.devices.map((d) => d.name).join(', ') || 'CPU'],
    ['Transcription model', asr.length ? (f('F02')?.status ?? 'available') : 'unavailable', asr.length ? `Installed: ${asr.join(', ')}. ${f('F02')?.reason ?? ''}` : (f('F02')?.reason ?? 'No model installed.')],
    ['Local director', ollama.length ? 'available' : 'experimental', ollama.length ? `Ollama: ${ollama.slice(0, 3).join(', ')}` : 'Rules only. Install Ollama with a model for semantic review and plain-language requests.'],
    ['Renderer', system.renderer ? 'available' : 'unavailable', system.renderer ? 'Chromium and FFmpeg are ready.' : 'Chromium for the renderer, or FFmpeg, is missing.'],
    ['Fonts', system.fonts ? 'available' : 'unavailable', system.fonts ? 'Bundled Inter, Archivo and JetBrains Mono.' : 'Bundled caption fonts are missing.'],
    ['Providers', 'available', caps.networkPolicy === 'local_only' ? 'Local only. External providers are off.' : 'Some providers are approved.'],
  ];
  return (
    <section aria-labelledby="caps-h" className="card">
      <h2 id="caps-h" className="card__head">What this computer can do</h2>
      <table className="kv">
        <tbody>
          {rows.map(([name, status, detail]) => (
            <tr key={name}>
              <th scope="row">{name}</th>
              <td>
                <Status status={status} />
              </td>
              <td className="muted">{detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <details className="details">
        <summary>Every feature</summary>
        <table className="kv">
          <tbody>
            {caps.features.map((x) => (
              <tr key={x.id}>
                <th scope="row">
                  <span className="mono">{x.id}</span> {FEATURE_NAMES[x.id]}
                </th>
                <td>
                  <Status status={x.status} />
                </td>
                <td className="muted">{x.reason ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}

export function StarterPack({ ctx }: { ctx: AppCtx }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReturnType<typeof describe> | null>(null);
  const [done, setDone] = useState<Array<{ item: string; license: string }> | null>(null);
  const cached = !!ctx.caps?.models.some((m) => m.kind === 'asr' && m.id === 'base');
  const install = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ licenses: Array<{ item: string; license: string }> }>('POST', '/v1/starter-pack', { allowNetwork: !cached });
      setDone(r.licenses);
      ctx.refreshCaps();
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-labelledby="pack-h" className="card">
      <h2 id="pack-h" className="card__head">Starter pack</h2>
      <table className="kv">
        <tbody>
          <tr>
            <th scope="row">Transcription model</th>
            <td className="mono">Whisper base</td>
            <td className="muted">{cached ? 'Already on this computer' : 'About 145 MB download'} · MIT</td>
          </tr>
          <tr>
            <th scope="row">Music and sound effects</th>
            <td className="mono">Generated library</td>
            <td className="muted">Made on this computer, no download · Takeoff original</td>
          </tr>
        </tbody>
      </table>
      <p className="muted">
        {cached ? 'Installing makes no network request.' : 'Download is the only network request Takeoff makes, and only when you choose it.'}
      </p>
      <div className="row">
        <button type="button" className="btn btn--ghost" onClick={install} disabled={busy}>
          <Download size={16} aria-hidden="true" /> {busy ? 'Installing…' : cached ? 'Install' : 'Download'}
        </button>
      </div>
      <ErrorNote error={error} />
      {done && (
        <p className="note" role="status">
          Installed: {done.map((l) => `${l.item} (${l.license})`).join('; ')}.
        </p>
      )}
    </section>
  );
}

export function ProjectFolder({ ctx }: { ctx: AppCtx }) {
  const choose = async () => {
    const p = await bridge().pickFolder();
    if (p) ctx.setProjectFolder(p);
  };
  return (
    <div className="row">
      <button type="button" className="btn btn--ghost" onClick={choose}>
        <FolderOpen size={16} aria-hidden="true" /> {ctx.projectFolder ? 'Change project folder' : 'Choose project folder'}
      </button>
      <span className="mono path" title={ctx.projectFolder ?? undefined}>
        {ctx.projectFolder ?? 'No folder chosen'}
      </span>
    </div>
  );
}

function BrandForm({ ctx }: { ctx: AppCtx }) {
  const b = ctx.brand;
  const [name, setName] = useState(b?.name ?? '');
  // Brand colours are the user's output palette (rendered video), not chrome tokens.
  const [primary, setPrimary] = useState(b?.palette.find((p) => p.role === 'primary')?.color ?? '#FFFFFF');
  const [highlight, setHighlight] = useState(b?.captionStyle.highlightColor ?? '#FFD60A');
  const [template, setTemplate] = useState<CaptionTemplate>(b?.captionStyle.template ?? 'restrained');
  const [glossary, setGlossary] = useState(b?.glossary.join(', ') ?? '');
  const [saved, setSaved] = useState(false);
  const save = () => {
    const profile: BrandProfile = {
      schemaVersion: '1.0',
      id: 'brand',
      version: (b?.version ?? 0) + 1,
      name: name.trim(),
      palette: [{ role: 'primary', color: primary.toUpperCase() }, { role: 'highlight', color: highlight.toUpperCase() }],
      fonts: [{ role: 'caption', family: 'Inter', assetId: null, license: 'OFL-1.1' }],
      logos: [],
      captionStyle: { template, highlightColor: highlight.toUpperCase(), positionPolicy: 'safe_bottom' },
      hookTone: 'plain',
      glossary: glossary.split(',').map((g) => g.trim()).filter(Boolean).slice(0, 200),
      prohibitedClaims: [],
      motionIntensity: 'restrained',
      safeLayouts: ['full'],
      music: { moods: [], bannedCategories: [] },
      sfx: { bannedCategories: [] },
      ctaTemplates: [],
      aspectPresets: [{ width: 1080, height: 1920 }],
      provenance: { source: 'manual', sourceUrl: null, createdAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z') },
    };
    ctx.setBrand(profile);
    setSaved(true);
  };
  return (
    <form className="form" onSubmit={(e) => (e.preventDefault(), save())}>
      <label className="field">
        <span>Brand name</span>
        <input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="row row--top">
        <label className="field">
          <span>Primary colour</span>
          <input type="color" value={primary} onChange={(e) => setPrimary(e.target.value)} />
        </label>
        <label className="field">
          <span>Caption highlight</span>
          <input type="color" value={highlight} onChange={(e) => setHighlight(e.target.value)} />
        </label>
        <label className="field">
          <span>Caption style</span>
          <select value={template} onChange={(e) => setTemplate(e.target.value as CaptionTemplate)}>
            {CAPTION_STYLES.map((s) => (
              <option key={s} value={s}>
                {s[0]!.toUpperCase() + s.slice(1)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        <span>Glossary (comma-separated product and brand names)</span>
        <input value={glossary} onChange={(e) => setGlossary(e.target.value)} placeholder="Flutter, Dio" />
      </label>
      <div className="row">
        <button type="submit" className="btn btn--ghost">Save brand</button>
        {saved && <span role="status" className="muted">Saved. Pick it in the Output column.</span>}
      </div>
    </form>
  );
}

export function FirstRun({ ctx, onDone }: { ctx: AppCtx; onDone(): void }) {
  return (
    <div className="firstrun">
      <h1 className="display">Drop in your takes, choose your edits, get a polished short you can still change.</h1>
      <p className="lede">No account. Everything runs on this computer unless you approve a provider for a project.</p>
      <CapabilityPanel ctx={ctx} />
      <StarterPack ctx={ctx} />
      <section aria-labelledby="net-h" className="card">
        <h2 id="net-h" className="card__head">Network</h2>
        <fieldset className="radios">
          <legend className="sr-only">Network policy</legend>
          <label>
            <input type="radio" name="net" checked readOnly /> Local only
          </label>
          <label className="is-disabled">
            <input type="radio" name="net" disabled /> Approved providers
          </label>
        </fieldset>
        <p className="muted">
          Local only blocks every transfer of media, transcript and frames in code. You can approve a provider for one project, per data type, in Settings.
        </p>
      </section>
      <section aria-labelledby="folder-h" className="card">
        <h2 id="folder-h" className="card__head">
          <HardDrive size={16} aria-hidden="true" /> Project folder
        </h2>
        <p className="muted">Projects, renders and exports are written here. Your original recordings are never changed.</p>
        <ProjectFolder ctx={ctx} />
      </section>
      <section aria-labelledby="brand-h" className="card">
        <h2 id="brand-h" className="card__head">
          Brand profile <Label>Optional</Label>
        </h2>
        <p className="muted">Colours, caption style and glossary for your captions and hooks. Skipping changes nothing about the edit.</p>
        <BrandForm ctx={ctx} />
      </section>
      <div className="row row--end">
        <button type="button" className="btn btn--brand" onClick={onDone}>
          Continue
        </button>
      </div>
    </div>
  );
}
