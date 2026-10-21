/**
 * Financial reports. Every figure is aggregated in SQL from POSTED journal lines (integer minor units),
 * so reports always reconcile with the ledger.
 */
import { all, first } from "../lib/db";
import type { CompanyRow } from "../env";
import { cashFlowSection } from "@shared/coa";
import { fiscalYearFor } from "./setup";

export interface AccountBalance {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
  parent_id: string | null;
  debit: number;
  credit: number;
}

export interface Filters {
  department_id?: string | null;
  project_id?: string | null;
  cost_centre_id?: string | null;
  branch_id?: string | null;
}

function filterSql(f: Filters = {}) {
  const parts: string[] = [];
  const params: string[] = [];
  for (const k of ["department_id", "project_id", "cost_centre_id", "branch_id"] as const) {
    if (f[k]) { parts.push(`l.${k} = ?`); params.push(f[k]!); }
  }
  return { sql: parts.length ? ` AND ${parts.join(" AND ")}` : "", params };
}

/** Sum of posted debits/credits per account for entry_date in [from, to] (from may be null = beginning). */
export async function balances(db: D1Database, companyId: string, from: string | null, to: string, f: Filters = {}): Promise<AccountBalance[]> {
  const fs = filterSql(f);
  return all<AccountBalance>(db,
    `SELECT a.id, a.code, a.name, a.type, a.subtype, a.parent_id, COALESCE(SUM(l.debit),0) AS debit, COALESCE(SUM(l.credit),0) AS credit
     FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
     WHERE e.company_id = ? AND e.status = 'posted' AND e.entry_date <= ? ${from ? "AND e.entry_date >= ?" : ""}${fs.sql}
     GROUP BY a.id ORDER BY a.code`,
    ...(from ? [companyId, to, from, ...fs.params] : [companyId, to, ...fs.params]));
}

export async function trialBalance(db: D1Database, company: CompanyRow, from: string, to: string, f: Filters = {}) {
  const opening = await balances(db, company.id, null, prevDay(from), f);
  const movement = await balances(db, company.id, from, to, f);
  const map = new Map<string, { id: string; code: string; name: string; type: string; opening: number; debit: number; credit: number; closing: number }>();
  for (const o of opening) map.set(o.id, { id: o.id, code: o.code, name: o.name, type: o.type, opening: o.debit - o.credit, debit: 0, credit: 0, closing: 0 });
  for (const m of movement) {
    const row = map.get(m.id) ?? { id: m.id, code: m.code, name: m.name, type: m.type, opening: 0, debit: 0, credit: 0, closing: 0 };
    row.debit = m.debit; row.credit = m.credit;
    map.set(m.id, row);
  }
  const rows = [...map.values()].map((r) => {
    const closing = r.opening + r.debit - r.credit;
    return { ...r, closing, closing_debit: closing > 0 ? closing : 0, closing_credit: closing < 0 ? -closing : 0 };
  }).filter((r) => r.opening !== 0 || r.debit !== 0 || r.credit !== 0).sort((a, b) => a.code.localeCompare(b.code));
  const totals = rows.reduce((t, r) => ({
    debit: t.debit + r.debit, credit: t.credit + r.credit, closing_debit: t.closing_debit + r.closing_debit, closing_credit: t.closing_credit + r.closing_credit,
  }), { debit: 0, credit: 0, closing_debit: 0, closing_credit: 0 });
  return { from, to, rows, totals, balanced: totals.debit === totals.credit && totals.closing_debit === totals.closing_credit };
}

export function prevDay(d: string) {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() - 1);
  return x.toISOString().slice(0, 10);
}

const PL_SECTIONS = [
  { key: "revenue", label: "Revenue", type: "income", subtypes: ["operating_income"] },
  { key: "cogs", label: "Cost of sales", type: "expense", subtypes: ["cogs"] },
  { key: "operating_expense", label: "Operating expenses", type: "expense", subtypes: ["operating_expense", "depreciation"] },
  { key: "other_income", label: "Other income", type: "income", subtypes: ["other_income"] },
  { key: "other_expense", label: "Other expenses", type: "expense", subtypes: ["other_expense"] },
] as const;

