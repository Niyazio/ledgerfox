import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { all, batch, first, stmt, nowIso } from "../lib/db";
import { badRequest, conflict, notFound, unprocessable } from "../lib/errors";
import { body, reqText, shortText, isoDate, rate, percentBp, minor } from "../lib/validate";
import { newId } from "../lib/crypto";
import { audit, requirePerm } from "../lib/auth";
import { requireCapacity } from "../services/billing";
import { companySchema, validateCompanyInput } from "./orgs";
import { fiscalYearStatements, monthlyPeriods } from "../services/setup";
import { currencyExponent, isCurrency } from "@shared/currencies";
import { JURISDICTIONS, schemeForCountry } from "@shared/tax";
import { rateToString } from "@shared/money";

const settings = new Hono<AppEnv>();

settings.get("/", async (c) => {
  const company = c.get("company");
  const role = c.get("role");
  const [branches, departments, projects, costCentres, taxCodes, warehouses, units] = await Promise.all([
    all(c.env.DB, `SELECT * FROM branches WHERE company_id = ? ORDER BY code`, company.id),
    all(c.env.DB, `SELECT * FROM departments WHERE company_id = ? ORDER BY code`, company.id),
    all(c.env.DB, `SELECT * FROM projects WHERE company_id = ? ORDER BY code`, company.id),
    all(c.env.DB, `SELECT * FROM cost_centres WHERE company_id = ? ORDER BY code`, company.id),
    all(c.env.DB, `SELECT * FROM tax_codes WHERE company_id = ? ORDER BY scheme, rate_bp, name`, company.id),
    all(c.env.DB, `SELECT * FROM warehouses WHERE company_id = ? ORDER BY code`, company.id),
    all(c.env.DB, `SELECT * FROM units WHERE company_id = ? ORDER BY code`, company.id),
  ]);
  return c.json({
    company: { ...company, print_language: company.print_lang ?? company.print_language },
    role,
    permissions: c.get("perms"),
    branch_scope: c.get("branches"),
    jurisdiction: JURISDICTIONS[company.country] ?? JURISDICTIONS.DEFAULT,
    tax_scheme: schemeForCountry(company.country),
    branches, departments, projects, cost_centres: costCentres, tax_codes: taxCodes, warehouses, units,
  });
});

settings.patch("/", async (c) => {
  requirePerm(c, "company.manage");
  const company = c.get("company");
  const input = await body(c, companySchema.omit({ country: true, base_currency: true, fiscal_year_start_month: true, is_demo: true, business_type: true }).extend({
    print_template: z.enum(["modern", "classic", "compact"]).optional(),
    print_language: z.enum(["en", "hi", "ta", "ml", "kn"]).optional(),
    print_qr_verify: z.boolean().optional(),
    print_qr_upi: z.boolean().optional(),
    round_off_invoices: z.boolean().optional(),
    invoice_terms: shortText(2000).nullish(),
    date_format: z.enum(["DD-MM-YYYY", "MM/DD/YYYY", "YYYY-MM-DD", "DD/MM/YYYY"]).optional(),
    number_locale: z.enum(["en-IN", "en-US", "en-GB", "de-DE", "fr-FR", "ar-AE"]).optional(),
    // Approval limits: purchases above this amount need purchase.approve; sales discounts above this % need sales.discount_any. Empty = no limit.
    purchase_approval_limit: z.union([z.string(), z.number()]).nullish(),
    billing_discount_limit: z.union([z.string(), z.number()]).nullish(),
  }));
  const limits = {
    purchase: input.purchase_approval_limit === undefined ? undefined : input.purchase_approval_limit === null || input.purchase_approval_limit === "" ? null : minor(input.purchase_approval_limit, currencyExponent(company.base_currency), "approval limit"),
    discount: input.billing_discount_limit === undefined ? undefined : input.billing_discount_limit === null || input.billing_discount_limit === "" ? null : percentBp(input.billing_discount_limit, "discount limit"),
  };
  if ((limits.purchase ?? 0) < 0 || (limits.discount ?? 0) < 0 || (limits.discount ?? 0) > 10000) throw badRequest("Limits must be positive (discount 0–100%)");
  validateCompanyInput({ ...input, country: company.country, base_currency: company.base_currency, fiscal_year_start_month: company.fiscal_year_start_month });
  await batch(c.env.DB, [
    stmt(
      c.env.DB,
      `UPDATE companies SET name = ?, legal_name = ?, tax_id = ?, state_code = ?, address = ?, city = ?, postal_code = ?, phone = ?, email = ?,
         round_off_invoices = COALESCE(?, round_off_invoices), invoice_terms = ?, date_format = COALESCE(?, date_format), number_locale = COALESCE(?, number_locale),
         upi_id = CASE WHEN ? THEN ? ELSE upi_id END, print_template = COALESCE(?, print_template), print_language = COALESCE(?, print_language), print_lang = COALESCE(?, print_lang),
         print_qr_verify = COALESCE(?, print_qr_verify), print_qr_upi = COALESCE(?, print_qr_upi),
         purchase_approval_limit = CASE WHEN ? THEN ? ELSE purchase_approval_limit END,
         billing_discount_limit_bp = CASE WHEN ? THEN ? ELSE billing_discount_limit_bp END
       WHERE id = ?`,
      input.name, input.legal_name ?? null, input.tax_id ?? null, input.state_code ?? null, input.address ?? null, input.city ?? null,
      input.postal_code ?? null, input.phone ?? null, input.email || null,
      input.round_off_invoices === undefined ? null : input.round_off_invoices ? 1 : 0, input.invoice_terms ?? null,
      input.date_format ?? null, input.number_locale ?? null,
      input.upi_id === undefined ? 0 : 1, input.upi_id || null, input.print_template ?? null,
      // The old column accepts only en/hi/ta; the new one holds any supported language.
      input.print_language === undefined ? null : ["en", "hi", "ta"].includes(input.print_language) ? input.print_language : "en", input.print_language ?? null,
      input.print_qr_verify === undefined ? null : input.print_qr_verify ? 1 : 0, input.print_qr_upi === undefined ? null : input.print_qr_upi ? 1 : 0,
      limits.purchase === undefined ? 0 : 1, limits.purchase ?? null, limits.discount === undefined ? 0 : 1, limits.discount ?? null, company.id,
    ),
    audit(c, "company.update", "company", company.id, input),
  ]);
  return c.json({ ok: true });
});

