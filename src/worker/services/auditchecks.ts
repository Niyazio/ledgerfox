/**
 * Audit checks: what auditors look for first, checked automatically for a period. Each check says why it matters
 * and lists the entries to look at. Read-only. The India-specific limits (Income Tax Act s.40A(3) and s.269ST) apply
 * to Indian companies only.
 */
import type { CompanyRow } from "../env";
import { all, first } from "../lib/db";
import * as R from "./reports";

export interface AuditCheck { key: string; title: string; why: string; ok: boolean; count: number; rows: Record<string, unknown>[] }

const LIMIT = 100;

/** Numbers missing between the lowest and highest issued number of a series (e.g. INV-00004 between 3 and 5). */
export function numberGaps(numbers: string[]) {
  const series = new Map<string, number[]>();
  for (const n of numbers) {
    const m = /^(.*?)(\d+)$/.exec(n);
    if (!m) continue;
    const list = series.get(m[1]) ?? [];
    list.push(Number(m[2]));
    series.set(m[1], list);
  }
  const gaps: { series: string; missing: string }[] = [];
  for (const [prefix, list] of series) {
    const sorted = [...new Set(list)].sort((a, b) => a - b);
    const width = numbers.find((n) => n.startsWith(prefix))!.length - prefix.length;
    for (let i = 1; i < sorted.length && gaps.length < LIMIT; i++) {
      for (let x = sorted[i - 1] + 1; x < sorted[i] && gaps.length < LIMIT; x++) gaps.push({ series: prefix || "(no prefix)", missing: `${prefix}${String(x).padStart(width, "0")}` });
    }
  }
  return gaps;
}