export async function profitAndLoss(db: D1Database, company: CompanyRow, from: string, to: string, f: Filters = {}) {
  const rows = (await balances(db, company.id, from, to, f)).filter((r) => r.type === "income" || r.type === "expense");
  const sections = PL_SECTIONS.map((s) => {
    const lines = rows
      .filter((r) => r.type === s.type && (s.subtypes as readonly string[]).includes(r.subtype))
      .map((r) => ({ id: r.id, code: r.code, name: r.name, type: r.type, amount: s.type === "income" ? r.credit - r.debit : r.debit - r.credit }))
      .filter((l) => l.amount !== 0);
    return { key: s.key, label: s.label, lines, total: lines.reduce((t, l) => t + l.amount, 0) };
  });
  // Any income/expense account with an unexpected subtype still counts (never silently dropped).
  const known = new Set(sections.flatMap((s) => s.lines.map((l) => l.id)));
  const strays = rows.filter((r) => !known.has(r.id) && r.debit !== r.credit);
  for (const r of strays) {
    const sec = sections.find((s) => s.key === (r.type === "income" ? "other_income" : "other_expense"))!;
    const amount = r.type === "income" ? r.credit - r.debit : r.debit - r.credit;
    sec.lines.push({ id: r.id, code: r.code, name: r.name, type: r.type, amount });
    sec.total += amount;
  }
  const get = (k: string) => sections.find((s) => s.key === k)!.total;
  const revenue = get("revenue");
  const grossProfit = revenue - get("cogs");
  const operatingProfit = grossProfit - get("operating_expense");
  const netProfit = operatingProfit + get("other_income") - get("other_expense");
  const income = revenue + get("other_income");
  const expense = get("cogs") + get("operating_expense") + get("other_expense");
  return { from, to, sections, revenue, gross_profit: grossProfit, operating_profit: operatingProfit, net_profit: netProfit, total_income: income, total_expense: expense };
}

/** Cumulative profit (income − expense) for entries dated within [from, to]. */
async function cumulativeProfit(db: D1Database, companyId: string, from: string | null, to: string, f: Filters = {}) {
  const fs = filterSql(f);
  const r = await first<{ p: number }>(db,
    `SELECT COALESCE(SUM(CASE WHEN a.type = 'income' THEN l.credit - l.debit WHEN a.type = 'expense' THEN l.credit - l.debit ELSE 0 END),0) AS p
     FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
     WHERE e.company_id = ? AND e.status = 'posted' AND e.entry_date <= ? ${from ? "AND e.entry_date >= ?" : ""}${fs.sql}`,
    ...(from ? [companyId, to, from, ...fs.params] : [companyId, to, ...fs.params]));
  return r?.p ?? 0;
}

export async function balanceSheet(db: D1Database, company: CompanyRow, asOf: string, f: Filters = {}) {
  const rows = (await balances(db, company.id, null, asOf, f)).filter((r) => ["asset", "liability", "equity"].includes(r.type));
  const fy = fiscalYearFor(asOf, company.fiscal_year_start_month);
  const fyRow = await first<{ start_date: string }>(db, `SELECT start_date FROM fiscal_years WHERE company_id = ? AND start_date <= ? AND end_date >= ?`, company.id, asOf, asOf);
  const fyStart = fyRow?.start_date ?? fy.start;
  const currentEarnings = await cumulativeProfit(db, company.id, fyStart, asOf, f);
  const priorEarnings = await cumulativeProfit(db, company.id, null, prevDay(fyStart), f);
  const group = (type: string, sign: 1 | -1) => {
    const lines = rows.filter((r) => r.type === type).map((r) => ({ id: r.id, code: r.code, name: r.name, subtype: r.subtype, amount: sign * (r.debit - r.credit) })).filter((l) => l.amount !== 0);
    return { lines, total: lines.reduce((t, l) => t + l.amount, 0) };
  };
  const assets = group("asset", 1);
  const liabilities = group("liability", -1);
  const equity = group("equity", -1);
  equity.lines.push({ id: "retained-prior", code: "", name: "Retained earnings (prior years, unclosed)", subtype: "retained_earnings", amount: priorEarnings });
  equity.lines.push({ id: "current-earnings", code: "", name: "Current year earnings", subtype: "retained_earnings", amount: currentEarnings });
  equity.total += priorEarnings + currentEarnings;
  const currentAssets = assets.lines.filter((l) => !["fixed_asset", "accumulated_depreciation", "non_current_asset"].includes(l.subtype)).reduce((t, l) => t + l.amount, 0);
  const currentLiabilities = liabilities.lines.filter((l) => l.subtype !== "long_term_liability").reduce((t, l) => t + l.amount, 0);
  return {
    as_of: asOf,
    fiscal_year_start: fyStart,
    assets, liabilities, equity,
    current_assets: currentAssets,
    current_liabilities: currentLiabilities,
    total_liabilities_and_equity: liabilities.total + equity.total,
    balanced: assets.total === liabilities.total + equity.total,
    difference: assets.total - (liabilities.total + equity.total),
  };
}