// ── Dimensions (branches, departments, projects, cost centres) ──
const DIMENSIONS = { branches: "branches", departments: "departments", projects: "projects", "cost-centres": "cost_centres" } as const;
const dimSchema = z.object({
  name: reqText(120), code: reqText(20), is_active: z.boolean().optional(), state_code: shortText(4).nullish(), address: shortText(500).nullish(),
  invoice_prefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,8}$/, "Prefix: up to 8 letters or digits").nullish().or(z.literal("")),
  phone: shortText(40).nullish(), gstin: shortText(15).nullish(),
});

for (const [path, table] of Object.entries(DIMENSIONS)) {
  settings.post(`/${path}`, async (c) => {
    requirePerm(c, table === "branches" ? "branches.manage" : "company.manage");
    const input = await body(c, dimSchema);
    if (table === "branches") await requireCapacity(c, c.get("company").org_id, "branches", c.get("company").id);
    const id = newId();
    const company = c.get("company");
    const s = table === "branches"
      ? stmt(c.env.DB, `INSERT INTO branches (id, company_id, name, code, state_code, address, invoice_prefix, phone, gstin) VALUES (?,?,?,?,?,?,?,?,?)`, id, company.id, input.name, input.code, input.state_code ?? null, input.address ?? null, input.invoice_prefix || null, input.phone ?? null, input.gstin || null)
      : stmt(c.env.DB, `INSERT INTO ${table} (id, company_id, name, code) VALUES (?,?,?,?)`, id, company.id, input.name, input.code);
    await batch(c.env.DB, [s, audit(c, `${table}.create`, table, id, input)]);
    return c.json({ id }, 201);
  });
  settings.patch(`/${path}/:id`, async (c) => {
    requirePerm(c, table === "branches" ? "branches.manage" : "company.manage");
    const input = await body(c, dimSchema);
    const company = c.get("company");
    const id = c.req.param("id");
    const r = await first(c.env.DB, `SELECT 1 FROM ${table} WHERE id = ? AND company_id = ?`, id, company.id);
    if (!r) throw notFound();
    const s = table === "branches"
      ? stmt(c.env.DB, `UPDATE branches SET name = ?, code = ?, state_code = ?, address = ?, is_active = ?,
          invoice_prefix = CASE WHEN ? THEN ? ELSE invoice_prefix END, phone = CASE WHEN ? THEN ? ELSE phone END, gstin = CASE WHEN ? THEN ? ELSE gstin END WHERE id = ? AND company_id = ?`,
          input.name, input.code, input.state_code ?? null, input.address ?? null, input.is_active === false ? 0 : 1,
          input.invoice_prefix !== undefined ? 1 : 0, input.invoice_prefix || null, input.phone !== undefined ? 1 : 0, input.phone ?? null, input.gstin !== undefined ? 1 : 0, input.gstin || null, id, company.id)
      : stmt(c.env.DB, `UPDATE ${table} SET name = ?, code = ?, is_active = ? WHERE id = ? AND company_id = ?`, input.name, input.code, input.is_active === false ? 0 : 1, id, company.id);
    await batch(c.env.DB, [s, audit(c, `${table}.update`, table, id, input)]);
    return c.json({ ok: true });
  });
}

