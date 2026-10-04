# Agent integration

Agents and scripts drive Takeoff through three surfaces in `packages/engine`:
the `takeoff` CLI, an MCP stdio server and a loopback HTTP API. All three call
the same `Workspace` and `Engine` code, so approved folders, revision checks and
lock rules are identical. An agent proposes JSON plans and allowlisted patches;
Takeoff validates them and runs deterministic code. No surface has a shell tool
or accepts FFmpeg filters, HTML or code.

How the director proposes plans internally is in [director.md](director.md);
what each job does is in [engine.md](engine.md).

## Approved folders

Every project folder, imported file, export destination and diagnostic folder
must resolve, after symlinks, under an approved folder. Anything else fails as
`path_not_approved`.

| Surface | Approved folders |
|---|---|
| CLI project commands | The folders and the files' parent folders named on that command line |
| `takeoff mcp` | Each `--root`; else `TAKEOFF_APPROVED_ROOTS` (colon-separated); else the current folder |
| `takeoff serve` | The same as `mcp`, plus `<app data>/projects` |
| Desktop app | Folders the user picks in a native dialog, added in process with `Workspace.addApprovedRoot`. No HTTP, MCP or CLI call can add a folder |

## CLI

Run `node packages/engine/bin/takeoff.js` (the package's `takeoff` bin). Node
loads the TypeScript directly; there is no build step.

```text
takeoff 0.1.0
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
Global: --json (errors as JSON on stderr)
```

| Command | Does |
|---|---|
| `init` | Creates a project. `--name` defaults to `Untitled`. `--toggles` and `--target` store edit defaults |
| `import` | Imports files into a pool (default `takes`). Prints `{items}` with an `assetId` or `error` per file |
| `transcribe` | Prepare + Transcribe |
| `edit` | Merges `--toggles` (a JSON object of `settings` fields) and `--target` into the stored defaults, then runs the full pipeline. The first `edit` or `init` must set every toggle. `--target` is `auto` or 10–180 seconds; with a target, `--policy` defaults to `soft_target`. `--glossary` sets ASR terms (part of the transcript cache key). `--director-timeout` is 1–600 s |
| `plan` | Prints the head plan with its `revision` and `planHash` |
| `validate` | Schema check; with `--project`, semantic checks too. Exits 1 when invalid |
| `patch` | Applies a patch file; prints `{revision, planHash}` |
| `render` | Re-renders the head as a draft and runs QA. `--final` runs a `final_1080` export into `<dir>/exports` |
| `qa` | Same as `render` without `--final` |
| `export` | Exports to `<dest>` (`final_1080` by default). `--no-captions` leaves captions out of the video |
| `capabilities` | Prints the `capabilities` DTO |
| `starter-pack` | Downloads the base ASR model (only with `--allow-network`, and only if it is not cached) and generates the music/SFX library |
| `serve` | Starts the HTTP API and prints `{url, token}` |
| `mcp` | Serves MCP on stdin/stdout |
| `render-test` | Renders a five-second synthetic clip end to end and copies it to `<out.mp4>` |

The toggle keys are `badTakes`, `fillers`, `silence`, `captions`, `userBroll`,
`aiBroll`, `zoom`, `music`, `sfx`, `studioVoice`, `autoColor`, `textHook`,
`motionGraphics`, `networkPolicy` and `fillerStrength` ([schema.md](schema.md#edit-plan)).

Results print as JSON on stdout. Exit codes: 0 on success; 1 when a job did not
succeed, an import item failed, a plan is invalid or any error occurred; 2 on a
usage error. Errors print `takeoff: <message>` and the remedy on stderr, or the
`{code, message, remedy}` JSON with `--json`.

## MCP server

`takeoff mcp --root <folder>` speaks JSON-RPC 2.0 over stdio, one message per
line, protocol version `2025-06-18`. It answers `initialize`, `ping`,
`tools/list` and `tools/call`, and ignores notifications. stdout carries only
JSON-RPC lines.

Tool inputs are checked against each tool's JSON Schema (no extra fields). A
result is one text item holding JSON. A failure sets `isError: true` and the text
is `{code, message, remedy}` (`invalid_arguments` for a schema failure). Tool
calls wait for the job to finish.

| Tool | Required inputs | Optional inputs | Returns |
|---|---|---|---|
| `inspect_project` | `project` | — | Project, assets with pools, transcript words, plan with `revision` and `planHash`, revisions, latest job, artifacts, edit defaults |
| `import_assets` | `project`, `paths` (1–100), `pool` | — | `{items}` |
| `transcribe` | `project` | `idempotencyKey` | `{job, error, revision, warnings, qa}` |
| `propose_edit` | `project`, `baseRevision` | `settings`, `targetSeconds` (10–180 or `null`), `lengthPolicy`, `idempotencyKey` | Same as `transcribe` |
| `validate_plan` | `plan` | `project` | `{ok, schemaErrors, errors, warnings, semantic: "run" \| "skipped"}` |
| `apply_patch` | `project`, `patch` | — | `{revision, planHash}` |
| `render_draft` | `project` | `idempotencyKey` | Same as `transcribe` |
| `inspect_frames` | `project`, `frames` (1–16) | `width` (16–1920, default 540) | `{revision, frames: [{request, artifactId, ref}]}` |
| `run_qa` | `project` | `planHash` | Same as `transcribe` |
| `export_project` | `project`, `destination`, `profile` | `burnCaptions` (default `true`), `idempotencyKey` | Same plus `manifest` and `dir` |

`project` is the project folder. An `idempotencyKey` is 8–128 letters, digits,
`_` or `-`; the same key returns the same job. A frame request is
`{clock: "source", assetId, us}` (from the original take) or
`{clock: "output", frame}` (from the draft render of the current revision;
`no_render` when there is none). `run_qa` with a stale `planHash` fails as
`stale_revision`.

## HTTP API

`takeoff serve [--port N] [--root dir]... [--app-origin O]` listens on
`127.0.0.1` only (port 0 picks a free one) and prints `{url, token}`. The token
is `TAKEOFF_TOKEN` when set (at least 16 characters), otherwise 32 random bytes.

Every request passes these checks in order:

1. **Host** must be `127.0.0.1:<port>` or `localhost:<port>`, or the reply is
   421 `bad_host`. This stops DNS-rebinding pages.
2. **Origin** must be absent, `null` or exactly `--app-origin`, or the reply is
   403 `bad_origin`. An allowed origin is echoed in
   `Access-Control-Allow-Origin`; `OPTIONS` preflights get 204 here.
3. **`Authorization: Bearer <token>`**, compared as SHA-256 digests with
   `timingSafeEqual`, or the reply is 401 `unauthorized`.

Bodies must be JSON objects of at most 1 MB (413 `body_too_large`). Contract
DTOs are validated with the contracts schemas; other bodies are checked by hand.
Errors are `{code, message, remedy}`. Status codes: 400 for `invalid_*` codes,
403 for `path_not_approved`, `egress_denied` and `network_denied`, 404 for
`not_found`, `revision_not_found`, `brand_not_found`, unknown routes, and
`no_plan` from `GET /plan` and `/qa`, 409 for `stale_revision`, `locked_object`, `project_exists`
and nothing to undo/redo, 503 for `renderer_unavailable` and `director_unavailable`, 500 for `internal`,
and 422 for other codes. Responses are `Cache-Control: no-store`.

| Method and path | Body | Reply |
|---|---|---|
| `GET /v1/capabilities` | — | 200 `capabilities` DTO |
| `GET /v1/system` | — | 200 `{diskFreeBytes, ffmpeg, renderer, fonts}`: machine facts the DTO has no field for |
| `GET /v1/projects` | — | 200 `{projects: [{id, name, root}]}` |
| `POST /v1/projects[?root=<folder>]` | `create-project-request` | 201 `{projectId, revision}`. Without `root`, a new folder under `<app data>/projects` |
| `GET /v1/projects/{id}` | — | 200 project snapshot (as `inspect_project`) |
| `POST /v1/projects/{id}/assets[?pool=…]` | `import-assets-request`, `path` items only (`upload_unsupported` otherwise) | 200 `{items}`; imports run before the reply |
| `POST /v1/projects/{id}/edit-defaults` | Any of `settings` (merged), `targetSeconds`, `lengthPolicy`, `takes`, `brandProfileId`, `brief`, `captionTemplate`, `zoomMaxScale`; other fields are refused | 200 `{editDefaults}` (see [Edit defaults](#edit-defaults)) |
| `POST /v1/projects/{id}/brands` | `brand-profile` | 201 `{ref}`: the saved `brands/<id>-v<n>.json` |
| `GET /v1/projects/{id}/providers` | — | 200 `{policy}`: the project's provider policy |
| `POST /v1/projects/{id}/providers` | `{networkPolicy, approvals}` | 200 `{policy}` after validation ([privacy.md](privacy.md#approved-providers)) |
| `POST /v1/projects/{id}/requests` | `{text, baseRevision}` | 200 `{revision, planHash, intents, ops}`: a plain-language request applied as a patch (see [Plain-language requests](#plain-language-requests)) |
| `POST /v1/projects/{id}/jobs` | `create-job-request` | 202 job. `Prepare` (draft only) runs Edit Video with the stored edit defaults (`settings_required` if none); `Transcribe`; `Build graphics`/`Render preview`/`Check quality` (draft, `baseRevision` must be current) re-render and QA. `Export` is refused: use `/exports` |
| `GET /v1/jobs/{id}` | — | 200 job |
| `POST /v1/jobs/{id}/cancel` | — | 202 job, or 409 `not_cancelable` |
| `GET /v1/jobs/{id}/events` | — | Server-sent events: `event: job` with the job JSON whenever it changes (polled every 250 ms); the stream ends at a terminal state |
| `GET /v1/projects/{id}/plan` | — | 200 `{revision, planHash, plan}`, or 404 `no_plan` |
| `PATCH /v1/projects/{id}/plan` | `patch` | 200 `{revision, planHash}` |
| `POST /v1/projects/{id}/undo`, `/redo` | `{baseRevision?}` | 200 `{revision, planHash}` |
| `POST /v1/projects/{id}/revert` | `{revision, baseRevision?}` | 200 `{revision, planHash}` |
| `POST /v1/projects/{id}/frames` | `{schemaVersion: "1.0", frames, width?}` | 200, as `inspect_frames` |
| `POST /v1/projects/{id}/qa` | `{planHash?, idempotencyKey?}` | 202 job (draft re-render and QA) |
| `POST /v1/projects/{id}/exports` | `{schemaVersion: "1.0", destinationDir, profile, burnCaptions?, idempotencyKey?}` | 202 job; the destination is checked before the job starts |
| `GET /v1/projects/{id}/media/{sha256}` | — | The file, with `Range` support (206/416). Only job artifacts, asset proxies and inspected frames recorded by the project are served, addressed by SHA-256 |
| `POST /v1/diagnostics` | `{destinationDir}` | 201 `{dir}`: a redacted diagnostic bundle under an approved folder |
| `POST /v1/starter-pack` | `{allowNetwork?}` | 200 starter-pack result |

Job routes reply 202 at once and run in the background; poll the job or follow
its events. Project ids resolve through the registry, and the registered folder
is re-checked against the approved folders on every request. The `/assets` reply
is the engine's per-file result (`{index, assetId, pool, reused}` or
`{index, error}`), not the contracts `import-assets-response` shape.

### Edit defaults

A project stores one set of edit defaults, which Edit Video uses: the full
`settings`, `targetSeconds` (`null` or 10–180) and `lengthPolicy`, and optionally:

| Field | Rule | Effect |
|---|---|---|
| `takes` | 1–500 distinct asset ids from the `takes` pool | Only these takes, in this story order (default: every take in import order) |
| `brandProfileId` | A brand saved in this project | Glossary, prohibited claims, palette and fonts come from it |
| `brief` | Text, at most 500 characters | Kept in the job snapshot; not sent to the director |
| `captionTemplate` | `restrained`, `energetic` or `static` | Applied to every generated caption |
| `zoomMaxScale` | 1.0–1.25 | Caps every generated punch zoom |

`null` clears an optional field. The CLI `init`/`edit` flags and MCP
`propose_edit` set only `settings`, `targetSeconds` and `lengthPolicy`.

### Plain-language requests

`POST /v1/projects/{id}/requests` takes `{text, baseRevision}` (1–500
characters). A local Ollama model on `127.0.0.1` only classifies the text into
these allowlisted intents; product code turns each intent into patch ops over
the head plan, skipping locked objects, and applies them as a `user` revision:

`captions_restrained`, `captions_energetic`, `captions_static`, `captions_top`,
`captions_bottom`, `music_quieter` and `music_louder` (±6 dB), `mute_music`,
`mute_sfx` (−60 dB), `remove_hook`, `remove_motion`, `remove_broll`.

The request text is sent to the model fenced as `<untrusted_data>`, and the
model's reply is never echoed. No Ollama model is `director_unavailable`; no
answer is `director_failed`; no matching change is `request_not_understood`,
whose remedy lists what can be asked. A stale `baseRevision` is
`stale_revision`.

## Agent skill

`packages/engine/skills/takeoff-agent/SKILL.md` is a portable skill for coding
agents: how to connect (MCP or CLI), the tool table, the clock rules, patch rules
and a working loop (inspect → propose → read QA and markers → inspect frames →
patch → re-render → export when no critical issue remains). It tells the agent to
treat transcript text, filenames and metadata as data. Its `set_crop` row says
`rect {x, y, w, h}`; the schema field names are `x`, `y`, `width`, `height`.

## Patches and revisions

A patch is `{schemaVersion: "1.0", baseRevision, ops}` with 1–200 allowlisted
ops. The ops and their fields are in [schema.md](schema.md#patch); what each one
does is in [timeline.md](timeline.md#patches).

```json
{ "schemaVersion": "1.0", "baseRevision": 3, "ops": [ { "op": "restore_span", "assetId": "a_1", "sourceStartUs": 1200000, "sourceEndUs": 1650000 } ] }
```

- **Base revision.** `baseRevision` must equal the current revision, or the edit
  fails as `stale_revision` (HTTP 409). Re-read the plan and rebuild the patch.
- **Locks.** Direct edits are `user` revisions. An op on a locked object fails as
  `locked_object` (HTTP 409). Regeneration and QA repairs never overwrite a lock.
- **Undo, redo, revert** create new revisions and take an optional
  `baseRevision` with the same check.
- **Pipeline revisions.** Edit Video and QA repairs commit `system` revisions.
- **Unknown ops and extra fields** are rejected by the schema (`invalid_patch`).

## Checks

```sh
node --test packages/engine/test/server.test.ts packages/engine/test/mcp.test.ts packages/engine/test/cli.test.ts
```

`server.test.ts` covers token, Host, Origin and body-size rejection, the
loopback address, 409 on a stale patch, Range and SSE. `mcp.test.ts` spawns
`bin/takeoff.js mcp`.
