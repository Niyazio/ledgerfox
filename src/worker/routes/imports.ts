import { Hono } from "hono";
import { z } from "zod";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { all, batch, stmt, todayIso } from "../lib/db";
import { body, isoDate, minor, qty } from "../lib/validate";
import { newId } from "../lib/crypto";
import { audit, hasPerm, requirePerm } from "../lib/auth";
import { currencyExponent, isCurrency } from "@shared/currencies";
import { INDIA_STATES, isValidGstin } from "@shared/tax";
import { buildJournal, systemAccounts, assertOpenPeriod } from "../services/ledger";
import { stockMoveStmt, defaultWarehouse } from "../services/inventory";

/**
 * Bulk import of customers/suppliers and products from a spreadsheet. The browser reads the Excel/CSV file and sends
 * rows (header → value) in chunks of up to 200; `dry_run` checks every row without saving. A chunk is all-or-nothing.
 * Header names are matched loosely (e.g. "GSTIN", "GST No", "Party name") so exports from other accounting and billing software work.
 */
const imports = new Hono<AppEnv>();
const MAX_ROWS = 200;

const payload = z.object({
  rows: z.array(z.record(z.string(), z.unknown())).min(1).max(MAX_ROWS),
  dry_run: z.boolean().default(false),
  kind: z.enum(["customer", "supplier"]).optional(),
  as_of: isoDate.optional(),
});

/** Normalised header → canonical field. */
const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");
function picker(row: Record<string, unknown>) {
  const m = new Map(Object.entries(row).map(([k, v]) => [norm(k), v == null ? "" : String(v).trim()]));
  return (...names: string[]) => { for (const n of names) { const v = m.get(norm(n)); if (v) return v; } return ""; };
}
/** Spreadsheet dates: 2027-03-31, 31-03-2027, 31/03/2027, 03/2027 (end of month), or an Excel serial number. */
export function isoFromAny(v: string): string | null {
  const s = v.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m) return valid(+m[3], +m[2], +m[1]);
  m = /^(\d{1,2})[-/](\d{4})$/.exec(s);
  if (m) return valid(+m[2], +m[1], new Date(Date.UTC(+m[2], +m[1], 0)).getUTCDate());
  if (/^\d{5}$/.test(s)) return new Date(Date.UTC(1899, 11, 30) + Number(s) * 86_400_000).toISOString().slice(0, 10);
  return null;
}
function valid(y: number, mo: number, d: number) {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null;
}

const yes = (v: string) => /^(y|yes|true|1|track|stock)$/i.test(v);
const money = (v: string) => v.replace(/[₹,\s]/g, "").replace(/^rs\.?/i, "");

interface RowError { row: number; message: string }
interface Outcome { created: number; skipped: { row: number; reason: string }[]; errors: RowError[] }

function stateCode(v: string): string | null {
  if (!v) return null;
  const s = v.trim();
  if (/^\d{1,2}$/.test(s)) return s.padStart(2, "0");
  const hit = Object.entries(INDIA_STATES).find(([, name]) => norm(name) === norm(s.replace(/^\d+\s*[-–]\s*/, "")));
  return hit?.[0] ?? null;
}

function respond(c: Context<AppEnv>, o: Outcome, dryRun: boolean) {
  return c.json({ dry_run: dryRun, ok: o.errors.length === 0, ...o });
}

