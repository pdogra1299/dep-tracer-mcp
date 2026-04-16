# Dependency Tracer MCP Server

[![npm version](https://badge.fury.io/js/@nexus2520%2Fdep-tracer-mcp-server.svg)](https://www.npmjs.com/package/@nexus2520/dep-tracer-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

An MCP (Model Context Protocol) server that maps function and component dependencies in **Haskell** and **ReScript** codebases — built to help LLMs trace affected code flows for accurate test generation, change-impact analysis, and code understanding.

When you ask an LLM "what tests do I need to update if I change function X?" or "what should I mock to test this component?", this MCP gives it a real dependency graph instead of guessing.

## Features

### Available Tools (10 total)

#### Indexing (`indexing`)
- `index_codebase` — Index a Haskell or ReScript codebase. Incremental by default (only changed files); pass `force_full: true` to re-index everything.
- `index_status` — Show file count, symbol count, edge count, and last-indexed timestamp for one or all indexed codebases.

#### Tracing (`tracing`)
- `trace_callees` — What does function/component X depend on? (outgoing edges, recursive). Use to answer *"what should I mock to test X?"* or *"what's the full flow from this endpoint to the database?"*.
- `trace_callers` — What depends on X? (incoming edges, recursive). Use to answer *"I changed X, what tests need updating?"* or *"what entry points reach this code?"*.
- `trace_module_deps` — File/module-level dependency graph (coarser, always available even without HIE for Haskell).
- `impact_analysis` — Given changed files or symbols, find every affected entry point and downstream consumer.

#### Inspection (`inspection`)
- `get_symbol` — Full detail on one symbol: file location, type signature (when available), direct callees, direct callers.
- `get_module_symbols` — List all symbols defined in a file with kinds (`function`, `type`, `component`, `module`, `value`, `class`).
- `search_symbols` — Search by name pattern across the codebase. Supports partial match and `*` wildcards.
- `get_test_context` — Composite tool that returns everything needed to write tests for a symbol: the symbol itself, dependencies to mock, callers as usage examples, and the full set of files involved.

## Why this exists

Most code-analysis MCPs target mainstream languages (TypeScript, Python, Go) via tree-sitter. Haskell and ReScript have fundamentally different dependency models:

- **Haskell**: type-class polymorphism, custom preludes, plugins (RecordDot, large-records), and code-generation pipelines mean tree-sitter alone misses too much. Real dependency info lives in GHC's `.hie` files.
- **ReScript**: the compiler emits clean ES module `.bs.js` files alongside source. Those imports are the ground truth for module dependencies — far more reliable than parsing `open` statements.

This server exploits both: `.bs.js` imports for ReScript module graphs, regex on `.res` for function-level edges, regex on `.hs` for Haskell symbols, and (optionally) a small Haskell helper binary that reads `.hie` files for full type-checked Haskell call graphs.

## Installation

### Via npx (recommended for MCP usage)

No install needed — Claude/MCP runs it on demand:

```json
{
  "mcpServers": {
    "dep-tracer": {
      "command": "npx",
      "args": ["-y", "@nexus2520/dep-tracer-mcp-server"]
    }
  }
}
```

### Via npm (global install)

```bash
npm install -g @nexus2520/dep-tracer-mcp-server
```

Then point your MCP config at the installed binary:

```json
{
  "mcpServers": {
    "dep-tracer": {
      "command": "dep-tracer-mcp-server"
    }
  }
}
```

### From source

```bash
git clone https://github.com/pdogra1299/dep-tracer-mcp.git
cd dep-tracer-mcp
npm install
npm run build
```

Then reference the built binary:

```json
{
  "mcpServers": {
    "dep-tracer": {
      "command": "node",
      "args": ["/absolute/path/to/dep-tracer-mcp/build/index.js"]
    }
  }
}
```

## Configuration

All configuration is via environment variables — no config files.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DEP_TRACER_DB_PATH` | No | `~/.dep-tracer/deps.db` | SQLite database path. Set to a project-relative path (e.g. `.dep-tracer/index.db`) for per-project isolation. |
| `DEP_TRACER_BACKEND` | No | auto | Storage backend: `native` (better-sqlite3), `wasm` (sql.js), or unset (auto: native first, fall back to wasm). |
| `HIE_READER_BIN` | No | (none) | Path to the compiled `hie-reader` Haskell binary. Without it, Haskell indexing falls back to source parsing. |
| `DEP_TRACER_LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, `error`. All logs go to stderr (stdout is reserved for MCP stdio). |

### Storage backend selection

By default the server tries `better-sqlite3` (native, ~5–10× faster for bulk inserts). If the native module isn't installed or fails to load (no C++ toolchain), it transparently falls back to `sql.js` (WASM, pure JS, always works). You'll see one of these log lines on startup:

```
[INFO] Storage backend: better-sqlite3 (native)
[INFO] Storage backend: sql.js (WASM)
```

Force a backend explicitly with `DEP_TRACER_BACKEND=native` or `DEP_TRACER_BACKEND=wasm`.

### Per-project vs shared database

The default DB path is global (`~/.dep-tracer/deps.db`), which means all indexed codebases live in one database. This is convenient for cross-codebase queries but means `index_status` shows everything you've ever indexed.

For per-project isolation, set the path to something inside your project:

```json
{
  "mcpServers": {
    "dep-tracer": {
      "command": "npx",
      "args": ["-y", "@nexus2520/dep-tracer-mcp-server"],
      "env": {
        "DEP_TRACER_DB_PATH": ".dep-tracer/index.db"
      }
    }
  }
}
```

Add `.dep-tracer/` to your project's `.gitignore` (or commit it for shareable indexes).

## Usage

### Quick start

After adding the MCP server to your Claude config, in any Claude session:

```
Use index_codebase to index this directory.
  root_path = /absolute/path/to/my-project
  name = "my-project"
  language = "rescript"   (or "haskell")
```

The first index is full; subsequent calls are incremental (only re-process changed files based on mtime).

### Example queries

Once indexed, ask Claude things like:

- *"Use search_symbols to find all functions matching `*Auth*` in my-project."*
- *"Use trace_callees on `MyComponent.make` with depth 2 to show what it depends on."*
- *"Use impact_analysis with `changed_files: ['src/utils/Helpers.res']` to show what would break."*
- *"Use get_test_context on `Server.handleLogin` so I can write tests for it."*

The LLM gets back a structured graph with file paths and line numbers — accurate context for generating tests, refactoring, or explaining code.

## Haskell HIE Support (advanced)

The default Haskell indexer uses regex-based source parsing — it extracts module names, imports, type signatures, and top-level symbols. It does **not** capture function-level call edges (which require GHC's type checker output).

For full type-checked call graphs, build the bundled `hie-reader` Haskell binary and point `HIE_READER_BIN` at it.

### Requirements

- The same GHC major version that produced your project's `.hie` files (HIE files are not portable across GHC majors).
- Either Nix or `cabal-install` with a matching GHC in PATH.

### Build with Nix (recommended)

```bash
cd helpers/hie-reader
# Edit flake.nix to set the matching ghcXYZ package (e.g. ghc928, ghc945, ghc964, ghc982)
nix build
# binary is at ./result/bin/hie-reader
```

### Build with Cabal

```bash
cd helpers/hie-reader
cabal build
# Find the binary path with: cabal list-bin hie-reader
```

### Configure

```json
{
  "mcpServers": {
    "dep-tracer": {
      "command": "npx",
      "args": ["-y", "@nexus2520/dep-tracer-mcp-server"],
      "env": {
        "HIE_READER_BIN": "/absolute/path/to/hie-reader"
      }
    }
  }
}
```

## How it works

### ReScript indexing pipeline

1. Read `rescript.json` (or `bsconfig.json`) from the project root.
2. Discover source directories from the `sources` field (`src/`, `app/`, `packages/<name>/src/`, …).
3. Resolve workspace package aliases (`@scope/pkg`) by scanning each workspace's `package.json` `name` field.
4. Walk all `.res` files; for each:
   - **Module deps**: parse the co-located `.bs.js` file's ES `import` statements. This is the compiler's authoritative output.
   - **Symbols**: regex-extract `let`, `@react.component`, `type`, `module` definitions.
   - **Edges**: scan within each function's line range for `open`, `Module.func` calls, JSX `<Component>`, and `->` pipe references.
5. Insert into SQLite under a single transaction.

### Haskell indexing pipeline

1. Read `package.yaml` to find source directories (or scan common locations: `src/`, `src-generated/`, `lib/`, `app/`, `test/`).
2. Walk all `.hs` files; for each:
   - Extract module declaration, imports (qualified, aliased, with explicit lists).
   - Extract type signatures, data/type/newtype/class declarations, top-level function definitions.
3. If `HIE_READER_BIN` is set, additionally spawn the binary which streams NDJSON containing full type-checked call graphs.
4. Insert into SQLite under a single transaction.

### Graph traversal

All graph queries (`trace_callees`, `trace_callers`, `trace_module_deps`) use SQLite recursive CTEs with depth limiting (default 5, max 20) and cycle detection via path accumulation. This is fast and consistent across both backends.

## Development

```bash
npm install
npm run build      # tsc + chmod
npm run dev        # tsc --watch
npm test           # vitest
npm run test:watch # vitest watch
```

The MCP server entry point is `src/index.ts`. Source layout:

- `src/db/` — Storage backends (sql.js, better-sqlite3) + schema + Database class
- `src/indexers/rescript/` — ReScript module resolver, `.bs.js` import parser, `.res` regex parser
- `src/indexers/haskell/` — Import resolver, source parser (regex), HIE indexer (spawns helper binary)
- `src/graph/` — Recursive CTE traversal + LLM output formatter
- `src/handlers/` — MCP tool handlers grouped by domain (index, query, inspect)
- `src/tools/definitions.ts` — All 10 tool definitions (zod schemas)
- `helpers/hie-reader/` — Standalone Haskell helper binary (separate Cabal/Nix build)

## License

MIT — see [LICENSE](./LICENSE).
