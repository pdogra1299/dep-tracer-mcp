import type { Database } from '../db/database.js';
import { traceCallees, traceCallers, traceModuleDeps, analyzeImpact } from '../graph/traversal.js';
import { formatTraceResult, formatModuleDepResult, formatImpactResult } from '../graph/formatter.js';

export class QueryHandlers {
  constructor(private db: Database) {}

  async handleTraceCallees(args: {
    codebase: string; symbol: string; max_depth?: number;
    edge_kinds?: string[]; symbol_kinds?: string[];
  }) {
    const cb = this.db.getCodebase(args.codebase);
    if (!cb) return this.notFound(args.codebase);

    const result = traceCallees(this.db, cb.id, {
      codebase: args.codebase,
      symbol: args.symbol,
      maxDepth: args.max_depth ?? 5,
      edgeKinds: args.edge_kinds,
      symbolKinds: args.symbol_kinds,
    });

    return { content: [{ type: 'text' as const, text: formatTraceResult(result) }] };
  }

  async handleTraceCallers(args: {
    codebase: string; symbol: string; max_depth?: number;
    edge_kinds?: string[]; symbol_kinds?: string[];
  }) {
    const cb = this.db.getCodebase(args.codebase);
    if (!cb) return this.notFound(args.codebase);

    const result = traceCallers(this.db, cb.id, {
      codebase: args.codebase,
      symbol: args.symbol,
      maxDepth: args.max_depth ?? 5,
      edgeKinds: args.edge_kinds,
      symbolKinds: args.symbol_kinds,
    });

    return { content: [{ type: 'text' as const, text: formatTraceResult(result) }] };
  }

  async handleTraceModuleDeps(args: {
    codebase: string; file_path: string;
    direction?: 'imports' | 'imported_by' | 'both'; max_depth?: number;
  }) {
    const cb = this.db.getCodebase(args.codebase);
    if (!cb) return this.notFound(args.codebase);

    const result = traceModuleDeps(
      this.db, cb.id, args.file_path,
      args.direction ?? 'both', args.max_depth ?? 5,
    );

    return { content: [{ type: 'text' as const, text: formatModuleDepResult(result) }] };
  }

  async handleImpactAnalysis(args: {
    codebase: string; changed_files?: string[];
    changed_symbols?: string[]; max_depth?: number;
  }) {
    const cb = this.db.getCodebase(args.codebase);
    if (!cb) return this.notFound(args.codebase);

    const result = analyzeImpact(
      this.db, cb.id,
      args.changed_files ?? [],
      args.changed_symbols ?? [],
      args.max_depth ?? 5,
    );

    return { content: [{ type: 'text' as const, text: formatImpactResult(result) }] };
  }

  private notFound(name: string) {
    return {
      content: [{ type: 'text' as const, text: `Codebase "${name}" not found. Use index_codebase first.` }],
    };
  }
}
