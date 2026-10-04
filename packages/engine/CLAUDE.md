# packages/engine

`@takeoff/engine`: the local job coordinator. It owns jobs, state, validation,
files and permissions; the director only proposes plans and the renderer only
renders validated compiled plans. PRD §5.1, §5.3–5.5, §6, §7.2, §8 (EditorialEngine
orchestration, RenderService, QAService, ProviderBroker, ExportService), §10–§15.
It also serves the loopback HTTP API, the `takeoff` CLI and the MCP stdio server.

## What lives here

| Path | Contents |
|---|---|
| `src/engine.ts` | `Engine` (`create`/`open`, `importAssets`, `runPipeline`, `cancel`, `applyPatch`/`undo`/`redo`/`revert`, `renderAffected`, `exportProject`, `recover`, `installStarterPack`, `diagnosticBundle`), `mergeLocks`, `loadBrowserRenderer` |
| `src/capabilities.ts` | `engineCapabilities` → contracts `capabilities` DTO plus disk/renderer/font flags; `chromiumPresent` (the Playwright headless shell renders launch) |
| `src/brands.ts` | F17 brand library under `<appDataDir>/brands/<id>/v<n>.json` (`saveLibraryBrand` assigns the next version), brand files (`importBrandFile`: fonts/logos copied to `files/<sha256><ext>`, id `bf_<sha256>`, magic bytes checked, ≤ 10 MB), `BRAND_REF` |
| `src/transcribe.ts` | `workerTranscriber()`: the Python worker over `uv run --directory workers/transcribe`, JSONL progress, typed errors |
| `src/qa.ts` | `runQa` (decode, frames, dims, fps, pix_fmt, color tags, samples, loudness/true peak, overlay checks, contact sheet), `contactFrames` |
| `src/export.ts` | SRT/VTT/word-timed JSON captions, dialogue/music/sfx stems |
| `src/broker.ts` | `ProviderBroker` (policy, egress, budgets, receipts), `keychainKey` |
| `src/log.ts` | `Logger` (JSONL in `<appDataDir>/logs`), `redact` |
| `src/errors.ts` | `EngineError` (`code`, `message`, `remedy`), `toErrorInfo` |
| `src/workspace.ts` | `Workspace`: project registry (`<appDataDir>/projects.json`, id → root), one open `Engine` per root, app-level capabilities and starter pack; shared ops (`snapshot`, `artifacts`, `mediaFile`, `inspectFrames`, `checkPlan`, edit defaults) |
| `src/server.ts` | `startServer(ws, {port, token, appOrigin})`: versioned `/v1` loopback API (PRD §8 table plus list/snapshot, undo/redo/revert, media with Range, job SSE, starter pack, `/system`, edit defaults, brands, providers (read only), plain-language requests, diagnostics) |
| `src/requests.ts` | `planRequest`: Ollama on loopback classifies a request into `REQUEST_INTENTS`; product code maps intents to patch ops |
| `src/mcp.ts` | `runMcp`: MCP stdio (JSON-RPC 2.0, protocol `2025-06-18`), the ten PRD tools, Ajv-checked inputs |
| `src/cli.ts`, `bin/takeoff.js` | `takeoff` CLI (`main`), `renderTest` (PRD §17 five-second clip) |
| `skills/takeoff-agent/SKILL.md` | Portable agent skill: tool contract and patch ops |

