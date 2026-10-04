// Create screen (PRD 5.2): Footage · Edits · Output. Three columns at ≥1200px, stacked steps below.
import { useEffect, useId, useState, type DragEvent } from 'react';
import {
  ArrowDown, ArrowUp, AudioLines, Captions, ChevronDown, ChevronUp, FileVideo, Hourglass, Image, Images, Info, MessageSquareX, Mic, Music,
  Palette, Scissors, Shapes, Sparkles, Type, Upload, ZoomIn, type LucideIcon,
} from 'lucide-react';
import type { BooleanSettingKey, CaptionTemplate, FillerStrength } from '@takeoff/contracts';
import { api, bridge, describe, mediaUrl, newKey, type Snapshot } from './api.ts';
import type { AppCtx } from './App.tsx';
import { ProjectFolder } from './FirstRun.tsx';
import {
  CAPTION_STYLES, FILLER_STRENGTHS, TARGET_CHOICES, TOGGLES, ZOOM_MAX_OPTIONS, availability, creatorPolish, defaultEdits, editBlocker, effectiveSettings,
  lengthPolicy, move, parseTarget, targetLabel, type EditOptions, type TargetChoice, type ToggleDef,
} from './logic.ts';
import { ErrorNote, Label, Switch, usePref } from './ui.tsx';

const ICONS: Record<BooleanSettingKey, LucideIcon> = {
  badTakes: Scissors, fillers: MessageSquareX, silence: Hourglass, captions: Captions, aiBroll: Sparkles, userBroll: Images, zoom: ZoomIn,
  music: Music, sfx: AudioLines, studioVoice: Mic, autoColor: Palette, textHook: Type, motionGraphics: Shapes,
};

interface Card {
  key: string;
  assetId?: string;
  name: string;
  kind: 'video' | 'audio' | 'image';
  status: 'importing' | 'ready' | 'error';
  error?: string;
  selected: boolean;
  durationUs: number | null;
  thumb?: string;
  /** F07: B-roll tags (file-name words are added by the engine). */
  tags?: string[];
}
type Pool = 'takes' | 'broll';

const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;
const joinPath = (dir: string, name: string) => `${dir.replace(/[\\/]+$/, '')}${dir.includes('\\') && !dir.includes('/') ? '\\' : '/'}${name}`;
const fmtDur = (us: number | null) => (us === null ? '–' : `${Math.floor(us / 60e6)}:${String(Math.floor((us / 1e6) % 60)).padStart(2, '0')}`);
const kindOf = (p: string): Card['kind'] => (/\.(png|jpe?g)$/i.test(p) ? 'image' : 'video');

