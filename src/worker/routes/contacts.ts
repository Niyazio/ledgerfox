import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { all, batch, first, stmt } from "../lib/db";
import { badRequest, conflict, notFound } from "../lib/errors";
import { body, reqText, shortText, minor, pageParams } from "../lib/validate";
import { newId } from "../lib/crypto";
import { audit, branchFilter, hasPerm, requireAnyPerm, requirePerm } from "../lib/auth";
import type { Context } from "hono";
import { isValidGstin, INDIA_STATES } from "@shared/tax";
import { currencyExponent, isCurrency } from "@shared/currencies";

const contacts = new Hono<AppEnv>();

const schema = z.object({
  kind: z.enum(["customer", "supplier", "both"]),
  name: reqText(200),
  email: z.string().trim().email().max(254).nullish().or(z.literal("")),
  phone: shortText(40).nullish(),
  tax_id: shortText(30).nullish(),
  pan: shortText(12).nullish(),
  state_code: shortText(4).nullish(),
  country: z.string().regex(/^[A-Z]{2}$/).nullish(),
  billing_address: shortText(600).nullish(),
  shipping_address: shortText(600).nullish(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullish(),
  payment_terms_days: z.number().int().min(0).max(365).default(30),
  credit_limit: z.union([z.string(), z.number()]).nullish(),
  notes: shortText(2000).nullish(),
  is_active: z.boolean().optional(),
  price_list_id: z.string().max(64).nullish(),
});

/** A price list given for a contact must be one of this company's. */
async function checkPriceList(db: D1Database, companyId: string, id: string | null | undefined) {
  if (id && !(await first(db, `SELECT 1 FROM price_lists WHERE id = ? AND company_id = ?`, id, companyId))) throw badRequest("Unknown price list");
}

function validate(input: z.infer<typeof schema>, companyCountry: string) {
  if (input.currency && !isCurrency(input.currency)) throw badRequest("Unsupported currency");
  const country = input.country ?? companyCountry;
  if (country === "IN") {
    if (input.tax_id && !isValidGstin(input.tax_id)) throw badRequest("GSTIN is not valid (format or check digit)");
    if (input.state_code && !INDIA_STATES[input.state_code]) throw badRequest("Unknown state code");
    if (input.tax_id && !input.state_code) input.state_code = input.tax_id.slice(0, 2);
  }
}

/** Customers are governed by sales permissions, suppliers by purchase permissions; "both" needs both. */
function requireKindWrite(c: Context<AppEnv>, kind: string) {
  if (kind === "customer" || kind === "both") requirePerm(c, "customers.write");
  if (kind === "supplier" || kind === "both") requirePerm(c, "suppliers.write");
}
const canSeeCustomers = (c: Context<AppEnv>) => ["sales.view", "sales.create", "customers.write"].some((p) => hasPerm(c, p as never));
const canSeeSuppliers = (c: Context<AppEnv>) => ["purchase.view", "purchase.create", "suppliers.write"].some((p) => hasPerm(c, p as never));

contacts.get("/", async (c) => {
  const company = c.get("company");
  const { limit, offset } = pageParams(c);
  const kind = c.req.query("kind");
  const q = c.req.query("q");
  const where = ["ct.company_id = ?"];
  const params: (string | number)[] = [company.id];
  const cust = canSeeCustomers(c), supp = canSeeSuppliers(c);
  if (!cust && !supp) requireAnyPerm(c, "sales.view", "purchase.view");
  if (kind === "customer" || (!supp && kind !== "supplier")) { if (!cust) requireAnyPerm(c, "sales.view"); where.push("ct.kind IN ('customer','both')"); }
  if (kind === "supplier" || (!cust && kind !== "customer")) { if (!supp) requireAnyPerm(c, "purchase.view"); where.push("ct.kind IN ('supplier','both')"); }
  if (c.req.query("active") === "1") where.push("ct.is_active = 1");
  if (q) { where.push("(ct.name LIKE ? OR ct.email LIKE ? OR ct.tax_id LIKE ?)"); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  // Open balances are summed once per company (outstanding documents only) and joined, rather than per contact;
  // branch-limited members only see their branches' documents in these totals.
  const bf = branchFilter(c, "branch_id");
  const rows = await all(
    c.env.DB,
    `SELECT ct.*, COALESCE(b.receivable,0) AS receivable, COALESCE(b.payable,0) AS payable
     FROM contacts ct
     LEFT JOIN (SELECT contact_id,
                  SUM(CASE WHEN doc_type = 'invoice' THEN total - amount_settled ELSE 0 END) AS receivable,
                  SUM(CASE WHEN doc_type = 'bill' THEN total - amount_settled ELSE 0 END) AS payable
                FROM documents WHERE company_id = ? AND status = 'posted' AND doc_type IN ('invoice','bill') AND total > amount_settled${bf.sql}
                GROUP BY contact_id) b ON b.contact_id = ct.id
     WHERE ${where.join(" AND ")} ORDER BY ct.name LIMIT ? OFFSET ?`,
    company.id, ...bf.params, ...params, limit, offset,
  );
  const total = await first<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM contacts ct WHERE ${where.join(" AND ")}`, ...params);
  return c.json({ contacts: rows, total: total?.n ?? 0 });
});

contacts.get("/:id", async (c) => {
  const company = c.get("company");
  const ct = await first<{ kind: string }>(c.env.DB, `SELECT * FROM contacts WHERE id = ? AND company_id = ?`, c.req.param("id"), company.id);
  if (!ct) throw notFound("Contact");
  const cust = canSeeCustomers(c), supp = canSeeSuppliers(c);
  if (!((ct.kind !== "supplier" && cust) || (ct.kind !== "customer" && supp))) throw notFound("Contact");
  // Only documents and payments of the families and branches this member may see.
  const fam = [...(cust ? ["quote", "sales_order", "invoice", "credit_note"] : []), ...(supp ? ["purchase_order", "bill", "debit_note"] : [])];
  const dirs = [...(cust ? ["in"] : []), ...(supp ? ["out"] : [])];
  const bd = branchFilter(c, "branch_id");
  const docs = await all(c.env.DB,
    `SELECT id, doc_type, number, issue_date, due_date, status, currency, total, amount_settled FROM documents
     WHERE company_id = ? AND contact_id = ? AND doc_type IN (${fam.map(() => "?").join(",") || "''"})${bd.sql} ORDER BY issue_date DESC LIMIT 100`, company.id, c.req.param("id"), ...fam, ...bd.params);
  const payments = await all(c.env.DB,
    `SELECT id, direction, number, payment_date, currency, amount, status FROM payments WHERE company_id = ? AND contact_id = ? AND direction IN (${dirs.map(() => "?").join(",") || "''"})${bd.sql} ORDER BY payment_date DESC LIMIT 100`,
    company.id, c.req.param("id"), ...dirs, ...bd.params);
  return c.json({ contact: ct, documents: docs, payments });
});

contacts.post("/", async (c) => {
  const input = await body(c, schema);
  requireKindWrite(c, input.kind);
  const company = c.get("company");
  validate(input, company.country);
  await checkPriceList(c.env.DB, company.id, input.price_list_id);
  const id = newId();
  const limitMinor = input.credit_limit ? minor(input.credit_limit, currencyExponent(input.currency ?? company.base_currency), "credit limit") : null;
  await batch(c.env.DB, [
    stmt(c.env.DB,
      `INSERT INTO contacts (id, company_id, kind, name, email, phone, tax_id, pan, state_code, country, billing_address, shipping_address,
         currency, payment_terms_days, credit_limit, notes, price_list_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, company.id, input.kind, input.name, input.email || null, input.phone ?? null, input.tax_id?.toUpperCase() ?? null, input.pan ?? null,
      input.state_code ?? null, input.country ?? company.country, input.billing_address ?? null, input.shipping_address ?? null,
      input.currency ?? null, input.payment_terms_days, limitMinor, input.notes ?? null, input.price_list_id || null),
    audit(c, "contact.create", "contact", id, { name: input.name, kind: input.kind }),
  ]);
  return c.json({ id }, 201);
});

