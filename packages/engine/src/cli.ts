// `takeoff` CLI: the same operations as the MCP tools and HTTP API, for agents that cannot speak MCP
// and for scripts. Results print as JSON on stdout; failures exit nonzero (with --json, the typed
// error goes to stderr as JSON). Paths named on the command line are what the user approves.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import type { Settings } from '@takeoff/contracts';
import { ENGINE_VERSION, type EngineOptions, type PipelineResult, type RendererModule } from './engine.ts';
import { EngineError, toErrorInfo } from './errors.ts';
import { runMcp } from './mcp.ts';
import { startServer } from './server.ts';
import type { Transcriber } from './transcribe.ts';
import { checkPlan, defaultAppDataDir, setEditDefaults, Workspace } from './workspace.ts';

const run = promisify(execFile);

const USAGE = `takeoff ${ENGINE_VERSION}
  init <dir> [--name N] [--toggles JSON] [--target S|auto]
  import <dir> <files...> [--pool takes|broll|music|sfx]
  transcribe <dir> [--glossary 'REST,Dio']
  edit <dir> [--toggles JSON] [--target S|auto] [--policy hard_max|soft_target] [--glossary 'REST,Dio'] [--director rules|ollama:<model>] [--director-timeout S]
  plan <dir>
  validate <plan.json> [--project dir]
  patch <dir> <patch.json>
  render <dir> [--final]
  qa <dir>
  export <dir> <dest> [--profile final_1080|draft_720] [--no-captions]
  capabilities
  starter-pack [--allow-network]
  serve [--port N] [--root dir]... [--app-origin O]
  mcp [--root dir]...
  render-test <out.mp4> [--final]
Global: --json (errors as JSON on stderr)`;

const usage = (m: string) => new EngineError('usage', m, 'Run takeoff --help.');

/** The lavfi test clip has no speech; ASR is skipped so render-test needs no model. */
const noSpeech: Transcriber = {
  probe: async () => ({ models: [], devices: ['cpu'], defaultDevice: 'cpu', versions: {} }),
  configHash: async () => '0'.repeat(64),
  transcribe: async () => {
    throw new EngineError('no_speech', 'no speech in the synthetic test clip', 'None needed.');
  },
  downloadModel: async () => undefined,
};

const TEST_SETTINGS: Settings = {
  badTakes: false, fillers: false, silence: false, captions: false, userBroll: false, aiBroll: false, zoom: false,
  music: false, sfx: false, studioVoice: true, autoColor: true, textHook: false, motionGraphics: false, networkPolicy: 'local_only', fillerStrength: 'normal',
};

/**
 * PRD §17 first deliverable: render a five-second synthetic clip end to end (lavfi media → import →
 * plan → compile → browser renderer → QA) and copy the video to `out`.
 */
