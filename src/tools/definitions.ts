import { z } from 'zod';

/**
 * All 10 MCP tool definitions for the dependency tracer.
 * Grouped: indexing (2), tracing (4), inspection (4).
 */

// ── Shared schema fragments ───────────────────────────────────────────

const codebaseParam = z.string().describe('Codebase name (the name you used when calling index_codebase)');
const symbolParam = z.string().describe('Fully qualified symbol name or partial name for search');
const maxDepthParam = z.number().min(1).max(20).default(5).describe('Maximum traversal depth (default: 5, max: 20)');
const symbolKindsParam = z.array(
  z.enum(['function', 'type', 'class', 'module', 'component', 'value', 'pattern'])
).optional().describe('Filter by symbol kind');
const edgeKindsParam = z.array(
  z.enum(['calls', 'imports', 'uses_type', 'instantiates', 'opens', 'inherits'])
).optional().describe('Filter by edge kind');

// ── Tool definitions ──────────────────────────────────────────────────

export const toolDefs = {
  // ── INDEXING ─────────────────────────────────────────────────────────

  index_codebase: {
    description:
      'Index a codebase to build the dependency graph. Supports Haskell and ReScript. ' +
      'Performs incremental indexing (only changed files) unless force_full is set. ' +
      'For Haskell, optionally uses hie-reader binary for rich type info; falls back to source parsing.',
    schema: {
      root_path: z.string().describe('Absolute path to the codebase root directory'),
      name: z.string().describe('Name for this codebase (used in all subsequent queries)'),
      language: z.enum(['haskell', 'rescript']).describe('Programming language'),
      force_full: z.boolean().default(false).describe('Force full re-index, ignoring mtime cache'),
      hie_dir: z.string().optional().describe('[Haskell only] Path to .hie files directory. If omitted, searches dist-newstyle/'),
    },
  },

  index_status: {
    description:
      'Get indexing status for all codebases or a specific one. ' +
      'Shows file count, symbol count, edge count, last indexed time.',
    schema: {
      name: z.string().optional().describe('Codebase name (optional, shows all if omitted)'),
    },
  },

  // ── TRACING ──────────────────────────────────────────────────────────

  trace_callees: {
    description:
      'Trace what a function/component depends on (outgoing edges). ' +
      'Shows all functions called, types used, and components rendered. ' +
      'Use this to answer: "What do I need to mock to test function X?" or ' +
      '"What is the full flow from this endpoint to the database?"',
    schema: {
      codebase: codebaseParam,
      symbol: symbolParam,
      max_depth: maxDepthParam,
      edge_kinds: edgeKindsParam,
      symbol_kinds: symbolKindsParam,
    },
  },

  trace_callers: {
    description:
      'Trace what depends on a function/component (incoming edges). ' +
      'Shows all callers, importers, and parent components. ' +
      'Use this to answer: "I changed function X, what tests need updating?" or ' +
      '"What entry points reach this code?"',
    schema: {
      codebase: codebaseParam,
      symbol: symbolParam,
      max_depth: maxDepthParam,
      edge_kinds: edgeKindsParam,
      symbol_kinds: symbolKindsParam,
    },
  },

  trace_module_deps: {
    description:
      'Trace module-level dependencies (coarser but always available). ' +
      'Shows which files/modules depend on which.',
    schema: {
      codebase: codebaseParam,
      file_path: z.string().describe('File path relative to codebase root'),
      direction: z.enum(['imports', 'imported_by', 'both']).default('both').describe('Direction of trace'),
      max_depth: maxDepthParam,
    },
  },

  impact_analysis: {
    description:
      'Given changed files or symbols, determine the full impact: ' +
      'what tests might break, what entry points are affected, what downstream consumers exist.',
    schema: {
      codebase: codebaseParam,
      changed_files: z.array(z.string()).optional().describe('Changed file paths (relative to codebase root)'),
      changed_symbols: z.array(z.string()).optional().describe('Changed symbol names (qualified or partial)'),
      max_depth: maxDepthParam,
    },
  },

  // ── INSPECTION ───────────────────────────────────────────────────────

  get_symbol: {
    description:
      'Get detailed information about a specific symbol: definition location, type signature, ' +
      'direct callees, and direct callers.',
    schema: {
      codebase: codebaseParam,
      symbol: symbolParam,
    },
  },

  get_module_symbols: {
    description:
      'List all symbols defined in a module/file: functions, types, components, exports.',
    schema: {
      codebase: codebaseParam,
      file_path: z.string().describe('File path relative to codebase root'),
      kinds: symbolKindsParam,
      exported_only: z.boolean().default(false).describe('Only show exported symbols'),
    },
  },

  search_symbols: {
    description:
      'Search for symbols by name pattern. Supports partial matching and * wildcards. ' +
      'Use when you know a function name but not its full module path.',
    schema: {
      codebase: codebaseParam,
      query: z.string().describe('Search query: partial name, glob pattern (e.g., "*.Authentication.*"), or exact qualified name'),
      kinds: symbolKindsParam,
      limit: z.number().min(1).max(100).default(25).describe('Max results'),
    },
  },

  get_test_context: {
    description:
      'Get everything needed to write tests for a function or module: ' +
      'the function itself, all its direct dependencies (what to mock), ' +
      'all its callers (usage examples), type definitions it uses, ' +
      'and file paths for all involved code.',
    schema: {
      codebase: codebaseParam,
      symbol: symbolParam,
      include_source: z.boolean().default(true).describe('Include source code snippets'),
      callee_depth: z.number().min(1).max(10).default(2).describe('How deep to trace callees'),
      caller_depth: z.number().min(1).max(10).default(1).describe('How deep to trace callers'),
    },
  },
} as const;
