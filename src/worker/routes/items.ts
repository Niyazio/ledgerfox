import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { all, batch, first, stmt } from "../lib/db";
import { badRequest, conflict, notFound, unprocessable } from "../lib/errors";
import { body, reqText, shortText, optId, minor, qty, isoDate, pageParams } from "../lib/validate";
import type { Context } from "hono";
import { newId } from "../lib/crypto";
import { assertBranchVisible, audit, branchFilter, hasPerm, requireAnyPerm, requirePerm } from "../lib/auth";
import { currencyExponent } from "@shared/currencies";
import { buildJournal, systemAccounts, assertOpenPeriod } from "../services/ledger";
import { companyPosition, issueCost, stockMoveStmt, warehouseQty } from "../services/inventory";

const items = new Hono<AppEnv>();
items.use("*", async (c, next) => { if (c.req.method === "GET") requireAnyPerm(c, "inventory.view", "sales.create", "purchase.create"); await next(); });

const itemSchema = z.object({
  kind: z.enum(["goods", "service"]),
  name: reqText(200),
  sku: shortText(60).nullish(),
  unit: z.string().trim().min(1).max(20).default("nos"),
  hsn_sac: z.string().trim().regex(/^[0-9]{4,8}$/, "HSN/SAC must be 4–8 digits").nullish().or(z.literal("")),
  description: shortText(1000).nullish(),
  sale_price: z.union([z.string(), z.number()]).default("0"),
  purchase_price: z.union([z.string(), z.number()]).optional(),
  tax_code_id: optId,
  income_account_id: optId,
  expense_account_id: optId,
  track_inventory: z.boolean().default(false),
  reorder_level: z.union([z.string(), z.number()]).default("0"),
  is_active: z.boolean().optional(),
  // Internal product code (encoded in the product QR) and the manufacturer's barcode (EAN/UPC/Code 128).
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9._-]{0,31}$/, "Code: up to 32 letters, digits, dot, dash or underscore").nullish().or(z.literal("")),
  barcode: z.string().trim().regex(/^[A-Za-z0-9._\-/+ ]{4,48}$/, "Barcode: 4–48 letters or digits").nullish().or(z.literal("")),
});

/** Next free code of the form P000123 for this company. */
async function nextCode(db: D1Database, companyId: string) {
  const r = await first<{ n: number | null }>(db, `SELECT MAX(CAST(SUBSTR(code, 2) AS INTEGER)) AS n FROM items WHERE company_id = ? AND code GLOB 'P[0-9]*'`, companyId);
  return `P${String((r?.n ?? 0) + 1).padStart(6, "0")}`;
}

async function checkUnique(db: D1Database, companyId: string, id: string | null, code: string | null, barcode: string | null) {
  if (code && (await first(db, `SELECT 1 FROM items WHERE company_id = ? AND code = ? AND id IS NOT ?`, companyId, code, id))) throw conflict("CODE_TAKEN", `Product code ${code} is already used`);
  if (barcode && (await first(db, `SELECT 1 FROM items WHERE company_id = ? AND barcode = ? AND id IS NOT ?`, companyId, barcode, id))) throw conflict("BARCODE_TAKEN", `Barcode ${barcode} is already used by another product`);
}

/** Members without cost access (e.g. billing staff) do not receive purchase prices or stock values. */
function hideCost<T extends Record<string, unknown>>(c: Context<AppEnv>, row: T): T {
  if (hasPerm(c, "items.cost") || hasPerm(c, "purchase.view") || hasPerm(c, "reports.read")) return row;
  const { purchase_price: _p, stock_value: _v, value: _x, ...rest } = row;
  return rest as T;
}

