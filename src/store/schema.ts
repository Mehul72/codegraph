/**
 * The schema is versioned through SQLite's own user_version. Migrations are a
 * plain list: each entry moves the database up one version. There is no
 * downgrade path, because the index is disposable and `codegraph reindex
 * --force` is always available.
 */

export const SCHEMA_VERSION = 1;

const V1 = `
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Drives incremental indexing. One row per file we have looked at, including
-- files we chose not to parse, so we do not re-stat and re-read them forever.
CREATE TABLE files (
  path       TEXT PRIMARY KEY,
  hash       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  mtime_ms   INTEGER NOT NULL,
  lang       TEXT,
  indexed_at INTEGER NOT NULL
);

CREATE TABLE nodes (
  id         TEXT PRIMARY KEY,
  repo       TEXT NOT NULL,
  path       TEXT NOT NULL,
  name       TEXT NOT NULL,
  name_lower TEXT NOT NULL,
  qualified  TEXT,
  kind       TEXT NOT NULL,
  lang       TEXT NOT NULL,
  line_start INTEGER NOT NULL,
  line_end   INTEGER NOT NULL,
  signature  TEXT,
  doc        TEXT,
  exported   INTEGER NOT NULL DEFAULT 1,
  -- 1 for a stub copied in from a linked repo during cross-repo resolution.
  external   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX nodes_by_path       ON nodes(path);
CREATE INDEX nodes_by_name       ON nodes(name);
CREATE INDEX nodes_by_name_lower ON nodes(name_lower);
CREATE INDEX nodes_by_qualified  ON nodes(qualified);
CREATE INDEX nodes_by_kind       ON nodes(kind);

CREATE TABLE edges (
  eid        INTEGER PRIMARY KEY,
  src_id     TEXT NOT NULL,
  dst_id     TEXT NOT NULL,
  type       TEXT NOT NULL,
  confidence TEXT NOT NULL,
  path       TEXT NOT NULL,
  line       INTEGER NOT NULL,
  -- The ref that produced this edge, or NULL when the AST showed us both ends.
  rid        INTEGER
);
CREATE UNIQUE INDEX edges_identity ON edges(src_id, dst_id, type, path, line);
CREATE INDEX edges_by_src  ON edges(src_id);
CREATE INDEX edges_by_dst  ON edges(dst_id);
CREATE INDEX edges_by_path ON edges(path);
CREATE INDEX edges_by_rid  ON edges(rid);

-- References the extractor could not place on its own. Kept around after
-- resolution so an incremental pass can reconsider them without reparsing.
CREATE TABLE refs (
  rid         INTEGER PRIMARY KEY,
  src_id      TEXT NOT NULL,
  path        TEXT NOT NULL,
  line        INTEGER NOT NULL,
  type        TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  name        TEXT,
  qualifier   TEXT,
  module      TEXT,
  symbol      TEXT,
  alias       TEXT,
  lang        TEXT NOT NULL,
  resolved    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX refs_by_path     ON refs(path);
CREATE INDEX refs_by_name     ON refs(name);
CREATE INDEX refs_by_resolved ON refs(resolved);

-- What each file can be imported as. Written at extraction time because that
-- is the only moment we have the source in hand, and resolution needs it for
-- every single import without re-reading files.
CREATE TABLE modules (
  path     TEXT NOT NULL,
  family   TEXT NOT NULL,
  module   TEXT NOT NULL,
  -- 0 for the canonical path, 1 for a suffix or package-name alias.
  is_alias INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (path, module)
);
CREATE INDEX modules_by_module ON modules(module, family);
`;

export const MIGRATIONS: readonly string[] = [V1];
