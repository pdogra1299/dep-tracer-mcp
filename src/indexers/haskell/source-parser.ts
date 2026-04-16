import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ParsedSymbol, ParsedEdge, ParsedModuleDep, SymbolKind } from '../types.js';
import { logger } from '../../utils/logger.js';

/**
 * Regex-based parser for .hs files (fallback when hie-reader is not available).
 *
 * Extracts:
 * - Module declaration
 * - Import statements (qualified, as, hiding)
 * - Type signatures
 * - Function definitions
 * - Type/data/newtype/class declarations
 */

export interface HsParseResult {
  moduleName: string;
  symbols: ParsedSymbol[];
  imports: HsImport[];
  edges: ParsedEdge[];
}

export interface HsImport {
  module: string;
  qualified: boolean;
  alias?: string;
  items?: string[]; // explicit import list
}

// Module declaration: module Foo.Bar.Baz where
const MODULE_RE = /^module\s+([\w.]+)/m;

// Import statements (multi-line aware via capturing)
const IMPORT_RE = /^import\s+(qualified\s+)?([\w.]+)(?:\s+as\s+(\w+))?(?:\s+hiding)?\s*(?:\(([^)]*)\))?/gm;

// Type signature: functionName :: Type -> Type
const TYPE_SIG_RE = /^(\w[\w']*)\s*::\s*(.+)$/gm;

// Data/type/newtype declarations
const DATA_DECL_RE = /^(data|type|newtype)\s+([\w']+)/gm;

// Class declaration
const CLASS_DECL_RE = /^class\s+(?:\([^)]*\)\s*=>)?\s*(\w+)/gm;

// Instance declaration (for reference tracking)
const INSTANCE_RE = /^instance\s+/gm;

export function parseHsFile(content: string, filePath: string): HsParseResult {
  const moduleMatch = content.match(MODULE_RE);
  const moduleName = moduleMatch ? moduleMatch[1] : filePath.replace(/\.hs$/, '').replace(/\//g, '.');

  const symbols: ParsedSymbol[] = [];
  const imports: HsImport[] = [];
  const edges: ParsedEdge[] = [];
  const lines = content.split('\n');

  // Extract imports
  let match: RegExpExecArray | null;
  IMPORT_RE.lastIndex = 0;
  while ((match = IMPORT_RE.exec(content)) !== null) {
    const imp: HsImport = {
      module: match[2],
      qualified: !!match[1],
      alias: match[3] || undefined,
      items: match[4] ? match[4].split(',').map(s => s.trim()).filter(Boolean) : undefined,
    };
    imports.push(imp);
  }

  // Extract type signatures (these give us function names + types)
  const signatureMap = new Map<string, string>();
  TYPE_SIG_RE.lastIndex = 0;
  while ((match = TYPE_SIG_RE.exec(content)) !== null) {
    const name = match[1];
    const typeSig = match[2].trim();
    // Skip operators and internal names
    if (name.startsWith('_') || name === 'where' || name === 'let' || name === 'do') continue;
    signatureMap.set(name, typeSig);
  }

  // Extract data/type/newtype/class declarations
  DATA_DECL_RE.lastIndex = 0;
  while ((match = DATA_DECL_RE.exec(content)) !== null) {
    const kind = match[1]; // data, type, newtype
    const name = match[2];
    const lineNum = content.substring(0, match.index).split('\n').length;
    symbols.push({
      name,
      qualified: `${moduleName}.${name}`,
      kind: 'type',
      lineStart: lineNum,
      exported: true,
    });
  }

  CLASS_DECL_RE.lastIndex = 0;
  while ((match = CLASS_DECL_RE.exec(content)) !== null) {
    const name = match[1];
    const lineNum = content.substring(0, match.index).split('\n').length;
    symbols.push({
      name,
      qualified: `${moduleName}.${name}`,
      kind: 'class',
      lineStart: lineNum,
      exported: true,
    });
  }

  // Extract function definitions from signatures
  for (const [name, typeSig] of signatureMap) {
    // Find the line number of the signature
    const sigIdx = content.indexOf(`\n${name} ::`);
    const lineNum = sigIdx >= 0 ? content.substring(0, sigIdx + 1).split('\n').length : undefined;

    // Determine if it's a function (has -> in type) or a value
    const isFunction = typeSig.includes('->');

    symbols.push({
      name,
      qualified: `${moduleName}.${name}`,
      kind: isFunction ? 'function' : 'value',
      lineStart: lineNum,
      exported: true,
      metadata: JSON.stringify({ typeSignature: typeSig }),
    });
  }

  // Also find function definitions without signatures (top-level let bindings or pattern matches)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Top-level function definition: name arg1 arg2 = ...
    // Must start at column 0, not be an import/module/data/type/class line
    if (/^[a-z]\w*'?\s+\w/.test(line) && !line.startsWith('import ') && !line.startsWith('module ')) {
      const funcMatch = line.match(/^(\w[\w']*)\s+/);
      if (funcMatch) {
        const name = funcMatch[1];
        // Skip keywords
        if (['where', 'let', 'do', 'case', 'of', 'if', 'then', 'else', 'in', 'deriving', 'instance', 'class', 'data', 'type', 'newtype', 'import', 'module', 'infixl', 'infixr', 'infix', 'foreign', 'default'].includes(name)) continue;
        // Skip if already found via type signature
        if (signatureMap.has(name)) continue;

        symbols.push({
          name,
          qualified: `${moduleName}.${name}`,
          kind: 'function',
          lineStart: i + 1,
          exported: true,
        });
      }
    }
  }

  // Create module-level edges from imports
  for (const imp of imports) {
    // Edge: this module depends on imported module
    if (imp.items) {
      // Explicit import list: create edges for each imported symbol
      for (const item of imp.items) {
        const cleanItem = item.replace(/\(.*\)/, '').trim();
        if (cleanItem) {
          edges.push({
            sourceQualified: moduleName,
            targetQualified: `${imp.module}.${cleanItem}`,
            kind: 'imports',
          });
        }
      }
    }
  }

  return { moduleName, symbols, imports, edges };
}

/**
 * Parse all .hs files and return combined results.
 */
export function parseHsFiles(
  hsFiles: string[],
  codebaseRoot: string,
): Map<string, HsParseResult> {
  const results = new Map<string, HsParseResult>();
  let processed = 0;
  let errors = 0;

  for (const hsFile of hsFiles) {
    const fullPath = join(codebaseRoot, hsFile);
    try {
      const content = readFileSync(fullPath, 'utf8');
      const result = parseHsFile(content, hsFile);
      results.set(hsFile, result);
      processed++;
    } catch (err) {
      errors++;
      logger.debug(`Failed to parse ${hsFile}:`, err);
    }
  }

  logger.info(`hs-parser: parsed ${processed} files, ${errors} errors`);
  return results;
}
