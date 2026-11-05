/**
 * Everything about one product in one place: stock by branch and warehouse, batches and expiry, production, sales,
 * deliveries, purchases, how the invoices and bills were paid (cash or bank) and what is still outstanding, and the
 * profit. Read-only; every figure comes from posted documents and stock movements. Amounts are in the base currency
 * unless a row carries its own `currency`.
 *
 * Payments are made per invoice or bill, not per product: the payment columns describe the whole document the
 * product was sold or bought on.
 */
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { all, first } from "../lib/db";
import { branchFilter, hasPerm } from "../lib/auth";

const BASE = (amount: string, doc = "d") => `CAST(ROUND(${amount} * ${doc}.fx_rate_scaled / 1000000000.0) AS INTEGER)`;
const ROWS = 200;

export interface PaidVia { document_id: string; kind: "cash" | "bank" | "other" | "note"; account: string; amount: number }

/** How each document was settled: by cash, by bank (account names), or by credit / debit notes. Document currency. */
export async function paidVia(c: Context<AppEnv>, docIds: string[]): Promise<Map<string, PaidVia[]>> {
  const out = new Map<string, PaidVia[]>();
  for (let i = 0; i < docIds.length; i += 90) {
    const ids = docIds.slice(i, i + 90);
    const rows = await all<{ document_id: string; source_kind: string; subtype: string | null; account: string | null; note: string | null; amount: number }>(c.env.DB,
      `SELECT a.document_id, a.source_kind, ac.subtype, ac.name AS account, n.number AS note, SUM(a.amount) AS amount
         FROM allocations a
         LEFT JOIN payments p ON p.id = a.payment_id
         LEFT JOIN accounts ac ON ac.id = p.account_id
         LEFT JOIN documents n ON n.id = a.note_id
        WHERE a.company_id = ? AND a.document_id IN (${ids.map(() => "?").join(",")}) AND (p.id IS NULL OR p.status = 'posted')
        GROUP BY a.document_id, a.source_kind, ac.id, n.id HAVING SUM(a.amount) <> 0`, c.get("company").id, ...ids);
    for (const r of rows) {
      const kind: PaidVia["kind"] = r.source_kind !== "payment" ? "note" : r.subtype === "cash" ? "cash" : r.subtype === "bank" ? "bank" : "other";
      const list = out.get(r.document_id) ?? [];
      list.push({ document_id: r.document_id, kind, account: r.source_kind === "payment" ? (r.account ?? "") : `${r.source_kind === "credit_note" ? "Credit note" : "Debit note"} ${r.note ?? ""}`.trim(), amount: r.amount });
      out.set(r.document_id, list);
    }
  }
  return out;
}

/** Split the settled amounts of documents into cash / bank / notes, in the base currency. */
function settledSplit(docs: { id: string; fx_rate_scaled: number }[], via: Map<string, PaidVia[]>) {
  const s = { cash: 0, bank: 0, other: 0, note: 0 };
  for (const d of docs) for (const p of via.get(d.id) ?? []) s[p.kind] += Math.round((p.amount * d.fx_rate_scaled) / 1e9);
  return s;
}

const range = (from: string | undefined, to: string | undefined, col: string) => ({
  sql: `${from ? ` AND ${col} >= ?` : ""}${to ? ` AND ${col} <= ?` : ""}`,
  params: [...(from ? [from] : []), ...(to ? [to] : [])],
});

