/**
 * SQLite schema for the dependency tracer.
 * 6 tables: codebases, files, symbols, edges, module_deps, schema_version.
 */

export const SCHEMA_VERSION = 1;

export const CREATE_TABLES = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS codebases (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  language    TEXT NOT NULL CHECK(language IN ('haskell', 'rescript')),
  root_path   TEXT NOT NULL,
  indexed_at  TEXT,
  file_count  INTEGER DEFAULT 0,
  symbol_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  codebase_id INTEGER NOT NULL REFERENCES codebases(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  mtime_ms    INTEGER NOT NULL,
  indexed_at  TEXT NOT NULL,
  UNIQUE(codebase_id, path)
);

CREATE TABLE IF NOT EXISTS symbols (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  codebase_id INTEGER NOT NULL REFERENCES codebases(id) ON DELETE CASCADE,
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  qualified   TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK(kind IN ('function','type','class','module','component','value','pattern')),
  line_start  INTEGER,
  line_end    INTEGER,
  exported    INTEGER DEFAULT 1,
  metadata    TEXT
);

CREATE TABLE IF NOT EXISTS edges (
  source_id   INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  target_id   INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK(kind IN ('calls','imports','uses_type','instantiates','opens','inherits')),
  UNIQUE(source_id, target_id, kind)
);

CREATE TABLE IF NOT EXISTS module_deps (
  source_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  target_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  dep_kind    TEXT NOT NULL CHECK(dep_kind IN ('import','open','qualified_use')),
  UNIQUE(source_file_id, target_file_id, dep_kind)
);

-- Indexes for query performance
CREATE INDEX IF NOT EXISTS idx_symbols_qualified ON symbols(qualified);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_symbols_codebase_kind ON symbols(codebase_id, kind);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
CREATE INDEX IF NOT EXISTS idx_module_deps_source ON module_deps(source_file_id);
CREATE INDEX IF NOT EXISTS idx_module_deps_target ON module_deps(target_file_id);
CREATE INDEX IF NOT EXISTS idx_files_codebase_path ON files(codebase_id, path);
`;