export function Create({ ctx }: { ctx: AppCtx }) {
  const [edits, setEdits] = usePref<EditOptions>('edits', defaultEdits());
  const [names, setNames] = usePref<Record<string, string>>('assetNames', {});
  const [takes, setTakes] = useState<Card[]>([]);
  const [broll, setBroll] = useState<Card[]>([]);
  const [target, setTarget] = useState<TargetChoice>('auto');
  const [custom, setCustom] = useState('');
  const [hardMax, setHardMax] = useState(false);

  const [brief, setBrief] = useState('');
  const [preset, setPreset] = usePref<'final_1080' | 'draft_720'>('outputPreset', 'final_1080');
  const [error, setError] = useState<ReturnType<typeof describe> | null>(null);
  const [starting, setStarting] = useState(false);

  // Reopen the last project's footage and choices.
  useEffect(() => {
    if (!ctx.projectId) return;
    api<Snapshot>('GET', `/v1/projects/${ctx.projectId}`)
      .then((s) => {
        const order = s.editDefaults?.takes;
        const card = (a: Snapshot['assets'][number]): Card => ({ key: a.id, assetId: a.id, name: names[a.id] ?? a.name ?? basename(a.relativePath), kind: a.kind, status: 'ready', selected: !order || order.includes(a.id), durationUs: a.probe.durationUs, tags: a.tags });
        const t = s.assets.filter((a) => a.pool === 'takes').map(card);
        if (order) t.sort((x, y) => (order.indexOf(x.assetId!) + 1 || 1e9) - (order.indexOf(y.assetId!) + 1 || 1e9));
        setTakes(t);
        setBroll(s.assets.filter((a) => a.pool === 'broll').map(card));
        if (s.editDefaults?.targetSeconds) {
          const c = String(s.editDefaults.targetSeconds);
          setTarget((TARGET_CHOICES as readonly string[]).includes(c) ? (c as TargetChoice) : 'custom');
          setCustom(c);
          setHardMax(s.editDefaults.lengthPolicy === 'hard_max');
        }
        for (const c of t) void thumb(s.project.id, c.assetId!, c.durationUs, c.kind, setTakes);
      })
      .catch(() => ctx.setProjectId(null)); // moved or no longer approved: start fresh
  }, [ctx.projectId]);

  async function thumb(projectId: string, assetId: string, durationUs: number | null, kind: Card['kind'], set: typeof setTakes) {
    if (kind !== 'video' || !durationUs) return;
    try {
      const r = await api<{ frames: Array<{ artifactId: string }> }>('POST', `/v1/projects/${projectId}/frames`, { schemaVersion: '1.0', frames: [{ clock: 'source', assetId, us: Math.floor(Math.min(1e6, durationUs / 2)) }], width: 320 });
      const src = mediaUrl(projectId, r.frames[0]!.artifactId);
      set((cs) => cs.map((c) => (c.assetId === assetId ? { ...c, thumb: src } : c)));
    } catch {
      // no thumbnail: the card still shows name, duration and status
    }
  }

  async function ensureProject(): Promise<string> {
    if (ctx.projectId) return ctx.projectId;
    if (!ctx.projectFolder) throw new Error('choose a project folder first');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
    const root = joinPath(ctx.projectFolder, `takeoff-${stamp}`);
    const r = await api<{ projectId: string }>('POST', `/v1/projects?root=${encodeURIComponent(root)}`, { schemaVersion: '1.0', name: `Short ${stamp}`, settings: effectiveSettings(edits.settings, ctx.caps) });
    ctx.setProjectId(r.projectId);
    return r.projectId;
  }

  async function addPaths(paths: string[], pool: Pool) {
    if (!paths.length) return;
    setError(null);
    const set = pool === 'takes' ? setTakes : setBroll;
    const pending: Card[] = paths.map((p) => ({ key: newKey('f'), name: basename(p), kind: kindOf(p), status: 'importing', selected: true, durationUs: null }));
    set((cs) => [...cs, ...pending]);
    try {
      const id = await ensureProject();
      const r = await api<{ items: Array<{ index: number; assetId?: string; error?: { message: string; remedy: string } }> }>('POST', `/v1/projects/${id}/assets?pool=${pool}`, { schemaVersion: '1.0', items: paths.map((path) => ({ source: 'path', path })) });
      const snap = await api<Snapshot>('GET', `/v1/projects/${id}`);
      const nextNames = { ...names };
      const done = pending.map((c, i) => {
        const item = r.items.find((x) => x.index === i);
        if (!item?.assetId) return { ...c, status: 'error' as const, error: item?.error ? `${item.error.message}. ${item.error.remedy}` : 'Import failed.', selected: false };
        nextNames[item.assetId] = c.name;
        const a = snap.assets.find((x) => x.id === item.assetId);
        return { ...c, assetId: item.assetId, kind: a?.kind ?? c.kind, status: 'ready' as const, durationUs: a?.probe.durationUs ?? null };
      });
      setNames(nextNames);
      // The same file imported twice is one asset: keep the first card.
      set((cs) => {
        const rest = cs.filter((c) => !pending.some((p) => p.key === c.key));
        return [...rest, ...done.filter((d) => !d.assetId || !rest.some((c) => c.assetId === d.assetId))];
      });
      for (const c of done) if (c.assetId) void thumb(id, c.assetId, c.durationUs, c.kind, set);
    } catch (e) {
      set((cs) => cs.map((c) => (pending.some((p) => p.key === c.key) ? { ...c, status: 'error', error: describe(e).message, selected: false } : c)));
      setError(describe(e));
    }
  }

  /** F07: tags say what a B-roll shows; it is placed only where one matches a spoken word. */
  async function saveTags(c: Card, tags: string[]) {
    if (!ctx.projectId || !c.assetId) return;
    setError(null);
    try {
      const r = await api<{ tags: string[] }>('PATCH', `/v1/projects/${ctx.projectId}/assets/${encodeURIComponent(c.assetId)}`, { tags });
      setBroll((cs) => cs.map((x) => (x.key === c.key ? { ...x, tags: r.tags } : x)));
    } catch (e) {
      setError(describe(e));
    }
  }

  const pick = async (pool: Pool) => addPaths(await bridge().pickFiles(pool), pool);
  const drop = async (e: DragEvent, pool: Pool) => {
    e.preventDefault();
    await addPaths(await bridge().dropFiles([...e.dataTransfer.files], pool), pool);
  };

  const t = parseTarget(target, custom);
  const selected = takes.filter((c) => c.selected && c.assetId && c.status === 'ready');
  const blocker = editBlocker({ projectFolder: ctx.projectFolder ?? ctx.projectId, selectedTakes: selected.length, importing: [...takes, ...broll].some((c) => c.status === 'importing'), targetError: t.error, caps: ctx.caps });

  async function editVideo() {
    setStarting(true);
    setError(null);
    try {
      const id = await ensureProject();
      // The library brand's latest version is stored in the project; the plan then names that exact version.
      const brand = ctx.brands.find((b) => b.id === ctx.brandId);
      if (brand) await api('POST', `/v1/projects/${id}/brands`, { brandId: brand.id, version: brand.version });
      const brandProfileId = brand?.id ?? null;
      await api('POST', `/v1/projects/${id}/edit-defaults`, {
        settings: effectiveSettings(edits.settings, ctx.caps),
        targetSeconds: t.seconds,
        lengthPolicy: lengthPolicy(t.seconds, hardMax),
        takes: selected.map((c) => c.assetId),
        brandProfileId,
        brief: brief.trim() || null,
        captionTemplate: edits.captionTemplate,
        zoomMaxScale: edits.zoomMaxScale,
      });
      const snap = await api<Snapshot>('GET', `/v1/projects/${id}`);
      const job = await api<{ id: string }>('POST', `/v1/projects/${id}/jobs`, { schemaVersion: '1.0', stage: 'Prepare', profile: 'draft', baseRevision: snap.project.revision, idempotencyKey: newKey('edit') });
      ctx.runJob(job.id, 'review');
    } catch (e) {
      setError(describe(e));
    } finally {
      setStarting(false);
    }
  }

  const newProject = () => {
    ctx.setProjectId(null);
    setTakes([]);
    setBroll([]);
  };

  return (
    <div className="create">
      <section className="col" aria-labelledby="footage-h">
        <h2 id="footage-h" className="col__head">
          <span className="stepnum" aria-hidden="true">1</span> Footage
        </h2>
        {!ctx.projectFolder && !ctx.projectId && <ProjectFolder ctx={ctx} />}
        <Pool title="Takes" pool="takes" cards={takes} setCards={setTakes} onPick={() => pick('takes')} onDrop={(e) => drop(e, 'takes')} ordered />
        <Pool title="Own B-roll" pool="broll" cards={broll} setCards={setBroll} onPick={() => pick('broll')} onDrop={(e) => drop(e, 'broll')} onTags={saveTags} />
        {ctx.projectId && (
          <button type="button" className="btn btn--quiet" onClick={newProject}>
            New project
          </button>
        )}
      </section>

      <section className="col" aria-labelledby="edits-h">
        <h2 id="edits-h" className="col__head">
          <span className="stepnum" aria-hidden="true">2</span> Edits
        </h2>
        <div className="row" role="group" aria-label="Presets">
          <button type="button" className="btn btn--ghost" onClick={() => setEdits(defaultEdits())}>
            Recommended
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => setEdits(creatorPolish(edits))}>
            Creator polish
          </button>
        </div>
        <ul className="toggles">
          {TOGGLES.map((def) => (
            <ToggleRow key={def.key} def={def} edits={edits} setEdits={setEdits} ctx={ctx} />
          ))}
        </ul>
      </section>

      <section className="col" aria-labelledby="output-h">
        <h2 id="output-h" className="col__head">
          <span className="stepnum" aria-hidden="true">3</span> Output
        </h2>
        <fieldset className="field">
          <legend>Target length</legend>
          <div className="segmented">
            {TARGET_CHOICES.map((c) => (
              <label key={c} className={target === c ? 'is-on' : undefined}>
                <input type="radio" name="target" value={c} checked={target === c} onChange={() => setTarget(c)} />
                {targetLabel(c)}
              </label>
            ))}
          </div>
          {target === 'custom' && (
            <label className="field">
              <span>Seconds (10–180)</span>
              <input type="number" min={10} max={180} step={1} value={custom} onChange={(e) => setCustom(e.target.value)} aria-invalid={!!t.error} aria-describedby="target-err" />
              {t.error && (
                <span id="target-err" className="error-text">
                  {t.error}
                </span>
              )}
            </label>
          )}
          <label className="check">
            <input type="checkbox" checked={hardMax} disabled={t.seconds === null} onChange={(e) => setHardMax(e.target.checked)} /> Hard maximum
          </label>
          <p className="hint">{target === 'auto' ? 'Keeps a complete story and reports the actual length.' : hardMax ? 'Never longer than this; a conflict is reported instead.' : 'A preference: within ±10% or 2 s. Speech is never sped up.'}</p>
        </fieldset>
        <label className="field">
          <span>Brand</span>
          <select value={ctx.brands.some((b) => b.id === ctx.brandId) ? ctx.brandId! : ''} onChange={(e) => ctx.setBrandId(e.target.value || null)}>
            <option value="">None</option>
            {ctx.brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name} (v{b.version})
              </option>
            ))}
          </select>
          <span className="hint">Create or edit brands in Settings.</span>
        </label>
        <label className="field is-disabled">
          <span>Reference</span>
          <input disabled placeholder="Reference media or URL" aria-describedby="ref-why" />
          <span id="ref-why" className="hint">
            Unavailable: reference style analysis is planned for a later release (P1).
          </span>
        </label>
        <label className="field">
          <span>Creative brief</span>
          <textarea rows={3} maxLength={500} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="Calm, practical, for Flutter developers" />
        </label>
        <label className="field">
          <span>Output preset</span>
          <select value={preset} onChange={(e) => setPreset(e.target.value as typeof preset)}>
            <option value="final_1080">1080×1920 · 30 fps · final</option>
            <option value="draft_720">720p · draft</option>
          </select>
          <span className="hint">Edit Video renders a quick draft to review; this preset is used when you export.</span>
        </label>
        <div className="primary">
          <button type="button" className="btn btn--brand" disabled={!!blocker || starting} aria-describedby={blocker ? 'edit-blocker' : undefined} onClick={editVideo}>
            {starting ? 'Starting…' : 'Edit Video'}
          </button>
          {blocker && (
            <p id="edit-blocker" className="hint">
              {blocker}
            </p>
          )}
        </div>
        <ErrorNote error={error} />
      </section>
    </div>
  );
}

