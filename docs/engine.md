# Engine

`packages/engine` is the local job coordinator. It owns jobs, state, validation,
files and permissions: the director only proposes plans, and the renderer only
renders validated compiled plans. The same package serves the loopback HTTP API,
the `takeoff` CLI and the MCP stdio server; [agents.md](agents.md) documents
those surfaces. This page covers what happens behind them.

```ts
import { Workspace } from '@takeoff/engine';

const ws = new Workspace({ appDataDir, approvedRoots: ['/Users/me/Videos'] });
const e = ws.create('/Users/me/Videos/MyReel', 'My reel');
await e.importAssets(['/Users/me/Videos/take1.mov'], { pool: 'takes' });
const r = await e.runPipeline({ settings, targetSeconds: null, lengthPolicy: 'none', idempotencyKey: 'edit-0001', baseRevision: 0 });
// r: { job, error, revision, qa, warnings }
```

## App data and project files

**App data** is `TAKEOFF_APP_DATA` when set. Otherwise it is
`~/Library/Application Support/Takeoff` on macOS, and
`$XDG_DATA_HOME/takeoff` (default `~/.local/share/takeoff`) elsewhere. It holds:

| Path | Contents |
|---|---|
| `projects.json` | The project registry: id → name and root |
| `logs/engine.jsonl` | Redacted structured logs |
| `library/` | The generated music and SFX, and their `library.json` index |
| `projects/` | Projects created over HTTP without a `?root=` |

**A project folder** holds `project.db` and the media folders described in
[projects.md](projects.md), plus these engine files:

| Path | Contents |
|---|---|
| `assets/<id>.json` | Asset manifests |
| `brands/<id>-v<n>.json` | Versioned brand profiles |
| `cache/transcripts/` | Worker transcript output |
| `cache/frames/` | Frames extracted for inspection |
| `jobs/<jobId>/request.json` | The job's input snapshot |
| `jobs/<jobId>/<stage>.json` | Stage checkpoints; `compiled-r<rev>.json` compiled timelines |
| `renders/<jobId>/` | Draft renders `draft-r<rev>.mp4`, QA reports `qa-r<rev>.json`, contact-sheet frames |
| `exports/<jobId>/` | Export render `video.mp4` and `export-manifest.json` |

Every engine write goes through `atomicWrite`, and every project-relative path
through `resolveUnderRoot`.

## Imports

`importAssets(paths, {pool})` imports each file on its own, so one bad file
never blocks the others. Each path must resolve, after symlinks, under an
approved root (`path_not_approved` otherwise). Files are ingested one at a time.

- **Pools.** `takes` takes video or audio; `broll` takes video or images;
  `music` and `sfx` need audio. A wrong kind fails as `wrong_pool`.
- **Dedupe.** A file whose content hash is already in the project returns that
  asset with `reused: true`. Two concurrent imports of the same bytes share one
  ingest.
- **Ids.** An asset id is `a_` plus the first 16 hex characters of its SHA-256.

## Pipeline

`runPipeline` (Edit Video) runs seven stages in order. `transcribe` runs only
the first two, and `renderAffected` (re-render after an edit) only the last
three.

