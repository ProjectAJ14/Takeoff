# Desktop app

`packages/app` is the Electron desktop app. It runs the engine in its own main
process and reaches it only through the engine's loopback HTTP API, so the app
follows exactly the rules that agents get ([agents.md](agents.md)). It holds no
editorial logic of its own.

**Status:** works on macOS from a source checkout. There is no installer, no
code signing and no auto-update; packaging waits on the distribution and
license decision (PRD §23, see [release-gates.md](release-gates.md)).

## Run it

After the setup in [CONTRIBUTING.md](../CONTRIBUTING.md) (`npm install`,
`npx playwright install chromium`, `uv sync` in `workers/transcribe`):

```sh
npm run build -w @takeoff/app    # esbuild main + preload, Vite renderer → packages/app/dist/
npm run start -w @takeoff/app    # electron .
npm run dev -w @takeoff/app      # build, then start
```

Node runs the engine's TypeScript directly inside Electron (Electron 44 ships
Node 24 with type stripping and `node:sqlite`), so only the app's own code is
built. On first launch the app shows the first-run screen; the starter pack
there downloads the Whisper `base` model only after you click to allow it.

## Screens

| Screen | What you do there |
|---|---|
| First run | See what this computer can do (each feature's capability status and reason), install the starter pack (model download only with your consent, then the generated music and SFX library), choose a project folder, and optionally create a brand. Skipping the brand changes nothing about the edit |
| Create | Three columns. **Footage:** takes (drag in or pick; ordered, with Move earlier/later) and your own B-roll in a separate pool, each B-roll card with a Tags field ("what it shows"). **Edits:** the 13 toggles with their verbatim names; a row that is unavailable on this machine is disabled with its reason. The Fillers row holds strength and the "Always keep" / "Always cut" lists; Captions holds the caption style; Zoom holds the maximum zoom. **Output:** target length (auto or seconds, optional hard maximum), brand (from the library, shown with its version), a brief, and the output preset. **Edit Video** runs the pipeline |
| Processing | The seven stages with their state. A progress bar appears only when the job reports progress; otherwise elapsed time. Cancel is available throughout |
| Review | The draft player (Compare original shows the source proxy), the transcript with cuts you can restore, a change summary with "Needs review" items, Adjust (re-run with a new target, hook options plus a free hook edit, plain-language requests when a local Ollama model exists), the timeline and an inspector for the selected clip (lock, move, split, trim, crop, caption text and style, gain, mute, remove graphic). Undo and redo create new revisions |
| Export | Destination folder, preset (`final_1080` or `draft_720`), burn captions or not. Nothing reaches the destination when QA finds a critical issue. Reveal in folder opens the result |
| Settings | Ground (ink or paper), the brand library (create and edit brands: name, palette, font file, logo, caption style, hook tone, glossary, prohibited claims), providers per project, diagnostics, capabilities |

Direct edits in review lock the object they change, so re-running the edit
never overwrites them. The `draft_720` preset renders at 540×960 (the renderer's
`draft` profile, see [rendering.md](rendering.md#output-profiles)), although its
label says 720p.

## Keyboard

Every control is reachable with Tab and operable with Enter or Space; toggles
are `role="switch"` with `aria-checked` and an On/Off word.

| Keys | Where | Does |
|---|---|---|
| ⌘Z / Ctrl+Z | Review | Undo (a new revision) |
| ⇧⌘Z / Shift+Ctrl+Z | Review | Redo |

Inside a text field these keys keep their native text undo.

## Security model

- **Window.** `contextIsolation`, `sandbox` and `webSecurity` on; `nodeIntegration`
  and `webviewTag` off. The page loads only from `app://takeoff`; navigation,
  redirects and `window.open` elsewhere are denied, and every permission request
  is denied.
- **Content Security Policy** on every `app://` response: scripts, styles and
  fonts only from the app itself, `connect-src` only the loopback API port, no
  objects, frames, forms or base URL changes. No inline script or style.
- **Network.** The session cancels every request that is not `app://takeoff`,
  `blob:`, `data:`, `devtools:` or loopback HTTP. Fonts are bundled
  `@fontsource` files; the app makes no font or CDN request.
- **Engine API.** In process, on `127.0.0.1`, with a random 32-byte token passed
  to the page by synchronous IPC (never on the command line). Main attaches the
  token only to the media route, because `<video>` and `<img>` cannot send
  headers.
- **Preload.** A sandboxed script exposes only `window.takeoff`: the API base and
  token, native pickers (takes, B-roll, font, logo), dropped-file paths, provider
  approvals and reveal-in-folder. Every IPC handler checks that the sender is the
  app window and validates its arguments.
- **Files.** Folders become approved only through the native folder picker
  (remembered in `<userData>/approved-roots.json`); single files only through the
  file picker or a drop, for this session, with a media, font or logo
  extension. No HTTP, MCP or CLI call can approve a folder.
- **Providers.** Provider approvals are written only by the main process, from
  Settings. The HTTP API can read them but has no route to change them, so no API
  caller can grant itself egress ([privacy.md](privacy.md)).
- **Test hooks.** `TAKEOFF_USER_DATA` and `TAKEOFF_TEST_PICK` work only in an
  unpackaged build started with `NODE_ENV=test` or `--test`; a packaged app
  ignores them.
- **Local storage** holds only per-viewer conveniences (ground, last project,
  first-run flag, selected brand id, presets). Losing it loses no project data;
  brands live in the engine's library under app data.

## Checks

```sh
node --test "packages/app/test/**/*.test.ts"       # policy and UI logic, plus the Electron smoke test
NODE_ENV=test node packages/app/test/e2e/ui-e2e.ts  # slow: the real app end to end
```

`electron.smoke.test.ts` builds and launches the app with a temporary user-data
folder and asserts the window's web preferences, the preload surface, the CSP
header, that non-loopback requests are blocked, the first-run statuses and that
the 13 toggles are keyboard-operable switches. It skips when the Electron binary
is missing, and it is part of `npm test`.

`ui-e2e.ts` drives the real app on `say`-generated footage through first run
(brand with a highlight colour and logo), create (tagged B-roll, filler
dictionary), Edit Video, review (play, restore, undo, hook option, caption edit,
lock) and export, checks the MP4 with ffprobe, records every request the session
sees, runs a keyboard-only pass and saves screenshots at 1440, 1200 and 900 px
and at 200% zoom in both grounds. `TAKEOFF_E2E_KEEP=1` keeps the temporary
project. It needs macOS `say`, FFmpeg, uv with the cached `base` model, the
Playwright Chromium and the Electron binary. CI does not run it.
