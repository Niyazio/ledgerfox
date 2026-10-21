import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { all, batch, first, stmt, todayIso } from "../lib/db";
import { conflict, notFound, unprocessable } from "../lib/errors";
import { body, isoDate, shortText, optId, minor, rate, pageParams } from "../lib/validate";
import { assertBranchVisible, audit, changes, branchFilter, requireAnyPerm, requirePerm, resolveBranch } from "../lib/auth";
import { buildJournal, buildReversal, postDraft, lineStmt, assertBalanced, normaliseLines, systemAccount, type LineInput } from "../services/ledger";
import { currencyExponent, isCurrency } from "@shared/currencies";
import { convertToBase } from "@shared/money";

const journals = new Hono<AppEnv>();
journals.use("*", async (c, next) => { if (c.req.method === "GET") requireAnyPerm(c, "journal.view"); await next(); });

const lineSchema = z.object({
  account_id: z.string().min(1),
  debit: z.union([z.string(), z.number()]).nullish(),
  credit: z.union([z.string(), z.number()]).nullish(),
  description: shortText(300).nullish(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullish(),
  fx_rate: z.union([z.string(), z.number()]).nullish(),
  contact_id: optId,
  department_id: optId,
  project_id: optId,
  cost_centre_id: optId,
  branch_id: optId,
});

const journalSchema = z.object({
  entry_date: isoDate,
  memo: shortText(500).nullish(),
  reference: shortText(100).nullish(),
  kind: z.enum(["manual", "adjustment", "opening"]).default("manual"),
  branch_id: optId,
  post: z.boolean().default(false),
  idempotency_key: z.string().min(8).max(100).nullish(),
  lines: z.array(lineSchema).min(2).max(200),
});

/**
 * Convert API lines to ledger lines. Amounts are entered in the line currency (default: base);
 * foreign-currency lines are converted at the given rate, and the original amount is retained.
 */
function toLedgerLines(lines: z.infer<typeof lineSchema>[], base: string): LineInput[] {
  const baseExp = currencyExponent(base);
  return lines.map((l, i) => {
    const cur = l.currency && l.currency !== base ? l.currency : null;
    if (cur && !isCurrency(cur)) throw unprocessable("INVALID_CURRENCY", `Line ${i + 1}: unsupported currency`);
    const exp = cur ? currencyExponent(cur) : baseExp;
    const d = l.debit != null && l.debit !== "" ? minor(l.debit, exp, `Line ${i + 1} debit`) : 0;
    const cr = l.credit != null && l.credit !== "" ? minor(l.credit, exp, `Line ${i + 1} credit`) : 0;
    if (d < 0 || cr < 0) throw unprocessable("INVALID_AMOUNT", `Line ${i + 1}: amounts cannot be negative`);
    if (!cur) return { ...l, currency: null, debit: d, credit: cr };
    const r = rate(l.fx_rate, `Line ${i + 1} exchange rate`);
    const amountFc = d || cr;
    const baseAmt = convertToBase(amountFc, r, exp, baseExp);
    return {
      ...l, currency: cur, fx_rate_scaled: r, amount_fc: amountFc,
      debit: d ? baseAmt : 0, credit: cr ? baseAmt : 0,
    };
  });
}

async function checkLineRefs(db: D1Database, companyId: string, lines: LineInput[]) {
  // Validate every referenced id belongs to this company (FKs also enforce this; this gives clearer errors).
  const ids = [...new Set(lines.map((l) => l.account_id))];
  const found = await all<{ id: string }>(db, `SELECT id FROM accounts WHERE company_id = ? AND id IN (${ids.map(() => "?").join(",")})`, companyId, ...ids);
  if (found.length !== ids.length) throw unprocessable("INVALID_ACCOUNT", "One or more accounts do not exist in this company");
}

/** 404 when the entry does not exist or belongs to a branch the member cannot see. */
async function visibleEntry(c: Context<AppEnv>, id: string) {
  const e = await first<{ status: string; source_type: string | null; branch_id: string | null }>(c.env.DB, `SELECT status, source_type, branch_id FROM journal_entries WHERE id = ? AND company_id = ?`, id, c.get("company").id);
  if (!e) throw notFound("Journal entry");
  assertBranchVisible(c, e.branch_id);
  return e;
}

journals.get("/", async (c) => {
  const company = c.get("company");
  const { limit, offset } = pageParams(c);
  const status = c.req.query("status");
  const q = c.req.query("q");
  const from = c.req.query("from");
  const to = c.req.query("to");
  const where = ["e.company_id = ?"];
  const params: (string | number)[] = [company.id];
  if (status === "draft" || status === "posted") { where.push("e.status = ?"); params.push(status); }
  if (from) { where.push("e.entry_date >= ?"); params.push(from); }
  if (to) { where.push("e.entry_date <= ?"); params.push(to); }
  if (q) { where.push("(e.entry_number LIKE ? OR e.memo LIKE ? OR e.reference LIKE ?)"); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const bf = branchFilter(c, "e.branch_id");
  if (bf.sql) { where.push(bf.sql.replace(/^ AND /, "")); params.push(...bf.params); }
  const rows = await all(
    c.env.DB,
    `SELECT e.id, e.entry_number, e.entry_date, e.status, e.kind, e.memo, e.reference, e.total, e.source_type, e.source_id,
            e.reversal_of_id, e.reversed_by_id, e.created_at, u.name AS created_by_name
     FROM journal_entries e LEFT JOIN users u ON u.id = e.created_by
     WHERE ${where.join(" AND ")} ORDER BY e.entry_date DESC, e.created_at DESC LIMIT ? OFFSET ?`,
    ...params, limit, offset,
  );
  const total = await first<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM journal_entries e WHERE ${where.join(" AND ")}`, ...params);
  return c.json({ entries: rows, total: total?.n ?? 0 });
});

journals.get("/:id", async (c) => {
  const company = c.get("company");
  const entry = await first(
    c.env.DB,
    `SELECT e.*, cu.name AS created_by_name, pu.name AS posted_by_name FROM journal_entries e
     LEFT JOIN users cu ON cu.id = e.created_by LEFT JOIN users pu ON pu.id = e.posted_by
     WHERE e.id = ? AND e.company_id = ?`,
    c.req.param("id"), company.id,
  );
  if (!entry) throw notFound("Journal entry");
  assertBranchVisible(c, (entry as { branch_id?: string | null }).branch_id);
  const lines = await all(
    c.env.DB,
    `SELECT l.*, a.code AS account_code, a.name AS account_name, ct.name AS contact_name,
            d.name AS department_name, p.name AS project_name, cc.name AS cost_centre_name
     FROM journal_lines l JOIN accounts a ON a.id = l.account_id
     LEFT JOIN contacts ct ON ct.id = l.contact_id LEFT JOIN departments d ON d.id = l.department_id
     LEFT JOIN projects p ON p.id = l.project_id LEFT JOIN cost_centres cc ON cc.id = l.cost_centre_id
     WHERE l.entry_id = ? AND l.company_id = ? ORDER BY l.line_no`,
    c.req.param("id"), company.id,
  );
  return c.json({ entry, lines });
});

journals.post("/", async (c) => {
  requirePerm(c, "journal.create");
  const input = await body(c, journalSchema);
  if (input.post) requirePerm(c, "journal.post");
  const company = c.get("company");
  const user = c.get("user");
  if (input.idempotency_key) {
    const dup = await first<{ id: string }>(c.env.DB, `SELECT id FROM journal_entries WHERE company_id = ? AND idempotency_key = ?`, company.id, input.idempotency_key);
    if (dup) return c.json({ id: dup.id, duplicate: true }, 200);
  }
  const lines = toLedgerLines(input.lines, company.base_currency);
  await checkLineRefs(c.env.DB, company.id, normaliseLines(lines));
  const built = buildJournal(c.env.DB, {
    company_id: company.id, entry_date: input.entry_date, kind: input.kind, memo: input.memo, reference: input.reference,
    branch_id: resolveBranch(c, input.branch_id), idempotency_key: input.idempotency_key, created_by: user.id, lines, post: input.post,
  });
  await batch(c.env.DB, [...built.stmts, audit(c, input.post ? "journal.create_post" : "journal.create", "journal", built.id, { total: built.total, kind: input.kind })]);
  const row = await first<{ entry_number: string | null }>(c.env.DB, `SELECT entry_number FROM journal_entries WHERE id = ?`, built.id);
  return c.json({ id: built.id, entry_number: row?.entry_number ?? null }, 201);
});

journals.put("/:id", async (c) => {
  requirePerm(c, "journal.create");
  const input = await body(c, journalSchema.omit({ post: true, idempotency_key: true }));
  const company = c.get("company");
  const id = c.req.param("id");
  const e = await visibleEntry(c, id);
  if (e.status !== "draft") throw conflict("POSTED_IMMUTABLE", "Posted entries cannot be edited; reverse and re-enter instead");
  const lines = normaliseLines(toLedgerLines(input.lines, company.base_currency));
  await checkLineRefs(c.env.DB, company.id, lines);
  const total = lines.reduce((s, l) => s + (l.debit ?? 0), 0);
  const before = await first<Record<string, unknown>>(c.env.DB, `SELECT entry_date, memo, reference, total FROM journal_entries WHERE id = ?`, id);
  await batch(c.env.DB, [
    stmt(c.env.DB, `DELETE FROM journal_lines WHERE entry_id = ? AND company_id = ?`, id, company.id),
    stmt(c.env.DB, `UPDATE journal_entries SET entry_date = ?, memo = ?, reference = ?, kind = ?, branch_id = ?, total = ? WHERE id = ? AND company_id = ? AND status = 'draft'`,
      input.entry_date, input.memo ?? null, input.reference ?? null, input.kind, resolveBranch(c, input.branch_id ?? e.branch_id), total, id, company.id),
    ...lines.map((l, i) => lineStmt(c.env.DB, company.id, id, i + 1, l)),
    audit(c, "journal.update", "journal", id, { total, changes: changes(before ?? {}, { entry_date: input.entry_date, memo: input.memo ?? null, reference: input.reference ?? null, total }) }),
  ]);
  return c.json({ ok: true });
});

journals.post("/:id/post", async (c) => {
  requirePerm(c, "journal.post");
  const company = c.get("company");
  const id = c.req.param("id");
  await visibleEntry(c, id);
  await postDraft(c.env.DB, company.id, id, c.get("user").id, [audit(c, "journal.post", "journal", id)]);
  const row = await first<{ entry_number: string }>(c.env.DB, `SELECT entry_number FROM journal_entries WHERE id = ?`, id);
  return c.json({ ok: true, entry_number: row?.entry_number });
});

journals.delete("/:id", async (c) => {
  requirePerm(c, "journal.create");
  const company = c.get("company");
  const id = c.req.param("id");
  const e = await visibleEntry(c, id);
  if (e.status !== "draft") throw conflict("POSTED_IMMUTABLE", "Posted entries cannot be deleted; reverse them instead");
  await batch(c.env.DB, [
    stmt(c.env.DB, `DELETE FROM journal_entries WHERE id = ? AND company_id = ? AND status = 'draft'`, id, company.id),
    audit(c, "journal.delete_draft", "journal", id),
  ]);
  return c.json({ ok: true });
});

journals.post("/:id/reverse", async (c) => {
  requirePerm(c, "journal.reverse");
  const input = await body(c, z.object({ date: isoDate.optional(), memo: shortText(500).nullish() }));
  const company = c.get("company");
  const id = c.req.param("id");
  await visibleEntry(c, id);
  const built = await buildReversal(c.env.DB, company.id, id, input.date ?? todayIso(), c.get("user").id, input.memo);
  await batch(c.env.DB, [...built.stmts, audit(c, "journal.reverse", "journal", id, { reversal_id: built.id })]);
  return c.json({ id: built.id }, 201);
});

/**
 * Opening balances: one opening entry per company. Any difference is posted to Opening Balance Equity
 * so the entry always balances.
 */
journals.post("/opening-balances", async (c) => {
  requirePerm(c, "journal.post");
  const input = await body(c, z.object({
    date: isoDate,
    lines: z.array(z.object({ account_id: z.string(), debit: z.union([z.string(), z.number()]).nullish(), credit: z.union([z.string(), z.number()]).nullish(), contact_id: optId })).min(1).max(300),
  }));
  const company = c.get("company");
  const existing = await first(c.env.DB, `SELECT id FROM journal_entries WHERE company_id = ? AND kind = 'opening' AND status = 'posted' AND reversed_by_id IS NULL`, company.id);
  if (existing) throw conflict("OPENING_EXISTS", "Opening balances are already posted. Reverse the existing opening entry to re-enter them.");
  const exp = currencyExponent(company.base_currency);
  const lines: LineInput[] = input.lines.map((l, i) => ({
    account_id: l.account_id, contact_id: l.contact_id ?? null,
    debit: l.debit ? minor(l.debit, exp, `Line ${i + 1} debit`) : 0,
    credit: l.credit ? minor(l.credit, exp, `Line ${i + 1} credit`) : 0,
    description: "Opening balance",
  }));
  const dr = lines.reduce((s, l) => s + (l.debit ?? 0), 0);
  const cr = lines.reduce((s, l) => s + (l.credit ?? 0), 0);
  if (dr !== cr) {
    const obe = await systemAccount(c.env.DB, company.id, "OPENING_EQUITY");
    lines.push({ account_id: obe, debit: dr < cr ? cr - dr : 0, credit: dr > cr ? dr - cr : 0, description: "Opening balance difference" });
  }
  await checkLineRefs(c.env.DB, company.id, normaliseLines(lines));
  assertBalanced(normaliseLines(lines));
  const built = buildJournal(c.env.DB, {
    company_id: company.id, entry_date: input.date, kind: "opening", memo: "Opening balances", created_by: c.get("user").id, lines, post: true,
    idempotency_key: `opening:${company.id}:${input.date}:${Date.now()}`,
  });
  await batch(c.env.DB, [...built.stmts, audit(c, "journal.opening_balances", "journal", built.id, { total: built.total })]);
  return c.json({ id: built.id }, 201);
});

export default journals;
