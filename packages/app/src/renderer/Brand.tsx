// Brand editor (F17, manual): saved through the engine's brand library as a new immutable version, never in
// localStorage. Fonts and logos are files the user picks; the engine copies them by SHA-256. These colours are the
// user's rendered-output palette, not chrome tokens (the swatches preview them only).
import { useState } from 'react';
import { FileType, ImagePlus, X } from 'lucide-react';
import type { BrandProfile, CaptionTemplate, HookTone } from '@takeoff/contracts';
import { api, bridge, describe } from './api.ts';
import type { AppCtx } from './App.tsx';
import { CAPTION_STYLES } from './logic.ts';
import { ErrorNote } from './ui.tsx';

type Role = BrandProfile['palette'][number]['role'];
const ROLES: Array<[Role, string, string]> = [
  ['primary', 'Primary', '#FFFFFF'],
  ['secondary', 'Secondary', '#CCCCCC'],
  ['accent', 'Accent', '#2F6FEB'],
  ['background', 'Background', '#111111'],
  ['text', 'Caption text', '#FFFFFF'],
  ['highlight', 'Highlight', '#FFD23F'],
];
const TONES: HookTone[] = ['plain', 'direct', 'playful'];
const list = (s: string, sep: RegExp) => s.split(sep).map((x) => x.trim()).filter(Boolean);
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'brand';
const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;

