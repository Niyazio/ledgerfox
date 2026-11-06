/**
 * Serial numbers for products tracked one by one. A bill brings serials into stock, an invoice takes them out, a
 * credit note (sales return) brings them back and a debit note (return to supplier) takes them out again. Cancelling
 * a document undoes its serials. Every check runs before posting, and the changes go in the same transaction.
 */
import { all, stmt } from "../lib/db";
import { newId } from "../lib/crypto";
import { unprocessable } from "../lib/errors";

export function parseSerials(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.map((s) => String(s)) : []; } catch { return []; }
}

/** Cleans what was typed: one serial per line or comma, trimmed, upper case, no repeats. */
export function cleanSerials(list: string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const s of list ?? []) for (const part of s.split(/[\n,;]+/)) { const t = part.trim().toUpperCase(); if (t && !out.includes(t)) out.push(t); }
  return out;
}

interface Line { item_id: string | null; qty_milli: number; serials: string | null; track_serials: number | null; item_name: string | null; description: string }

/** Statements that move a document's serials, after checking them. */
export async function serialStatements(db: D1Database, companyId: string, doc: { id: string; doc_type: string }, lines: Line[]) {
  const stmts: D1PreparedStatement[] = [];
  const incoming = doc.doc_type === "bill" || doc.doc_type === "credit_note";
  const outgoing = doc.doc_type === "invoice" || doc.doc_type === "debit_note";
  if (!incoming && !outgoing) return stmts;
  for (const l of lines) {
    if (!l.item_id || !l.track_serials) continue;
    const name = l.item_name ?? l.description;
    const serials = parseSerials(l.serials);
    if (l.qty_milli % 1000 !== 0) throw unprocessable("SERIAL_QTY", `"${name}" is tracked by serial number, so its quantity must be a whole number`);
    if (serials.length !== l.qty_milli / 1000) throw unprocessable("SERIALS_REQUIRED", `Enter ${l.qty_milli / 1000} serial number${l.qty_milli === 1000 ? "" : "s"} for "${name}" (${serials.length} entered)`);
    const known = await all<{ id: string; serial: string; status: string }>(db,
      `SELECT id, serial, status FROM item_serials WHERE company_id = ? AND item_id = ? AND serial IN (${serials.map(() => "?").join(",")})`, companyId, l.item_id, ...serials);
    const by = new Map(known.map((k) => [k.serial, k]));
    for (const s of serials) {
      const k = by.get(s);
      if (doc.doc_type === "bill") {
        if (k?.status === "in_stock") throw unprocessable("SERIAL_IN_STOCK", `Serial ${s} of "${name}" is already in stock`);
        stmts.push(k
          ? stmt(db, `UPDATE item_serials SET status = 'in_stock', in_doc_id = ?, out_doc_id = NULL, updated_at = ? WHERE id = ?`, doc.id, new Date().toISOString(), k.id)
          : stmt(db, `INSERT INTO item_serials (id, company_id, item_id, serial, status, in_doc_id) VALUES (?,?,?,?,'in_stock',?)`, newId(), companyId, l.item_id, s, doc.id));
      } else if (doc.doc_type === "credit_note") {
        if (!k || k.status !== "out") throw unprocessable("SERIAL_NOT_SOLD", `Serial ${s} of "${name}" was not sold, so it cannot be returned`);
        stmts.push(stmt(db, `UPDATE item_serials SET status = 'in_stock', in_doc_id = ?, updated_at = ? WHERE id = ?`, doc.id, new Date().toISOString(), k.id));
      } else {
        if (!k || k.status !== "in_stock") throw unprocessable("SERIAL_NOT_IN_STOCK", `Serial ${s} of "${name}" is not in stock`);
        stmts.push(stmt(db, `UPDATE item_serials SET status = 'out', out_doc_id = ?, updated_at = ? WHERE id = ? AND status = 'in_stock'`, doc.id, new Date().toISOString(), k.id));
      }
    }
  }
  return stmts;
}

/** Cancelling a document puts its serials back where they were. */
export async function serialVoidStatements(db: D1Database, companyId: string, doc: { id: string; doc_type: string }) {
  const now = new Date().toISOString();
  if (doc.doc_type === "invoice" || doc.doc_type === "debit_note") {
    return [stmt(db, `UPDATE item_serials SET status = 'in_stock', out_doc_id = NULL, updated_at = ? WHERE company_id = ? AND out_doc_id = ? AND status = 'out'`, now, companyId, doc.id)];
  }
  if (doc.doc_type === "bill" || doc.doc_type === "credit_note") {
    const gone = await all<{ serial: string }>(db, `SELECT serial FROM item_serials WHERE company_id = ? AND in_doc_id = ? AND status <> 'in_stock'`, companyId, doc.id);
    if (gone.length) throw unprocessable("SERIAL_ALREADY_OUT", `Serial ${gone[0].serial} from this document has been sold or returned since. Cancel that first.`);
    return doc.doc_type === "bill"
      ? [stmt(db, `DELETE FROM item_serials WHERE company_id = ? AND in_doc_id = ? AND status = 'in_stock'`, companyId, doc.id)]
      : [stmt(db, `UPDATE item_serials SET status = 'out', updated_at = ? WHERE company_id = ? AND in_doc_id = ? AND status = 'in_stock'`, now, companyId, doc.id)];
  }
  return [];
}