async function checkRefs(db: D1Database, companyId: string, input: z.infer<typeof itemSchema>) {
  for (const [field, table] of [["tax_code_id", "tax_codes"], ["income_account_id", "accounts"], ["expense_account_id", "accounts"]] as const) {
    const v = input[field];
    if (v && !(await first(db, `SELECT 1 FROM ${table} WHERE id = ? AND company_id = ?`, v, companyId))) throw badRequest(`${field} not found in this company`);
  }
  if (input.track_inventory && input.kind !== "goods") throw badRequest("Only goods can track inventory");
}

items.get("/", async (c) => {
  const company = c.get("company");
  const { limit, offset } = pageParams(c);
  const q = c.req.query("q");
  const where = ["i.company_id = ?"];
  const params: (string | number)[] = [company.id];
  if (q) { where.push("(i.name LIKE ? OR i.sku LIKE ? OR i.hsn_sac LIKE ? OR i.code = ? OR i.barcode = ?)"); params.push(`%${q}%`, `%${q}%`, `%${q}%`, q.toUpperCase(), q); }
  if (c.req.query("active") === "1") where.push("i.is_active = 1");
  const rows = await all(c.env.DB,
    `SELECT i.*, t.name AS tax_code_name, t.rate_bp,
       (SELECT COALESCE(SUM(qty_milli),0) FROM stock_moves s WHERE s.item_id = i.id) AS stock_qty_milli,
       (SELECT COALESCE(SUM(value),0) FROM stock_moves s WHERE s.item_id = i.id) AS stock_value
     FROM items i LEFT JOIN tax_codes t ON t.id = i.tax_code_id
     WHERE ${where.join(" AND ")} ORDER BY i.name LIMIT ? OFFSET ?`, ...params, limit, offset);
  const total = await first<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM items i WHERE ${where.join(" AND ")}`, ...params);
  return c.json({ items: rows.map((r) => hideCost(c, r as Record<string, unknown>)), total: total?.n ?? 0 });
});

/**
 * Scanner lookup: a product QR (LF1|P|<code>), a printed barcode, a product code or an SKU, matched exactly.
 * Only the product's identity and selling details are returned; QR codes never contain prices or costs.
 */
items.get("/lookup", async (c) => {
  const company = c.get("company");
  let v = (c.req.query("code") ?? "").trim();
  if (!v) throw badRequest("Scan or type a code");
  const qr = /^LF1\|P\|([A-Z0-9._-]{1,32})$/i.exec(v);
  if (qr) v = qr[1];
  const item = await first<Record<string, unknown>>(c.env.DB,
    `SELECT i.*, t.name AS tax_code_name, t.rate_bp FROM items i LEFT JOIN tax_codes t ON t.id = i.tax_code_id
     WHERE i.company_id = ? AND (i.code = ? OR i.barcode = ? OR i.sku = ?) ORDER BY i.code = ? DESC, i.barcode = ? DESC LIMIT 1`,
    company.id, v.toUpperCase(), v, v, v.toUpperCase(), v);
  if (!item) throw notFound("Product with this code");
  if (!item.is_active) throw unprocessable("ITEM_INACTIVE", `${item.name} is inactive`);
  return c.json({ item: hideCost(c, item) });
});

items.get("/stock", async (c) => {
  const company = c.get("company");
  const bf = branchFilter(c, "w.branch_id");
  const rows = await all(c.env.DB,
    `SELECT i.id AS item_id, i.name, i.sku, i.code, i.unit, i.reorder_level_milli, w.id AS warehouse_id, w.name AS warehouse_name, w.branch_id,
            SUM(s.qty_milli) AS qty_milli, SUM(s.value) AS value
     FROM stock_moves s JOIN items i ON i.id = s.item_id JOIN warehouses w ON w.id = s.warehouse_id
     WHERE s.company_id = ?${bf.sql} GROUP BY i.id, w.id ORDER BY i.name, w.name`, company.id, ...bf.params);
  return c.json({ stock: rows.map((r) => hideCost(c, r as Record<string, unknown>)) });
});

items.get("/movements", async (c) => {
  const company = c.get("company");
  const { limit, offset } = pageParams(c);
  const itemId = c.req.query("item_id");
  const bf = branchFilter(c, "w.branch_id");
  const rows = await all(c.env.DB,
    `SELECT s.*, i.name AS item_name, w.name AS warehouse_name, u.name AS created_by_name FROM stock_moves s
     JOIN items i ON i.id = s.item_id JOIN warehouses w ON w.id = s.warehouse_id LEFT JOIN users u ON u.id = s.created_by
     WHERE s.company_id = ? ${itemId ? "AND s.item_id = ?" : ""}${bf.sql} ORDER BY s.move_date DESC, s.created_at DESC LIMIT ? OFFSET ?`,
    ...(itemId ? [company.id, itemId] : [company.id]), ...bf.params, limit, offset);
  return c.json({ movements: rows.map((r) => hideCost(c, r as Record<string, unknown>)) });
});

items.get("/:id", async (c) => {
  const company = c.get("company");
  const item = await first(c.env.DB, `SELECT * FROM items WHERE id = ? AND company_id = ?`, c.req.param("id"), company.id);
  if (!item) throw notFound("Item");
  const pos = await companyPosition(c.env.DB, company.id, c.req.param("id"));
  const cost = hasPerm(c, "items.cost") || hasPerm(c, "purchase.view") || hasPerm(c, "reports.read");
  return c.json({ item: hideCost(c, item as Record<string, unknown>), position: cost ? pos : { qty_milli: pos.qty_milli } });
});

items.post("/", async (c) => {
  requirePerm(c, "items.write");
  const input = await body(c, itemSchema);
  const company = c.get("company");
  await checkRefs(c.env.DB, company.id, input);
  const exp = currencyExponent(company.base_currency);
  const id = newId();
  const code = input.code || (await nextCode(c.env.DB, company.id));
  await checkUnique(c.env.DB, company.id, null, code, input.barcode || null);
  await batch(c.env.DB, [
    stmt(c.env.DB,
      `INSERT INTO items (id, company_id, kind, name, sku, unit, hsn_sac, description, sale_price, purchase_price, tax_code_id,
         income_account_id, expense_account_id, track_inventory, reorder_level_milli, code, barcode) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, company.id, input.kind, input.name, input.sku || null, input.unit, input.hsn_sac || null, input.description ?? null,
      minor(input.sale_price, exp, "sale price"), minor(input.purchase_price ?? "0", exp, "purchase price"), input.tax_code_id ?? null,
      input.income_account_id ?? null, input.expense_account_id ?? null, input.track_inventory ? 1 : 0, qty(input.reorder_level, "reorder level"),
      code, input.barcode || null),
    audit(c, "item.create", "item", id, { name: input.name, code }),
  ]);
  return c.json({ id, code }, 201);
});

