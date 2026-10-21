import { Hono } from "hono";
import { z } from "zod";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { all, batch, first, stmt, todayIso } from "../lib/db";
import { badRequest, forbidden, notFound } from "../lib/errors";
import { body, dateParam, minor, reqText } from "../lib/validate";
import { newId } from "../lib/crypto";
import { audit, requirePerm, resolveBranch } from "../lib/auth";
import { formatMoney, currencyExponent } from "@shared/currencies";
import { fiscalYearFor } from "../services/setup";
import * as R from "../services/reports";
import { cashForecast, explainProfitAndLoss, unusualTransactions } from "../services/insights";

const reports = new Hono<AppEnv>();
reports.use("*", async (c, next) => { requirePerm(c, "reports.read"); await next(); });

function range(c: Context<AppEnv>) {
  const company = c.get("company");
  const today = todayIso();
  const fy = fiscalYearFor(today, company.fiscal_year_start_month);
  const from = dateParam(c, "from", fy.start);
  const to = dateParam(c, "to", today);
  if (from > to) throw badRequest("'from' must be on or before 'to'");
  return { from, to };
}

/** Branch for this report: as requested, validated; members limited to some branches always get one of theirs. */
function reportBranch(c: Context<AppEnv>): string | null {
  return resolveBranch(c, c.req.query("branch_id") || null);
}

/** Reports that are only available consolidated (no per-branch breakdown yet). */
function consolidatedOnly(c: Context<AppEnv>) {
  if (!c.get("branches").all) throw forbidden("This report covers the whole company. Ask the owner for access to all branches.");
}

function filters(c: Context<AppEnv>): R.Filters {
  return {
    department_id: c.req.query("department_id") || null,
    project_id: c.req.query("project_id") || null,
    cost_centre_id: c.req.query("cost_centre_id") || null,
    branch_id: reportBranch(c),
  };
}

reports.get("/trial-balance", async (c) => {
  const { from, to } = range(c);
  return c.json(await R.trialBalance(c.env.DB, c.get("company"), from, to, { branch_id: reportBranch(c) }));
});

reports.get("/profit-loss", async (c) => {
  const { from, to } = range(c);
  const company = c.get("company");
  const cur = await R.profitAndLoss(c.env.DB, company, from, to, filters(c));
  // Comparison with the immediately preceding period of equal length.
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  const prevTo = R.prevDay(from);
  const prevFrom = new Date(Date.parse(`${prevTo}T00:00:00Z`) - (days - 1) * 86400000).toISOString().slice(0, 10);
  const prev = await R.profitAndLoss(c.env.DB, company, prevFrom, prevTo, filters(c));
  const flat = (p: typeof cur) => p.sections.flatMap((s) => s.lines.map((l) => ({ name: l.name, type: l.type, amount: l.amount })));
  const fmt = (n: number) => formatMoney(n, company.base_currency, company.number_locale);
  const explanation = explainProfitAndLoss(
    { income: cur.total_income, expense: cur.total_expense, lines: flat(cur) },
    { income: prev.total_income, expense: prev.total_expense, lines: flat(prev) }, fmt,
  );
  return c.json({ ...cur, previous: { from: prevFrom, to: prevTo, net_profit: prev.net_profit, total_income: prev.total_income, total_expense: prev.total_expense }, explanation });
});

reports.get("/balance-sheet", async (c) => {
  const asOf = dateParam(c, "as_of", todayIso());
  return c.json(await R.balanceSheet(c.env.DB, c.get("company"), asOf, { branch_id: reportBranch(c) }));
});

reports.get("/cash-flow", async (c) => {
  consolidatedOnly(c);
  const { from, to } = range(c);
  return c.json(await R.cashFlow(c.env.DB, c.get("company"), from, to));
});