function Pool(p: { title: string; pool: Pool; cards: Card[]; setCards(f: (c: Card[]) => Card[]): void; onPick(): void; onDrop(e: DragEvent): void; ordered?: boolean; onTags?(c: Card, tags: string[]): void }) {
  const [over, setOver] = useState(false);
  const id = useId();
  return (
    <div className="pool" aria-labelledby={id}>
      <div className="pool__head">
        <Label id={id}>{p.title}</Label>
        <button type="button" className="btn btn--quiet" onClick={p.onPick}>
          <Upload size={16} aria-hidden="true" /> Add files
        </button>
      </div>
      <div
        className={over ? 'dropzone is-over' : 'dropzone'}
        onDragOver={(e) => (e.preventDefault(), setOver(true))}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => (setOver(false), p.onDrop(e))}
      >
        {p.cards.length === 0 ? (
          <p className="muted">{p.pool === 'takes' ? 'Drop recordings here, or add files. MP4 or MOV.' : 'Drop B-roll clips or images here. Kept apart from your takes.'}</p>
        ) : (
          <ol className="footage-list">
            {p.cards.map((c, i) => (
              <FootageCard key={c.key} card={c} index={i} count={p.cards.length} ordered={!!p.ordered} set={(next) => p.setCards((cs) => cs.map((x) => (x.key === c.key ? next : x)))} move={(d) => p.setCards((cs) => move(cs, i, d))} onTags={p.onTags && ((tags) => p.onTags!(c, tags))} />
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function FootageCard({ card: c, index, count, ordered, set, move, onTags }: { card: Card; index: number; count: number; ordered: boolean; set(c: Card): void; move(d: -1 | 1): void; onTags?(tags: string[]): void }) {
  const nameId = useId();
  const [tags, setTags] = useState((c.tags ?? []).join(', '));
  useEffect(() => setTags((c.tags ?? []).join(', ')), [c.tags?.join()]);
  const status = c.status === 'importing' ? 'Importing…' : c.status === 'error' ? `Failed: ${c.error ?? ''}` : 'Ready';
  return (
    <li className={c.selected ? 'footage is-selected' : 'footage'} aria-labelledby={nameId}>
      <div className="footage__thumb">{c.thumb ? <img src={c.thumb} alt="" /> : c.kind === 'image' ? <Image size={20} aria-hidden="true" /> : <FileVideo size={20} aria-hidden="true" />}</div>
      <div className="footage__body">
        <span id={nameId} className="footage__name" title={c.name}>
          {c.name}
        </span>
        <span className="mono muted">{fmtDur(c.durationUs)}</span>
        <span className={c.status === 'error' ? 'footage__status error-text' : 'footage__status'}>{status}</span>
        <label className="check">
          <input type="checkbox" checked={c.selected} disabled={c.status !== 'ready'} onChange={(e) => set({ ...c, selected: e.target.checked })} /> Use in edit
        </label>
        {onTags && c.status === 'ready' && (
          <form className="row" onSubmit={(e) => (e.preventDefault(), onTags(tags.split(',').map((t) => t.trim()).filter(Boolean)))}>
            <label className="field">
              <span>Tags (what it shows)</span>
              <input value={tags} maxLength={400} placeholder="server, network" onChange={(e) => setTags(e.target.value)} />
            </label>
            <button type="submit" className="btn btn--quiet btn--sm">
              Save tags
            </button>
          </form>
        )}
      </div>
      {ordered && (
        <div className="footage__order">
          <span className="disc" aria-label={`Take ${index + 1} of ${count}`}>
            {index + 1}
          </span>
          <button type="button" className="iconbtn" onClick={() => move(-1)} disabled={index === 0} aria-label={`Move ${c.name} earlier`}>
            <ArrowUp size={16} aria-hidden="true" />
          </button>
          <button type="button" className="iconbtn" onClick={() => move(1)} disabled={index === count - 1} aria-label={`Move ${c.name} later`}>
            <ArrowDown size={16} aria-hidden="true" />
          </button>
        </div>
      )}
    </li>
  );
}

function ToggleRow({ def, edits, setEdits, ctx }: { def: ToggleDef; edits: EditOptions; setEdits(e: EditOptions): void; ctx: AppCtx }) {
  const [info, setInfo] = useState(false);
  const [open, setOpen] = useState(false);
  const id = useId();
  const a = availability(def, ctx.caps);
  const off = a.status === 'unavailable';
  const on = !off && edits.settings[def.key];
  const Icon = ICONS[def.key];
  const hasSettings = def.key === 'fillers' || def.key === 'captions' || def.key === 'zoom';
  const set = (patch: Partial<EditOptions> & { fillerStrength?: FillerStrength }) => {
    const { fillerStrength, ...rest } = patch;
    setEdits({ ...edits, ...rest, settings: fillerStrength ? { ...edits.settings, fillerStrength } : edits.settings });
  };
  return (
    <li className={off ? 'toggle-row is-unavailable' : 'toggle-row'}>
      <div className="toggle-row__main">
        <Icon size={16} aria-hidden="true" className="toggle-row__icon" />
        <span id={`${id}-name`} className="toggle-row__name">
          {def.name}
        </span>
        <button type="button" className="iconbtn" aria-expanded={info} aria-controls={`${id}-info`} onClick={() => setInfo(!info)} aria-label={`About ${def.name}`}>
          <Info size={16} aria-hidden="true" />
        </button>
        {hasSettings && (
          <button type="button" className="iconbtn" aria-expanded={open} aria-controls={`${id}-settings`} onClick={() => setOpen(!open)} aria-label={`${def.name} settings`} disabled={off}>
            {open ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
          </button>
        )}
        <Switch checked={on} disabled={off} labelledBy={`${id}-name`} describedBy={a.reason ? `${id}-reason` : undefined} onChange={(v) => setEdits({ ...edits, settings: { ...edits.settings, [def.key]: v } })} />
      </div>
      {a.reason && (
        <p id={`${id}-reason`} className="toggle-row__reason">
          {off ? 'Unavailable: ' : a.status === 'experimental' ? 'Experimental: ' : ''}
          {a.reason}
        </p>
      )}
      <p id={`${id}-info`} className="toggle-row__info" hidden={!info}>
        {def.info}
      </p>
      {hasSettings && (
        <div id={`${id}-settings`} className="toggle-row__settings" hidden={!open}>
          {def.key === 'fillers' && <FillerWords edits={edits} setEdits={setEdits} />}
          {def.key === 'fillers' && (
            <label className="field">
              <span>Strength</span>
              <select value={edits.settings.fillerStrength ?? 'normal'} onChange={(e) => set({ fillerStrength: e.target.value as FillerStrength })}>
                {FILLER_STRENGTHS.map((s) => (
                  <option key={s} value={s}>
                    {s[0]!.toUpperCase() + s.slice(1)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {def.key === 'captions' && (
            <label className="field">
              <span>Caption style</span>
              <select value={edits.captionTemplate} onChange={(e) => set({ captionTemplate: e.target.value as CaptionTemplate })}>
                {CAPTION_STYLES.map((s) => (
                  <option key={s} value={s}>
                    {s === 'static' ? 'Static (no animation)' : s[0]!.toUpperCase() + s.slice(1)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {def.key === 'zoom' && (
            <label className="field">
              <span>Maximum zoom</span>
              <select value={edits.zoomMaxScale} onChange={(e) => set({ zoomMaxScale: Number(e.target.value) })}>
                {ZOOM_MAX_OPTIONS.map((z) => (
                  <option key={z} value={z}>
                    {z.toFixed(2)}×{z === 1.15 ? ' (gentle)' : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
    </li>
  );
}

/** F04 custom dictionary: words always kept (even if they look like fillers) and words or phrases always cut. */
function FillerWords({ edits, setEdits }: { edits: EditOptions; setEdits(e: EditOptions): void }) {
  const dict = edits.settings.fillerDictionary ?? { preserve: [], remove: [] };
  const set = (k: 'preserve' | 'remove', text: string) => {
    const next = { ...dict, [k]: text.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 200).map((x) => x.slice(0, 40)) };
    // Empty lists are sent as such (not omitted), so clearing them also clears the project's stored dictionary.
    setEdits({ ...edits, settings: { ...edits.settings, fillerDictionary: next } });
  };
  return (
    <div className="row row--top">
      <label className="field">
        <span>Always keep (one per line)</span>
        <textarea rows={2} defaultValue={dict.preserve.join('\n')} onBlur={(e) => set('preserve', e.target.value)} placeholder="like" />
      </label>
      <label className="field">
        <span>Always cut (one per line)</span>
        <textarea rows={2} defaultValue={dict.remove.join('\n')} onBlur={(e) => set('remove', e.target.value)} placeholder="you know" />
      </label>
    </div>
  );
}