items.put("/:id", async (c) => {
  requirePerm(c, "items.write");
  const input = await body(c, itemSchema);
  const company = c.get("company");
  const id = c.req.param("id");
  const existing = await first<{ track_inventory: number; kind: string; purchase_price: number; code: string | null; barcode: string | null; name: string; sale_price: number }>(
    c.env.DB, `SELECT track_inventory, kind, purchase_price, code, barcode, name, sale_price FROM items WHERE id = ? AND company_id = ?`, id, company.id);
  if (!existing) throw notFound("Item");
  if (Boolean(existing.track_inventory) !== input.track_inventory || existing.kind !== input.kind) {
    const moved = await first(c.env.DB, `SELECT 1 FROM stock_moves WHERE item_id = ? UNION ALL SELECT 1 FROM document_lines WHERE item_id = ? LIMIT 1`, id, id);
    if (moved) throw conflict("ITEM_IN_USE", "Inventory tracking and item kind cannot change after the item has been used");
  }
  await checkRefs(c.env.DB, company.id, input);
  const exp = currencyExponent(company.base_currency);
  // Without cost access the purchase price is kept as it is (it was not sent to this member in the first place).
  const canCost = hasPerm(c, "items.cost");
  const purchasePrice = canCost && input.purchase_price !== undefined ? minor(input.purchase_price, exp, "purchase price") : existing.purchase_price;
  const code = input.code || existing.code || (await nextCode(c.env.DB, company.id));
  const barcode = input.barcode === undefined ? existing.barcode : input.barcode || null;
  await checkUnique(c.env.DB, company.id, id, code, barcode);
  const salePrice = minor(input.sale_price, exp, "sale price");
  await batch(c.env.DB, [
    stmt(c.env.DB,
      `UPDATE items SET kind = ?, name = ?, sku = ?, unit = ?, hsn_sac = ?, description = ?, sale_price = ?, purchase_price = ?, tax_code_id = ?,
         income_account_id = ?, expense_account_id = ?, track_inventory = ?, reorder_level_milli = ?, is_active = ?, code = ?, barcode = ? WHERE id = ? AND company_id = ?`,
      input.kind, input.name, input.sku || null, input.unit, input.hsn_sac || null, input.description ?? null,
      salePrice, purchasePrice, input.tax_code_id ?? null,
      input.income_account_id ?? null, input.expense_account_id ?? null, input.track_inventory ? 1 : 0, qty(input.reorder_level, "reorder level"),
      input.is_active === false ? 0 : 1, code, barcode, id, company.id),
    audit(c, "item.update", "item", id, {
      name: input.name,
      changes: Object.fromEntries(Object.entries({ name: [existing.name, input.name], sale_price: [existing.sale_price, salePrice], purchase_price: [existing.purchase_price, purchasePrice], code: [existing.code, code], barcode: [existing.barcode, barcode] })
        .filter(([, [a, b]]) => a !== b).map(([k, [a, b]]) => [k, { from: a, to: b }])),
    }),
  ]);
  return c.json({ ok: true });
});

