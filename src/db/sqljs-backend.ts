import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { StorageBackend, RunResult } from './backend.js';
import { logger } from '../utils/logger.js';

export class SqlJsBackend implements StorageBackend {
  private db: SqlJsDatabase;
  private dbPath: string | null;

  private constructor(db: SqlJsDatabase, dbPath: string | null) {
    this.db = db;
    this.dbPath = dbPath;
  }

  static async create(dbPath?: string): Promise<SqlJsBackend> {
    const SQL = await initSqlJs();
    let db: SqlJsDatabase;

    if (dbPath && existsSync(dbPath)) {
      const buffer = readFileSync(dbPath);
      db = new SQL.Database(buffer);
      logger.info(`Loaded existing database from ${dbPath}`);
    } else {
      db = new SQL.Database();
      if (dbPath) {
        logger.info(`Creating new database (will save to ${dbPath})`);
      }
    }

    db.run('PRAGMA journal_mode = WAL');
    db.run('PRAGMA foreign_keys = ON');

    return new SqlJsBackend(db, dbPath ?? null);
  }

  run(sql: string, params?: unknown[]): RunResult {
    this.db.run(sql, params as any[]);
    const changes = this.db.getRowsModified();
    // sql.js doesn't expose lastInsertRowid directly via run,
    // so we query it separately
    const row = this.db.exec('SELECT last_insert_rowid() as id');
    const lastInsertRowid = row.length > 0 ? (row[0].values[0][0] as number) : 0;
    return { changes, lastInsertRowid };
  }

  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
    const stmt = this.db.prepare(sql);
    if (params) stmt.bind(params as any[]);

    const results: T[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject() as T);
    }
    stmt.free();
    return results;
  }

  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined {
    const stmt = this.db.prepare(sql);
    if (params) stmt.bind(params as any[]);

    let result: T | undefined;
    if (stmt.step()) {
      result = stmt.getAsObject() as T;
    }
    stmt.free();
    return result;
  }

  transaction<R>(fn: () => R): R {
    this.db.run('BEGIN TRANSACTION');
    try {
      const result = fn();
      this.db.run('COMMIT');
      return result;
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  serialize(): Buffer | null {
    const data = this.db.export();
    return Buffer.from(data);
  }

  /** Save the in-memory database to disk. */
  save(): void {
    if (!this.dbPath) return;
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const data = this.serialize()!;
    writeFileSync(this.dbPath, data);
    logger.debug(`Database saved to ${this.dbPath}`);
  }

  close(): void {
    this.save();
    this.db.close();
  }
}
