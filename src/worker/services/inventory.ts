/**
 * Inventory costing: moving weighted average per item across the company.
 * Issue value = qty × (total value ÷ total qty) rounded half-up; issuing the full remaining
 * quantity takes the full remaining value so no residue is left on the books.
 */
import { first, stmt } from "../lib/db";
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
  },
) {
  return stmt(
    db,
    `INSERT INTO stock_moves (id, company_id, item_id, warehouse_id, move_date, qty_milli, value, kind, source_type, source_id, journal_entry_id, memo, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    newId(), m.company_id, m.item_id, m.warehouse_id, m.move_date, m.qty_milli, m.value, m.kind,
    m.source_type ?? null, m.source_id ?? null, m.journal_entry_id ?? null, m.memo ?? null, m.created_by,
  );
}

export async function defaultWarehouse(db: D1Database, companyId: string): Promise<string> {
  const w = await first<{ id: string }>(db, `SELECT id FROM warehouses WHERE company_id = ? AND is_active = 1 ORDER BY code = 'MAIN' DESC, code LIMIT 1`, companyId);
  if (!w) throw unprocessable("NO_WAREHOUSE", "Create a warehouse first");
  return w.id;
}