reports.get("/general-ledger", async (c) => {
  const { from, to } = range(c);
  const accountId = c.req.query("account_id");
  if (!accountId) throw badRequest("account_id is required");
  consolidatedOnly(c);
  const r = await R.generalLedger(c.env.DB, c.get("company"), accountId, from, to, c.req.query("contact_id") || null);
  if (!r) throw notFound("Account");
  return c.json(r);
});

reports.get("/aging/:kind{receivable|payable}", async (c) => {
  consolidatedOnly(c);
  const asOf = dateParam(c, "as_of", todayIso());
  return c.json(await R.aging(c.env.DB, c.get("company"), c.req.param("kind") as "receivable" | "payable", asOf));
});

reports.get("/statement/:contactId", async (c) => {
  consolidatedOnly(c);
  const { from, to } = range(c);
  const r = await R.contactStatement(c.env.DB, c.get("company"), c.req.param("contactId"), from, to);
  if (!r) throw notFound("Contact");
  return c.json(r);
});

reports.get("/gst-summary", async (c) => {
  consolidatedOnly(c);
  const { from, to } = range(c);
  return c.json(await R.gstSummary(c.env.DB, c.get("company"), from, to));
});

reports.get("/inventory-valuation", async (c) => {
  consolidatedOnly(c);
  return c.json(await R.inventoryValuation(c.env.DB, c.get("company"), dateParam(c, "as_of", todayIso())));
});

reports.get("/sales-by-customer", async (c) => {
  const { from, to } = range(c);
  const company = c.get("company");
  const rows = await all(c.env.DB,
    `SELECT ct.id, ct.name, COUNT(DISTINCT CASE WHEN d.doc_type = 'invoice' THEN d.id END) AS invoices,
       SUM(CASE WHEN d.doc_type = 'invoice' THEN d.total_base ELSE -d.total_base END) AS gross_base
     FROM documents d JOIN contacts ct ON ct.id = d.contact_id
     WHERE d.company_id = ? AND d.status = 'posted' AND d.doc_type IN ('invoice','credit_note') AND d.issue_date BETWEEN ? AND ?${reportBranch(c) ? " AND d.branch_id = ?" : ""}
     GROUP BY ct.id ORDER BY gross_base DESC`, company.id, from, to, ...(reportBranch(c) ? [reportBranch(c)!] : []));
  return c.json({ from, to, rows });
});

reports.get("/purchases-by-supplier", async (c) => {
  const { from, to } = range(c);
  const company = c.get("company");
  const rows = await all(c.env.DB,
    `SELECT ct.id, ct.name, COUNT(DISTINCT CASE WHEN d.doc_type = 'bill' THEN d.id END) AS bills,
       SUM(CASE WHEN d.doc_type = 'bill' THEN d.total_base ELSE -d.total_base END) AS gross_base
     FROM documents d JOIN contacts ct ON ct.id = d.contact_id
     WHERE d.company_id = ? AND d.status = 'posted' AND d.doc_type IN ('bill','debit_note') AND d.issue_date BETWEEN ? AND ?${reportBranch(c) ? " AND d.branch_id = ?" : ""}
     GROUP BY ct.id ORDER BY gross_base DESC`, company.id, from, to, ...(reportBranch(c) ? [reportBranch(c)!] : []));
  return c.json({ from, to, rows });
});

reports.get("/expenses", async (c) => {
  consolidatedOnly(c);
  const { from, to } = range(c);
  const company = c.get("company");
  const byCategory = await all(c.env.DB,
    `SELECT a.id, a.code, a.name, SUM(l.debit - l.credit) AS amount, COUNT(DISTINCT e.id) AS entries
     FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
     WHERE e.company_id = ? AND e.status = 'posted' AND a.type = 'expense' AND e.entry_date BETWEEN ? AND ?
     GROUP BY a.id HAVING amount <> 0 ORDER BY amount DESC`, company.id, from, to);
  const claims = await all(c.env.DB,
    `SELECT status, COUNT(*) AS n, SUM(total) AS total FROM expenses WHERE company_id = ? AND expense_date BETWEEN ? AND ? GROUP BY status`, company.id, from, to);
  return c.json({ from, to, by_category: byCategory, claims });
});

