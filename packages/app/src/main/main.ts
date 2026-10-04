// Electron main: runs the engine's loopback API in-process, serves the renderer from app://takeoff with a
// strict CSP, and is the only place that can widen file access (folders and files the user picks).
// Privacy (PRD §14): every non-loopback request from any web contents is cancelled.
import { app, BrowserWindow, dialog, ipcMain, protocol, session, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { delimiter, dirname, extname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Workspace, startServer, toErrorInfo, type RunningServer } from '@takeoff/engine';
import { ORIGIN, POOL_NAMES, POOLS, allowedRequest, csp, isMediaPath, isPool, testHooksEnabled } from './policy.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const RENDERER_DIR = join(HERE, 'renderer');
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.png': 'image/png' };

// Test hooks exist only in an unpackaged build started with NODE_ENV=test or --test; a packaged app ignores them.
const TEST_MODE = testHooksEnabled(app.isPackaged, process.env.NODE_ENV, process.argv);
// Tests point userData at a temp dir before anything reads it.
if (TEST_MODE && process.env.TAKEOFF_USER_DATA) app.setPath('userData', process.env.TAKEOFF_USER_DATA);
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

const rootsFile = () => join(app.getPath('userData'), 'approved-roots.json');
function savedRoots(): string[] {
  try {
    const v = JSON.parse(readFileSync(rootsFile(), 'utf8')) as { roots?: unknown };
    return Array.isArray(v.roots) ? v.roots.filter((r): r is string => typeof r === 'string' && isAbsolute(r) && existsSync(r) && statSync(r).isDirectory()) : [];
  } catch {
    return [];
  }
}

// Test hook: TAKEOFF_TEST_PICK (absolute paths joined by the platform path delimiter) answers the native
// pickers. Read on every pick so a test can change it between picks.
const testPick = (): string[] | null => (TEST_MODE && process.env.TAKEOFF_TEST_PICK !== undefined ? process.env.TAKEOFF_TEST_PICK.split(delimiter).filter(Boolean) : null);

let ws: Workspace;
let server: RunningServer;
let win: BrowserWindow | null = null;

const trusted = (e: IpcMainEvent | IpcMainInvokeEvent) => !!e.senderFrame && e.senderFrame.url.startsWith(`${ORIGIN}/`) && e.sender === win?.webContents;
function approveFolder(p: string): string {
  const real = ws.addApprovedRoot(p);
  const roots = [...new Set([...savedRoots(), real])];
  writeFileSync(`${rootsFile()}.tmp`, JSON.stringify({ roots }, null, 2));
  renameSync(`${rootsFile()}.tmp`, rootsFile());
  return real;
}
/** Single media files only, by extension; each is approved on its own, never its folder. */
function approveFiles(paths: unknown, kind: unknown): string[] {
  if (!isPool(kind) || !Array.isArray(paths) || paths.length > 200) return [];
  const exts: readonly string[] = POOLS[kind];
  return paths.flatMap((p) => {
    if (typeof p !== 'string' || !isAbsolute(p) || !exts.includes(extname(p).slice(1).toLowerCase())) return [];
    try {
      return statSync(p).isFile() ? [ws.addApprovedRoot(p)] : [];
    } catch {
      return [];
    }
  });
}

function lockDown(port: number): void {
  const s = session.defaultSession;
  s.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !allowedRequest(d.url) }));
  // <video>/<img> cannot send headers: attach the session token to media GETs on our API only.
  s.webRequest.onBeforeSendHeaders({ urls: ['http://127.0.0.1/*'] }, (d, cb) => {
    const u = new URL(d.url);
    if (u.port === String(port) && d.method === 'GET' && isMediaPath(u.pathname)) d.requestHeaders.Authorization = `Bearer ${server.token}`;
    cb({ requestHeaders: d.requestHeaders });
  });
  s.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  s.setPermissionCheckHandler(() => false);
  s.protocol.handle('app', async (req) => {
    const u = new URL(req.url);
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
    const abs = join(RENDERER_DIR, rel);
    const back = relative(RENDERER_DIR, abs);
    if (u.host !== 'takeoff' || back.startsWith('..') || isAbsolute(back)) return new Response('not found', { status: 404 });
    try {
      const body = await readFile(abs);
      return new Response(body, { headers: { 'Content-Type': TYPES[extname(abs)] ?? 'application/octet-stream', 'Content-Security-Policy': csp(port), 'X-Content-Type-Options': 'nosniff' } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}

app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (ev, url) => {
    if (!url.startsWith(`${ORIGIN}/`)) ev.preventDefault();
  });
  contents.on('will-redirect', (ev, url) => {
    if (!url.startsWith(`${ORIGIN}/`)) ev.preventDefault();
  });
  contents.on('will-attach-webview', (ev) => ev.preventDefault());
});

ipcMain.on('takeoff:config', (e) => {
  e.returnValue = trusted(e) ? { apiBase: server.url, token: server.token } : null;
});
ipcMain.handle('takeoff:pick-folder', async (e) => {
  if (!trusted(e) || !win) return null;
  const stub = testPick();
  const r = stub ? { canceled: !stub[0], filePaths: stub } : await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  const p = r.filePaths[0];
  return r.canceled || !p || !isAbsolute(p) || !statSync(p, { throwIfNoEntry: false })?.isDirectory() ? null : approveFolder(p);
});
ipcMain.handle('takeoff:pick-files', async (e, kind: unknown) => {
  if (!trusted(e) || !win || !isPool(kind)) return [];
  const stub = testPick();
  const r = stub ? { canceled: false, filePaths: stub } : await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: POOL_NAMES[kind], extensions: [...POOLS[kind]] }] });
  return r.canceled ? [] : approveFiles(r.filePaths, kind);
});
// Paths come from webUtils.getPathForFile on files the user dropped; still checked as media files.
ipcMain.handle('takeoff:dropped-files', (e, paths: unknown, kind: unknown) => (trusted(e) ? approveFiles(paths, kind) : []));
// Provider approvals widen egress, so they are written here, from the user's Settings, never over HTTP.
ipcMain.handle('takeoff:set-providers', (e, projectId: unknown, policy: unknown) => {
  if (!trusted(e)) return { error: { code: 'untrusted', message: 'refused', remedy: 'Use the Takeoff window.' } };
  try {
    if (typeof projectId !== 'string' || !policy || typeof policy !== 'object') throw new Error('bad arguments');
    return { policy: ws.byId(projectId).broker.setPolicy(policy as never) }; // setPolicy validates the shape
  } catch (err) {
    return { error: toErrorInfo(err) };
  }
});
ipcMain.handle('takeoff:reveal', (e, p: unknown) => {
  if (!trusted(e)) return false;
  if (p === undefined) return void shell.showItemInFolder(join(app.getPath('userData'), 'logs')), true;
  if (typeof p !== 'string') return false;
  try {
    shell.showItemInFolder(ws.approved(p)); // only inside folders the user approved
    return true;
  } catch {
    return false;
  }
});

app.whenReady().then(async () => {
  ws = new Workspace({ appDataDir: app.getPath('userData'), approvedRoots: savedRoots() });
  server = await startServer(ws, { token: randomBytes(32).toString('base64url'), appOrigin: ORIGIN });
  lockDown(server.port);
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 480,
    minHeight: 480,
    title: 'Takeoff',
    backgroundColor: '#17171a', // ink --bg (tokens.css), shown before the renderer paints
    webPreferences: { preload: join(HERE, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, webviewTag: false, spellcheck: false },
  });
  win.on('closed', () => (win = null));
  await win.loadURL(`${ORIGIN}/index.html`);
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  server?.close();
  ws?.close();
});
