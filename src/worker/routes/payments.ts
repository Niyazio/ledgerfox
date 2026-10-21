import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { all, first, todayIso } from "../lib/db";
import { notFound } from "../lib/errors";
import { body, isoDate, shortText, minor, rate, pageParams } from "../lib/validate";
import { requirePerm, hasPerm, resolveBranch, assertBranchVisible, branchFilter } from "../lib/auth";
import type { Context } from "hono";
import type { Permission } from "@shared/permissions";
import { currencyExponent } from "@shared/currencies";
import { recordPayment, voidPayment, applyCredit } from "../services/payments";

const payments = new Hono<AppEnv>();

/** Receipts belong to sales, supplier payments to purchases. */
const payPerm = (direction: string, action: "view" | "post" | "void") => `${direction === "in" ? "sales" : "purchase"}.${action}` as Permission;

async function access(c: Context<AppEnv>, id: string, action: "view" | "post" | "void") {
  const p = await first<{ direction: string; branch_id: string | null; currency: string }>(c.env.DB, `SELECT direction, branch_id, currency FROM payments WHERE id = ? AND company_id = ?`, id, c.get("company").id);
  if (!p) throw notFound("Payment");
  assertBranchVisible(c, p.branch_id);
  requirePerm(c, payPerm(p.direction, action));
  return p;
}

payments.get("/", async (c) => {
  const company = c.get("company");
  const { limit, offset } = pageParams(c);
  const direction = c.req.query("direction");
  const where = ["p.company_id = ?"];
  const params: (string | number)[] = [company.id];
  if (direction === "in" || direction === "out") { requirePerm(c, payPerm(direction, "view")); where.push("p.direction = ?"); params.push(direction); }
  else {
    const dirs = ["in", "out"].filter((d) => hasPerm(c, payPerm(d, "view")));
    if (!dirs.length) requirePerm(c, "sales.view");
    where.push(`p.direction IN (${dirs.map(() => "?").join(",")})`); params.push(...dirs);
  }
  const bf = branchFilter(c, "p.branch_id");
  if (bf.sql) { where.push(bf.sql.replace(/^ AND /, "")); params.push(...bf.params); }
  const contactId = c.req.query("contact_id");
  if (contactId) { where.push("p.contact_id = ?"); params.push(contactId); }
  const rows = await all(c.env.DB,
    `SELECT p.*, ct.name AS contact_name, a.name AS account_name,
       (SELECT COALESCE(SUM(amount),0) FROM allocations WHERE payment_id = p.id) AS allocated
     FROM payments p JOIN contacts ct ON ct.id = p.contact_id JOIN accounts a ON a.id = p.account_id
     WHERE ${where.join(" AND ")} ORDER BY p.payment_date DESC, p.created_at DESC LIMIT ? OFFSET ?`, ...params, limit, offset);
  const total = await first<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM payments p WHERE ${where.join(" AND ")}`, ...params);
  return c.json({ payments: rows, total: total?.n ?? 0 });
});

payments.get("/:id", async (c) => {
  await access(c, c.req.param("id"), "view");
  const company = c.get("company");
  const p = await first(c.env.DB,
    `SELECT p.*, ct.name AS contact_name, a.name AS account_name, je.entry_number AS journal_number
     FROM payments p JOIN contacts ct ON ct.id = p.contact_id JOIN accounts a ON a.id = p.account_id LEFT JOIN journal_entries je ON je.id = p.journal_entry_id
     WHERE p.id = ? AND p.company_id = ?`, c.req.param("id"), company.id);
  if (!p) throw notFound("Payment");
  const allocations = await all(c.env.DB,
    `SELECT a.*, d.number, d.doc_type FROM allocations a JOIN documents d ON d.id = a.document_id WHERE a.payment_id = ? ORDER BY a.created_at`, c.req.param("id"));
  return c.json({ payment: p, allocations });
});

const paySchema = z.object({
  direction: z.enum(["in", "out"]),
  contact_id: z.string(),
  payment_date: isoDate,
  account_id: z.string(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullish(),
  fx_rate: z.union([z.string(), z.number()]).nullish(),
  amount: z.union([z.string(), z.number()]),
  method: z.enum(["cash", "bank_transfer", "upi", "cheque", "card", "other"]).nullish(),
  reference: shortText(100).nullish(),
  notes: shortText(1000).nullish(),
  idempotency_key: z.string().min(8).max(100).nullish(),
  allocations: z.array(z.object({ document_id: z.string(), amount: z.union([z.string(), z.number()]) })).max(100).default([]),
  branch_id: z.string().nullish(),
});

payments.post("/", async (c) => {
  const input = await body(c, paySchema);
  requirePerm(c, payPerm(input.direction, "post"));
  const company = c.get("company");
  let currency = input.currency ?? null;
  if (!currency) {
    const ct = await first<{ currency: string | null }>(c.env.DB, `SELECT currency FROM contacts WHERE id = ? AND company_id = ?`, input.contact_id, company.id);
    currency = ct?.currency ?? company.base_currency;
  }
  const exp = currencyExponent(currency);
  const result = await recordPayment(c, {
    direction: input.direction, contact_id: input.contact_id, payment_date: input.payment_date, account_id: input.account_id, currency,
    fx_rate_scaled: input.fx_rate ? rate(input.fx_rate) : null, amount: minor(input.amount, exp), method: input.method, reference: input.reference,
    notes: input.notes, idempotency_key: input.idempotency_key, branch_id: resolveBranch(c, input.branch_id),
    allocations: input.allocations.filter((a) => a.amount !== "" && a.amount !== 0 && a.amount !== "0").map((a) => ({ document_id: a.document_id, amount: minor(a.amount, exp, "allocation") })),
  });
  return c.json(result, result.duplicate ? 200 : 201);
});

payments.post("/:id/apply", async (c) => {
  const p = await access(c, c.req.param("id"), "post");
  const input = await body(c, z.object({ document_id: z.string(), amount: z.union([z.string(), z.number()]), date: isoDate.optional() }));
  await applyCredit(c, { kind: "payment", id: c.req.param("id") }, input.document_id, minor(input.amount, currencyExponent(p.currency)), input.date ?? todayIso());
  return c.json({ ok: true });
});

payments.post("/:id/void", async (c) => {
  await access(c, c.req.param("id"), "void");
  const input = await body(c, z.object({ date: isoDate.optional(), reason: shortText(300).nullish() }));
  await voidPayment(c, c.req.param("id"), input.date ?? todayIso(), input.reason);
  return c.json({ ok: true });
});

export default payments;