| Stage | What it does |
|---|---|
| Prepare | Needs at least one take (`no_takes`). Checks free disk for about 1 MB per second of takes, with 20% headroom (`disk_full`) |
| Transcribe | Runs the Python worker on each take with audio (see [Transcript cache](#transcript-cache)) |
| Clean speech | Builds the `director-request`: output 1080×1920 at 30 fps, BT.709, 48 kHz; the settings and target; transcript words; candidates from `detectCandidates`; the brand's name, tone, glossary and prohibited claims. Picks a music and an sfx asset when those toggles are on |
| Plan visuals/audio | Asks the director for a plan, validates it, merges locks and commits it as a `system` revision |
| Build graphics | Compiles the plan to `jobs/<jobId>/compiled-r<rev>.json` |
| Render preview | Renders a draft to `renders/<jobId>/draft-r<rev>.mp4` |
| Check quality | Runs QA and the repair loop |

A run with critical QA issues left at the end fails as `qa_critical`.

- **No speech.** When no take has words, the plan is a visual-only draft: one
  segment per video take, with a `marker_no_speech` review marker. With no video
  either, the job fails as `no_usable_media`. Takes without speech in an
  otherwise spoken project are left out with a `no_speech` warning.
- **Music and SFX.** The first asset in the project's `music` or `sfx` pool is
  used. Otherwise the engine imports the first library entry of that kind, as a
  `generated` asset carrying the library's license.
- **One heavy task at a time.** Transcription and renders are serialised within
  an engine.
- **Target length.** `targetSeconds` is `null` (automatic) or an integer from 10
  to 180; anything else is `invalid_settings`.
- **Take selection.** `takes` (ids from the `takes` pool) limits the run to those
  takes, in that story order. Default: every take, in import order.
- **Caption style and zoom strength.** `captionTemplate` replaces the template
  of every generated caption, and `zoomMaxScale` (1.0–1.25) caps every generated
  punch zoom. Both apply before locked objects are merged back.

## Jobs, cancel and resume

- **Creation.** Every job is created from a valid `create-job-request`. Its
  idempotency key must be 8–128 letters, digits, `_` or `-`. A known key returns
  the same job, and a concurrent second call returns the run already in flight.
- **States.** `queued` → `running` → `succeeded`, `failed` or `canceled`.
  `model_missing` puts the job in `waiting_for_user` instead, with the worker's
  remedy recorded in a `job_waiting` event.
- **Input snapshot.** The job's input is written once to `request.json`. A resumed
  job re-reads it, so a later call cannot change its settings.
- **Checkpoints.** Each stage's output is written to `jobs/<jobId>/<stage>.json`
  with its cache key, and recorded with `store.addCheckpoint`.
- **Cache key.** SHA-256 of the canonical JSON of: the stage, the job snapshot
  (settings, target, length policy, brand reference), the engine,
  compiler and prompt versions, the content hashes of the takes, and the previous
  stage's key. A stage whose stored key matches is skipped, so changing an early
  input invalidates everything after it.
- **Resume.** Calling the same operation again with the same idempotency key
  restarts a `queued` or `waiting_for_user` job and skips every stage whose key
  matches. A finished job returns its recorded result.
- **Cancel.** `cancel(jobId)` aborts the running stage's signal and marks the job
  `canceled` at once. Checkpoints stay, and nothing commits after the abort. A
  queued or waiting job is canceled directly.

## Transcript cache

- **Config.** Model `base`, language `en`, and the glossary from the engine
  options (CLI `--glossary`) or else the brand profile. Glossary terms that are
  empty, contain a comma or are over 64 characters are dropped; at most 200 are
  kept.
- **Key.** `(source hash, config hash, model)`, stored in the project database.
  The config hash is SHA-256 of the model, language, glossary and the worker's
  reported component versions. Unchanged media with unchanged config is never
  transcribed again.
- **No speech** is cached too, so a silent take is not re-run.
- **Ids.** Word and sentence ids are namespaced by asset (`<assetId>.w0001`), so
  several takes never share an id.
- **VAD speech intervals** from the worker are stored next to the transcript and
  passed to the director to protect untranscribed speech.

## Director selection

| Choice | Adapters, in order |
|---|---|
| `rules` (default) | `RulesDirector` |
| `{kind: 'ollama', model, port?, timeoutMs?}` | `OllamaDirector` on `127.0.0.1`, then `RulesDirector` |
| `{kind: 'external', provider, model}` | `ExternalDirector` sending through `ProviderBroker.send(provider, 'transcript', …)`, then `RulesDirector` |

`directPlan` uses the first available adapter, repairs once, and falls back to
the rules plan (see [director.md](director.md#validate-repair-fall-back)). A plan
that still fails validation fails the job as `invalid_plan`. The CLI offers
`rules` and `ollama:<model>`; no surface selects the external director yet.

## Lock merge

`mergeLocks(next, head)` copies every locked object of the head plan into the
regenerated plan unchanged: decisions, segments, captions, visuals, transforms,
sfx cues and the music cue. A locked object that the new plan dropped is added
back. The merged plan is validated again; a failure is `lock_conflict`, and
nothing is committed.

## QA

`runQa` checks the rendered file against the compiled timeline. Every check ends
as `passed`, `failed`, `skipped` (with a reason) or `not_run`. A check that did
not run is never reported as passed.

| Check | Fails when | Severity |
|---|---|---|
| `decode` | A full FFmpeg decode reports any error | critical |
| `video_stream`, `audio_stream` | The stream is missing | critical |
| `duration_frames` | Video packets ≠ `totalFrames` | critical |
| `dimensions` | Size ≠ the size the renderer declared | critical |
| `frame_rate` | Rate ≠ the compiled rate | critical |
| `pix_fmt` | Not `yuv420p` | warning |
| `color_tags` | Space, primaries or transfer not `bt709` | warning |
| `audio_samples` | Not 48 kHz, or the sample count is off by more than one frame's worth | critical |
| `true_peak` | Above −0.1 dBTP (critical); above the plan's target (warning) | critical / warning |
| `loudness` | More than ±1 LU from the plan's target | warning |
| `caption_bounds` | A caption box leaves the platform safe area, or caption text overflowed | critical |
| `visual_render` | A scene's text overflowed, or the scene left the safe area | critical |
| `undeclared_network` | A scene attempted a request outside the allowlist | critical |
| `fonts` | A font fell back to the default | warning |
| `face_crop` | Always `not_run`: there is no face tracking | — |
| `contact_sheet` | A contact-sheet frame could not be extracted | warning |

Digital silence makes `loudness` and `true_peak` `skipped`. The overlay checks
are `not_run` when the renderer reports no overlay measurements. The contact
sheet extracts up to 60 frames: the first frame, both sides of every cut, each
visual's start, middle and end, and the middle of the longest caption.

### Repair loop

Some issues carry a `suggestedPatch`:

- `caption_bounds` → `set_caption` with `template: "static"`, when the caption
  is not locked and not already static.
- `visual_render` → `remove_visual`, when the visual is not locked.

Check quality applies the suggested ops through `compiler.applyPatch` (locks
win), commits a `system` revision, renders a new draft and runs QA again. Each
issue group (check plus object) gets at most 3 attempts, over at most 6 rounds.
If a patch no longer applies, the issue stays for review. Non-critical issues
become job warnings.

## Export

`exportProject({profile, destinationDir, burnCaptions, idempotencyKey?})`:

1. Checks that `destinationDir` is under an approved root before any work.
2. Checks free disk for about 3 MB per second of output.
3. Renders the head revision: profile `final_1080` uses the `final` render
   profile (1080×1920), and `draft_720` the `draft` profile (540×960). With
   `burnCaptions: false`, captions are left out of the video.
4. Runs full QA. **With a critical issue, nothing is written to the destination.**
5. Writes `<destination>/takeoff-r<rev>-<jobId first 8>.partial/`, then renames
   it without `.partial`.

| File | Contents |
|---|---|
| `video.mp4` | The render |
| `captions.srt`, `captions.vtt`, `captions.json` | When the plan has captions (even with `burnCaptions: false`). The JSON has word timing in frames and milliseconds |
| `stems/dialogue.wav`, `stems/music.wav`, `stems/sfx.wav` | 48 kHz stereo, exactly `totalSamples` long; silent when the bus is empty |
| `bundle/` | `plan.json`, `transcripts/<assetId>.json`, `assets/<id>.json` manifests, the caption files, `qa-report.json`, `export-manifest.json`, and `bundle.json` listing each file's SHA-256. No source media, no keys |
| `export-manifest.json` | The contracts `export-manifest`: preset, outputs with hashes and sizes, QA checks, unresolved warnings |

The stems are plain cuts, gains and placement from the 48 kHz master WAVs; they
do not carry Studio voice, seam fades or ducking. The project also keeps the
render and manifest under `exports/<jobId>/`.

## Provider broker

`ProviderBroker` is the only code path that sends content off the machine. Its
policy is stored per project (setting `providerPolicy`) and defaults to
`local_only`.

```ts
{ networkPolicy: 'local_only' | 'approved_providers',
  approvals: [{ provider: 'anthropic', dataTypes: ['transcript'], budgetUsd: 2 }] }
```

`send(provider, dataType, purpose, request, {jobId?, estimatedCostUsd?})` checks,
in order, and throws `egress_denied` before any network call when:

- the project is `local_only`;
- the provider is not approved, or is not a known endpoint (only `anthropic`,
  `https://api.anthropic.com/v1/messages`, exists);
- the data type is not approved for that provider (`transcript`, `frames`,
  `audio`, `video`, `asset_query`, `asset_download`, `prompt`, `brand_page`).

Then:

- **Budget.** Spend is the sum of the provider's receipts. Without a caller
  estimate, the provider's deliberately high estimate applies (3 bytes per token
  at $15/M in, plus `max_tokens` or 4096 out at $75/M), so a send never counts as
  free. Over budget is `budget_exceeded`.
- **Credentials.** The key is read from the OS credential store (see
  [privacy.md](privacy.md#credentials)).
- **Receipt first.** A `provider-receipt` (provider, data type, purpose, bytes,
  estimated cost, retention policy URL, job) is recorded before the request is
  sent, so a lost reply still leaves a record.
- **Transport.** `POST` with redirects refused and a 120 s timeout. A non-2xx
  status or a non-JSON body is `provider_error`. There are no retries.

`setPolicy` validates and stores a policy and appends a `provider_policy` event.
The HTTP API exposes it as `POST /v1/projects/{id}/providers`; the CLI and MCP do
not.

## Logs and diagnostics

`Logger` appends one JSON line per event to `<app data>/logs/engine.jsonl`.
`redact` keeps only these keys: `projectId`, `jobId`, `stage`, `durationMs`,
`cacheHit`, `counts`, `codes`, `code`, `fps`, `qaOutcome`, `fallbackCount`,
`retryCount`, `state`, `revision`, `attempt`. A string survives only if it looks
like an id or code (at most 40 characters, no `/`, `\` or spaces) or is a stage
name. Nested objects keep the same rule, two levels deep. A logging failure
never fails a job.

Errors carry `{code, message, remedy}`. An untyped error becomes
`internal error (<class name>)`, because its message could hold a path.

`writeDiagnostics` (`Engine.diagnosticBundle`, `Workspace.diagnosticBundle`,
HTTP `POST /v1/diagnostics`) writes `takeoff-diagnostics-<ms>/` under an approved
folder: `versions.json` (engine, compiler, prompt, Node, platform),
`capabilities.json` and `logs/engine.jsonl` redacted again.

## Capabilities

`engineCapabilities` builds the contracts `capabilities` DTO from what the
machine has: FFmpeg encoders and decoders, installed ASR models (from the
worker's `probe`), Ollama models on `127.0.0.1` (1.5 s timeout), whether the
Playwright Chromium binary exists, bundled fonts, the installed library and free
disk. Each feature F01–F17 is `available`, `experimental` (degraded) or
`unavailable`, with a reason. [features.md](features.md) lists them.

## Starter pack

`installStarterPack({allowNetwork})` is an explicit user action at app level
(CLI `starter-pack`, HTTP `POST /v1/starter-pack`):

1. Asks the worker whether the `base` model is cached. If not, it needs
   `allowNetwork: true` (`network_denied` otherwise) and downloads it with
   `download-model --model base --allow-network`.
2. Generates the music and SFX library into `<app data>/library` with the
   renderer's `generateLibraryAudio` (see
   [rendering.md](rendering.md#generated-library-audio)).
3. Writes `library/library.json` as `{schemaVersion, entries: [{id, kind, path,
   category, license}]}`, keeping only entries with a valid id and a file inside
   the library folder.
4. Returns the model, the entries and their licenses (Whisper base weights: MIT;
   library: `Takeoff original, generated`).

With the model already cached, the pack needs no network grant.

## Recovery

`recover()` is for after a crash:

- Each `running` job goes back to `queued` if all its checkpoints still match
  their hashes; otherwise it fails as `interrupted`. Artifacts whose files no
  longer match are dropped.
- Every `*.partial` file or folder under the project root is deleted.

No surface calls `recover()` yet.

## `render-test`

`renderTest(out, {final?})` is the PRD §17 first deliverable. It generates a
five-second 1080×1920 30 fps `testsrc2` clip with a 440 Hz tone in a temporary
folder, imports it, runs the pipeline with Studio voice and auto colour on, and
copies the draft (or, with `--final`, the `final_1080` export) to `out`. It skips
ASR, so it needs no model.

```sh
node packages/engine/bin/takeoff.js render-test /tmp/takeoff-test.mp4
```

## Known gaps

From `ponytail:` comments in the source and from what no surface calls yet:

- A locked object the regenerated plan dropped is appended, so segment order is
  then the lock's, not chronological.
- Imports run one file at a time.
- `renderAffected` re-renders the whole timeline after any edit.
- The broker's cost estimate is a deliberate over-estimate with no price table,
  and sends are never retried.
- Finding a job by id scans every registered project.
- The renderer's "output is not an input" check compares paths lexically; a
  symlinked or case-variant path slips through.
- Stems lack Studio voice, seam fades and ducking.
- The library pick takes the first entry of a kind, so music is always
  `bed_calm` and every sfx cue (including `whoosh` cues) uses `sfx_ui_click`.
- `recover()` is a library call only, and the external director cannot be
  selected from any surface. Brand profiles, provider policy, diagnostics and the
  optional edit defaults are reachable over HTTP only, not from the CLI or MCP.
- The creative `brief` is kept in the job snapshot but not sent to the director.
- No face tracking, no B-roll placement, no upload imports.
- Capabilities looks for Playwright's full Chromium binary, while renders
  launch the headless shell. With only the shell installed, capabilities reports
  the renderer missing although renders work.

## Checks

```sh
node --test "packages/engine/test/**/*.test.ts"
node packages/engine/test/e2e/run-e2e.ts      # slow; TAKEOFF_E2E_KEEP=1 keeps the temp folder
```

Tests use temporary projects, `lavfi` media, a fake transcriber and a fake
renderer; `integration.slow.test.ts` runs the real worker and skips without
`say`, `uv` or the cached `tiny` model.