Project layout written by the engine: `assets/<id>.json` (manifests), `brands/files/<sha256><ext>` (brand fonts/logos;
profiles live in the store's `brand_profiles` table), `cache/transcripts/`, `cache/faces/`, `renders/<jobId>/<profile>-r<rev>.report.json`
(render report), `jobs/<jobId>/<stage>.json` (checkpoints), `renders/<jobId>/`,
`exports/<jobId>/`. Asset pool and source start time are store settings `asset:<id>`.

## Invariants

- Stages run in order: Prepare → Transcribe → Clean speech → Plan visuals/audio →
  Build graphics → Render preview → Check quality. Each stage's output is written
  with `atomicWrite` and recorded with `store.addCheckpoint`; its cache key is
  sha256 of stage, job snapshot (settings, target, brand ref), source hashes,
  engine/compiler/prompt versions and the previous stage's key. A resumed job
  skips only stages whose key matches.
- A job's input is snapshotted once (`jobs/<id>/request.json`); a resume never
  takes new settings. `createJob` with a known idempotency key returns the same
  job; a concurrent second call returns the in-flight promise.
- Cancel aborts the stage's signal and acknowledges at once (state `canceled`);
  checkpoints stay; nothing commits after abort.
- Transcripts are cached by source hash + engine config hash (model, language,
  glossary, worker versions); unchanged media is never re-transcribed. Word and
  sentence ids are namespaced `<assetId>.w0001` so takes never share ids.
  `no_speech` is cached too and yields a visual-only plan with a review marker;
  `model_missing` puts the job in `waiting_for_user` with the worker's remedy.
- Director: rules by default; Ollama only on loopback; External only through
  `ProviderBroker.send` (refused in `local_only`, falls back to rules). Every plan
  goes through `compiler.validatePlan`, then `mergeLocks` copies every locked
  object of the head plan unchanged before a `system` commit.
- QA: a check that did not run is `not_run`/`skipped`, never `passed`. Repairs use
  only `suggestedPatch` ops (caption → `static` template, failed visual →
  `remove_visual`), ≤3 per issue group, through `compiler.applyPatch` (locks win).
  Any critical issue fails the job (`qa_critical`); an export with one writes
  nothing to the destination.
- Paths: imports and export/diagnostic destinations must realpath under
  `approvedRoots`; project files go through `resolveUnderRoot`. Processes take
  argument arrays; filter graphs hold only validated integers and gains.
- Egress: `local_only` throws `egress_denied` before any fetch; data types and
  budgets are per provider; a send without a caller estimate is charged the provider's
  conservative `estimateUsd`, never 0; a `provider_receipt` event is recorded before sending.
  Keys come from the macOS Keychain (`security find-generic-password -s takeoff.<provider> -w`)
  and are never logged, stored or bundled.
- Logs keep only `LOG_KEYS`, and only strings that look like ids/codes (≤40 chars,
  no `/` or spaces). Errors carry codes and product text, never paths or transcript text.
- The browser renderer is loaded only by `loadBrowserRenderer` (dynamic import of
  `@takeoff/renderer-browser`), which adapts `BrowserRenderer` and
  `generateLibraryAudio` to `RendererModule` and maps the artifact's `overlay`
  (caption bounds, violations) to the QA `OverlayReport` via `overlayFromBrowser`.
  `EngineOptions.loadRenderer` replaces it in tests. Draft renders get each
  asset's `proxyPath`.
- HTTP: listens on `127.0.0.1` only (no host option). Order per request: Host must be
  `127.0.0.1:<port>` or `localhost:<port>` (421), Origin must be absent, `null` or the
  configured app origin (403), then `Authorization: Bearer <token>` compared as sha256
  digests with `timingSafeEqual` (401). Bodies must be JSON objects ≤ 1 MB (413). Contract
  DTOs (`create-project-request`, `import-assets-request`, `create-job-request`, `patch`)
  are validated with contracts `validate`; other bodies by hand. Errors are `{code, message, remedy}`.
- Project ids resolve through the registry, and the registered root is re-checked against
  the approved roots on every open. The media route serves only files recorded by the store
  (job artifacts by hash, asset proxies, inspected frames), addressed by sha256.
- MCP and CLI use the same `Workspace` and `Engine` calls as HTTP, so approved roots,
  `baseRevision` and lock rules are identical. There is no shell tool. stdout of `mcp`
  carries only JSON-RPC lines.
- `Workspace.addApprovedRoot` (folder or single file) is in-process only, for the desktop main process
  after a native picker; no HTTP, MCP or CLI route reaches it. It updates the workspace and every open engine.
- Provider approvals (`broker.setPolicy`) are likewise in-process only: `GET /v1/projects/:id/providers`
  reads the policy, and no HTTP, MCP or CLI route writes it, so an API caller cannot grant itself egress.
- Edit defaults may also carry `takes` (selected takes in story order), `brandProfileId`, `brief`,
  `captionTemplate` (applied to every generated caption) and `zoomMaxScale` (caps punch scales); both
  are applied before `mergeLocks`, so locked objects keep their values. `null` clears a field.
- Faces (F06/F08): Prepare runs the worker's `faces` command per video take (`Transcriber.faces`, optional), cached as
  store setting `faces:<contentHash>` keyed by sample fps + detector + worker versions. A missing or failing tracker never
  fails a job: centre framing, a `face_tracking_failed` warning, and QA `face_crop` `not_run` with the reason. QA
  `face_crop` checks the renderer's face samples (rect after crop and punch) lie inside the frame ±2%.
- Brands (F17): versions are immutable (store `putBrandProfile`; different content under an existing version →
  `brand_version_exists`). Plans reference `brands/<id>@<version>`; a render reads exactly that version, so a later version
  never changes a re-render of an old plan. Each render writes a render report (frozen brand, fonts with an explicit
  `fallback: 'Inter'` when a brand font file is missing, logo, face-tracked assets, plan hash, video sha256).
- Prohibited claims: the Plan stage drops unlocked hooks/scene labels containing a brand-prohibited phrase and adds an
  `unsupported_claim` marker; `#renderInput` refuses any plan that still carries one (`prohibited_claim`), so such text
  never reaches a render.
- Director context: `voiceAnalysis` (media `analyzeVoice`, cached `voice:<contentHash>`), B-roll (`brollTags(name,
  tags)`; tags via `setAssetTags` / `PATCH /v1/projects/{id}/assets/{assetId}`), music/SFX candidates (own pool, else every
  library entry imported, mood/category from tags or the library entry; brand-banned categories removed), brief + brand
  moods, `settings.fillerDictionary` into `detectCandidates`. Hook options are stored per run (`hookOptions`) and returned
  in the snapshot.
- `renderFinal` (`takeoff render --final`) records a `render_final` and QA-checks it; `exportProject` reuses a final render
  whose report has the same plan hash, profile and caption choice and whose bytes still match the recorded hash.
- Stems come from the renderer module's `renderStems` (the mix's own buses); `writeStems` remains only for renderers
  without it (test fakes).
