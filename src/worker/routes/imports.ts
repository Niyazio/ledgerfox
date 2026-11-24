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
import { isValidSubtype, type AccountType } from "@shared/coa";

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
  /** Products only: rows whose name or SKU already exists update that product's prices, tax, HSN, unit and description. */
  update_existing: z.boolean().default(false),
});

/** Normalised header → canonical field. */
const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");
function picker(row: Record<string, unknown>) {
  const m = new Map(Object.entries(row).map(([k, v]) => [norm(k), v == null ? "" : String(v).trim()]));
  // Combined columns such as "Service / SKU" = "SEO Basic / MNCG-DM-005" are split into "Service" and "SKU".
  for (const [k, v] of Object.entries(row)) {
    const heads = k.split("/").map((h) => h.trim()).filter(Boolean);
    const vals = String(v ?? "").split(" / ").map((x) => x.trim());
    if (heads.length > 1 && vals.length === heads.length) heads.forEach((h, i) => { if (!m.get(norm(h))) m.set(norm(h), vals[i]); });
  }
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
const money = (v: string) => v.replace(/[₹,\s]/g, "").replace(/^(rs|inr)\.?/i, "");
/** "₹8,000/month", "Rs 1,000 per hour", "5,000 onwards" → the amount, and the unit when one is given. */
export function priceAndUnit(v: string): { amount: string; unit: string } {
  const m = /^([0-9]+(?:\.[0-9]+)?)(?:\/([a-z]{1,20}))?/i.exec(money(v.replace(/\bper\b/i, "/")));
  return m ? { amount: m[1], unit: (m[2] ?? "").trim().toLowerCase() } : { amount: money(v), unit: "" };
}

interface RowError { row: number; message: string }
interface Outcome { created: number; updated?: number; skipped: { row: number; reason: string }[]; errors: RowError[] }

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
  const [existing, taxCodes, warehouses, units, codeMax, ledgers] = await Promise.all([
    all<{ id: string; name: string; sku: string | null; code: string | null; barcode: string | null }>(c.env.DB, `SELECT id, name, sku, code, barcode FROM items WHERE company_id = ?`, company.id),
    all<{ id: string; name: string; rate_bp: number; category: string; is_active: number }>(c.env.DB, `SELECT id, name, rate_bp, category, is_active FROM tax_codes WHERE company_id = ?`, company.id),
    all<{ id: string; code: string; name: string }>(c.env.DB, `SELECT id, code, name FROM warehouses WHERE company_id = ? AND is_active = 1`, company.id),
    all<{ code: string; name: string }>(c.env.DB, `SELECT code, name FROM units WHERE company_id = ?`, company.id),
    all<{ n: number | null }>(c.env.DB, `SELECT MAX(CAST(SUBSTR(code, 2) AS INTEGER)) AS n FROM items WHERE company_id = ? AND code GLOB 'P[0-9]*'`, company.id),
    all<{ id: string; code: string; name: string; type: string }>(c.env.DB, `SELECT id, code, name, type FROM accounts WHERE company_id = ? AND is_group = 0 AND is_active = 1`, company.id),
  ]);
  /** An account given by code ("4210"), name, or both ("4210 Website Income" / "4210 - Website Income"). */
  const ledger = (raw: string, types: string[]) => {
    const v = raw.trim().toLowerCase();
    const pool = ledgers.filter((a) => types.includes(a.type));
    const lead = v.split(/[\s:–]+/)[0];
    return pool.find((a) => a.code.toLowerCase() === v || a.name.toLowerCase() === v) ?? pool.find((a) => a.code.toLowerCase() === lead);
  };

  const taken = { name: new Set(existing.map((e) => e.name.toLowerCase())), sku: new Set(existing.map((e) => e.sku?.toLowerCase()).filter(Boolean)), code: new Set(existing.map((e) => e.code).filter(Boolean)), barcode: new Set(existing.map((e) => e.barcode).filter(Boolean)) };
  let nextCode = (codeMax[0]?.n ?? 0) + 1;
  const out: Outcome = { created: 0, updated: 0, skipped: [], errors: [] };
  const stmts: D1PreparedStatement[] = [];
  const updatedIds = new Set<string>();
  const opening: { item_id: string; warehouse_id: string; qty_milli: number; value: number; batch_no: string | null; expiry_date: string | null }[] = [];
  const canStock = hasPerm(c, "inventory.adjust");
  const newUnits: string[] = [];
  input.rows.forEach((raw, i) => {
    const row = i + 1;
    const p = picker(raw);
    const fail = (message: string) => out.errors.push({ row, message });
    const name = p("name", "item name", "product name", "service name", "service", "product", "stock item", "particulars", "description");
    if (!name) return fail("Name is missing");
    // "Description" is the name only when the sheet has no name column; otherwise it is the product's description.
    const details = (name === p("description") ? p("details", "long description", "remarks") : p("details", "long description", "description", "remarks")).slice(0, 1000);
    const sku = p("sku", "item code", "part no");
    const code = p("code", "product code").toUpperCase();
    const barcode = p("barcode", "ean", "upc");
    if (code && !/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(code)) return fail(`Product code ${code} has unsupported characters`);
    const exists = taken.name.has(name.toLowerCase()) || (sku && taken.sku.has(sku.toLowerCase()));
    if (exists && !input.update_existing) { out.skipped.push({ row, reason: `${name} already exists` }); return; }
    if (!exists && code && taken.code.has(code)) return fail(`Product code ${code} is already used`);
    if (!exists && barcode && taken.barcode.has(barcode)) return fail(`Barcode ${barcode} is already used`);
    const kindRaw = p("type", "kind", "goods/service").toLowerCase();
    // No Type column: a "Service" column, or a rate per month / hour / visit, means a service.
    const kind = kindRaw ? (/serv/.test(kindRaw) ? "service" : "goods")
      : Object.keys(raw).some((k) => /\bservices?\b/i.test(k)) || /^(month|year|day|week|hour|hr|session|visit|page|campaign|project)s?$/.test(priceAndUnit(p("sale price", "selling price", "rate", "suggested rate", "mrp", "price", "amount")).unit) ? "service" : "goods";
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
    // Income (sales) and expense (purchase) accounts, by code or name.
    const incRaw = p("income account", "sales account", "revenue account", "income a/c", "sales ledger", "income ledger");
    const expRaw = p("expense account", "purchase account", "cost account", "expense a/c", "purchase ledger");
    const incAcc = incRaw ? ledger(incRaw, ["income"]) : undefined;
    const expAcc = expRaw ? ledger(expRaw, ["expense", "asset"]) : undefined;
    if (incRaw && !incAcc) return fail(`No income account "${incRaw}" in the chart of accounts`);
    if (expRaw && !expAcc) return fail(`No expense account "${expRaw}" in the chart of accounts`);
    const salePrice = priceAndUnit(p("sale price", "selling price", "rate", "suggested rate", "mrp", "price", "amount"));
    const unitRaw = (p("unit", "uom", "units") || salePrice.unit).toLowerCase().replace(/\.$/, "");
    if (unitRaw && !/^[a-z0-9 ._-]{1,20}$/.test(unitRaw)) return fail(`Unit "${unitRaw}" is too long or has unsupported characters`);
    let unit = unitRaw ? units.find((u) => u.code.toLowerCase() === unitRaw || u.name.toLowerCase() === unitRaw)?.code : "nos";
    if (!unit) { units.push({ code: unitRaw, name: unitRaw }); newUnits.push(unitRaw); unit = unitRaw; }
    let sale: number, purchase: number, reorder: number, openQty: number, openValue: number;
    try {
      sale = minor(salePrice.amount || "0", exp, "sale price");
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
    if (exists) {
      // Update only what the row gives; stock and codes are never changed by an import.
      const hit = existing.find((e) => e.name.toLowerCase() === name.toLowerCase()) ?? existing.find((e) => sku && e.sku?.toLowerCase() === sku.toLowerCase());
      if (!hit || updatedIds.has(hit.id)) { out.skipped.push({ row, reason: `${name} appears twice in the file` }); return; }
      updatedIds.add(hit.id);
      const has = (...n: string[]) => p(...n) !== "";
      stmts.push(stmt(c.env.DB,
        `UPDATE items SET sale_price = CASE WHEN ? THEN ? ELSE sale_price END, purchase_price = CASE WHEN ? THEN ? ELSE purchase_price END,
           tax_code_id = COALESCE(?, tax_code_id), hsn_sac = COALESCE(?, hsn_sac), unit = CASE WHEN ? THEN ? ELSE unit END, description = COALESCE(?, description),
           income_account_id = COALESCE(?, income_account_id), expense_account_id = COALESCE(?, expense_account_id)
         WHERE id = ? AND company_id = ?`,
        salePrice.amount ? 1 : 0, sale, has("purchase price", "cost", "cost price", "purchase rate") ? 1 : 0, purchase,
        taxId, hsn || null, unitRaw ? 1 : 0, unit, details || null, incAcc?.id ?? null, expAcc?.id ?? null, hit.id, company.id));
      if (openQty > 0) out.skipped.push({ row, reason: `${name}: opening stock not added to an existing product (use Adjust stock)` });
      out.updated!++;
      return;
    }
    const id = newId();
    const itemCode = code || `P${String(nextCode++).padStart(6, "0")}`;
    taken.name.add(name.toLowerCase()); if (sku) taken.sku.add(sku.toLowerCase()); taken.code.add(itemCode); if (barcode) taken.barcode.add(barcode);
    stmts.push(stmt(c.env.DB,
      `INSERT INTO items (id, company_id, kind, name, sku, unit, hsn_sac, description, sale_price, purchase_price, tax_code_id, track_inventory, reorder_level_milli, code, barcode, track_batches, income_account_id, expense_account_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, company.id, kind, name.slice(0, 200), sku || null, unit, hsn || null, details || null,
      sale, purchase, taxId, track ? 1 : 0, reorder, itemCode, barcode || null, batches ? 1 : 0, incAcc?.id ?? null, expAcc?.id ?? null));
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
    await batch(c.env.DB, [...stmts, audit(c, "item.import", "item", null, { created: out.created, updated: out.updated, skipped: out.skipped.length, opening_items: opening.length })]);
  }
  if (out.errors.length) { out.created = 0; out.updated = 0; }
  return c.json({ dry_run: input.dry_run, ok: out.errors.length === 0, ...out, new_units: out.errors.length ? [] : newUnits });
});

/** Account types as people write them, to type + subtype. */
export function accountKind(raw: string): { type: AccountType; subtype: string } | null {
  const t = raw.toLowerCase().replace(/&/g, " and ").replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
  const table: [RegExp, AccountType, string][] = [
    [/^(other|indirect|non operating) incomes?$/, "income", "other_income"],
    [/^(income|incomes|revenue|sales|direct income|operating income|service income)$/, "income", "operating_income"],
    [/^(cost of (goods )?sold|cogs|direct expenses?|purchases?|cost of sales)$/, "expense", "cogs"],
    [/^depreciation$/, "expense", "depreciation"],
    [/^(other|non operating) expenses?$/, "expense", "other_expense"],
    [/^(expenses?|indirect expenses?|operating expenses?)$/, "expense", "operating_expense"],
    [/^(fixed assets?|capital assets?|property plant and equipment|ppe|intangible assets?)$/, "asset", "fixed_asset"],
    [/^(bank|bank accounts?)$/, "asset", "bank"],
    [/^(cash|cash in hand)$/, "asset", "cash"],
    [/^(current assets?|assets?|other current assets?|loans and advances|deposits?)$/, "asset", "current_asset"],
    [/^(non current assets?|investments?|long term assets?)$/, "asset", "non_current_asset"],
    [/^(current liabilit(y|ies)|liabilit(y|ies)|other current liabilit(y|ies)|provisions?|duties and taxes)$/, "liability", "current_liability"],
    [/^(long term liabilit(y|ies)|loans?|secured loans?|unsecured loans?)$/, "liability", "long_term_liability"],
    [/^(equity|capital|capital account|owner s equity|reserves?( and surplus)?)$/, "equity", "equity"],
  ];
  const hit = table.find(([re]) => re.test(t));
  return hit ? { type: hit[1], subtype: hit[2] } : null;
}

/** Chart of accounts: new ledger accounts (and groups) from a sheet. Existing codes and names are skipped, never changed. */
imports.post("/accounts", async (c) => {
  requirePerm(c, "accounts.write");
  const input = await body(c, payload);
  const company = c.get("company");
  const existing = await all<{ id: string; code: string; name: string; type: string; subtype: string; is_group: number; parent_id: string | null }>(c.env.DB,
    `SELECT id, code, name, type, subtype, is_group, parent_id FROM accounts WHERE company_id = ?`, company.id);
  const byCode = new Map(existing.map((a) => [a.code.toLowerCase(), a]));
  const names = new Set(existing.map((a) => a.name.toLowerCase()));
  const out: Outcome = { created: 0, skipped: [], errors: [] };
  const stmts: D1PreparedStatement[] = [];
  const made: { code: string; name: string }[] = [];
  input.rows.forEach((raw, i) => {
    const row = i + 1;
    const p = picker(raw);
    const fail = (message: string) => out.errors.push({ row, message });
    const code = p("code", "account code", "ledger code", "a/c code", "gl code");
    const name = p("account name", "name", "ledger name", "ledger", "account");
    if (!name) return fail("Account name is missing");
    if (!code) return fail(`${name}: code is missing`);
    if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,19}$/.test(code)) return fail(`Code "${code}" may only have letters, digits, dots and dashes`);
    if (byCode.has(code.toLowerCase())) { out.skipped.push({ row, reason: `Code ${code} already exists (${byCode.get(code.toLowerCase())!.name})` }); return; }
    if (names.has(name.toLowerCase())) { out.skipped.push({ row, reason: `${name} already exists` }); return; }
    const kind = accountKind(p("type", "account type", "nature", "group type", "category"));
    if (!kind) return fail(`${name}: type "${p("type", "account type")}" is not one of Income, Other income, Expense, Cost of goods sold, Fixed asset, Current asset, Bank, Cash, Liability, Long-term liability, Equity`);
    const sub = p("subtype");
    const subtype = sub && isValidSubtype(kind.type, sub.toLowerCase().replace(/[^a-z]+/g, "_")) ? sub.toLowerCase().replace(/[^a-z]+/g, "_") : kind.subtype;
    const isGroup = /^(y|yes|true|1|group)$/i.test(p("group", "is group"));
    // Parent: the one named (code or name), else the group for this kind (e.g. 1200 Fixed Assets, 6000 Operating Expenses).
    const parentRaw = p("parent", "parent code", "parent account", "under", "group under");
    let parent: { id: string; type: string; is_group: number } | undefined;
    if (parentRaw) {
      const pc = parentRaw.toLowerCase();
      parent = byCode.get(pc) ?? existing.find((a) => a.name.toLowerCase() === pc) ?? byCode.get(/^(\S+)/.exec(pc)![1]);
      if (!parent) return fail(`${name}: parent "${parentRaw}" not found`);
      if (!parent.is_group) return fail(`${name}: parent "${parentRaw}" is not a group`);
      if (parent.type !== kind.type) return fail(`${name}: parent "${parentRaw}" is a different type of account`);
    } else {
      const groups = existing.filter((a) => a.is_group && a.type === kind.type).sort((a, b) => a.code.localeCompare(b.code));
      parent = groups.find((g) => g.subtype === subtype && g.parent_id) ?? groups.find((g) => g.subtype === subtype) ?? groups[0];
    }
    const id = newId();
    stmts.push(stmt(c.env.DB, `INSERT INTO accounts (id, company_id, code, name, type, subtype, parent_id, is_group, description) VALUES (?,?,?,?,?,?,?,?,?)`,
      id, company.id, code, name.slice(0, 120), kind.type, subtype, parent?.id ?? null, isGroup ? 1 : 0, p("description", "notes").slice(0, 500) || null));
    const rec = { id, code, name, type: kind.type, subtype, is_group: isGroup ? 1 : 0, parent_id: parent?.id ?? null };
    existing.push(rec); byCode.set(code.toLowerCase(), rec); names.add(name.toLowerCase());
    made.push({ code, name });
    out.created++;
  });
  if (!input.dry_run && !out.errors.length && stmts.length) await batch(c.env.DB, [...stmts, audit(c, "account.import", "account", null, { created: made })]);
  if (out.errors.length) out.created = 0;
  return respond(c, out, input.dry_run);
});

export default imports;
