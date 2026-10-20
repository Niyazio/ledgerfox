import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { all, batch, first, stmt } from "../lib/db";
import { badRequest, conflict, notFound, unprocessable } from "../lib/errors";
import { body, isoDate, shortText, optId, minor } from "../lib/validate";
import { newId, sha256Hex } from "../lib/crypto";
import { audit, requirePerm } from "../lib/auth";
import { parseCsv, parseBankDate } from "@shared/csv";
import { currencyExponent } from "@shared/currencies";
import { buildJournal, assertOpenPeriod } from "../services/ledger";

const banking = new Hono<AppEnv>();

async function bankAccount(db: D1Database, companyId: string, id: string) {
  const a = await first<{ id: string; name: string; subtype: string; is_group: number }>(db, `SELECT id, name, subtype, is_group FROM accounts WHERE id = ? AND company_id = ?`, id, companyId);
  if (!a || a.is_group || !["bank", "cash"].includes(a.subtype)) throw badRequest("Choose a bank or cash account");
  return a;
}

banking.get("/accounts", async (c) => {
  const company = c.get("company");
  const rows = await all(c.env.DB,
    `SELECT a.id, a.code, a.name, a.subtype,
       (SELECT COALESCE(SUM(l.debit - l.credit),0) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE l.account_id = a.id AND e.status = 'posted') AS book_balance,
       (SELECT COUNT(*) FROM bank_statement_lines s WHERE s.account_id = a.id AND s.status = 'unmatched') AS unmatched,
       (SELECT MAX(statement_date) FROM bank_reconciliations r WHERE r.account_id = a.id) AS last_reconciled
     FROM accounts a WHERE a.company_id = ? AND a.subtype IN ('bank','cash') AND a.is_group = 0 AND a.is_active = 1 ORDER BY a.code`, company.id);
  return c.json({ accounts: rows });
});

const importSchema = z.object({
  account_id: z.string(),
  filename: shortText(200).nullish(),
  csv: z.string().min(1).max(2_000_000),
  has_header: z.boolean().default(true),
  date_format: z.enum(["DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD", "DD-MMM-YYYY"]),
  columns: z.object({
    date: z.number().int().min(0),
    description: z.number().int().min(0),
    reference: z.number().int().min(0).nullish(),
    amount: z.number().int().min(0).nullish(),       // signed single column
    debit: z.number().int().min(0).nullish(),        // withdrawals
    credit: z.number().int().min(0).nullish(),       // deposits
    balance: z.number().int().min(0).nullish(),
  }),
  preview: z.boolean().default(false),
});

