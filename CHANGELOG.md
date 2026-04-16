# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-04-16

### Added

- **Initial release** — MCP server for dependency tracing in Haskell and ReScript codebases.
- **10 MCP tools** in 3 groups:
  - Indexing: `index_codebase`, `index_status`
  - Tracing: `trace_callees`, `trace_callers`, `trace_module_deps`, `impact_analysis`
  - Inspection: `get_symbol`, `get_module_symbols`, `search_symbols`, `get_test_context`
- **ReScript indexer** — pure TypeScript, no external binaries required:
  - Module-level dependency extraction from `.bs.js` ES import statements (ground truth from compiler output)
  - Function/component/type symbol extraction via regex on `.res` files
  - Reference extraction for `open`, qualified `Module.function` calls, JSX usage, and pipe operators
  - Resolves `@scope/package/...` aliases via monorepo workspace `package.json` files
  - Discovers source directories from `rescript.json` (or `bsconfig.json`)
- **Haskell indexer** — two-tier:
  - Source-parser fallback (always available): regex-based extraction of imports, type signatures, function/data/class declarations from `.hs` files
  - HIE-based indexer (opt-in via `HIE_READER_BIN`): scaffold for a Haskell helper binary that reads GHC `.hie` files for full type-checked call graphs
  - Module-to-file resolution from `package.yaml` source-dirs (or scans `src/`, `src-generated/`, `lib/`, `app/`, `test/`)
- **Pluggable storage backend** with priority cascade:
  - Auto-detect: tries `better-sqlite3` (native, ~5–10x faster for bulk ops) first, falls back to `sql.js` (WASM, zero native deps)
  - Override via `DEP_TRACER_BACKEND=native|wasm`
- **Graph traversal engine** using SQLite recursive CTEs with cycle detection and configurable depth (default 5, max 20).
- **Incremental indexing** — file mtime tracking; subsequent `index_codebase` calls only re-process changed files unless `force_full: true`.
- **Atomic transactions** — symbol/edge inserts wrapped in `BEGIN/COMMIT` for crash safety.
- **LLM-friendly output formatter** — groups results by depth, includes file paths with line numbers, summarizes node counts and files involved.
- **Configuration via environment variables**:
  - `DEP_TRACER_DB_PATH` — SQLite database path (default: `~/.dep-tracer/deps.db`)
  - `DEP_TRACER_BACKEND` — `wasm` (default), `native`, or unset (auto)
  - `HIE_READER_BIN` — path to compiled hie-reader binary for full Haskell HIE support
  - `DEP_TRACER_LOG_LEVEL` — `debug`, `info`, `warn`, `error`

### Known limitations

- Haskell function-level call edges require the `hie-reader` Haskell binary, which must be built with the same GHC major version that produced the project's `.hie` files. Without it, only module-level dependencies and top-level symbols are indexed.
- ReScript regex parser may miss deeply nested or PPX-transformed function bodies. `.bs.js` import parsing remains accurate regardless.
