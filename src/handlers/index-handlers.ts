import type { Database } from '../db/database.js';
import { ModuleResolver } from '../indexers/rescript/module-resolver.js';
import { indexBsJsFiles } from '../indexers/rescript/bs-js-indexer.js';
import { parseResFiles } from '../indexers/rescript/res-parser.js';
import { HaskellImportResolver } from '../indexers/haskell/import-resolver.js';
import { parseHsFiles } from '../indexers/haskell/source-parser.js';
import { getHieReaderBin, findHieDir, runHieReader } from '../indexers/haskell/hie-indexer.js';
import { detectChanges } from '../indexers/incremental.js';
import { logger } from '../utils/logger.js';

export class IndexHandlers {
  constructor(private db: Database) {}

  async handleIndexCodebase(args: {
    root_path: string;
    name: string;
    language: 'haskell' | 'rescript';
    force_full?: boolean;
    hie_dir?: string;
  }) {
    const startTime = Date.now();

    if (args.language === 'rescript') {
      return this.indexRescript(args.root_path, args.name, args.force_full ?? false);
    }

    if (args.language === 'haskell') {
      return this.indexHaskell(args.root_path, args.name, args.force_full ?? false, args.hie_dir);
    }

    return { content: [{ type: 'text' as const, text: `Unknown language: ${args.language}` }] };
  }

  private async indexRescript(rootPath: string, name: string, forceFull: boolean) {
    const startTime = Date.now();

    // 1. Load rescript.json config
    const config = await ModuleResolver.loadConfig(rootPath);

    // 2. Initialize module resolver
    const resolver = new ModuleResolver(rootPath, config);
    await resolver.initialize();

    // 3. Get all .res files
    const allResFiles = resolver.getAllResFiles();
    logger.info(`Found ${allResFiles.length} .res files`);

    // 4. Upsert codebase record
    const codebaseId = this.db.upsertCodebase(name, 'rescript', rootPath);

    // 5. Detect changed files
    const changes = detectChanges(rootPath, codebaseId, allResFiles, this.db, forceFull);

    if (changes.length === 0) {
      this.db.updateCodebaseStats(codebaseId);
      this.db.save();
      return {
        content: [{ type: 'text' as const, text: `"${name}" is up to date. No files changed.` }],
      };
    }

    const filesToProcess = changes.filter(c => c.status !== 'deleted').map(c => c.path);

    // 6. Index in a transaction for atomicity
    this.db.runInTransaction(() => {
      // Handle deleted files
      for (const change of changes) {
        if (change.status === 'deleted') {
          const file = this.db.getFile(codebaseId, change.path);
          if (file) {
            this.db.deleteFileData(file.id);
          }
        }
      }

      // Handle new/modified files: clear old data, re-index
      for (const change of changes) {
        if (change.status === 'modified') {
          const file = this.db.getFile(codebaseId, change.path);
          if (file) {
            this.db.deleteFileData(file.id);
          }
        }
      }

      // 7. Parse .res files for symbols and edges
      const parseResults = parseResFiles(filesToProcess, rootPath);

      // 8. Insert file records and symbols
      const fileIdMap = new Map<string, number>(); // path → file ID
      const symbolIdMap = new Map<string, number>(); // qualified name → symbol ID

      for (const change of changes) {
        if (change.status === 'deleted') continue;
        const fileId = this.db.upsertFile(codebaseId, change.path, change.mtimeMs);
        fileIdMap.set(change.path, fileId);
      }

      // Also ensure we have file IDs for already-indexed files (needed for edge resolution)
      for (const resFile of allResFiles) {
        if (!fileIdMap.has(resFile)) {
          const existing = this.db.getFile(codebaseId, resFile);
          if (existing) {
            fileIdMap.set(resFile, existing.id);
          }
        }
      }

      // Insert symbols from parsed .res files
      for (const [filePath, result] of parseResults) {
        const fileId = fileIdMap.get(filePath);
        if (!fileId) continue;

        for (const sym of result.symbols) {
          const symId = this.db.insertSymbol(
            codebaseId, fileId, sym.name, sym.qualified, sym.kind,
            sym.lineStart, sym.lineEnd, sym.exported, sym.metadata,
          );
          symbolIdMap.set(sym.qualified, symId);
        }
      }

      // Load existing symbols for edge resolution
      // (edges may reference symbols in files that weren't re-indexed)
      const allExistingSymbols = this.db.searchSymbols(codebaseId, '%', undefined, 999999);
      for (const sym of allExistingSymbols) {
        if (!symbolIdMap.has(sym.qualified)) {
          symbolIdMap.set(sym.qualified, sym.id);
        }
      }

      // 9. Insert function-level edges
      let edgesInserted = 0;
      for (const [_filePath, result] of parseResults) {
        for (const edge of result.edges) {
          const sourceId = symbolIdMap.get(edge.sourceQualified);
          const targetId = symbolIdMap.get(edge.targetQualified);
          if (sourceId && targetId) {
            this.db.insertEdge(sourceId, targetId, edge.kind);
            edgesInserted++;
          }
        }
      }

      // 10. Parse .bs.js files for module-level dependencies
      const moduleDeps = indexBsJsFiles(filesToProcess, rootPath, resolver);
      let moduleDepInserted = 0;
      for (const dep of moduleDeps) {
        const sourceFileId = fileIdMap.get(dep.sourceFilePath);
        const targetFileId = fileIdMap.get(dep.targetFilePath);
        if (sourceFileId && targetFileId) {
          this.db.insertModuleDep(sourceFileId, targetFileId, dep.kind);
          moduleDepInserted++;
        }
      }

      // 11. Update codebase stats
      this.db.updateCodebaseStats(codebaseId);

      logger.info(`Indexed: ${filesToProcess.length} files, ${edgesInserted} edges, ${moduleDepInserted} module deps`);
    });

    // 12. Save database (sql.js WASM → disk)
    this.db.save();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const cb = this.db.getCodebase(name)!;
    const edgeCount = this.db.getEdgeCount(cb.id);
    const moduleDepCount = this.db.getModuleDepCount(cb.id);

    const text = [
      `=== Indexed "${name}" (rescript) in ${elapsed}s ===`,
      `Files: ${cb.file_count}`,
      `Symbols: ${cb.symbol_count}`,
      `Edges: ${edgeCount}`,
      `Module deps: ${moduleDepCount}`,
      `Changed: ${changes.length} files (${changes.filter(c => c.status === 'new').length} new, ${changes.filter(c => c.status === 'modified').length} modified, ${changes.filter(c => c.status === 'deleted').length} deleted)`,
    ].join('\n');

    return { content: [{ type: 'text' as const, text }] };
  }