contacts.put("/:id", async (c) => {
  const input = await body(c, schema);
  const company = c.get("company");
  const id = c.req.param("id");
  validate(input, company.country);
  await checkPriceList(c.env.DB, company.id, input.price_list_id);
  const existing = await first<{ currency: string | null; kind: string }>(c.env.DB, `SELECT currency, kind FROM contacts WHERE id = ? AND company_id = ?`, id, company.id);
  if (!existing) throw notFound("Contact");
  requireKindWrite(c, existing.kind);
  requireKindWrite(c, input.kind);
  if ((existing.currency ?? null) !== (input.currency ?? null)) {
    const used = await first(c.env.DB, `SELECT 1 FROM documents WHERE contact_id = ? AND status <> 'draft' LIMIT 1`, id);
    if (used) throw conflict("CONTACT_IN_USE", "The currency of a contact with posted documents cannot be changed");
  }
  const limitMinor = input.credit_limit ? minor(input.credit_limit, currencyExponent(input.currency ?? company.base_currency), "credit limit") : null;
  await batch(c.env.DB, [
    stmt(c.env.DB,
      `UPDATE contacts SET kind = ?, name = ?, email = ?, phone = ?, tax_id = ?, pan = ?, state_code = ?, country = ?, billing_address = ?,
         shipping_address = ?, currency = ?, payment_terms_days = ?, credit_limit = ?, notes = ?, is_active = ?,
         price_list_id = CASE WHEN ? THEN ? ELSE price_list_id END WHERE id = ? AND company_id = ?`,
      input.kind, input.name, input.email || null, input.phone ?? null, input.tax_id?.toUpperCase() ?? null, input.pan ?? null, input.state_code ?? null,
      input.country ?? company.country, input.billing_address ?? null, input.shipping_address ?? null, input.currency ?? null,
      input.payment_terms_days, limitMinor, input.notes ?? null, input.is_active === false ? 0 : 1,
      input.price_list_id === undefined ? 0 : 1, input.price_list_id || null, id, company.id),
    audit(c, "contact.update", "contact", id, { name: input.name }),
  ]);
  return c.json({ ok: true });
});

contacts.delete("/:id", async (c) => {
  const company = c.get("company");
  const id = c.req.param("id");
  // Ownership first, so another tenant's IDs are indistinguishable from non-existent ones.
  const r = await first<{ kind: string }>(c.env.DB, `SELECT kind FROM contacts WHERE id = ? AND company_id = ?`, id, company.id);
  if (!r) throw notFound("Contact");
  requireKindWrite(c, r.kind);
  const used = await first(c.env.DB,
    `SELECT 1 FROM documents WHERE contact_id = ? UNION ALL SELECT 1 FROM payments WHERE contact_id = ? UNION ALL SELECT 1 FROM journal_lines WHERE contact_id = ? UNION ALL SELECT 1 FROM expenses WHERE contact_id = ? LIMIT 1`,
    id, id, id, id);
  if (used) throw conflict("CONTACT_IN_USE", "This contact has transactions. Mark it inactive instead.");
  await batch(c.env.DB, [stmt(c.env.DB, `DELETE FROM contacts WHERE id = ? AND company_id = ?`, id, company.id), audit(c, "contact.delete", "contact", id)]);
  return c.json({ ok: true });
});

export default contacts;
