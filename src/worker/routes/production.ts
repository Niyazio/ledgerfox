import { Hono } from "hono";
import { z } from "zod";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { all, batch, bumpSequence, first, seqNumberExpr, stmt, todayIso } from "../lib/db";
import { badRequest, conflict, notFound, unprocessable } from "../lib/errors";
import { body, isoDate, minor, qty, reqText, shortText, pageParams } from "../lib/validate";
import { newId } from "../lib/crypto";
import { assertBranchVisible, audit, branchFilter, requirePerm } from "../lib/auth";
import { currencyExponent } from "@shared/currencies";
import { assertOpenPeriod, buildJournal, buildReversal, systemAccounts } from "../services/ledger";
import { batchBalances, pickBatches, planIssues, splitValue, stockMoveStmt } from "../services/inventory";

/**
 * Manufacturing: a bill of materials says what one batch of a product consumes; a production entry consumes the
 * components at moving-average cost and adds the finished product at that cost plus any labour/overhead.
 * Components and finished goods sit in the same Inventory account, so only the labour/overhead reaches the ledger
 * (Dr Inventory, Cr the account it was paid or accrued from).
 */
const production = new Hono<AppEnv>();

const scale = (perOutput: number, output: number, made: number) => Number((BigInt(perOutput) * BigInt(made) + BigInt(output) / 2n) / BigInt(output));

type Item = { id: string; name: string; unit: string; track_inventory: number; track_batches: number; kind: string };
async function itemsById(db: D1Database, companyId: string, ids: string[]) {
  if (!ids.length) return new Map<string, Item>();
  const rows = await all<Item>(db, `SELECT id, name, unit, track_inventory, track_batches, kind FROM items WHERE company_id = ? AND id IN (${ids.map(() => "?").join(",")})`, companyId, ...ids);
  return new Map(rows.map((r) => [r.id, r]));
}

const bomSchema = z.object({
  item_id: z.string(), name: reqText(120), output_quantity: z.union([z.string(), z.number()]).default("1"), notes: shortText(500).nullish(), is_active: z.boolean().optional(),
  lines: z.array(z.object({ item_id: z.string(), quantity: z.union([z.string(), z.number()]) })).min(1).max(100),
});

async function checkBom(c: Context<AppEnv>, input: z.infer<typeof bomSchema>) {
  const company = c.get("company");
  const items = await itemsById(c.env.DB, company.id, [input.item_id, ...input.lines.map((l) => l.item_id)]);
  const product = items.get(input.item_id);
  if (!product || !product.track_inventory) throw badRequest("The finished product must be a stock item");
  const output = qty(input.output_quantity, "Output quantity");
  if (output <= 0) throw badRequest("Output quantity must be positive");
  const lines = input.lines.map((l, n) => {
    const it = items.get(l.item_id);
    if (!it || !it.track_inventory) throw badRequest(`Component ${n + 1}: must be a stock item (add labour and overheads as extra cost)`);
    if (l.item_id === input.item_id) throw badRequest(`Component ${n + 1}: a product cannot consume itself`);
    const q = qty(l.quantity, `Component ${n + 1} quantity`);
    if (q <= 0) throw badRequest(`Component ${n + 1}: quantity must be positive`);
    return { item_id: l.item_id, qty_milli: q };
  });
  return { output, lines };
}

production.get("/boms", async (c) => {
  requirePerm(c, "inventory.view");
  const rows = await all(c.env.DB,
    `SELECT b.id, b.name, b.item_id, i.name AS item_name, i.unit, b.output_qty_milli, b.is_active, b.notes,
       (SELECT COUNT(*) FROM bom_lines l WHERE l.bom_id = b.id) AS components
     FROM boms b JOIN items i ON i.id = b.item_id WHERE b.company_id = ? ORDER BY i.name, b.name`, c.get("company").id);
  return c.json({ boms: rows });
});

production.get("/boms/:id", async (c) => {
  requirePerm(c, "inventory.view");
  const company = c.get("company");
  const bom = await first(c.env.DB, `SELECT b.*, i.name AS item_name, i.unit FROM boms b JOIN items i ON i.id = b.item_id WHERE b.id = ? AND b.company_id = ?`, c.req.param("id"), company.id);
  if (!bom) throw notFound("Bill of materials");
  const lines = await all(c.env.DB, `SELECT l.item_id, i.name, i.unit, l.qty_milli FROM bom_lines l JOIN items i ON i.id = l.item_id WHERE l.bom_id = ? ORDER BY l.line_no`, c.req.param("id"));
  return c.json({ bom, lines });
});