// ── Warehouses ──
items.post("/warehouses", async (c) => {
  requirePerm(c, "branches.manage");
  const input = await body(c, z.object({ name: reqText(120), code: reqText(20), branch_id: optId }));
  const company = c.get("company");
  if (input.branch_id && !(await first(c.env.DB, `SELECT 1 FROM branches WHERE id = ? AND company_id = ?`, input.branch_id, company.id))) throw badRequest("Branch not found");
  const id = newId();
  await batch(c.env.DB, [
    stmt(c.env.DB, `INSERT INTO warehouses (id, company_id, name, code, branch_id) VALUES (?,?,?,?,?)`, id, company.id, input.name, input.code, input.branch_id ?? null),
    audit(c, "warehouse.create", "warehouse", id, input),
  ]);
  return c.json({ id }, 201);
});

items.patch("/warehouses/:id", async (c) => {
  requirePerm(c, "branches.manage");
  const input = await body(c, z.object({ name: reqText(120), code: reqText(20), is_active: z.boolean().default(true) }));
  const company = c.get("company");
  await batch(c.env.DB, [
    stmt(c.env.DB, `UPDATE warehouses SET name = ?, code = ?, is_active = ? WHERE id = ? AND company_id = ?`, input.name, input.code, input.is_active ? 1 : 0, c.req.param("id"), company.id),
    audit(c, "warehouse.update", "warehouse", c.req.param("id"), input),
  ]);
  return c.json({ ok: true });
});

async function trackedItem(db: D1Database, companyId: string, itemId: string) {
  const it = await first<{ id: string; name: string; track_inventory: number }>(db, `SELECT id, name, track_inventory FROM items WHERE id = ? AND company_id = ?`, itemId, companyId);
  if (!it) throw notFound("Item");
  if (!it.track_inventory) throw unprocessable("NOT_TRACKED", "This item does not track inventory");
  return it;
}

async function checkWarehouse(c: Context<AppEnv>, id: string, mustSee = true) {
  const w = await first<{ branch_id: string | null }>(c.env.DB, `SELECT branch_id FROM warehouses WHERE id = ? AND company_id = ? AND is_active = 1`, id, c.get("company").id);
  if (!w) throw badRequest("Warehouse not found");
  if (mustSee) assertBranchVisible(c, w.branch_id);
  return w.branch_id;
}