export async function productInsights(c: Context<AppEnv>, itemId: string, opts: { from?: string; to?: string } = {}) {
  const company = c.get("company");
  const db = c.env.DB;
  const cid = company.id;
  const seeCost = hasPerm(c, "items.cost") || hasPerm(c, "purchase.view") || hasPerm(c, "reports.read");
  const seeSales = hasPerm(c, "sales.view");
  const seePurchases = hasPerm(c, "purchase.view");
  const docBranch = branchFilter(c, "d.branch_id");
  const whBranch = branchFilter(c, "w.branch_id");
  const dr = range(opts.from, opts.to, "d.issue_date");

  // ── Stock: by warehouse (with its branch), and what moved in and out of each ──
  const warehouses = await all<{ warehouse_id: string; warehouse: string; branch_id: string | null; branch: string | null; qty_milli: number; value: number; sold_milli: number; bought_milli: number; produced_milli: number; transferred_milli: number }>(db,
    `SELECT w.id AS warehouse_id, w.name AS warehouse, w.branch_id, b.name AS branch,
            COALESCE(SUM(m.qty_milli),0) AS qty_milli, COALESCE(SUM(m.value),0) AS value,
            COALESCE(SUM(CASE WHEN m.kind = 'sale' THEN -m.qty_milli WHEN m.kind = 'return_in' THEN -m.qty_milli ELSE 0 END),0) AS sold_milli,
            COALESCE(SUM(CASE WHEN m.kind = 'purchase' THEN m.qty_milli WHEN m.kind = 'return_out' THEN m.qty_milli ELSE 0 END),0) AS bought_milli,
            COALESCE(SUM(CASE WHEN m.source_type = 'production' AND m.qty_milli > 0 THEN m.qty_milli ELSE 0 END),0) AS produced_milli,
            COALESCE(SUM(CASE WHEN m.kind = 'transfer' THEN m.qty_milli ELSE 0 END),0) AS transferred_milli
       FROM stock_moves m JOIN warehouses w ON w.id = m.warehouse_id LEFT JOIN branches b ON b.id = w.branch_id
      WHERE m.company_id = ? AND m.item_id = ?${whBranch.sql}
      GROUP BY w.id ORDER BY b.name, w.name`, cid, itemId, ...whBranch.params);
  const stock = warehouses.reduce((s, w) => ({ qty_milli: s.qty_milli + w.qty_milli, value: s.value + w.value }), { qty_milli: 0, value: 0 });

  // ── Batches: what is left of each, its expiry and where it came from ──
  const batches = await all<{ batch_no: string; warehouse: string; expiry_date: string | null; qty_milli: number; received_on: string; source_type: string | null; source_id: string | null }>(db,
    `SELECT m.batch_no, w.name AS warehouse, MAX(m.expiry_date) AS expiry_date, SUM(m.qty_milli) AS qty_milli, MIN(m.move_date) AS received_on,
            (SELECT x.source_type FROM stock_moves x WHERE x.company_id = m.company_id AND x.item_id = m.item_id AND x.batch_no = m.batch_no AND x.qty_milli > 0 ORDER BY x.move_date, x.created_at LIMIT 1) AS source_type,
            (SELECT x.source_id FROM stock_moves x WHERE x.company_id = m.company_id AND x.item_id = m.item_id AND x.batch_no = m.batch_no AND x.qty_milli > 0 ORDER BY x.move_date, x.created_at LIMIT 1) AS source_id
       FROM stock_moves m JOIN warehouses w ON w.id = m.warehouse_id
      WHERE m.company_id = ? AND m.item_id = ? AND m.batch_no IS NOT NULL${whBranch.sql}
      GROUP BY m.batch_no, w.id ORDER BY MAX(m.expiry_date) IS NULL, MAX(m.expiry_date), m.batch_no`, cid, itemId, ...whBranch.params);

  // Name each batch's source: "Bill B-0012", "Production PRD-0003", "Opening stock"…
  const srcIds = [...new Set(batches.map((b) => b.source_id).filter(Boolean))] as string[];
  const names = new Map<string, string>();
  if (srcIds.length) {
    const marks = srcIds.map(() => "?").join(",");
    for (const r of await all<{ id: string; label: string }>(db, `SELECT id, number AS label FROM documents WHERE company_id = ? AND id IN (${marks})
        UNION ALL SELECT id, number AS label FROM production_orders WHERE company_id = ? AND id IN (${marks})`, cid, ...srcIds, cid, ...srcIds)) names.set(r.id, r.label);
  }
  const SOURCE: Record<string, string> = { bill: "Bill", invoice: "Invoice", credit_note: "Credit note", debit_note: "Debit note", production: "Production" };
  const namedBatches = batches.map((b) => ({ ...b, source_label: b.source_type ? `${SOURCE[b.source_type] ?? b.source_type.replace(/_/g, " ")}${b.source_id && names.get(b.source_id) ? ` ${names.get(b.source_id)}` : ""}` : null }));

  // ── Production: runs that made it, and runs that used it as a material ──
  const prodBranch = branchFilter(c, "p.branch_id");
  const made = await all(db,
    `SELECT p.id, p.number, p.production_date, p.qty_milli, p.material_cost, p.extra_cost, p.total_cost, p.batch_no, p.expiry_date, p.status, w.name AS warehouse
       FROM production_orders p JOIN warehouses w ON w.id = p.warehouse_id
      WHERE p.company_id = ? AND p.item_id = ?${prodBranch.sql} ORDER BY p.production_date DESC LIMIT ${ROWS}`, cid, itemId, ...prodBranch.params);
  const usedIn = await all(db,
    `SELECT p.id, p.number, p.production_date, l.qty_milli, l.value, p.status, i.name AS product, i.id AS product_id
       FROM production_lines l JOIN production_orders p ON p.id = l.production_id JOIN items i ON i.id = p.item_id
      WHERE l.company_id = ? AND l.item_id = ?${prodBranch.sql} ORDER BY p.production_date DESC LIMIT ${ROWS}`, cid, itemId, ...prodBranch.params);

  // ── Sales (invoices less credit notes), with the stock cost of each line ──
  type SaleRow = { document_id: string; doc_type: string; number: string | null; issue_date: string; due_date: string | null; contact_id: string; contact: string; branch: string | null;
    qty_milli: number; unit_price: number; currency: string; fx_rate_scaled: number; taxable_base: number; cost: number; total: number; amount_settled: number; batch_no: string | null };
  const sales: SaleRow[] = seeSales ? await all<SaleRow>(db,
    `SELECT d.id AS document_id, d.doc_type, d.number, d.issue_date, d.due_date, d.contact_id, ct.name AS contact, b.name AS branch,
            l.qty_milli, l.unit_price, d.currency, d.fx_rate_scaled, ${BASE("l.taxable")} AS taxable_base, l.batch_no,
            COALESCE((SELECT -SUM(m.value) FROM stock_moves m WHERE m.company_id = d.company_id AND m.source_id = d.id AND m.source_type = d.doc_type AND m.item_id = l.item_id), 0) AS cost,
            d.total, d.amount_settled
       FROM document_lines l JOIN documents d ON d.id = l.document_id JOIN contacts ct ON ct.id = d.contact_id LEFT JOIN branches b ON b.id = d.branch_id
      WHERE l.company_id = ? AND l.item_id = ? AND d.doc_type IN ('invoice','credit_note') AND d.status = 'posted'${dr.sql}${docBranch.sql}
      ORDER BY d.issue_date DESC, d.number DESC LIMIT ${ROWS}`, cid, itemId, ...dr.params, ...docBranch.params) : [];
  // The cost subquery gives the document's whole cost for this product: keep it on the document's first line only,
  // when the product appears on several lines of one invoice.
  const seenCost = new Set<string>();
  for (const s of sales) {
    if (seenCost.has(s.document_id)) s.cost = 0; else seenCost.add(s.document_id);
  }

  const totals = seeSales ? await first<{ qty_milli: number; revenue: number; cost: number; invoices: number; customers: number }>(db,
    `SELECT COALESCE(SUM(CASE WHEN d.doc_type = 'invoice' THEN l.qty_milli ELSE -l.qty_milli END),0) AS qty_milli,
            COALESCE(SUM(CASE WHEN d.doc_type = 'invoice' THEN 1 ELSE -1 END * ${BASE("l.taxable")}),0) AS revenue,
            COUNT(DISTINCT CASE WHEN d.doc_type = 'invoice' THEN d.id END) AS invoices, COUNT(DISTINCT d.contact_id) AS customers,
            COALESCE((SELECT -SUM(m.value) FROM stock_moves m JOIN documents d2 ON d2.id = m.source_id
                       WHERE m.company_id = ? AND m.item_id = ? AND m.source_type IN ('invoice','credit_note') AND d2.status = 'posted'${range(opts.from, opts.to, "d2.issue_date").sql}${branchFilter(c, "d2.branch_id").sql}),0) AS cost
       FROM document_lines l JOIN documents d ON d.id = l.document_id
      WHERE l.company_id = ? AND l.item_id = ? AND d.doc_type IN ('invoice','credit_note') AND d.status = 'posted'${dr.sql}${docBranch.sql}`,
    cid, itemId, ...range(opts.from, opts.to, "d2.issue_date").params, ...branchFilter(c, "d2.branch_id").params, cid, itemId, ...dr.params, ...docBranch.params) : null;

  const monthly = seeSales ? await all<{ month: string; qty_milli: number; revenue: number; cost: number }>(db,
    `SELECT substr(d.issue_date, 1, 7) AS month,
            SUM(CASE WHEN d.doc_type = 'invoice' THEN l.qty_milli ELSE -l.qty_milli END) AS qty_milli,
            SUM(CASE WHEN d.doc_type = 'invoice' THEN 1 ELSE -1 END * ${BASE("l.taxable")}) AS revenue,
            0 AS cost
       FROM document_lines l JOIN documents d ON d.id = l.document_id
      WHERE l.company_id = ? AND l.item_id = ? AND d.doc_type IN ('invoice','credit_note') AND d.status = 'posted' AND d.issue_date >= date('now', 'start of month', '-11 months')${docBranch.sql}
      GROUP BY month ORDER BY month`, cid, itemId, ...docBranch.params) : [];
  if (monthly.length) {
    const costs = await all<{ month: string; cost: number }>(db,
      `SELECT substr(d.issue_date, 1, 7) AS month, -SUM(m.value) AS cost FROM stock_moves m JOIN documents d ON d.id = m.source_id
        WHERE m.company_id = ? AND m.item_id = ? AND m.source_type IN ('invoice','credit_note') AND d.status = 'posted' AND d.issue_date >= date('now', 'start of month', '-11 months')${docBranch.sql}
        GROUP BY month`, cid, itemId, ...docBranch.params);
    for (const m of monthly) m.cost = costs.find((x) => x.month === m.month)?.cost ?? 0;
  }

  const byBranch = seeSales ? await all<{ branch: string | null; qty_milli: number; revenue: number }>(db,
    `SELECT b.name AS branch, SUM(CASE WHEN d.doc_type = 'invoice' THEN l.qty_milli ELSE -l.qty_milli END) AS qty_milli,
            SUM(CASE WHEN d.doc_type = 'invoice' THEN 1 ELSE -1 END * ${BASE("l.taxable")}) AS revenue
       FROM document_lines l JOIN documents d ON d.id = l.document_id LEFT JOIN branches b ON b.id = d.branch_id
      WHERE l.company_id = ? AND l.item_id = ? AND d.doc_type IN ('invoice','credit_note') AND d.status = 'posted'${dr.sql}${docBranch.sql}
      GROUP BY d.branch_id ORDER BY revenue DESC`, cid, itemId, ...dr.params, ...docBranch.params) : [];

  const topCustomers = seeSales ? await all(db,
    `SELECT ct.id, ct.name, SUM(CASE WHEN d.doc_type = 'invoice' THEN l.qty_milli ELSE -l.qty_milli END) AS qty_milli,
            SUM(CASE WHEN d.doc_type = 'invoice' THEN 1 ELSE -1 END * ${BASE("l.taxable")}) AS revenue, MAX(d.issue_date) AS last_bought
       FROM document_lines l JOIN documents d ON d.id = l.document_id JOIN contacts ct ON ct.id = d.contact_id
      WHERE l.company_id = ? AND l.item_id = ? AND d.doc_type IN ('invoice','credit_note') AND d.status = 'posted'${dr.sql}${docBranch.sql}
      GROUP BY ct.id ORDER BY revenue DESC LIMIT 10`, cid, itemId, ...dr.params, ...docBranch.params) : [];

  // ── Deliveries (delivery challans) ──
  const deliveries = seeSales ? await all(db,
    `SELECT d.id AS document_id, d.number, d.issue_date, d.status, ct.id AS contact_id, ct.name AS contact, l.qty_milli
       FROM document_lines l JOIN documents d ON d.id = l.document_id JOIN contacts ct ON ct.id = d.contact_id
      WHERE l.company_id = ? AND l.item_id = ? AND d.doc_type = 'sales_order' AND d.variant = 'delivery_challan' AND d.status <> 'void'${dr.sql}${docBranch.sql}
      ORDER BY d.issue_date DESC LIMIT ${ROWS}`, cid, itemId, ...dr.params, ...docBranch.params) : [];

  // ── Purchases (bills less debit notes) ──
  type BuyRow = Omit<SaleRow, "cost">;
  const purchases: BuyRow[] = seePurchases ? await all<BuyRow>(db,
    `SELECT d.id AS document_id, d.doc_type, d.number, d.issue_date, d.due_date, d.contact_id, ct.name AS contact, b.name AS branch,
            l.qty_milli, l.unit_price, d.currency, d.fx_rate_scaled, ${BASE("l.taxable")} AS taxable_base, l.batch_no, d.total, d.amount_settled
       FROM document_lines l JOIN documents d ON d.id = l.document_id JOIN contacts ct ON ct.id = d.contact_id LEFT JOIN branches b ON b.id = d.branch_id
      WHERE l.company_id = ? AND l.item_id = ? AND d.doc_type IN ('bill','debit_note') AND d.status = 'posted'${dr.sql}${docBranch.sql}
      ORDER BY d.issue_date DESC, d.number DESC LIMIT ${ROWS}`, cid, itemId, ...dr.params, ...docBranch.params) : [];
  const suppliers = seePurchases ? await all(db,
    `SELECT ct.id, ct.name, SUM(CASE WHEN d.doc_type = 'bill' THEN l.qty_milli ELSE -l.qty_milli END) AS qty_milli,
            SUM(CASE WHEN d.doc_type = 'bill' THEN 1 ELSE -1 END * ${BASE("l.taxable")}) AS spent, MAX(d.issue_date) AS last_bought,
            MIN(l.unit_price) AS lowest_price, MAX(l.unit_price) AS highest_price
       FROM document_lines l JOIN documents d ON d.id = l.document_id JOIN contacts ct ON ct.id = d.contact_id
      WHERE l.company_id = ? AND l.item_id = ? AND d.doc_type IN ('bill','debit_note') AND d.status = 'posted'${dr.sql}${docBranch.sql}
      GROUP BY ct.id ORDER BY spent DESC LIMIT 10`, cid, itemId, ...dr.params, ...docBranch.params) : [];

  // ── Payments of those invoices and bills: cash / bank / notes, and what is outstanding ──
  const uniq = <T extends { document_id: string; doc_type: string; fx_rate_scaled: number; total: number; amount_settled: number }>(rows: T[], type: string) =>
    [...new Map(rows.filter((r) => r.doc_type === type).map((r) => [r.document_id, r])).values()];
  const invoices = uniq(sales, "invoice"), bills = uniq(purchases, "bill");
  const via = await paidVia(c, [...invoices, ...bills].map((d) => d.document_id));
  type Doc = { document_id: string; fx_rate_scaled: number; total: number; amount_settled: number };
  const money = (docs: Doc[]) => {
    const split = settledSplit(docs.map((d) => ({ id: d.document_id, fx_rate_scaled: d.fx_rate_scaled })), via);
    const base = (v: number, d: Doc) => Math.round((v * d.fx_rate_scaled) / 1e9);
    return {
      documents: docs.length,
      total: docs.reduce((s, d) => s + base(d.total, d), 0),
      settled: docs.reduce((s, d) => s + base(d.amount_settled, d), 0),
      outstanding: docs.reduce((s, d) => s + base(d.total - d.amount_settled, d), 0),
      ...split,
    };
  };
  const withVia = <T extends { document_id: string }>(rows: T[]) => rows.map((r) => ({ ...r, paid_via: via.get(r.document_id) ?? [] }));

  const revenue = totals?.revenue ?? 0, cost = totals?.cost ?? 0;
  const strip = <T extends Record<string, unknown>>(rows: T[], keys: string[]) => (seeCost ? rows : rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !keys.includes(k))) as T));
  return {
    stock: { ...stock, ...(seeCost ? { avg_cost: stock.qty_milli > 0 ? Math.round((stock.value * 1000) / stock.qty_milli) : 0 } : { value: undefined }) },
    warehouses: strip(warehouses, ["value"]),
    batches: namedBatches,
    production: seeCost ? { made, used_in: usedIn } : { made: made.map(({ material_cost: _a, extra_cost: _b, total_cost: _c, ...r }: any) => r), used_in: usedIn.map(({ value: _v, ...r }: any) => r) },
    sales: seeSales ? {
      summary: { qty_milli: totals?.qty_milli ?? 0, revenue, invoices: totals?.invoices ?? 0, customers: totals?.customers ?? 0, ...(seeCost ? { cost, profit: revenue - cost, margin_bp: revenue ? Math.round(((revenue - cost) * 10000) / revenue) : null } : {}) },
      rows: strip(withVia(sales), ["cost"]), monthly: strip(monthly, ["cost"]), by_branch: byBranch, top_customers: topCustomers, deliveries,
      payments: money(invoices),
    } : null,
    purchases: seePurchases ? { rows: withVia(purchases), suppliers, payments: money(bills) } : null,
    can: { cost: seeCost, sales: seeSales, purchases: seePurchases },
  };
}

