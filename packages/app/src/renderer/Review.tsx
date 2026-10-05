// Review and refine (PRD 5.4, 5.5): player left, editable transcript right, change summary, review markers and
// a collapsed timeline below. Every edit is a typed patch on the current revision; direct edits lock their object.
import { useEffect, useRef, useState } from 'react';
import { AudioLines, Captions, Eye, Film, History, Images, Lock, LockOpen, Music, Redo2, RotateCcw, Send, Shapes, TriangleAlert, Undo2, Wand2, type LucideIcon } from 'lucide-react';
import type { EditPlan, PatchOp } from '@takeoff/contracts';
import { api, describe, mediaUrl, newKey, patchPlan, type Snapshot } from './api.ts';
import type { AppCtx } from './App.tsx';
import { ExportDialog } from './ExportDialog.tsx';
import { JobStages } from './Processing.tsx';
import { CAPTION_STYLES, TARGET_CHOICES, lengthPolicy, parseTarget, sourceCutAt, summarize, summaryLine, targetLabel, timelineClips, transcriptItems, type Clip, type LaneId, type TargetChoice } from './logic.ts';
import { ErrorNote, Label, Switch, fmtSeconds } from './ui.tsx';

const LANES: Array<[LaneId, string, LucideIcon]> = [
  ['video', 'Video', Film],
  ['captions', 'Captions', Captions],
  ['broll', 'B-roll', Images],
  ['motion', 'Motion', Shapes],
  ['music', 'Music', Music],
  ['sfx', 'SFX', AudioLines],
];