// ── Tax codes ──
const taxSchema = z.object({
  name: reqText(80),
  rate: z.union([z.string(), z.number()]),
  category: z.enum(["standard", "zero", "exempt", "nil", "non_gst", "reverse_charge"]).default("standard"),
  is_active: z.boolean().optional(),
});

settings.post("/tax-codes", async (c) => {
  requirePerm(c, "company.manage");
  const input = await body(c, taxSchema);
  const company = c.get("company");
  const bp = percentBp(input.rate, "rate");
  if (bp > 100000) throw badRequest("Rate cannot exceed 1000%");
  const id = newId();
  await batch(c.env.DB, [
    stmt(c.env.DB, `INSERT INTO tax_codes (id, company_id, name, scheme, rate_bp, category) VALUES (?,?,?,?,?,?)`,
      id, company.id, input.name, schemeForCountry(company.country), bp, input.category),
    audit(c, "tax_code.create", "tax_code", id, input),
  ]);
  return c.json({ id }, 201);
});

settings.patch("/tax-codes/:id", async (c) => {
  requirePerm(c, "company.manage");
  const input = await body(c, taxSchema.partial());
  const company = c.get("company");
  const id = c.req.param("id");
  const t = await first<{ rate_bp: number }>(c.env.DB, `SELECT rate_bp FROM tax_codes WHERE id = ? AND company_id = ?`, id, company.id);
  if (!t) throw notFound("Tax code");
  const newBp = input.rate !== undefined ? percentBp(input.rate, "rate") : t.rate_bp;
  if (newBp !== t.rate_bp) {
    const used = await first(c.env.DB, `SELECT 1 FROM document_lines WHERE tax_code_id = ? LIMIT 1`, id);
    if (used) throw conflict("TAX_CODE_IN_USE", "This tax code is used on documents. Create a new code for the new rate and deactivate this one.");
  }
  await batch(c.env.DB, [
    stmt(c.env.DB, `UPDATE tax_codes SET name = COALESCE(?, name), rate_bp = ?, category = COALESCE(?, category), is_active = COALESCE(?, is_active) WHERE id = ? AND company_id = ?`,
      input.name ?? null, newBp, input.category ?? null, input.is_active === undefined ? null : input.is_active ? 1 : 0, id, company.id),
    audit(c, "tax_code.update", "tax_code", id, input),
  ]);
  return c.json({ ok: true });
});

// ── Numbering ──
settings.get("/sequences", async (c) => {
  return c.json({ sequences: await all(c.env.DB, `SELECT key, prefix, next_value, padding FROM number_sequences WHERE company_id = ? ORDER BY key`, c.get("company").id) });
});

settings.patch("/sequences/:key", async (c) => {
  requirePerm(c, "company.manage");
  const input = await body(c, z.object({ prefix: z.string().max(20).regex(/^[A-Za-z0-9/_-]*$/), padding: z.number().int().min(1).max(10) }));
  const company = c.get("company");
  const key = c.req.param("key");
  await batch(c.env.DB, [
    stmt(c.env.DB, `UPDATE number_sequences SET prefix = ?, padding = ? WHERE company_id = ? AND key = ?`, input.prefix, input.padding, company.id, key),
    audit(c, "sequence.update", "sequence", key, input),
  ]);
  return c.json({ ok: true });
});

