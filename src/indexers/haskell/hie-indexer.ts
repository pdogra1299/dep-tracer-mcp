import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnAndStreamLines } from '../../utils/process.js';
import type { ParsedSymbol, ParsedEdge, ParsedModuleDep, SymbolKind } from '../types.js';
import { logger } from '../../utils/logger.js';

/**
 * Indexes Haskell codebases using the hie-reader binary.
 * hie-reader reads GHC .hie files and outputs NDJSON (one JSON line per module).
 *
 * If HIE_READER_BIN is not set, this indexer is skipped and the source-parser fallback is used.
 */

interface HieModuleOutput {
  module: string;
  srcFile: string;
  declarations: Array<{
    name: string;
    kind: string; // "function", "type", "class", "pattern", "value"
    lineStart: number;
    lineEnd?: number;
    exported: boolean;
    typeSignature?: string;
  }>;
  references: Array<{
    fromDecl: string;
    toModule: string;
    toName: string;
    line: number;
  }>;
  imports: Array<{
    module: string;
    qualified: boolean;
    alias?: string;
  }>;
}

export interface HieIndexResult {
  symbols: ParsedSymbol[];
  edges: ParsedEdge[];
  moduleDeps: ParsedModuleDep[];
  filesProcessed: string[]; // source file paths
}

/**
 * Find the .hie files directory. Looks in common locations within dist-newstyle.
 */
export function findHieDir(codebaseRoot: string, hint?: string): string | null {
  if (hint && existsSync(hint)) return hint;

  // Common patterns for cabal-built projects
  const candidates = [
    'dist-newstyle',
    '.hie',
  ];

  for (const candidate of candidates) {
    const dir = join(codebaseRoot, candidate);
    if (existsSync(dir)) return dir;
  }

  return null;
}

/**
 * Run hie-reader binary and parse its NDJSON output.
 */
export async function runHieReader(
  hieReaderBin: string,
  hieDir: string,
  codebaseRoot: string,
): Promise<HieIndexResult> {
  const symbols: ParsedSymbol[] = [];
  const edges: ParsedEdge[] = [];
  const moduleDeps: ParsedModuleDep[] = [];
  const filesProcessed: string[] = [];

  let moduleCount = 0;

  const exitCode = await spawnAndStreamLines(
    hieReaderBin,
    ['--hie-dir', hieDir, '--src-dir', codebaseRoot],
    (line) => {
      if (!line.trim()) return;
      try {
        const mod: HieModuleOutput = JSON.parse(line);
        moduleCount++;
        filesProcessed.push(mod.srcFile);

        // Convert declarations to symbols
        for (const decl of mod.declarations) {
          symbols.push({
            name: decl.name,
            qualified: `${mod.module}.${decl.name}`,
            kind: decl.kind as SymbolKind,
            lineStart: decl.lineStart,
            lineEnd: decl.lineEnd,
            exported: decl.exported,
            metadata: decl.typeSignature ? JSON.stringify({ typeSignature: decl.typeSignature }) : undefined,
          });
        }

        // Convert references to edges
        for (const ref of mod.references) {
          edges.push({
            sourceQualified: `${mod.module}.${ref.fromDecl}`,
            targetQualified: `${ref.toModule}.${ref.toName}`,
            kind: 'calls',
          });
        }

        // Convert imports to module deps
        for (const imp of mod.imports) {
          moduleDeps.push({
            sourceFilePath: mod.srcFile,
            targetFilePath: imp.module, // Will need to resolve module → file
            kind: imp.qualified ? 'import' : 'import',
          });
        }
      } catch (err) {
        logger.debug(`Failed to parse hie-reader line: ${line.substring(0, 100)}...`);
      }
    },
  );

  if (exitCode !== 0) {
    logger.warn(`hie-reader exited with code ${exitCode}`);
  }

  logger.info(`hie-indexer: processed ${moduleCount} modules, ${symbols.length} symbols, ${edges.length} edges`);
  return { symbols, edges, moduleDeps, filesProcessed };
}

/**
 * Check if hie-reader binary is available.
 */
export function getHieReaderBin(): string | null {
  const bin = process.env.HIE_READER_BIN;
  if (bin && existsSync(bin)) return bin;
  return null;
}