/**
 * Stock adjustment. Increases are valued at the entered unit cost (or current average);
 * decreases at the moving average. The value change is posted Inventory ↔ Inventory Adjustments
 * (or Opening Balance Equity for opening stock) in the same transaction.
 */
items.post("/adjustments", async (c) => {
  requirePerm(c, "inventory.adjust");
  const input = await body(c, z.object({
    item_id: z.string(), warehouse_id: z.string(), date: isoDate,
    quantity: z.union([z.string(), z.number()]), // signed
    unit_cost: z.union([z.string(), z.number()]).nullish(),
    reason: z.enum(["adjustment", "opening"]).default("adjustment"),
    memo: shortText(300).nullish(),
  }));
  const company = c.get("company");
  const user = c.get("user");
  const item = await trackedItem(c.env.DB, company.id, input.item_id);
  await checkWarehouse(c, input.warehouse_id);
  await assertOpenPeriod(c.env.DB, company.id, input.date);
  const q = qty(input.quantity);
  if (q === 0) throw badRequest("Quantity cannot be zero");
  const pos = await companyPosition(c.env.DB, company.id, item.id);
  let value: number;
  if (q > 0) {
    if (input.unit_cost != null && input.unit_cost !== "") {
      const unitCost = minor(input.unit_cost, currencyExponent(company.base_currency), "unit cost");
      value = Number((BigInt(unitCost) * BigInt(q) + 500n) / 1000n);
    } else if (pos.qty_milli > 0) {
      value = Number((BigInt(pos.value) * BigInt(q) + BigInt(pos.qty_milli) / 2n) / BigInt(pos.qty_milli));
    } else throw badRequest("Enter a unit cost for stock with no existing average cost");
  } else {
    const avail = await warehouseQty(c.env.DB, company.id, item.id, input.warehouse_id);
    if (avail < -q) throw unprocessable("INSUFFICIENT_STOCK", `Only ${avail / 1000} available in this warehouse`);
    value = -issueCost(pos, -q);
  }
  const acc = await systemAccounts(c.env.DB, company.id, ["INVENTORY", "INV_ADJ", "OPENING_EQUITY"]);
  const counter = input.reason === "opening" ? acc.OPENING_EQUITY : acc.INV_ADJ;
  const stmts: D1PreparedStatement[] = [];
  let journalId: string | null = null;
  if (value !== 0) {
    const built = buildJournal(c.env.DB, {
      company_id: company.id, entry_date: input.date, kind: "system", memo: input.memo ?? `Stock ${input.reason}: ${item.name}`,
      source_type: "stock_adjustment", source_id: newId(), created_by: user.id, post: true,
      lines: value > 0
        ? [{ account_id: acc.INVENTORY, debit: value }, { account_id: counter, credit: value }]
        : [{ account_id: counter, debit: -value }, { account_id: acc.INVENTORY, credit: -value }],
    });
    journalId = built.id;
    stmts.push(...built.stmts);
  }
  stmts.push(stockMoveStmt(c.env.DB, {
    company_id: company.id, item_id: item.id, warehouse_id: input.warehouse_id, move_date: input.date, qty_milli: q, value,
    kind: input.reason === "opening" ? "opening" : "adjustment", journal_entry_id: journalId, memo: input.memo, created_by: user.id,
  }));
  stmts.push(audit(c, "stock.adjust", "item", item.id, { qty_milli: q, value }));
  await batch(c.env.DB, stmts);
  return c.json({ ok: true, value, journal_id: journalId }, 201);
});