/**
 * Cash flow statement, indirect method. Every non-cash balance-sheet movement is classified,
 * so (net profit + all adjustments) always equals the change in cash — verified and returned as `reconciles`.
 */
export async function cashFlow(db: D1Database, company: CompanyRow, from: string, to: string) {
  const pl = await profitAndLoss(db, company, from, to);
  const move = (await balances(db, company.id, from, to)).filter((r) => ["asset", "liability", "equity"].includes(r.type));
  const sections: Record<"operating" | "investing" | "financing", { name: string; amount: number }[]> = { operating: [], investing: [], financing: [] };
  let cashChange = 0;
  for (const r of move) {
    const sec = cashFlowSection(r.subtype) ?? (r.type === "asset" ? "operating" : r.type === "liability" ? "operating" : "financing");
    const net = r.debit - r.credit;
    if (sec === "cash") { cashChange += net; continue; }
    const effect = -net; // increase in a non-cash asset uses cash; increase in liability/equity provides it
    if (effect !== 0) sections[sec].push({ name: labelForAdjustment(r.name, r.subtype, effect), amount: effect });
  }
  const operating = pl.net_profit + sections.operating.reduce((t, l) => t + l.amount, 0);
  const investing = sections.investing.reduce((t, l) => t + l.amount, 0);
  const financing = sections.financing.reduce((t, l) => t + l.amount, 0);
  const openingCash = (await first<{ b: number }>(db,
    `SELECT COALESCE(SUM(l.debit - l.credit),0) AS b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
     WHERE e.company_id = ? AND e.status = 'posted' AND e.entry_date < ? AND a.subtype IN ('cash','bank')`, company.id, from))?.b ?? 0;
  return {
    from, to,
    net_profit: pl.net_profit,
    operating: { adjustments: sections.operating, total: operating },
    investing: { lines: sections.investing, total: investing },
    financing: { lines: sections.financing, total: financing },
    net_change: operating + investing + financing,
    cash_change_per_ledger: cashChange,
    opening_cash: openingCash,
    closing_cash: openingCash + cashChange,
    reconciles: operating + investing + financing === cashChange,
  };
}

function labelForAdjustment(name: string, subtype: string, effect: number) {
  if (subtype === "accumulated_depreciation") return `Depreciation (${name})`;
  const dir = effect > 0 ? (["payable", "tax_output", "current_liability", "long_term_liability", "equity", "retained_earnings"].includes(subtype) ? "Increase" : "Decrease") : (["payable", "tax_output", "current_liability", "long_term_liability", "equity", "retained_earnings"].includes(subtype) ? "Decrease" : "Increase");
  return `${dir} in ${name}`;
}

