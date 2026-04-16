import type { Database } from '../db/database.js';
import { resolveSymbol, traceCallees, traceCallers } from '../graph/traversal.js';
import { formatSymbolDetail, formatTestContext, formatTraceResult } from '../graph/formatter.js';

export class InspectHandlers {
  constructor(private db: Database) {}

  async handleGetSymbol(args: { codebase: string; symbol: string }) {
    const cb = this.db.getCodebase(args.codebase);
    if (!cb) return this.notFound(args.codebase);

    const qualified = resolveSymbol(this.db, cb.id, args.symbol);
    if (!qualified) {
      return { content: [{ type: 'text' as const, text: `Symbol "${args.symbol}" not found in "${args.codebase}".` }] };
    }

    const sym = this.db.findSymbol(cb.id, qualified)!;
    const files = this.db.getFilesByCodebase(cb.id);
    const file = files.find(f => f.id === sym.file_id);
    const filePath = file?.path ?? 'unknown';

    const directCallees = this.db.getDirectCallees(sym.id);
    const directCallers = this.db.getDirectCallers(sym.id);

    const text = formatSymbolDetail(sym, filePath, directCallees, directCallers);
    return { content: [{ type: 'text' as const, text }] };
  }

  async handleGetModuleSymbols(args: {
    codebase: string; file_path: string;
    kinds?: string[]; exported_only?: boolean;
  }) {
    const cb = this.db.getCodebase(args.codebase);
    if (!cb) return this.notFound(args.codebase);

    const file = this.db.getFile(cb.id, args.file_path);
    if (!file) {
      return { content: [{ type: 'text' as const, text: `File "${args.file_path}" not found in "${args.codebase}".` }] };
    }

    let symbols = this.db.getSymbolsByFile(file.id, args.kinds);
    if (args.exported_only) {
      symbols = symbols.filter(s => s.exported === 1);
    }

    if (symbols.length === 0) {
      return { content: [{ type: 'text' as const, text: `No symbols found in ${args.file_path}.` }] };
    }

    const lines: string[] = [
      `=== Symbols in ${args.file_path} (${symbols.length}) ===`,
      '',
    ];

    for (const sym of symbols) {
      const loc = sym.line_start ? `:${sym.line_start}` : '';
      const exp = sym.exported ? '' : ' [internal]';
      lines.push(`  ${sym.kind.padEnd(10)} ${sym.qualified}${loc}${exp}`);
    }

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  }

  async handleSearchSymbols(args: {
    codebase: string; query: string;
    kinds?: string[]; limit?: number;
  }) {
    const cb = this.db.getCodebase(args.codebase);
    if (!cb) return this.notFound(args.codebase);

    const results = this.db.searchSymbols(cb.id, args.query, args.kinds, args.limit ?? 25);

    if (results.length === 0) {
      return { content: [{ type: 'text' as const, text: `No symbols matching "${args.query}" in "${args.codebase}".` }] };
    }

    const lines: string[] = [
      `=== Search: "${args.query}" (${results.length} results) ===`,
      '',
    ];

    for (const sym of results) {
      const loc = sym.line_start ? `:${sym.line_start}` : '';
      lines.push(`  ${sym.kind.padEnd(10)} ${sym.qualified} [${sym.file_path}${loc}]`);
    }

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  }

  async handleGetTestContext(args: {
    codebase: string; symbol: string;
    include_source?: boolean; callee_depth?: number; caller_depth?: number;
  }) {
    const cb = this.db.getCodebase(args.codebase);
    if (!cb) return this.notFound(args.codebase);

    const qualified = resolveSymbol(this.db, cb.id, args.symbol);
    if (!qualified) {
      return { content: [{ type: 'text' as const, text: `Symbol "${args.symbol}" not found in "${args.codebase}".` }] };
    }

    const sym = this.db.findSymbol(cb.id, qualified)!;
    const files = this.db.getFilesByCodebase(cb.id);
    const file = files.find(f => f.id === sym.file_id);
    const filePath = file?.path ?? 'unknown';

    const calleeResult = traceCallees(this.db, cb.id, {
      codebase: args.codebase,
      symbol: qualified,
      maxDepth: args.callee_depth ?? 2,
    });

    const callerResult = traceCallers(this.db, cb.id, {
      codebase: args.codebase,
      symbol: qualified,
      maxDepth: args.caller_depth ?? 1,
    });

    const text = formatTestContext(sym, filePath, calleeResult, callerResult);
    return { content: [{ type: 'text' as const, text }] };
  }

  private notFound(name: string) {
    return {
      content: [{ type: 'text' as const, text: `Codebase "${name}" not found. Use index_codebase first.` }],
    };
  }
}
