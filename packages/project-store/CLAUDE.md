# packages/project-store

Owns a project's durable state: one SQLite database at `<projectRoot>/project.db`
(`node:sqlite`, WAL, `synchronous=FULL`, `busy_timeout=5000`), plan revision
history with undo/redo/revert, the job table and crash recovery, and the two
filesystem helpers every writer uses (`atomicWrite`, `resolveUnderRoot`).
PRD §5.4, §8 ProjectStore, §9.1, §13. Shapes come from `@takeoff/contracts`;
this package defines no plan, job or transcript type of its own.

## What lives here

| Path | Contents |
|---|---|
| `src/index.ts` | `createProject`, `openProject`, `ProjectStore`, `StaleRevisionError`, `canonicalJson` |
| `src/migrations.ts` | Numbered SQL migrations, applied in order and recorded in `schema_migrations` |
| `src/fs.ts` | `resolveUnderRoot(root, rel)`, `atomicWrite(path, data)` |
| `test/commit-worker.ts` | Worker thread used by the concurrent-writer test |

Tables: `project` (single row), `assets`, `transcripts` (cache keyed by
source hash + config hash + model), `plan_revisions`, `jobs`, `artifacts`,
`events` (append-only), `settings`.

## Invariants

- Migrations are forward-only. Append a new array entry; never edit or reorder an
  applied one. A database whose version is newer than the app refuses to open.
- `commitPlan(plan, baseRevision, author)` validates against the `edit-plan`
  schema and compares-and-sets inside `BEGIN IMMEDIATE`; a moved head throws
  `StaleRevisionError`. No last-write-wins.
- History is never rewritten. `undo`, `redo` and `revertTo` append a revision that
  copies an earlier plan. `parent` is where undo returns; `redo_target` is where
  redo goes; a new commit or revert clears redo.
- Locks: a revision authored by `agent` or `system` (commit, undo, redo or
  revert) must carry every object the head plan has `locked: true` unchanged,
  still locked and present. Only `user` revisions may edit or unlock them.
- The stored plan's `revision` equals its row; `plan_hash` is SHA-256 of
  `canonicalJson(plan)` (sorted keys).
- Jobs move only along `TRANSITIONS`. `running` needs every dependency
  `succeeded`; `failed` needs an `ErrorInfo`. Every transition and artifact
  write re-validates the job against the contracts `job` schema in the same
  transaction. `createJob` with a known
  idempotency key returns the existing job unchanged.
- Checkpoints and artifacts are hashed by the store from bytes on disk, never
  taken from the caller. `.partial` files are refused. Recovery re-verifies them:
  a `running` job returns to `queued` only if it has checkpoints that all verify,
  otherwise `failed`; unverified artifacts are dropped; recovery never sets
  `succeeded`.
- Paths are stored project-relative and must match the contracts `relPath` rule.
  `resolveUnderRoot` rejects absolute paths, `..`, backslashes and symlink escapes
  (realpath of the deepest existing entry; a dangling symlink is rejected).
- `events` rejects UPDATE and DELETE by trigger. Event data carries ids, revisions,
  hashes and receipts, never transcripts, frames, prompts, paths or secrets.

## Checks

```sh
node --test "packages/project-store/test/**/*.test.ts"
npx tsc -p tsconfig.json --noEmit 2>&1 | grep packages/project-store
```

Tests make projects in `fs.mkdtemp` directories and use contracts fixtures for
documents. A schema change here is a new migration plus a test that opens a
database created before it.