export async function generalLedger(db: D1Database, company: CompanyRow, accountId: string, from: string, to: string, contactId?: string | null) {
  const acc = await first<{ id: string; code: string; name: string; type: string }>(db, `SELECT id, code, name, type FROM accounts WHERE id = ? AND company_id = ?`, accountId, company.id);
  if (!acc) return null;
  const extra = contactId ? " AND l.contact_id = ?" : "";
  const op = await first<{ b: number }>(db,
    `SELECT COALESCE(SUM(l.debit - l.credit),0) AS b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE e.company_id = ? AND e.status = 'posted' AND l.account_id = ? AND e.entry_date < ?${extra}`, ...(contactId ? [company.id, accountId, from, contactId] : [company.id, accountId, from]));
  const lines = await all<{ entry_id: string; entry_number: string; entry_date: string; memo: string | null; description: string | null; debit: number; credit: number; contact_name: string | null; source_type: string | null; source_id: string | null }>(db,
    `SELECT e.id AS entry_id, e.entry_number, e.entry_date, e.memo, l.description, l.debit, l.credit, ct.name AS contact_name, e.source_type, e.source_id
     FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id LEFT JOIN contacts ct ON ct.id = l.contact_id
     WHERE e.company_id = ? AND e.status = 'posted' AND l.account_id = ? AND e.entry_date BETWEEN ? AND ?${extra}
     ORDER BY e.entry_date, e.posted_at, l.line_no LIMIT 5000`, ...(contactId ? [company.id, accountId, from, to, contactId] : [company.id, accountId, from, to]));
  let running = op?.b ?? 0;
  const withBal = lines.map((l) => { running += l.debit - l.credit; return { ...l, balance: running }; });
  return {
    account: acc, from, to, opening: op?.b ?? 0, lines: withBal, closing: running,
    total_debit: lines.reduce((t, l) => t + l.debit, 0), total_credit: lines.reduce((t, l) => t + l.credit, 0),
    truncated: lines.length >= 5000,
  };
}

