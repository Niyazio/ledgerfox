/** D1-compatible facade over sql.js (SQLite compiled to WebAssembly) for the phone's offline copy. */
import type { Database, SqlValue } from "sql.js";

type Bindable = SqlValue;

function toBindable(v: unknown): Bindable {
  if (v === undefined) throw new TypeError("undefined cannot be bound");
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (typeof v === "bigint") return Number(v);
  return v as Bindable;
}

const meta = (changes = 0) => ({ duration: 0, changes, last_row_id: 0, changed_db: changes > 0, size_after: 0, rows_read: 0, rows_written: changes });

class Statement {
  constructor(private db: Database, readonly sql: string, readonly params: Bindable[] = []) {}
  bind(...values: unknown[]) { return new Statement(this.db, this.sql, values.map(toBindable)); }
  private rows(): Record<string, unknown>[] {
    const s = this.db.prepare(this.sql);
    try {
      s.bind(this.params);
      const out: Record<string, unknown>[] = [];
      while (s.step()) out.push(s.getAsObject() as Record<string, unknown>);
      return out;
    } finally { s.free(); }
  }
  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const r = this.rows()[0];
    if (!r) return null;
    return (column ? r[column] : r) as T;
  }
  async all<T = Record<string, unknown>>() { return { results: this.rows() as T[], success: true as const, meta: meta() }; }
  async raw<T = unknown[]>(): Promise<T[]> { return this.rows().map((r) => Object.values(r)) as T[]; }
  async run() { return this.execute(); }
  execute() {
    if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(this.sql) || /\bRETURNING\b/i.test(this.sql)) return { results: this.rows(), success: true as const, meta: meta() };
    this.db.run(this.sql, this.params);
    return { results: [] as Record<string, unknown>[], success: true as const, meta: meta(this.db.getRowsModified()) };
  }
}

export class SqlJsD1 {
  constructor(readonly raw: Database) { raw.exec("PRAGMA foreign_keys = ON;"); }
  prepare(sql: string) { return new Statement(this.raw, sql); }
  async batch(statements: Statement[]) {
    this.raw.exec("BEGIN");
    try { const out = statements.map((s) => s.execute()); this.raw.exec("COMMIT"); return out; }
    catch (e) { this.raw.exec("ROLLBACK"); throw e; }
  }
  async exec(sql: string) { this.raw.exec(sql); return { count: 0, duration: 0 }; }
}
