import { readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { ParsedSymbol, ParsedEdge, SymbolKind } from '../types.js';
import { logger } from '../../utils/logger.js';

/**
 * Regex-based parser for .res files.
 * Two-pass: first extract symbol definitions, then extract references.
 *
 * Handles the dominant patterns in ReScript codebases:
 * - @react.component let make = ...
 * - let functionName = (...) => { ... }
 * - type myType = ...
 * - module SubModule = { ... }
 * - open ModuleName
 * - ModuleName.functionName(...)
 * - <ComponentName ... />
 * - value->ModuleName.functionName
 */

export interface ResParseResult {
  symbols: ParsedSymbol[];
  edges: ParsedEdge[];
  openedModules: string[];
}

interface SymbolSpan {
  name: string;
  qualified: string;
  kind: SymbolKind;
  lineStart: number;
  lineEnd: number;
  exported: boolean;
}

/**
 * Parse a .res file and extract symbols and references.
 */
export function parseResFile(content: string, filePath: string): ResParseResult {
  const moduleName = basename(filePath, '.res');
  const lines = content.split('\n');

  // Pass 1: Extract symbols
  const symbols = extractSymbols(lines, moduleName);

  // Pass 2: Extract references (opens, qualified calls, JSX usage)
  const { edges, openedModules } = extractReferences(lines, moduleName, symbols);

  return {
    symbols: symbols.map(s => ({
      name: s.name,
      qualified: s.qualified,
      kind: s.kind,
      lineStart: s.lineStart,
      lineEnd: s.lineEnd,
      exported: s.exported,
    })),
    edges,
    openedModules,
  };
}

/**
 * Pass 1: Extract all symbol definitions from a .res file.
 */
function extractSymbols(lines: string[], moduleName: string): SymbolSpan[] {
  const symbols: SymbolSpan[] = [];
  let isReactComponent = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Detect @react.component decorator (applies to next let)
    if (trimmed.startsWith('@react.component')) {
      isReactComponent = true;
      continue;
    }

    // Let bindings (functions, values, components)
    const letMatch = trimmed.match(/^let\s+(\w+)\s*/);
    if (letMatch) {
      const name = letMatch[1];
      const lineStart = i + 1; // 1-indexed
      const lineEnd = findBindingEnd(lines, i);
      const kind: SymbolKind = isReactComponent ? 'component' : isFunction(trimmed) ? 'function' : 'value';

      symbols.push({
        name,
        qualified: `${moduleName}.${name}`,
        kind,
        lineStart,
        lineEnd,
        exported: !trimmed.startsWith('//'), // simplified: assume exported unless commented
      });
      isReactComponent = false;
      continue;
    }

    // Type definitions
    const typeMatch = trimmed.match(/^type\s+(\w+)/);
    if (typeMatch && !trimmed.startsWith('//')) {
      const name = typeMatch[1];
      symbols.push({
        name,
        qualified: `${moduleName}.${name}`,
        kind: 'type',
        lineStart: i + 1,
        lineEnd: findBindingEnd(lines, i),
        exported: true,
      });
      isReactComponent = false;
      continue;
    }

    // Module definitions
    const moduleMatch = trimmed.match(/^module\s+(\w+)\s*/);
    if (moduleMatch && !trimmed.startsWith('//')) {
      const name = moduleMatch[1];
      symbols.push({
        name,
        qualified: `${moduleName}.${name}`,
        kind: 'module',
        lineStart: i + 1,
        lineEnd: findBlockEnd(lines, i),
        exported: true,
      });
      isReactComponent = false;
      continue;
    }

    // Reset react component flag if we hit a non-decorator, non-let line
    if (isReactComponent && trimmed.length > 0 && !trimmed.startsWith('@')) {
      isReactComponent = false;
    }
  }

  return symbols;
}

/**
 * Pass 2: Extract references from the source.
 */
