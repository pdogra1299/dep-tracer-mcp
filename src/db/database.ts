import type { StorageBackend } from './backend.js';
import { SqlJsBackend } from './sqljs-backend.js';
import { NativeBackend } from './native-backend.js';
import { CREATE_TABLES, SCHEMA_VERSION } from './schema.js';
import { logger } from '../utils/logger.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

function resolveDbPath(): string {
  const envPath = process.env.DEP_TRACER_DB_PATH;
  if (envPath) return envPath;
  return join(homedir(), '.dep-tracer', 'deps.db');
}

export class Database {
  private backend: StorageBackend;

  private constructor(backend: StorageBackend) {
    this.backend = backend;
  }

  static async create(): Promise<Database> {
    const dbPath = resolveDbPath();
    const explicit = process.env.DEP_TRACER_BACKEND; // 'native', 'wasm', or unset

    let backend: StorageBackend;

    if (explicit === 'wasm') {
      // User explicitly wants WASM — skip native attempt
      backend = await SqlJsBackend.create(dbPath);
    } else if (explicit === 'native') {
      // User explicitly wants native — fail hard if unavailable
      backend = await NativeBackend.create(dbPath);
    } else {
      // Auto mode: try native first (faster), fall back to WASM (always works)
      backend = await Database.createWithFallback(dbPath);
    }

    const db = new Database(backend);
    db.initSchema();
    return db;
  }

  /**
   * Priority cascade:
   *   1. better-sqlite3 (native, ~5-10x faster for bulk inserts)
   *   2. sql.js (WASM, zero native deps, always works)
   */
  private static async createWithFallback(dbPath: string): Promise<StorageBackend> {
    // Attempt 1: better-sqlite3 (native)
    try {
      const backend = await NativeBackend.create(dbPath);
      logger.info('Storage backend: better-sqlite3 (native)');
      return backend;
    } catch {
      logger.debug('better-sqlite3 not available, falling back to sql.js (WASM)');
    }

    // Attempt 2: sql.js (WASM) — always available
    const backend = await SqlJsBackend.create(dbPath);
    logger.info('Storage backend: sql.js (WASM)');
    return backend;
  }

  private initSchema(): void {
    const row = this.backend.get<{ version: number }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
    );

