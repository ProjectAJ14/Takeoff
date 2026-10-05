// One-click processing (PRD 5.3): named stages, a bar only when progress is measured, elapsed time
// otherwise, cancel, expandable details, and throttled screen-reader announcements.
import { useEffect, useState } from 'react';
import { CircleCheck, CircleX } from 'lucide-react';
import type { Job, JobStage } from '@takeoff/contracts';
import { api, describe, watchJob } from './api.ts';
import type { AppCtx } from './App.tsx';
import { STAGES, elapsed, foldJob, isTerminal, type StageView } from './logic.ts';
import { ErrorNote, useAnnouncer } from './ui.tsx';

const stagesFor = (j: Job | null): readonly JobStage[] =>
  j?.stage === 'Export' ? ['Export'] : j && ['Build graphics', 'Render preview', 'Check quality'].includes(j.stage) && j.idempotencyKey.startsWith('render') ? STAGES.slice(4) : STAGES;

export function JobStages({ jobId, onDone }: { jobId: string; onDone(job: Job): void }) {
  const [job, setJob] = useState<Job | null>(null);
  const [views, setViews] = useState<StageView[] | null>(null);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<ReturnType<typeof describe> | null>(null);
  const [said, announce] = useAnnouncer();

  useEffect(() => {
    const ac = new AbortController();
    let prev: StageView[] | null = null;
    let lastStage = '';
    watchJob(
      jobId,
      (j) => {
        prev = foldJob(prev, j, Date.now(), stagesFor(j));
        setViews(prev);
        setJob(j);
        const msg = j.state === 'running' ? `${j.stage}${j.progress !== null ? `, ${Math.round(j.progress * 100)}%` : ''}` : `${j.stage}: ${j.state.replace(/_/g, ' ')}`;
        if (msg !== lastStage) announce((lastStage = msg));
        if (isTerminal(j)) onDone(j);
      },
      ac.signal,
    ).catch((e) => !ac.signal.aborted && setError(describe(e)));
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => (ac.abort(), clearInterval(tick));
  }, [jobId]);

  const cancel = () => api('POST', `/v1/jobs/${jobId}/cancel`).catch((e) => setError(describe(e)));
  const list = views ?? (stagesFor(job) as JobStage[]).map((stage) => ({ stage, state: 'pending' as const, progress: null, startedAt: null, endedAt: null }));
  return (
    <div className="processing">
      <p className="sr-only" aria-live="polite" role="status">
        {said}
      </p>
      <ol className="stages">
        {list.map((v, i) => (
          <li key={v.stage} className={`stage stage--${v.state}`} aria-current={v.state === 'running' ? 'step' : undefined}>
            <span className="disc" aria-hidden="true">
              {v.state === 'done' ? <CircleCheck size={16} /> : v.state === 'failed' ? <CircleX size={16} /> : i + 1}
            </span>
            <span className="stage__name">{v.stage}</span>
            <span className="stage__state">{{ pending: 'Waiting', running: 'Running', done: 'Done', failed: 'Failed', canceled: 'Canceled' }[v.state]}</span>
            {v.state === 'running' && v.progress !== null ? (
              <progress className="bar" max={1} value={v.progress} aria-label={`${v.stage} progress`}>
                {Math.round(v.progress * 100)}%
              </progress>
            ) : (
              <span className="mono muted timecode">{v.startedAt ? elapsed((v.endedAt ?? now) - v.startedAt) : ''}</span>
            )}
          </li>
        ))}
      </ol>
      {job && !isTerminal(job) && (
        <button type="button" className="btn btn--ghost" onClick={cancel}>
          Cancel
        </button>
      )}
      {job?.error && <ErrorNote error={job.error} />}
      <ErrorNote error={error} />
      <details className="details">
        <summary>Details</summary>
        <pre className="well">
          {job
            ? [`job ${job.id}`, `stage ${job.stage}`, `state ${job.state}`, `attempts ${job.attempts}`, `base revision ${job.baseRevision}`, `artifacts ${job.artifacts.length}`, ...(job.error ? [`error ${job.error.code}`] : [])].join('\n')
            : 'Waiting for the engine…'}
        </pre>
      </details>
    </div>
  );
}

export function Processing({ ctx, jobId, onSucceeded }: { ctx: AppCtx; jobId: string; onSucceeded(): void }) {
  const [last, setLast] = useState<Job | null>(null);
  return (
    <section className="narrow" aria-labelledby="proc-h">
      <h1 id="proc-h" className="h1">
        Editing your video
      </h1>
      <p className="muted">Nothing needs your attention while this runs. Uncertain cuts are left in and marked for review.</p>
      <JobStages jobId={jobId} onDone={(j) => (j.state === 'succeeded' ? onSucceeded() : setLast(j))} />
      {last && last.state !== 'succeeded' && (
        <div className="row">
          <button type="button" className="btn btn--ghost" onClick={() => ctx.go('create')}>
            Back to create
          </button>
          {ctx.projectId && (
            <button type="button" className="btn btn--quiet" onClick={() => ctx.go('review')}>
              Open last draft
            </button>
          )}
        </div>
      )}
    </section>
  );
}