production.post("/boms", async (c) => {
  requirePerm(c, "items.write");
  const input = await body(c, bomSchema);
  const { output, lines } = await checkBom(c, input);
  const company = c.get("company");
  const id = newId();
  await batch(c.env.DB, [
    stmt(c.env.DB, `INSERT INTO boms (id, company_id, item_id, name, output_qty_milli, notes, created_by) VALUES (?,?,?,?,?,?,?)`, id, company.id, input.item_id, input.name, output, input.notes ?? null, c.get("user").id),
    ...lines.map((l, i) => stmt(c.env.DB, `INSERT INTO bom_lines (id, company_id, bom_id, line_no, item_id, qty_milli) VALUES (?,?,?,?,?,?)`, newId(), company.id, id, i + 1, l.item_id, l.qty_milli)),
    audit(c, "bom.create", "bom", id, { name: input.name, components: lines.length }),
  ]);
  return c.json({ id }, 201);
});

production.put("/boms/:id", async (c) => {
  requirePerm(c, "items.write");
  const input = await body(c, bomSchema);
  const { output, lines } = await checkBom(c, input);
  const company = c.get("company");
  const id = c.req.param("id");
  if (!(await first(c.env.DB, `SELECT 1 FROM boms WHERE id = ? AND company_id = ?`, id, company.id))) throw notFound("Bill of materials");
  await batch(c.env.DB, [
    stmt(c.env.DB, `UPDATE boms SET item_id = ?, name = ?, output_qty_milli = ?, notes = ?, is_active = ? WHERE id = ? AND company_id = ?`, input.item_id, input.name, output, input.notes ?? null, input.is_active === false ? 0 : 1, id, company.id),
    stmt(c.env.DB, `DELETE FROM bom_lines WHERE bom_id = ? AND company_id = ?`, id, company.id),
    ...lines.map((l, i) => stmt(c.env.DB, `INSERT INTO bom_lines (id, company_id, bom_id, line_no, item_id, qty_milli) VALUES (?,?,?,?,?,?)`, newId(), company.id, id, i + 1, l.item_id, l.qty_milli)),
    audit(c, "bom.update", "bom", id, { name: input.name, components: lines.length }),
  ]);
  return c.json({ ok: true });
});

/** Components needed to make `qty` with a bill of materials, with stock on hand in a warehouse. */
production.get("/boms/:id/plan", async (c) => {
  requirePerm(c, "inventory.view");
  const company = c.get("company");
  const bom = await first<{ output_qty_milli: number }>(c.env.DB, `SELECT output_qty_milli FROM boms WHERE id = ? AND company_id = ?`, c.req.param("id"), company.id);
  if (!bom) throw notFound("Bill of materials");
  const made = qty(c.req.query("qty") || "1");
  const wh = c.req.query("warehouse_id") ?? "";
  const lines = await all<{ item_id: string; name: string; unit: string; qty_milli: number; on_hand: number; stock_qty: number; stock_value: number }>(c.env.DB,
    `SELECT l.item_id, i.name, i.unit, l.qty_milli,
       COALESCE((SELECT SUM(s.qty_milli) FROM stock_moves s WHERE s.company_id = l.company_id AND s.item_id = l.item_id AND s.warehouse_id = ?), 0) AS on_hand,
       COALESCE((SELECT SUM(s.qty_milli) FROM stock_moves s WHERE s.company_id = l.company_id AND s.item_id = l.item_id), 0) AS stock_qty,
       COALESCE((SELECT SUM(s.value) FROM stock_moves s WHERE s.company_id = l.company_id AND s.item_id = l.item_id), 0) AS stock_value
     FROM bom_lines l JOIN items i ON i.id = l.item_id WHERE l.bom_id = ? AND l.company_id = ? ORDER BY l.line_no`, wh, c.req.param("id"), company.id);
  const need = lines.map((l) => {
    const required = scale(l.qty_milli, bom.output_qty_milli, made);
    const cost = l.stock_qty > 0 ? Math.round((l.stock_value * required) / l.stock_qty) : 0;
    return { item_id: l.item_id, name: l.name, unit: l.unit, required_milli: required, on_hand_milli: l.on_hand, short_milli: Math.max(0, required - l.on_hand), estimated_cost: cost };
  });
  return c.json({ qty_milli: made, components: need, estimated_material_cost: need.reduce((t, n) => t + n.estimated_cost, 0) });
});

// ── Production entries ──

