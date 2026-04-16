import type { Database } from '../db/database.js';

export interface TraceOptions {
  codebase: string;
  symbol: string;
  maxDepth: number;
  edgeKinds?: string[];
  symbolKinds?: string[];
}

export interface SymbolNode {
  id: number;
  name: string;
  qualified: string;
  kind: string;
  depth: number;
  filePath?: string;
  lineStart?: number | null;
  lineEnd?: number | null;
}

export interface TraceResult {
  root: SymbolNode | null;
  nodes: SymbolNode[];
  direction: 'callees' | 'callers';
  maxDepthReached: number;
}

export interface ModuleDepResult {
  rootPath: string;
  nodes: Array<{ path: string; depth: number; direction: string }>;
}

export interface ImpactResult {
  changedSymbols: SymbolNode[];
  affectedEntryPoints: SymbolNode[];
  affectedFiles: string[];
}

/**
 * Resolve a symbol query to a qualified name.
 * Handles: exact qualified name, partial name, or pattern search.
 */
export function resolveSymbol(db: Database, codebaseId: number, query: string): string | null {
  // Try exact qualified match first
  const exact = db.findSymbol(codebaseId, query);
  if (exact) return exact.qualified;

  // Try name match (returns first match)
  const byName = db.findSymbolsByName(codebaseId, query);
  if (byName.length > 0) return byName[0].qualified;

  // Try search
  const searched = db.searchSymbols(codebaseId, query, undefined, 1);
  if (searched.length > 0) return searched[0].qualified;

  return null;
}

/**
 * Trace callees (outgoing dependencies).
 */
export function traceCallees(db: Database, codebaseId: number, opts: TraceOptions): TraceResult {
  const qualified = resolveSymbol(db, codebaseId, opts.symbol);
  if (!qualified) {
    return { root: null, nodes: [], direction: 'callees', maxDepthReached: 0 };
  }

  const rows = db.traceCallees(codebaseId, qualified, opts.maxDepth);
  const nodes = enrichNodes(db, codebaseId, rows, opts.symbolKinds);

  return {
    root: nodes.find(n => n.depth === 0) ?? null,
    nodes,
    direction: 'callees',
    maxDepthReached: Math.max(0, ...nodes.map(n => n.depth)),
  };
}

/**
 * Trace callers (incoming dependencies).
 */
export function traceCallers(db: Database, codebaseId: number, opts: TraceOptions): TraceResult {
  const qualified = resolveSymbol(db, codebaseId, opts.symbol);
  if (!qualified) {
    return { root: null, nodes: [], direction: 'callers', maxDepthReached: 0 };
  }

  const rows = db.traceCallers(codebaseId, qualified, opts.maxDepth);
  const nodes = enrichNodes(db, codebaseId, rows, opts.symbolKinds);

  return {
    root: nodes.find(n => n.depth === 0) ?? null,
    nodes,
    direction: 'callers',
    maxDepthReached: Math.max(0, ...nodes.map(n => n.depth)),
  };
}

/**
 * Trace module-level dependencies.
 */
export function traceModuleDeps(
  db: Database,
  codebaseId: number,
  filePath: string,
  direction: 'imports' | 'imported_by' | 'both',
  maxDepth: number,
): ModuleDepResult {
  const nodes = db.traceModuleDeps(codebaseId, filePath, direction, maxDepth);
  return { rootPath: filePath, nodes };
}

/**
 * Impact analysis: given changed files/symbols, find all affected entry points.
 */
export function analyzeImpact(
  db: Database,
  codebaseId: number,
  changedFiles: string[],
  changedSymbolQueries: string[],
  maxDepth: number,
): ImpactResult {
  const changedSymbols: SymbolNode[] = [];
  const seenIds = new Set<number>();

  // Collect symbols from changed files
  for (const filePath of changedFiles) {
    const file = db.getFile(codebaseId, filePath);
    if (!file) continue;
    const symbols = db.getSymbolsByFile(file.id);
    for (const sym of symbols) {
      if (!seenIds.has(sym.id)) {
        changedSymbols.push({
          id: sym.id, name: sym.name, qualified: sym.qualified,
          kind: sym.kind, depth: 0, lineStart: sym.line_start, lineEnd: sym.line_end,
        });
        seenIds.add(sym.id);
      }
    }
  }

  // Collect explicitly named changed symbols
  for (const query of changedSymbolQueries) {
    const qualified = resolveSymbol(db, codebaseId, query);
    if (!qualified) continue;
    const sym = db.findSymbol(codebaseId, qualified);
    if (sym && !seenIds.has(sym.id)) {
      changedSymbols.push({
        id: sym.id, name: sym.name, qualified: sym.qualified,
        kind: sym.kind, depth: 0, lineStart: sym.line_start, lineEnd: sym.line_end,
      });
      seenIds.add(sym.id);
    }
  }

  // Trace callers for each changed symbol to find entry points
  const affectedEntryPoints: SymbolNode[] = [];
  const affectedFileSet = new Set<string>();
  const seenEntryIds = new Set<number>();

  for (const sym of changedSymbols) {
    const callerResult = db.traceCallers(codebaseId, sym.qualified, maxDepth);
    for (const caller of callerResult) {
      if (caller.depth > 0 && !seenEntryIds.has(caller.id)) {
        // Check if this is a "leaf" in the caller tree (no further callers = entry point)
        const furtherCallers = db.getDirectCallers(caller.id);
        if (furtherCallers.length === 0 || caller.depth === maxDepth) {
          affectedEntryPoints.push({
            id: caller.id, name: caller.name, qualified: caller.qualified,
            kind: caller.kind, depth: caller.depth,
          });
          seenEntryIds.add(caller.id);
        }
      }
    }
  }

  // Collect affected file paths
  for (const ep of [...changedSymbols, ...affectedEntryPoints]) {
    const sym = db.findSymbol(codebaseId, ep.qualified);
    if (sym) {
      const files = db.getFilesByCodebase(codebaseId);
      const file = files.find(f => f.id === sym.file_id);
      if (file) affectedFileSet.add(file.path);
    }
  }

  return {
    changedSymbols,
    affectedEntryPoints,
    affectedFiles: Array.from(affectedFileSet).sort(),
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

function enrichNodes(
  db: Database,
  codebaseId: number,
  rows: Array<{ id: number; name: string; qualified: string; kind: string; depth: number }>,
  symbolKinds?: string[],
): SymbolNode[] {
  const nodes: SymbolNode[] = [];

  for (const row of rows) {
    if (symbolKinds && symbolKinds.length > 0 && !symbolKinds.includes(row.kind)) continue;

    const sym = db.findSymbol(codebaseId, row.qualified);
    let filePath: string | undefined;
    if (sym) {
      const files = db.getFilesByCodebase(codebaseId);
      const file = files.find(f => f.id === sym.file_id);
      filePath = file?.path;
    }

    nodes.push({
      id: row.id,
      name: row.name,
      qualified: row.qualified,
      kind: row.kind,
      depth: row.depth,
      filePath,
      lineStart: sym?.line_start,
      lineEnd: sym?.line_end,
    });
  }

  return nodes;
}
