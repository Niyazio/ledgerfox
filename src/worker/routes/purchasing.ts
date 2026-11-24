import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { all, batch, first, stmt, todayIso } from "../lib/db";
import { badRequest, conflict, notFound } from "../lib/errors";
import { body, idStr, isoDate, minor, optId, qty, reqText, shortText } from "../lib/validate";
import { newId } from "../lib/crypto";
import { audit, requireAnyPerm, requirePerm } from "../lib/auth";
import { currencyExponent } from "@shared/currencies";
import { prepareDraft } from "../services/documents";
import { portalToken } from "../services/collect";
import { siteUrl } from "../services/email";

/**
 * Purchasing beyond the purchase order: requests for quotation (RFQ) to several suppliers with a side-by-side comparison,
 * goods receipt notes (GRN) with quality acceptance, and the 3-way match of order, receipt and bill.
 */
export const purchasing = new Hono<AppEnv>();

async function nextNumber(db: D1Database, table: "rfqs" | "grns", companyId: string, prefix: string) {
  const r = await first<{ n: number | null }>(db, `SELECT MAX(CAST(SUBSTR(number, ${prefix.length + 1}) AS INTEGER)) AS n FROM ${table} WHERE company_id = ? AND number LIKE ?`, companyId, `${prefix}%`);
  return `${prefix}${String((r?.n ?? 0) + 1).padStart(4, "0")}`;
}

// ── Requests for quotation ──

purchasing.get("/rfqs", async (c) => {
  requirePerm(c, "purchase.view");
  const rows = await all(c.env.DB,
    `SELECT r.*, (SELECT COUNT(*) FROM rfq_suppliers s WHERE s.rfq_id = r.id) AS suppliers, (SELECT COUNT(*) FROM rfq_suppliers s WHERE s.rfq_id = r.id AND s.status = 'quoted') AS quotes,
            ct.name AS awarded_to, d.number AS po_number
       FROM rfqs r LEFT JOIN contacts ct ON ct.id = r.awarded_contact_id LEFT JOIN documents d ON d.id = r.po_id
      WHERE r.company_id = ? ORDER BY r.created_at DESC LIMIT 300`, c.get("company").id);
  return c.json({ rfqs: rows });
});

const rfqSchema = z.object({
  title: reqText(120),
  issue_date: isoDate.optional(),
  respond_by: isoDate.nullish(),
  notes: shortText(1000).nullish(),
  lines: z.array(z.object({ item_id: optId, description: reqText(300), quantity: z.union([z.string(), z.number()]), unit: shortText(20).nullish() })).min(1).max(100),
  supplier_ids: z.array(idStr).min(1).max(30),
});

purchasing.post("/rfqs", async (c) => {
  requirePerm(c, "purchase.create");
  const input = await body(c, rfqSchema);
  const co = c.get("company");
  const ids = [...new Set(input.supplier_ids)];
  const found = await all<{ id: string }>(c.env.DB, `SELECT id FROM contacts WHERE company_id = ? AND kind IN ('supplier','both') AND id IN (${ids.map(() => "?").join(",")})`, co.id, ...ids);
  if (found.length !== ids.length) throw badRequest("Choose suppliers from your supplier list");
  const id = newId();
  const number = await nextNumber(c.env.DB, "rfqs", co.id, "RFQ-");
  const stmts = [stmt(c.env.DB, `INSERT INTO rfqs (id, company_id, number, title, issue_date, respond_by, notes, created_by) VALUES (?,?,?,?,?,?,?,?)`,
    id, co.id, number, input.title, input.issue_date ?? todayIso(), input.respond_by ?? null, input.notes ?? null, c.get("user").id)];
  input.lines.forEach((l, i) => stmts.push(stmt(c.env.DB, `INSERT INTO rfq_lines (id, rfq_id, line_no, item_id, description, qty_milli, unit) VALUES (?,?,?,?,?,?,?)`,
    newId(), id, i + 1, l.item_id ?? null, l.description, qty(l.quantity), l.unit ?? null)));
  for (const s of ids) stmts.push(stmt(c.env.DB, `INSERT INTO rfq_suppliers (rfq_id, contact_id) VALUES (?,?)`, id, s));
  stmts.push(audit(c, "rfq.create", "rfq", id, { number, suppliers: ids.length, lines: input.lines.length }));
  await batch(c.env.DB, stmts);
  return c.json({ id, number }, 201);
});

