/**
 * Inventory costing: moving weighted average per item across the company.
 * Issue value = qty × (total value ÷ total qty) rounded half-up; issuing the full remaining
 * quantity takes the full remaining value so no residue is left on the books.
 */
import { all, first, stmt } from "../lib/db";
import { newId } from "../lib/crypto";
import { unprocessable } from "../lib/errors";
import { divRound } from "@shared/money";

export interface StockPosition {
  qty_milli: number;
  value: number;
}

export async function companyPosition(db: D1Database, companyId: string, itemId: string): Promise<StockPosition> {
  const r = await first<{ q: number; v: number }>(
    db, `SELECT COALESCE(SUM(qty_milli),0) AS q, COALESCE(SUM(value),0) AS v FROM stock_moves WHERE company_id = ? AND item_id = ?`, companyId, itemId,
  );
  return { qty_milli: r?.q ?? 0, value: r?.v ?? 0 };
}

export async function warehouseQty(db: D1Database, companyId: string, itemId: string, warehouseId: string): Promise<number> {
  const r = await first<{ q: number }>(
    db, `SELECT COALESCE(SUM(qty_milli),0) AS q FROM stock_moves WHERE company_id = ? AND item_id = ? AND warehouse_id = ?`, companyId, itemId, warehouseId,
  );
  return r?.q ?? 0;
}

/** Cost of issuing qtyMilli units at the current moving average. */
export function issueCost(pos: StockPosition, qtyMilli: number): number {
  if (qtyMilli <= 0) throw new Error("issueCost: qty must be positive");
  if (pos.qty_milli <= 0) return 0;
  if (qtyMilli >= pos.qty_milli) return pos.value;
  return Number(divRound(BigInt(pos.value) * BigInt(qtyMilli), BigInt(pos.qty_milli)));
}

/**
 * Plan outgoing movements for several lines of the same document, accumulating the position so
 * multiple lines of one item are costed consistently.
 */
export async function planIssues(
  db: D1Database,
  companyId: string,
  lines: { item_id: string; qty_milli: number; warehouse_id: string; name: string }[],
): Promise<{ item_id: string; warehouse_id: string; qty_milli: number; value: number }[]> {
  const positions = new Map<string, StockPosition>();
  const whQty = new Map<string, number>();
  const out: { item_id: string; warehouse_id: string; qty_milli: number; value: number }[] = [];
  for (const l of lines) {
    if (!positions.has(l.item_id)) positions.set(l.item_id, await companyPosition(db, companyId, l.item_id));
    const wk = `${l.item_id}:${l.warehouse_id}`;
    if (!whQty.has(wk)) whQty.set(wk, await warehouseQty(db, companyId, l.item_id, l.warehouse_id));
    const available = whQty.get(wk)!;
    if (available < l.qty_milli) {
      throw unprocessable("INSUFFICIENT_STOCK", `Not enough stock of "${l.name}" (available ${available / 1000}, required ${l.qty_milli / 1000})`);
    }
    const pos = positions.get(l.item_id)!;
    const value = issueCost(pos, l.qty_milli);
    positions.set(l.item_id, { qty_milli: pos.qty_milli - l.qty_milli, value: pos.value - value });
    whQty.set(wk, available - l.qty_milli);
    out.push({ item_id: l.item_id, warehouse_id: l.warehouse_id, qty_milli: l.qty_milli, value });
  }
  return out;
}

