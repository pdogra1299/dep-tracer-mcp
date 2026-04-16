import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { ModuleResolver } from './module-resolver.js';
import type { ParsedModuleDep } from '../types.js';
import { logger } from '../../utils/logger.js';

/**
 * Parses .bs.js files (ReScript compiler output) to extract module-level dependencies.
 * These ES import statements are the ground truth for the dependency graph.
 *
 * Example .bs.js imports:
 *   import * as MyUtil from "@scope/pkg/src/MyUtil.bs.js";  ← workspace package import
 *   import * as Helper from "../../utils/Helper.bs.js";      ← relative import
 *   import * as React from "react";                          ← skip (external)
 *   import * as Stdlib_List from "@rescript/runtime/...";    ← skip (runtime)
 */

// Matches: import * as Name from "path"
// Also matches: import { Name } from "path" and import Name from "path"
const IMPORT_RE = /^import\s+(?:\*\s+as\s+\w+|{\s*[^}]+\s*}|\w+)\s+from\s+["']([^"']+)["']/gm;

export interface BsJsImport {
  importPath: string;       // raw import path from .bs.js
  resolvedResPath: string;  // resolved to .res file path relative to codebase root
}

/**
 * Parse a single .bs.js file and extract all internal dependencies.
 */
export function parseBsJsImports(
  bsJsContent: string,
  sourceResFile: string,
  resolver: ModuleResolver,
): BsJsImport[] {
  const imports: BsJsImport[] = [];
  let match: RegExpExecArray | null;

  // Reset regex state
  IMPORT_RE.lastIndex = 0;

  while ((match = IMPORT_RE.exec(bsJsContent)) !== null) {
    const importPath = match[1];

    // Skip external imports
    if (isExternalImport(importPath)) continue;

    const resolvedResPath = resolver.resolveImportPath(importPath, sourceResFile);
    if (resolvedResPath) {
      imports.push({ importPath, resolvedResPath });
    }
  }

  return imports;
}

function isExternalImport(path: string): boolean {
  // Skip: react, react/jsx-runtime, @rescript/runtime/*, @rescript/react/*
  if (path === 'react' || path.startsWith('react/')) return true;
  if (path.startsWith('@rescript/')) return true;
  // Skip non-.bs.js imports (pure JS libraries)
  if (!path.endsWith('.bs.js')) return true;
  return false;
}

/**
 * Index all .bs.js files in the codebase and extract module dependencies.
 */
export function indexBsJsFiles(
  resFiles: string[],
  codebaseRoot: string,
  resolver: ModuleResolver,
): ParsedModuleDep[] {
  const deps: ParsedModuleDep[] = [];
  let processed = 0;
  let skipped = 0;

  for (const resFile of resFiles) {
    const bsJsFile = resFile.replace(/\.res$/, '.bs.js');
    const fullBsJsPath = join(codebaseRoot, bsJsFile);

    if (!existsSync(fullBsJsPath)) {
      skipped++;
      continue;
    }

    let content: string;
    try {
      content = readFileSync(fullBsJsPath, 'utf8');
    } catch {
      skipped++;
      continue;
    }

    const imports = parseBsJsImports(content, resFile, resolver);

    for (const imp of imports) {
      deps.push({
        sourceFilePath: resFile,
        targetFilePath: imp.resolvedResPath,
        kind: 'import',
      });
    }

    processed++;
  }

  logger.info(`bs-js-indexer: processed ${processed} files, skipped ${skipped}, found ${deps.length} module deps`);
  return deps;
}
