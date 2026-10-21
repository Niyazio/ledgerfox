import { Hono } from "hono";
import { z } from "zod";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { all, batch, bumpSequence, first, seqNumberExpr, stmt, nowIso, todayIso } from "../lib/db";
import { badRequest, conflict, forbidden, notFound, unprocessable } from "../lib/errors";
import { body, isoDate, optId, minor, rate, pageParams, reqText } from "../lib/validate";
import { newId } from "../lib/crypto";
import { audit, requireAnyPerm, requirePerm } from "../lib/auth";
import { can } from "@shared/permissions";
import { currencyExponent } from "@shared/currencies";
import { computeLine, resolveTaxMode, schemeForCountry, type TaxCodeLike } from "@shared/tax";
import { convertToBase } from "@shared/money";
import { buildJournal, systemAccounts, assertOpenPeriod, type LineInput } from "../services/ledger";
import { lookupRate } from "../services/documents";
import { suggestExpenseCategory } from "../services/insights";

const expenses = new Hono<AppEnv>();
expenses.use("*", async (c, next) => { if (c.req.method === "GET") requireAnyPerm(c, "expense.create", "expense.approve", "reports.read"); await next(); });

const schema = z.object({
  expense_date: isoDate,
  contact_id: optId,
  category_account_id: z.string(),
  paid_from_account_id: z.string(),
  description: reqText(500),
  currency: z.string().regex(/^[A-Z]{3}$/).nullish(),
  fx_rate: z.union([z.string(), z.number()]).nullish(),
  amount: z.union([z.string(), z.number()]),          // net of tax
  tax_code_id: optId,
  department_id: optId,
  project_id: optId,
  cost_centre_id: optId,
});

async function compute(c: Context<AppEnv>, input: z.infer<typeof schema>) {
  const db = c.env.DB;
  const company = c.get("company");
  const cat = await first<{ type: string; is_group: number }>(db, `SELECT type, is_group FROM accounts WHERE id = ? AND company_id = ?`, input.category_account_id, company.id);
  if (!cat || cat.is_group) throw badRequest("Choose a valid expense category account");
  if (!["expense", "asset"].includes(cat.type)) throw badRequest("Category must be an expense (or asset) account");
  const paid = await first<{ subtype: string; is_group: number }>(db, `SELECT subtype, is_group FROM accounts WHERE id = ? AND company_id = ?`, input.paid_from_account_id, company.id);
  if (!paid || paid.is_group || !["cash", "bank", "payable", "current_liability"].includes(paid.subtype)) {
    throw badRequest("Paid-from must be a cash, bank, card/current liability or payable account");
  }
  if (paid.subtype === "payable" && !input.contact_id) throw badRequest("Choose the supplier when the expense is unpaid (accounts payable)");
  if (input.contact_id && !(await first(db, `SELECT 1 FROM contacts WHERE id = ? AND company_id = ?`, input.contact_id, company.id))) throw badRequest("Supplier not found");
  const currency = input.currency || company.base_currency;
  const exp = currencyExponent(currency);
  const amount = minor(input.amount, exp);
  if (amount <= 0) throw badRequest("Amount must be positive");
  let fx = currency === company.base_currency ? 1_000_000_000 : input.fx_rate ? rate(input.fx_rate) : await lookupRate(db, company, currency, input.expense_date);
  if (!fx) throw unprocessable("RATE_REQUIRED", `Enter the ${currency} exchange rate`);
  fx = Number(fx);
  let tax: (TaxCodeLike & { id: string }) | null = null;
  if (input.tax_code_id) {
    tax = await first<TaxCodeLike & { id: string }>(db, `SELECT id, scheme, rate_bp, category FROM tax_codes WHERE id = ? AND company_id = ?`, input.tax_code_id, company.id);
    if (!tax) throw badRequest("Tax code not found");
  }
  let supplierState: string | null = null;
  if (input.contact_id) supplierState = (await first<{ state_code: string | null }>(db, `SELECT state_code FROM contacts WHERE id = ?`, input.contact_id))?.state_code ?? null;
  const mode = resolveTaxMode(schemeForCountry(company.country), supplierState ?? company.state_code, company.state_code);
  const t = computeLine({ qty_milli: 1000, unit_price: amount, tax }, mode);
  return { amount, currency, fx, tax: t, mode, total: t.line_total };
}