async function loadRfq(db: D1Database, companyId: string, id: string) {
  const r = await first<{ id: string; number: string; title: string; status: string; issue_date: string; respond_by: string | null; notes: string | null; awarded_contact_id: string | null; po_id: string | null }>(db,
    `SELECT * FROM rfqs WHERE id = ? AND company_id = ?`, id, companyId);
  if (!r) throw notFound("RFQ");
  const lines = await all<{ id: string; line_no: number; item_id: string | null; description: string; qty_milli: number; unit: string | null }>(db, `SELECT * FROM rfq_lines WHERE rfq_id = ? ORDER BY line_no`, id);
  const suppliers = await all<{ contact_id: string; name: string; currency: string | null; status: string; delivery_days: number | null; valid_until: string | null; notes: string | null; quoted_at: string | null; entered_by: string | null }>(db,
    `SELECT s.*, ct.name, ct.currency FROM rfq_suppliers s JOIN contacts ct ON ct.id = s.contact_id WHERE s.rfq_id = ? ORDER BY ct.name`, id);
  const quotes = await all<{ contact_id: string; line_id: string; unit_price: number }>(db, `SELECT contact_id, line_id, unit_price FROM rfq_quotes WHERE rfq_id = ?`, id);
  return { rfq: r, lines, suppliers, quotes };
}

/** The RFQ with each supplier's prices side by side, their totals, and the lowest price per line. */
purchasing.get("/rfqs/:id", async (c) => {
  requirePerm(c, "purchase.view");
  const co = c.get("company");
  const x = await loadRfq(c.env.DB, co.id, c.req.param("id"));
  const totals = x.suppliers.map((s) => {
    const qs = x.quotes.filter((q) => q.contact_id === s.contact_id);
    const complete = x.lines.every((l) => qs.some((q) => q.line_id === l.id));
    return { contact_id: s.contact_id, total: x.lines.reduce((t, l) => t + Math.round(((qs.find((q) => q.line_id === l.id)?.unit_price ?? 0) * l.qty_milli) / 1000), 0), complete };
  });
  const quoted = totals.filter((t) => t.complete && x.suppliers.find((s) => s.contact_id === t.contact_id)?.status === "quoted");
  const best = quoted.sort((a, b) => a.total - b.total)[0]?.contact_id ?? null;
  const lowest = Object.fromEntries(x.lines.map((l) => {
    const ps = x.quotes.filter((q) => q.line_id === l.id).map((q) => q.unit_price);
    return [l.id, ps.length ? Math.min(...ps) : null];
  }));
  return c.json({ ...x, totals, best, lowest });
});

/** Send: every supplier gets (or keeps) their private portal link, where the RFQ now appears for them to quote. */
purchasing.post("/rfqs/:id/send", async (c) => {
  requirePerm(c, "purchase.create");
  const co = c.get("company");
  const x = await loadRfq(c.env.DB, co.id, c.req.param("id"));
  if (x.rfq.status !== "draft" && x.rfq.status !== "sent") throw conflict("CLOSED", "This RFQ is closed");
  const links = [];
  for (const s of x.suppliers) {
    const token = await portalToken(c.env, co.id, s.contact_id, c.get("user").id);
    links.push({ contact_id: s.contact_id, name: s.name, url: `${siteUrl(c.env, c.req.url)}/portal/${token}` });
  }
  await batch(c.env.DB, [
    stmt(c.env.DB, `UPDATE rfqs SET status = 'sent' WHERE id = ?`, x.rfq.id),
    audit(c, "rfq.send", "rfq", x.rfq.id, { number: x.rfq.number, suppliers: links.length }),
  ]);
  return c.json({ links });
});