imports.post("/contacts", async (c) => {
  const input = await body(c, payload);
  const company = c.get("company");
  const india = company.country === "IN";
  const existing = await all<{ name: string; tax_id: string | null; kind: string }>(c.env.DB, `SELECT name, tax_id, kind FROM contacts WHERE company_id = ?`, company.id);
  const names = new Set(existing.map((e) => `${e.kind}|${e.name.toLowerCase()}`));
  const gstins = new Set(existing.filter((e) => e.tax_id).map((e) => e.tax_id!.toUpperCase()));
  const out: Outcome = { created: 0, skipped: [], errors: [] };
  const stmts: D1PreparedStatement[] = [];
  input.rows.forEach((raw, i) => {
    const row = i + 1;
    const p = picker(raw);
    const name = p("name", "party name", "customer name", "supplier name", "ledger name", "company name");
    if (!name) { out.errors.push({ row, message: "Name is missing" }); return; }
    const kindRaw = p("type", "kind", "party type", "group").toLowerCase();
    const kind = /both/.test(kindRaw) ? "both" : /supplier|vendor|creditor/.test(kindRaw) ? "supplier" : /customer|debtor|client/.test(kindRaw) ? "customer" : input.kind ?? "customer";
    if ((kind === "customer" || kind === "both") && !hasPerm(c, "customers.write")) { out.errors.push({ row, message: "You may not add customers" }); return; }
    if ((kind === "supplier" || kind === "both") && !hasPerm(c, "suppliers.write")) { out.errors.push({ row, message: "You may not add suppliers" }); return; }
    const gstin = p("gstin", "gst no", "gst number", "gstin/uin", "tax id").toUpperCase();
    if (gstin && india && !isValidGstin(gstin)) { out.errors.push({ row, message: `GSTIN ${gstin} is not valid` }); return; }
    let state = stateCode(p("state", "state code", "place of supply"));
    if (p("state", "state code") && !state && india) { out.errors.push({ row, message: `Unknown state "${p("state", "state code")}"` }); return; }
    if (!state && gstin) state = gstin.slice(0, 2);
    const email = p("email", "email id", "e-mail");
    if (email && !z.string().email().safeParse(email).success) { out.errors.push({ row, message: `Email ${email} is not valid` }); return; }
    const currency = p("currency").toUpperCase() || null;
    if (currency && !isCurrency(currency)) { out.errors.push({ row, message: `Currency ${currency} is not supported` }); return; }
    const terms = p("payment terms", "credit days", "credit period", "terms days");
    const days = terms ? parseInt(terms, 10) : 30;
    if (!Number.isFinite(days) || days < 0 || days > 365) { out.errors.push({ row, message: "Credit days must be 0–365" }); return; }
    let limit: number | null = null;
    const lim = money(p("credit limit"));
    if (lim) { try { limit = minor(lim, currencyExponent(currency ?? company.base_currency), "credit limit"); } catch (e) { out.errors.push({ row, message: (e as Error).message }); return; } }
    if ((gstin && gstins.has(gstin)) || names.has(`${kind}|${name.toLowerCase()}`)) { out.skipped.push({ row, reason: `${name} already exists` }); return; }
    gstins.add(gstin); names.add(`${kind}|${name.toLowerCase()}`);
    stmts.push(stmt(c.env.DB,
      `INSERT INTO contacts (id, company_id, kind, name, email, phone, tax_id, pan, state_code, country, billing_address, shipping_address, currency, payment_terms_days, credit_limit, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      newId(), company.id, kind, name.slice(0, 200), email || null, p("phone", "mobile", "mobile no", "contact no").slice(0, 40) || null, gstin || null,
      p("pan", "pan no").toUpperCase().slice(0, 12) || null, state, company.country,
      p("address", "billing address", "address 1").slice(0, 600) || null, p("shipping address", "delivery address").slice(0, 600) || null,
      currency, days, limit, p("notes", "remarks").slice(0, 2000) || null));
    out.created++;
  });
  if (!input.dry_run && !out.errors.length && stmts.length) {
    await batch(c.env.DB, [...stmts, audit(c, "contact.import", "contact", null, { created: out.created, skipped: out.skipped.length })]);
  }
  if (out.errors.length) out.created = 0;
  return respond(c, out, input.dry_run);
});

imports.post("/items", async (c) => {
  requirePerm(c, "items.write");
  const input = await body(c, payload);
  const company = c.get("company");
  const asOf = input.as_of ?? todayIso();
  const exp = currencyExponent(company.base_currency);
  const [existing, taxCodes, warehouses, units, codeMax] = await Promise.all([
    all<{ name: string; sku: string | null; code: string | null; barcode: string | null }>(c.env.DB, `SELECT name, sku, code, barcode FROM items WHERE company_id = ?`, company.id),
    all<{ id: string; name: string; rate_bp: number; category: string; is_active: number }>(c.env.DB, `SELECT id, name, rate_bp, category, is_active FROM tax_codes WHERE company_id = ?`, company.id),
    all<{ id: string; code: string; name: string }>(c.env.DB, `SELECT id, code, name FROM warehouses WHERE company_id = ? AND is_active = 1`, company.id),
    all<{ code: string; name: string }>(c.env.DB, `SELECT code, name FROM units WHERE company_id = ?`, company.id),
    all<{ n: number | null }>(c.env.DB, `SELECT MAX(CAST(SUBSTR(code, 2) AS INTEGER)) AS n FROM items WHERE company_id = ? AND code GLOB 'P[0-9]*'`, company.id),
  ]);
  const taken = { name: new Set(existing.map((e) => e.name.toLowerCase())), sku: new Set(existing.map((e) => e.sku?.toLowerCase()).filter(Boolean)), code: new Set(existing.map((e) => e.code).filter(Boolean)), barcode: new Set(existing.map((e) => e.barcode).filter(Boolean)) };
  let nextCode = (codeMax[0]?.n ?? 0) + 1;
  const out: Outcome = { created: 0, skipped: [], errors: [] };
  const stmts: D1PreparedStatement[] = [];
  const opening: { item_id: string; warehouse_id: string; qty_milli: number; value: number; batch_no: string | null; expiry_date: string | null }[] = [];
  const canStock = hasPerm(c, "inventory.adjust");
  const newUnits: string[] = [];
  input.rows.forEach((raw, i) => {
    const row = i + 1;
    const p = picker(raw);
    const fail = (message: string) => out.errors.push({ row, message });
    const name = p("name", "item name", "product name", "stock item", "description");
    if (!name) return fail("Name is missing");
    const sku = p("sku", "item code", "part no");
    const code = p("code", "product code").toUpperCase();
    const barcode = p("barcode", "ean", "upc");
    if (code && !/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(code)) return fail(`Product code ${code} has unsupported characters`);
    if (taken.name.has(name.toLowerCase()) || (sku && taken.sku.has(sku.toLowerCase()))) { out.skipped.push({ row, reason: `${name} already exists` }); return; }
    if (code && taken.code.has(code)) return fail(`Product code ${code} is already used`);
    if (barcode && taken.barcode.has(barcode)) return fail(`Barcode ${barcode} is already used`);
    const kindRaw = p("type", "kind", "goods/service").toLowerCase();
    const kind = /serv/.test(kindRaw) ? "service" : "goods";
    const hsn = p("hsn", "hsn/sac", "hsn code", "sac", "hsn_sac").replace(/\s/g, "");
    if (hsn && !/^[0-9]{4,8}$/.test(hsn)) return fail(`HSN/SAC ${hsn} must be 4–8 digits`);
    // Tax: a rate ("18", "18%", "GST 18%") or "exempt"/"nil"; matched to this company's tax codes.
    const taxRaw = p("gst", "gst rate", "tax", "tax rate", "gst %", "igst rate");
    let taxId: string | null = null;
    if (taxRaw) {
      const t = taxRaw.toLowerCase();
      const hit = /exempt/.test(t) ? taxCodes.find((x) => x.category === "exempt")
        : /nil/.test(t) ? taxCodes.find((x) => x.category === "nil")
        : (() => { const n = parseFloat(t.replace(/[^0-9.]/g, "")); return Number.isFinite(n) ? taxCodes.filter((x) => x.category === "standard" && x.rate_bp === Math.round(n * 100)).sort((a, b) => b.is_active - a.is_active)[0] ?? (n === 0 ? taxCodes.find((x) => x.category === "nil") : undefined) : undefined; })();
      if (!hit) return fail(`No tax code matches "${taxRaw}"`);
      taxId = hit.id;
    }
    // Units are matched by code or name; a new unit (e.g. "bag") is added to the company's units.
    const unitRaw = p("unit", "uom", "units").toLowerCase().replace(/\.$/, "");
    if (unitRaw && !/^[a-z0-9 ._-]{1,20}$/.test(unitRaw)) return fail(`Unit "${unitRaw}" is too long or has unsupported characters`);
    let unit = unitRaw ? units.find((u) => u.code.toLowerCase() === unitRaw || u.name.toLowerCase() === unitRaw)?.code : "nos";
    if (!unit) { units.push({ code: unitRaw, name: unitRaw }); newUnits.push(unitRaw); unit = unitRaw; }
    let sale: number, purchase: number, reorder: number, openQty: number, openValue: number;
    try {
      sale = minor(money(p("sale price", "selling price", "rate", "mrp", "price")) || "0", exp, "sale price");
      purchase = minor(money(p("purchase price", "cost", "cost price", "purchase rate")) || "0", exp, "purchase price");
      reorder = qty(p("reorder level", "min stock", "reorder") || "0", "reorder level");
      openQty = qty(p("opening stock", "opening qty", "opening quantity", "stock", "qty") || "0", "opening stock");
      const rate = money(p("opening rate", "opening cost", "stock rate"));
      const unitCost = rate ? minor(rate, exp, "opening rate") : purchase;
      openValue = Number((BigInt(unitCost) * BigInt(openQty) + 500n) / 1000n);
    } catch (e) { return fail((e as Error).message); }
    const batchNo = p("batch", "batch no", "batch number", "lot", "lot no").toUpperCase().slice(0, 40);
    const expiryRaw = p("expiry", "expiry date", "exp date", "best before");
    const expiry = expiryRaw ? isoFromAny(expiryRaw) : null;
    if (expiryRaw && !expiry) return fail(`Expiry "${expiryRaw}" is not a date (use YYYY-MM-DD, DD-MM-YYYY or MM/YYYY)`);
    const batches = kind === "goods" && (yes(p("track batches", "batch tracking", "batch wise")) || Boolean(batchNo));
    const track = kind === "goods" && (yes(p("track stock", "track inventory", "maintain stock", "inventory")) || openQty > 0 || batches);
    if (batches && openQty > 0 && !batchNo) return fail("Give the batch number of the opening stock");
    if (openQty < 0) return fail("Opening stock cannot be negative");
    if (openQty > 0 && !canStock) return fail("You may not enter opening stock");
    if (openQty > 0 && openValue <= 0) return fail("Give an opening rate or purchase price for the opening stock");
    let wh: string | null = null;
    if (openQty > 0) {
      const w = p("warehouse", "godown", "location");
      if (w) { wh = warehouses.find((x) => x.code.toLowerCase() === w.toLowerCase() || x.name.toLowerCase() === w.toLowerCase())?.id ?? null; if (!wh) return fail(`Warehouse "${w}" not found`); }
    }
    const id = newId();
    const itemCode = code || `P${String(nextCode++).padStart(6, "0")}`;
    taken.name.add(name.toLowerCase()); if (sku) taken.sku.add(sku.toLowerCase()); taken.code.add(itemCode); if (barcode) taken.barcode.add(barcode);
    stmts.push(stmt(c.env.DB,
      `INSERT INTO items (id, company_id, kind, name, sku, unit, hsn_sac, description, sale_price, purchase_price, tax_code_id, track_inventory, reorder_level_milli, code, barcode, track_batches)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, company.id, kind, name.slice(0, 200), sku || null, unit, hsn || null, p("details", "long description").slice(0, 1000) || null,
      sale, purchase, taxId, track ? 1 : 0, reorder, itemCode, barcode || null, batches ? 1 : 0));
    if (openQty > 0) opening.push({ item_id: id, warehouse_id: wh ?? "", qty_milli: openQty, value: openValue, batch_no: batches ? batchNo : null, expiry_date: batches ? expiry : null });
    out.created++;
  });
  if (!input.dry_run && !out.errors.length && stmts.length) {
    stmts.unshift(...newUnits.map((u) => stmt(c.env.DB, `INSERT INTO units (id, company_id, code, name) VALUES (?,?,?,?)`, newId(), company.id, u, u)));
    if (opening.length) {
      await assertOpenPeriod(c.env.DB, company.id, asOf);
      const fallback = opening.some((o) => !o.warehouse_id) ? await defaultWarehouse(c.env.DB, company.id) : "";
      const total = opening.reduce((t, o) => t + o.value, 0);
      const acc = await systemAccounts(c.env.DB, company.id, ["INVENTORY", "OPENING_EQUITY"]);
      const built = buildJournal(c.env.DB, {
        company_id: company.id, entry_date: asOf, kind: "system", memo: `Opening stock imported (${opening.length} items)`,
        source_type: "stock_import", source_id: newId(), created_by: c.get("user").id, post: true,
        lines: [{ account_id: acc.INVENTORY, debit: total }, { account_id: acc.OPENING_EQUITY, credit: total }],
      });
      stmts.push(...built.stmts);
      for (const o of opening) {
        stmts.push(stockMoveStmt(c.env.DB, { company_id: company.id, item_id: o.item_id, warehouse_id: o.warehouse_id || fallback, move_date: asOf, qty_milli: o.qty_milli, value: o.value, kind: "opening", journal_entry_id: built.id, memo: "Imported opening stock", created_by: c.get("user").id, batch_no: o.batch_no, expiry_date: o.expiry_date }));
      }
    }
    await batch(c.env.DB, [...stmts, audit(c, "item.import", "item", null, { created: out.created, skipped: out.skipped.length, opening_items: opening.length })]);
  }
  if (out.errors.length) out.created = 0;
  return c.json({ dry_run: input.dry_run, ok: out.errors.length === 0, ...out, new_units: out.errors.length ? [] : newUnits });
});

export default imports;