// ── Exchange rates ──
settings.get("/exchange-rates", async (c) => {
  const rows = await all<{ id: string; currency: string; rate_date: string; rate_scaled: number }>(
    c.env.DB, `SELECT id, currency, rate_date, rate_scaled FROM exchange_rates WHERE company_id = ? ORDER BY rate_date DESC, currency LIMIT 500`, c.get("company").id,
  );
  return c.json({ rates: rows.map((r) => ({ ...r, rate: rateToString(r.rate_scaled) })) });
});

settings.post("/exchange-rates", async (c) => {
  requirePerm(c, "accounts.write");
  const input = await body(c, z.object({ currency: z.string().regex(/^[A-Z]{3}$/), rate_date: isoDate, rate: z.union([z.string(), z.number()]) }));
  const company = c.get("company");
  if (!isCurrency(input.currency)) throw badRequest("Unsupported currency");
  if (input.currency === company.base_currency) throw badRequest("The base currency always has a rate of 1");
  const id = newId();
  await batch(c.env.DB, [
    stmt(c.env.DB, `INSERT INTO exchange_rates (id, company_id, currency, rate_date, rate_scaled, created_by) VALUES (?,?,?,?,?,?)
      ON CONFLICT(company_id, currency, rate_date) DO UPDATE SET rate_scaled = excluded.rate_scaled`,
      id, company.id, input.currency, input.rate_date, rate(input.rate), c.get("user").id),
    audit(c, "exchange_rate.set", "exchange_rate", `${input.currency}:${input.rate_date}`, input),
  ]);
  return c.json({ ok: true }, 201);
});

settings.get("/exchange-rates/lookup", async (c) => {
  const currency = c.req.query("currency") ?? "";
  const date = c.req.query("date") ?? "";
  const company = c.get("company");
  if (currency === company.base_currency) return c.json({ rate: "1", rate_date: date });
  const r = await first<{ rate_scaled: number; rate_date: string }>(
    c.env.DB, `SELECT rate_scaled, rate_date FROM exchange_rates WHERE company_id = ? AND currency = ? AND rate_date <= ? ORDER BY rate_date DESC LIMIT 1`,
    company.id, currency, date,
  );
  return c.json(r ? { rate: rateToString(r.rate_scaled), rate_date: r.rate_date } : { rate: null });
});

// ── Fiscal years & periods ──
settings.get("/fiscal-years", async (c) => {
  const company = c.get("company");
  const years = await all(c.env.DB, `SELECT * FROM fiscal_years WHERE company_id = ? ORDER BY start_date DESC`, company.id);
  const periods = await all(c.env.DB, `SELECT * FROM fiscal_periods WHERE company_id = ? ORDER BY start_date`, company.id);
  return c.json({ fiscal_years: years, periods });
});

settings.post("/fiscal-years", async (c) => {
  requirePerm(c, "period.manage");
  const input = await body(c, z.object({ start_date: isoDate, end_date: isoDate, name: reqText(40) }));
  const company = c.get("company");
  if (!input.start_date.endsWith("-01")) throw badRequest("A fiscal year must start on the first day of a month");
  const months = monthlyPeriods(input.start_date, input.end_date);
  const last = months[months.length - 1];
  if (!last || last.end !== input.end_date) throw badRequest("A fiscal year must end on the last day of a month");
  if (months.length > 24) throw badRequest("A fiscal year cannot exceed 24 months");
  const overlap = await first(c.env.DB, `SELECT 1 FROM fiscal_years WHERE company_id = ? AND start_date <= ? AND end_date >= ?`, company.id, input.end_date, input.start_date);
  if (overlap) throw unprocessable("OVERLAP", "This fiscal year overlaps an existing one");
  const fy = fiscalYearStatements(c.env.DB, company.id, { start: input.start_date, end: input.end_date, name: input.name });
  await batch(c.env.DB, [...fy.stmts, audit(c, "fiscal_year.create", "fiscal_year", fy.fyId, input)]);
  return c.json({ id: fy.fyId }, 201);
});

settings.post("/periods/:id/:action{lock|unlock}", async (c) => {
  requirePerm(c, "period.manage");
  const company = c.get("company");
  const id = c.req.param("id");
  const action = c.req.param("action");
  const p = await first<{ status: string; name: string }>(c.env.DB, `SELECT status, name FROM fiscal_periods WHERE id = ? AND company_id = ?`, id, company.id);
  if (!p) throw notFound("Period");
  const status = action === "lock" ? "locked" : "open";
  await batch(c.env.DB, [
    stmt(c.env.DB, `UPDATE fiscal_periods SET status = ?, locked_by = ?, locked_at = ? WHERE id = ? AND company_id = ?`,
      status, status === "locked" ? c.get("user").id : null, status === "locked" ? nowIso() : null, id, company.id),
    audit(c, `period.${action}`, "fiscal_period", id, { name: p.name }),
  ]);
  return c.json({ ok: true, status });
});