/**
 * A customer's or supplier's page: what they bought or supplied (by product), how much was paid by cash and by bank,
 * what is outstanding and overdue, and — for customers — the profit made on their invoices.
 */
export async function contactInsights(c: Context<AppEnv>, contactId: string, opts: { from?: string; to?: string; customer: boolean; supplier: boolean }) {
  const db = c.env.DB, cid = c.get("company").id;
  const seeCost = hasPerm(c, "items.cost") || hasPerm(c, "purchase.view") || hasPerm(c, "reports.read");
  const bd = branchFilter(c, "d.branch_id");
  const dr = range(opts.from, opts.to, "d.issue_date");
  const today = new Date().toISOString().slice(0, 10);

  const side = async (main: "invoice" | "bill", note: "credit_note" | "debit_note") => {
    const docs = await all<{ document_id: string; doc_type: string; fx_rate_scaled: number; total: number; amount_settled: number; due_date: string | null }>(db,
      `SELECT d.id AS document_id, d.doc_type, d.fx_rate_scaled, d.total, d.amount_settled, d.due_date FROM documents d
        WHERE d.company_id = ? AND d.contact_id = ? AND d.doc_type = ? AND d.status = 'posted'${dr.sql}${bd.sql}`, cid, contactId, main, ...dr.params, ...bd.params);
    const via = await paidVia(c, docs.map((d) => d.document_id));
    const base = (v: number, d: { fx_rate_scaled: number }) => Math.round((v * d.fx_rate_scaled) / 1e9);
    const split = settledSplit(docs.map((d) => ({ id: d.document_id, fx_rate_scaled: d.fx_rate_scaled })), via);
    const products = await all<{ item_id: string | null; name: string; unit: string | null; qty_milli: number; amount: number; cost: number; documents: number; last_date: string }>(db,
      `SELECT l.item_id, COALESCE(i.name, l.description) AS name, i.unit,
              SUM(CASE WHEN d.doc_type = ? THEN l.qty_milli ELSE -l.qty_milli END) AS qty_milli,
              SUM(CASE WHEN d.doc_type = ? THEN 1 ELSE -1 END * ${BASE("l.taxable")}) AS amount,
              0 AS cost, COUNT(DISTINCT d.id) AS documents, MAX(d.issue_date) AS last_date
         FROM document_lines l JOIN documents d ON d.id = l.document_id LEFT JOIN items i ON i.id = l.item_id
        WHERE l.company_id = ? AND d.contact_id = ? AND d.doc_type IN (?, ?) AND d.status = 'posted'${dr.sql}${bd.sql}
        GROUP BY COALESCE(l.item_id, l.description) ORDER BY amount DESC LIMIT 100`, main, main, cid, contactId, main, note, ...dr.params, ...bd.params);
    if (main === "invoice" && seeCost) {
      const costs = await all<{ item_id: string; cost: number }>(db,
        `SELECT m.item_id, -SUM(m.value) AS cost FROM stock_moves m JOIN documents d ON d.id = m.source_id
          WHERE m.company_id = ? AND d.contact_id = ? AND m.source_type IN ('invoice','credit_note') AND d.status = 'posted'${dr.sql}${bd.sql}
          GROUP BY m.item_id`, cid, contactId, ...dr.params, ...bd.params);
      for (const p of products) p.cost = costs.find((x) => x.item_id === p.item_id)?.cost ?? 0;
    }
    const outstanding = docs.reduce((s, d) => s + base(d.total - d.amount_settled, d), 0);
    const overdue = docs.filter((d) => d.due_date && d.due_date < today).reduce((s, d) => s + base(d.total - d.amount_settled, d), 0);
    const amount = products.reduce((s, p) => s + p.amount, 0);
    const cost = products.reduce((s, p) => s + p.cost, 0);
    return {
      summary: {
        documents: docs.length, total: docs.reduce((s, d) => s + base(d.total, d), 0), settled: docs.reduce((s, d) => s + base(d.amount_settled, d), 0), outstanding, overdue, ...split,
        amount, ...(main === "invoice" && seeCost ? { cost, profit: amount - cost, margin_bp: amount ? Math.round(((amount - cost) * 10000) / amount) : null } : {}),
      },
      products: main === "invoice" && seeCost ? products : products.map(({ cost: _c, ...p }) => p),
    };
  };

  const payments = await all(db,
    `SELECT p.id, p.direction, p.number, p.payment_date, p.currency, p.amount, p.amount_base, p.method, p.reference, p.status, ac.name AS account, ac.subtype
       FROM payments p JOIN accounts ac ON ac.id = p.account_id
      WHERE p.company_id = ? AND p.contact_id = ? AND p.direction IN (${[...(opts.customer ? ["'in'"] : []), ...(opts.supplier ? ["'out'"] : [])].join(",") || "''"})${range(opts.from, opts.to, "p.payment_date").sql}${branchFilter(c, "p.branch_id").sql}
      ORDER BY p.payment_date DESC LIMIT 200`, cid, contactId, ...range(opts.from, opts.to, "p.payment_date").params, ...branchFilter(c, "p.branch_id").params);

  return {
    sales: opts.customer ? await side("invoice", "credit_note") : null,
    purchases: opts.supplier ? await side("bill", "debit_note") : null,
    payments,
    can: { cost: seeCost },
  };
}
