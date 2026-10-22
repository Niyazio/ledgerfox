/**
 * Double-entry ledger engine.
 *
 * Every posting is expressed as a list of D1 statements executed in ONE batch (one SQL transaction):
 *   1. insert header (draft)  2. insert lines  3. bump number sequence  4. flip status to 'posted'.
 * The status flip fires trg_je_post_validate in the database, which re-checks balance, period lock and
 * account validity — so invariants hold even if application code has a bug. Callers append their own
 * statements (document status, audit log) to the same batch so everything commits or nothing does.
 */
import { batch, bumpSequence, first, nowIso, run, seqNumberExpr, stmt, all } from "../lib/db";
import { newId } from "../lib/crypto";
import { conflict, unprocessable, notFound } from "../lib/errors";
import { sum } from "@shared/money";

export interface LineInput {
  account_id: string;
  debit?: number;
  credit?: number;
  description?: string | null;
  currency?: string | null;
  fx_rate_scaled?: number | null;
  amount_fc?: number | null;
  contact_id?: string | null;
  department_id?: string | null;
  project_id?: string | null;
  cost_centre_id?: string | null;
  branch_id?: string | null;
  tax_code_id?: string | null;
}

export interface JournalInput {
  company_id: string;
  entry_date: string;
  kind?: "manual" | "adjustment" | "opening" | "system" | "reversal" | "depreciation";
  memo?: string | null;
  reference?: string | null;
  source_type?: string | null;
  source_id?: string | null;
  reversal_of_id?: string | null;
  idempotency_key?: string | null;
  branch_id?: string | null;
  created_by: string;
  lines: LineInput[];
  post: boolean;
}

export interface BuiltJournal {
  id: string;
  stmts: D1PreparedStatement[];
  total: number;
}

/** Drop zero lines and validate shape; throws 422 with a precise message. */
export function normaliseLines(lines: LineInput[]): Required<Pick<LineInput, "account_id" | "debit" | "credit">>[] & LineInput[] {
  const out = lines
    .map((l) => ({ ...l, debit: l.debit ?? 0, credit: l.credit ?? 0 }))
    .filter((l) => l.debit !== 0 || l.credit !== 0);
  for (const [i, l] of out.entries()) {
    if (!Number.isSafeInteger(l.debit) || !Number.isSafeInteger(l.credit)) {
      throw unprocessable("INVALID_AMOUNT", `Line ${i + 1}: amounts must be integer minor units`);
    }
    if (l.debit < 0 || l.credit < 0) {
      throw unprocessable("INVALID_AMOUNT", `Line ${i + 1}: debit and credit cannot be negative`);
    }
    if (l.debit > 0 && l.credit > 0) {
      throw unprocessable("INVALID_AMOUNT", `Line ${i + 1}: a line cannot have both a debit and a credit`);
    }
    if (!l.account_id) throw unprocessable("INVALID_ACCOUNT", `Line ${i + 1}: account is required`);
  }
  return out as never;
}

export function assertBalanced(lines: { debit?: number; credit?: number }[]) {
  const dr = sum(lines.map((l) => l.debit ?? 0));
  const cr = sum(lines.map((l) => l.credit ?? 0));
  if (lines.length < 2) throw unprocessable("TOO_FEW_LINES", "A journal needs at least two non-zero lines");
  if (dr !== cr) {
    throw unprocessable("UNBALANCED", `Debits (${dr}) must equal credits (${cr})`, { debit: dr, credit: cr, difference: dr - cr });
  }
  if (dr === 0) throw unprocessable("ZERO_ENTRY", "Journal total cannot be zero");
  return dr;
}

