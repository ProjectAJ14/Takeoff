# packages/app

`@takeoff/app`: the Electron desktop shell and React UI. It owns windows, native pickers, the renderer's
security posture and every screen of PRD §5 (first run, create, processing, review, timeline, export,
settings). It owns no editorial logic: every read and edit goes through the engine's loopback HTTP API
(`packages/engine`), so the app enforces exactly the rules agents get. PRD §5, §6 (toggle list), §8, §14.

## What lives here

| Path | Contents |
|---|---|
| `src/main/main.ts` | Electron main: `Workspace` + `startServer` in process (random 32-byte token, `appOrigin` `app://takeoff`), `app://` protocol with the CSP header, session lockdown, IPC handlers, persisted approved folders (`<userData>/approved-roots.json`) |
| `src/main/policy.ts` | Pure policy: `allowedRequest` (loopback/app/blob/data only), `csp(port)`, `isMediaPath`, picker pools and extensions, `testHooksEnabled` |
| `src/preload/preload.ts` | Sandboxed CJS preload: `window.takeoff = {apiBase, token, pickFolder, pickFiles, dropFiles, setProviders, revealInFolder}` |
| `src/renderer/logic.ts` | Pure UI logic: `TOGGLES` (names verbatim, defaults), `creatorPolish`, `availability`, `effectiveSettings`, target length, `editBlocker`, `foldJob` stage views, `announceDelay`, `summarize`, `transcriptItems`, `timelineClips`, `sourceCutAt`, size estimate |
| `src/renderer/api.ts` | `api()` fetch with bearer token, `watchJob()` SSE over a fetch stream, `patchPlan`, snapshot types |
| `src/renderer/*.tsx` | `App` (navigation, caps), `FirstRun`, `Create`, `Processing` (`JobStages`), `Review` (transcript, summary, adjust, timeline, inspector), `ExportDialog`, `Settings`, `ui.tsx` (`Switch`, `ErrorNote`, `usePref`, `useAnnouncer`) |
| `src/renderer/styles.css` | Chrome styles: role tokens from `design/tokens.css`, bundled `@fontsource` latin subsets |
| `scripts/build.ts` | esbuild main (ESM) + preload (CJS), Vite renderer → `dist/` |

Scripts: `npm run build -w @takeoff/app`, `start` (`electron .`), `dev` (build, then start).

## Runtime decision: engine in the main process

Electron 44 ships Node 24.21, which has `node:sqlite` and type stripping. Measured: the main process
imports `@takeoff/engine`'s TypeScript sources directly. So `build.ts` marks every package external
(`packages: 'external'`) instead of bundling the engine: bundling would break the engine's
`import.meta.url`-relative files (director prompts, worker directory, fonts) and the lazy
`@takeoff/renderer-browser` import. No utility or child process is needed. Revisit if a future Electron
drops type stripping or `node:sqlite`.

## Invariants

- Window: `contextIsolation`, `sandbox`, `webSecurity` on; `nodeIntegration` and `webviewTag` off. The
  page loads only from `app://takeoff`; navigation, redirects and `window.open` elsewhere are denied;
  every permission request and check is denied.
- CSP on every `app://` response: `default-src 'self'; script-src 'self'; style-src 'self'; font-src
  'self'; connect-src http://127.0.0.1:<port>; img-src/media-src 'self' <api> blob: data:` plus
  `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`, `frame-ancestors 'none'`. No inline script
  or style elements; Vite inlines no assets (`assetsInlineLimit: 0`).
- `session.webRequest` cancels every request that is not `app://takeoff`, `blob:`, `data:`, `devtools:`
  or http to loopback (PRD §14: no CDN or font request). Fonts are `@fontsource` files bundled by Vite.
- The token reaches the renderer by synchronous IPC, never argv. Main attaches it only to `GET
  /v1/projects/<id>/media/<sha256>` on the API port, because `<video>`/`<img>` cannot send headers.
- Approved roots widen only in main, through `Workspace.addApprovedRoot`: a folder from the folder
  picker (persisted), single files from the file picker or a drop (session only, media extensions
  only: takes `mp4 mov m4v`, B-roll also `png jpg jpeg`). Dropped paths come from
  `webUtils.getPathForFile` in the preload. Reveal-in-folder accepts only approved paths.
- Provider approvals (`broker.setPolicy`) are written only by main (`setProviders` IPC from Settings); the
  HTTP API can read them but has no write route, so no API caller can grant itself egress.
- Test hooks (`TAKEOFF_USER_DATA`, `TAKEOFF_TEST_PICK`) run only when `!app.isPackaged` and `NODE_ENV=test`
  or `--test` (`testHooksEnabled`); a packaged app ignores them.
- Every IPC handler checks the sender is the app window's `app://takeoff` frame and validates arguments.
- Unavailable toggles render disabled with the reason and are sent as `false` (`effectiveSettings`);
  AI-found B-roll (P1) is always unavailable. Toggle names stay verbatim; F11 is "Studio voice".
- Direct edits in review (caption, crop, gain, split, trim, reorder) send `unlock_object` (if locked),
  the op, then `lock_object` in one patch, so user edits survive regeneration.
- Processing shows a bar only when the job reports `progress`, elapsed time otherwise; the live region
  speaks at most once per 5 s.
- `localStorage` holds only per-viewer conveniences (ground, last project id/folder, first-run flag,
  draft brand, asset display names, presets); losing it loses no project data.

## Checks

```sh
node --test "packages/app/test/**/*.test.ts"
npx tsc -p tsconfig.json --noEmit
```

`logic.test.ts` covers toggle defaults, availability, target options, blockers, take order, stage
folding, announcement throttling, transcript/timeline read-outs and the shell policy.
`electron.smoke.test.ts` builds, launches Electron (Playwright `_electron`) with a temp userData and
approved root, and asserts the window's web preferences, the preload surface, the CSP header, that
non-loopback requests are blocked in page and main, first-run statuses, and that the 13 create-screen
toggles are keyboard-operable switches with `aria-checked` and an On/Off word. It skips when the
Electron binary is missing. Set `TAKEOFF_APP_SHOTS=<dir>` to save screenshots.

`test/e2e/ui-e2e.ts` (not in `npm test`; slow) drives the real app on `say`-generated footage through
first run, create, Edit Video, review (play, restore, undo, caption edit, lock) and export, ffprobes the
MP4, records every request the session sees (all must be loopback/app/blob/data), runs a keyboard-only
create pass and saves screenshots at 1440/1200/900 px and 200% zoom in both grounds under the OS temp dir.
Pickers are answered by `TAKEOFF_TEST_PICK` (paths joined by the platform delimiter), which main honours
only in an unpackaged build under `NODE_ENV=test` or `--test`. Zoomed shots use `webContents.capturePage` because Playwright
crops full-page shots under a zoom factor.

UI changes also need the manual pass in the repository `CLAUDE.md` (1440/1200/900 px, 200% zoom, both
grounds, keyboard only); the smoke test does not replace it.