export async function auditChecks(db: D1Database, company: CompanyRow, from: string, to: string): Promise<AuditCheck[]> {
  const cid = company.id;
  const india = company.country === "IN";
  const checks: AuditCheck[] = [];
  const add = (key: string, title: string, why: string, rows: Record<string, unknown>[]) => checks.push({ key, title, why, ok: rows.length === 0, count: rows.length, rows: rows.slice(0, LIMIT) });

  if (india) {
    add("cash_payments_40a3", "Cash payments over ₹10,000 to one party in a day",
      "Income Tax Act s.40A(3): such expenses may be disallowed. Pay by bank, UPI or cheque instead.",
      // Supplier payments and cash expenses together, per party per day.
      await all(db, `SELECT date, party, contact_id, SUM(amount) AS amount, COUNT(*) AS payments FROM (
          SELECT p.payment_date AS date, ct.name AS party, p.contact_id, p.amount_base AS amount
            FROM payments p JOIN accounts a ON a.id = p.account_id JOIN contacts ct ON ct.id = p.contact_id
           WHERE p.company_id = ? AND p.direction = 'out' AND p.status = 'posted' AND a.subtype = 'cash' AND p.payment_date BETWEEN ? AND ?
          UNION ALL
          SELECT x.expense_date, COALESCE(ct.name, x.description), COALESCE(x.contact_id, x.id), CAST(ROUND(x.total * x.fx_rate_scaled / 1000000000.0) AS INTEGER)
            FROM expenses x JOIN accounts a ON a.id = x.paid_from_account_id LEFT JOIN contacts ct ON ct.id = x.contact_id
           WHERE x.company_id = ? AND x.status = 'posted' AND a.subtype = 'cash' AND x.expense_date BETWEEN ? AND ?)
        GROUP BY date, contact_id HAVING SUM(amount) > 1000000 ORDER BY date`, cid, from, to, cid, from, to));
    add("cash_receipts_269st", "Cash received of ₹2,00,000 or more from one party in a day",
      "Income Tax Act s.269ST: receiving this much in cash attracts a penalty equal to the amount.",
      await all(db, `SELECT p.payment_date AS date, ct.name AS party, ct.id AS contact_id, SUM(p.amount_base) AS amount, COUNT(*) AS receipts
        FROM payments p JOIN accounts a ON a.id = p.account_id JOIN contacts ct ON ct.id = p.contact_id
       WHERE p.company_id = ? AND p.direction = 'in' AND p.status = 'posted' AND a.subtype = 'cash' AND p.payment_date BETWEEN ? AND ?
       GROUP BY p.payment_date, p.contact_id HAVING SUM(p.amount_base) >= 20000000 ORDER BY date`, cid, from, to));
    add("bills_no_gstin", "Bills with GST but no supplier GSTIN",
      "Input tax credit can be claimed only on invoices from registered suppliers whose GSTIN is on record.",
      await all(db, `SELECT d.id AS document_id, d.doc_type, d.number, d.reference, d.issue_date AS date, ct.name AS party, ct.id AS contact_id, d.tax_total AS amount
        FROM documents d JOIN contacts ct ON ct.id = d.contact_id
       WHERE d.company_id = ? AND d.doc_type = 'bill' AND d.status = 'posted' AND d.tax_total > 0 AND (ct.tax_id IS NULL OR ct.tax_id = '') AND d.issue_date BETWEEN ? AND ? ORDER BY d.issue_date`, cid, from, to));
  }

  add("negative_cash", "Cash balance below zero",
    "Cash in hand can never be negative: it usually means a receipt was not entered, or an expense was paid from another account.",
    await negativeCash(db, cid, from, to));

  add("backdated", "Entries made more than 30 days after their date",
    "Late or back-dated entries are a common audit question; check that each one has a reason.",
    await all(db, `SELECT e.id AS entry_id, e.entry_number AS number, e.entry_date AS date, substr(e.posted_at, 1, 10) AS entered_on, e.source_type, e.source_id, e.memo,
          CAST(julianday(substr(e.posted_at, 1, 10)) - julianday(e.entry_date) AS INTEGER) AS days_late
       FROM journal_entries e WHERE e.company_id = ? AND e.status = 'posted' AND e.kind <> 'opening' AND e.entry_date BETWEEN ? AND ?
        AND julianday(substr(e.posted_at, 1, 10)) - julianday(e.entry_date) > 30 ORDER BY days_late DESC`, cid, from, to));

  add("manual_to_control", "Manual journals posted to receivables, payables, stock, sales or tax accounts",
    "These accounts are normally changed only by invoices, bills, receipts and stock entries; a hand-made journal there bypasses those checks.",
    await all(db, `SELECT e.id AS entry_id, e.entry_number AS number, e.entry_date AS date, a.name AS account, l.debit, l.credit, e.memo
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
      WHERE e.company_id = ? AND e.status = 'posted' AND e.kind IN ('manual','adjustment') AND e.source_type IS NULL AND e.entry_date BETWEEN ? AND ?
        AND (a.subtype IN ('receivable','payable','inventory','tax_output','tax_input') OR a.system_key IN ('SALES','PURCHASES'))
      ORDER BY e.entry_date`, cid, from, to));

  add("duplicate_bills", "Possible duplicate supplier bills",
    "The same supplier invoice number entered twice means the expense and the input tax are counted twice.",
    await all(db, `SELECT ct.name AS party, ct.id AS contact_id, UPPER(d.reference) AS reference, COUNT(*) AS bills, SUM(d.total_base) AS amount, MIN(d.issue_date) AS date
       FROM documents d JOIN contacts ct ON ct.id = d.contact_id
      WHERE d.company_id = ? AND d.doc_type = 'bill' AND d.status = 'posted' AND d.reference IS NOT NULL AND d.reference <> '' AND d.issue_date BETWEEN ? AND ?
      GROUP BY d.contact_id, UPPER(d.reference) HAVING COUNT(*) > 1`, cid, from, to));

  const issued = await all<{ number: string }>(db, `SELECT number FROM documents WHERE company_id = ? AND doc_type IN ('invoice','credit_note') AND number IS NOT NULL AND issue_date BETWEEN ? AND ?`, cid, from, to);
  add("number_gaps", "Missing invoice / credit note numbers",
    "Auditors and tax officers expect an unbroken series; a missing number has to be explained.",
    numberGaps(issued.map((r) => r.number)));

  add("cancelled", "Cancelled (void) documents",
    "Cancellations are allowed but should be few and explained; they stay in the books with their number.",
    await all(db, `SELECT d.id AS document_id, d.doc_type, d.number, d.issue_date AS date, ct.name AS party, d.total_base AS amount,
          (SELECT json_extract(l.details, '$.reason') FROM audit_logs l WHERE l.entity_id = d.id AND l.action LIKE '%.void' ORDER BY l.created_at DESC LIMIT 1) AS reason
       FROM documents d JOIN contacts ct ON ct.id = d.contact_id WHERE d.company_id = ? AND d.status = 'void' AND d.number IS NOT NULL AND d.issue_date BETWEEN ? AND ? ORDER BY d.issue_date`, cid, from, to));

  // The ledgers agree with the details behind them.
  const recv = await R.aging(db, company, "receivable", to);
  const pay = await R.aging(db, company, "payable", to);
  const stock = await R.inventoryValuation(db, company, to);
  add("ledger_agrees", "Ledger balances agree with their details",
    "Receivables = unpaid invoices, payables = unpaid bills, stock account = stock value. A difference usually means a manual journal.",
    [
      ...(recv.unreconciled_difference ? [{ account: "Accounts receivable", ledger: recv.ledger_balance, details: recv.totals.total, difference: recv.unreconciled_difference }] : []),
      ...(pay.unreconciled_difference ? [{ account: "Accounts payable", ledger: pay.ledger_balance, details: pay.totals.total, difference: pay.unreconciled_difference }] : []),
      ...(!stock.reconciles ? [{ account: "Inventory", ledger: stock.ledger_value, details: stock.stock_value, difference: stock.difference }] : []),
    ]);

  const locked = await first<{ n: number }>(db, `SELECT COUNT(*) AS n FROM fiscal_periods WHERE company_id = ? AND status <> 'open' AND end_date >= ? AND start_date <= ?`, cid, from, to);
  checks.push({ key: "periods_locked", title: "Closed periods locked", why: "After the accounts are finalised, lock the period (Settings → Fiscal periods) so nothing changes behind the auditor.", ok: (locked?.n ?? 0) > 0, count: locked?.n ?? 0, rows: [] });
  return checks;
}

/** Days on which a cash account's running balance went below zero. */
async function negativeCash(db: D1Database, companyId: string, from: string, to: string) {
  const accounts = await all<{ id: string; name: string }>(db, `SELECT id, name FROM accounts WHERE company_id = ? AND subtype = 'cash' AND is_group = 0`, companyId);
  const out: Record<string, unknown>[] = [];
  for (const a of accounts) {
    const opening = (await first<{ b: number }>(db, `SELECT COALESCE(SUM(l.debit - l.credit),0) AS b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.company_id = ? AND e.status = 'posted' AND l.account_id = ? AND e.entry_date < ?`, companyId, a.id, from))?.b ?? 0;
    const days = await all<{ d: string; net: number }>(db, `SELECT e.entry_date AS d, SUM(l.debit - l.credit) AS net FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.company_id = ? AND e.status = 'posted' AND l.account_id = ? AND e.entry_date BETWEEN ? AND ? GROUP BY e.entry_date ORDER BY e.entry_date`, companyId, a.id, from, to);
    let bal = opening;
    for (const day of days) { bal += day.net; if (bal < 0) out.push({ date: day.d, account: a.name, account_id: a.id, balance: bal }); }
  }
  return out;
}