const quoteSchema = z.object({
  prices: z.array(z.object({ line_id: idStr, unit_price: z.union([z.string(), z.number()]) })).max(100),
  delivery_days: z.number().int().min(0).max(3650).nullish(),
  valid_until: isoDate.nullish(),
  notes: shortText(500).nullish(),
});

/** Save a supplier's quotation (from the portal, or typed in by the buyer from an email or a call). */
export async function saveQuote(db: D1Database, companyId: string, rfqId: string, contactId: string, input: z.infer<typeof quoteSchema>, enteredBy: string | null) {
  const x = await loadRfq(db, companyId, rfqId);
  if (x.rfq.status !== "sent") throw conflict("NOT_OPEN", x.rfq.status === "draft" ? "Send the RFQ first" : "This RFQ is closed");
  const s = x.suppliers.find((y) => y.contact_id === contactId);
  if (!s) throw notFound("RFQ");
  const co = await first<{ base_currency: string }>(db, `SELECT base_currency FROM companies WHERE id = ?`, companyId);
  const exp = currencyExponent(s.currency || co!.base_currency);
  const prices = input.prices.map((p) => {
    if (!x.lines.some((l) => l.id === p.line_id)) throw badRequest("Unknown line");
    return { line_id: p.line_id, unit_price: minor(p.unit_price, exp, "price") };
  });
  if (!prices.length) throw badRequest("Give a price for at least one line");
  await batch(db, [
    stmt(db, `DELETE FROM rfq_quotes WHERE rfq_id = ? AND contact_id = ?`, rfqId, contactId),
    ...prices.map((p) => stmt(db, `INSERT INTO rfq_quotes (rfq_id, contact_id, line_id, unit_price) VALUES (?,?,?,?)`, rfqId, contactId, p.line_id, p.unit_price)),
    stmt(db, `UPDATE rfq_suppliers SET status = 'quoted', delivery_days = ?, valid_until = ?, notes = ?, quoted_at = ?, entered_by = ? WHERE rfq_id = ? AND contact_id = ?`,
      input.delivery_days ?? null, input.valid_until ?? null, input.notes ?? null, new Date().toISOString(), enteredBy, rfqId, contactId),
  ]);
  return prices.length;
}
export { quoteSchema };

purchasing.post("/rfqs/:id/quotes/:contactId", async (c) => {
  requirePerm(c, "purchase.create");
  const input = await body(c, quoteSchema);
  const n = await saveQuote(c.env.DB, c.get("company").id, c.req.param("id"), c.req.param("contactId"), input, c.get("user").id);
  await batch(c.env.DB, [audit(c, "rfq.quote_entered", "rfq", c.req.param("id"), { contact_id: c.req.param("contactId"), lines: n })]);
  return c.json({ ok: true });
});

