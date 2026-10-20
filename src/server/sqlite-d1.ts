/**
 * A D1-compatible facade over Node's built-in SQLite (node:sqlite), so the same Worker code runs on a PC with the
 * company data in a single file. Only the subset of the D1 API this codebase uses is implemented.
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";

type Bindable = string | number | bigint | null | Uint8Array;

function toBindable(v: unknown): Bindable {
  if (v === undefined) throw new TypeError("D1_TYPE_ERROR: undefined cannot be bound");
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return v as Bindable;
}

const meta = (changes = 0, lastRowId = 0) => ({ duration: 0, changes, last_row_id: lastRowId, changed_db: changes > 0, size_after: 0, rows_read: 0, rows_written: changes });

class Statement {
  constructor(private db: SqliteD1, readonly sql: string, readonly params: Bindable[] = []) {}

  bind(...values: unknown[]): Statement {
    return new Statement(this.db, this.sql, values.map(toBindable));
  }

  private stmt(): StatementSync {
    return this.db.statement(this.sql);
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = this.stmt().get(...this.params) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (column ? row[column] : row) as T;
  }

  async all<T = Record<string, unknown>>() {
    return { results: this.stmt().all(...this.params) as T[], success: true as const, meta: meta() };
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    const s = this.stmt();
    s.setReturnArrays(true);
    try { return s.all(...this.params) as T[]; } finally { s.setReturnArrays(false); }
  }

  async run() {
    return this.execute();
  }

  /** Synchronous execution used inside batches. Statements that return rows (e.g. RETURNING) report them as results. */
  execute() {
    const s = this.stmt();
    if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(this.sql) || /\bRETURNING\b/i.test(this.sql)) {
      return { results: s.all(...this.params) as Record<string, unknown>[], success: true as const, meta: meta() };
    }
    const r = s.run(...this.params);
    return { results: [] as Record<string, unknown>[], success: true as const, meta: meta(Number(r.changes), Number(r.lastInsertRowid)) };
  }
}

export class SqliteD1 {
  readonly raw: DatabaseSync;
  private cache = new Map<string, StatementSync>();

  constructor(path: string) {
    this.raw = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    // WAL keeps readers non-blocking; synchronous=FULL makes every committed transaction survive power loss.
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  }

  statement(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      if (this.cache.size > 500) this.cache.clear();
      this.cache.set(sql, s);
    }
    return s;
  }

  prepare(sql: string) {
    return new Statement(this, sql);
  }

  /** Like D1: all statements run in one transaction; any failure rolls everything back. */
  async batch(statements: Statement[]) {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const out = statements.map((s) => s.execute());
      this.raw.exec("COMMIT");
      return out;
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    }
  }

  async exec(sql: string) {
    this.raw.exec(sql);
    return { count: 0, duration: 0 };
  }

  close() {
    this.cache.clear();
    this.raw.close();
  }
}

/** Cast for code typed against Cloudflare's D1Database. */
export const asD1 = (db: SqliteD1) => db as unknown as D1Database;