/** Import a CSV bank statement. Duplicate rows (same date/amount/description/reference occurrence) are skipped. */
banking.post("/import", async (c) => {
  requirePerm(c, "bank.reconcile");
  const input = await body(c, importSchema);
  const company = c.get("company");
  await bankAccount(c.env.DB, company.id, input.account_id);
  const exp = currencyExponent(company.base_currency);
  const rows = parseCsv(input.csv);
  const data = input.has_header ? rows.slice(1) : rows;
  if (data.length > 2000) throw badRequest("Import at most 2,000 rows at a time");
  const col = input.columns;
  if (col.amount == null && (col.debit == null || col.credit == null)) throw badRequest("Map either an amount column or both debit and credit columns");
  const parsed: { txn_date: string; description: string; reference: string | null; amount: number; balance: number | null; hash: string }[] = [];
  const errors: { row: number; error: string }[] = [];
  const occurrences = new Map<string, number>();
  const clean = (v: string | undefined) => (v ?? "").trim().replace(/[₹$€£,\s]/g, "").replace(/^\((.*)\)$/, "-$1").replace(/(CR|Cr)$/, "").replace(/(DR|Dr)$/, "");
  for (const [i, r] of data.entries()) {
    const rowNo = i + (input.has_header ? 2 : 1);
    try {
      const date = parseBankDate(r[col.date] ?? "", input.date_format);
      if (!date) throw new Error(`Unrecognised date "${r[col.date] ?? ""}"`);
      let amount: number;
      if (col.amount != null) amount = minor(clean(r[col.amount]) || "0", exp);
      else {
        const dr = clean(r[col.debit!]); const cr = clean(r[col.credit!]);
        amount = (cr ? minor(cr, exp) : 0) - (dr ? minor(dr, exp) : 0);
      }
      if (amount === 0) continue;
      const description = (r[col.description] ?? "").trim().slice(0, 500) || "(no description)";
      const reference = col.reference != null ? (r[col.reference] ?? "").trim().slice(0, 100) || null : null;
      const balance = col.balance != null && clean(r[col.balance]) ? minor(clean(r[col.balance]), exp) : null;
      const key = `${date}|${amount}|${description.toLowerCase()}|${reference ?? ""}`;
      const n = (occurrences.get(key) ?? 0) + 1;
      occurrences.set(key, n);
      parsed.push({ txn_date: date, description, reference, amount, balance, hash: await sha256Hex(`${key}|${n}`) });
    } catch (e) {
      errors.push({ row: rowNo, error: (e as Error).message });
    }
  }
  if (input.preview) return c.json({ rows: parsed.slice(0, 50), total: parsed.length, errors: errors.slice(0, 50) });
  if (errors.length) throw unprocessable("IMPORT_ERRORS", `${errors.length} row(s) could not be read`, errors.slice(0, 50));
  const existing = new Set((await all<{ dedupe_hash: string }>(c.env.DB,
    `SELECT dedupe_hash FROM bank_statement_lines WHERE company_id = ? AND account_id = ?`, company.id, input.account_id)).map((r) => r.dedupe_hash));
  const fresh = parsed.filter((p) => !existing.has(p.hash));
  const importId = newId();
  const stmts: D1PreparedStatement[] = [
    stmt(c.env.DB, `INSERT INTO bank_imports (id, company_id, account_id, filename, row_count, imported_count, duplicate_count, created_by) VALUES (?,?,?,?,?,?,?,?)`,
      importId, company.id, input.account_id, input.filename ?? null, parsed.length, fresh.length, parsed.length - fresh.length, c.get("user").id),
  ];
  for (const p of fresh) {
    stmts.push(stmt(c.env.DB,
      `INSERT OR IGNORE INTO bank_statement_lines (id, company_id, account_id, import_id, txn_date, description, reference, amount, running_balance, dedupe_hash) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      newId(), company.id, input.account_id, importId, p.txn_date, p.description, p.reference, p.amount, p.balance, p.hash));
  }
  stmts.push(audit(c, "bank.import", "bank_import", importId, { rows: parsed.length, imported: fresh.length }));
  await batch(c.env.DB, stmts);
  return c.json({ import_id: importId, imported: fresh.length, duplicates: parsed.length - fresh.length }, 201);
});

banking.get("/lines", async (c) => {
  const company = c.get("company");
  const accountId = c.req.query("account_id");
  if (!accountId) throw badRequest("account_id is required");
  const status = c.req.query("status");
  const rows = await all(c.env.DB,
    `SELECT s.*, e.entry_number, e.id AS entry_id, e.memo AS entry_memo FROM bank_statement_lines s
     LEFT JOIN journal_lines l ON l.id = s.matched_line_id LEFT JOIN journal_entries e ON e.id = l.entry_id
     WHERE s.company_id = ? AND s.account_id = ? ${status ? "AND s.status = ?" : ""} ORDER BY s.txn_date DESC, s.created_at LIMIT 500`,
    ...(status ? [company.id, accountId, status] : [company.id, accountId]));
  return c.json({ lines: rows });
});

/** Rule-based match suggestions: same amount and direction, within ±10 days, not yet matched. */
banking.get("/lines/:id/suggestions", async (c) => {
  const company = c.get("company");
  const s = await first<{ account_id: string; amount: number; txn_date: string; description: string; reference: string | null }>(
    c.env.DB, `SELECT * FROM bank_statement_lines WHERE id = ? AND company_id = ?`, c.req.param("id"), company.id);
  if (!s) throw notFound("Statement line");
  const debit = s.amount > 0 ? s.amount : 0;
  const credit = s.amount < 0 ? -s.amount : 0;
  const cands = await all<{ line_id: string; entry_id: string; entry_number: string; entry_date: string; memo: string | null; reference: string | null; contact_name: string | null; debit: number; credit: number }>(c.env.DB,
    `SELECT l.id AS line_id, e.id AS entry_id, e.entry_number, e.entry_date, e.memo, e.reference, ct.name AS contact_name, l.debit, l.credit
     FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id LEFT JOIN contacts ct ON ct.id = l.contact_id
     WHERE e.company_id = ? AND e.status = 'posted' AND l.account_id = ? AND l.debit = ? AND l.credit = ?
       AND e.entry_date BETWEEN date(?, '-10 days') AND date(?, '+10 days')
       AND NOT EXISTS (SELECT 1 FROM bank_statement_lines b WHERE b.matched_line_id = l.id)
     LIMIT 20`, company.id, s.account_id, debit, credit, s.txn_date, s.txn_date);
  const words = new Set(`${s.description} ${s.reference ?? ""}`.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3));
  const scored = cands.map((k) => {
    const days = Math.abs((Date.parse(k.entry_date) - Date.parse(s.txn_date)) / 86400000);
    const text = `${k.memo ?? ""} ${k.reference ?? ""} ${k.contact_name ?? ""}`.toLowerCase();
    const overlap = [...words].filter((w) => text.includes(w)).length;
    const score = Math.max(0, 100 - days * 8) + overlap * 15;
    return { ...k, score, reason: `Same amount; ${days === 0 ? "same day" : `${days} day(s) apart`}${overlap ? `; ${overlap} matching word(s)` : ""}` };
  }).sort((a, b) => b.score - a.score);
  return c.json({ suggestions: scored.slice(0, 5) });
});

banking.post("/lines/:id/match", async (c) => {
  requirePerm(c, "bank.reconcile");
  const input = await body(c, z.object({ journal_line_id: z.string() }));
  const company = c.get("company");
  const s = await first<{ account_id: string; amount: number; status: string }>(c.env.DB, `SELECT * FROM bank_statement_lines WHERE id = ? AND company_id = ?`, c.req.param("id"), company.id);
  if (!s) throw notFound("Statement line");
  if (s.status === "matched") throw conflict("ALREADY_MATCHED", "Line is already matched");
  const l = await first<{ account_id: string; debit: number; credit: number; status: string }>(c.env.DB,
    `SELECT l.account_id, l.debit, l.credit, e.status FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE l.id = ? AND l.company_id = ?`, input.journal_line_id, company.id);
  if (!l || l.status !== "posted") throw badRequest("Journal line not found or not posted");
  if (l.account_id !== s.account_id) throw badRequest("The journal line is on a different account");
  if (l.debit - l.credit !== s.amount) throw unprocessable("AMOUNT_MISMATCH", "Amounts must match exactly");
  await batch(c.env.DB, [
    stmt(c.env.DB, `UPDATE bank_statement_lines SET status = 'matched', matched_line_id = ? WHERE id = ? AND company_id = ? AND status <> 'matched'`, input.journal_line_id, c.req.param("id"), company.id),
    audit(c, "bank.match", "bank_line", c.req.param("id"), input),
  ]);
  return c.json({ ok: true });
});

banking.post("/lines/:id/:action{unmatch|ignore|restore}", async (c) => {
  requirePerm(c, "bank.reconcile");
  const company = c.get("company");
  const action = c.req.param("action");
  const s = await first<{ reconciliation_id: string | null }>(c.env.DB, `SELECT reconciliation_id FROM bank_statement_lines WHERE id = ? AND company_id = ?`, c.req.param("id"), company.id);
  if (!s) throw notFound("Statement line");
  if (s.reconciliation_id) throw conflict("RECONCILED", "This line is part of a completed reconciliation");
  const status = action === "ignore" ? "ignored" : "unmatched";
  await batch(c.env.DB, [
    stmt(c.env.DB, `UPDATE bank_statement_lines SET status = ?, matched_line_id = NULL WHERE id = ? AND company_id = ?`, status, c.req.param("id"), company.id),
    audit(c, `bank.${action}`, "bank_line", c.req.param("id")),
  ]);
  return c.json({ ok: true });
});

/** Create and post a journal for an unrecorded bank transaction (e.g. bank charges, interest) and match it. */
banking.post("/lines/:id/create-entry", async (c) => {
  requirePerm(c, "txn.post");
  requirePerm(c, "bank.reconcile");
  const input = await body(c, z.object({ account_id: z.string(), contact_id: optId, memo: shortText(300).nullish() }));
  const company = c.get("company");
  const s = await first<{ id: string; account_id: string; amount: number; status: string; txn_date: string; description: string }>(
    c.env.DB, `SELECT * FROM bank_statement_lines WHERE id = ? AND company_id = ?`, c.req.param("id"), company.id);
  if (!s) throw notFound("Statement line");
  if (s.status !== "unmatched") throw conflict("ALREADY_MATCHED", "Line is not unmatched");
  const counter = await first<{ is_group: number }>(c.env.DB, `SELECT is_group FROM accounts WHERE id = ? AND company_id = ?`, input.account_id, company.id);
  if (!counter || counter.is_group) throw badRequest("Choose a valid account");
  await assertOpenPeriod(c.env.DB, company.id, s.txn_date);
  const amt = Math.abs(s.amount);
  const bankLineFirst = s.amount > 0
    ? [{ account_id: s.account_id, debit: amt, description: s.description }, { account_id: input.account_id, credit: amt, contact_id: input.contact_id ?? null }]
    : [{ account_id: s.account_id, credit: amt, description: s.description }, { account_id: input.account_id, debit: amt, contact_id: input.contact_id ?? null }];
  const built = buildJournal(c.env.DB, {
    company_id: company.id, entry_date: s.txn_date, kind: "manual", memo: input.memo ?? s.description, source_type: "bank_line", source_id: s.id,
    created_by: c.get("user").id, post: true, lines: bankLineFirst,
  });
  await batch(c.env.DB, [
    ...built.stmts,
    stmt(c.env.DB, `UPDATE bank_statement_lines SET status = 'matched', matched_line_id = (SELECT id FROM journal_lines WHERE entry_id = ? AND line_no = 1) WHERE id = ? AND company_id = ?`, built.id, s.id, company.id),
    audit(c, "bank.create_entry", "bank_line", s.id, { journal_id: built.id }),
  ]);
  return c.json({ journal_id: built.id }, 201);
});

async function reconciliationState(db: D1Database, companyId: string, accountId: string, date: string) {
  const book = await first<{ b: number }>(db,
    `SELECT COALESCE(SUM(l.debit - l.credit),0) AS b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE e.company_id = ? AND e.status = 'posted' AND l.account_id = ? AND e.entry_date <= ?`, companyId, accountId, date);
  // Reconciliation starts at the earliest imported statement line; earlier book entries are treated as cleared.
  const start = await first<{ d: string | null }>(db, `SELECT MIN(txn_date) AS d FROM bank_statement_lines WHERE company_id = ? AND account_id = ?`, companyId, accountId);
  const uncleared = start?.d ? await all<{ line_id: string; entry_number: string; entry_date: string; memo: string | null; amount: number }>(db,
    `SELECT l.id AS line_id, e.entry_number, e.entry_date, e.memo, (l.debit - l.credit) AS amount FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE e.company_id = ? AND e.status = 'posted' AND l.account_id = ? AND e.entry_date BETWEEN ? AND ?
       AND NOT EXISTS (SELECT 1 FROM bank_statement_lines b WHERE b.matched_line_id = l.id)
     ORDER BY e.entry_date LIMIT 500`, companyId, accountId, start.d, date) : [];
  const unmatchedStatement = await all<{ id: string; txn_date: string; description: string; amount: number }>(db,
    `SELECT id, txn_date, description, amount FROM bank_statement_lines WHERE company_id = ? AND account_id = ? AND status = 'unmatched' AND txn_date <= ? ORDER BY txn_date LIMIT 500`,
    companyId, accountId, date);
  const unclearedTotal = uncleared.reduce((t, u) => t + u.amount, 0);
  return { book_balance: book?.b ?? 0, uncleared, uncleared_total: unclearedTotal, cleared_balance: (book?.b ?? 0) - unclearedTotal, unmatched_statement: unmatchedStatement, start_date: start?.d ?? null };
}

banking.get("/reconcile", async (c) => {
  const company = c.get("company");
  const accountId = c.req.query("account_id") ?? "";
  await bankAccount(c.env.DB, company.id, accountId);
  const date = c.req.query("date") ?? new Date().toISOString().slice(0, 10);
  const state = await reconciliationState(c.env.DB, company.id, accountId, date);
  const history = await all(c.env.DB,
    `SELECT r.*, u.name AS completed_by_name FROM bank_reconciliations r LEFT JOIN users u ON u.id = r.completed_by WHERE r.company_id = ? AND r.account_id = ? ORDER BY r.statement_date DESC LIMIT 50`,
    company.id, accountId);
  return c.json({ ...state, history });
});

banking.post("/reconcile", async (c) => {
  requirePerm(c, "bank.reconcile");
  const input = await body(c, z.object({ account_id: z.string(), statement_date: isoDate, statement_balance: z.union([z.string(), z.number()]) }));
  const company = c.get("company");
  await bankAccount(c.env.DB, company.id, input.account_id);
  const statementBalance = minor(input.statement_balance, currencyExponent(company.base_currency), "statement balance");
  const state = await reconciliationState(c.env.DB, company.id, input.account_id, input.statement_date);
  const difference = statementBalance - state.cleared_balance;
  if (difference !== 0) {
    throw unprocessable("NOT_RECONCILED", "Statement balance does not equal the cleared book balance. Match or record the remaining items first.", { difference, cleared_balance: state.cleared_balance });
  }
  const last = await first<{ statement_date: string }>(c.env.DB, `SELECT MAX(statement_date) AS statement_date FROM bank_reconciliations WHERE company_id = ? AND account_id = ?`, company.id, input.account_id);
  if (last?.statement_date && input.statement_date <= last.statement_date) throw conflict("OUT_OF_ORDER", `Already reconciled through ${last.statement_date}`);
  const id = newId();
  await batch(c.env.DB, [
    stmt(c.env.DB, `INSERT INTO bank_reconciliations (id, company_id, account_id, statement_date, statement_balance, cleared_balance, book_balance, difference, completed_by) VALUES (?,?,?,?,?,?,?,?,?)`,
      id, company.id, input.account_id, input.statement_date, statementBalance, state.cleared_balance, state.book_balance, 0, c.get("user").id),
    stmt(c.env.DB, `UPDATE bank_statement_lines SET reconciliation_id = ? WHERE company_id = ? AND account_id = ? AND status IN ('matched','ignored') AND txn_date <= ? AND reconciliation_id IS NULL`,
      id, company.id, input.account_id, input.statement_date),
    audit(c, "bank.reconcile", "bank_reconciliation", id, { statement_date: input.statement_date, statement_balance: statementBalance }),
  ]);
  return c.json({ id }, 201);
});

export default banking;
