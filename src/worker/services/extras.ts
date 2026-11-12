/**
 * More everyday features:
 * - project time billing: log hours against a project and turn the unbilled hours into a draft invoice;
 * - advances (retainers) taken against a quotation, proforma or sales order, applied when its invoice is issued;
 * - today's exchange rates fetched automatically for the currencies a company uses;
 * - GSTR-2B matching: the government's statement of supplier invoices compared with the bills in the books.
 */
import type { Context } from "hono";
import type { AppEnv, CompanyRow, Env } from "../env";
import { all, first, run, todayIso } from "../lib/db";
import { newId } from "../lib/crypto";
import { badRequest } from "../lib/errors";
import { applyCredit } from "./payments";
import { RATE_SCALE_NUM } from "@shared/money";
import { isCurrency } from "@shared/currencies";

// ── Advances on quotations / proformas / sales orders ──

/** The quotation / order an invoice came from, and the one that came from (quote → sales order → invoice). */
async function sourceDocs(db: D1Database, companyId: string, invoiceId: string) {
  const ids: string[] = [];
  let cur = (await first<{ related_doc_id: string | null }>(db, `SELECT related_doc_id FROM documents WHERE id = ? AND company_id = ?`, invoiceId, companyId))?.related_doc_id;
  for (let i = 0; cur && i < 3; i++) {
    ids.push(cur);
    cur = (await first<{ related_doc_id: string | null; doc_type: string }>(db, `SELECT related_doc_id, doc_type FROM documents WHERE id = ? AND company_id = ?`, cur, companyId))?.related_doc_id;
  }
  return ids;
}

/** Applies advances taken on the invoice's quotation / order to the newly issued invoice (as far as it is due). */
export async function applyAdvances(c: Context<AppEnv>, invoiceId: string) {
  const db = c.env.DB, company = c.get("company");
  const from = await sourceDocs(db, company.id, invoiceId);
  if (!from.length) return 0;
  const advances = await all<{ payment_id: string; amount: number; currency: string; applied: number }>(db,
    `SELECT p.id AS payment_id, p.amount, p.currency,
            COALESCE((SELECT SUM(a.amount) FROM allocations a WHERE a.payment_id = p.id), 0) AS applied
       FROM advance_links l JOIN payments p ON p.id = l.payment_id
      WHERE l.company_id = ? AND l.document_id IN (${from.map(() => "?").join(",")}) AND p.status = 'posted' ORDER BY p.payment_date`, company.id, ...from);
  let applied = 0;
  for (const a of advances) {
    const inv = await first<{ total: number; amount_settled: number; currency: string; issue_date: string }>(db, `SELECT total, amount_settled, currency, issue_date FROM documents WHERE id = ?`, invoiceId);
    if (!inv || inv.currency !== a.currency) continue;
    const amt = Math.min(a.amount - a.applied, inv.total - inv.amount_settled);
    if (amt <= 0) continue;
    await applyCredit(c, { kind: "payment", id: a.payment_id }, invoiceId, amt, inv.issue_date > todayIso() ? inv.issue_date : todayIso());
    applied += amt;
  }
  return applied;
}

// ── Exchange rates ──