/** Award: a draft purchase order to the chosen supplier at their quoted prices. */
purchasing.post("/rfqs/:id/award", async (c) => {
  requirePerm(c, "purchase.create");
  const co = c.get("company");
  const input = await body(c, z.object({ contact_id: idStr }));
  const x = await loadRfq(c.env.DB, co.id, c.req.param("id"));
  if (x.rfq.status !== "sent") throw conflict("NOT_OPEN", "Only a sent RFQ can be awarded");
  const s = x.suppliers.find((y) => y.contact_id === input.contact_id);
  if (!s || s.status !== "quoted") throw badRequest("This supplier has not quoted");
  const qs = x.quotes.filter((q) => q.contact_id === input.contact_id);
  const lines = x.lines.filter((l) => qs.some((q) => q.line_id === l.id));
  if (!lines.length) throw badRequest("This supplier quoted no lines");
  const items = await all<{ id: string; tax_code_id: string | null; hsn_sac: string | null }>(c.env.DB, `SELECT id, tax_code_id, hsn_sac FROM items WHERE company_id = ? AND id IN (${lines.map(() => "?").join(",") || "''"})`, co.id, ...lines.map((l) => l.item_id ?? ""));
  const prepared = await prepareDraft(c, {
    doc_type: "purchase_order", contact_id: input.contact_id, issue_date: todayIso(), currency: s.currency || co.base_currency, reference: x.rfq.number,
    notes: [x.rfq.title, s.delivery_days != null ? `Delivery within ${s.delivery_days} days as quoted.` : null].filter(Boolean).join("\n"),
    lines: lines.map((l) => {
      const it = items.find((i) => i.id === l.item_id);
      return { item_id: l.item_id, description: l.description, qty_milli: l.qty_milli, unit_price: qs.find((q) => q.line_id === l.id)!.unit_price, discount_bp: 0, tax_code_id: it?.tax_code_id ?? null, hsn_sac: it?.hsn_sac ?? null };
    }),
  });
  await batch(c.env.DB, [
    ...prepared.stmts,
    stmt(c.env.DB, `UPDATE rfqs SET status = 'awarded', awarded_contact_id = ?, po_id = ? WHERE id = ?`, input.contact_id, prepared.id, x.rfq.id),
    audit(c, "rfq.award", "rfq", x.rfq.id, { number: x.rfq.number, supplier: s.name, po_id: prepared.id }),
  ]);
  return c.json({ po_id: prepared.id }, 201);
});

purchasing.post("/rfqs/:id/cancel", async (c) => {
  requirePerm(c, "purchase.create");
  const x = await loadRfq(c.env.DB, c.get("company").id, c.req.param("id"));
  if (x.rfq.status === "awarded" || x.rfq.status === "cancelled") throw conflict("CLOSED", "This RFQ is already closed");
  await batch(c.env.DB, [stmt(c.env.DB, `UPDATE rfqs SET status = 'cancelled' WHERE id = ?`, x.rfq.id), audit(c, "rfq.cancel", "rfq", x.rfq.id, { number: x.rfq.number })]);
  return c.json({ ok: true });
});

// ── Goods receipt notes and the 3-way match ──

/** Per line of a purchase order: ordered, received, accepted, rejected and billed, with the bill's price. */
export async function poMatch(db: D1Database, companyId: string, poId: string) {
  const po = await first<{ id: string; number: string; contact_id: string; status: string; doc_type: string; currency: string }>(db, `SELECT id, number, contact_id, status, doc_type, currency FROM documents WHERE id = ? AND company_id = ?`, poId, companyId);
  if (!po || po.doc_type !== "purchase_order") throw notFound("Purchase order");
  const lines = await all<{ line_no: number; item_id: string | null; description: string; qty_milli: number; unit_price: number }>(db,
    `SELECT line_no, item_id, description, qty_milli, unit_price FROM document_lines WHERE document_id = ? ORDER BY line_no`, poId);
  const recv = await all<{ po_line_no: number; received: number; accepted: number; rejected: number }>(db,
    `SELECT l.po_line_no, SUM(l.received_milli) AS received, SUM(l.accepted_milli) AS accepted, SUM(l.rejected_milli) AS rejected
       FROM grn_lines l JOIN grns g ON g.id = l.grn_id WHERE g.company_id = ? AND g.po_id = ? AND g.status = 'posted' GROUP BY l.po_line_no`, companyId, poId);
  const billed = await all<{ item_id: string | null; description: string; qty_milli: number; unit_price: number; number: string }>(db,
    `SELECT l.item_id, l.description, l.qty_milli, l.unit_price, d.number FROM document_lines l JOIN documents d ON d.id = l.document_id
      WHERE d.company_id = ? AND d.related_doc_id = ? AND d.doc_type = 'bill' AND d.status = 'posted'`, companyId, poId);
  const used = new Set<number>();
  const rows = lines.map((l) => {
    const r = recv.find((x) => x.po_line_no === l.line_no);
    const b = billed.filter((x, i) => !used.has(i) && (l.item_id ? x.item_id === l.item_id : x.description === l.description));
    billed.forEach((x, i) => { if (b.includes(x)) used.add(i); });
    const billedQty = b.reduce((s, x) => s + x.qty_milli, 0);
    const maxPrice = b.length ? Math.max(...b.map((x) => x.unit_price)) : null;
    const accepted = r?.accepted ?? 0;
    const issues: string[] = [];
    if (accepted < l.qty_milli && (r || billedQty)) issues.push("short_receipt");
    if (billedQty > accepted) issues.push("billed_more_than_received");
    if (maxPrice != null && maxPrice > l.unit_price) issues.push("price_above_order");
    if ((r?.rejected ?? 0) > 0) issues.push("rejected");
    return { line_no: l.line_no, description: l.description, ordered: l.qty_milli, received: r?.received ?? 0, accepted, rejected: r?.rejected ?? 0, billed: billedQty, order_price: l.unit_price, bill_price: maxPrice, bills: [...new Set(b.map((x) => x.number))], issues };
  });
  const status = rows.some((r) => r.issues.includes("billed_more_than_received") || r.issues.includes("price_above_order")) ? "mismatch"
    : rows.every((r) => r.accepted >= r.ordered && r.billed >= r.ordered) ? "matched" : rows.some((r) => r.received || r.billed) ? "partial" : "open";
  return { po, rows, status };
}