export function buildJournal(db: D1Database, input: JournalInput): BuiltJournal {
  const lines = normaliseLines(input.lines);
  const total = input.post ? assertBalanced(lines) : sum(lines.map((l) => l.debit ?? 0));
  const id = newId();
  const stmts: D1PreparedStatement[] = [];
  stmts.push(
    stmt(
      db,
      `INSERT INTO journal_entries (id, company_id, entry_date, status, kind, memo, reference, source_type, source_id,
         reversal_of_id, idempotency_key, total, branch_id, created_by)
       VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      id, input.company_id, input.entry_date, input.kind ?? "manual", input.memo ?? null, input.reference ?? null,
      input.source_type ?? null, input.source_id ?? null, input.reversal_of_id ?? null, input.idempotency_key ?? null,
      input.branch_id ?? null, input.created_by,
    ),
  );
  // Lines inherit the entry's branch so branch reports (which read journal lines) include every posting.
  lines.forEach((l, i) => stmts.push(lineStmt(db, input.company_id, id, i + 1, { ...l, branch_id: (l as LineInput).branch_id ?? input.branch_id ?? null })));
  if (input.post) stmts.push(...postStatements(db, input.company_id, id, total, input.created_by));
  else stmts.push(stmt(db, `UPDATE journal_entries SET total = ? WHERE id = ?`, total, id));
  return { id, stmts, total };
}

export function lineStmt(db: D1Database, companyId: string, entryId: string, lineNo: number, l: LineInput): D1PreparedStatement {
  return stmt(
    db,
    `INSERT INTO journal_lines (id, entry_id, company_id, line_no, account_id, description, debit, credit, currency,
       fx_rate_scaled, amount_fc, contact_id, department_id, project_id, cost_centre_id, branch_id, tax_code_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    newId(), entryId, companyId, lineNo, l.account_id, l.description ?? null, l.debit ?? 0, l.credit ?? 0,
    l.currency ?? null, l.fx_rate_scaled ?? null, l.amount_fc ?? null, l.contact_id ?? null, l.department_id ?? null,
    l.project_id ?? null, l.cost_centre_id ?? null, l.branch_id ?? null, l.tax_code_id ?? null,
  );
}

/** Statements that number and post an existing draft entry. */
export function postStatements(db: D1Database, companyId: string, entryId: string, total: number, userId: string): D1PreparedStatement[] {
  return [
    ...bumpSequence(db, companyId, "JV", "JV-"),
    stmt(
      db,
      `UPDATE journal_entries SET status = 'posted', total = ?, posted_by = ?, posted_at = ?, entry_number = ${seqNumberExpr()}
       WHERE id = ? AND company_id = ?`,
      total, userId, nowIso(), companyId, "JV", entryId, companyId,
    ),
  ];
}

export async function postDraft(db: D1Database, companyId: string, entryId: string, userId: string, extra: D1PreparedStatement[] = []) {
  const entry = await first<{ status: string; source_type: string | null }>(
    db, `SELECT status, source_type FROM journal_entries WHERE id = ? AND company_id = ?`, entryId, companyId,
  );
  if (!entry) throw notFound("Journal entry");
  if (entry.status !== "draft") throw conflict("ALREADY_POSTED", "Journal entry is already posted");
  const lines = await all<{ debit: number; credit: number }>(db, `SELECT debit, credit FROM journal_lines WHERE entry_id = ?`, entryId);
  const total = assertBalanced(lines);
  await batch(db, [...postStatements(db, companyId, entryId, total, userId), ...extra]);
}

/**
 * Reverse a posted entry with an equal and opposite entry, linking both.
 * The unique index on reversal_of_id + the immutable-header trigger make double reversal impossible.
 */
export async function buildReversal(
  db: D1Database,
  companyId: string,
  entryId: string,
  date: string,
  userId: string,
  memo?: string | null,
  opts: { allowSourced?: boolean } = {},
): Promise<BuiltJournal> {
  const entry = await first<{ id: string; status: string; kind: string; entry_number: string; reversed_by_id: string | null; source_type: string | null; memo: string | null; entry_date: string; branch_id: string | null }>(
    db, `SELECT * FROM journal_entries WHERE id = ? AND company_id = ?`, entryId, companyId,
  );
  if (!entry) throw notFound("Journal entry");
  if (entry.status !== "posted") throw conflict("NOT_POSTED", "Only posted entries can be reversed; delete the draft instead");
  if (entry.reversed_by_id) throw conflict("ALREADY_REVERSED", "This entry has already been reversed");
  if (entry.kind === "reversal") throw conflict("CANNOT_REVERSE_REVERSAL", "A reversal entry cannot itself be reversed");
  if (entry.source_type && !opts.allowSourced) {
    throw conflict("SOURCE_MANAGED", `This entry was created by a ${entry.source_type.replace(/_/g, " ")}; void or cancel it from that document instead`);
  }
  if (date < entry.entry_date) throw unprocessable("INVALID_DATE", "Reversal date cannot be before the original entry date");
  const lines = await all<LineInput & { debit: number; credit: number }>(
    db, `SELECT * FROM journal_lines WHERE entry_id = ? ORDER BY line_no`, entryId,
  );
  const built = buildJournal(db, {
    company_id: companyId,
    entry_date: date,
    kind: "reversal",
    memo: memo ?? `Reversal of ${entry.entry_number}${entry.memo ? ` — ${entry.memo}` : ""}`,
    reference: entry.entry_number,
    source_type: entry.source_type,
    source_id: null,
    reversal_of_id: entry.id,
    branch_id: entry.branch_id,
    created_by: userId,
    post: true,
    lines: lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit })),
  });
  built.stmts.push(stmt(db, `UPDATE journal_entries SET reversed_by_id = ? WHERE id = ? AND company_id = ?`, built.id, entryId, companyId));
  return built;
}

