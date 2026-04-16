import type { StorageBackend, RunResult } from './backend.js';
import { logger } from '../utils/logger.js';

/**
 * Opt-in native backend using better-sqlite3.
 * Activated via DEP_TRACER_BACKEND=native.
 * Falls back gracefully if the native module isn't available.
 */
export class NativeBackend implements StorageBackend {
  private db: any; // better-sqlite3 Database instance

  private constructor(db: any) {
    this.db = db;
  }

  static async create(dbPath: string): Promise<NativeBackend> {
    let BetterSqlite3: any;
    try {
      BetterSqlite3 = (await import('better-sqlite3')).default;
    } catch {
      throw new Error(
        'better-sqlite3 is not installed or failed to load. ' +
        'Install it with: npm install better-sqlite3, ' +
        'or use the default WASM backend (DEP_TRACER_BACKEND=wasm).'
      );
    }

    const db = new BetterSqlite3(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    logger.info(`Opened native SQLite database at ${dbPath}`);

    return new NativeBackend(db);
  }

  run(sql: string, params?: unknown[]): RunResult {
    const stmt = this.db.prepare(sql);
    const result = params ? stmt.run(...params) : stmt.run();
    return {
      changes: result.changes,
      lastInsertRowid: Number(result.lastInsertRowid),
    };
  }

  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
    const stmt = this.db.prepare(sql);
    return params ? stmt.all(...params) : stmt.all();
  }

  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined {
    const stmt = this.db.prepare(sql);
    return params ? stmt.get(...params) : stmt.get();
  }

  transaction<R>(fn: () => R): R {
    return this.db.transaction(fn)();
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  serialize(): Buffer | null {
    // Native backend writes directly to disk; no serialization needed.
    return null;
  }

  close(): void {
    this.db.close();
  }
}