purchasing.get("/grns", async (c) => {
  requirePerm(c, "purchase.view");
  const rows = await all(c.env.DB,
    `SELECT g.*, ct.name AS supplier, d.number AS po_number, (SELECT SUM(rejected_milli) FROM grn_lines WHERE grn_id = g.id) AS rejected
       FROM grns g JOIN contacts ct ON ct.id = g.contact_id JOIN documents d ON d.id = g.po_id WHERE g.company_id = ? ORDER BY g.receipt_date DESC, g.created_at DESC LIMIT 300`, c.get("company").id);
  return c.json({ grns: rows });
});

purchasing.get("/grns/:id", async (c) => {
  requirePerm(c, "purchase.view");
  const g = await first(c.env.DB, `SELECT g.*, ct.name AS supplier, d.number AS po_number FROM grns g JOIN contacts ct ON ct.id = g.contact_id JOIN documents d ON d.id = g.po_id WHERE g.id = ? AND g.company_id = ?`, c.req.param("id"), c.get("company").id);
  if (!g) throw notFound("Goods receipt");
  return c.json({ grn: g, lines: await all(c.env.DB, `SELECT * FROM grn_lines WHERE grn_id = ? ORDER BY po_line_no`, c.req.param("id")) });
});

purchasing.post("/grns", async (c) => {
  requirePerm(c, "purchase.create");
  const co = c.get("company");
  const input = await body(c, z.object({
    po_id: idStr, receipt_date: isoDate.optional(), supplier_ref: shortText(60).nullish(), notes: shortText(500).nullish(),
    lines: z.array(z.object({ line_no: z.number().int().min(1), received: z.union([z.string(), z.number()]), rejected: z.union([z.string(), z.number()]).optional(), reject_reason: shortText(200).nullish() })).min(1).max(200),
  }));
  const po = await first<{ id: string; contact_id: string; status: string; doc_type: string; number: string }>(c.env.DB, `SELECT id, contact_id, status, doc_type, number FROM documents WHERE id = ? AND company_id = ?`, input.po_id, co.id);
  if (!po || po.doc_type !== "purchase_order") throw notFound("Purchase order");
  if (!["open", "accepted", "converted"].includes(po.status)) throw conflict("NOT_ISSUED", "Issue the purchase order before receiving goods against it");
  const poLines = await all<{ line_no: number; item_id: string | null; description: string; qty_milli: number }>(c.env.DB, `SELECT line_no, item_id, description, qty_milli FROM document_lines WHERE document_id = ?`, po.id);
  const id = newId();
  const number = await nextNumber(c.env.DB, "grns", co.id, "GRN-");
  const stmts = [stmt(c.env.DB, `INSERT INTO grns (id, company_id, number, po_id, contact_id, receipt_date, supplier_ref, notes, created_by) VALUES (?,?,?,?,?,?,?,?,?)`,
    id, co.id, number, po.id, po.contact_id, input.receipt_date ?? todayIso(), input.supplier_ref ?? null, input.notes ?? null, c.get("user").id)];
  let any = false;
  for (const l of input.lines) {
    const pl = poLines.find((x) => x.line_no === l.line_no);
    if (!pl) throw badRequest(`Line ${l.line_no} is not on the purchase order`);
    const received = qty(l.received, "quantity received");
    const rejected = l.rejected ? qty(l.rejected, "quantity rejected") : 0;
    if (received < 0 || rejected < 0) throw badRequest("Quantities cannot be negative");
    if (rejected > received) throw badRequest(`Line ${l.line_no}: more rejected than received`);
    if (rejected > 0 && !l.reject_reason) throw badRequest(`Line ${l.line_no}: give the reason for rejecting`);
    if (!received) continue;
    any = true;
    stmts.push(stmt(c.env.DB, `INSERT INTO grn_lines (id, grn_id, po_line_no, item_id, description, received_milli, accepted_milli, rejected_milli, reject_reason) VALUES (?,?,?,?,?,?,?,?,?)`,
      newId(), id, l.line_no, pl.item_id, pl.description, received, received - rejected, rejected, l.reject_reason ?? null));
  }
  if (!any) throw badRequest("Enter the quantity received on at least one line");
  stmts.push(audit(c, "grn.create", "grn", id, { number, po: po.number }));
  await batch(c.env.DB, stmts);
  return c.json({ id, number }, 201);
});