export async function renderTest(out: string, opts: { final?: boolean; loadRenderer?: () => Promise<RendererModule> } = {}) {
  const dest = resolve(out);
  await mkdir(dirname(dest), { recursive: true });
  const dir = await mkdtemp(join(tmpdir(), 'takeoff-render-test-'));
  const ws = new Workspace({ appDataDir: join(dir, 'appdata'), approvedRoots: [dir], transcriber: noSpeech, loadRenderer: opts.loadRenderer });
  try {
    const clip = join(dir, 'clip.mp4');
    await run('ffmpeg', [
      '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30:duration=5', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=5',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip,
    ]);
    const e = ws.create(join(dir, 'project'), 'render-test', { settings: TEST_SETTINGS });
    const [imp] = await e.importAssets([clip], { pool: 'takes' });
    if (imp?.error) throw new EngineError(imp.error.code, imp.error.message, imp.error.remedy);
    let r: PipelineResult = await e.runPipeline({ settings: TEST_SETTINGS, targetSeconds: null, lengthPolicy: 'none', idempotencyKey: 'render-test-0001', baseRevision: 0 });
    let video: string | undefined;
    if (r.error === null && opts.final) {
      const x = await e.exportProject({ profile: 'final_1080', destinationDir: dir, burnCaptions: true, idempotencyKey: 'render-test-final' });
      r = x;
      video = x.dir ? join(x.dir, 'video.mp4') : undefined;
    } else if (r.error === null) {
      const a = r.job.artifacts.filter((x) => x.kind === 'render_draft').at(-1);
      video = a && join(e.root, a.ref);
    }
    if (r.error || !video) throw r.error ? new EngineError(r.error.code, r.error.message, r.error.remedy) : new EngineError('render_failed', `render-test ended ${r.job.state}`, 'Run takeoff capabilities.');
    await copyFile(video, dest);
    const status = Object.fromEntries((r.qa?.checks ?? []).map((c) => [c.name, c.status]));
    return { out: dest, revision: r.revision, qa: status };
  } finally {
    ws.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function rootsFrom(flags: string[] | undefined): string[] {
  if (flags?.length) return flags.map((r) => resolve(r));
  const env = process.env.TAKEOFF_APPROVED_ROOTS;
  return env ? env.split(':').filter(Boolean).map((r) => resolve(r)) : [process.cwd()];
}

const parseDirector = (d: string | undefined, timeout: string | undefined): EngineOptions['director'] => {
  if (d === undefined || d === 'rules') return d;
  const m = /^ollama:([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})$/.exec(d);
  if (!m) throw usage('--director must be rules or ollama:<model>');
  const s = timeout === undefined ? undefined : Number(timeout);
  if (s !== undefined && !(Number.isInteger(s) && s >= 1 && s <= 600)) throw usage('--director-timeout must be 1–600 seconds');
  return { kind: 'ollama', model: m[1]!, timeoutMs: s && s * 1000 };
};
const parseTarget = (t: string | undefined) => (t === undefined ? undefined : t === 'auto' ? null : Number(t));
const parseJson = async (file: string) => {
  try {
    return JSON.parse(await readFile(resolve(file), 'utf8'));
  } catch {
    throw new EngineError('invalid_json', 'the file is missing or not JSON', 'Check the file path and contents.');
  }
};
const toggles = (s: string | undefined) => {
  if (s === undefined) return undefined;
  try {
    return JSON.parse(s) as Partial<Settings>;
  } catch {
    throw usage('--toggles must be JSON');
  }
};
const done = (r: PipelineResult) => {
  if (r.error || r.job.state !== 'succeeded') process.exitCode = 1;
  return r;
};

const OPTIONS = {
  json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, name: { type: 'string' }, toggles: { type: 'string' }, target: { type: 'string' },
  policy: { type: 'string' }, pool: { type: 'string' }, project: { type: 'string' }, final: { type: 'boolean' }, profile: { type: 'string' },
  'no-captions': { type: 'boolean' }, 'allow-network': { type: 'boolean' }, glossary: { type: 'string' }, director: { type: 'string' }, 'director-timeout': { type: 'string' }, port: { type: 'string' }, root: { type: 'string', multiple: true }, 'app-origin': { type: 'string' },
} as const;

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
  } catch (e) {
    const info = { code: 'usage', message: (e as Error).message, remedy: 'Run takeoff --help.' };
    process.stderr.write(argv.includes('--json') ? JSON.stringify(info) + '\n' : `takeoff: ${info.message}\n`);
    return 2;
  }
  const { values: f, positionals: p } = parsed;
  const [cmd, ...args] = p;
  const appDataDir = defaultAppDataDir();
  // CLI: the folders and files named on the command line are the approved roots.
  // ASR glossary (terms Whisper should spell, e.g. REST) and director choice for edit/transcribe.
  const asr = f.glossary === undefined ? undefined : { glossary: f.glossary.split(',').map((t) => t.trim()).filter(Boolean) };
  const cliWs = async (dirs: string[], files: string[] = []) => {
    for (const d of dirs) await mkdir(resolve(d), { recursive: true });
    return new Workspace({ appDataDir, approvedRoots: [...dirs, ...files.map((x) => dirname(resolve(x)))].map((x) => resolve(x)), asr, director: parseDirector(f.director, f['director-timeout']) } satisfies EngineOptions);
  };
  const need = (n: number) => {
    if (args.length < n) throw usage(`${cmd} needs ${n} argument(s)`);
  };
  let result: unknown;
  let ws: Workspace | undefined;
  try {
    if (f.help || !cmd) {
      process.stdout.write(USAGE + '\n');
      return cmd || f.help ? 0 : 2;
    }
    switch (cmd) {
      case 'init': {
        need(1);
        ws = await cliWs([args[0]!]);
        const t = toggles(f.toggles);
        const e = ws.create(args[0]!, f.name ?? 'Untitled');
        if (t || f.target) setEditDefaults(e, { settings: t, targetSeconds: parseTarget(f.target) });
        result = { projectId: e.projectId, root: e.root, revision: e.store.currentRevision() };
        break;
      }
      case 'import': {
        need(2);
        ws = await cliWs([args[0]!], args.slice(1));
        const items = await ws.open(args[0]!).importAssets(args.slice(1), { pool: (f.pool ?? 'takes') as 'takes' });
        if (items.some((i) => i.error)) process.exitCode = 1;
        result = { items };
        break;
      }
      case 'transcribe':
        need(1);
        ws = await cliWs([args[0]!]);
        result = done(await ws.open(args[0]!).transcribe({ idempotencyKey: randomUUID() }));
        break;
      case 'edit': {
        need(1);
        ws = await cliWs([args[0]!]);
        const e = ws.open(args[0]!);
        const d = setEditDefaults(e, { settings: toggles(f.toggles), targetSeconds: parseTarget(f.target), lengthPolicy: f.policy as 'soft_target' | undefined });
        result = done(await e.runPipeline({ ...d, baseRevision: e.store.currentRevision(), idempotencyKey: randomUUID() }));
        break;
      }
      case 'plan': {
        need(1);
        ws = await cliWs([args[0]!]);
        const head = ws.open(args[0]!).getPlan();
        if (!head) throw new EngineError('no_plan', 'the project has no plan yet', 'Run takeoff edit first.');
        result = head;
        break;
      }
      case 'validate': {
        need(1);
        ws = f.project ? await cliWs([f.project]) : undefined;
        result = checkPlan(await parseJson(args[0]!), ws && f.project ? ws.open(f.project) : undefined);
        if (!(result as { ok: boolean }).ok) process.exitCode = 1;
        break;
      }
      case 'patch': {
        need(2);
        ws = await cliWs([args[0]!]);
        const s = ws.open(args[0]!).applyPatch(await parseJson(args[1]!));
        result = { revision: s.revision, planHash: s.planHash };
        break;
      }
      case 'render':
      case 'qa': {
        need(1);
        ws = await cliWs([args[0]!]);
        const e = ws.open(args[0]!);
        if (cmd === 'render' && f.final) {
          const r = await e.exportProject({ profile: 'final_1080', destinationDir: join(e.root, 'exports'), burnCaptions: true });
          result = { ...done(r), dir: r.dir };
        } else result = done(await e.renderAffected());
        break;
      }
      case 'export': {
        need(2);
        ws = await cliWs([args[0]!, args[1]!]);
        const r = await ws.open(args[0]!).exportProject({ profile: (f.profile ?? 'final_1080') as 'final_1080', destinationDir: args[1]!, burnCaptions: !f['no-captions'] });
        result = { ...done(r), manifest: r.manifest, dir: r.dir };
        break;
      }
      case 'capabilities':
        ws = new Workspace({ appDataDir, approvedRoots: [] });
        result = (await ws.capabilities()).dto;
        break;
      case 'starter-pack':
        ws = new Workspace({ appDataDir, approvedRoots: [] });
        result = await ws.starterPack({ allowNetwork: f['allow-network'] === true });
        break;
      case 'serve': {
        const roots = rootsFrom(f.root);
        await mkdir(join(appDataDir, 'projects'), { recursive: true });
        const sws = new Workspace({ appDataDir, approvedRoots: [...roots, join(appDataDir, 'projects')] });
        const s = await startServer(sws, { port: f.port ? Number(f.port) : 0, token: process.env.TAKEOFF_TOKEN, appOrigin: f['app-origin'] });
        process.stdout.write(JSON.stringify({ url: s.url, token: s.token }) + '\n');
        await new Promise<void>((r) => process.once('SIGINT', r).once('SIGTERM', r));
        await s.close();
        sws.close();
        return 0;
      }
      case 'mcp': {
        const mws = new Workspace({ appDataDir, approvedRoots: rootsFrom(f.root) });
        await runMcp(mws);
        mws.close();
        return 0;
      }
      case 'render-test':
        need(1);
        result = await renderTest(args[0]!, { final: f.final });
        break;
      default:
        throw usage(`unknown command ${cmd}`);
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return Number(process.exitCode ?? 0);
  } catch (e) {
    const info = toErrorInfo(e);
    process.stderr.write(f.json ? JSON.stringify(info) + '\n' : `takeoff: ${info.message}\n${info.remedy}\n`);
    return info.code === 'usage' ? 2 : 1;
  } finally {
    ws?.close();
  }
}
