// Drives the real Electron app end to end on synthetic speech: first run (brand with colour + logo) → create project →
// import → B-roll with tags, filler dictionary, text hook, own B-roll and motion graphics on → Edit Video → stages →
// review (play, restore, undo, choose a hook option, caption edit, lock) → export,
// then checks the exported MP4 with ffprobe. Screenshots every screen at 1440/1200/900 px and at 200% zoom
// in both grounds, checks for horizontal overflow, runs a keyboard-only pass on the create screen and
// records every request the app's session sees (no non-loopback request is allowed).
// Slow (real ASR, Chromium, FFmpeg), so it is not part of `npm test`.
//
//   node packages/app/test/e2e/ui-e2e.ts          # screenshots land in <tmp>/takeoff-ui-shots-*/
//   TAKEOFF_E2E_KEEP=1 node ...                    # also keep the temp project, media and export
//
// Needs macOS `say`, ffmpeg/ffprobe, uv with the cached `base` model, Chromium for Playwright and the
// Electron binary. The pickers are answered by the main process's TAKEOFF_TEST_PICK hook (test mode only).
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { _electron, type ElectronApplication, type Page } from 'playwright';
import { allowedRequest } from '../../src/main/policy.ts';

const run = promisify(execFile);
const APP = fileURLToPath(new URL('../..', import.meta.url));
const dir = await mkdtemp(join(tmpdir(), 'takeoff-ui-e2e-'));
const shots = await mkdtemp(join(tmpdir(), 'takeoff-ui-shots-'));
const step = (m: string) => process.stdout.write(`- ${m}\n`);
const ff = (args: string[]) => run('ffmpeg', ['-v', 'error', '-y', ...args], { cwd: dir, maxBuffer: 64 << 20 });
const problems: string[] = [];

const VIEWS: Array<{ w: number; zoom: number }> = [
  { w: 1440, zoom: 1 },
  { w: 1200, zoom: 1 },
  { w: 900, zoom: 1 },
  { w: 1440, zoom: 2 }, // 200% zoom: 720 CSS px wide
];

