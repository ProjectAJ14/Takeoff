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
| `brands/<id>/v<n>.json`, `brands/files/<sha256><ext>` | The brand library: one immutable file per brand version, and brand fonts and logos addressed by content hash ([Brands](#brands)) |
| `projects/` | Projects created over HTTP without a `?root=` |

**A project folder** holds `project.db` and the media folders described in
[projects.md](projects.md), plus these engine files:

| Path | Contents |
|---|---|
| `assets/<id>.json` | Asset manifests |
| `brands/files/<sha256><ext>` | Font and logo files of the brands this project uses (the profiles themselves are in `project.db`) |
| `cache/transcripts/` | Worker transcript output |
| `cache/faces/` | Worker face tracks, one file per source and tracker version |
| `cache/frames/` | Frames extracted for inspection |
| `jobs/<jobId>/request.json` | The job's input snapshot |
| `jobs/<jobId>/<stage>.json` | Stage checkpoints; `compiled-r<rev>.json` compiled timelines |
| `renders/<jobId>/` | Renders `draft-r<rev>.mp4` (or `final-r<rev>.mp4` from `render --final`), each with a render report `<name>.report.json`; QA reports `qa-r<rev>.json`; contact-sheet frames |
| `exports/<jobId>/` | Export render `video.mp4` (and its render report), QA report and `export-manifest.json` |

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
| Prepare | Needs at least one take (`no_takes`). Checks free disk for about 1 MB per second of takes, with 20% headroom (`disk_full`). Tracks faces in each video take and measures clipping in each take's audio (see [Faces and voice analysis](#faces-and-voice-analysis)) |
| Transcribe | Runs the Python worker on each take with audio (see [Transcript cache](#transcript-cache)) |
| Clean speech | Builds the `director-request`: output 1080×1920 at 30 fps, BT.709, 48 kHz; the settings and target; transcript words; candidates from `detectCandidates` (with the filler dictionary); the brand's name, tone, glossary and prohibited claims. Gathers the director context: B-roll with tags, music and SFX candidates, clipping per take, and the brief plus the brand's music moods |
| Plan visuals/audio | Asks the director for a plan, merges locks, removes brand-prohibited hooks and labels, validates, and commits it as a `system` revision. Stores up to three hook options for the review screen |
| Build graphics | Compiles the plan to `jobs/<jobId>/compiled-r<rev>.json` |
| Render preview | Renders a draft to `renders/<jobId>/draft-r<rev>.mp4` (a final for `renderFinal`) and writes its render report |
| Check quality | Runs QA and the repair loop |

A run with critical QA issues left at the end fails as `qa_critical`.

- **No speech.** When no take has words, the plan is a visual-only draft: one
  segment per video take, with a `marker_no_speech` review marker. With no video
  either, the job fails as `no_usable_media`. Takes without speech in an
  otherwise spoken project are left out with a `no_speech` warning.
- **Music and SFX candidates.** Every asset in the project's own `music` or
  `sfx` pool, or, when there is none, every library entry of that kind, imported
  as a `generated` asset carrying the library's license. A track's moods are its
  library category, its tags and the words of its file name; an effect's
  category (`ui_click`, `hit`, `whoosh`) comes the same way. Categories the brand
  bans are left out. The director picks among them ([director.md](director.md#rules-director)).
- **B-roll candidates.** Every video or image in the `broll` pool with its tags:
  the words of its original file name plus user tags (`setAssetTags`, CLI
  `import --tags`, HTTP `PATCH /v1/projects/{id}/assets/{assetId}`; at most 20
  tags of 1–32 letters, digits, spaces, `_` or `-`).
- **One heavy task at a time.** Transcription and renders are serialised within
  an engine.
- **Target length.** `targetSeconds` is `null` (automatic) or an integer from 10
  to 180; anything else is `invalid_settings`.
- **Take selection.** `takes` (ids from the `takes` pool) limits the run to those
  takes, in that story order. Default: every take, in import order.
- **Caption style and zoom strength.** `captionTemplate` replaces the template
  of every generated caption, and `zoomMaxScale` (1.0–1.25) caps every generated
  punch zoom. Both apply before locked objects are merged back.

## Faces and voice analysis

- **Faces (F06/F08).** Prepare runs the worker's `faces` command on each video
  take ([media.md](media.md#faces)), sampling 5 frames per second. The track is
  cached as `cache/faces/…` and keyed by the source hash, sample rate, detector
  and the worker's versions, so unchanged footage is never tracked again. The
  renderer receives the tracks as `RenderInput.faceTracks`. Face tracking is an
  enhancement: when the worker is missing or fails, the job continues with centre
  framing, adds a `face_tracking_failed` warning, and QA reports `face_crop` as
  `not_run` with the reason.
- **Voice analysis (F11).** `analyzeVoice` measures each take's clipping ratio
  once per content hash. The director adds a `source_clipping` marker above
  0.1 %. A failed measurement is simply absent.

## Brands

A brand profile (F17) is stored in two places, and both keep every version:

- **The app library**, `<app data>/brands/<id>/v<n>.json`.
  `saveLibraryBrand` always writes the next version and never rewrites one.
  Fonts (`.woff2`, `.woff`, `.ttf`, `.otf`) and logos (`.png`, `.jpg`) are
  imported by `importBrandFile` from an approved path: at most 10 MB, checked by
  magic bytes, copied to `files/<sha256><ext>`. Their id is `bf_<sha256>`, so a
  file can never change under its id.
- **The project**, through `saveBrandProfile`: the version goes into the
  store's `brand_profiles` table ([projects.md](projects.md)) and its files are
  copied into `brands/files/`. Saving different content under an existing
  version fails as `brand_version_exists`.

A plan names one version as `brandProfileRef: "brands/<id>@<version>"`, and a
render reads exactly that version, so saving a later version never changes a
re-render of an old plan. Edit defaults' `brandProfileId` picks the latest
version stored in the project.

At render time the engine passes the brand's font files (verified against their
hash) and its primary logo. A brand font whose file is missing falls back to
Inter. **Prohibited claims:** Plan visuals/audio removes any unlocked hook or
motion-graphic label containing a phrase the brand prohibits and adds an
`unsupported_claim` marker; a locked one makes the marker `critical`, and the
render refuses any plan that still contains such text (`prohibited_claim`).

Every render writes a **render report** next to the video
(`<name>.report.json`): revision, plan hash, profile, whether captions were
burned, the video's SHA-256, renderer and versions, the frozen brand profile,
each brand font with its hash or `fallback: "Inter"`, the logo and whether it
was drawn, and which assets had a face track.

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
| `face_crop` | A tracked face (confidence ≥ 0.5), sampled at the middle frame of each segment after the crop and any punch zoom, lies outside the frame by more than 2% of its width. `not_run`, with the reason, when no face was tracked | warning |
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
   `burnCaptions: false`, captions are left out of the video. A final render of
   the same plan hash and caption choice, recorded by `renderFinal` (CLI
   `render --final`), is reused instead when its bytes still match the hash in
   its render report.
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

The stems come from the renderer's own mix buses (`renderStems`), so they carry
the seam fades, the Studio voice chain, the music fades, gain and ducking, and
the SFX placement, before loudness normalisation. A renderer without
`renderStems` (the test fakes) gets plain cuts from the master WAVs instead. The
project also keeps the render and manifest under `exports/<jobId>/`.

`renderFinal()` renders the head plan with the `final` profile into
`renders/<jobId>/final-r<rev>.mp4`, writes its render report and runs QA, so a
later export can reuse it.

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
Only the desktop app's main process calls it, from Settings. The HTTP API can
read the policy (`GET /v1/projects/{id}/providers`) but not write it; the CLI and
MCP do neither.

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
worker's `probe`), Ollama models on `127.0.0.1` (1.5 s timeout), whether
Playwright's Chromium headless shell (the binary renders launch) exists, bundled
fonts, the installed library and free disk. F08 is `available` when the worker
answers `probe`, else `experimental` (centre zooms only). Each feature F01–F17 is `available`, `experimental` (degraded) or
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

`Workspace.open` runs it synchronously the first time a process opens a
project, before any job of that process can start. It assumes one process per
project: a second live process on the same project would see its running jobs
requeued.

`packages/engine/test/recovery.test.ts` kills the real CLI during Transcribe and
again during Render preview, and checks that a rerun finishes from the cached
transcript with one transcript row, that no `.partial` is ever an artifact and
that the source's hash never changes. It also cancels a hung render and fills
the disk at export (`disk_full`, nothing written to the destination).

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
- The external director cannot be selected from any surface. Diagnostics and
  the optional edit defaults other than the brand are reachable over HTTP only,
  not from the CLI or MCP.
- Only the brief's mood words reach the director (for the music pick).
- `recover()` on open assumes one process per project.
- No upload imports.

## Hard maximum at export

A final export (`profile: 'final_1080'`) of a plan carrying an export-blocking
warning (`isExportBlocking`, today `locked_duration_conflict`) fails with
`duration_conflict` before rendering and writes nothing. A draft export of the
same plan still succeeds and lists the conflict in `unresolvedWarnings`.

## Checks

```sh
node --test "packages/engine/test/**/*.test.ts"
node packages/engine/test/e2e/run-e2e.ts        # slow; TAKEOFF_E2E_KEEP=1 keeps the temp folder
node packages/engine/test/e2e/hard-case-e2e.ts  # slow; cross-take false start, punchline pause, 30 s hard max, seams
```

Tests use temporary projects, `lavfi` media, a fake transcriber and a fake
renderer; `integration.slow.test.ts` runs the real worker and skips without
`say`, `uv` or the cached `tiny` model. `wiring.test.ts` covers face tracking,
brand versions and render reports, prohibited claims, the director context,
final-render reuse, renderer stems and recovery on open. `egress.test.ts` and
`recovery.test.ts` are described in [privacy.md](privacy.md#network-trace) and
[Recovery](#recovery); the crash part of `recovery.test.ts` skips without `say`,
`uv` and the cached `base` model.