production.get("/orders", async (c) => {
  requirePerm(c, "inventory.view");
  const company = c.get("company");
  const { limit, offset } = pageParams(c);
  const bf = branchFilter(c, "p.branch_id");
  const rows = await all(c.env.DB,
    `SELECT p.id, p.number, p.production_date, p.item_id, i.name AS item_name, i.unit, p.qty_milli, p.material_cost, p.extra_cost, p.total_cost, p.status,
            p.batch_no, w.name AS warehouse_name, u.name AS created_by_name
     FROM production_orders p JOIN items i ON i.id = p.item_id JOIN warehouses w ON w.id = p.warehouse_id LEFT JOIN users u ON u.id = p.created_by
     WHERE p.company_id = ?${bf.sql} ORDER BY p.production_date DESC, p.created_at DESC LIMIT ? OFFSET ?`, company.id, ...bf.params, limit, offset);
  return c.json({ orders: rows });
});

production.get("/orders/:id", async (c) => {
  requirePerm(c, "inventory.view");
  const company = c.get("company");
  const p = await first<{ branch_id: string | null }>(c.env.DB,
    `SELECT p.*, i.name AS item_name, i.unit, w.name AS warehouse_name, b.name AS bom_name, a.name AS extra_account_name, je.entry_number AS journal_number
     FROM production_orders p JOIN items i ON i.id = p.item_id JOIN warehouses w ON w.id = p.warehouse_id LEFT JOIN boms b ON b.id = p.bom_id
     LEFT JOIN accounts a ON a.id = p.extra_account_id LEFT JOIN journal_entries je ON je.id = p.journal_entry_id
     WHERE p.id = ? AND p.company_id = ?`, c.req.param("id"), company.id);
  if (!p) throw notFound("Production entry");
  assertBranchVisible(c, p.branch_id);
  const lines = await all(c.env.DB, `SELECT l.item_id, i.name, i.unit, l.qty_milli, l.value FROM production_lines l JOIN items i ON i.id = l.item_id WHERE l.production_id = ? ORDER BY i.name`, c.req.param("id"));
  return c.json({ order: p, lines });
});

const orderSchema = z.object({
  bom_id: z.string().nullish(),
  item_id: z.string().nullish(),
  quantity: z.union([z.string(), z.number()]),
  date: isoDate,
  warehouse_id: z.string(),
  components: z.array(z.object({ item_id: z.string(), quantity: z.union([z.string(), z.number()]) })).max(100).nullish(),
  extra_cost: z.union([z.string(), z.number()]).nullish(),
  extra_account_id: z.string().nullish(),
  batch_no: z.string().trim().max(40).nullish(),
  expiry_date: isoDate.nullish().or(z.literal("")),
  memo: shortText(300).nullish(),
});

