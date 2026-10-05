// Builds the app, launches Electron with a temp userData and a temp approved root, and checks the shell's
// security posture and the first two screens. Skips when the Electron binary is not installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { allowedRequest } from '../src/main/policy.ts';

const APP = fileURLToPath(new URL('..', import.meta.url));

async function electronPath(): Promise<string | null> {
  try {
    const p = (await import('electron')).default as unknown as string;
    return typeof p === 'string' ? p : null;
  } catch {
    return null;
  }
}

test('desktop shell: CSP, loopback-only network, first run, create-screen switches', { timeout: 180_000 }, async (t) => {
  const exe = await electronPath();
  if (!exe) return t.skip('electron binary is not installed');
  await promisify(execFile)(process.execPath, [join(APP, 'scripts', 'build.ts')], { cwd: APP });
  const { _electron } = await import('playwright');

  const dir = await mkdtemp(join(tmpdir(), 'takeoff-app-'));
  const userData = join(dir, 'userData');
  const root = join(dir, 'approved');
  await mkdir(userData, { recursive: true });
  await mkdir(root);
  await writeFile(join(userData, 'approved-roots.json'), JSON.stringify({ roots: [root] }));
  const shots = process.env.TAKEOFF_APP_SHOTS; // optional: folder for screenshots to inspect
  const shot = async (p: import('playwright').Page, name: string) => void (shots && (await p.screenshot({ path: join(shots, `${name}.png`), fullPage: true })));
  const app = await _electron.launch({ executablePath: exe, args: [APP], env: { ...process.env, NODE_ENV: 'test', TAKEOFF_USER_DATA: userData } });
  try {
    const page = await app.firstWindow();
    const requests: string[] = [];
    page.on('request', (r) => requests.push(r.url()));
    await page.waitForSelector('h1');
    assert.equal(await page.title(), 'Takeoff');

    // Hardened window and preload surface.
    const prefs = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]!;
      const p = (w.webContents as unknown as { getLastWebPreferences(): Electron.WebPreferences }).getLastWebPreferences(); // untyped in electron.d.ts
      return { contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration, sandbox: p.sandbox, webSecurity: p.webSecurity, url: w.webContents.getURL() };
    });
    assert.deepEqual(prefs, { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, url: 'app://takeoff/index.html' });
    assert.deepEqual(await page.evaluate(() => Object.keys(window.takeoff ?? {}).sort()), ['apiBase', 'dropFiles', 'pickFiles', 'pickFolder', 'revealInFolder', 'setProviders', 'token']);
    assert.equal(await page.evaluate(() => typeof (globalThis as { require?: unknown }).require), 'undefined');
    const apiBase = await page.evaluate(() => window.takeoff!.apiBase);
    assert.match(apiBase, /^http:\/\/127\.0\.0\.1:\d+$/);

    // CSP header on the app's own document.
    const csp = await app.evaluate(async ({ session }) => (await session.defaultSession.fetch('app://takeoff/index.html')).headers.get('content-security-policy'));
    assert.ok(csp);
    const port = new URL(apiBase).port;
    for (const d of ["default-src 'self'", "script-src 'self'", "font-src 'self'", `connect-src http://127.0.0.1:${port}`]) assert.ok(csp.includes(d), `CSP has ${d}`);

    // Non-loopback requests are refused by CSP in the page and cancelled by the session in main.
    assert.equal(await page.evaluate(() => fetch('https://example.com/').then(() => 'sent', () => 'blocked')), 'blocked');
    const mainFetch = await app.evaluate(async ({ session }) => session.defaultSession.fetch('https://example.com/').then(() => 'sent', (e: Error) => String(e.message)));
    assert.match(mainFetch, /BLOCKED_BY_CLIENT/);
    // The API refuses a request without the token, even from the app's own page.
    assert.equal(await page.evaluate((b) => fetch(`${b}/v1/projects`).then((r) => r.status), apiBase), 401);

    // First run: capability check with statuses, starter-pack offer, Local only.
    await page.getByRole('heading', { name: 'What this computer can do' }).waitFor();
    await page.getByRole('rowheader', { name: 'Transcription model' }).first().waitFor({ timeout: 60_000 });
    assert.ok(await page.getByRole('button', { name: /^(Download|Install)$/ }).isVisible());
    assert.ok(await page.getByRole('radio', { name: 'Local only' }).isChecked());
    await shot(page, 'first-run');

    // Create screen: every toggle is a keyboard-operable switch with aria-checked and an On/Off word.
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('heading', { name: /Edits/ }).waitFor();
    const switches = page.getByRole('switch');
    assert.equal(await switches.count(), 13);
    for (const s of await switches.all()) {
      assert.match(String(await s.getAttribute('aria-checked')), /^(true|false)$/);
      assert.match(String(await s.textContent()), /^(On|Off)$/);
    }
    const badTakes = page.getByRole('switch', { name: 'Bad takes' });
    assert.equal(await badTakes.getAttribute('aria-checked'), 'true');
    assert.equal(await page.getByRole('switch', { name: 'Background music' }).getAttribute('aria-checked'), 'false');
    assert.ok(await page.getByRole('switch', { name: 'AI-found B-roll' }).isDisabled(), 'P1 toggle is visibly unavailable');
    assert.ok(await page.getByRole('switch', { name: 'Studio voice' }).isVisible());
    await badTakes.focus();
    await page.keyboard.press('Space');
    assert.equal(await badTakes.getAttribute('aria-checked'), 'false');
    // Edit Video stays disabled with a concrete remedy (no footage yet).
    assert.ok(await page.getByRole('button', { name: 'Edit Video' }).isDisabled());
    assert.ok((await page.locator('#edit-blocker').textContent())!.length > 10);

    await shot(page, 'create');
    const offenders = requests.filter((u) => !allowedRequest(u));
    assert.deepEqual(offenders, [], 'no non-loopback request from the renderer');
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