let app: ElectronApplication | undefined;
try {
  // ---- synthetic talking head: fillers, a false start, a 2 s pause ----
  step(`synthesising media in ${dir}`);
  await run('say', ['-v', 'Samantha', '-o', join(dir, 'a.aiff'), 'Um, so today I want to explain how Flutter talks to a server. Uh, so the main thing is. So the main thing is that Flutter sends a request through Dio to the server.']);
  await run('say', ['-v', 'Samantha', '-o', join(dir, 'b.aiff'), "Now let's compare REST versus GraphQL. REST uses many endpoints, uh, while GraphQL uses one endpoint. Thanks for watching."]);
  await ff(['-i', 'a.aiff', '-f', 'lavfi', '-t', '2', '-i', 'anullsrc=r=48000:cl=mono', '-i', 'b.aiff', '-filter_complex',
    '[0:a]aresample=48000[a0];[2:a]aresample=48000[a2];[a0][1:a][a2]concat=n=3:v=0:a=1[o]', '-map', '[o]', '-ac', '1', 'speech.wav']);
  await ff(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-i', 'speech.wav', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', 'take1.mov']);
  const take = join(dir, 'take1.mov');
  await ff(['-f', 'lavfi', '-i', 'color=c=0xFF00FF:s=640x360', '-frames:v', '1', 'server.png']);
  await ff(['-f', 'lavfi', '-i', 'color=c=0x00FFFF:s=500x200', '-frames:v', '1', 'logo.png']);
  const projects = join(dir, 'projects');
  const dest = join(dir, 'dest');
  await mkdir(projects);
  await mkdir(dest);

  step('build and launch');
  await run(process.execPath, [join(APP, 'scripts', 'build.ts')], { cwd: APP });
  const exe = (await import('electron')).default as unknown as string;
  app = await _electron.launch({ executablePath: exe, args: [APP, '--test'], env: { ...process.env, NODE_ENV: 'test', TAKEOFF_USER_DATA: join(dir, 'userData') } });
  const a = app;
  // Every request the app's session sees (completed or cancelled), recorded in main.
  await a.evaluate(({ session }) => {
    const seen: string[] = ((globalThis as { __seen?: string[] }).__seen = []);
    session.defaultSession.webRequest.onCompleted((d) => void seen.push(d.url));
    session.defaultSession.webRequest.onErrorOccurred((d) => void seen.push(d.url));
  });
  const page = await a.firstWindow();
  const pageRequests: string[] = [];
  page.on('request', (r) => pageRequests.push(r.url()));
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && problems.push(`console error: ${m.text()}`));
  const pick = (...paths: string[]) => a.evaluate((_e, v) => void (process.env.TAKEOFF_TEST_PICK = v), paths.join(delimiter));

  // An occluded test window throttles CSS transitions; finish them so shots show settled state.
  const settle = () => page.evaluate(() => document.getAnimations().forEach((x) => { try { x.finish(); } catch { /* infinite */ } }));
  /** Screenshots at every width, zoom and ground; flags horizontal overflow of the page. */
  async function shoot(name: string, opts: { grounds?: Array<'ink' | 'paper'> } = {}) {
    for (const ground of opts.grounds ?? ['ink', 'paper']) {
      await page.evaluate((g) => document.documentElement.setAttribute('data-mode', g), ground);
      for (const v of VIEWS) {
        await a.evaluate(({ BrowserWindow }, s) => {
          const w = BrowserWindow.getAllWindows()[0]!;
          w.setContentSize(s.w, 900);
          w.webContents.setZoomFactor(s.zoom);
        }, v);
        await page.waitForFunction((cssW) => Math.abs(window.innerWidth - cssW) <= 1, v.w / v.zoom, { timeout: 5000 }).catch(() => problems.push(`window did not resize to ${v.w}/${v.zoom}`));
        await page.waitForTimeout(250);
        await settle();
        const over = await page.evaluate(() => {
          const vw = document.documentElement.clientWidth;
          const wide = document.documentElement.scrollWidth > vw;
          const out = [...document.querySelectorAll<HTMLElement>('body *')]
            .filter((el) => {
              if (!el.offsetParent || el.closest('.timeline, .sr-only, dialog:not([open])')) return false;
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.right > vw + 1;
            })
            .slice(0, 5)
            .map((el) => `${el.tagName.toLowerCase()}.${el.className}`);
          return wide || out.length ? `scrollWidth ${document.documentElement.scrollWidth} > ${vw}: ${out.join(', ')}` : null;
        });
        const file = join(shots, `${name}-${ground}-${v.w}${v.zoom === 2 ? '-200pct' : ''}.png`);
        // A modal is fixed to the viewport, so a full-page shot would misplace it.
        if (v.zoom === 1) await page.screenshot({ path: file, fullPage: !(await page.locator('dialog[open]').count()) });
        else {
          // Playwright crops full-page shots under a zoom factor, so capture the real window, one screen at a time.
          const h = await page.evaluate(() => [document.documentElement.scrollHeight, innerHeight]);
          for (let y = 0, i = 0; y < h[0]! && i < 6; y += h[1]!, i++) {
            await page.evaluate((top) => window.scrollTo(0, top), y);
            await page.waitForTimeout(100);
            const png = await a.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG().toString('base64'));
            writeFileSync(file.replace(/\.png$/, `-${i}.png`), Buffer.from(png, 'base64'));
          }
          await page.evaluate(() => window.scrollTo(0, 0));
        }
        if (over) problems.push(`${name} ${ground} ${v.w}px zoom ${v.zoom}: horizontal overflow ${over}`);
      }
    }
    await a.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]!;
      w.setContentSize(1440, 900);
      w.webContents.setZoomFactor(1);
    });
    await page.evaluate(() => document.documentElement.setAttribute('data-mode', 'ink'));
  }

  // ---- first run ----
  step('first run');
  await page.getByRole('heading', { name: 'What this computer can do' }).waitFor();
  await page.getByRole('rowheader', { name: 'Transcription model' }).first().waitFor({ timeout: 60_000 });
  await pick(projects);
  await page.getByRole('button', { name: 'Choose project folder' }).click();
  await page.getByText(projects).first().waitFor();
  step('first run: brand (engine library, not localStorage)');
  await page.getByLabel('Brand name').fill('UI Brand');
  await page.getByLabel('Highlight').fill('#13f0a7');
  await page.getByLabel(/Prohibited claims/).fill('fastest');
  await pick(join(dir, 'logo.png'));
  await page.getByRole('button', { name: 'Choose logo' }).click();
  await page.getByText('logo.png').waitFor();
  await page.getByRole('button', { name: 'Save brand' }).click();
  await page.getByText('Saved UI Brand, version 1.').waitFor();
  assert.equal(await page.evaluate(() => Object.keys(localStorage).filter((k) => k === 'takeoff.brand').length), 0, 'no brand draft in localStorage');
  await shoot('1-first-run');
  await page.getByRole('button', { name: 'Continue' }).click();

  // ---- create ----
  step('create: import footage');
  await page.getByRole('heading', { name: /Edits/ }).waitFor();
  await pick(take);
  await page.getByRole('button', { name: 'Add files' }).first().click();
  await page.locator('.footage__status', { hasText: 'Ready' }).waitFor({ timeout: 120_000 });
  await page.locator('.footage__thumb img').waitFor({ timeout: 60_000 }).catch(() => problems.push('create: no thumbnail on the footage card'));

  step('create: B-roll with tags, filler dictionary, brand');
  await pick(join(dir, 'server.png'));
  await page.getByRole('button', { name: 'Add files' }).nth(1).click();
  const brollCard = page.locator('.footage', { hasText: 'server.png' });
  await brollCard.locator('.footage__status', { hasText: 'Ready' }).waitFor({ timeout: 120_000 });
  // A typed tag that is spoken mid-sentence ("REST uses many endpoints, ..."), where a B-roll has room.
  await brollCard.getByLabel(/Tags/).fill('network, endpoints');
  const [tagRes] = await Promise.all([page.waitForResponse((x) => x.request().method() === 'PATCH' && /\/assets\//.test(x.url())), brollCard.getByRole('button', { name: 'Save tags' }).click()]);
  assert.equal(tagRes.status(), 200, 'tags saved through PATCH /v1/projects/{id}/assets/{assetId}');
  await page.getByRole('switch', { name: 'Own B-roll' }).click();
  await page.getByRole('button', { name: 'Fillers settings' }).click();
  await page.getByLabel(/Always cut/).fill('really');
  await page.getByLabel(/Always keep/).focus(); // blur commits the list
  assert.match(String(await page.getByLabel('Brand').inputValue()), /^ui-brand-/, 'the saved brand is selected');

  step('create: keyboard-only pass');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const tabTo = async (pred: string, max = 120) => {
    for (let i = 0; i < max; i++) {
      await page.keyboard.press('Tab');
      if (await page.evaluate((p) => new Function('el', `return ${p}`)(document.activeElement), pred)) return;
    }
    throw new Error(`Tab never reached ${pred}`);
  };
  const switchFor = (name: string) => `el?.getAttribute('role') === 'switch' && document.getElementById(el.getAttribute('aria-labelledby'))?.textContent.trim() === '${name}'`;
  for (const name of ['Text hook', 'Motion graphics']) {
    await tabTo(switchFor(name));
    await page.keyboard.press('Space');
    assert.equal(await page.getByRole('switch', { name }).getAttribute('aria-checked'), 'true', `${name} on by keyboard`);
  }
  const ring = await page.evaluate(() => getComputedStyle(document.activeElement!).boxShadow);
  assert.ok(ring && ring !== 'none', 'focused switch shows the focus ring');
  await settle();
  await page.screenshot({ path: join(shots, '2-create-keyboard-focus.png') });
  await shoot('2-create');
  await tabTo(`el?.textContent === 'Edit Video'`);
  await settle();
  await page.screenshot({ path: join(shots, '2-create-edit-video-focus.png') });
  await page.keyboard.press('Enter');

  // ---- processing ----
  step('processing');
  await page.getByRole('heading', { name: 'Editing your video' }).waitFor();
  await page.locator('.stage--running').first().waitFor({ timeout: 60_000 });
  await shoot('3-processing', { grounds: ['ink', 'paper'] });
  await page.getByRole('heading', { name: 'Transcript' }).waitFor({ timeout: 600_000 });
  // (The processing screen's stages all reached Done before it navigated: onSucceeded only fires on success.)

  // ---- review ----
  step('review: player');
  const vid = page.locator('video.player__video');
  await vid.waitFor({ timeout: 60_000 });
  const played = await vid.evaluate(async (v: HTMLVideoElement) => {
    v.muted = true;
    await v.play();
    await new Promise((r) => setTimeout(r, 1500));
    v.pause();
    return { t: v.currentTime, w: v.videoWidth, h: v.videoHeight };
  });
  assert.ok(played.t > 0.5 && played.w > 0, `draft plays: ${JSON.stringify(played)}`);
  await vid.evaluate((v: HTMLVideoElement) => (v.currentTime = 0));

  step('review: transcript cuts, restore, undo');
  const cuts = page.locator('.transcript .cut');
  const nCuts = await cuts.count();
  assert.ok(nCuts > 0, 'transcript shows removed spans');
  for (const r of await page.locator('.transcript .cut__reason').allTextContents()) assert.ok(r.trim().length > 0, 'every cut has a reason');
  const revText = () => page.locator('.toolbar .mono').textContent();
  const rev0 = await revText();
  await shoot('4-review');
  const restoreBtn = cuts.first().getByRole('button', { name: /^Restore/ });
  const restoreLabel = await restoreBtn.getAttribute('aria-label');
  await restoreBtn.click();
  await page.waitForFunction((r) => document.querySelector('.toolbar .mono')?.textContent !== r, rev0);
  assert.equal(await cuts.count(), nCuts - 1, `restored: ${restoreLabel}`);
  const rev1 = await revText();
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.waitForFunction((r) => document.querySelector('.toolbar .mono')?.textContent !== r, rev1);
  assert.equal(await cuts.count(), nCuts, 'undo brings the cut back');

  step('review: choose a hook option');
  const opts = page.getByRole('radio', { name: /^\d\. / });
  const nOpts = await opts.count();
  assert.ok(nOpts >= 1 && nOpts <= 3, `hook options: ${nOpts}`);
  await opts.last().check();
  const chosen = (await opts.last().evaluate((el) => el.parentElement!.textContent ?? '')).replace(/^\s*\d\.\s*/, '').trim();
  const rh = await revText();
  await page.getByRole('button', { name: 'Save hook' }).click();
  await page.waitForFunction((x) => document.querySelector('.toolbar .mono')?.textContent !== x, rh);
  assert.equal(await page.getByLabel('Text hook (edit freely)').inputValue(), chosen);

  step('review: caption edit and lock');
  await page.locator('.timeline-wrap > summary').click();
  const capClip = page.getByRole('button', { name: /^Captions: / }).first();
  await capClip.click();
  const capInput = page.getByLabel('Caption text');
  await capInput.fill('Edited by the UI test');
  let r = await revText();
  await page.getByRole('button', { name: 'Save caption' }).click();
  await page.waitForFunction((x) => document.querySelector('.toolbar .mono')?.textContent !== x, r);
  assert.match(String(await page.getByRole('button', { name: /^Captions: Edited by the UI test,/ }).getAttribute('aria-label')), /locked/, 'edited caption is locked');
  const vidClip = page.getByRole('button', { name: /^Video: / }).first();
  await vidClip.click();
  const lock = page.locator('.inspector').getByRole('switch');
  const before = await lock.getAttribute('aria-checked');
  r = await revText();
  await lock.click();
  await page.waitForFunction((x) => document.querySelector('.toolbar .mono')?.textContent !== x, r);
  assert.notEqual(await lock.getAttribute('aria-checked'), before, 'lock toggled');
  await shoot('5-review-timeline');

  // ---- export ----
  step('export');
  await page.locator('.toolbar').getByRole('button', { name: 'Export' }).click();
  const dlg = page.locator('dialog.dialog');
  await dlg.waitFor();
  await pick(dest);
  await dlg.getByRole('button', { name: /destination/ }).click();
  await dlg.getByText(dest).waitFor();
  await shoot('6-export-dialog');
  await dlg.getByRole('button', { name: 'Export', exact: true }).click();
  await dlg.getByText(/Export (complete|failed|canceled)/).waitFor({ timeout: 900_000 });
  const outcome = await dlg.locator('.result strong').textContent();
  await shoot('7-export-done');
  assert.equal(outcome, 'Export complete.', outcome ?? '');

  step('ffprobe export');
  const outDir = readdirSync(dest).find((f) => f.startsWith('takeoff-r'));
  assert.ok(outDir, `export folder in ${dest}`);
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', join(dest, outDir, 'video.mp4')]);
  const p = JSON.parse(stdout);
  const v = p.streams.find((s: { codec_type: string }) => s.codec_type === 'video');
  const au = p.streams.find((s: { codec_type: string }) => s.codec_type === 'audio');
  assert.deepEqual([v.codec_name, v.width, v.height, v.r_frame_rate], ['h264', 1080, 1920, '30/1']);
  assert.deepEqual([au.codec_name, Number(au.sample_rate)], ['aac', 48000]);
  assert.ok(Number(p.format.duration) > 3, `duration ${p.format.duration}`);
  await dlg.getByRole('button', { name: 'Close' }).click();

  step('plan: brand version, B-roll, filler dictionary');
  {
    const { apiBase, token } = await page.evaluate(() => ({ apiBase: window.takeoff!.apiBase, token: window.takeoff!.token }));
    const h = { Authorization: `Bearer ${token}` };
    const pid = ((await (await fetch(`${apiBase}/v1/projects`, { headers: h })).json()) as { projects: Array<{ id: string }> }).projects[0]!.id;
    const snap = (await (await fetch(`${apiBase}/v1/projects/${pid}`, { headers: h })).json()) as { plan: { plan: any }; assets: Array<{ tags: string[]; pool: string }> };
    const plan = snap.plan.plan;
    assert.match(plan.brandProfileRef, /^brands\/ui-brand-[a-z0-9-]+@1$/);
    assert.deepEqual(snap.assets.find((x) => x.pool === 'broll')!.tags, ['network', 'endpoints']);
    assert.ok(plan.visuals.some((x: any) => x.kind === 'broll'), `B-roll placed: ${plan.visuals.map((x: any) => x.kind)}`);
    assert.deepEqual(plan.settings.fillerDictionary, { preserve: [], remove: ['really'] });
  }

  step('provider approvals: IPC only, never HTTP');
  const pol = { networkPolicy: 'approved_providers', approvals: [{ provider: 'anthropic', dataTypes: ['transcript'], budgetUsd: 1 }] };
  const { apiBase, token } = await page.evaluate(() => ({ apiBase: window.takeoff!.apiBase, token: window.takeoff!.token }));
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const pid = ((await (await fetch(`${apiBase}/v1/projects`, { headers: h })).json()) as { projects: Array<{ id: string }> }).projects[0]!.id;
  const http = (await fetch(`${apiBase}/v1/projects/${pid}/providers`, { method: 'POST', headers: h, body: JSON.stringify(pol) })).status; // from outside the page: no console noise
  const ipc = await page.evaluate(
    async ([id, good]) => {
      const t = window.takeoff!;
      const bad = await t.setProviders(id, { networkPolicy: 'approved_providers', approvals: [{ provider: 'evil', dataTypes: ['video'], budgetUsd: 1 }] });
      const ok = await t.setProviders(id, good);
      return { bad: !!bad.error, ok: !ok.error };
    },
    [pid, pol] as const,
  );
  const after = ((await (await fetch(`${apiBase}/v1/projects/${pid}/providers`, { headers: h })).json()) as { policy: { networkPolicy: string } }).policy.networkPolicy;
  await page.evaluate((id) => window.takeoff!.setProviders(id, { networkPolicy: 'local_only', approvals: [] }), pid);
  const prov = { http, ...ipc, after };
  assert.deepEqual(prov, { http: 404, bad: true, ok: true, after: 'approved_providers' });

  // ---- network ----
  step('network');
  const seen = await a.evaluate(() => (globalThis as { __seen?: string[] }).__seen ?? []);
  const offenders = [...new Set([...seen, ...pageRequests])].filter((u) => !allowedRequest(u));
  assert.deepEqual(offenders, [], 'no non-loopback request');
  step(`${seen.length + pageRequests.length} requests, all app://, blob:, data: or loopback`);

  if (problems.length) throw new Error(`UI problems:\n${problems.join('\n')}`);
  step('passed');
} catch (e) {
  if (problems.length) process.stderr.write(`${problems.join('\n')}\n`);
  throw e;
} finally {
  await app?.close().catch(() => {});
  step(`screenshots: ${shots}`);
  if (process.env.TAKEOFF_E2E_KEEP) step(`kept ${dir}`);
  else await rm(dir, { recursive: true, force: true });
}
