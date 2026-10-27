import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { all, batch, first, stmt } from "../lib/db";
import { badRequest, conflict, notFound } from "../lib/errors";
import { body, minor, percentBp, qty, reqText } from "../lib/validate";
import { newId } from "../lib/crypto";
import { audit, requirePerm } from "../lib/auth";
import { currencyExponent } from "@shared/currencies";
import type { PriceBreak, PriceList } from "@shared/pricing";

/** Price lists: wholesale/dealer/retail rates per customer, with quantity breaks. */
const priceLists = new Hono<AppEnv>();

const MAX_ROWS = 500;

/** "-10" → -1000 bp, "5%" → 500 bp. */
const signedBp = (v: string | number | null | undefined) => {
  const s = String(v ?? "").trim().replace(/%$/, "");
  if (!s) return 0;
  const neg = s.startsWith("-");
  const bp = percentBp(neg ? s.slice(1) : s.replace(/^\+/, ""), "Adjustment");
  return neg ? -bp : bp;
};

priceLists.get("/", async (c) => {
  requirePerm(c, "inventory.view");
  const lists = await all(c.env.DB,
    `SELECT p.id, p.name, p.adjust_bp, p.is_active,
       (SELECT COUNT(*) FROM price_list_prices x WHERE x.price_list_id = p.id) AS prices,
       (SELECT COUNT(*) FROM contacts ct WHERE ct.price_list_id = p.id) AS customers
     FROM price_lists p WHERE p.company_id = ? ORDER BY p.name`, c.get("company").id);
  return c.json({ price_lists: lists });
});

const head = z.object({ name: reqText(80), adjust_percent: z.union([z.string(), z.number()]).nullish(), is_active: z.boolean().optional() });

priceLists.post("/", async (c) => {
  requirePerm(c, "items.write");
  const input = await body(c, head);
  const company = c.get("company");
  if (await first(c.env.DB, `SELECT 1 FROM price_lists WHERE company_id = ? AND name = ?`, company.id, input.name)) throw conflict("DUPLICATE", "A price list with this name exists");
  const id = newId();
  const adj = signedBp(input.adjust_percent);
  if (adj < -10_000) throw badRequest("A discount cannot exceed 100%");
  await batch(c.env.DB, [
    stmt(c.env.DB, `INSERT INTO price_lists (id, company_id, name, adjust_bp) VALUES (?,?,?,?)`, id, company.id, input.name, adj),
    audit(c, "price_list.create", "price_list", id, { name: input.name, adjust_bp: adj }),
  ]);
  return c.json({ id }, 201);
});

priceLists.put("/:id", async (c) => {
  requirePerm(c, "items.write");
  const input = await body(c, head);
  const company = c.get("company");
  const id = c.req.param("id");
  if (!(await first(c.env.DB, `SELECT 1 FROM price_lists WHERE id = ? AND company_id = ?`, id, company.id))) throw notFound("Price list");
  if (await first(c.env.DB, `SELECT 1 FROM price_lists WHERE company_id = ? AND name = ? AND id <> ?`, company.id, input.name, id)) throw conflict("DUPLICATE", "A price list with this name exists");
  const adj = signedBp(input.adjust_percent);
  if (adj < -10_000) throw badRequest("A discount cannot exceed 100%");
  await batch(c.env.DB, [
    stmt(c.env.DB, `UPDATE price_lists SET name = ?, adjust_bp = ?, is_active = ? WHERE id = ? AND company_id = ?`, input.name, adj, input.is_active === false ? 0 : 1, id, company.id),
    audit(c, "price_list.update", "price_list", id, { name: input.name, adjust_bp: adj, is_active: input.is_active !== false }),
  ]);
  return c.json({ ok: true });
});

