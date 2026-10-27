import { Hono } from "hono";
import { listPrice } from "@shared/pricing";
import { contactPricing } from "./priceLists";
import { z } from "zod";
import type { AppEnv } from "../env";
import { all, batch, first, stmt, todayIso } from "../lib/db";
import { AppError, badRequest, notFound } from "../lib/errors";
import { body, minor, optId, percentBp, qty } from "../lib/validate";
import { newId } from "../lib/crypto";
import { audit, hasPerm, requirePerm, resolveBranch } from "../lib/auth";
import { currencyExponent, formatMoney } from "@shared/currencies";
import { issueDocument, prepareDraft, type DraftInput } from "../services/documents";
import { recordPayment } from "../services/payments";
import { systemAccounts } from "../services/ledger";

/**
 * Counter sale: creates and issues the invoice and records the payment(s) — cash, UPI and/or card — in one step.
 * A sale paid less than in full is a credit sale and needs a named customer within their credit limit.
 */
const pos = new Hono<AppEnv>();
pos.use("*", async (c, next) => { requirePerm(c, "sales.create"); requirePerm(c, "sales.post"); await next(); });

export const WALK_IN = "Walk-in customer";

const saleSchema = z.object({
  contact_id: optId,
  lines: z.array(z.object({
    item_id: z.string().min(1),
    quantity: z.union([z.string(), z.number()]),
    unit_price: z.union([z.string(), z.number()]).nullish(),
    discount_percent: z.union([z.string(), z.number()]).nullish(),
  })).min(1).max(200),
  payments: z.array(z.object({ mode: z.enum(["cash", "upi", "card"]), amount: z.union([z.string(), z.number()]), reference: z.string().max(60).nullish() })).max(3).default([]),
  branch_id: optId,
  warehouse_id: optId,
  notes: z.string().max(500).nullish(),
});

/** The shared walk-in customer contact, created on first use. */
async function walkIn(db: D1Database, companyId: string, stateCode: string | null) {
  const found = await first<{ id: string }>(db, `SELECT id FROM contacts WHERE company_id = ? AND kind IN ('customer','both') AND name = ? LIMIT 1`, companyId, WALK_IN);
  if (found) return found.id;
  const id = newId();
  await batch(db, [stmt(db, `INSERT INTO contacts (id, company_id, kind, name, state_code, payment_terms_days) VALUES (?,?,?,?,?,0)`, id, companyId, "customer", WALK_IN, stateCode)]);
  return id;
}

