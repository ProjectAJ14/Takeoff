// Export (PRD 5.5): preset, duration, size estimate, caption burn-in and destination. The engine validates the
// file before it reports success; this dialog shows the QA result and the files written. It never publishes.
import { useEffect, useRef, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import type { EditPlan, ExportManifest, Job } from '@takeoff/contracts';
import { api, bridge, describe, mediaUrl, newKey } from './api.ts';
import type { AppCtx } from './App.tsx';
import { JobStages } from './Processing.tsx';
import { formatBytes, planSeconds, sizeEstimateBytes } from './logic.ts';
import { ErrorNote, fmtSeconds, usePref } from './ui.tsx';

type Preset = 'final_1080' | 'draft_720';

export function ExportDialog({ ctx, projectId, plan, rev, onClose }: { ctx: AppCtx; projectId: string; plan: EditPlan; rev: number; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [preset, setPreset] = usePref<Preset>('outputPreset', 'final_1080');
  const [burn, setBurn] = useState(true);
  const [dest, setDest] = usePref<string | null>('exportDir', null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [result, setResult] = useState<{ job: Job; manifest: ExportManifest | null; dir: string | null } | null>(null);
  const [error, setError] = useState<ReturnType<typeof describe> | null>(null);
  useEffect(() => ref.current?.showModal(), []);

  const seconds = planSeconds(plan);
  const remedy = !dest ? 'Choose a destination folder.' : !plan.segments.length ? 'The edit is empty; restore some speech first.' : null;
  const choose = async () => {
    const p = await bridge().pickFolder();
    if (p) setDest(p);
  };
  const start = async () => {
    setError(null);
    setResult(null);
    try {
      const j = await api<Job>('POST', `/v1/projects/${projectId}/exports`, { schemaVersion: '1.0', profile: preset, destinationDir: dest, burnCaptions: burn, idempotencyKey: newKey('export') });
      setJobId(j.id);
    } catch (e) {
      setError(describe(e));
    }
  };
  const finished = async (job: Job) => {
    setJobId(null);
    const art = job.artifacts.find((a) => a.kind === 'export_manifest');
    let manifest: ExportManifest | null = null;
    if (art) manifest = await fetch(mediaUrl(projectId, art.hash), { headers: { Authorization: `Bearer ${bridge().token}` } }).then((r) => r.json() as Promise<ExportManifest>).catch(() => null);
    // The engine writes into <destination>/takeoff-r<revision>-<job id prefix>.
    const dir = job.state === 'succeeded' && manifest && dest ? `${dest.replace(/[\\/]+$/, '')}/takeoff-r${manifest.revision}-${job.id.slice(0, 8)}` : null;
    setResult({ job, manifest, dir });
  };

  return (
    <dialog ref={ref} className="dialog" aria-labelledby="exp-h" onClose={onClose}>
      <h2 id="exp-h" className="card__head">
        Export
      </h2>
      <div className="form">
        <label className="field">
          <span>Preset</span>
          <select value={preset} onChange={(e) => setPreset(e.target.value as Preset)} disabled={!!jobId}>
            <option value="final_1080">final_1080 · 1080×1920 · 30 fps · H.264/AAC</option>
            <option value="draft_720">draft_720 · 720p draft</option>
          </select>
        </label>
        <table className="kv">
          <tbody>
            <tr>
              <th scope="row">Duration</th>
              <td className="mono">{fmtSeconds(seconds)}</td>
            </tr>
            <tr>
              <th scope="row">Estimated size</th>
              <td className="mono">about {formatBytes(sizeEstimateBytes(seconds, preset))}</td>
            </tr>
            <tr>
              <th scope="row">Revision</th>
              <td className="mono">r{rev}</td>
            </tr>
          </tbody>
        </table>
        <label className="check">
          <input type="checkbox" checked={burn} onChange={(e) => setBurn(e.target.checked)} disabled={!!jobId} /> Burn captions into the video
        </label>
        <div className="row">
          <button type="button" className="btn btn--ghost" onClick={choose} disabled={!!jobId}>
            <FolderOpen size={16} aria-hidden="true" /> {dest ? 'Change destination' : 'Choose destination'}
          </button>
          <span className="mono path">{dest ?? 'No folder chosen'}</span>
        </div>
        <p className="hint">Takeoff saves files to this folder and checks them. It never publishes anywhere.</p>
        {jobId && <JobStages jobId={jobId} onDone={finished} />}
        <ErrorNote error={error} />
        {result && <ExportResult result={result} />}
        <div className="row row--end">
          <button type="button" className="btn btn--ghost" onClick={() => ref.current?.close()}>
            Close
          </button>
          <button type="button" className="btn btn--brand" disabled={!!remedy || !!jobId} aria-describedby={remedy ? 'exp-remedy' : undefined} onClick={start}>
            Export
          </button>
        </div>
        {remedy && (
          <p id="exp-remedy" className="hint">
            {remedy}
          </p>
        )}
      </div>
    </dialog>
  );
}

function ExportResult({ result: { job, manifest, dir } }: { result: { job: Job; manifest: ExportManifest | null; dir: string | null } }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => void box.current?.scrollIntoView({ block: 'nearest' }), []); // the outcome lands below the dialog's fold; void: Chromium's scrollIntoView returns a Promise, which React would call as cleanup
  return (
    <div ref={box} className="result" role="status">
      <p>
        <strong>{job.state === 'succeeded' ? 'Export complete.' : job.state === 'canceled' ? 'Export canceled; nothing was written.' : 'Export failed; nothing was written to the destination.'}</strong>
      </p>
      {job.error && <ErrorNote error={job.error} />}
      {manifest && (
        <>
          <table className="kv">
            <caption className="label">Quality checks</caption>
            <tbody>
              {manifest.checks.map((c) => (
                <tr key={c.name}>
                  <th scope="row" className="mono">
                    {c.name}
                  </th>
                  <td>{{ passed: 'Passed', failed: 'Failed', skipped: 'Skipped', not_run: 'Not run' }[c.status]}</td>
                  <td className="muted">{c.detail ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {job.state === 'succeeded' && (
            <table className="kv">
              <caption className="label">Files written</caption>
              <tbody>
                {manifest.outputs.map((o) => (
                  <tr key={o.relativePath}>
                    <th scope="row" className="mono">
                      {o.relativePath}
                    </th>
                    <td className="mono muted">{formatBytes(o.bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {manifest.unresolvedWarnings.length > 0 && <p className="hint">{manifest.unresolvedWarnings.length} warning(s) remain; they are listed in export-manifest.json.</p>}
        </>
      )}
      {dir && (
        <button type="button" className="btn btn--ghost" onClick={() => void bridge().revealInFolder(dir)}>
          <FolderOpen size={16} aria-hidden="true" /> Reveal in folder
        </button>
      )}
    </div>
  );
}