priceLists.delete("/:id", async (c) => {
  requirePerm(c, "items.write");
  const company = c.get("company");
  const id = c.req.param("id");
  const used = await first<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM contacts WHERE price_list_id = ? AND company_id = ?`, id, company.id);
  if (used?.n) throw conflict("IN_USE", `${used.n} customer(s) use this price list; move them to another list or switch it off instead`);
  await batch(c.env.DB, [
    stmt(c.env.DB, `DELETE FROM price_lists WHERE id = ? AND company_id = ?`, id, company.id),
    audit(c, "price_list.delete", "price_list", id, {}),
  ]);
  return c.json({ ok: true });
});

priceLists.get("/:id/prices", async (c) => {
  requirePerm(c, "inventory.view");
  const company = c.get("company");
  const list = await first(c.env.DB, `SELECT id, name, adjust_bp, is_active FROM price_lists WHERE id = ? AND company_id = ?`, c.req.param("id"), company.id);
  if (!list) throw notFound("Price list");
  const rows = await all(c.env.DB,
    `SELECT x.item_id, i.name, i.code, i.unit, i.sale_price, x.min_qty_milli, x.price FROM price_list_prices x JOIN items i ON i.id = x.item_id
     WHERE x.price_list_id = ? AND x.company_id = ? ORDER BY i.name, x.min_qty_milli`, c.req.param("id"), company.id);
  return c.json({ price_list: list, prices: rows });
});

/** Replace the list's prices (the form sends the whole table). */
priceLists.put("/:id/prices", async (c) => {
  requirePerm(c, "items.write");
  const company = c.get("company");
  const id = c.req.param("id");
  const input = await body(c, z.object({ rows: z.array(z.object({ item_id: z.string(), min_qty: z.union([z.string(), z.number()]).nullish(), price: z.union([z.string(), z.number()]) })).max(MAX_ROWS) }));
  if (!(await first(c.env.DB, `SELECT 1 FROM price_lists WHERE id = ? AND company_id = ?`, id, company.id))) throw notFound("Price list");
  const exp = currencyExponent(company.base_currency);
  const ids = [...new Set(input.rows.map((r) => r.item_id))];
  const known = new Set((ids.length ? await all<{ id: string }>(c.env.DB, `SELECT id FROM items WHERE company_id = ? AND id IN (${ids.map(() => "?").join(",")})`, company.id, ...ids) : []).map((r) => r.id));
  const seen = new Set<string>();
  const rows = input.rows.map((r, n) => {
    if (!known.has(r.item_id)) throw badRequest(`Row ${n + 1}: product not found`);
    const minQty = qty(r.min_qty || "0", `Row ${n + 1} minimum quantity`);
    if (minQty < 0) throw badRequest(`Row ${n + 1}: minimum quantity cannot be negative`);
    const price = minor(r.price, exp, `Row ${n + 1} price`);
    if (price < 0) throw badRequest(`Row ${n + 1}: price cannot be negative`);
    const key = `${r.item_id}|${minQty}`;
    if (seen.has(key)) throw badRequest(`Row ${n + 1}: the same product and minimum quantity appear twice`);
    seen.add(key);
    return { item_id: r.item_id, min_qty_milli: minQty, price };
  });
  await batch(c.env.DB, [
    stmt(c.env.DB, `DELETE FROM price_list_prices WHERE price_list_id = ? AND company_id = ?`, id, company.id),
    ...rows.map((r) => stmt(c.env.DB, `INSERT INTO price_list_prices (id, company_id, price_list_id, item_id, min_qty_milli, price) VALUES (?,?,?,?,?,?)`, newId(), company.id, id, r.item_id, r.min_qty_milli, r.price)),
    audit(c, "price_list.prices", "price_list", id, { rows: rows.length }),
  ]);
  return c.json({ ok: true, rows: rows.length });
});

/** The active list of a customer with its prices, for the invoice form and the POS. */
export async function contactPricing(db: D1Database, companyId: string, contactId: string | null | undefined): Promise<{ list: PriceList | null; breaks: PriceBreak[] }> {
  if (!contactId) return { list: null, breaks: [] };
  const list = await first<PriceList>(db,
    `SELECT p.id, p.name, p.adjust_bp FROM contacts ct JOIN price_lists p ON p.id = ct.price_list_id AND p.company_id = ct.company_id
     WHERE ct.id = ? AND ct.company_id = ? AND p.is_active = 1`, contactId, companyId);
  if (!list) return { list: null, breaks: [] };
  const breaks = await all<PriceBreak>(db, `SELECT item_id, min_qty_milli, price FROM price_list_prices WHERE price_list_id = ? AND company_id = ?`, list.id, companyId);
  return { list, breaks };
}

priceLists.get("/for-contact/:contactId", async (c) => {
  requirePerm(c, "sales.view");
  return c.json(await contactPricing(c.env.DB, c.get("company").id, c.req.param("contactId")));
});

export default priceLists;