reports.get("/dashboard", async (c) => {
  const company = c.get("company");
  const today = todayIso();
  // Branch view (validated): every figure below is limited to that branch's postings and documents.
  const branch = reportBranch(c);
  const lb = branch ? " AND l.branch_id = ?" : "";
  const db_ = branch ? " AND branch_id = ?" : "";
  const bp = branch ? [branch] : [];
  const cash = await all(c.env.DB,
    `SELECT a.id, a.name, a.subtype, COALESCE(s.balance,0) AS balance FROM accounts a
     LEFT JOIN (SELECT l.account_id, SUM(l.debit - l.credit) AS balance FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
                WHERE e.company_id = ? AND e.status = 'posted'${lb} AND l.account_id IN (SELECT id FROM accounts WHERE company_id = ? AND subtype IN ('cash','bank'))
                GROUP BY l.account_id) s ON s.account_id = a.id
     WHERE a.company_id = ? AND a.subtype IN ('cash','bank') AND a.is_group = 0 AND a.is_active = 1 ORDER BY a.code`, company.id, ...bp, company.id, company.id);
  const arap = await first<{ ar: number; ap: number; overdue_ar: number; overdue_ap: number; overdue_inv: number; overdue_bills: number }>(c.env.DB,
    `SELECT
       COALESCE(SUM(CASE WHEN doc_type = 'invoice' THEN (total_base * (total - amount_settled)) / total END),0) AS ar,
       COALESCE(SUM(CASE WHEN doc_type = 'bill' THEN (total_base * (total - amount_settled)) / total END),0) AS ap,
       COALESCE(SUM(CASE WHEN doc_type = 'invoice' AND due_date < ? THEN (total_base * (total - amount_settled)) / total END),0) AS overdue_ar,
       COALESCE(SUM(CASE WHEN doc_type = 'bill' AND due_date < ? THEN (total_base * (total - amount_settled)) / total END),0) AS overdue_ap,
       COUNT(CASE WHEN doc_type = 'invoice' AND due_date < ? THEN 1 END) AS overdue_inv,
       COUNT(CASE WHEN doc_type = 'bill' AND due_date < ? THEN 1 END) AS overdue_bills
     FROM documents WHERE company_id = ? AND status = 'posted' AND total > amount_settled AND total > 0${db_}`, today, today, today, today, company.id, ...bp);
  // Monthly income and expense for the last 6 months from the ledger.
  const start = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  start.setUTCMonth(start.getUTCMonth() - 5);
  const series = await all<{ month: string; income: number; expense: number }>(c.env.DB,
    `SELECT s.month,
       COALESCE(SUM(CASE WHEN a.type = 'income' THEN s.credit - s.debit END),0) AS income,
       COALESCE(SUM(CASE WHEN a.type = 'expense' THEN s.debit - s.credit END),0) AS expense
     FROM (SELECT substr(e.entry_date, 1, 7) AS month, l.account_id, SUM(l.debit) AS debit, SUM(l.credit) AS credit
           FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
           WHERE e.company_id = ? AND e.status = 'posted' AND e.entry_date >= ?${lb}
           GROUP BY month, l.account_id) s
     JOIN accounts a ON a.id = s.account_id AND a.type IN ('income','expense')
     GROUP BY s.month ORDER BY s.month`, company.id, start.toISOString().slice(0, 10), ...bp);
  const months: { month: string; income: number; expense: number }[] = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(start); d.setUTCMonth(start.getUTCMonth() + i);
    const m = d.toISOString().slice(0, 7);
    months.push(series.find((s) => s.month === m) ?? { month: m, income: 0, expense: 0 });
  }
  const reorder = await all(c.env.DB,
    `SELECT i.id, i.name, i.unit, i.reorder_level_milli, COALESCE((SELECT SUM(qty_milli) FROM stock_moves s WHERE s.item_id = i.id),0) AS qty_milli
     FROM items i WHERE i.company_id = ? AND i.track_inventory = 1 AND i.is_active = 1 AND i.reorder_level_milli > 0
       AND COALESCE((SELECT SUM(qty_milli) FROM stock_moves s WHERE s.item_id = i.id),0) <= i.reorder_level_milli LIMIT 20`, company.id);
  const pending = await first<{ drafts: number; expenses: number; unmatched: number }>(c.env.DB,
    `SELECT (SELECT COUNT(*) FROM journal_entries WHERE company_id = ? AND status = 'draft'${db_}) AS drafts,
            (SELECT COUNT(*) FROM expenses WHERE company_id = ? AND status = 'submitted'${db_}) AS expenses,
            (SELECT COUNT(*) FROM bank_statement_lines WHERE company_id = ? AND status = 'unmatched') AS unmatched`, company.id, ...bp, company.id, ...bp, company.id);
  const recent = await all(c.env.DB,
    `SELECT id, entry_number, entry_date, memo, total, kind FROM journal_entries WHERE company_id = ? AND status = 'posted'${db_} ORDER BY posted_at DESC LIMIT 8`, company.id, ...bp);
  return c.json({ cash, receivables: arap, months, reorder: branch ? [] : reorder, pending, recent, branch_id: branch });
});

