-- Nexus D1 schema (P4 stage 1) — mapped from src/types/schema.ts per
-- docs/d1-migration.md. Applied with:
--   wrangler d1 execute nexus --local --file migrations/0001-schema.sql -y
-- (the e2e stack and `npm run dev` run this automatically; remote needs the
-- real database first: npx wrangler d1 create nexus, paste the id into
-- wrangler.jsonc, then same command with --remote).
--
-- The doc↔rows mapping lives in ONE module: src/server/d1/tables.ts (used by
-- both the Worker mirror and scripts/import-doc-to-d1.mjs — no drift).
--
-- Principles:
--   - The bucket keeps BYTES (media, script md files); D1 keeps STATE.
--   - Unknown doc fields land in `extra` JSON — never silently dropped.
--   - Soft deletes keep BOTH halves of {at, by} (deleted_at + deleted_by).
--   - Tombstones survive as `deletions` so the offline outbox can tell
--     "never existed" from "was deleted" (NOT EXISTS guard).
--   - settings live as one JSON row: they already merge whole-value.
--   - meta also carries 'ids' (doc.ids JSON), 'docStamps' ({updatedAt,
--     writerId}), 'studioSub' — doc-level fields with no table of their own.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- rows: 'schema', 'rev', 'settings' (JSON), 'studioSub'

CREATE TABLE IF NOT EXISTS groups (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  color       TEXT NOT NULL DEFAULT '',
  folder_id   TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  writer_id   TEXT NOT NULL DEFAULT 'unknown',
  deleted_at  TEXT,
  deleted_by  TEXT,
  archived_at TEXT,
  extra       TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS projects (
  id              TEXT PRIMARY KEY,
  group_id        TEXT NOT NULL REFERENCES groups(id),
  name            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  folder_id       TEXT,
  labels          TEXT NOT NULL DEFAULT '[]',
  assignee_app_id TEXT,
  due_at          TEXT,
  notes           TEXT NOT NULL DEFAULT '',
  approved_at     TEXT, -- P7 approval state ({at, by}, null = unapproved)
  approved_by     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  writer_id       TEXT NOT NULL DEFAULT 'unknown',
  deleted_at      TEXT,
  deleted_by      TEXT,
  archived_at     TEXT,
  extra           TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_projects_group ON projects(group_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

CREATE TABLE IF NOT EXISTS media_sections (
  project_id TEXT NOT NULL REFERENCES projects(id),
  id         TEXT NOT NULL,
  name       TEXT NOT NULL,
  sort       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, id)
);

-- The table that deletes linking.ts: "link an upload" = INSERT OR IGNORE.
CREATE TABLE IF NOT EXISTS project_files (
  project_id TEXT NOT NULL REFERENCES projects(id),
  file_key   TEXT NOT NULL,
  section_id TEXT,
  added_at   TEXT NOT NULL,
  added_by   TEXT NOT NULL DEFAULT 'unknown',
  PRIMARY KEY (project_id, file_key)
);
CREATE INDEX IF NOT EXISTS idx_project_files_section ON project_files(project_id, section_id);

CREATE TABLE IF NOT EXISTS scripts (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  project_id TEXT,
  status     TEXT NOT NULL DEFAULT 'draft',
  -- storage JSON: {"type":"inline","body":"…"} | {"type":"md","fileId":"…"} | drive-doc
  storage    TEXT NOT NULL DEFAULT '{"type":"inline","body":""}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  writer_id  TEXT NOT NULL DEFAULT 'unknown',
  deleted_at TEXT,
  deleted_by TEXT,
  archived_at TEXT,
  extra      TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_scripts_project ON scripts(project_id);

CREATE TABLE IF NOT EXISTS script_copies (
  script_id TEXT NOT NULL REFERENCES scripts(id),
  file_id   TEXT NOT NULL,
  label     TEXT NOT NULL,
  at        TEXT NOT NULL,
  PRIMARY KEY (script_id, file_id)
);

CREATE TABLE IF NOT EXISTS users_app (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','editor','viewer')),
  disabled      INTEGER NOT NULL DEFAULT 0,
  auth          TEXT NOT NULL, -- JSON {kind,hash[,salt,iterations]}
  session_epoch INTEGER,
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL DEFAULT 'bootstrap',
  updated_at    TEXT,
  writer_id     TEXT,
  extra         TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS viewers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  scope      TEXT NOT NULL DEFAULT '', -- P8: '' = whole workspace, else one project id
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'bootstrap',
  updated_at TEXT,
  writer_id  TEXT,
  extra      TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS upload_links (
  id            TEXT PRIMARY KEY,
  token_hash    TEXT NOT NULL,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  section_id    TEXT NOT NULL,
  max_file_bytes INTEGER NOT NULL,
  note          TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL DEFAULT '',
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT,
  updated_at    TEXT,
  writer_id     TEXT,
  extra         TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS refs (
  id         TEXT PRIMARY KEY,
  project_id TEXT,
  url        TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT,
  writer_id  TEXT,
  deleted_at TEXT,
  deleted_by TEXT,
  extra      TEXT NOT NULL DEFAULT '{}'
);

-- P7 project discussion — same shape as refs (per-entry LWW, soft delete);
-- FK like project_files: a project hard-delete takes its thread with it
-- (wireDiff emits comment dels child-first with the project's).
CREATE TABLE IF NOT EXISTS comments (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  body       TEXT NOT NULL,
  by         TEXT NOT NULL DEFAULT 'anonymous',
  created_at TEXT NOT NULL,
  updated_at TEXT,
  writer_id  TEXT,
  deleted_at TEXT,
  deleted_by TEXT,
  extra      TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_comments_project ON comments(project_id);

-- The activity ring becomes a table: newest-N reads are ORDER BY seq DESC.
CREATE TABLE IF NOT EXISTS activity (
  seq   INTEGER PRIMARY KEY AUTOINCREMENT,
  at    TEXT NOT NULL,
  actor TEXT NOT NULL,
  verb  TEXT NOT NULL,
  ref   TEXT NOT NULL,
  meta  TEXT NOT NULL DEFAULT '{}',
  -- canonical-JSON sha256 of the event: the mirror's set-dedup key. The doc
  -- ring is append+trim (and restores can move it backwards), so position
  -- alone never identifies an entry.
  h     TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_activity_at ON activity(at);

-- Tombstones: the offline outbox needs "never existed" vs "was deleted".
CREATE TABLE IF NOT EXISTS deletions (
  id   TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('group','project','script','user')),
  at   TEXT NOT NULL,
  by   TEXT NOT NULL,
  PRIMARY KEY (type, id)
);

-- Snapshot metadata (doc.snapshots[]) — stage 1 regen must reproduce the
-- whole doc; Time Travel (P10) retires the mechanism, not the data.
CREATE TABLE IF NOT EXISTS snapshots (
  file_id TEXT PRIMARY KEY,
  rev     INTEGER NOT NULL,
  at      TEXT NOT NULL,
  by      TEXT NOT NULL,
  note    TEXT NOT NULL DEFAULT ''
);

-- Client sync watermarks: one row per client writerId → its last-applied rev.
CREATE TABLE IF NOT EXISTS client_sync (
  writer_id TEXT PRIMARY KEY,
  last_rev  INTEGER NOT NULL DEFAULT 0,
  at        TEXT NOT NULL
);
