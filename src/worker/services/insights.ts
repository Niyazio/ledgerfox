/**
 * Deterministic, rule-based assistance. No external AI service is used.
 * Every suggestion is labelled as a suggestion and nothing here posts, approves or changes data.
 * Statistics (mean / standard deviation) are computed in floating point because they are
 * heuristics, never financial values; all reported amounts come straight from integer ledger data.
 */
import { all, first, todayIso } from "../lib/db";

const KEYWORDS: [RegExp, string[]][] = [
  [/\b(rent|lease)\b/i, ["Rent"]],
  [/\b(electric|power|water|utility|bescom|tneb|msedcl)\b/i, ["Electricity & Utilities"]],
  [/\b(internet|broadband|wifi|phone|mobile|airtel|jio|vodafone|bsnl|telecom)\b/i, ["Telephone & Internet"]],
  [/\b(uber|ola|taxi|cab|flight|train|irctc|hotel|travel|fuel|petrol|diesel|toll|parking)\b/i, ["Travel & Conveyance"]],
  [/\b(stationery|paper|printer|toner|office supplies|pens?)\b/i, ["Office Supplies & Stationery"]],
  [/\b(lawyer|legal|audit|ca fees|consult|professional)\b/i, ["Professional & Legal Fees"]],
  [/\b(aws|azure|google workspace|microsoft|software|saas|subscription|github|zoom|slack|domain|hosting)\b/i, ["Software & Subscriptions"]],
  [/\b(bank charge|bank fee|commission|sms charges|annual fee)\b/i, ["Bank Charges"]],
  [/\b(repair|maintenance|service charge|amc)\b/i, ["Repairs & Maintenance"]],
  [/\b(ads?|advert|marketing|facebook|meta|google ads|promotion|seo)\b/i, ["Advertising & Marketing"]],
  [/\b(insurance|premium|policy)\b/i, ["Insurance"]],
  [/\b(lunch|dinner|meal|restaurant|food|swiggy|zomato|coffee|tea)\b/i, ["Meals & Entertainment"]],
  [/\b(salary|wages|payroll|stipend)\b/i, ["Salaries & Wages"]],
];

export interface CategorySuggestion {
  account_id: string;
  account_name: string;
  reason: string;
  confidence: "high" | "medium" | "low";
}

export async function suggestExpenseCategory(db: D1Database, companyId: string, description: string, contactId: string | null): Promise<CategorySuggestion[]> {
  const out: CategorySuggestion[] = [];
  const seen = new Set<string>();
  const push = (s: CategorySuggestion) => { if (!seen.has(s.account_id)) { seen.add(s.account_id); out.push(s); } };
  if (contactId) {
    const hist = await all<{ id: string; name: string; n: number }>(db,
      `SELECT a.id, a.name, COUNT(*) AS n FROM expenses e JOIN accounts a ON a.id = e.category_account_id
       WHERE e.company_id = ? AND e.contact_id = ? GROUP BY a.id ORDER BY n DESC LIMIT 2`, companyId, contactId);
    for (const h of hist) push({ account_id: h.id, account_name: h.name, reason: `Used ${h.n} time(s) before for this supplier`, confidence: "high" });
  }
  const desc = description.trim();
  if (desc.length >= 3) {
    for (const [re, names] of KEYWORDS) {
      if (!re.test(desc)) continue;
      for (const name of names) {
        const a = await first<{ id: string; name: string }>(db, `SELECT id, name FROM accounts WHERE company_id = ? AND name = ? AND is_group = 0 AND is_active = 1`, companyId, name);
        if (a) push({ account_id: a.id, account_name: a.name, reason: `Description matches “${desc.match(re)?.[0]}”`, confidence: "medium" });
      }
    }
    const word = desc.split(/\s+/).find((w) => w.length >= 4);
    if (word) {
      const prev = await all<{ id: string; name: string; n: number }>(db,
        `SELECT a.id, a.name, COUNT(*) AS n FROM expenses e JOIN accounts a ON a.id = e.category_account_id
         WHERE e.company_id = ? AND e.description LIKE ? GROUP BY a.id ORDER BY n DESC LIMIT 2`, companyId, `%${word}%`);
      for (const p of prev) push({ account_id: p.id, account_name: p.name, reason: `Similar past expenses (“${word}”)`, confidence: "low" });
    }
  }
  return out.slice(0, 4);
}

export async function duplicateBillCheck(db: D1Database, companyId: string, contactId: string, reference: string | null, total: number, excludeId: string) {
  const warnings: string[] = [];
  if (reference) {
    const d = await first<{ number: string | null; status: string }>(db,
      `SELECT number, status FROM documents WHERE company_id = ? AND doc_type = 'bill' AND contact_id = ? AND reference = ? AND id <> ? AND status <> 'void' LIMIT 1`,
      companyId, contactId, reference, excludeId);
    if (d) warnings.push(`Possible duplicate: another bill from this supplier already uses reference “${reference}” (${d.number ?? "draft"}).`);
  }
  const same = await first<{ number: string | null; issue_date: string }>(db,
    `SELECT number, issue_date FROM documents WHERE company_id = ? AND doc_type = 'bill' AND contact_id = ? AND total = ? AND id <> ? AND status <> 'void'
       AND issue_date >= date('now', '-30 days') LIMIT 1`, companyId, contactId, total, excludeId);
  if (same) warnings.push(`Possible duplicate: a bill with the same amount from this supplier exists (${same.number ?? "draft"}, ${same.issue_date}).`);
  return warnings;
}