export function Review({ ctx, projectId }: { ctx: AppCtx; projectId: string }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<ReturnType<typeof describe> | null>(null);
  const [compare, setCompare] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [renderJob, setRenderJob] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [time, setTime] = useState(0);
  const [status, setStatus] = useState('');
  const video = useRef<HTMLVideoElement>(null);

  const reload = () =>
    api<Snapshot>('GET', `/v1/projects/${projectId}`)
      .then(setSnap)
      .catch((e) => setError(describe(e)));
  useEffect(() => void reload(), [projectId]);

  const head = snap?.plan ?? null;
  const rev = head?.revision ?? 0;
  const run = async (what: string, f: () => Promise<unknown>) => {
    setError(null);
    try {
      await f();
      setStatus(what);
      await reload();
    } catch (e) {
      setError(describe(e));
    }
  };
  const edit = (what: string, ops: PatchOp[]) => run(what, () => patchPlan(projectId, rev, ops));
  /** A direct edit: unlock if needed, change, then lock against regeneration (PRD 5.4). */
  const directEdit = (what: string, objectId: string, locked: boolean, ops: PatchOp[]) =>
    edit(what, [...(locked ? [{ op: 'unlock_object' as const, objectId }] : []), ...ops, { op: 'lock_object', objectId }]);
  const undo = () => run('Undone', () => api('POST', `/v1/projects/${projectId}/undo`, { baseRevision: snap?.project.revision }));
  const redo = () => run('Redone', () => api('POST', `/v1/projects/${projectId}/redo`, { baseRevision: snap?.project.revision }));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z' || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) return; // native text undo
      e.preventDefault();
      void (e.shiftKey ? redo() : undo());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!snap) return <p role="status">{error ? <ErrorNote error={error} /> : 'Loading project…'}</p>;
  if (!head) {
    return (
      <section className="narrow">
        <h1 className="h1">No edit yet</h1>
        <p className="muted">Run Edit Video on the Create screen to get a draft to review.</p>
        <button type="button" className="btn btn--ghost" onClick={() => ctx.go('create')}>
          Go to create
        </button>
      </section>
    );
  }
  const plan = head.plan;
  const draft = snap.artifacts.filter((a) => a.kind === 'render_draft' && a.ref.endsWith(`-r${rev}.mp4`)).at(-1);
  const firstAsset = plan.segments[0]?.assetId;
  const proxy = snap.artifacts.find((a) => a.kind === 'proxy' && a.assetId === firstAsset);
  const src = compare ? proxy && mediaUrl(projectId, proxy.id) : draft && mediaUrl(projectId, draft.id);
  const geo = timelineClips(plan, snap.transcripts);
  const director = ctx.caps?.models.some((m) => m.kind === 'director' && m.backend === 'ollama') ?? false;

  const startRender = async () => {
    setError(null);
    try {
      const j = await api<{ id: string }>('POST', `/v1/projects/${projectId}/jobs`, { schemaVersion: '1.0', stage: 'Render preview', profile: 'draft', baseRevision: rev, idempotencyKey: newKey('render') });
      setRenderJob(j.id);
    } catch (e) {
      setError(describe(e));
    }
  };
  const seek = (sec: number) => {
    if (video.current && !compare) video.current.currentTime = sec;
  };

  return (
    <div className="review">
      <div className="toolbar" role="toolbar" aria-label="Edit history and output">
        <button type="button" className="btn btn--ghost" onClick={undo} aria-keyshortcuts="Meta+Z Control+Z">
          <Undo2 size={16} aria-hidden="true" /> Undo
        </button>
        <button type="button" className="btn btn--ghost" onClick={redo} aria-keyshortcuts="Shift+Meta+Z Shift+Control+Z">
          <Redo2 size={16} aria-hidden="true" /> Redo
        </button>
        <Revert snap={snap} onRevert={(r) => run(`Reverted to revision ${r}`, () => api('POST', `/v1/projects/${projectId}/revert`, { revision: r, baseRevision: snap.project.revision }))} />
        <button type="button" className="btn btn--ghost" aria-pressed={compare} onClick={() => setCompare(!compare)} disabled={!proxy}>
          <Eye size={16} aria-hidden="true" /> Compare original
        </button>
        <span className="spacer" />
        <span className="mono muted">r{rev}</span>
        <button type="button" className="btn btn--brand" onClick={() => setExporting(true)}>
          Export
        </button>
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>
      <ErrorNote error={error} />

      <div className="review__grid">
        <section className="player" aria-label="Player">
          {src ? (
            <video ref={video} key={src} src={src} controls className="player__video" onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)} />
          ) : (
            <div className="player__empty">
              <p>{compare ? 'The original has no preview proxy.' : 'The preview is out of date for this revision.'}</p>
            </div>
          )}
          {compare && <p className="player__tag mono">Original</p>}
          {!draft && !compare && !renderJob && (
            <button type="button" className="btn btn--ghost" onClick={startRender}>
              Update preview
            </button>
          )}
          {renderJob && <JobStages jobId={renderJob} onDone={(j) => (setRenderJob(null), j.state === 'succeeded' ? reload() : setError(j.error))} />}
        </section>

        <section className="transcript-pane" aria-labelledby="tx-h">
          <h2 id="tx-h" className="col__head">
            Transcript
          </h2>
          <Transcript plan={plan} snap={snap} onSeek={seek} onRestore={(i) => edit(`Restored ${i.words.join(' ') || 'pause'}`, [{ op: 'restore_span', assetId: i.assetId, sourceStartUs: i.startUs, sourceEndUs: i.endUs }])} />
        </section>
      </div>

      <div className="review__below">
        <Summary plan={plan} onSelect={setSelected} />
        <Adjust ctx={ctx} projectId={projectId} snap={snap} plan={plan} director={director} rev={rev} onEdit={edit} onError={setError} onStatus={(s) => (setStatus(s), reload())} />
      </div>

      <details className="timeline-wrap">
        <summary>Timeline</summary>
        <Timeline geo={geo} time={compare ? null : time} selected={selected} onSelect={setSelected} />
        {selected && <Inspector plan={plan} snap={snap} id={selected} time={time} segStart={geo.segStart} onEdit={edit} onDirect={directEdit} />}
      </details>

      {exporting && <ExportDialog ctx={ctx} projectId={projectId} plan={plan} rev={rev} onClose={() => setExporting(false)} />}
    </div>
  );
}

function Revert({ snap, onRevert }: { snap: Snapshot; onRevert(r: number): void }) {
  const [r, setR] = useState('');
  return (
    <span className="revert">
      <label className="sr-only" htmlFor="revert-sel">
        Revision to revert to
      </label>
      <select id="revert-sel" value={r} onChange={(e) => setR(e.target.value)}>
        <option value="">Revision…</option>
        {snap.revisions
          .filter((x) => x.revision < snap.project.revision && x.revision > 0)
          .reverse()
          .map((x) => (
            <option key={x.revision} value={x.revision}>
              r{x.revision} · {x.author}
              {x.op ? ` · ${x.op}` : ''}
            </option>
          ))}
      </select>
      <button type="button" className="btn btn--ghost" disabled={!r} onClick={() => onRevert(Number(r))}>
        <History size={16} aria-hidden="true" /> Revert
      </button>
    </span>
  );
}