production.post("/orders", async (c) => {
  requirePerm(c, "inventory.adjust");
  const input = await body(c, orderSchema);
  const company = c.get("company");
  const user = c.get("user");
  const db = c.env.DB;
  const wh = await first<{ branch_id: string | null }>(db, `SELECT branch_id FROM warehouses WHERE id = ? AND company_id = ? AND is_active = 1`, input.warehouse_id, company.id);
  if (!wh) throw badRequest("Warehouse not found");
  assertBranchVisible(c, wh.branch_id);
  await assertOpenPeriod(db, company.id, input.date);
  const made = qty(input.quantity, "Quantity made");
  if (made <= 0) throw badRequest("Quantity made must be positive");

  // Components: as entered (actual consumption), else scaled from the bill of materials.
  let productId = input.item_id ?? null;
  let comps: { item_id: string; qty_milli: number }[];
  if (input.bom_id) {
    const bom = await first<{ item_id: string; output_qty_milli: number; is_active: number }>(db, `SELECT item_id, output_qty_milli, is_active FROM boms WHERE id = ? AND company_id = ?`, input.bom_id, company.id);
    if (!bom) throw notFound("Bill of materials");
    if (productId && productId !== bom.item_id) throw badRequest("The product does not match the bill of materials");
    productId = bom.item_id;
    const lines = await all<{ item_id: string; qty_milli: number }>(db, `SELECT item_id, qty_milli FROM bom_lines WHERE bom_id = ? ORDER BY line_no`, input.bom_id);
    comps = lines.map((l) => ({ item_id: l.item_id, qty_milli: scale(l.qty_milli, bom.output_qty_milli, made) }));
  } else comps = [];
  if (input.components?.length) comps = input.components.map((l, n) => ({ item_id: l.item_id, qty_milli: qty(l.quantity, `Component ${n + 1} quantity`) }));
  if (!productId) throw badRequest("Choose a bill of materials or a product");
  comps = comps.filter((l) => l.qty_milli !== 0);
  if (!comps.length) throw badRequest("Add at least one component");
  // One line per component (two rows of the same material are consumed together).
  const merged = new Map<string, number>();
  for (const l of comps) {
    if (l.qty_milli < 0) throw badRequest("Component quantities must be positive");
    merged.set(l.item_id, (merged.get(l.item_id) ?? 0) + l.qty_milli);
  }
  const items = await itemsById(db, company.id, [productId, ...merged.keys()]);
  const product = items.get(productId);
  if (!product || !product.track_inventory) throw badRequest("The finished product must be a stock item");
  if (merged.has(productId)) throw badRequest("A product cannot consume itself");
  for (const id of merged.keys()) if (!items.get(id)?.track_inventory) throw badRequest("Components must be stock items");

  const exp = currencyExponent(company.base_currency);
  const extra = input.extra_cost ? minor(input.extra_cost, exp, "Extra cost") : 0;
  if (extra < 0) throw badRequest("Extra cost cannot be negative");
  if (extra > 0) {
    if (!input.extra_account_id) throw badRequest("Choose the account the labour/overhead is charged from");
    const acc = await first<{ type: string; is_active: number }>(db, `SELECT type, is_active FROM accounts WHERE id = ? AND company_id = ?`, input.extra_account_id, company.id);
    if (!acc || !acc.is_active) throw badRequest("Account not found");
  }
  const fgBatch = input.batch_no?.toUpperCase() || null;
  if (product.track_batches && !fgBatch) throw unprocessable("BATCH_REQUIRED", `Enter the batch number for "${product.name}"`);

  const plan = await planIssues(db, company.id, [...merged].map(([item_id, q]) => ({ item_id, qty_milli: q, warehouse_id: input.warehouse_id, name: items.get(item_id)!.name })));
  const material = plan.reduce((t, p) => t + p.value, 0);
  const total = material + extra;
  const id = newId();
  const stmts: D1PreparedStatement[] = [];
  let journalId: string | null = null;
  if (extra > 0) {
    const acc = await systemAccounts(db, company.id, ["INVENTORY"]);
    const built = buildJournal(db, {
      company_id: company.id, entry_date: input.date, kind: "system", memo: `Production: ${product.name} — labour/overhead`,
      source_type: "production", source_id: id, branch_id: wh.branch_id, created_by: user.id, post: true,
      lines: [{ account_id: acc.INVENTORY, debit: extra }, { account_id: input.extra_account_id!, credit: extra }],
    });
    journalId = built.id;
    stmts.push(...built.stmts);
  }
  stmts.push(...bumpSequence(db, company.id, "production", "PRD-"));
  stmts.push(stmt(db,
    `INSERT INTO production_orders (id, company_id, number, bom_id, item_id, qty_milli, production_date, warehouse_id, material_cost, extra_cost, extra_account_id,
       total_cost, journal_entry_id, batch_no, expiry_date, memo, branch_id, created_by)
     VALUES (?, ?, ${seqNumberExpr()}, ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, company.id, company.id, "production", input.bom_id ?? null, productId, made, input.date, input.warehouse_id, material, extra, extra > 0 ? input.extra_account_id ?? null : null,
    total, journalId, fgBatch, input.expiry_date || null, input.memo ?? null, wh.branch_id ?? null, user.id));
  const move = (m: { item_id: string; qty_milli: number; value: number; batch_no?: string | null; expiry_date?: string | null }) => stockMoveStmt(db, {
    company_id: company.id, item_id: m.item_id, warehouse_id: input.warehouse_id, move_date: input.date, qty_milli: m.qty_milli, value: m.value, kind: "adjustment",
    source_type: "production", source_id: id, journal_entry_id: journalId, memo: input.memo ?? `Production ${product.name}`, created_by: user.id, batch_no: m.batch_no ?? null, expiry_date: m.expiry_date ?? null,
  });
  // Components out first (first-expiry-first-out for batch-tracked materials), then the finished product in.
  for (const p of plan) {
    stmts.push(stmt(db, `INSERT INTO production_lines (id, company_id, production_id, item_id, qty_milli, value) VALUES (?,?,?,?,?,?)`, newId(), company.id, id, p.item_id, p.qty_milli, p.value));
    const it = items.get(p.item_id)!;
    if (it.track_batches) {
      const picks = pickBatches(await batchBalances(db, company.id, p.item_id, input.warehouse_id), p.qty_milli, input.date, it.name);
      const values = splitValue(p.value, picks);
      picks.forEach((b, i) => stmts.push(move({ item_id: p.item_id, qty_milli: -b.qty_milli, value: -values[i], batch_no: b.batch_no, expiry_date: b.expiry_date })));
    } else stmts.push(move({ item_id: p.item_id, qty_milli: -p.qty_milli, value: -p.value }));
  }
  stmts.push(move({ item_id: productId, qty_milli: made, value: total, batch_no: fgBatch, expiry_date: input.expiry_date || null }));
  stmts.push(audit(c, "production.post", "production", id, { item_id: productId, qty_milli: made, material, extra }));
  await batch(db, stmts);
  const row = await first<{ number: string }>(db, `SELECT number FROM production_orders WHERE id = ?`, id);
  return c.json({ id, number: row?.number, material_cost: material, extra_cost: extra, total_cost: total, unit_cost: Math.round((total * 1000) / made) }, 201);
});

/** Void: takes the finished product back out and returns the components at the values they left with. */
production.post("/orders/:id/void", async (c) => {
  requirePerm(c, "inventory.adjust");
  const company = c.get("company");
  const user = c.get("user");
  const db = c.env.DB;
  const id = c.req.param("id");
  const input = await body(c, z.object({ date: isoDate.nullish(), reason: shortText(300).nullish() }));
  const p = await first<{ status: string; production_date: string; journal_entry_id: string | null; branch_id: string | null; number: string; item_id: string; warehouse_id: string }>(db,
    `SELECT status, production_date, journal_entry_id, branch_id, number, item_id, warehouse_id FROM production_orders WHERE id = ? AND company_id = ?`, id, company.id);
  if (!p) throw notFound("Production entry");
  assertBranchVisible(c, p.branch_id);
  if (p.status === "void") throw conflict("ALREADY_VOID", "Already void");
  const date = input.date ?? (todayIso() < p.production_date ? p.production_date : todayIso());
  if (date < p.production_date) throw badRequest("The void date cannot be before the production date");
  await assertOpenPeriod(db, company.id, date);
  const moves = await all<{ item_id: string; warehouse_id: string; qty_milli: number; value: number; batch_no: string | null; expiry_date: string | null }>(db,
    `SELECT item_id, warehouse_id, qty_milli, value, batch_no, expiry_date FROM stock_moves WHERE company_id = ? AND source_type = 'production' AND source_id = ?`, company.id, id);
  // The finished goods must still be on hand (in the same batch, for batch-tracked products).
  for (const m of moves.filter((x) => x.qty_milli > 0)) {
    const have = m.batch_no
      ? (await batchBalances(db, company.id, m.item_id, m.warehouse_id)).find((b) => b.batch_no === m.batch_no)?.qty_milli ?? 0
      : (await first<{ q: number }>(db, `SELECT COALESCE(SUM(qty_milli),0) AS q FROM stock_moves WHERE company_id = ? AND item_id = ? AND warehouse_id = ?`, company.id, m.item_id, m.warehouse_id))?.q ?? 0;
    if (have < m.qty_milli) throw unprocessable("INSUFFICIENT_STOCK", `Only ${have / 1000} of the ${m.qty_milli / 1000} made are still in stock; it cannot be voided`);
  }
  const stmts: D1PreparedStatement[] = [];
  let revId: string | null = null;
  if (p.journal_entry_id) {
    const rev = await buildReversal(db, company.id, p.journal_entry_id, date, user.id, `Void ${p.number}${input.reason ? ` — ${input.reason}` : ""}`, { allowSourced: true });
    revId = rev.id;
    stmts.push(...rev.stmts);
  }
  // Finished goods out before components back in, so stock never dips below zero.
  for (const m of [...moves].sort((a, b) => b.qty_milli - a.qty_milli)) {
    stmts.push(stockMoveStmt(db, {
      company_id: company.id, item_id: m.item_id, warehouse_id: m.warehouse_id, move_date: date, qty_milli: -m.qty_milli, value: -m.value, kind: "adjustment",
      source_type: "production_void", source_id: id, journal_entry_id: revId, memo: `Void ${p.number}`, created_by: user.id, batch_no: m.batch_no, expiry_date: m.expiry_date,
    }));
  }
  stmts.push(stmt(db, `UPDATE production_orders SET status = 'void', void_journal_id = ?, voided_by = ?, voided_at = ? WHERE id = ? AND company_id = ? AND status = 'posted'`, revId, user.id, new Date().toISOString(), id, company.id));
  stmts.push(audit(c, "production.void", "production", id, { reason: input.reason ?? null }));
  await batch(db, stmts);
  return c.json({ ok: true });
});

export default production;