- `Workspace.open` runs `recover()` (synchronous) before any job of that process starts. ponytail: one process per project.
- Plain-language requests: the model only picks intent names from an allowlist; it never produces ids,
  timings, text or settings. No Ollama model → `director_unavailable` (503).
- Settings have no defaults (contracts rule): a project's edit defaults are stored once
  (create-project settings, CLI `--toggles`, MCP `propose_edit.settings`) and merged later.
- Starter pack: the network grant covers only the base-model download; with the model
  already cached (worker `probe`), it needs no grant and only generates the library.
- CLI `edit`/`transcribe` take `--glossary 'REST,Dio'` (ASR terms, part of the transcript
  cache key) and `edit` takes `--director rules|ollama:<model>` with `--director-timeout S`.

## Checks

```sh
node --test "packages/engine/test/**/*.test.ts"
npx tsc -p tsconfig.json --noEmit 2>&1 | grep packages/engine
```

`server.test.ts` covers token/Host/Origin/body-cap rejection, the loopback address, 409 on a
stale PATCH, Range and SSE. `mcp.test.ts` spawns `bin/takeoff.js mcp`. `cli.test.ts` runs
`renderTest` with the real renderer (loaded by file URL) and asserts a 150-frame, 5 s BT.709
MP4; the bin variant skips until `@takeoff/renderer-browser` is linked.

Tests use `fs.mkdtemp` projects, lavfi media, a fake transcriber and a fake
renderer (tiny bt709 MP4 of the compiled duration). `integration.slow.test.ts`
runs the real worker with the cached `tiny` model on `say` speech and skips
without `say`, `uv` or the model.

`wiring.test.ts` covers faces (cache, render input, face_crop), brand versions and render reports, prohibited claims,
director context, final-render reuse, renderer stems, asset tags over HTTP and recovery on open.

`test/e2e/run-e2e.ts` (slow, not in `npm test`): `node packages/engine/test/e2e/run-e2e.ts`
runs the whole CLI route on `say` + lavfi footage (landscape MOV, rotated portrait MP4) plus a tagged B-roll image and a
brand (`takeoff brand` with a highlight colour and logo PNG) with every P0 toggle, checks B-roll, logo and brand-colour
pixels, a non-silent music stem and that export reused the `render --final` render, then asserts the export (1080x1920, 30 fps, h264/aac, decoded frames =
compiled frames, -14 ±1 LUFS, true peak ≤ -1), captions without fillers or the false start,
transcript-verbatim graphics labels, stem lengths and unchanged sources, and writes six PNG
frames to inspect. `TAKEOFF_E2E_OLLAMA=<model>` adds the Ollama director and its fallback;
`TAKEOFF_E2E_KEEP=1` keeps the temp dir.

`test/e2e/hard-case-e2e.ts` (slow): two takes (an abandoned attempt in take 1, said in full in take 2), a 1.2 s beat
before a one-word punchline, "I like this", a negation and a number, 30 s hard max. Asserts the take 1 attempt is cut or
reviewed, negation/number/"like" verbatim in captions, no segment edge inside a word, the beat kept, flagged or dropped
with its setup (never split from it), duration ≤ 30 s or a conflict, and no sample step at any seam of the dialogue stem
or mix above the local signal; writes `seams.png` (frames either side of every cut) and `report.json`.