function extractReferences(
  lines: string[],
  moduleName: string,
  symbols: SymbolSpan[],
): { edges: ParsedEdge[]; openedModules: string[] } {
  const edges: ParsedEdge[] = [];
  const openedModules: string[] = [];
  const seenEdges = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Skip comments
    if (trimmed.startsWith('//')) continue;

    // open Module statements
    const openMatch = trimmed.match(/^open\s+([\w.]+)/);
    if (openMatch) {
      openedModules.push(openMatch[1]);
      // Find which symbol this open is inside (if any)
      const enclosing = findEnclosingSymbol(symbols, i + 1);
      if (enclosing) {
        const edgeKey = `${enclosing.qualified}->opens->${openMatch[1]}`;
        if (!seenEdges.has(edgeKey)) {
          edges.push({
            sourceQualified: enclosing.qualified,
            targetQualified: openMatch[1],
            kind: 'opens',
          });
          seenEdges.add(edgeKey);
        }
      }
      continue;
    }

    // Qualified function calls: ModuleName.functionName
    // Match both Module.func and Module.SubModule.func
    const qualifiedRe = /\b([A-Z]\w+)\.(\w+)/g;
    let qMatch: RegExpExecArray | null;
    while ((qMatch = qualifiedRe.exec(line)) !== null) {
      const targetModule = qMatch[1];
      const targetFunc = qMatch[2];

      // Skip React.* built-in calls, Dict.*, Array.*, etc. (stdlib)
      if (isStdlibModule(targetModule)) continue;

      const enclosing = findEnclosingSymbol(symbols, i + 1);
      const sourceQualified = enclosing?.qualified ?? moduleName;
      const targetQualified = `${targetModule}.${targetFunc}`;

      const edgeKey = `${sourceQualified}->calls->${targetQualified}`;
      if (!seenEdges.has(edgeKey)) {
        edges.push({
          sourceQualified,
          targetQualified,
          kind: 'calls',
        });
        seenEdges.add(edgeKey);
      }
    }

    // JSX component usage: <ComponentName or <Module.ComponentName
    const jsxRe = /<([A-Z]\w+)(?:\.(\w+))?/g;
    let jsxMatch: RegExpExecArray | null;
    while ((jsxMatch = jsxRe.exec(line)) !== null) {
      const componentModule = jsxMatch[1];
      const subComponent = jsxMatch[2];

      if (isStdlibModule(componentModule)) continue;

      const enclosing = findEnclosingSymbol(symbols, i + 1);
      const sourceQualified = enclosing?.qualified ?? moduleName;
      const targetQualified = subComponent
        ? `${componentModule}.${subComponent}`
        : `${componentModule}.make`;

      const edgeKey = `${sourceQualified}->instantiates->${targetQualified}`;
      if (!seenEdges.has(edgeKey)) {
        edges.push({
          sourceQualified,
          targetQualified,
          kind: 'instantiates',
        });
        seenEdges.add(edgeKey);
      }
    }
  }

  return { edges, openedModules };
}

// ── Helpers ─────────────────────────────────────────────────────────

const STDLIB_MODULES = new Set([
  'React', 'Dict', 'Array', 'String', 'Int', 'Float', 'Option',
  'Promise', 'JSON', 'Fetch', 'Console', 'Math', 'Date', 'RegExp',
  'Belt', 'Js', 'Map', 'Set', 'Buffer', 'List', 'Result', 'Nullable',
]);

function isStdlibModule(name: string): boolean {
  return STDLIB_MODULES.has(name);
}

function isFunction(line: string): boolean {
  // Check if the let binding looks like a function:
  // let name = (...) => ...
  // let name = (~labeled) => ...
  // let name = () => ...
  return /^let\s+\w+\s*=\s*\(?.*(?:=>|switch)/.test(line)
    || /^let\s+\w+\s*=\s*\(~/.test(line);
}

/**
 * Find where a let binding ends by tracking indentation and braces.
 */
function findBindingEnd(lines: string[], startIdx: number): number {
  let depth = 0;
  let foundOpen = false;

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];

    for (const ch of line) {
      if (ch === '{' || ch === '(') { depth++; foundOpen = true; }
      if (ch === '}' || ch === ')') depth--;
    }

    // If we opened and closed all braces, or hit a new top-level definition
    if (foundOpen && depth <= 0) {
      return i + 1;
    }

    // If next line starts with a top-level keyword (and we haven't opened braces)
    if (i > startIdx && !foundOpen) {
      const nextTrimmed = line.trimStart();
      if (/^(let|type|module|@react|open|external|include)\b/.test(nextTrimmed)) {
        return i; // end at previous line
      }
    }
  }

  return lines.length;
}

/**
 * Find where a module block ends by tracking braces.
 */
function findBlockEnd(lines: string[], startIdx: number): number {
  let depth = 0;

  for (let i = startIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') depth++;
      if (ch === '}') depth--;
    }
    if (depth <= 0 && i > startIdx) {
      return i + 1;
    }
  }

  return lines.length;
}

/**
 * Find the symbol whose line range contains the given line number.
 */
function findEnclosingSymbol(symbols: SymbolSpan[], lineNum: number): SymbolSpan | null {
  // Find the most specific (narrowest) enclosing symbol
  let best: SymbolSpan | null = null;

  for (const sym of symbols) {
    if (lineNum >= sym.lineStart && lineNum <= sym.lineEnd) {
      if (!best || (sym.lineEnd - sym.lineStart) < (best.lineEnd - best.lineStart)) {
        best = sym;
      }
    }
  }

  return best;
}

/**
 * Parse all .res files and return combined results.
 */
export function parseResFiles(
  resFiles: string[],
  codebaseRoot: string,
): Map<string, ResParseResult> {
  const results = new Map<string, ResParseResult>();
  let processed = 0;
  let errors = 0;

  for (const resFile of resFiles) {
    const fullPath = join(codebaseRoot, resFile);
    try {
      const content = readFileSync(fullPath, 'utf8');
      const result = parseResFile(content, resFile);
      results.set(resFile, result);
      processed++;
    } catch (err) {
      errors++;
      logger.debug(`Failed to parse ${resFile}:`, err);
    }
  }

  logger.info(`res-parser: parsed ${processed} files, ${errors} errors`);
  return results;
}