export function stockMoveStmt(
  db: D1Database,
  m: {
    company_id: string; item_id: string; warehouse_id: string; move_date: string; qty_milli: number; value: number;
    kind: string; source_type?: string | null; source_id?: string | null; journal_entry_id?: string | null; memo?: string | null; created_by: string;
    batch_no?: string | null; expiry_date?: string | null;
  },
) {
  return stmt(
    db,
    `INSERT INTO stock_moves (id, company_id, item_id, warehouse_id, move_date, qty_milli, value, kind, source_type, source_id, journal_entry_id, memo, created_by, batch_no, expiry_date)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    newId(), m.company_id, m.item_id, m.warehouse_id, m.move_date, m.qty_milli, m.value, m.kind,
    m.source_type ?? null, m.source_id ?? null, m.journal_entry_id ?? null, m.memo ?? null, m.created_by, m.batch_no ?? null, m.expiry_date ?? null,
  );
}

// ── Batches and expiry ──

export interface BatchStock { batch_no: string; expiry_date: string | null; qty_milli: number }

/** Batches with stock in a warehouse, earliest expiry first (batches without an expiry last). */
export async function batchBalances(db: D1Database, companyId: string, itemId: string, warehouseId: string): Promise<BatchStock[]> {
  return all<BatchStock>(db,
    `SELECT batch_no, MAX(expiry_date) AS expiry_date, SUM(qty_milli) AS qty_milli FROM stock_moves
     WHERE company_id = ? AND item_id = ? AND warehouse_id = ? AND batch_no IS NOT NULL
     GROUP BY batch_no HAVING SUM(qty_milli) > 0 ORDER BY MAX(expiry_date) IS NULL, MAX(expiry_date), batch_no`, companyId, itemId, warehouseId);
}

/**
 * Which batches an outgoing quantity comes from. A requested batch is used as is; otherwise first-expiry-first-out.
 * Expired batches are never picked for a sale (`allowExpired` is for write-offs and transfers). `stock` is updated
 * in place so several lines of one document share it.
 */
export function pickBatches(stock: BatchStock[], qty: number, onDate: string, name: string, requested?: string | null, allowExpired = false): BatchStock[] {
  const usable = (b: BatchStock) => allowExpired || !b.expiry_date || b.expiry_date >= onDate;
  const pool = requested ? stock.filter((b) => b.batch_no === requested.toUpperCase()) : stock.filter(usable);
  if (requested && !pool.length) throw unprocessable("BATCH_NOT_FOUND", `Batch ${requested} of "${name}" has no stock in this warehouse`);
  if (requested && !usable(pool[0])) throw unprocessable("BATCH_EXPIRED", `Batch ${requested} of "${name}" expired on ${pool[0].expiry_date} and cannot be sold`);
  const out: BatchStock[] = [];
  let left = qty;
  for (const b of pool) {
    if (left <= 0) break;
    const take = Math.min(b.qty_milli, left);
    if (take <= 0) continue;
    out.push({ batch_no: b.batch_no, expiry_date: b.expiry_date, qty_milli: take });
    b.qty_milli -= take;
    left -= take;
  }
  if (left > 0) {
    const expired = stock.filter((b) => !usable(b)).reduce((t, b) => t + b.qty_milli, 0);
    throw unprocessable("INSUFFICIENT_STOCK", `Not enough ${requested ? `in batch ${requested}` : "unexpired stock"} of "${name}" (short by ${left / 1000}${expired ? `; ${expired / 1000} more is expired` : ""})`);
  }
  return out;
}

/** Splits a value across batch quantities, keeping the exact total (remainder on the last part). */
export function splitValue(value: number, parts: { qty_milli: number }[]): number[] {
  const total = parts.reduce((t, p) => t + p.qty_milli, 0);
  let given = 0;
  return parts.map((p, i) => {
    if (i === parts.length - 1) return value - given;
    const v = total ? Math.round((value * p.qty_milli) / total) : 0;
    given += v;
    return v;
  });
}

export async function defaultWarehouse(db: D1Database, companyId: string): Promise<string> {
  const w = await first<{ id: string }>(db, `SELECT id FROM warehouses WHERE company_id = ? AND is_active = 1 ORDER BY code = 'MAIN' DESC, code LIMIT 1`, companyId);
  if (!w) throw unprocessable("NO_WAREHOUSE", "Create a warehouse first");
  return w.id;
}