/** Flags posted expense/income lines that are > 3 standard deviations from the account's 12-month mean (min. 8 samples). */
export async function unusualTransactions(db: D1Database, companyId: string) {
  const rows = await all<{ account_id: string; account_name: string; amount: number; entry_id: string; entry_number: string; entry_date: string; memo: string | null }>(db,
    `SELECT l.account_id, a.name AS account_name, (l.debit + l.credit) AS amount, e.id AS entry_id, e.entry_number, e.entry_date, e.memo
     FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
     WHERE e.company_id = ? AND e.status = 'posted' AND a.type IN ('expense','income') AND e.kind <> 'reversal'
       AND e.entry_date >= date('now', '-365 days')
     ORDER BY e.entry_date DESC LIMIT 3000`, companyId);
  const byAcc = new Map<string, typeof rows>();
  for (const r of rows) (byAcc.get(r.account_id) ?? byAcc.set(r.account_id, []).get(r.account_id)!).push(r);
  const flags: { entry_id: string; entry_number: string; entry_date: string; account_name: string; amount: number; typical: number; reason: string }[] = [];
  for (const list of byAcc.values()) {
    if (list.length < 8) continue;
    const mean = list.reduce((s, r) => s + r.amount, 0) / list.length;
    const sd = Math.sqrt(list.reduce((s, r) => s + (r.amount - mean) ** 2, 0) / list.length);
    if (sd === 0) continue;
    for (const r of list.slice(0, 50)) {
      const z = (r.amount - mean) / sd;
      if (z > 3) flags.push({ entry_id: r.entry_id, entry_number: r.entry_number, entry_date: r.entry_date, account_name: r.account_name, amount: r.amount, typical: Math.round(mean), reason: `About ${z.toFixed(1)}× the usual spread above the typical amount for this account` });
    }
  }
  return flags.sort((a, b) => b.entry_date.localeCompare(a.entry_date)).slice(0, 20);
}

/** Simple cash projection from current cash + open receivables/payables by due date (base currency). */
export async function cashForecast(db: D1Database, companyId: string) {
  const today = todayIso();
  const cash = await first<{ bal: number }>(db,
    `SELECT COALESCE(SUM(l.debit - l.credit),0) AS bal FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
     WHERE e.company_id = ? AND e.status = 'posted' AND a.subtype IN ('cash','bank')`, companyId);
  const buckets = [
    { label: "Overdue", from: "0000-01-01", to: addDays(today, -1) },
    { label: "Next 30 days", from: today, to: addDays(today, 30) },
    { label: "31–60 days", from: addDays(today, 31), to: addDays(today, 60) },
    { label: "61–90 days", from: addDays(today, 61), to: addDays(today, 90) },
  ];
  // Outstanding converted at document rate: total_base × outstanding / total (integer arithmetic in SQL).
  const out = [];
  let running = cash?.bal ?? 0;
  for (const b of buckets) {
    const r = await first<{ inflow: number; outflow: number }>(db,
      `SELECT
         COALESCE(SUM(CASE WHEN doc_type = 'invoice' THEN (total_base * (total - amount_settled)) / total END),0) AS inflow,
         COALESCE(SUM(CASE WHEN doc_type = 'bill' THEN (total_base * (total - amount_settled)) / total END),0) AS outflow
       FROM documents WHERE company_id = ? AND status = 'posted' AND total > amount_settled AND total > 0
         AND COALESCE(due_date, issue_date) BETWEEN ? AND ?`, companyId, b.from, b.to);
    running += (r?.inflow ?? 0) - (r?.outflow ?? 0);
    out.push({ label: b.label, inflow: r?.inflow ?? 0, outflow: r?.outflow ?? 0, projected_balance: running });
  }
  return { opening_cash: cash?.bal ?? 0, buckets: out, note: "Projection assumes open invoices and bills are settled on their due dates; overdue items are assumed to settle now." };
}

function addDays(d: string, n: number) {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}

/** Plain-language explanation of a profit & loss comparison. Uses only the figures passed in. */
export function explainProfitAndLoss(cur: { income: number; expense: number; lines: { name: string; type: string; amount: number }[] }, prev: { income: number; expense: number; lines: { name: string; type: string; amount: number }[] }, fmt: (n: number) => string) {
  const sentences: string[] = [];
  const profit = cur.income - cur.expense;
  const prevProfit = prev.income - prev.expense;
  sentences.push(`Net ${profit >= 0 ? "profit" : "loss"} for the period is ${fmt(Math.abs(profit))} on income of ${fmt(cur.income)} and expenses of ${fmt(cur.expense)}.`);
  if (cur.income > 0) sentences.push(`Net margin is ${((profit * 100) / cur.income).toFixed(1)}%.`);
  if (prev.income || prev.expense) {
    const d = profit - prevProfit;
    sentences.push(`Compared with the previous period (${prevProfit >= 0 ? "profit" : "loss"} ${fmt(Math.abs(prevProfit))}), the result ${d >= 0 ? "improved" : "declined"} by ${fmt(Math.abs(d))}.`);
    const prevMap = new Map(prev.lines.map((l) => [l.name, l.amount]));
    const changes = cur.lines
      .map((l) => ({ ...l, delta: l.amount - (prevMap.get(l.name) ?? 0) }))
      .filter((l) => l.delta !== 0)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, 3);
    for (const ch of changes) {
      sentences.push(`${ch.name} ${ch.delta > 0 ? "increased" : "decreased"} by ${fmt(Math.abs(ch.delta))} (${ch.type}).`);
    }
  }
  const topExp = cur.lines.filter((l) => l.type === "expense").sort((a, b) => b.amount - a.amount)[0];
  if (topExp && cur.expense > 0) sentences.push(`The largest expense is ${topExp.name} at ${((topExp.amount * 100) / cur.expense).toFixed(1)}% of total expenses.`);
  return sentences;
}