export async function aging(db: D1Database, company: CompanyRow, kind: "receivable" | "payable", asOf: string) {
  const docType = kind === "receivable" ? "invoice" : "bill";
  const docs = await all<{ id: string; number: string; contact_id: string; contact_name: string; issue_date: string; due_date: string | null; currency: string; total: number; total_base: number; settled: number }>(db,
    `SELECT d.id, d.number, d.contact_id, ct.name AS contact_name, d.issue_date, d.due_date, d.currency, d.total, d.total_base,
       (SELECT COALESCE(SUM(a.amount),0) FROM allocations a WHERE a.document_id = d.id AND a.allocation_date <= ?) AS settled
     FROM documents d JOIN contacts ct ON ct.id = d.contact_id
     WHERE d.company_id = ? AND d.doc_type = ? AND d.issue_date <= ? AND (d.status = 'posted' OR (d.status = 'void' AND d.updated_at > ?))
     ORDER BY ct.name, d.issue_date`, asOf, company.id, docType, asOf, `${asOf}T23:59:59.999Z`);
  const buckets = ["current", "1_30", "31_60", "61_90", "over_90"] as const;
  const rows = docs.map((d) => {
    const outstanding = d.total - d.settled;
    const outstanding_base = d.total ? Math.round((d.total_base * outstanding) / d.total) : 0; // display-only proportional conversion
    const days = Math.floor((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${(d.due_date ?? d.issue_date)}T00:00:00Z`)) / 86400000);
    const bucket: (typeof buckets)[number] = days <= 0 ? "current" : days <= 30 ? "1_30" : days <= 60 ? "31_60" : days <= 90 ? "61_90" : "over_90";
    return { ...d, outstanding, outstanding_base, days_overdue: Math.max(days, 0), bucket };
  }).filter((r) => r.outstanding > 0);
  const byContact = new Map<string, { contact_id: string; contact_name: string; total: number } & Record<(typeof buckets)[number], number>>();
  for (const r of rows) {
    const e = byContact.get(r.contact_id) ?? { contact_id: r.contact_id, contact_name: r.contact_name, total: 0, current: 0, "1_30": 0, "31_60": 0, "61_90": 0, over_90: 0 };
    e[r.bucket] += r.outstanding_base;
    e.total += r.outstanding_base;
    byContact.set(r.contact_id, e);
  }
  const summary = [...byContact.values()];
  const totals = summary.reduce((t, s) => { for (const b of [...buckets, "total"] as const) t[b] += s[b]; return t; }, { current: 0, "1_30": 0, "31_60": 0, "61_90": 0, over_90: 0, total: 0 });
  // Reconciliation: document-based outstanding vs control account balance (differences arise from manual journals or advances).
  const ctrl = await first<{ b: number }>(db,
    `SELECT COALESCE(SUM(l.debit - l.credit),0) AS b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
     WHERE e.company_id = ? AND e.status = 'posted' AND e.entry_date <= ? AND a.subtype = ?`, company.id, asOf, kind);
  const ledgerBalance = kind === "receivable" ? ctrl?.b ?? 0 : -(ctrl?.b ?? 0);
  return { as_of: asOf, kind, documents: rows, summary, totals, ledger_balance: ledgerBalance, unreconciled_difference: ledgerBalance - totals.total };
}

/** Customer/supplier statement from the ledger (AR/AP control lines carrying the contact), base currency. */
export async function contactStatement(db: D1Database, company: CompanyRow, contactId: string, from: string, to: string) {
  const contact = await first<{ id: string; name: string; kind: string; billing_address: string | null; tax_id: string | null; email: string | null }>(
    db, `SELECT id, name, kind, billing_address, tax_id, email FROM contacts WHERE id = ? AND company_id = ?`, contactId, company.id);
  if (!contact) return null;
  const op = await first<{ b: number }>(db,
    `SELECT COALESCE(SUM(l.debit - l.credit),0) AS b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
     WHERE e.company_id = ? AND e.status = 'posted' AND l.contact_id = ? AND a.subtype IN ('receivable','payable') AND e.entry_date < ?`, company.id, contactId, from);
  const lines = await all<{ entry_date: string; entry_number: string; memo: string | null; source_type: string | null; source_id: string | null; debit: number; credit: number; currency: string | null; amount_fc: number | null; doc_number: string | null; pay_number: string | null }>(db,
    `SELECT e.entry_date, e.entry_number, e.memo, e.source_type, e.source_id, l.debit, l.credit, l.currency, l.amount_fc,
       d.number AS doc_number, p.number AS pay_number
     FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
     LEFT JOIN documents d ON d.id = e.source_id LEFT JOIN payments p ON p.id = e.source_id
     WHERE e.company_id = ? AND e.status = 'posted' AND l.contact_id = ? AND a.subtype IN ('receivable','payable') AND e.entry_date BETWEEN ? AND ?
     ORDER BY e.entry_date, e.posted_at`, company.id, contactId, from, to);
  let running = op?.b ?? 0;
  return {
    contact, from, to, opening: op?.b ?? 0,
    lines: lines.map((l) => { running += l.debit - l.credit; return { ...l, reference: l.doc_number ?? l.pay_number ?? l.entry_number, balance: running }; }),
    closing: running,
    note: "Positive balance = amount owed to you; negative = amount you owe (or customer advance).",
  };
}

export async function gstSummary(db: D1Database, company: CompanyRow, from: string, to: string) {
  const docs = await all<{ doc_type: string; rate_bp: number | null; tax_name: string | null; taxable: number; cgst: number; sgst: number; igst: number; other_tax: number; fx: number; total: number; total_base: number }>(db,
    `SELECT d.doc_type, t.rate_bp, t.name AS tax_name, SUM(l.taxable) AS taxable, SUM(l.cgst) AS cgst, SUM(l.sgst) AS sgst, SUM(l.igst) AS igst, SUM(l.other_tax) AS other_tax,
       d.fx_rate_scaled AS fx, 0 AS total, 0 AS total_base
     FROM document_lines l JOIN documents d ON d.id = l.document_id LEFT JOIN tax_codes t ON t.id = l.tax_code_id
     WHERE d.company_id = ? AND d.status IN ('posted') AND d.doc_type IN ('invoice','credit_note','bill','debit_note') AND d.issue_date BETWEEN ? AND ?
       AND d.currency = ?
     GROUP BY d.doc_type, t.id ORDER BY d.doc_type, t.rate_bp`, company.id, from, to, company.base_currency);
  const foreign = await first<{ n: number }>(db, `SELECT COUNT(*) AS n FROM documents WHERE company_id = ? AND status = 'posted' AND currency <> ? AND issue_date BETWEEN ? AND ?`, company.id, company.base_currency, from, to);
  // Ledger-based tax account movements are the authoritative totals (include expenses and foreign-currency documents).
  const ledger = await all<{ code: string; name: string; system_key: string | null; debit: number; credit: number }>(db,
    `SELECT a.code, a.name, a.system_key, COALESCE(SUM(l.debit),0) AS debit, COALESCE(SUM(l.credit),0) AS credit
     FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
     WHERE e.company_id = ? AND e.status = 'posted' AND e.entry_date BETWEEN ? AND ? AND a.subtype IN ('tax_input','tax_output')
     GROUP BY a.id ORDER BY a.code`, company.id, from, to);
  const output = ledger.filter((l) => l.system_key?.startsWith("OUT_")).reduce((t, l) => t + l.credit - l.debit, 0);
  const input = ledger.filter((l) => l.system_key?.startsWith("IN_")).reduce((t, l) => t + l.debit - l.credit, 0);
  const sign = (t: string) => (t === "credit_note" || t === "debit_note" ? -1 : 1);
  const outward = docs.filter((d) => d.doc_type === "invoice" || d.doc_type === "credit_note").map((d) => ({ ...d, sign: sign(d.doc_type) }));
  const inward = docs.filter((d) => d.doc_type === "bill" || d.doc_type === "debit_note").map((d) => ({ ...d, sign: sign(d.doc_type) }));
  return {
    from, to, outward, inward, ledger, output_tax: output, input_tax: input, net_payable: output - input,
    foreign_currency_documents: foreign?.n ?? 0,
    disclaimer: "Summary for review only. This is not a GSTR return and has not been validated against GST portal rules.",
  };
}

export async function inventoryValuation(db: D1Database, company: CompanyRow, asOf: string) {
  const rows = await all<{ item_id: string; name: string; sku: string | null; unit: string; qty_milli: number; value: number; reorder_level_milli: number }>(db,
    `SELECT i.id AS item_id, i.name, i.sku, i.unit, i.reorder_level_milli, COALESCE(SUM(s.qty_milli),0) AS qty_milli, COALESCE(SUM(s.value),0) AS value
     FROM items i LEFT JOIN stock_moves s ON s.item_id = i.id AND s.move_date <= ?
     WHERE i.company_id = ? AND i.track_inventory = 1 GROUP BY i.id ORDER BY i.name`, asOf, company.id);
  const stockValue = rows.reduce((t, r) => t + r.value, 0);
  const gl = await first<{ b: number }>(db,
    `SELECT COALESCE(SUM(l.debit - l.credit),0) AS b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
     WHERE e.company_id = ? AND e.status = 'posted' AND e.entry_date <= ? AND a.subtype = 'inventory'`, company.id, asOf);
  return {
    as_of: asOf, method: "Moving weighted average (company-wide per item)",
    items: rows.map((r) => ({ ...r, avg_cost: r.qty_milli > 0 ? Math.round((r.value * 1000) / r.qty_milli) : 0, below_reorder: r.reorder_level_milli > 0 && r.qty_milli <= r.reorder_level_milli })),
    stock_value: stockValue, ledger_value: gl?.b ?? 0, difference: (gl?.b ?? 0) - stockValue, reconciles: (gl?.b ?? 0) === stockValue,
  };
}

export async function budgetVsActual(db: D1Database, company: CompanyRow, budgetId: string) {
  const b = await first<{ id: string; name: string; start_date: string; end_date: string }>(db,
    `SELECT b.id, b.name, fy.start_date, fy.end_date FROM budgets b JOIN fiscal_years fy ON fy.id = b.fiscal_year_id WHERE b.id = ? AND b.company_id = ?`, budgetId, company.id);
  if (!b) return null;
  const budget = await all<{ account_id: string; code: string; name: string; type: string; amount: number }>(db,
    `SELECT bl.account_id, a.code, a.name, a.type, SUM(bl.amount) AS amount FROM budget_lines bl JOIN accounts a ON a.id = bl.account_id
     WHERE bl.budget_id = ? GROUP BY bl.account_id ORDER BY a.code`, budgetId);
  const actuals = await balances(db, company.id, b.start_date, b.end_date);
  const act = new Map(actuals.map((a) => [a.id, a.type === "income" ? a.credit - a.debit : a.debit - a.credit]));
  const rows = budget.map((r) => {
    const actual = act.get(r.account_id) ?? 0;
    const variance = r.type === "income" ? actual - r.amount : r.amount - actual; // positive = favourable
    return { ...r, actual, variance, favourable: variance >= 0 };
  });
  return { budget: b, rows };
}
