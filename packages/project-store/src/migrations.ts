// Forward-only. Append a new numbered entry; never edit or reorder an applied one.
export const migrations: readonly string[] = [
  /* 1 */ `
  CREATE TABLE project (
    id TEXT PRIMARY KEY,
    singleton INTEGER NOT NULL UNIQUE DEFAULT 1 CHECK (singleton = 1),
    name TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    plan_hash TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE assets (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    manifest TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE transcripts (
    source_hash TEXT NOT NULL,
    config_hash TEXT NOT NULL,
    model TEXT NOT NULL,
    transcript TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (source_hash, config_hash, model)
  );
  CREATE TABLE plan_revisions (
    revision INTEGER PRIMARY KEY CHECK (revision >= 1),
    plan TEXT NOT NULL,
    plan_hash TEXT NOT NULL,
    author TEXT NOT NULL CHECK (author IN ('agent', 'user', 'system')),
    op TEXT NOT NULL CHECK (op IN ('commit', 'undo', 'redo', 'revert')),
    parent INTEGER REFERENCES plan_revisions(revision),
    redo_target INTEGER REFERENCES plan_revisions(revision),
    created_at TEXT NOT NULL
  );
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    stage TEXT NOT NULL,
    profile TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'waiting_for_user', 'succeeded', 'failed', 'canceled')),
    base_revision INTEGER NOT NULL,
    depends_on TEXT NOT NULL DEFAULT '[]',
    progress REAL,
    attempts INTEGER NOT NULL DEFAULT 0,
    checkpoints TEXT NOT NULL DEFAULT '[]',
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE artifacts (
    job_id TEXT NOT NULL REFERENCES jobs(id),
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (job_id, path)
  );
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
  CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];
