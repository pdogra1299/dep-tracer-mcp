/**
 * Pluggable storage backend interface.
 * Both sql.js (WASM) and better-sqlite3 (native) implement this.
 * All queries — including recursive CTEs — work identically on both.
 */
export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface StorageBackend {
  /** Execute a mutating SQL statement (CREATE, INSERT, UPDATE, DELETE). */
  run(sql: string, params?: unknown[]): RunResult;

  /** Query multiple rows. */
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];

  /** Query a single row. */
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined;

  /** Wrap multiple operations in a transaction. */
  transaction<R>(fn: () => R): R;

  /** Execute raw SQL (for schema setup, multiple statements). */
  exec(sql: string): void;

  /** Serialize DB to a buffer (sql.js → file persistence). Returns null for native backend. */
  serialize(): Buffer | null;

  /** Close the connection. */
  close(): void;
}