    if (!row) {
      this.backend.exec(CREATE_TABLES);
      this.backend.run(
        'INSERT INTO schema_version (version) VALUES (?)',
        [SCHEMA_VERSION]
      );
      logger.info(`Initialized database schema v${SCHEMA_VERSION}`);
    } else {
      logger.debug('Database schema already exists');
    }
  }

  // ── Codebase operations ─────────────────────────────────────────────

  upsertCodebase(name: string, language: string, rootPath: string): number {
    const existing = this.backend.get<{ id: number }>(
      'SELECT id FROM codebases WHERE name = ?',
      [name]
    );
    if (existing) {
      this.backend.run(
        'UPDATE codebases SET language = ?, root_path = ? WHERE id = ?',
        [language, rootPath, existing.id]
      );
      return existing.id;
    }
    const result = this.backend.run(
      'INSERT INTO codebases (name, language, root_path) VALUES (?, ?, ?)',
      [name, language, rootPath]
    );
    return result.lastInsertRowid;
  }

  getCodebase(name: string) {
    return this.backend.get<{
      id: number; name: string; language: string; root_path: string;
      indexed_at: string | null; file_count: number; symbol_count: number;
    }>('SELECT * FROM codebases WHERE name = ?', [name]);
  }

  getAllCodebases() {
    return this.backend.all<{
      id: number; name: string; language: string; root_path: string;
      indexed_at: string | null; file_count: number; symbol_count: number;
    }>('SELECT * FROM codebases');
  }

  updateCodebaseStats(codebaseId: number): void {
    const fileCount = this.backend.get<{ c: number }>(
      'SELECT COUNT(*) as c FROM files WHERE codebase_id = ?', [codebaseId]
    )?.c ?? 0;
    const symbolCount = this.backend.get<{ c: number }>(
      'SELECT COUNT(*) as c FROM symbols WHERE codebase_id = ?', [codebaseId]
    )?.c ?? 0;
    this.backend.run(
      'UPDATE codebases SET file_count = ?, symbol_count = ?, indexed_at = ? WHERE id = ?',
      [fileCount, symbolCount, new Date().toISOString(), codebaseId]
    );
  }

  // ── File operations ─────────────────────────────────────────────────

  upsertFile(codebaseId: number, path: string, mtimeMs: number): number {
    const existing = this.backend.get<{ id: number }>(
      'SELECT id FROM files WHERE codebase_id = ? AND path = ?',
      [codebaseId, path]
    );
    const now = new Date().toISOString();
    if (existing) {
      this.backend.run(
        'UPDATE files SET mtime_ms = ?, indexed_at = ? WHERE id = ?',
        [mtimeMs, now, existing.id]
      );
      return existing.id;
    }
    const result = this.backend.run(
      'INSERT INTO files (codebase_id, path, mtime_ms, indexed_at) VALUES (?, ?, ?, ?)',
      [codebaseId, path, mtimeMs, now]
    );
    return result.lastInsertRowid;
  }

  getFile(codebaseId: number, path: string) {
    return this.backend.get<{ id: number; path: string; mtime_ms: number }>(
      'SELECT id, path, mtime_ms FROM files WHERE codebase_id = ? AND path = ?',
      [codebaseId, path]
    );
  }

  getFilesByCodebase(codebaseId: number) {
    return this.backend.all<{ id: number; path: string; mtime_ms: number }>(
      'SELECT id, path, mtime_ms FROM files WHERE codebase_id = ?',
      [codebaseId]
    );
  }

  deleteFileData(fileId: number): void {
    // Cascading deletes handle symbols and edges
    this.backend.run('DELETE FROM module_deps WHERE source_file_id = ? OR target_file_id = ?', [fileId, fileId]);
    this.backend.run('DELETE FROM symbols WHERE file_id = ?', [fileId]);
  }

  // ── Symbol operations ───────────────────────────────────────────────

  insertSymbol(
    codebaseId: number, fileId: number, name: string, qualified: string,
    kind: string, lineStart?: number, lineEnd?: number,
    exported: boolean = true, metadata?: string,
  ): number {
    const result = this.backend.run(
      `INSERT INTO symbols (codebase_id, file_id, name, qualified, kind, line_start, line_end, exported, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [codebaseId, fileId, name, qualified, kind, lineStart ?? null, lineEnd ?? null, exported ? 1 : 0, metadata ?? null]
    );
    return result.lastInsertRowid;
  }

  findSymbol(codebaseId: number, qualified: string) {
    return this.backend.get<{
      id: number; name: string; qualified: string; kind: string;
      line_start: number | null; line_end: number | null;
      exported: number; metadata: string | null; file_id: number;
    }>(
      'SELECT * FROM symbols WHERE codebase_id = ? AND qualified = ?',
      [codebaseId, qualified]
    );
  }

  findSymbolsByName(codebaseId: number, name: string) {
    return this.backend.all<{
      id: number; name: string; qualified: string; kind: string;
      line_start: number | null; line_end: number | null; file_id: number;
    }>(
      'SELECT * FROM symbols WHERE codebase_id = ? AND name = ?',
      [codebaseId, name]
    );
  }

  searchSymbols(codebaseId: number, pattern: string, kinds?: string[], limit: number = 25) {
    const likePattern = pattern.includes('*')
      ? pattern.replace(/\*/g, '%')
      : `%${pattern}%`;

    let sql = 'SELECT s.*, f.path as file_path FROM symbols s JOIN files f ON s.file_id = f.id WHERE s.codebase_id = ? AND (s.qualified LIKE ? OR s.name LIKE ?)';
    const params: unknown[] = [codebaseId, likePattern, likePattern];

    if (kinds && kinds.length > 0) {
      sql += ` AND s.kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }
    sql += ' ORDER BY s.qualified LIMIT ?';
    params.push(limit);

    return this.backend.all<{
      id: number; name: string; qualified: string; kind: string;
      line_start: number | null; line_end: number | null;
      file_path: string; exported: number;
    }>(sql, params);
  }

  getSymbolsByFile(fileId: number, kinds?: string[]) {
    let sql = 'SELECT * FROM symbols WHERE file_id = ?';
    const params: unknown[] = [fileId];
    if (kinds && kinds.length > 0) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }
    sql += ' ORDER BY line_start';
    return this.backend.all<{
      id: number; name: string; qualified: string; kind: string;
      line_start: number | null; line_end: number | null;
      exported: number; metadata: string | null;
    }>(sql, params);
  }

  // ── Edge operations ─────────────────────────────────────────────────

  insertEdge(sourceId: number, targetId: number, kind: string): void {
    this.backend.run(
      'INSERT OR IGNORE INTO edges (source_id, target_id, kind) VALUES (?, ?, ?)',
      [sourceId, targetId, kind]
    );
  }

  insertModuleDep(sourceFileId: number, targetFileId: number, depKind: string): void {
    this.backend.run(
      'INSERT OR IGNORE INTO module_deps (source_file_id, target_file_id, dep_kind) VALUES (?, ?, ?)',
      [sourceFileId, targetFileId, depKind]
    );
  }

  // ── Graph traversal (recursive CTEs) ────────────────────────────────

  traceCallees(codebaseId: number, qualified: string, maxDepth: number = 5) {
    return this.backend.all<{
      id: number; name: string; qualified: string; kind: string;
      depth: number; path: string;
    }>(`
      WITH RECURSIVE callee_tree(id, name, qualified, kind, depth, path) AS (
        SELECT s.id, s.name, s.qualified, s.kind, 0, CAST(s.id AS TEXT)
        FROM symbols s
        WHERE s.codebase_id = ? AND s.qualified = ?

        UNION ALL

        SELECT s.id, s.name, s.qualified, s.kind, ct.depth + 1,
               ct.path || ',' || CAST(s.id AS TEXT)
        FROM callee_tree ct
        JOIN edges e ON e.source_id = ct.id
        JOIN symbols s ON s.id = e.target_id
        WHERE ct.depth < ?
          AND ct.path NOT LIKE '%' || CAST(s.id AS TEXT) || '%'
      )
      SELECT DISTINCT id, name, qualified, kind, depth, path
      FROM callee_tree
      ORDER BY depth, qualified
    `, [codebaseId, qualified, maxDepth]);
  }

  traceCallers(codebaseId: number, qualified: string, maxDepth: number = 5) {
    return this.backend.all<{
      id: number; name: string; qualified: string; kind: string;
      depth: number; path: string;
    }>(`
      WITH RECURSIVE caller_tree(id, name, qualified, kind, depth, path) AS (
        SELECT s.id, s.name, s.qualified, s.kind, 0, CAST(s.id AS TEXT)
        FROM symbols s
        WHERE s.codebase_id = ? AND s.qualified = ?

        UNION ALL

        SELECT s.id, s.name, s.qualified, s.kind, ct.depth + 1,
               CAST(s.id AS TEXT) || ',' || ct.path
        FROM caller_tree ct
        JOIN edges e ON e.target_id = ct.id
        JOIN symbols s ON s.id = e.source_id
        WHERE ct.depth < ?
          AND ct.path NOT LIKE '%' || CAST(s.id AS TEXT) || '%'
      )
      SELECT DISTINCT id, name, qualified, kind, depth, path
      FROM caller_tree
      ORDER BY depth, qualified
    `, [codebaseId, qualified, maxDepth]);
  }

  traceModuleDeps(
    codebaseId: number, filePath: string,
    direction: 'imports' | 'imported_by' | 'both' = 'both',
    maxDepth: number = 5,
  ) {
    const queries: Array<{ id: number; path: string; depth: number; direction: string }> = [];

    if (direction === 'imports' || direction === 'both') {
      const rows = this.backend.all<{ id: number; path: string; depth: number }>(`
        WITH RECURSIVE dep_tree(file_id, path, depth, visited) AS (
          SELECT f.id, f.path, 0, CAST(f.id AS TEXT)
          FROM files f WHERE f.codebase_id = ? AND f.path = ?

          UNION ALL

          SELECT f.id, f.path, dt.depth + 1, dt.visited || ',' || CAST(f.id AS TEXT)
          FROM dep_tree dt
          JOIN module_deps md ON md.source_file_id = dt.file_id
          JOIN files f ON f.id = md.target_file_id
          WHERE dt.depth < ?
            AND dt.visited NOT LIKE '%' || CAST(f.id AS TEXT) || '%'
        )
        SELECT DISTINCT file_id as id, path, depth FROM dep_tree ORDER BY depth, path
      `, [codebaseId, filePath, maxDepth]);
      rows.forEach(r => queries.push({ ...r, direction: 'imports' }));
    }

    if (direction === 'imported_by' || direction === 'both') {
      const rows = this.backend.all<{ id: number; path: string; depth: number }>(`
        WITH RECURSIVE dep_tree(file_id, path, depth, visited) AS (
          SELECT f.id, f.path, 0, CAST(f.id AS TEXT)
          FROM files f WHERE f.codebase_id = ? AND f.path = ?

          UNION ALL

          SELECT f.id, f.path, dt.depth + 1, dt.visited || ',' || CAST(f.id AS TEXT)
          FROM dep_tree dt
          JOIN module_deps md ON md.target_file_id = dt.file_id
          JOIN files f ON f.id = md.source_file_id
          WHERE dt.depth < ?
            AND dt.visited NOT LIKE '%' || CAST(f.id AS TEXT) || '%'
        )
        SELECT DISTINCT file_id as id, path, depth FROM dep_tree ORDER BY depth, path
      `, [codebaseId, filePath, maxDepth]);
      rows.forEach(r => queries.push({ ...r, direction: 'imported_by' }));
    }

    return queries;
  }

  getDirectCallees(symbolId: number) {
    return this.backend.all<{
      id: number; name: string; qualified: string; kind: string; edge_kind: string;
    }>(`
      SELECT s.id, s.name, s.qualified, s.kind, e.kind as edge_kind
      FROM edges e JOIN symbols s ON s.id = e.target_id
      WHERE e.source_id = ?
      ORDER BY s.qualified
    `, [symbolId]);
  }

  getDirectCallers(symbolId: number) {
    return this.backend.all<{
      id: number; name: string; qualified: string; kind: string; edge_kind: string;
    }>(`
      SELECT s.id, s.name, s.qualified, s.kind, e.kind as edge_kind
      FROM edges e JOIN symbols s ON s.id = e.source_id
      WHERE e.target_id = ?
      ORDER BY s.qualified
    `, [symbolId]);
  }

  getEdgeCount(codebaseId: number): number {
    return this.backend.get<{ c: number }>(`
      SELECT COUNT(*) as c FROM edges e
      JOIN symbols s ON s.id = e.source_id
      WHERE s.codebase_id = ?
    `, [codebaseId])?.c ?? 0;
  }

  getModuleDepCount(codebaseId: number): number {
    return this.backend.get<{ c: number }>(`
      SELECT COUNT(*) as c FROM module_deps md
      JOIN files f ON f.id = md.source_file_id
      WHERE f.codebase_id = ?
    `, [codebaseId])?.c ?? 0;
  }

  // ── Batch operations ────────────────────────────────────────────────

  runInTransaction<R>(fn: () => R): R {
    return this.backend.transaction(fn);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  /** Save database state (relevant for sql.js WASM backend). */
  save(): void {
    if ('save' in this.backend && typeof (this.backend as any).save === 'function') {
      (this.backend as any).save();
    }
  }

  close(): void {
    this.backend.close();
  }
}
