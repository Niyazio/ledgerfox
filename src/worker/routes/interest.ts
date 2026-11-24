import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, CompanyRow } from "../env";
import { all, batch, first, stmt, todayIso } from "../lib/db";
import { badRequest } from "../lib/errors";
import { body, idStr, isoDate } from "../lib/validate";
import { audit, requireAnyPerm, requirePerm } from "../lib/auth";
import { prepareDraft } from "../services/documents";

/**
 * Interest on overdue invoices: simple interest at the company's yearly rate on what is still unpaid, from the due date
 * (plus any days of grace), or from the date interest was last billed, up to the chosen date. One click makes a draft
 * interest invoice per customer, to check and issue like any other invoice.
 */
export const interest = new Hono<AppEnv>();

const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export interface InterestRow { document_id: string; number: string; contact_id: string; party: string; currency: string; due_date: string; from: string; days: number; outstanding: number; interest: number }

export async function overdueInterest(db: D1Database, co: CompanyRow & { overdue_interest_bp?: number; overdue_interest_grace_days?: number }, asOf: string, rateBp: number, contactId?: string) {
  const grace = co.overdue_interest_grace_days ?? 0;
  const docs = await all<{ id: string; number: string; contact_id: string; party: string; currency: string; due_date: string; interest_to: string | null; outstanding: number }>(db,
    `SELECT d.id, d.number, d.contact_id, ct.name AS party, d.currency, d.due_date, d.interest_to, d.total - d.amount_settled AS outstanding
       FROM documents d JOIN contacts ct ON ct.id = d.contact_id
      WHERE d.company_id = ? AND d.doc_type = 'invoice' AND d.status = 'posted' AND d.total > d.amount_settled AND d.due_date IS NOT NULL AND d.due_date < ?
        ${contactId ? "AND d.contact_id = ?" : ""} ORDER BY ct.name, d.due_date`, ...[co.id, asOf, ...(contactId ? [contactId] : [])]);
  const rows: InterestRow[] = [];
  for (const d of docs) {
    const start = addDays(d.due_date, grace);
    const from = d.interest_to && d.interest_to > start ? d.interest_to : start;
    const n = days(from, asOf);
    if (n <= 0) continue;
    const amount = Math.round((d.outstanding * rateBp * n) / (10_000 * 365));
    if (amount <= 0) continue;
    rows.push({ document_id: d.id, number: d.number, contact_id: d.contact_id, party: d.party, currency: d.currency, due_date: d.due_date, from, days: n, outstanding: d.outstanding, interest: amount });
  }
  return rows;
}

interest.get("/", async (c) => {
  requireAnyPerm(c, "sales.view", "reports.read");
  const co = c.get("company") as CompanyRow & { overdue_interest_bp: number; overdue_interest_grace_days: number };
  const asOf = c.req.query("as_of") || todayIso();
  const rateBp = c.req.query("rate") ? Math.round(Number(c.req.query("rate")) * 100) : co.overdue_interest_bp;
  if (!Number.isFinite(rateBp) || rateBp <= 0 || rateBp > 10_000) throw badRequest("Rate must be between 0 and 100% a year");
  const rows = await overdueInterest(c.env.DB, co, asOf, rateBp);
  const byParty = new Map<string, { contact_id: string; party: string; currency: string; invoices: number; outstanding: number; interest: number }>();
  for (const r of rows) {
    const k = `${r.contact_id}|${r.currency}`;
    const g = byParty.get(k) ?? { contact_id: r.contact_id, party: r.party, currency: r.currency, invoices: 0, outstanding: 0, interest: 0 };
    g.invoices++; g.outstanding += r.outstanding; g.interest += r.interest;
    byParty.set(k, g);
  }
  return c.json({ as_of: asOf, rate_bp: rateBp, grace_days: co.overdue_interest_grace_days, rows, customers: [...byParty.values()] });
});

interest.put("/settings", async (c) => {
  requirePerm(c, "company.manage");
  const input = await body(c, z.object({ rate_percent: z.number().gt(0).max(100), grace_days: z.number().int().min(0).max(365) }));
  await batch(c.env.DB, [
    stmt(c.env.DB, `UPDATE companies SET overdue_interest_bp = ?, overdue_interest_grace_days = ? WHERE id = ?`, Math.round(input.rate_percent * 100), input.grace_days, c.get("company").id),
    audit(c, "company.overdue_interest", "company", c.get("company").id, input),
  ]);
  return c.json({ ok: true });
});

/** A draft interest invoice for one customer: one line per overdue invoice; those invoices are marked billed up to the date. */
interest.post("/invoice", async (c) => {
  requirePerm(c, "sales.create");
  const co = c.get("company") as CompanyRow & { overdue_interest_bp: number; overdue_interest_grace_days: number };
  const input = await body(c, z.object({ contact_id: idStr, as_of: isoDate.optional(), rate_percent: z.number().gt(0).max(100).optional() }));
  const asOf = input.as_of ?? todayIso();
  const rateBp = input.rate_percent ? Math.round(input.rate_percent * 100) : co.overdue_interest_bp;
  const rows = await overdueInterest(c.env.DB, co, asOf, rateBp, input.contact_id);
  if (!rows.length) throw badRequest("This customer has no interest due");
  const currencies = [...new Set(rows.map((r) => r.currency))];
  if (currencies.length > 1) throw badRequest("This customer's overdue invoices are in different currencies; raise interest separately");
  const acc = await first<{ id: string }>(c.env.DB,
    `SELECT id FROM accounts WHERE company_id = ? AND type = 'income' AND is_group = 0 AND is_active = 1 ORDER BY CASE WHEN lower(name) LIKE '%interest%' THEN 0 WHEN subtype = 'other_income' THEN 1 ELSE 2 END, code LIMIT 1`, co.id);
  const pct = (rateBp / 100).toFixed(2).replace(/\.?0+$/, "");
  const prepared = await prepareDraft(c, {
    doc_type: "invoice", contact_id: input.contact_id, issue_date: asOf, currency: currencies[0], reference: "Interest on overdue",
    notes: `Interest at ${pct}% a year on overdue amounts up to ${asOf}.`,
    lines: rows.map((r) => ({
      description: `Interest @ ${pct}% p.a. on ${r.number} (due ${r.due_date}): ${r.days} days from ${r.from}`,
      qty_milli: 1000, unit_price: r.interest, discount_bp: 0, account_id: acc?.id ?? null,
    })),
  });
  await batch(c.env.DB, [
    ...prepared.stmts,
    ...rows.map((r) => stmt(c.env.DB, `UPDATE documents SET interest_to = ? WHERE id = ?`, asOf, r.document_id)),
    audit(c, "invoice.interest", "document", prepared.id, { contact_id: input.contact_id, as_of: asOf, rate_bp: rateBp, invoices: rows.map((r) => r.number) }),
  ]);
  return c.json({ id: prepared.id, invoices: rows.length, interest: rows.reduce((s, r) => s + r.interest, 0) }, 201);
});
