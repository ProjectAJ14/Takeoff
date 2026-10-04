# Projects and jobs

`packages/project-store` holds a project's durable state: the plan revision
history, assets, the transcript cache, jobs, artifacts and an append-only event
log. The engine opens one store per project (see [engine.md](engine.md)); the
CLI, MCP server and HTTP API reach it only through the engine.

```ts
import { createProject, openProject } from '@takeoff/project-store';

const store = createProject('/path/to/MyReel', 'My reel');  // name: 1–200 chars
const snap = store.commitPlan(plan, store.currentRevision(), 'agent');
store.close();
```

## On-disk layout

| Path under the project root | Written by | Contents |
|---|---|---|
| `project.db` (+ `-wal`, `-shm`) | project-store | SQLite through `node:sqlite`, with `journal_mode=WAL`, `synchronous=FULL`, `busy_timeout=5000` and `foreign_keys=ON` |
| `media/originals/<sha256><ext>` | `@takeoff/media` `ingest` | Copies of sources that sit outside the project root |
| `media/derived/<sha256>/` | `@takeoff/media` `ingest` | `proxy.mp4`, `analysis.wav`, `master.wav`, `derived.json` (see [media.md](media.md)) |

`createProject` refuses a root that already contains `project.db`.
`openProject` refuses a root without one.

Tables in `project.db`:

| Table | Holds |
|---|---|
| `project` | A single row: id, name, schema version, head revision and plan hash |
| `assets` | One row per asset: the manifest JSON plus kind, hash and relative path |
| `transcripts` | Transcript cache keyed by `(source_hash, config_hash, model)` |
| `plan_revisions` | Every plan revision |
| `jobs` | Jobs and their checkpoints |
| `artifacts` | Job artifacts |
| `events` | The append-only event log |
| `settings` | Key → JSON value |
| `schema_migrations` | Applied migration versions |

## Revisions, undo, redo and revert

The history is never rewritten. Each of these calls appends a new revision:

| Call | New revision copies | `parent` (where undo goes) | `redo_target` |
|---|---|---|---|
| `commitPlan(plan, baseRevision, author)` | `plan` | The previous head (`null` at revision 0) | `null` |
| `undo(author, baseRevision?)` | The head's `parent` | That revision's `parent` | The old head |
| `redo(author, baseRevision?)` | The head's `redo_target` | That revision's `parent` | That revision's `redo_target` |
| `revertTo(revision, author, baseRevision?)` | `revision` | The old head | `null` |

Example: commit r1, then commit r2. Undo appends r3, a copy of r1's plan with
`redo_target` 2. Redo then appends r4, a copy of r2's plan. A new commit or a
revert clears redo.

- **Compare-and-set.** Every call runs inside `BEGIN IMMEDIATE`. If
  `baseRevision` is given and isn't the current head, the call throws
  `StaleRevisionError` (`expected`, `actual`). There is no last-write-wins.
- **Validation.** `commitPlan` validates against the `edit-plan` schema and
  refuses a plan with a different `projectId`. The stored plan's `revision` is
  overwritten with its row number. `plan_hash` is the SHA-256 of
  `canonicalJson(plan)`, which is JSON with sorted keys.
- **Authors** are `agent`, `user` or `system`. Only a `user` revision may
  change, unlock or drop an object that the head plan has `locked: true`. Any
  other author (commit, undo, redo or revert) must carry each locked object
  unchanged, or the call throws.
- `getPlan(revision?)`, `listRevisions()` and `currentRevision()` read history.

## Jobs

`createJob(request, dependsOn?)` takes a `create-job-request` and returns a
`job`. A job moves only along these edges:

| From | To |
|---|---|
| `queued` | `running`, `canceled` |
| `running` | `succeeded`, `failed`, `canceled`, `waiting_for_user`, `queued` |
| `waiting_for_user` | `running`, `canceled` |
| `failed` | `queued` |
| `succeeded`, `canceled` | (terminal) |

- **Idempotency.** `createJob` with an `idempotencyKey` that already exists
  returns the existing job unchanged. A `baseRevision` past the head, or an
  unknown dependency, is refused.
- **Transitions.** `transitionJob(id, to, {error})` enforces the table above.
  - `running` needs every dependency to have `succeeded`, and it increments
    `attempts`.
  - `failed` needs an `ErrorInfo` (`{code, message, remedy}`).
  - Moving to `queued` or `running` clears the error.
  - Every transition re-validates the job against the `job` schema inside the
    same transaction.
- **Running-only calls.** `setJobProgress(id, 0..1 | null)`,
  `addCheckpoint(id, name, ref)` and `addArtifact(id, kind, ref)` only work on a
  `running` job.
- **Hashing.** The store hashes checkpoint and artifact files from the bytes on
  disk; it never takes a hash from the caller. `.partial` files are refused.

### Recovery

After a crash, `recoverInterruptedJobs()` handles every job still in `running`:

- Artifacts whose file is missing or changed are dropped.
- The job returns to `queued` if it has at least one checkpoint and every
  checkpoint still verifies.
- Otherwise it becomes `failed` with error code `interrupted`
  ("Run the stage again.") and its checkpoints are cleared.
- Recovery never marks a job `succeeded`.

## Other records

- `importAsset(manifest)` validates an `asset-manifest`. The file must already
  exist under the project root at its `relativePath`.
- `putTranscript` / `getTranscript` store validated transcripts by source hash,
  config hash and model.
- `recordProviderReceipt(receipt)` validates a `provider-receipt` for this
  project and appends it as a `provider_receipt` event.
- `appendEvent` / `listEvents` work on the `events` table, where triggers reject
  UPDATE and DELETE. The store writes these event types: `asset_imported`,
  `plan_revision`, `job_created`, `job_state`, `job_recovered` and
  `provider_receipt`. Event data carries ids, revisions and hashes. It never
  carries transcripts, frames, prompts, paths or secrets.

## Migrations

Migrations are numbered SQL entries in `src/migrations.ts`. They are applied in
order inside one transaction and recorded in `schema_migrations`. They are
forward-only: a change appends a new entry and never edits an applied one. A
database whose version is newer than the app throws
`project schema N is newer than this app supports`. There is currently one
migration.

## Path rules

- Stored paths are project-relative and must match the contracts `relPath`
  pattern (see [schema.md](schema.md#shared-rules-commonschemajson)).
- `resolveUnderRoot(root, rel)` rejects:
  - empty, absolute, drive-letter, backslash or NUL paths;
  - any `..` segment;
  - any path whose deepest existing entry resolves through a symlink to
    somewhere outside the root;
  - a dangling symlink.
- `atomicWrite(path, data)` writes `<path>.<random>.partial`, fsyncs it, renames
  it, then fsyncs the directory. Readers never see a torn file.

## Checks

```sh
node --test "packages/project-store/test/**/*.test.ts"
```

The tests create projects in `fs.mkdtemp` directories. They include a
concurrent-writer test that uses a worker thread
(`test/commit-worker.ts`).
