import { useEffect, useState } from 'react';
import { Clapperboard, Film, Settings as SettingsIcon, SlidersHorizontal } from 'lucide-react';
import type { BrandProfile } from '@takeoff/contracts';
import { api, describe, type Capabilities, type SystemInfo } from './api.ts';
import { ErrorNote, usePref } from './ui.tsx';
import { FirstRun } from './FirstRun.tsx';
import { Create } from './Create.tsx';
import { Processing } from './Processing.tsx';
import { Review } from './Review.tsx';
import { Settings } from './Settings.tsx';

export type Screen = 'first-run' | 'create' | 'processing' | 'review' | 'settings';
export type Ground = 'ink' | 'paper';

export interface AppCtx {
  caps: Capabilities | null;
  system: SystemInfo | null;
  refreshCaps(): void;
  projectFolder: string | null;
  setProjectFolder(p: string | null): void;
  projectId: string | null;
  setProjectId(id: string | null): void;
  /** The app brand library (latest version of each), from the engine; never localStorage. */
  brands: BrandProfile[];
  refreshBrands(): void;
  /** Brand chosen for new edits (a per-viewer convenience; the brand itself lives in the engine). */
  brandId: string | null;
  setBrandId(id: string | null): void;
  ground: Ground;
  setGround(g: Ground): void;
  go(screen: Screen): void;
  /** Shows a job's stages, then opens `then` when it succeeds. */
  runJob(jobId: string, then: Screen): void;
}

export function App() {
  const [firstRunDone, setFirstRunDone] = usePref('firstRunDone', false);
  const [ground, setGround] = usePref<Ground>('ground', 'ink');
  const [projectFolder, setProjectFolder] = usePref<string | null>('projectFolder', null);
  const [projectId, setProjectId] = usePref<string | null>('projectId', null);
  const [brandId, setBrandId] = usePref<string | null>('brandId', null);
  const [brands, setBrands] = useState<BrandProfile[]>([]);
  const [screen, setScreen] = useState<Screen>(firstRunDone ? 'create' : 'first-run');
  const [job, setJob] = useState<{ id: string; then: Screen } | null>(null);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [error, setError] = useState<ReturnType<typeof describe> | null>(null);

  const refreshCaps = () => {
    setError(null);
    Promise.all([api<Capabilities>('GET', '/v1/capabilities'), api<SystemInfo>('GET', '/v1/system')])
      .then(([c, s]) => (setCaps(c), setSystem(s)))
      .catch((e) => setError(describe(e)));
  };
  useEffect(refreshCaps, []);
  const refreshBrands = () => {
    api<{ brands: BrandProfile[] }>('GET', '/v1/brands')
      .then((r) => setBrands(r.brands))
      .catch((e) => setError(describe(e)));
  };
  useEffect(refreshBrands, []);
  // Ink is the default and never follows the OS; paper only when chosen in Settings.
  useEffect(() => document.documentElement.setAttribute('data-mode', ground), [ground]);

  const ctx: AppCtx = {
    caps, system, refreshCaps, projectFolder, setProjectFolder, projectId, setProjectId, brands, refreshBrands, brandId, setBrandId, ground, setGround,
    go: setScreen,
    runJob: (id, then) => (setJob({ id, then }), setScreen('processing')),
  };
  const nav: Array<[Screen, string, typeof Film]> = [
    ['create', 'Create', SlidersHorizontal],
    ['review', 'Review', Film],
    ['settings', 'Settings', SettingsIcon],
  ];

  return (
    <div className="app">
      <header className="topbar">
        <span className="brandmark">
          <Clapperboard size={16} aria-hidden="true" /> Takeoff
        </span>
        {screen !== 'first-run' && (
          <nav aria-label="Main">
            {nav.map(([s, label, Icon]) => (
              <button key={s} type="button" className="navbtn" aria-current={screen === s ? 'page' : undefined} onClick={() => setScreen(s)} disabled={s === 'review' && !projectId}>
                <Icon size={16} aria-hidden="true" /> {label}
              </button>
            ))}
          </nav>
        )}
      </header>
      <main className="main" id="main">
        <ErrorNote error={error} />
        {screen === 'first-run' && <FirstRun ctx={ctx} onDone={() => (setFirstRunDone(true), setScreen('create'))} />}
        {screen === 'create' && <Create ctx={ctx} />}
        {screen === 'processing' && job && <Processing ctx={ctx} jobId={job.id} onSucceeded={() => setScreen(job.then)} />}
        {screen === 'review' && projectId && <Review ctx={ctx} projectId={projectId} />}
        {screen === 'settings' && <Settings ctx={ctx} onFirstRun={() => setScreen('first-run')} />}
      </main>
    </div>
  );
}
