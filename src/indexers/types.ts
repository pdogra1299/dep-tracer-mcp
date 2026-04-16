/** Shared types used by all indexers. */

export type SymbolKind = 'function' | 'type' | 'class' | 'module' | 'component' | 'value' | 'pattern';
export type EdgeKind = 'calls' | 'imports' | 'uses_type' | 'instantiates' | 'opens' | 'inherits';
export type ModuleDepKind = 'import' | 'open' | 'qualified_use';

export interface ParsedSymbol {
  name: string;
  qualified: string;
  kind: SymbolKind;
  lineStart?: number;
  lineEnd?: number;
  exported: boolean;
  metadata?: string; // JSON string
}

export interface ParsedEdge {
  sourceQualified: string;
  targetQualified: string;
  kind: EdgeKind;
}

export interface ParsedModuleDep {
  sourceFilePath: string;
  targetFilePath: string;
  kind: ModuleDepKind;
}

export interface ParsedFileResult {
  filePath: string; // relative to codebase root
  mtimeMs: number;
  moduleName: string;
  symbols: ParsedSymbol[];
  edges: ParsedEdge[];
  moduleDeps: ParsedModuleDep[];
}

export interface IndexProgress {
  phase: string;
  current: number;
  total: number;
}