function Transcript({ plan, snap, onSeek, onRestore }: { plan: EditPlan; snap: Snapshot; onSeek(sec: number): void; onRestore(i: Extract<ReturnType<typeof transcriptItems>[number], { kind: 'removed' }>): void }) {
  const items = transcriptItems(plan, snap.transcripts);
  const geo = timelineClips(plan, snap.transcripts);
  const wordSec = (id: string, us: number) => {
    const g = plan.segments.find((s) => s.wordIds.includes(id));
    return g ? geo.segStart.get(g.id)! + (us - g.sourceStartUs) / 1e6 : 0;
  };
  if (!items.length) return <p className="muted">No speech was transcribed.</p>;
  return (
    <div className="transcript">
      {items.map((i) =>
        i.kind === 'word' ? (
          <span key={i.id} className={i.lowConfidence ? 'word word--low' : 'word'} onClick={() => onSeek(wordSec(i.id, i.startUs))} title={i.lowConfidence ? 'Low-confidence word: check it' : undefined}>
            {i.text}
            {i.lowConfidence && (
              <>
                <TriangleAlert size={12} aria-hidden="true" className="word__icon" />
                <span className="sr-only"> (low confidence)</span>
              </>
            )}{' '}
          </span>
        ) : (
          <span key={i.key} className="cut">
            {i.words.length ? <s>{i.words.join(' ')}</s> : <span className="mono muted">· {((i.endUs - i.startUs) / 1e6).toFixed(1)}s</span>}
            <span className="cut__reason">{i.reason}</span>
            <button type="button" className="btn btn--quiet btn--sm" onClick={() => onRestore(i)} aria-label={`Restore ${i.words.length ? `“${i.words.join(' ')}”` : `${((i.endUs - i.startUs) / 1e6).toFixed(1)} second pause`}, removed for ${i.reason}`}>
              <RotateCcw size={12} aria-hidden="true" /> Restore
            </button>{' '}
          </span>
        ),
      )}
    </div>
  );
}