export function BrandEditor({ ctx, brand, onSaved }: { ctx: AppCtx; brand: BrandProfile | null; onSaved?(b: BrandProfile): void }) {
  const color = (r: Role, d: string) => brand?.palette.find((p) => p.role === r)?.color ?? d;
  const font = brand?.fonts.find((f) => f.role === 'caption');
  const logo = brand?.logos[0];
  const [name, setName] = useState(brand?.name ?? '');
  const [palette, setPalette] = useState<Record<Role, string>>(() => Object.fromEntries(ROLES.map(([r, , d]) => [r, color(r, d)])) as Record<Role, string>);
  const [template, setTemplate] = useState<CaptionTemplate>(brand?.captionStyle.template ?? 'restrained');
  const [tone, setTone] = useState<HookTone>(brand?.hookTone ?? 'plain');
  const [family, setFamily] = useState(font?.family ?? 'Inter');
  const [fontFile, setFontFile] = useState<{ assetId: string; label: string } | null>(font?.assetId ? { assetId: font.assetId, label: 'Saved font file' } : null);
  const [logoFile, setLogoFile] = useState<{ assetId: string; label: string } | null>(logo ? { assetId: logo.assetId, label: 'Saved logo' } : null);
  const [glossary, setGlossary] = useState(brand?.glossary.join(', ') ?? '');
  const [claims, setClaims] = useState(brand?.prohibitedClaims.join('\n') ?? '');
  const [error, setError] = useState<ReturnType<typeof describe> | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pick = async (kind: 'font' | 'logo') => {
    setError(null);
    const [path] = await bridge().pickFiles(kind);
    if (!path) return;
    try {
      const r = await api<{ assetId: string }>('POST', '/v1/brand-files', { path, kind });
      (kind === 'font' ? setFontFile : setLogoFile)({ assetId: r.assetId, label: fileName(path) });
    } catch (e) {
      setError(describe(e));
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(null);
    const profile: BrandProfile = {
      schemaVersion: '1.0',
      id: brand?.id ?? `${slug(name)}-${crypto.randomUUID().slice(0, 6)}`,
      version: 1, // the library assigns the next version
      name: name.trim(),
      palette: ROLES.map(([role]) => ({ role, color: palette[role].toUpperCase() })),
      fonts: [
        { role: 'caption', family: family.trim() || 'Inter', assetId: fontFile?.assetId ?? null, license: fontFile ? 'Supplied by the user' : 'OFL-1.1' },
        { role: 'heading', family: family.trim() || 'Inter', assetId: fontFile?.assetId ?? null, license: fontFile ? 'Supplied by the user' : 'OFL-1.1' },
      ],
      logos: logoFile ? [{ assetId: logoFile.assetId, role: 'primary' }] : [],
      captionStyle: { template, highlightColor: palette.highlight.toUpperCase(), positionPolicy: 'safe_face_aware' },
      hookTone: tone,
      glossary: list(glossary, /,/).slice(0, 200),
      prohibitedClaims: list(claims, /\n/).slice(0, 200),
      motionIntensity: brand?.motionIntensity ?? 'restrained',
      safeLayouts: brand?.safeLayouts ?? ['full', 'inset'],
      music: brand?.music ?? { moods: [], bannedCategories: [] },
      sfx: brand?.sfx ?? { bannedCategories: [] },
      ctaTemplates: brand?.ctaTemplates ?? [],
      aspectPresets: [{ width: 1080, height: 1920 }],
      provenance: { source: 'manual', sourceUrl: null, createdAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z') },
    };
    try {
      const r = await api<{ brand: BrandProfile }>('POST', '/v1/brands', profile);
      ctx.refreshBrands();
      setSaved(`Saved ${r.brand.name}, version ${r.brand.version}.`);
      onSaved?.(r.brand);
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="form" onSubmit={(e) => (e.preventDefault(), void save())}>
      <label className="field">
        <span>Brand name</span>
        <input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <fieldset className="field">
        <legend>Palette (your video, not this app)</legend>
        <div className="row row--top">
          {ROLES.map(([role, label]) => (
            <label key={role} className="field">
              <span>{label}</span>
              <input type="color" value={palette[role]} onChange={(e) => setPalette({ ...palette, [role]: e.target.value })} />
            </label>
          ))}
        </div>
      </fieldset>
      <div className="row row--top">
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
        <label className="field">
          <span>Hook tone</span>
          <select value={tone} onChange={(e) => setTone(e.target.value as HookTone)}>
            {TONES.map((t) => (
              <option key={t} value={t}>
                {t[0]!.toUpperCase() + t.slice(1)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="row row--top">
        <label className="field">
          <span>Font family</span>
          <input maxLength={100} value={family} onChange={(e) => setFamily(e.target.value)} />
        </label>
        <div className="field">
          <span>Font file</span>
          <div className="row">
            <button type="button" className="btn btn--ghost" onClick={() => void pick('font')}>
              <FileType size={16} aria-hidden="true" /> {fontFile ? 'Replace font' : 'Choose font'}
            </button>
            {fontFile && (
              <>
                <span className="mono path">{fontFile.label}</span>
                <button type="button" className="iconbtn" aria-label="Remove font file" onClick={() => setFontFile(null)}>
                  <X size={16} aria-hidden="true" />
                </button>
              </>
            )}
          </div>
          <span className="hint">Licensed WOFF2, WOFF, TTF or OTF. Without one, captions use the bundled Inter, and the render report says so.</span>
        </div>
      </div>
      <div className="field">
        <span>Logo</span>
        <div className="row">
          <button type="button" className="btn btn--ghost" onClick={() => void pick('logo')}>
            <ImagePlus size={16} aria-hidden="true" /> {logoFile ? 'Replace logo' : 'Choose logo'}
          </button>
          {logoFile && (
            <>
              <span className="mono path">{logoFile.label}</span>
              <button type="button" className="iconbtn" aria-label="Remove logo" onClick={() => setLogoFile(null)}>
                <X size={16} aria-hidden="true" />
              </button>
            </>
          )}
        </div>
        <span className="hint">PNG or JPEG. Drawn in the top-right corner of the safe area, aspect kept.</span>
      </div>
      <label className="field">
        <span>Glossary (comma-separated; also spelled this way by transcription)</span>
        <input value={glossary} onChange={(e) => setGlossary(e.target.value)} placeholder="Flutter, Dio" />
      </label>
      <label className="field">
        <span>Prohibited claims (one per line; hooks and graphics never use them)</span>
        <textarea rows={3} value={claims} onChange={(e) => setClaims(e.target.value)} placeholder="fastest" />
      </label>
      <div className="row">
        <button type="submit" className="btn btn--ghost" disabled={busy || !name.trim()}>
          {busy ? 'Saving…' : brand ? 'Save new version' : 'Save brand'}
        </button>
        {saved && (
          <span role="status" className="muted">
            {saved}
          </span>
        )}
      </div>
      <ErrorNote error={error} />
    </form>
  );
}

/** Settings card: every library brand, each editable (a save is a new version; renders keep the version they used). */
export function BrandLibrary({ ctx }: { ctx: AppCtx }) {
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const current = ctx.brands.find((b) => b.id === editing) ?? null;
  return (
    <section className="card" aria-labelledby="brands-h">
      <h2 id="brands-h" className="card__head">
        Brand profiles
      </h2>
      {ctx.brands.length === 0 ? (
        <p className="muted">No brand yet. A brand sets caption colours, font, logo, hook tone, glossary and prohibited claims.</p>
      ) : (
        <ul className="plain-list">
          {ctx.brands.map((b) => (
            <li key={b.id} className="row">
              <span>{b.name}</span> <span className="mono muted">v{b.version}</span>
              <button type="button" className="btn btn--quiet btn--sm" aria-expanded={editing === b.id} onClick={() => setEditing(editing === b.id ? null : b.id)}>
                Edit
              </button>
            </li>
          ))}
        </ul>
      )}
      {editing !== null ? (
        <BrandEditor key={editing} ctx={ctx} brand={editing === 'new' ? null : current} onSaved={() => setEditing(null)} />
      ) : (
        <button type="button" className="btn btn--ghost" onClick={() => setEditing('new')}>
          New brand
        </button>
      )}
    </section>
  );
}