purchasing.post("/grns/:id/void", async (c) => {
  requirePerm(c, "purchase.void");
  const g = await first<{ status: string; number: string }>(c.env.DB, `SELECT status, number FROM grns WHERE id = ? AND company_id = ?`, c.req.param("id"), c.get("company").id);
  if (!g) throw notFound("Goods receipt");
  if (g.status === "void") throw conflict("ALREADY_VOID", "Already cancelled");
  const input = await body(c, z.object({ reason: shortText(200).nullish() }));
  await batch(c.env.DB, [stmt(c.env.DB, `UPDATE grns SET status = 'void' WHERE id = ?`, c.req.param("id")), audit(c, "grn.void", "grn", c.req.param("id"), { number: g.number, reason: input.reason ?? null })]);
  return c.json({ ok: true });
});

purchasing.get("/match/:poId", async (c) => {
  requirePerm(c, "purchase.view");
  return c.json(await poMatch(c.env.DB, c.get("company").id, c.req.param("poId")));
});

/** Every open or recent purchase order with its match status. */
purchasing.get("/match", async (c) => {
  requireAnyPerm(c, "purchase.view");
  const co = c.get("company");
  const pos = await all<{ id: string; number: string; issue_date: string; supplier: string; total: number; currency: string }>(c.env.DB,
    `SELECT d.id, d.number, d.issue_date, ct.name AS supplier, d.total, d.currency FROM documents d JOIN contacts ct ON ct.id = d.contact_id
      WHERE d.company_id = ? AND d.doc_type = 'purchase_order' AND d.status IN ('open','accepted','converted','closed') ORDER BY d.issue_date DESC LIMIT 100`, co.id);
  const out = [];
  for (const p of pos) {
    const m = await poMatch(c.env.DB, co.id, p.id);
    out.push({ ...p, status: m.status, issues: [...new Set(m.rows.flatMap((r) => r.issues))] });
  }
  return c.json({ orders: out });
});