function Summary({ plan, onSelect }: { plan: EditPlan; onSelect(id: string): void }) {
  const s = summarize(plan);
  const reviews = plan.decisions.filter((d) => d.action === 'review');
  return (
    <section className="card summary" aria-labelledby="sum-h">
      <h2 id="sum-h" className="card__head">
        What changed
      </h2>
      <p>{summaryLine(s)}</p>
      <Label>Needs review ({s.review})</Label>
      {s.review === 0 ? (
        <p className="muted">Nothing is marked for review.</p>
      ) : (
        <ul className="markers">
          {plan.reviewMarkers.map((m) => (
            <li key={m.id}>
              <span className={`sev sev--${m.severity}`}>{m.severity === 'critical' ? 'Critical' : m.severity === 'warning' ? 'Check' : 'Note'}</span> {m.message}
              {m.refs[0] && (
                <button type="button" className="btn btn--quiet btn--sm" onClick={() => onSelect(m.refs[0]!)}>
                  Select
                </button>
              )}
            </li>
          ))}
          {reviews.map((d) => (
            <li key={d.id}>
              <span className="sev sev--warning">Check</span> Kept, uncertain: {d.reason}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Adjust(p: { ctx: AppCtx; projectId: string; snap: Snapshot; plan: EditPlan; director: boolean; rev: number; onEdit(what: string, ops: PatchOp[]): Promise<void>; onError(e: ReturnType<typeof describe>): void; onStatus(s: string): void }) {
  const d = p.snap.editDefaults;
  const initial = d?.targetSeconds ? String(d.targetSeconds) : 'auto';
  const [target, setTarget] = useState<TargetChoice>((TARGET_CHOICES as readonly string[]).includes(initial) ? (initial as TargetChoice) : 'custom');
  const [custom, setCustom] = useState(d?.targetSeconds ? String(d.targetSeconds) : '');
  const [hardMax, setHardMax] = useState(d?.lengthPolicy === 'hard_max');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const hook = p.plan.visuals.find((v) => v.kind === 'hook_text');
  const [hookText, setHookText] = useState(hook?.kind === 'hook_text' ? hook.text : '');
  // F13: up to three verbatim options; picking one sends its own evidence word ids, an edit keeps the current ones.
  const options = p.snap.hookOptions ?? [];
  const [evidence, setEvidence] = useState<string[]>(hook?.kind === 'hook_text' ? hook.evidenceIds : (options[0]?.evidenceIds ?? []));
  const t = parseTarget(target, custom);

  const rerun = async () => {
    try {
      await api('POST', `/v1/projects/${p.projectId}/edit-defaults`, { targetSeconds: t.seconds, lengthPolicy: lengthPolicy(t.seconds, hardMax) });
      const j = await api<{ id: string }>('POST', `/v1/projects/${p.projectId}/jobs`, { schemaVersion: '1.0', stage: 'Prepare', profile: 'draft', baseRevision: p.snap.project.revision, idempotencyKey: newKey('edit') });
      p.ctx.runJob(j.id, 'review');
    } catch (e) {
      p.onError(describe(e));
    }
  };
  const request = async () => {
    setBusy(true);
    try {
      const r = await api<{ intents: string[]; ops: number }>('POST', `/v1/projects/${p.projectId}/requests`, { text, baseRevision: p.rev });
      setText('');
      p.onStatus(`Applied ${r.ops} change${r.ops === 1 ? '' : 's'}. Update the preview to see them.`);
    } catch (e) {
      p.onError(describe(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card" aria-labelledby="adj-h">
      <h2 id="adj-h" className="card__head">
        Adjust
      </h2>
      <fieldset className="field">
        <legend>Target length</legend>
        <div className="segmented">
          {TARGET_CHOICES.map((c) => (
            <label key={c} className={target === c ? 'is-on' : undefined}>
              <input type="radio" name="adj-target" checked={target === c} onChange={() => setTarget(c)} />
              {targetLabel(c)}
            </label>
          ))}
        </div>
        {target === 'custom' && (
          <label className="field">
            <span>Seconds (10–180)</span>
            <input type="number" min={10} max={180} value={custom} onChange={(e) => setCustom(e.target.value)} aria-invalid={!!t.error} />
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={hardMax} disabled={t.seconds === null} onChange={(e) => setHardMax(e.target.checked)} /> Hard maximum
        </label>
        <button type="button" className="btn btn--ghost" disabled={!!t.error} onClick={rerun}>
          Re-run edit
        </button>
        {t.error && <span className="error-text">{t.error}</span>}
        <p className="hint">Re-running keeps every locked object.</p>
      </fieldset>
      {(hook?.kind === 'hook_text' || options.length > 0) && (
        <form className="field" onSubmit={(e) => (e.preventDefault(), void p.onEdit('Hook updated', [{ op: 'set_hook', text: hookText.trim() || null, evidenceIds: evidence }]))}>
          {options.length > 0 && (
            <fieldset className="radios radios--stack">
              <legend>Hook options (from what you said)</legend>
              {options.map((o, i) => (
                <label key={o.evidenceIds.join()}>
                  <input type="radio" name="hook-option" checked={hookText === o.text} onChange={() => (setHookText(o.text), setEvidence(o.evidenceIds))} /> {i + 1}. {o.text}
                </label>
              ))}
            </fieldset>
          )}
          <label className="field">
            <span>Text hook (edit freely)</span>
            <input value={hookText} maxLength={80} onChange={(e) => setHookText(e.target.value)} />
          </label>
          <button type="submit" className="btn btn--ghost" disabled={!evidence.length}>
            Save hook
          </button>
        </form>
      )}
      <form className="field" onSubmit={(e) => (e.preventDefault(), void request())}>
        <label className="field">
          <span>
            <Wand2 size={16} aria-hidden="true" /> Ask for a change
          </span>
          <input value={text} maxLength={500} disabled={!p.director || busy} onChange={(e) => setText(e.target.value)} placeholder="Static captions and quieter music" aria-describedby="req-why" />
        </label>
        <button type="submit" className="btn btn--ghost" disabled={!p.director || busy || !text.trim()}>
          <Send size={16} aria-hidden="true" /> {busy ? 'Working…' : 'Apply'}
        </button>
        <p id="req-why" className="hint">
          {p.director ? 'The local director maps your request to typed edits you can undo.' : 'Unavailable: needs a local director. Install Ollama with a model, then reopen Takeoff.'}
        </p>
      </form>
    </section>
  );
}

function Timeline({ geo, time, selected, onSelect }: { geo: ReturnType<typeof timelineClips>; time: number | null; selected: string | null; onSelect(id: string): void }) {
  const pct = (s: number) => `${geo.total ? (100 * s) / geo.total : 0}%`;
  return (
    <div className="timeline" role="group" aria-label="Timeline">
      <div className="timeline__ruler mono" aria-hidden="true">
        <span>0:00</span>
        <span>{fmtSeconds(geo.total / 2)}</span>
        <span>{fmtSeconds(geo.total)}</span>
      </div>
      {LANES.map(([lane, name, Icon]) => {
        const clips = geo.clips.filter((c) => c.lane === lane);
        return (
          <div key={lane} className="lane" role="group" aria-label={`${name} lane, ${clips.length} item${clips.length === 1 ? '' : 's'}`}>
            <div className="lane__head">
              <Icon size={16} aria-hidden="true" />
              <span className="label">{name}</span>
            </div>
            <div className="lane__track">
              {clips.map((c: Clip) => (
                <button
                  key={c.id}
                  type="button"
                  className={['clip', c.id === selected && 'is-selected', c.uncertain && 'is-uncertain', c.locked && 'is-locked'].filter(Boolean).join(' ')}
                  style={{ left: pct(c.start), width: pct(Math.max(c.end - c.start, geo.total / 400)) }}
                  aria-pressed={c.id === selected}
                  aria-label={`${name}: ${c.label}, ${fmtSeconds(c.start)} to ${fmtSeconds(c.end)}${c.locked ? ', locked' : ''}${c.uncertain ? ', needs review' : ''}`}
                  onClick={() => onSelect(c.id)}
                >
                  {c.locked && <Lock size={12} aria-hidden="true" />}
                  {c.uncertain && <TriangleAlert size={12} aria-hidden="true" />}
                  <span className="clip__name">{c.label}</span>
                </button>
              ))}
              {time !== null && <span className="playhead" style={{ left: pct(time) }} aria-hidden="true" />}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Inspector(p: { plan: EditPlan; snap: Snapshot; id: string; time: number; segStart: Map<string, number>; onEdit(what: string, ops: PatchOp[]): Promise<void>; onDirect(what: string, id: string, locked: boolean, ops: PatchOp[]): Promise<void> }) {
  const { plan, id } = p;
  const seg = plan.segments.find((g) => g.id === id);
  const cap = plan.captions.find((c) => c.id === id);
  const vis = plan.visuals.find((v) => v.id === id);
  const sfx = plan.audio.sfx.find((x) => x.id === id);
  const music = plan.audio.music?.assetId === id ? plan.audio.music : null;
  const obj = seg ?? cap ?? vis ?? sfx ?? music;
  const [text, setText] = useState(cap?.text ?? '');
  const [template, setTemplate] = useState(cap?.template ?? 'restrained');
  const [gain, setGain] = useState(String((sfx ?? music)?.gainDb ?? 0));
  const [crop, setCrop] = useState({ x: 0, y: 0, width: 1, height: 1 });
  useEffect(() => {
    setText(cap?.text ?? '');
    setTemplate(cap?.template ?? 'restrained');
    setGain(String((sfx ?? music)?.gainDb ?? 0));
  }, [id, p.snap.project.revision]);
  if (!obj) return <p className="muted">That object is no longer in the plan.</p>;
  const locked = !!obj.locked;
  const lockId = `${id}-lock`;
  const segIndex = seg ? plan.segments.indexOf(seg) : -1;
  const cutAt = seg ? sourceCutAt(plan, p.snap.transcripts, seg.id, p.time, p.segStart.get(seg.id) ?? 0) : null;
  const gainOps = (db: number): PatchOp[] => [{ op: 'set_gain', targetId: id, gainDb: db }];

  return (
    <section className="inspector card" aria-label="Selected object">
      <div className="row">
        <span id={lockId} className="toggle-row__name">
          {locked ? <Lock size={16} aria-hidden="true" /> : <LockOpen size={16} aria-hidden="true" />} Lock
        </span>
        <Switch checked={locked} labelledBy={lockId} onChange={(v) => void p.onEdit(v ? 'Locked' : 'Unlocked', [{ op: v ? 'lock_object' : 'unlock_object', objectId: id }])} />
        <span className="hint">Locked objects survive re-running the edit.</span>
      </div>
      {seg && (
        <>
          <div className="row">
            <button type="button" className="btn btn--quiet" disabled={segIndex === 0} onClick={() => void p.onDirect('Moved earlier', id, locked, [{ op: 'reorder_segment', segmentId: id, toIndex: segIndex - 1 }])}>
              Move earlier
            </button>
            <button type="button" className="btn btn--quiet" disabled={segIndex === plan.segments.length - 1} onClick={() => void p.onDirect('Moved later', id, locked, [{ op: 'reorder_segment', segmentId: id, toIndex: segIndex + 1 }])}>
              Move later
            </button>
            <button type="button" className="btn btn--quiet" disabled={cutAt === null} onClick={() => void p.onDirect('Split', id, locked, [{ op: 'split_segment', segmentId: id, atSourceUs: cutAt!, newSegmentId: `${id}_s${cutAt}` }])}>
              Split at playhead
            </button>
            <button type="button" className="btn btn--quiet" disabled={cutAt === null} onClick={() => void p.onDirect('Trimmed start', id, locked, [{ op: 'trim_segment', segmentId: id, sourceStartUs: cutAt!, sourceEndUs: seg.sourceEndUs }])}>
              Trim start to playhead
            </button>
            <button type="button" className="btn btn--quiet" disabled={cutAt === null} onClick={() => void p.onDirect('Trimmed end', id, locked, [{ op: 'trim_segment', segmentId: id, sourceStartUs: seg.sourceStartUs, sourceEndUs: cutAt! }])}>
              Trim end to playhead
            </button>
          </div>
          {cutAt === null && <p className="hint">Play or seek into this clip to split or trim it at the playhead.</p>}
          <fieldset className="field">
            <legend>Crop (fractions of the source frame)</legend>
            <div className="row">
              {(['x', 'y', 'width', 'height'] as const).map((k) => (
                <label key={k} className="field field--sm">
                  <span>{k}</span>
                  <input type="number" min={0} max={1} step={0.01} value={crop[k]} onChange={(e) => setCrop({ ...crop, [k]: Number(e.target.value) })} />
                </label>
              ))}
            </div>
            <button type="button" className="btn btn--ghost" onClick={() => void p.onDirect('Crop set', id, locked, [{ op: 'set_crop', segmentId: id, rect: crop }])}>
              Set crop
            </button>
          </fieldset>
        </>
      )}
      {cap && (
        <form className="field" onSubmit={(e) => (e.preventDefault(), void p.onDirect('Caption updated', id, locked, [{ op: 'set_caption', captionId: id, text: text.trim(), template }]))}>
          <label className="field">
            <span>Caption text</span>
            <input value={text} maxLength={200} onChange={(e) => setText(e.target.value)} />
          </label>
          <label className="field">
            <span>Style</span>
            <select value={template} onChange={(e) => setTemplate(e.target.value as typeof template)}>
              {CAPTION_STYLES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn btn--ghost" disabled={!text.trim()}>
            Save caption
          </button>
        </form>
      )}
      {vis && vis.kind !== 'hook_text' && (
        <button type="button" className="btn btn--ghost" disabled={locked} onClick={() => void p.onEdit('Removed', [{ op: 'remove_visual', visualId: id }])}>
          Remove {vis.kind === 'broll' ? 'B-roll' : 'graphic'}
        </button>
      )}
      {(sfx || music) && (
        <form className="row" onSubmit={(e) => (e.preventDefault(), void p.onDirect('Gain set', id, locked, gainOps(Number(gain))))}>
          <label className="field">
            <span>Gain (dB, −60 to 12)</span>
            <input type="number" min={-60} max={12} step={1} value={gain} onChange={(e) => setGain(e.target.value)} />
          </label>
          <button type="submit" className="btn btn--ghost">
            Set gain
          </button>
          <button type="button" className="btn btn--quiet" onClick={() => void p.onDirect('Muted', id, locked, gainOps(-60))}>
            Mute
          </button>
        </form>
      )}
    </section>
  );
}