/** Today's rates for one base currency: units of each currency per 1 base unit (free public source, no key). */
async function latestRates(base: string): Promise<Record<string, number> | null> {
  try {
    const res = await fetch(`https://open.er-api.com/v6/latest/${base}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { result?: string; rates?: Record<string, number> };
    return j.result === "success" && j.rates ? j.rates : null;
  } catch { return null; }
}

/** Currencies a company deals in besides its own. */
export async function usedCurrencies(db: D1Database, company: Pick<CompanyRow, "id" | "base_currency">) {
  const rows = await all<{ currency: string }>(db,
    `SELECT currency FROM contacts WHERE company_id = ? AND currency IS NOT NULL
     UNION SELECT currency FROM documents WHERE company_id = ? UNION SELECT currency FROM exchange_rates WHERE company_id = ?`, company.id, company.id, company.id);
  return rows.map((r) => r.currency).filter((c) => c && c !== company.base_currency && isCurrency(c));
}

/**
 * Saves today's rate for each currency the company uses. A rate already entered for today (by hand) is kept.
 * `cache` shares one download per base currency across companies (daily job).
 */
export async function refreshRates(db: D1Database, company: Pick<CompanyRow, "id" | "base_currency">, date = todayIso(), cache = new Map<string, Record<string, number> | null>()) {
  const want = await usedCurrencies(db, company);
  if (!want.length) return { saved: 0, currencies: [] as string[] };
  if (!cache.has(company.base_currency)) cache.set(company.base_currency, await latestRates(company.base_currency));
  const rates = cache.get(company.base_currency);
  if (!rates) throw badRequest("Could not get today's exchange rates. Try again later, or enter the rate by hand.");
  let saved = 0;
  const done: string[] = [];
  for (const cur of want) {
    const perBase = rates[cur];
    if (!perBase || perBase <= 0) continue;
    // Stored as base units per 1 foreign unit × 1e9.
    const scaled = Math.round(RATE_SCALE_NUM / perBase);
    const r = await run(db, `INSERT OR IGNORE INTO exchange_rates (id, company_id, currency, rate_date, rate_scaled) VALUES (?,?,?,?,?)`, newId(), company.id, cur, date, scaled);
    if (r.meta.changes) { saved++; done.push(cur); }
  }
  return { saved, currencies: done };
}

export async function dailyRates(env: Env) {
  const companies = await all<{ id: string; base_currency: string }>(env.DB,
    `SELECT id, base_currency FROM companies co WHERE EXISTS (SELECT 1 FROM contacts ct WHERE ct.company_id = co.id AND ct.currency IS NOT NULL AND ct.currency <> co.base_currency)
        OR EXISTS (SELECT 1 FROM exchange_rates r WHERE r.company_id = co.id)`);
  const cache = new Map<string, Record<string, number> | null>();
  let saved = 0;
  for (const co of companies) { try { saved += (await refreshRates(env.DB, co, todayIso(), cache)).saved; } catch { /* source unavailable: try tomorrow */ } }
  return saved;
}

// ── GSTR-2B matching ──

interface TwoBInvoice { ctin: string; supplier: string; number: string; date: string; value: number; taxable: number; tax: number }
const paise = (n: unknown) => Math.round(Number(n ?? 0) * 100);
/** Invoice numbers compared loosely: "ST/0077", "st-77" and "ST 77" are the same number. */
const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/(^|[A-Z])0+(?=\d)/g, "$1");

/** Reads the B2B invoices from a GSTR-2B JSON file downloaded from the GST portal. */
export function parseGstr2b(json: unknown): { period: string | null; invoices: TwoBInvoice[] } {
  const root = (json as { data?: unknown })?.data ?? json;
  const r = root as { rtnprd?: string; docdata?: { b2b?: { ctin: string; trdnm?: string; inv?: Record<string, unknown>[] }[] } };
  const b2b = r?.docdata?.b2b;
  if (!Array.isArray(b2b)) throw badRequest("This does not look like a GSTR-2B JSON file. Download it from the GST portal: Returns → GSTR-2B → Download → JSON.");
  const invoices: TwoBInvoice[] = [];
  for (const s of b2b) for (const inv of s.inv ?? []) {
    const items = (inv.items as Record<string, unknown>[] | undefined) ?? [];
    const sum = (k: string) => (inv[k] !== undefined ? paise(inv[k]) : items.reduce((t, it) => t + paise(it[k]), 0));
    const [dd, mm, yyyy] = String(inv.dt ?? "").split("-");
    invoices.push({ ctin: String(s.ctin).toUpperCase(), supplier: s.trdnm ?? s.ctin, number: String(inv.inum ?? ""), date: yyyy ? `${yyyy}-${mm}-${dd}` : String(inv.dt ?? ""),
      value: paise(inv.val), taxable: sum("txval"), tax: sum("igst") + sum("cgst") + sum("sgst") + sum("cess") });
  }
  return { period: r.rtnprd ?? null, invoices };
}

/** Compares the 2B invoices with posted bills (matched by supplier GSTIN + supplier invoice number). */
export async function matchGstr2b(db: D1Database, companyId: string, parsed: ReturnType<typeof parseGstr2b>) {
  const p = parsed.period && /^\d{6}$/.test(parsed.period) ? { from: `${parsed.period.slice(2)}-${parsed.period.slice(0, 2)}-01` } : null;
  const to = p ? new Date(Date.UTC(Number(p.from.slice(0, 4)), Number(p.from.slice(5, 7)), 0)).toISOString().slice(0, 10) : null;
  const bills = await all<{ id: string; number: string; reference: string | null; issue_date: string; gstin: string | null; supplier: string; taxable: number; tax: number; total: number }>(db,
    `SELECT d.id, d.number, d.reference, d.issue_date, UPPER(ct.tax_id) AS gstin, ct.name AS supplier, d.total,
            COALESCE(SUM(l.taxable),0) AS taxable, COALESCE(SUM(l.cgst + l.sgst + l.igst + l.other_tax),0) AS tax
       FROM documents d JOIN contacts ct ON ct.id = d.contact_id LEFT JOIN document_lines l ON l.document_id = d.id
      WHERE d.company_id = ? AND d.doc_type = 'bill' AND d.status = 'posted' AND d.currency = 'INR' GROUP BY d.id`, companyId);
  const byKey = new Map(bills.filter((b) => b.gstin && b.reference).map((b) => [`${b.gstin}|${norm(b.reference!)}`, b]));
  const used = new Set<string>();
  const rows: { status: "matched" | "mismatch" | "missing_in_books" | "missing_in_2b"; supplier: string; gstin: string | null; number: string; date: string; twob?: { taxable: number; tax: number; value: number }; books?: { id: string; number: string; taxable: number; tax: number; total: number } }[] = [];
  for (const inv of parsed.invoices) {
    const b = byKey.get(`${inv.ctin}|${norm(inv.number)}`);
    if (!b) { rows.push({ status: "missing_in_books", supplier: inv.supplier, gstin: inv.ctin, number: inv.number, date: inv.date, twob: inv }); continue; }
    used.add(b.id);
    const same = Math.abs(b.taxable - inv.taxable) <= 100 && Math.abs(b.tax - inv.tax) <= 100;
    rows.push({ status: same ? "matched" : "mismatch", supplier: b.supplier, gstin: inv.ctin, number: inv.number, date: inv.date, twob: inv, books: { id: b.id, number: b.number, taxable: b.taxable, tax: b.tax, total: b.total } });
  }
  // Bills of the 2B month that the suppliers have not reported (their input tax credit is at risk).
  for (const b of bills) {
    if (used.has(b.id) || !b.gstin || (p && (b.issue_date < p.from || b.issue_date > to!))) continue;
    rows.push({ status: "missing_in_2b", supplier: b.supplier, gstin: b.gstin, number: b.reference ?? b.number, date: b.issue_date, books: { id: b.id, number: b.number, taxable: b.taxable, tax: b.tax, total: b.total } });
  }
  const sum = (s: string, k: "twob" | "books") => rows.filter((r) => r.status === s).reduce((t, r) => t + (r[k]?.tax ?? 0), 0);
  return {
    period: parsed.period, from: p?.from ?? null, to,
    counts: { matched: rows.filter((r) => r.status === "matched").length, mismatch: rows.filter((r) => r.status === "mismatch").length, missing_in_books: rows.filter((r) => r.status === "missing_in_books").length, missing_in_2b: rows.filter((r) => r.status === "missing_in_2b").length },
    tax: { matched: sum("matched", "twob"), missing_in_books: sum("missing_in_books", "twob"), missing_in_2b: sum("missing_in_2b", "books") },
    rows,
  };
}