expenses.get("/", async (c) => {
  const company = c.get("company");
  const { limit, offset } = pageParams(c);
  const status = c.req.query("status");
  const where = ["e.company_id = ?"];
  const params: (string | number)[] = [company.id];
  if (status) { where.push("e.status = ?"); params.push(status); }
  const rows = await all(c.env.DB,
    `SELECT e.*, a.name AS category_name, pa.name AS paid_from_name, ct.name AS contact_name, u.name AS created_by_name,
       (SELECT COUNT(*) FROM attachments at WHERE at.entity_type = 'expense' AND at.entity_id = e.id) AS attachment_count
     FROM expenses e JOIN accounts a ON a.id = e.category_account_id JOIN accounts pa ON pa.id = e.paid_from_account_id
     LEFT JOIN contacts ct ON ct.id = e.contact_id LEFT JOIN users u ON u.id = e.created_by
     WHERE ${where.join(" AND ")} ORDER BY e.expense_date DESC, e.created_at DESC LIMIT ? OFFSET ?`, ...params, limit, offset);
  const total = await first<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM expenses e WHERE ${where.join(" AND ")}`, ...params);
  return c.json({ expenses: rows, total: total?.n ?? 0 });
});

expenses.get("/suggest-category", async (c) => {
  const company = c.get("company");
  return c.json({ suggestions: await suggestExpenseCategory(c.env.DB, company.id, c.req.query("description") ?? "", c.req.query("contact_id") ?? null) });
});

expenses.get("/templates", async (c) => {
  const company = c.get("company");
  return c.json({ templates: await all(c.env.DB, `SELECT * FROM recurring_templates WHERE company_id = ? ORDER BY next_run_date`, company.id) });
});

expenses.get("/:id", async (c) => {
  const company = c.get("company");
  const e = await first(c.env.DB,
    `SELECT e.*, a.name AS category_name, pa.name AS paid_from_name, ct.name AS contact_name, je.entry_number AS journal_number,
            su.name AS submitted_by_name, au.name AS approved_by_name
     FROM expenses e JOIN accounts a ON a.id = e.category_account_id JOIN accounts pa ON pa.id = e.paid_from_account_id
     LEFT JOIN contacts ct ON ct.id = e.contact_id LEFT JOIN journal_entries je ON je.id = e.journal_entry_id
     LEFT JOIN users su ON su.id = e.submitted_by LEFT JOIN users au ON au.id = e.approved_by
     WHERE e.id = ? AND e.company_id = ?`, c.req.param("id"), company.id);
  if (!e) throw notFound("Expense");
  const attachments = await all(c.env.DB, `SELECT id, filename, mime_type, size_bytes, created_at FROM attachments WHERE company_id = ? AND entity_type = 'expense' AND entity_id = ?`, company.id, c.req.param("id"));
  return c.json({ expense: e, attachments });
});

expenses.post("/", async (c) => {
  requirePerm(c, "expense.create");
  const input = await body(c, schema);
  const company = c.get("company");
  const r = await compute(c, input);
  const id = newId();
  await batch(c.env.DB, [
    stmt(c.env.DB,
      `INSERT INTO expenses (id, company_id, expense_date, contact_id, category_account_id, paid_from_account_id, description, currency, fx_rate_scaled,
         amount, tax_code_id, tax_mode, tax_amount, total, status, department_id, project_id, cost_centre_id, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?,?,?)`,
      id, company.id, input.expense_date, input.contact_id ?? null, input.category_account_id, input.paid_from_account_id, input.description, r.currency, r.fx,
      r.amount, input.tax_code_id ?? null, r.mode, r.tax.tax, r.total, input.department_id ?? null, input.project_id ?? null, input.cost_centre_id ?? null, c.get("user").id),
    audit(c, "expense.create", "expense", id, { total: r.total }),
  ]);
  return c.json({ id, total: r.total, tax: r.tax.tax }, 201);
});

expenses.put("/:id", async (c) => {
  requirePerm(c, "expense.create");
  const input = await body(c, schema);
  const company = c.get("company");
  const id = c.req.param("id");
  const e = await first<{ status: string; created_by: string }>(c.env.DB, `SELECT status, created_by FROM expenses WHERE id = ? AND company_id = ?`, id, company.id);
  if (!e) throw notFound("Expense");
  if (!["draft", "rejected"].includes(e.status)) throw conflict("NOT_EDITABLE", "Only draft or rejected expenses can be edited");
  const r = await compute(c, input);
  await batch(c.env.DB, [
    stmt(c.env.DB,
      `UPDATE expenses SET expense_date = ?, contact_id = ?, category_account_id = ?, paid_from_account_id = ?, description = ?, currency = ?, fx_rate_scaled = ?,
         amount = ?, tax_code_id = ?, tax_mode = ?, tax_amount = ?, total = ?, status = 'draft', rejection_reason = NULL, department_id = ?, project_id = ?, cost_centre_id = ?
       WHERE id = ? AND company_id = ?`,
      input.expense_date, input.contact_id ?? null, input.category_account_id, input.paid_from_account_id, input.description, r.currency, r.fx,
      r.amount, input.tax_code_id ?? null, r.mode, r.tax.tax, r.total, input.department_id ?? null, input.project_id ?? null, input.cost_centre_id ?? null, id, company.id),
    audit(c, "expense.update", "expense", id, { total: r.total }),
  ]);
  return c.json({ ok: true });
});

expenses.delete("/:id", async (c) => {
  requirePerm(c, "expense.create");
  const company = c.get("company");
  const id = c.req.param("id");
  const e = await first<{ status: string }>(c.env.DB, `SELECT status FROM expenses WHERE id = ? AND company_id = ?`, id, company.id);
  if (!e) throw notFound("Expense");
  if (e.status === "posted") throw conflict("POSTED_IMMUTABLE", "Posted expenses cannot be deleted; reverse the journal instead");
  await batch(c.env.DB, [
    stmt(c.env.DB, `DELETE FROM attachments WHERE company_id = ? AND entity_type = 'expense' AND entity_id = ?`, company.id, id),
    stmt(c.env.DB, `DELETE FROM expenses WHERE id = ? AND company_id = ?`, id, company.id),
    audit(c, "expense.delete", "expense", id),
  ]);
  return c.json({ ok: true });
});

expenses.post("/:id/submit", async (c) => {
  requirePerm(c, "expense.create");
  const company = c.get("company");
  const id = c.req.param("id");
  const e = await first<{ status: string }>(c.env.DB, `SELECT status FROM expenses WHERE id = ? AND company_id = ?`, id, company.id);
  if (!e) throw notFound("Expense");
  if (e.status !== "draft") throw conflict("INVALID_STATUS", "Only drafts can be submitted");
  await batch(c.env.DB, [
    stmt(c.env.DB, `UPDATE expenses SET status = 'submitted', submitted_by = ? WHERE id = ? AND company_id = ? AND status = 'draft'`, c.get("user").id, id, company.id),
    audit(c, "expense.submit", "expense", id),
  ]);
  return c.json({ ok: true });
});

expenses.post("/:id/reject", async (c) => {
  requirePerm(c, "expense.approve");
  const input = await body(c, z.object({ reason: reqText(300) }));
  const company = c.get("company");
  const id = c.req.param("id");
  const e = await first<{ status: string }>(c.env.DB, `SELECT status FROM expenses WHERE id = ? AND company_id = ?`, id, company.id);
  if (!e) throw notFound("Expense");
  if (e.status !== "submitted") throw conflict("INVALID_STATUS", "Only submitted expenses can be rejected");
  await batch(c.env.DB, [
    stmt(c.env.DB, `UPDATE expenses SET status = 'rejected', rejection_reason = ? WHERE id = ? AND company_id = ?`, input.reason, id, company.id),
    audit(c, "expense.reject", "expense", id, input),
  ]);
  return c.json({ ok: true });
});

/**
 * Approve and post. Segregation of duties: the approver cannot be the person who submitted the claim,
 * unless they are the organisation owner/admin (small businesses often have a single user).
 */
expenses.post("/:id/approve", async (c) => {
  requirePerm(c, "expense.approve");
  requirePerm(c, "expense.approve");
  const company = c.get("company");
  const user = c.get("user");
  const id = c.req.param("id");
  const e = await first<{ status: string; submitted_by: string | null; created_by: string; expense_date: string; contact_id: string | null; category_account_id: string;
    paid_from_account_id: string; description: string; currency: string; fx_rate_scaled: number; amount: number; tax_code_id: string | null; tax_mode: string;
    tax_amount: number; total: number; department_id: string | null; project_id: string | null; cost_centre_id: string | null }>(
    c.env.DB, `SELECT * FROM expenses WHERE id = ? AND company_id = ?`, id, company.id,
  );
  if (!e) throw notFound("Expense");
  if (!["draft", "submitted"].includes(e.status)) throw conflict("INVALID_STATUS", `Expense is ${e.status}`);
  const role = c.get("role");
  if ((e.submitted_by ?? e.created_by) === user.id && !can(role, "org.manage")) {
    throw forbidden("You cannot approve your own expense claim");
  }
  await assertOpenPeriod(c.env.DB, company.id, e.expense_date);
  const baseExp = currencyExponent(company.base_currency);
  const exp = currencyExponent(e.currency);
  const toBase = (v: number) => convertToBase(v, e.fx_rate_scaled, exp, baseExp);
  const scheme = schemeForCountry(company.country);
  const acc = await systemAccounts(c.env.DB, company.id, scheme === "in_gst" ? ["IN_CGST", "IN_SGST", "IN_IGST"] : ["IN_TAX"]);
  const dims = { department_id: e.department_id, project_id: e.project_id, cost_centre_id: e.cost_centre_id };
  const lines: LineInput[] = [{ account_id: e.category_account_id, debit: toBase(e.amount), description: e.description, tax_code_id: e.tax_code_id, ...dims }];
  if (e.tax_amount) {
    const tax = e.tax_code_id ? await first<TaxCodeLike>(c.env.DB, `SELECT id, scheme, rate_bp, category FROM tax_codes WHERE id = ?`, e.tax_code_id) : null;
    const t = computeLine({ qty_milli: 1000, unit_price: e.amount, tax }, e.tax_mode as never);
    if (t.cgst) lines.push({ account_id: acc.IN_CGST, debit: toBase(t.cgst), description: "CGST" });
    if (t.sgst) lines.push({ account_id: acc.IN_SGST, debit: toBase(t.sgst), description: "SGST" });
    if (t.igst) lines.push({ account_id: acc.IN_IGST, debit: toBase(t.igst), description: "IGST" });
    if (t.other_tax) lines.push({ account_id: acc.IN_TAX, debit: toBase(t.other_tax), description: "Input tax" });
  }
  const dr = lines.reduce((s, l) => s + (l.debit ?? 0), 0);
  lines.push({ account_id: e.paid_from_account_id, credit: dr, contact_id: e.contact_id, currency: e.currency, fx_rate_scaled: e.fx_rate_scaled, amount_fc: e.total, description: e.description });
  const built = buildJournal(c.env.DB, {
    company_id: company.id, entry_date: e.expense_date, kind: "system", memo: `Expense: ${e.description}`,
    source_type: "expense", source_id: id, created_by: user.id, post: true, lines,
  });
  await batch(c.env.DB, [
    ...built.stmts,
    ...bumpSequence(c.env.DB, company.id, "expense", "EXP-"),
    stmt(c.env.DB, `UPDATE expenses SET status = 'posted', number = ${seqNumberExpr()}, approved_by = ?, approved_at = ?, journal_entry_id = ? WHERE id = ? AND company_id = ? AND status IN ('draft','submitted')`,
      company.id, "expense", user.id, nowIso(), built.id, id, company.id),
    audit(c, "expense.approve_post", "expense", id, { journal_id: built.id, total: e.total }),
  ]);
  return c.json({ ok: true, journal_id: built.id });
});

// ── Recurring expense templates ──
const templateSchema = z.object({
  name: reqText(120),
  frequency: z.enum(["weekly", "monthly", "quarterly", "yearly"]),
  next_run_date: isoDate,
  end_date: isoDate.nullish(),
  expense: schema.omit({ expense_date: true }),
});

expenses.post("/templates", async (c) => {
  requirePerm(c, "expense.create");
  const input = await body(c, templateSchema);
  const company = c.get("company");
  await compute(c, { ...input.expense, expense_date: input.next_run_date }); // validate
  const id = newId();
  await batch(c.env.DB, [
    stmt(c.env.DB, `INSERT INTO recurring_templates (id, company_id, kind, name, frequency, next_run_date, end_date, payload, created_by) VALUES (?,?,?,?,?,?,?,?,?)`,
      id, company.id, "expense", input.name, input.frequency, input.next_run_date, input.end_date ?? null, JSON.stringify(input.expense), c.get("user").id),
    audit(c, "recurring.create", "recurring_template", id, { name: input.name }),
  ]);
  return c.json({ id }, 201);
});

expenses.patch("/templates/:id", async (c) => {
  requirePerm(c, "expense.create");
  const input = await body(c, z.object({ is_active: z.boolean() }));
  const company = c.get("company");
  await batch(c.env.DB, [
    stmt(c.env.DB, `UPDATE recurring_templates SET is_active = ? WHERE id = ? AND company_id = ?`, input.is_active ? 1 : 0, c.req.param("id"), company.id),
    audit(c, "recurring.update", "recurring_template", c.req.param("id"), input),
  ]);
  return c.json({ ok: true });
});

export function advance(date: string, freq: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDate();
  if (freq === "weekly") d.setUTCDate(d.getUTCDate() + 7);
  else {
    const months = freq === "monthly" ? 1 : freq === "quarterly" ? 3 : 12;
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + months);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
  }
  return d.toISOString().slice(0, 10);
}

/** Generate draft expenses for all templates due on or before today (max 24 per template per run). Drafts still need approval. */
expenses.post("/templates/run", async (c) => {
  requirePerm(c, "expense.create");
  const company = c.get("company");
  const today = todayIso();
  const templates = await all<{ id: string; frequency: string; next_run_date: string; end_date: string | null; payload: string }>(
    c.env.DB, `SELECT * FROM recurring_templates WHERE company_id = ? AND is_active = 1 AND next_run_date <= ?`, company.id, today,
  );
  let created = 0;
  for (const t of templates) {
    const payload = schema.omit({ expense_date: true }).parse(JSON.parse(t.payload));
    let next = t.next_run_date;
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < 24 && next <= today && (!t.end_date || next <= t.end_date); i++) {
      const r = await compute(c, { ...payload, expense_date: next });
      stmts.push(stmt(c.env.DB,
        `INSERT INTO expenses (id, company_id, expense_date, contact_id, category_account_id, paid_from_account_id, description, currency, fx_rate_scaled,
           amount, tax_code_id, tax_mode, tax_amount, total, status, department_id, project_id, cost_centre_id, template_id, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?,?,?,?)`,
        newId(), company.id, next, payload.contact_id ?? null, payload.category_account_id, payload.paid_from_account_id, payload.description, r.currency, r.fx,
        r.amount, payload.tax_code_id ?? null, r.mode, r.tax.tax, r.total, payload.department_id ?? null, payload.project_id ?? null, payload.cost_centre_id ?? null, t.id, c.get("user").id));
      created++;
      next = advance(next, t.frequency);
    }
    const ended = t.end_date && next > t.end_date;
    stmts.push(stmt(c.env.DB, `UPDATE recurring_templates SET next_run_date = ?, is_active = ? WHERE id = ? AND company_id = ? AND next_run_date = ?`, next, ended ? 0 : 1, t.id, company.id, t.next_run_date));
    await batch(c.env.DB, stmts);
  }
  if (created) await batch(c.env.DB, [audit(c, "recurring.run", "company", company.id, { created })]);
  return c.json({ created });
});

export default expenses;