/** Lock every open period up to and including the given date ("close the books through"). */
settings.post("/periods/lock-through", async (c) => {
  requirePerm(c, "period.manage");
  const input = await body(c, z.object({ date: isoDate }));
  const company = c.get("company");
  await batch(c.env.DB, [
    stmt(c.env.DB, `UPDATE fiscal_periods SET status = 'locked', locked_by = ?, locked_at = ? WHERE company_id = ? AND end_date <= ? AND status = 'open'`,
      c.get("user").id, nowIso(), company.id, input.date),
    audit(c, "period.lock_through", "company", company.id, input),
  ]);
  return c.json({ ok: true });
});

// ── Audit log ──
settings.get("/audit-log", async (c) => {
  requirePerm(c, "audit.read");
  const company = c.get("company");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "100", 10) || 100, 500);
  const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);
  const entity = c.req.query("entity_id");
  const rows = await all(
    c.env.DB,
    `SELECT a.id, a.action, a.entity_type, a.entity_id, a.details, a.ip, a.created_at, u.name AS user_name, u.email AS user_email
     FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
     WHERE (a.company_id = ? OR (a.company_id IS NULL AND a.org_id = ?)) ${entity ? "AND a.entity_id = ?" : ""}
     ORDER BY a.created_at DESC LIMIT ? OFFSET ?`,
    ...(entity ? [company.id, company.org_id, entity, limit, offset] : [company.id, company.org_id, limit, offset]),
  );
  return c.json({ entries: rows });
});

// ── Branding: logo and the business's own payment QR, shown on printed documents ──

const MAX_IMAGE_BYTES = 300 * 1024;

/** Accept only base64 PNG/JPEG/WebP data URLs whose bytes match the declared type. */
export function validImageDataUrl(v: string): boolean {
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(v);
  if (!m) return false;
  if ((m[2].length * 3) / 4 > MAX_IMAGE_BYTES) return false;
  let head: string;
  try { head = atob(m[2].slice(0, 24)); } catch { return false; }
  const b = Array.from(head, (ch) => ch.charCodeAt(0));
  if (m[1] === "png") return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  if (m[1] === "jpeg") return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  return head.slice(0, 4) === "RIFF" && head.slice(8, 12) === "WEBP";
}

settings.get("/branding", async (c) => {
  const row = await first<{ logo: string | null; payment_qr: string | null }>(c.env.DB, `SELECT logo, payment_qr FROM company_branding WHERE company_id = ?`, c.get("company").id);
  return c.json({ logo: row?.logo ?? null, payment_qr: row?.payment_qr ?? null });
});

settings.put("/branding", async (c) => {
  requirePerm(c, "company.manage");
  const company = c.get("company");
  const input = await body(c, z.object({ logo: z.string().max(450_000).nullish(), payment_qr: z.string().max(450_000).nullish() }));
  for (const [k, v] of Object.entries(input)) {
    if (v && !validImageDataUrl(v)) throw badRequest(`${k === "logo" ? "Logo" : "Payment QR"} must be a PNG, JPEG or WebP image up to 300 KB`);
  }
  await batch(c.env.DB, [
    stmt(c.env.DB, `INSERT INTO company_branding (company_id, logo, payment_qr) VALUES (?, ?, ?)
      ON CONFLICT (company_id) DO UPDATE SET logo = CASE WHEN ? THEN excluded.logo ELSE logo END,
        payment_qr = CASE WHEN ? THEN excluded.payment_qr ELSE payment_qr END, updated_at = ?`,
      company.id, input.logo ?? null, input.payment_qr ?? null, input.logo === undefined ? 0 : 1, input.payment_qr === undefined ? 0 : 1, nowIso()),
    audit(c, "company.branding", "company", company.id, { logo: input.logo === undefined ? "unchanged" : input.logo ? "set" : "removed", payment_qr: input.payment_qr === undefined ? "unchanged" : input.payment_qr ? "set" : "removed" }),
  ]);
  return c.json({ ok: true });
});

export default settings;