pos.post("/sale", async (c) => {
  const input = await body(c, saleSchema);
  const company = c.get("company");
  const exp = currencyExponent(company.base_currency);
  const contactId = input.contact_id || (await walkIn(c.env.DB, company.id, company.state_code));
  const contact = await first<{ name: string; credit_limit: number | null; currency: string | null }>(c.env.DB, `SELECT name, credit_limit, currency FROM contacts WHERE id = ? AND company_id = ?`, contactId, company.id);
  if (!contact) throw notFound("Customer");
  if (contact.currency && contact.currency !== company.base_currency) throw badRequest("The counter bills in the base currency; use an invoice for this customer");
  const ids = [...new Set(input.lines.map((l) => l.item_id))];
  const items = await all<{ id: string; name: string; hsn_sac: string | null; sale_price: number; tax_code_id: string | null; is_active: number; income_account_id: string | null }>(c.env.DB,
    `SELECT id, name, hsn_sac, sale_price, tax_code_id, is_active, income_account_id FROM items WHERE company_id = ? AND id IN (${ids.map(() => "?").join(",")})`, company.id, ...ids);
  const byId = new Map(items.map((i) => [i.id, i]));
  const changePrice = hasPerm(c, "sales.discount_any");
  // The customer's price list sets the counter rate; staff without discount rights may only use that rate.
  const pricing = await contactPricing(c.env.DB, company.id, input.contact_id);
  const limit = company.billing_discount_limit_bp;
  const lines = input.lines.map((l, n) => {
    const it = byId.get(l.item_id);
    if (!it || !it.is_active) throw badRequest(`Line ${n + 1}: product not found or inactive`);
    const q = qty(l.quantity, `Line ${n + 1} quantity`);
    if (q <= 0) throw badRequest(`Line ${n + 1}: quantity must be positive`);
    const listed = listPrice(it.sale_price, pricing.list, pricing.breaks, it.id, q);
    const price = l.unit_price === null || l.unit_price === undefined || l.unit_price === "" ? listed : minor(l.unit_price, exp, `Line ${n + 1} price`);
    if (price !== listed && !changePrice) throw new AppError(403, "PRICE_LOCKED", `${it.name}: you cannot change the selling price`);
    const disc = percentBp(l.discount_percent ?? 0, `Line ${n + 1} discount`);
    if (disc < 0 || disc > 10000) throw badRequest(`Line ${n + 1}: discount must be 0–100%`);
    if (limit !== null && limit !== undefined && disc > limit && !hasPerm(c, "sales.discount_any")) throw new AppError(403, "DISCOUNT_LIMIT", `Discounts above ${limit / 100}% need a manager's approval`);
    return { item_id: it.id, description: it.name, hsn_sac: it.hsn_sac, qty_milli: q, unit_price: price, discount_bp: disc, account_id: it.income_account_id, tax_code_id: it.tax_code_id };
  });
  const draft: DraftInput = {
    doc_type: "invoice", contact_id: contactId, issue_date: todayIso(), due_date: todayIso(), currency: company.base_currency,
    branch_id: resolveBranch(c, input.branch_id), warehouse_id: input.warehouse_id ?? null, notes: input.notes ?? null, reference: "Counter sale", lines,
  };
  const prepared = await prepareDraft(c, draft);
  const total = prepared.totals.total;
  const pays = input.payments.map((p) => ({ ...p, minor: minor(p.amount, exp, `${p.mode} amount`) })).filter((p) => p.minor > 0);
  const paid = pays.reduce((t, p) => t + p.minor, 0);
  if (paid > total) throw badRequest(`Payments (${formatMoney(paid, company.base_currency)}) are more than the bill (${formatMoney(total, company.base_currency)}). Enter the amount kept, not the cash handed over.`);
  if (paid < total) {
    if (!input.contact_id) throw badRequest("Choose the customer for a credit sale (not fully paid)");
    if (contact.credit_limit) {
      const open = await first<{ due: number }>(c.env.DB, `SELECT COALESCE(SUM(total - amount_settled),0) AS due FROM documents WHERE company_id = ? AND contact_id = ? AND doc_type = 'invoice' AND status = 'posted'`, company.id, contactId);
      if ((open?.due ?? 0) + total - paid > contact.credit_limit && !hasPerm(c, "sales.credit_override")) throw new AppError(409, "CREDIT_LIMIT", `${contact.name} would go over their credit limit`);
    }
  }
  await batch(c.env.DB, [...prepared.stmts, audit(c, "invoice.create", "document", prepared.id, { total, pos: true })]);
  const number = await issueDocument(c, prepared.id);
  const acc = await systemAccounts(c.env.DB, company.id, ["CASH", "BANK"]);
  const receipts: string[] = [];
  try {
    for (const p of pays) {
      const r = await recordPayment(c, {
        direction: "in", contact_id: contactId, payment_date: todayIso(), account_id: p.mode === "cash" ? acc.CASH : acc.BANK, amount: p.minor,
        method: p.mode === "card" ? "card" : p.mode === "upi" ? "upi" : "cash", reference: p.reference ?? number ?? null, branch_id: draft.branch_id,
        allocations: [{ document_id: prepared.id, amount: p.minor }],
      });
      receipts.push(r.id);
    }
  } catch (e) {
    // The invoice is issued; tell the cashier exactly what is missing rather than hiding it.
    throw new AppError(500, "PAYMENT_NOT_RECORDED", `Invoice ${number} was saved but a payment could not be recorded (${(e as Error).message}). Record it from the invoice.`, { invoice_id: prepared.id });
  }
  return c.json({ invoice_id: prepared.id, number, total, paid, balance: total - paid, receipts }, 201);
});

export default pos;
