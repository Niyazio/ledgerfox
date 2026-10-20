import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { all, batch, first, stmt } from "../lib/db";
import { badRequest, conflict, notFound } from "../lib/errors";
import { body, reqText, shortText, minor, pageParams } from "../lib/validate";
import { newId } from "../lib/crypto";
import { audit, requirePerm } from "../lib/auth";
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
});

function validate(input: z.infer<typeof schema>, companyCountry: string) {
  if (input.currency && !isCurrency(input.currency)) throw badRequest("Unsupported currency");
  const country = input.country ?? companyCountry;
  if (country === "IN") {
    if (input.tax_id && !isValidGstin(input.tax_id)) throw badRequest("GSTIN is not valid (format or check digit)");
    if (input.state_code && !INDIA_STATES[input.state_code]) throw badRequest("Unknown state code");
    if (input.tax_id && !input.state_code) input.state_code = input.tax_id.slice(0, 2);
  }
}

contacts.get("/", async (c) => {
  const company = c.get("company");
  const { limit, offset } = pageParams(c);
  const kind = c.req.query("kind");
  const q = c.req.query("q");
  const where = ["ct.company_id = ?"];
  const params: (string | number)[] = [company.id];
  if (kind === "customer") where.push("ct.kind IN ('customer','both')");
  if (kind === "supplier") where.push("ct.kind IN ('supplier','both')");
  if (c.req.query("active") === "1") where.push("ct.is_active = 1");
  if (q) { where.push("(ct.name LIKE ? OR ct.email LIKE ? OR ct.tax_id LIKE ?)"); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const rows = await all(
    c.env.DB,
    `SELECT ct.*,
       (SELECT COALESCE(SUM(CASE WHEN d.doc_type = 'invoice' THEN d.total - d.amount_settled ELSE 0 END),0) FROM documents d WHERE d.contact_id = ct.id AND d.status = 'posted') AS receivable,
       (SELECT COALESCE(SUM(CASE WHEN d.doc_type = 'bill' THEN d.total - d.amount_settled ELSE 0 END),0) FROM documents d WHERE d.contact_id = ct.id AND d.status = 'posted') AS payable
     FROM contacts ct WHERE ${where.join(" AND ")} ORDER BY ct.name LIMIT ? OFFSET ?`,
    ...params, limit, offset,
  );
  const total = await first<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM contacts ct WHERE ${where.join(" AND ")}`, ...params);
  return c.json({ contacts: rows, total: total?.n ?? 0 });
});

contacts.get("/:id", async (c) => {
  const company = c.get("company");
  const ct = await first(c.env.DB, `SELECT * FROM contacts WHERE id = ? AND company_id = ?`, c.req.param("id"), company.id);
  if (!ct) throw notFound("Contact");
  const docs = await all(c.env.DB,
    `SELECT id, doc_type, number, issue_date, due_date, status, currency, total, amount_settled FROM documents
     WHERE company_id = ? AND contact_id = ? ORDER BY issue_date DESC LIMIT 100`, company.id, c.req.param("id"));
  const payments = await all(c.env.DB,
    `SELECT id, direction, number, payment_date, currency, amount, status FROM payments WHERE company_id = ? AND contact_id = ? ORDER BY payment_date DESC LIMIT 100`,
    company.id, c.req.param("id"));
  return c.json({ contact: ct, documents: docs, payments });
});

contacts.post("/", async (c) => {
  requirePerm(c, "masters.write");
  const input = await body(c, schema);
  const company = c.get("company");
  validate(input, company.country);
  const id = newId();
  const limitMinor = input.credit_limit ? minor(input.credit_limit, currencyExponent(input.currency ?? company.base_currency), "credit limit") : null;
  await batch(c.env.DB, [
    stmt(c.env.DB,
      `INSERT INTO contacts (id, company_id, kind, name, email, phone, tax_id, pan, state_code, country, billing_address, shipping_address,
         currency, payment_terms_days, credit_limit, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, company.id, input.kind, input.name, input.email || null, input.phone ?? null, input.tax_id?.toUpperCase() ?? null, input.pan ?? null,
      input.state_code ?? null, input.country ?? company.country, input.billing_address ?? null, input.shipping_address ?? null,
      input.currency ?? null, input.payment_terms_days, limitMinor, input.notes ?? null),
    audit(c, "contact.create", "contact", id, { name: input.name, kind: input.kind }),
  ]);
  return c.json({ id }, 201);
});

contacts.put("/:id", async (c) => {
  requirePerm(c, "masters.write");
  const input = await body(c, schema);
  const company = c.get("company");
  const id = c.req.param("id");
  validate(input, company.country);
  const existing = await first<{ currency: string | null }>(c.env.DB, `SELECT currency FROM contacts WHERE id = ? AND company_id = ?`, id, company.id);
  if (!existing) throw notFound("Contact");
  if ((existing.currency ?? null) !== (input.currency ?? null)) {
    const used = await first(c.env.DB, `SELECT 1 FROM documents WHERE contact_id = ? AND status <> 'draft' LIMIT 1`, id);
    if (used) throw conflict("CONTACT_IN_USE", "The currency of a contact with posted documents cannot be changed");
  }
  const limitMinor = input.credit_limit ? minor(input.credit_limit, currencyExponent(input.currency ?? company.base_currency), "credit limit") : null;
  await batch(c.env.DB, [
    stmt(c.env.DB,
      `UPDATE contacts SET kind = ?, name = ?, email = ?, phone = ?, tax_id = ?, pan = ?, state_code = ?, country = ?, billing_address = ?,
         shipping_address = ?, currency = ?, payment_terms_days = ?, credit_limit = ?, notes = ?, is_active = ? WHERE id = ? AND company_id = ?`,
      input.kind, input.name, input.email || null, input.phone ?? null, input.tax_id?.toUpperCase() ?? null, input.pan ?? null, input.state_code ?? null,
      input.country ?? company.country, input.billing_address ?? null, input.shipping_address ?? null, input.currency ?? null,
      input.payment_terms_days, limitMinor, input.notes ?? null, input.is_active === false ? 0 : 1, id, company.id),
    audit(c, "contact.update", "contact", id, { name: input.name }),
  ]);
  return c.json({ ok: true });
});

contacts.delete("/:id", async (c) => {
  requirePerm(c, "masters.write");
  const company = c.get("company");
  const id = c.req.param("id");
  const used = await first(c.env.DB,
    `SELECT 1 FROM documents WHERE contact_id = ? UNION ALL SELECT 1 FROM payments WHERE contact_id = ? UNION ALL SELECT 1 FROM journal_lines WHERE contact_id = ? UNION ALL SELECT 1 FROM expenses WHERE contact_id = ? LIMIT 1`,
    id, id, id, id);
  if (used) throw conflict("CONTACT_IN_USE", "This contact has transactions. Mark it inactive instead.");
  const r = await first(c.env.DB, `SELECT 1 FROM contacts WHERE id = ? AND company_id = ?`, id, company.id);
  if (!r) throw notFound("Contact");
  await batch(c.env.DB, [stmt(c.env.DB, `DELETE FROM contacts WHERE id = ? AND company_id = ?`, id, company.id), audit(c, "contact.delete", "contact", id)]);
  return c.json({ ok: true });
});

export default contacts;
