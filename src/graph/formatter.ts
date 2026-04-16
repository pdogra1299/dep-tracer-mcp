import type { TraceResult, ModuleDepResult, ImpactResult, SymbolNode } from './traversal.js';

/**
 * Format graph results as LLM-friendly text.
 */

export function formatTraceResult(result: TraceResult): string {
  if (!result.root) {
    return `Symbol not found. Try search_symbols to find the correct qualified name.`;
  }

  const lines: string[] = [];
  const direction = result.direction === 'callees' ? 'depends on' : 'is depended on by';
  lines.push(`=== ${result.root.qualified} ${direction} ===`);
  lines.push(`Kind: ${result.root.kind}`);
  if (result.root.filePath) {
    const loc = result.root.lineStart ? `:${result.root.lineStart}` : '';
    lines.push(`File: ${result.root.filePath}${loc}`);
  }
  lines.push('');

  // Group nodes by depth
  const byDepth = new Map<number, SymbolNode[]>();
  for (const node of result.nodes) {
    if (node.depth === 0) continue; // skip root
    const arr = byDepth.get(node.depth) ?? [];
    arr.push(node);
    byDepth.set(node.depth, arr);
  }

  for (const [depth, nodes] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
    lines.push(`Depth ${depth} (${nodes.length} symbols):`);
    for (const node of nodes.slice(0, 50)) { // cap per-depth output
      const loc = node.filePath
        ? ` [${node.filePath}${node.lineStart ? ':' + node.lineStart : ''}]`
        : '';
      lines.push(`  ${node.kind === 'component' ? '<' : ''}${node.qualified} (${node.kind})${loc}`);
    }
    if (nodes.length > 50) {
      lines.push(`  ... and ${nodes.length - 50} more`);
    }
    lines.push('');
  }

  // Summary
  const totalNodes = result.nodes.length - 1; // exclude root
  const uniqueFiles = new Set(result.nodes.filter(n => n.filePath).map(n => n.filePath!));
  lines.push(`Summary: ${totalNodes} symbols across ${uniqueFiles.size} files, max depth ${result.maxDepthReached}`);

  if (uniqueFiles.size > 0 && uniqueFiles.size <= 20) {
    lines.push('');
    lines.push('Files involved:');
    for (const f of [...uniqueFiles].sort()) {
      lines.push(`  - ${f}`);
    }
  }

  return lines.join('\n');
}

export function formatModuleDepResult(result: ModuleDepResult): string {
  if (result.nodes.length === 0) {
    return `No module dependencies found for ${result.rootPath}.`;
  }

  const lines: string[] = [];
  lines.push(`=== Module dependencies for ${result.rootPath} ===`);
  lines.push('');

  const imports = result.nodes.filter(n => n.direction === 'imports' && n.depth > 0);
  const importedBy = result.nodes.filter(n => n.direction === 'imported_by' && n.depth > 0);

  if (imports.length > 0) {
    lines.push(`Imports (${imports.length} modules):`);
    const byDepth = groupByDepth(imports);
    for (const [depth, nodes] of byDepth) {
      for (const n of nodes) {
        lines.push(`${'  '.repeat(depth)}→ ${n.path}`);
      }
    }
    lines.push('');
  }

  if (importedBy.length > 0) {
    lines.push(`Imported by (${importedBy.length} modules):`);
    const byDepth = groupByDepth(importedBy);
    for (const [depth, nodes] of byDepth) {
      for (const n of nodes) {
        lines.push(`${'  '.repeat(depth)}← ${n.path}`);
      }
    }
    lines.push('');
  }

  lines.push(`Total: ${imports.length} imports, ${importedBy.length} importers`);
  return lines.join('\n');
}

export function formatImpactResult(result: ImpactResult): string {
  const lines: string[] = [];
  lines.push('=== Impact Analysis ===');
  lines.push('');

  lines.push(`Changed symbols (${result.changedSymbols.length}):`);
  for (const sym of result.changedSymbols.slice(0, 30)) {
    lines.push(`  - ${sym.qualified} (${sym.kind})`);
  }
  if (result.changedSymbols.length > 30) {
    lines.push(`  ... and ${result.changedSymbols.length - 30} more`);
  }
  lines.push('');

  lines.push(`Affected entry points (${result.affectedEntryPoints.length}):`);
  for (const ep of result.affectedEntryPoints.slice(0, 30)) {
    lines.push(`  - ${ep.qualified} (${ep.kind}, depth ${ep.depth})`);
  }
  if (result.affectedEntryPoints.length > 30) {
    lines.push(`  ... and ${result.affectedEntryPoints.length - 30} more`);
  }
  lines.push('');

  lines.push(`Affected files (${result.affectedFiles.length}):`);
  for (const f of result.affectedFiles.slice(0, 30)) {
    lines.push(`  - ${f}`);
  }
  if (result.affectedFiles.length > 30) {
    lines.push(`  ... and ${result.affectedFiles.length - 30} more`);
  }

  return lines.join('\n');
}

