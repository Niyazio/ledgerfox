import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { all, batch, first, stmt, todayIso } from "../lib/db";
import { AppError, badRequest, conflict, notFound } from "../lib/errors";
import { body, idStr, isoDate, minor, optId, reqText } from "../lib/validate";
import { newId, randomToken, sha256Hex } from "../lib/crypto";
import { audit, hasPerm, requireAnyPerm, requirePerm } from "../lib/auth";
import { currencyExponent } from "@shared/currencies";
import { ROLES, type Role } from "@shared/permissions";
import { assertOpenPeriod, buildJournal, buildReversal, systemAccounts } from "../services/ledger";
import { stockMoveStmt } from "../services/inventory";
import { lookupRate } from "../services/documents";

/** Landed cost, approval rules, foreign-currency revaluation, and API keys. */
export const advanced = new Hono<AppEnv>();

const RATE = 1_000_000_000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

// ── Landed cost ──

advanced.get("/landed-costs", async (c) => {
  requirePerm(c, "purchase.view");
  const rows = await all(c.env.DB, `SELECT lc.*, d.number AS bill_number, ct.name AS supplier, a.name AS credit_account FROM landed_costs lc JOIN documents d ON d.id = lc.bill_id
      JOIN contacts ct ON ct.id = d.contact_id JOIN accounts a ON a.id = lc.credit_account_id WHERE lc.company_id = ? ORDER BY lc.cost_date DESC LIMIT 200`, c.get("company").id);
  return c.json({ landed_costs: rows.map((r: any) => ({ ...r, details: JSON.parse(r.details) })) });
});

/** The stock lines of a posted bill a landed cost can be spread over. */
async function billStock(db: D1Database, companyId: string, billId: string) {
  const bill = await first<{ id: string; number: string; doc_type: string; status: string; issue_date: string }>(db, `SELECT id, number, doc_type, status, issue_date FROM documents WHERE id = ? AND company_id = ?`, billId, companyId);
  if (!bill || bill.doc_type !== "bill") throw notFound("Bill");
  if (bill.status !== "posted") throw conflict("NOT_POSTED", "Post the bill first");
  const lines = await all<{ item_id: string; warehouse_id: string; name: string; qty_milli: number; value: number; on_hand: number }>(db,
    `SELECT m.item_id, m.warehouse_id, i.name, SUM(m.qty_milli) AS qty_milli, SUM(m.value) AS value,
            (SELECT COALESCE(SUM(x.qty_milli), 0) FROM stock_moves x WHERE x.company_id = m.company_id AND x.item_id = m.item_id) AS on_hand
       FROM stock_moves m JOIN items i ON i.id = m.item_id
      WHERE m.company_id = ? AND m.source_id = ? AND m.qty_milli > 0 GROUP BY m.item_id, m.warehouse_id`, companyId, billId);
  return { bill, lines };
}

advanced.get("/landed-costs/bill/:id", async (c) => {
  requirePerm(c, "purchase.view");
  return c.json(await billStock(c.env.DB, c.get("company").id, c.req.param("id")));
});

/** Split an amount over weights so the parts add up exactly. */
export function allocate(total: number, weights: number[]) {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (sum <= 0) throw badRequest("Nothing to spread the cost over");
  const parts = weights.map((w) => Math.floor((total * w) / sum));
  let rest = total - parts.reduce((s, p) => s + p, 0);
  for (let i = 0; rest > 0; i = (i + 1) % parts.length) if (weights[i] > 0) { parts[i]++; rest--; }
  return parts;
}