export async function systemAccount(db: D1Database, companyId: string, key: string): Promise<string> {
  const row = await first<{ id: string }>(db, `SELECT id FROM accounts WHERE company_id = ? AND system_key = ?`, companyId, key);
  if (!row) throw unprocessable("MISSING_SYSTEM_ACCOUNT", `Required system account "${key}" is missing from the chart of accounts`);
  return row.id;
}

export async function systemAccounts(db: D1Database, companyId: string, keys: string[]): Promise<Record<string, string>> {
  const rows = await all<{ id: string; system_key: string }>(
    db, `SELECT id, system_key FROM accounts WHERE company_id = ? AND system_key IS NOT NULL`, companyId,
  );
  const map: Record<string, string> = {};
  for (const r of rows) map[r.system_key] = r.id;
  for (const k of keys) {
    if (!map[k]) throw unprocessable("MISSING_SYSTEM_ACCOUNT", `Required system account "${k}" is missing from the chart of accounts`);
  }
  return map;
}

/**
 * The account with a system key, created on first use for companies whose chart predates it. An existing account with
 * the suggested code (or the same name) and no key is adopted rather than duplicated.
 */
export async function ensureSystemAccount(db: D1Database, companyId: string, key: string,
  seed: { code: string; name: string; type: string; subtype: string; parentCode: string }): Promise<string> {
  const hit = await first<{ id: string }>(db, `SELECT id FROM accounts WHERE company_id = ? AND system_key = ?`, companyId, key);
  if (hit) return hit.id;
  const adopt = await first<{ id: string }>(db, `SELECT id FROM accounts WHERE company_id = ? AND system_key IS NULL AND is_group = 0 AND (code = ? OR lower(name) = lower(?)) ORDER BY code = ? DESC LIMIT 1`,
    companyId, seed.code, seed.name, seed.code);
  if (adopt) { await run(db, `UPDATE accounts SET system_key = ? WHERE id = ?`, key, adopt.id); return adopt.id; }
  const codes = new Set((await all<{ code: string }>(db, `SELECT code FROM accounts WHERE company_id = ?`, companyId)).map((r) => r.code));
  let code = seed.code;
  while (codes.has(code)) code = String(Number(code) + 1);
  const parent = await first<{ id: string }>(db, `SELECT id FROM accounts WHERE company_id = ? AND code = ?`, companyId, seed.parentCode);
  const id = newId();
  await run(db, `INSERT INTO accounts (id, company_id, code, name, type, subtype, parent_id, is_group, system_key) VALUES (?,?,?,?,?,?,?,0,?)`,
    id, companyId, code, seed.name, seed.type, seed.subtype, parent?.id ?? null, key);
  return id;
}

export const TDS_RECEIVABLE_SEED = { code: "1180", name: "TDS Receivable", type: "asset", subtype: "current_asset", parentCode: "1100" };
export const TDS_PAYABLE_SEED = { code: "2150", name: "TDS Payable", type: "liability", subtype: "current_liability", parentCode: "2100" };
export const RCM_PAYABLE_SEED = { code: "2165", name: "GST Payable (Reverse Charge)", type: "liability", subtype: "current_liability", parentCode: "2100" };

/** Ensure an account belongs to the company, is postable and active. */
export async function assertPostable(db: D1Database, companyId: string, accountId: string, label = "Account") {
  const a = await first<{ is_group: number; is_active: number; type: string; subtype: string }>(
    db, `SELECT is_group, is_active, type, subtype FROM accounts WHERE id = ? AND company_id = ?`, accountId, companyId,
  );
  if (!a) throw unprocessable("INVALID_ACCOUNT", `${label} does not exist in this company`);
  if (a.is_group) throw unprocessable("INVALID_ACCOUNT", `${label} is a group account and cannot be posted to`);
  if (!a.is_active) throw unprocessable("INVALID_ACCOUNT", `${label} is inactive`);
  return a;
}

export async function assertOpenPeriod(db: D1Database, companyId: string, date: string) {
  const p = await first<{ status: string }>(
    db, `SELECT status FROM fiscal_periods WHERE company_id = ? AND ? BETWEEN start_date AND end_date`, companyId, date,
  );
  if (!p) throw unprocessable("PERIOD_CLOSED", `No fiscal period covers ${date}. Create the fiscal year first.`);
  if (p.status !== "open") throw unprocessable("PERIOD_CLOSED", `The period containing ${date} is locked`);
}