  private async indexHaskell(rootPath: string, name: string, forceFull: boolean, hieDir?: string) {
    const startTime = Date.now();

    // 1. Initialize import resolver
    const resolver = new HaskellImportResolver(rootPath);
    await resolver.initialize();

    const allHsFiles = resolver.getAllHsFiles();
    logger.info(`Found ${allHsFiles.length} .hs files`);

    // 2. Upsert codebase record
    const codebaseId = this.db.upsertCodebase(name, 'haskell', rootPath);

    // 3. Detect changed files
    const changes = detectChanges(rootPath, codebaseId, allHsFiles, this.db, forceFull);

    if (changes.length === 0) {
      this.db.updateCodebaseStats(codebaseId);
      this.db.save();
      return { content: [{ type: 'text' as const, text: `"${name}" is up to date. No files changed.` }] };
    }

    const filesToProcess = changes.filter(c => c.status !== 'deleted').map(c => c.path);

    // 4. Check if hie-reader is available for rich HIE-based indexing
    const hieReaderBin = getHieReaderBin();
    const resolvedHieDir = findHieDir(rootPath, hieDir);
    let usedHie = false;

    this.db.runInTransaction(() => {
      // Clear data for deleted/modified files
      for (const change of changes) {
        if (change.status === 'deleted' || change.status === 'modified') {
          const file = this.db.getFile(codebaseId, change.path);
          if (file) this.db.deleteFileData(file.id);
        }
      }

      // Insert file records
      const fileIdMap = new Map<string, number>();
      for (const change of changes) {
        if (change.status === 'deleted') continue;
        const fileId = this.db.upsertFile(codebaseId, change.path, change.mtimeMs);
        fileIdMap.set(change.path, fileId);
      }

      // Ensure we have file IDs for existing files
      for (const hsFile of allHsFiles) {
        if (!fileIdMap.has(hsFile)) {
          const existing = this.db.getFile(codebaseId, hsFile);
          if (existing) fileIdMap.set(hsFile, existing.id);
        }
      }

      // Use source-parser fallback (always available)
      const parseResults = parseHsFiles(filesToProcess, rootPath);

      const symbolIdMap = new Map<string, number>();

      for (const [filePath, result] of parseResults) {
        const fileId = fileIdMap.get(filePath);
        if (!fileId) continue;

        for (const sym of result.symbols) {
          const symId = this.db.insertSymbol(
            codebaseId, fileId, sym.name, sym.qualified, sym.kind,
            sym.lineStart, sym.lineEnd, sym.exported, sym.metadata,
          );
          symbolIdMap.set(sym.qualified, symId);
        }
      }

      // Load existing symbols for edge resolution
      const allExisting = this.db.searchSymbols(codebaseId, '%', undefined, 999999);
      for (const sym of allExisting) {
        if (!symbolIdMap.has(sym.qualified)) {
          symbolIdMap.set(sym.qualified, sym.id);
        }
      }

      // Insert edges from import analysis
      let edgesInserted = 0;
      for (const [_filePath, result] of parseResults) {
        for (const edge of result.edges) {
          const sourceId = symbolIdMap.get(edge.sourceQualified);
          const targetId = symbolIdMap.get(edge.targetQualified);
          if (sourceId && targetId) {
            this.db.insertEdge(sourceId, targetId, edge.kind);
            edgesInserted++;
          }
        }

        // Module-level dependencies from imports
        const fileId = fileIdMap.get(_filePath);
        if (fileId) {
          for (const imp of result.imports) {
            const targetFile = resolver.resolveModuleName(imp.module);
            if (targetFile) {
              const targetFileId = fileIdMap.get(targetFile);
              if (targetFileId) {
                this.db.insertModuleDep(fileId, targetFileId, 'import');
              }
            }
          }
        }
      }

      this.db.updateCodebaseStats(codebaseId);
      logger.info(`Indexed (source parser): ${filesToProcess.length} files, ${edgesInserted} edges`);
    });

    this.db.save();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const cb = this.db.getCodebase(name)!;
    const edgeCount = this.db.getEdgeCount(cb.id);
    const moduleDepCount = this.db.getModuleDepCount(cb.id);

    const method = usedHie ? 'hie-reader' : 'source-parser (fallback)';
    const text = [
      `=== Indexed "${name}" (haskell, ${method}) in ${elapsed}s ===`,
      `Files: ${cb.file_count}`,
      `Symbols: ${cb.symbol_count}`,
      `Edges: ${edgeCount}`,
      `Module deps: ${moduleDepCount}`,
      `Changed: ${changes.length} files`,
      hieReaderBin ? '' : 'Note: Set HIE_READER_BIN for richer type-level dependency tracing.',
    ].filter(Boolean).join('\n');

    return { content: [{ type: 'text' as const, text }] };
  }