advanced.post("/landed-costs", async (c) => {
  requirePerm(c, "purchase.post");
  requirePerm(c, "items.cost");
  const co = c.get("company");
  const input = await body(c, z.object({
    bill_id: idStr, cost_date: isoDate.optional(), method: z.enum(["value", "quantity"]).default("value"), credit_account_id: idStr,
    charges: z.array(z.object({ description: reqText(120), amount: z.union([z.string(), z.number()]) })).min(1).max(20),
  }));
  const { bill, lines } = await billStock(c.env.DB, co.id, input.bill_id);
  if (!lines.length) throw badRequest("This bill has no stock items to add the cost to");
  const sold = lines.filter((l) => l.on_hand <= 0);
  if (sold.length) throw badRequest(`${sold.map((l) => l.name).join(", ")}: none left in stock, so the cost cannot go into stock. Book it as an expense instead.`);
  const acc = await first<{ type: string; is_group: number }>(c.env.DB, `SELECT type, is_group FROM accounts WHERE id = ? AND company_id = ? AND is_active = 1`, input.credit_account_id, co.id);
  if (!acc || acc.is_group) throw badRequest("Choose the account the charges were booked to (e.g. Freight, or the supplier's payable)");
  const exp = currencyExponent(co.base_currency);
  const charges = input.charges.map((x) => ({ description: x.description, amount: minor(x.amount, exp) }));
  const total = charges.reduce((s, x) => s + x.amount, 0);
  if (total <= 0) throw badRequest("Enter the charges");
  const date = input.cost_date ?? todayIso();
  if (date < bill.issue_date) throw badRequest("The landed cost cannot be dated before the bill");
  await assertOpenPeriod(c.env.DB, co.id, date);
  const parts = allocate(total, lines.map((l) => (input.method === "value" ? l.value : l.qty_milli)));
  const sys = await systemAccounts(c.env.DB, co.id, ["INVENTORY"]);
  const id = newId();
  const memo = `Landed cost on ${bill.number}: ${charges.map((x) => x.description).join(", ")}`;
  const j = buildJournal(c.env.DB, {
    company_id: co.id, entry_date: date, kind: "system", memo, source_type: "landed_cost", source_id: id, created_by: c.get("user").id, post: true,
    lines: [{ account_id: sys.INVENTORY, debit: total }, { account_id: input.credit_account_id, credit: total }],
  });
  // Value only: a matched pair of tiny moves adds the cost to the stock value without changing the quantity.
  const moves = lines.flatMap((l, i) => parts[i] > 0 ? [
    stockMoveStmt(c.env.DB, { company_id: co.id, item_id: l.item_id, warehouse_id: l.warehouse_id, move_date: date, qty_milli: 1, value: parts[i], kind: "adjustment", source_type: "landed_cost", source_id: id, journal_entry_id: j.id, memo, created_by: c.get("user").id }),
    stockMoveStmt(c.env.DB, { company_id: co.id, item_id: l.item_id, warehouse_id: l.warehouse_id, move_date: date, qty_milli: -1, value: 0, kind: "adjustment", source_type: "landed_cost", source_id: id, journal_entry_id: j.id, memo, created_by: c.get("user").id }),
  ] : []);
  const details = { charges, lines: lines.map((l, i) => ({ item_id: l.item_id, name: l.name, qty_milli: l.qty_milli, value: l.value, added: parts[i] })) };
  await batch(c.env.DB, [
    ...j.stmts, ...moves,
    stmt(c.env.DB, `INSERT INTO landed_costs (id, company_id, bill_id, cost_date, method, total, credit_account_id, journal_entry_id, details, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      id, co.id, bill.id, date, input.method, total, input.credit_account_id, j.id, JSON.stringify(details), c.get("user").id),
    audit(c, "landed_cost.create", "landed_cost", id, { bill: bill.number, total, method: input.method }),
  ]);
  return c.json({ id, journal_entry_id: j.id, ...details }, 201);
});

// ── Approval rules ──

export const APPROVAL_DOC_TYPES = ["purchase_order", "bill", "debit_note", "invoice", "credit_note", "quote", "sales_order"] as const;

advanced.get("/approval-rules", async (c) => {
  requireAnyPerm(c, "company.manage", "purchase.approve");
  return c.json({ rules: await all(c.env.DB, `SELECT * FROM approval_rules WHERE company_id = ? AND is_active = 1 ORDER BY doc_type, step, min_amount`, c.get("company").id), roles: ROLES });
});

advanced.put("/approval-rules", async (c) => {
  requirePerm(c, "company.manage");
  const co = c.get("company");
  const input = await body(c, z.object({ rules: z.array(z.object({
    doc_type: z.enum(APPROVAL_DOC_TYPES), min_amount: z.union([z.string(), z.number()]), approver_role: z.enum(ROLES as unknown as [Role, ...Role[]]), step: z.number().int().min(1).max(5),
  })).max(40) }));
  const exp = currencyExponent(co.base_currency);
  await batch(c.env.DB, [
    stmt(c.env.DB, `UPDATE approval_rules SET is_active = 0 WHERE company_id = ?`, co.id),
    ...input.rules.map((r) => stmt(c.env.DB, `INSERT INTO approval_rules (id, company_id, doc_type, min_amount, approver_role, step) VALUES (?,?,?,?,?,?)`,
      newId(), co.id, r.doc_type, minor(r.min_amount || "0", exp), r.approver_role, r.step)),
    audit(c, "approval_rules.update", "company", co.id, { rules: input.rules.length }),
  ]);
  return c.json({ ok: true });
});

/** The approval steps a document needs (by its type and amount), and which are done. */
export async function approvalStatus(db: D1Database, companyId: string, documentId: string) {
  const d = await first<{ id: string; doc_type: string; total_base: number; status: string; number: string | null; created_by: string }>(db,
    `SELECT id, doc_type, total_base, status, number, created_by FROM documents WHERE id = ? AND company_id = ?`, documentId, companyId);
  if (!d) throw notFound("Document");
  const rules = await all<{ id: string; step: number; approver_role: string; min_amount: number }>(db,
    `SELECT id, step, approver_role, min_amount FROM approval_rules WHERE company_id = ? AND is_active = 1 AND doc_type = ? AND min_amount <= ? ORDER BY step, min_amount`, companyId, d.doc_type, d.total_base);
  const done = await all<{ rule_id: string; approved_by: string; approved_at: string; name: string }>(db,
    `SELECT s.rule_id, s.approved_by, s.approved_at, u.name FROM document_approval_steps s JOIN users u ON u.id = s.approved_by WHERE s.document_id = ?`, documentId);
  const steps = rules.map((r) => ({ ...r, approved: done.find((x) => x.rule_id === r.id) ?? null }));
  return { document: d, steps, complete: steps.every((s) => s.approved) };
}

/** Called before a document is issued: every step must be approved (the owner may issue without). */
export async function requireRuleApprovals(c: Context<AppEnv>, documentId: string) {
  if (c.get("role") === "owner") return;
  const s = await approvalStatus(c.env.DB, c.get("company").id, documentId);
  const open = s.steps.find((x) => !x.approved);
  if (open) throw new AppError(403, "APPROVAL_REQUIRED", `This needs approval by ${open.approver_role} (step ${open.step}) before it can be issued. Ask them to approve it in Approvals.`);
}

advanced.get("/approvals/:documentId", async (c) => {
  requireAnyPerm(c, "sales.view", "purchase.view");
  return c.json(await approvalStatus(c.env.DB, c.get("company").id, c.req.param("documentId")));
});

/** Drafts waiting for my approval: the next open step is for my role (or I am the owner). */
advanced.get("/approvals", async (c) => {
  requireAnyPerm(c, "sales.view", "purchase.view");
  const co = c.get("company");
  const drafts = await all<{ id: string; doc_type: string; number: string | null; issue_date: string; total: number; currency: string; party: string }>(c.env.DB,
    `SELECT d.id, d.doc_type, d.number, d.issue_date, d.total, d.currency, ct.name AS party FROM documents d JOIN contacts ct ON ct.id = d.contact_id
      WHERE d.company_id = ? AND d.status = 'draft' AND EXISTS (SELECT 1 FROM approval_rules r WHERE r.company_id = d.company_id AND r.is_active = 1 AND r.doc_type = d.doc_type AND r.min_amount <= d.total_base)
      ORDER BY d.issue_date LIMIT 200`, co.id);
  const out = [];
  for (const d of drafts) {
    const s = await approvalStatus(c.env.DB, co.id, d.id);
    const next = s.steps.find((x) => !x.approved);
    if (!next) continue;
    out.push({ ...d, next_step: next.step, next_role: next.approver_role, steps: s.steps.length, done: s.steps.filter((x) => x.approved).length, mine: c.get("role") === "owner" || c.get("role") === next.approver_role });
  }
  return c.json({ pending: out });
});

advanced.post("/approvals/:documentId/approve", async (c) => {
  const co = c.get("company");
  const input = await body(c, z.object({ note: z.string().trim().max(300).nullish() }));
  const s = await approvalStatus(c.env.DB, co.id, c.req.param("documentId"));
  if (s.document.status !== "draft") throw conflict("INVALID_STATUS", "Only drafts are approved");
  const next = s.steps.find((x) => !x.approved);
  if (!next) throw conflict("ALREADY_APPROVED", "Nothing left to approve");
  const role = c.get("role");
  if (role !== "owner" && role !== next.approver_role) throw new AppError(403, "NOT_APPROVER", `Step ${next.step} is approved by ${next.approver_role}`);
  if (s.document.created_by === c.get("user").id && role !== "owner") throw new AppError(403, "SELF_APPROVAL", "You cannot approve a document you made");
  if (s.steps.some((x) => x.approved?.approved_by === c.get("user").id) && role !== "owner") throw new AppError(403, "SAME_APPROVER", "Another person must approve the next step");
  await batch(c.env.DB, [
    stmt(c.env.DB, `INSERT INTO document_approval_steps (document_id, rule_id, company_id, approved_by, note) VALUES (?,?,?,?,?)`, s.document.id, next.id, co.id, c.get("user").id, input.note ?? null),
    audit(c, `${s.document.doc_type}.approved_step`, "document", s.document.id, { step: next.step, role: next.approver_role, note: input.note ?? null }),
  ]);
  return c.json({ ok: true, step: next.step, complete: s.steps.filter((x) => !x.approved).length === 1 });
});

// ── Foreign-currency revaluation ──

interface FxRow { document_id: string; number: string; doc_type: string; contact_id: string; party: string; currency: string; outstanding_fc: number; booked_rate: number; new_rate: number; booked_base: number; new_base: number; difference: number }

/** Open foreign-currency invoices and bills: what they are worth at the rate on `asOf`, against the rate they were booked at. */
export async function fxRevaluation(db: D1Database, co: AppEnv["Variables"]["company"], asOf: string) {
  const docs = await all<{ id: string; number: string; doc_type: string; contact_id: string; party: string; currency: string; fx_rate_scaled: number; outstanding: number }>(db,
    `SELECT d.id, d.number, d.doc_type, d.contact_id, ct.name AS party, d.currency, d.fx_rate_scaled, d.total - d.amount_settled AS outstanding
       FROM documents d JOIN contacts ct ON ct.id = d.contact_id
      WHERE d.company_id = ? AND d.status = 'posted' AND d.doc_type IN ('invoice','bill') AND d.currency <> ? AND d.total > d.amount_settled AND d.issue_date <= ?
      ORDER BY d.currency, d.issue_date`, co.id, co.base_currency, asOf);
  const rows: FxRow[] = [];
  const missing = new Set<string>();
  const baseExp = currencyExponent(co.base_currency);
  for (const d of docs) {
    const rate = await lookupRate(db, co, d.currency, asOf);
    if (!rate) { missing.add(d.currency); continue; }
    const scale = 10 ** (baseExp - currencyExponent(d.currency));
    const booked = Math.round((d.outstanding * d.fx_rate_scaled * scale) / RATE);
    const now = Math.round((d.outstanding * rate * scale) / RATE);
    // Receivable worth more = gain; payable worth more = loss.
    const difference = d.doc_type === "invoice" ? now - booked : booked - now;
    if (difference) rows.push({ document_id: d.id, number: d.number, doc_type: d.doc_type, contact_id: d.contact_id, party: d.party, currency: d.currency, outstanding_fc: d.outstanding, booked_rate: d.fx_rate_scaled, new_rate: rate, booked_base: booked, new_base: now, difference });
  }
  return { rows, missing_rates: [...missing], total: rows.reduce((s, r) => s + r.difference, 0) };
}

advanced.get("/fx-revaluation", async (c) => {
  requireAnyPerm(c, "reports.read", "journal.post");
  const asOf = c.req.query("as_of") || todayIso();
  const done = await all(c.env.DB, `SELECT id, as_of, total, journal_entry_id, reversal_entry_id, created_at FROM fx_revaluations WHERE company_id = ? ORDER BY as_of DESC LIMIT 24`, c.get("company").id);
  return c.json({ as_of: asOf, ...(await fxRevaluation(c.env.DB, c.get("company"), asOf)), history: done });
});

/** Post the revaluation on `as_of` (unrealised gain / loss against receivables and payables) and its reversal the next day. */
advanced.post("/fx-revaluation", async (c) => {
  requirePerm(c, "journal.post");
  const co = c.get("company");
  const input = await body(c, z.object({ as_of: isoDate }));
  if (await first(c.env.DB, `SELECT 1 FROM fx_revaluations WHERE company_id = ? AND as_of = ?`, co.id, input.as_of)) throw conflict("ALREADY_DONE", "Revaluation for this date is already posted");
  const r = await fxRevaluation(c.env.DB, co, input.as_of);
  if (r.missing_rates.length) throw badRequest(`Enter the exchange rate for ${r.missing_rates.join(", ")} on or before ${input.as_of} first (Settings → Currencies)`);
  if (!r.rows.length) throw badRequest("Nothing to revalue: no open foreign-currency invoices or bills, or the rates have not changed");
  await assertOpenPeriod(c.env.DB, co.id, input.as_of);
  await assertOpenPeriod(c.env.DB, co.id, addDays(input.as_of, 1));
  const acc = await systemAccounts(c.env.DB, co.id, ["AR", "AP", "FX_GAIN_LOSS"]);
  const lines = r.rows.flatMap((x) => {
    const control = x.doc_type === "invoice" ? acc.AR : acc.AP;
    const up = x.new_base > x.booked_base; // the balance in base currency grows
    const amt = Math.abs(x.new_base - x.booked_base);
    const controlLine = x.doc_type === "invoice" ? (up ? { debit: amt } : { credit: amt }) : (up ? { credit: amt } : { debit: amt });
    const fxLine = "debit" in controlLine ? { credit: amt } : { debit: amt };
    return [{ account_id: control, contact_id: x.contact_id, description: `${x.number} ${x.currency}`, ...controlLine }, { account_id: acc.FX_GAIN_LOSS, description: `Unrealised exchange difference ${x.number}`, ...fxLine }];
  });
  const id = newId();
  const j = buildJournal(c.env.DB, { company_id: co.id, entry_date: input.as_of, kind: "system", memo: `Foreign-currency revaluation at ${input.as_of}`, source_type: "fx_revaluation", source_id: id, created_by: c.get("user").id, post: true, lines });
  await batch(c.env.DB, [...j.stmts,
    stmt(c.env.DB, `INSERT INTO fx_revaluations (id, company_id, as_of, total, journal_entry_id, details, created_by) VALUES (?,?,?,?,?,?,?)`, id, co.id, input.as_of, r.total, j.id, JSON.stringify(r.rows), c.get("user").id)]);
  const rev = await buildReversal(c.env.DB, co.id, j.id, addDays(input.as_of, 1), c.get("user").id, `Reversal of revaluation at ${input.as_of}`, { allowSourced: true });
  await batch(c.env.DB, [...rev.stmts, stmt(c.env.DB, `UPDATE fx_revaluations SET reversal_entry_id = ? WHERE id = ?`, rev.id, id),
    audit(c, "fx.revaluation", "fx_revaluation", id, { as_of: input.as_of, total: r.total, documents: r.rows.length })]);
  return c.json({ id, journal_entry_id: j.id, reversal_entry_id: rev.id, total: r.total }, 201);
});

// ── API keys ──

advanced.get("/api-keys", async (c) => {
  requirePerm(c, "company.manage");
  return c.json({ keys: await all(c.env.DB, `SELECT k.id, k.name, k.prefix, k.access, k.created_at, k.last_used_at, k.revoked_at, u.name AS created_by FROM api_keys k LEFT JOIN users u ON u.id = k.created_by WHERE k.company_id = ? ORDER BY k.created_at DESC`, c.get("company").id) });
});

/** A new key is shown once; only its hash is kept. */
advanced.post("/api-keys", async (c) => {
  requirePerm(c, "company.manage");
  const co = c.get("company");
  const input = await body(c, z.object({ name: reqText(80), access: z.enum(["read", "write"]).default("read") }));
  if (input.access === "write" && !hasPerm(c, "sales.post")) throw badRequest("You need permission to issue invoices to make a write key");
  const key = `lfk_${randomToken(32)}`;
  const id = newId();
  await batch(c.env.DB, [
    stmt(c.env.DB, `INSERT INTO api_keys (id, company_id, name, prefix, key_hash, access, created_by) VALUES (?,?,?,?,?,?,?)`, id, co.id, input.name, key.slice(0, 10), await sha256Hex(key), input.access, c.get("user").id),
    audit(c, "api_key.create", "api_key", id, { name: input.name, access: input.access }),
  ]);
  return c.json({ id, key, company_id: co.id }, 201);
});

advanced.post("/api-keys/:id/revoke", async (c) => {
  requirePerm(c, "company.manage");
  const k = await first<{ name: string; revoked_at: string | null }>(c.env.DB, `SELECT name, revoked_at FROM api_keys WHERE id = ? AND company_id = ?`, c.req.param("id"), c.get("company").id);
  if (!k) throw notFound("API key");
  if (k.revoked_at) throw conflict("ALREADY_REVOKED", "Already revoked");
  await batch(c.env.DB, [stmt(c.env.DB, `UPDATE api_keys SET revoked_at = ? WHERE id = ?`, new Date().toISOString(), c.req.param("id")), audit(c, "api_key.revoke", "api_key", c.req.param("id"), { name: k.name })]);
  return c.json({ ok: true });
});

void optId;