/** Transfer between warehouses at moving-average cost; no ledger impact (same inventory account). */
items.post("/transfers", async (c) => {
  requirePerm(c, "inventory.transfer");
  const input = await body(c, z.object({ item_id: z.string(), from_warehouse_id: z.string(), to_warehouse_id: z.string(), date: isoDate, quantity: z.union([z.string(), z.number()]), memo: shortText(300).nullish() }));
  const company = c.get("company");
  const user = c.get("user");
  if (input.from_warehouse_id === input.to_warehouse_id) throw badRequest("Choose two different warehouses");
  const item = await trackedItem(c.env.DB, company.id, input.item_id);
  // Stock may be sent to any branch, but only from a warehouse the member can use.
  const fromBranch = await checkWarehouse(c, input.from_warehouse_id);
  const toBranch = await checkWarehouse(c, input.to_warehouse_id, false);
  const q = qty(input.quantity);
  if (q <= 0) throw badRequest("Quantity must be positive");
  const avail = await warehouseQty(c.env.DB, company.id, item.id, input.from_warehouse_id);
  if (avail < q) throw unprocessable("INSUFFICIENT_STOCK", `Only ${avail / 1000} available in the source warehouse`);
  await assertOpenPeriod(c.env.DB, company.id, input.date);
  const pos = await companyPosition(c.env.DB, company.id, item.id);
  const value = q >= pos.qty_milli ? pos.value : issueCost(pos, q);
  const ref = newId();
  await batch(c.env.DB, [
    stockMoveStmt(c.env.DB, { company_id: company.id, item_id: item.id, warehouse_id: input.from_warehouse_id, move_date: input.date, qty_milli: -q, value: -value, kind: "transfer", source_type: "transfer", source_id: ref, memo: input.memo, created_by: user.id }),
    stockMoveStmt(c.env.DB, { company_id: company.id, item_id: item.id, warehouse_id: input.to_warehouse_id, move_date: input.date, qty_milli: q, value, kind: "transfer", source_type: "transfer", source_id: ref, memo: input.memo, created_by: user.id }),
    stmt(c.env.DB, `INSERT INTO stock_transfers (id, company_id, item_id, qty_milli, value, from_warehouse_id, to_warehouse_id, from_branch_id, to_branch_id, transfer_date, memo, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, ref, company.id, item.id, q, value, input.from_warehouse_id, input.to_warehouse_id, fromBranch, toBranch, input.date, input.memo ?? null, user.id),
    audit(c, "stock.transfer", "item", item.id, { qty_milli: q, from: input.from_warehouse_id, to: input.to_warehouse_id, from_branch: fromBranch, to_branch: toBranch }),
  ]);
  return c.json({ ok: true, id: ref }, 201);
});

items.get("/transfers/list", async (c) => {
  requireAnyPerm(c, "inventory.view");
  const company = c.get("company");
  const scope = c.get("branches");
  const ids = scope.ids.length ? scope.ids : [""];
  const vis = scope.all ? "" : ` AND (t.from_branch_id IN (${ids.map(() => "?").join(",")}) OR t.to_branch_id IN (${ids.map(() => "?").join(",")}))`;
  const rows = await all(c.env.DB,
    `SELECT t.*, i.name AS item_name, i.code AS item_code, fw.name AS from_warehouse, tw.name AS to_warehouse, fb.name AS from_branch, tb.name AS to_branch, u.name AS created_by_name
     FROM stock_transfers t JOIN items i ON i.id = t.item_id JOIN warehouses fw ON fw.id = t.from_warehouse_id JOIN warehouses tw ON tw.id = t.to_warehouse_id
     LEFT JOIN branches fb ON fb.id = t.from_branch_id LEFT JOIN branches tb ON tb.id = t.to_branch_id LEFT JOIN users u ON u.id = t.created_by
     WHERE t.company_id = ?${vis} ORDER BY t.transfer_date DESC, t.created_at DESC LIMIT 200`, company.id, ...(scope.all ? [] : [...ids, ...ids]));
  return c.json({ transfers: rows.map((r) => hideCost(c, r as Record<string, unknown>)) });
});

export default items;