  async handleIndexStatus(args: { name?: string }) {
    if (args.name) {
      const cb = this.db.getCodebase(args.name);
      if (!cb) {
        return { content: [{ type: 'text' as const, text: `Codebase "${args.name}" not found.` }] };
      }
      const edgeCount = this.db.getEdgeCount(cb.id);
      const moduleDepCount = this.db.getModuleDepCount(cb.id);
      const text = [
        `=== ${cb.name} (${cb.language}) ===`,
        `Root: ${cb.root_path}`,
        `Files: ${cb.file_count}`,
        `Symbols: ${cb.symbol_count}`,
        `Edges: ${edgeCount}`,
        `Module deps: ${moduleDepCount}`,
        `Last indexed: ${cb.indexed_at ?? 'never'}`,
      ].join('\n');
      return { content: [{ type: 'text' as const, text }] };
    }

    const all = this.db.getAllCodebases();
    if (all.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No codebases indexed yet. Use index_codebase to index one.' }] };
    }

    const lines = all.map(cb => {
      const edgeCount = this.db.getEdgeCount(cb.id);
      return `- ${cb.name} (${cb.language}): ${cb.file_count} files, ${cb.symbol_count} symbols, ${edgeCount} edges [${cb.indexed_at ?? 'never'}]`;
    });
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  }
}