export function formatSymbolDetail(
  sym: { name: string; qualified: string; kind: string; line_start: number | null; line_end: number | null; exported: number; metadata: string | null },
  filePath: string,
  directCallees: Array<{ qualified: string; kind: string; edge_kind: string }>,
  directCallers: Array<{ qualified: string; kind: string; edge_kind: string }>,
): string {
  const lines: string[] = [];
  lines.push(`=== ${sym.qualified} ===`);
  lines.push(`Kind: ${sym.kind}`);
  lines.push(`File: ${filePath}${sym.line_start ? ':' + sym.line_start : ''}`);
  if (sym.line_end) lines.push(`Lines: ${sym.line_start}-${sym.line_end}`);
  lines.push(`Exported: ${sym.exported ? 'yes' : 'no'}`);
  if (sym.metadata) {
    try {
      const meta = JSON.parse(sym.metadata);
      if (meta.typeSignature) lines.push(`Type: ${meta.typeSignature}`);
    } catch { /* ignore */ }
  }
  lines.push('');

  if (directCallees.length > 0) {
    lines.push(`Direct dependencies (${directCallees.length}):`);
    for (const c of directCallees) {
      lines.push(`  → ${c.qualified} (${c.kind}) [${c.edge_kind}]`);
    }
    lines.push('');
  }

  if (directCallers.length > 0) {
    lines.push(`Direct callers (${directCallers.length}):`);
    for (const c of directCallers) {
      lines.push(`  ← ${c.qualified} (${c.kind}) [${c.edge_kind}]`);
    }
  }

  return lines.join('\n');
}

export function formatTestContext(
  sym: { name: string; qualified: string; kind: string },
  filePath: string,
  callees: TraceResult,
  callers: TraceResult,
): string {
  const lines: string[] = [];
  lines.push(`=== Test Context for ${sym.qualified} ===`);
  lines.push(`Kind: ${sym.kind}`);
  lines.push(`File: ${filePath}`);
  lines.push('');

  // What to mock (callees)
  const deps = callees.nodes.filter(n => n.depth > 0);
  if (deps.length > 0) {
    lines.push(`Dependencies to mock (${deps.length}):`);
    for (const d of deps) {
      const loc = d.filePath ? ` [${d.filePath}${d.lineStart ? ':' + d.lineStart : ''}]` : '';
      lines.push(`  - ${d.qualified} (${d.kind})${loc}`);
    }
    lines.push('');
  }

  // Usage examples (callers)
  const usage = callers.nodes.filter(n => n.depth > 0);
  if (usage.length > 0) {
    lines.push(`Usage examples / callers (${usage.length}):`);
    for (const u of usage) {
      const loc = u.filePath ? ` [${u.filePath}${u.lineStart ? ':' + u.lineStart : ''}]` : '';
      lines.push(`  - ${u.qualified} (${u.kind})${loc}`);
    }
    lines.push('');
  }

  // Files to read
  const allFiles = new Set<string>();
  if (filePath) allFiles.add(filePath);
  for (const n of [...deps, ...usage]) {
    if (n.filePath) allFiles.add(n.filePath);
  }
  lines.push(`Files involved (${allFiles.size}):`);
  for (const f of [...allFiles].sort()) {
    lines.push(`  - ${f}`);
  }

  return lines.join('\n');
}

// ── Helpers ─────────────────────────────────────────────────────────

function groupByDepth(nodes: Array<{ path: string; depth: number }>): Map<number, typeof nodes> {
  const map = new Map<number, typeof nodes>();
  for (const n of nodes) {
    const arr = map.get(n.depth) ?? [];
    arr.push(n);
    map.set(n.depth, arr);
  }
  return new Map([...map.entries()].sort((a, b) => a[0] - b[0]));
}
