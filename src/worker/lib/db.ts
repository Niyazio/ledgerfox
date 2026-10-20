import { fromDbError } from "./errors";

export type Param = string | number | null | Uint8Array;

export async function all<T = Record<string, unknown>>(db: D1Database, sql: string, ...params: Param[]): Promise<T[]> {
  try {
    const r = await db.prepare(sql).bind(...params).all<T>();
    return r.results ?? [];
  } catch (e) {
    throw fromDbError(e) ?? e;
  }
}

export async function first<T = Record<string, unknown>>(db: D1Database, sql: string, ...params: Param[]): Promise<T | null> {
  try {
    return (await db.prepare(sql).bind(...params).first<T>()) ?? null;
  } catch (e) {
    throw fromDbError(e) ?? e;
  }
}

export async function run(db: D1Database, sql: string, ...params: Param[]) {
  try {
    return await db.prepare(sql).bind(...params).run();
  } catch (e) {
    throw fromDbError(e) ?? e;
  }
}

/** Execute statements atomically (D1 batch = single SQL transaction; any failure rolls back all). */
export async function batch(db: D1Database, stmts: D1PreparedStatement[]) {
  if (stmts.length === 0) return [];
  try {
    return await db.batch(stmts);
  } catch (e) {
    throw fromDbError(e) ?? e;
  }
}

export function stmt(db: D1Database, sql: string, ...params: Param[]): D1PreparedStatement {
  return db.prepare(sql).bind(...params);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** SQL expression rendering the next number of a sequence (call after incrementing next_value). */
export function seqNumberExpr(): string {
  return `(SELECT prefix || CASE WHEN length(next_value - 1) >= padding THEN (next_value - 1)
           ELSE substr('000000000000' || (next_value - 1), -padding) END
           FROM number_sequences WHERE company_id = ? AND key = ?)`;
}

/** Statements that allocate the next number for a sequence inside a batch. */
export function bumpSequence(db: D1Database, companyId: string, key: string, defaultPrefix: string): D1PreparedStatement[] {
  return [
    stmt(db, `INSERT OR IGNORE INTO number_sequences (company_id, key, prefix, next_value) VALUES (?, ?, ?, 1)`, companyId, key, defaultPrefix),
    stmt(db, `UPDATE number_sequences SET next_value = next_value + 1 WHERE company_id = ? AND key = ?`, companyId, key),
  ];
}

export function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(",");
}