reports.get("/insights", async (c) => {
  consolidatedOnly(c);
  const company = c.get("company");
  const [forecast, unusual] = await Promise.all([cashForecast(c.env.DB, company.id), unusualTransactions(c.env.DB, company.id)]);
  return c.json({ forecast, unusual, label: "Rule-based suggestions — review before acting. No AI service is used." });
});

// ── Budgets ──
reports.get("/budgets", async (c) => {
  consolidatedOnly(c);
  const company = c.get("company");
  return c.json({ budgets: await all(c.env.DB, `SELECT b.*, fy.name AS fiscal_year_name FROM budgets b JOIN fiscal_years fy ON fy.id = b.fiscal_year_id WHERE b.company_id = ? ORDER BY b.created_at DESC`, company.id) });
});

reports.post("/budgets", async (c) => {
  requirePerm(c, "accounts.write");
  const input = await body(c, z.object({
    name: reqText(120), fiscal_year_id: z.string(),
    lines: z.array(z.object({ account_id: z.string(), period_month: z.string().regex(/^\d{4}-\d{2}$/), amount: z.union([z.string(), z.number()]) })).max(2000),
  }));
  const company = c.get("company");
  const fy = await first(c.env.DB, `SELECT 1 FROM fiscal_years WHERE id = ? AND company_id = ?`, input.fiscal_year_id, company.id);
  if (!fy) throw badRequest("Fiscal year not found");
  const id = newId();
  const exp = currencyExponent(company.base_currency);
  const stmts = [stmt(c.env.DB, `INSERT INTO budgets (id, company_id, name, fiscal_year_id, created_by) VALUES (?,?,?,?,?)`, id, company.id, input.name, input.fiscal_year_id, c.get("user").id)];
  for (const l of input.lines) {
    const amt = minor(l.amount, exp, "budget amount");
    if (amt === 0) continue;
    stmts.push(stmt(c.env.DB, `INSERT INTO budget_lines (budget_id, company_id, account_id, period_month, amount) VALUES (?,?,?,?,?)
      ON CONFLICT(budget_id, account_id, period_month) DO UPDATE SET amount = excluded.amount`, id, company.id, l.account_id, l.period_month, amt));
  }
  stmts.push(audit(c, "budget.create", "budget", id, { name: input.name, lines: input.lines.length }));
  await batch(c.env.DB, stmts);
  return c.json({ id }, 201);
});

reports.get("/budgets/:id", async (c) => {
  consolidatedOnly(c);
  const r = await R.budgetVsActual(c.env.DB, c.get("company"), c.req.param("id"));
  if (!r) throw notFound("Budget");
  return c.json(r);
});

export default reports;
