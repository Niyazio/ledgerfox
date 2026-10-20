import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { all, batch, first, stmt } from "../lib/db";
import { badRequest, conflict, notFound } from "../lib/errors";
import { body, reqText, shortText, optId } from "../lib/validate";
import { newId } from "../lib/crypto";
import { audit, requirePerm } from "../lib/auth";
import { isValidSubtype, type AccountType } from "@shared/coa";

const accounts = new Hono<AppEnv>();

accounts.get("/", async (c) => {
  const company = c.get("company");
  const rows = await all(
    c.env.DB,
    `SELECT a.*, COALESCE(b.debit, 0) AS debit_total, COALESCE(b.credit, 0) AS credit_total
     FROM accounts a
     LEFT JOIN (
       SELECT l.account_id, SUM(l.debit) AS debit, SUM(l.credit) AS credit
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE e.company_id = ? AND e.status = 'posted' GROUP BY l.account_id
     ) b ON b.account_id = a.id
     WHERE a.company_id = ? ORDER BY a.code`,
    company.id, company.id,
  );
  return c.json({ accounts: rows });
});

const accountSchema = z.object({
  code: z.string().trim().min(1).max(20).regex(/^[A-Za-z0-9.-]+$/, "Letters, digits, dot and dash only"),
  name: reqText(120),
  type: z.enum(["asset", "liability", "equity", "income", "expense"]),
  subtype: z.string().min(1).max(40),
  parent_id: optId,
  is_group: z.boolean().default(false),
  description: shortText(500).nullish(),
});

async function checkParent(db: D1Database, companyId: string, parentId: string | null | undefined, type: string, selfId?: string) {
  if (!parentId) return;
  const p = await first<{ is_group: number; type: string }>(db, `SELECT is_group, type FROM accounts WHERE id = ? AND company_id = ?`, parentId, companyId);
  if (!p) throw badRequest("Parent account not found");
  if (!p.is_group) throw badRequest("Parent must be a group account");
  if (p.type !== type) throw badRequest("Parent must have the same account type");
  if (selfId) {
    // prevent cycles
    let cur: string | null = parentId;
    for (let i = 0; cur && i < 20; i++) {
      if (cur === selfId) throw badRequest("An account cannot be its own ancestor");
      const r: { parent_id: string | null } | null = await first(db, `SELECT parent_id FROM accounts WHERE id = ?`, cur);
      cur = r?.parent_id ?? null;
    }
  }
}

accounts.post("/", async (c) => {
  requirePerm(c, "masters.write");
  const input = await body(c, accountSchema);
  const company = c.get("company");
  if (!isValidSubtype(input.type as AccountType, input.subtype)) throw badRequest("Subtype does not match the account type");
  await checkParent(c.env.DB, company.id, input.parent_id, input.type);
  const id = newId();
  await batch(c.env.DB, [
    stmt(c.env.DB, `INSERT INTO accounts (id, company_id, code, name, type, subtype, parent_id, is_group, description) VALUES (?,?,?,?,?,?,?,?,?)`,
      id, company.id, input.code, input.name, input.type, input.subtype, input.parent_id ?? null, input.is_group ? 1 : 0, input.description ?? null),
    audit(c, "account.create", "account", id, input),
  ]);
  return c.json({ id }, 201);
});

accounts.patch("/:id", async (c) => {
  requirePerm(c, "masters.write");
  const company = c.get("company");
  const id = c.req.param("id");
  const input = await body(c, accountSchema.partial().extend({ is_active: z.boolean().optional() }));
  const acc = await first<{ type: string; subtype: string; is_group: number; system_key: string | null; code: string }>(
    c.env.DB, `SELECT * FROM accounts WHERE id = ? AND company_id = ?`, id, company.id,
  );
  if (!acc) throw notFound("Account");
  const used = await first(c.env.DB, `SELECT 1 FROM journal_lines WHERE account_id = ? LIMIT 1`, id);
  if (input.type && input.type !== acc.type && used) throw conflict("ACCOUNT_IN_USE", "The type of an account with transactions cannot be changed");
  const type = input.type ?? acc.type;
  const subtype = input.subtype ?? acc.subtype;
  if (!isValidSubtype(type as AccountType, subtype)) throw badRequest("Subtype does not match the account type");
  if (input.is_group !== undefined && Boolean(input.is_group) !== Boolean(acc.is_group)) {
    if (input.is_group && used) throw conflict("ACCOUNT_IN_USE", "An account with transactions cannot become a group");
    if (!input.is_group) {
      const kids = await first(c.env.DB, `SELECT 1 FROM accounts WHERE parent_id = ? LIMIT 1`, id);
      if (kids) throw conflict("HAS_CHILDREN", "A group with sub-accounts cannot become a ledger account");
    }
  }
  if (input.is_active === false && acc.system_key) throw conflict("SYSTEM_ACCOUNT", "System accounts cannot be deactivated");
  if (input.parent_id !== undefined) await checkParent(c.env.DB, company.id, input.parent_id, type, id);
  await batch(c.env.DB, [
    stmt(
      c.env.DB,
      `UPDATE accounts SET code = COALESCE(?, code), name = COALESCE(?, name), type = ?, subtype = ?, parent_id = ?,
         is_group = COALESCE(?, is_group), is_active = COALESCE(?, is_active), description = COALESCE(?, description)
       WHERE id = ? AND company_id = ?`,
      input.code ?? null, input.name ?? null, type, subtype,
      input.parent_id === undefined ? (await first<{ parent_id: string | null }>(c.env.DB, `SELECT parent_id FROM accounts WHERE id = ?`, id))?.parent_id ?? null : input.parent_id,
      input.is_group === undefined ? null : input.is_group ? 1 : 0, input.is_active === undefined ? null : input.is_active ? 1 : 0,
      input.description ?? null, id, company.id,
    ),
    audit(c, "account.update", "account", id, input),
  ]);
  return c.json({ ok: true });
});

accounts.delete("/:id", async (c) => {
  requirePerm(c, "masters.write");
  const company = c.get("company");
  const id = c.req.param("id");
  const acc = await first<{ system_key: string | null }>(c.env.DB, `SELECT system_key FROM accounts WHERE id = ? AND company_id = ?`, id, company.id);
  if (!acc) throw notFound("Account");
  if (acc.system_key) throw conflict("SYSTEM_ACCOUNT", "System accounts cannot be deleted");
  const used = await first(c.env.DB,
    `SELECT 1 FROM journal_lines WHERE account_id = ? UNION ALL SELECT 1 FROM accounts WHERE parent_id = ? UNION ALL SELECT 1 FROM document_lines WHERE account_id = ? LIMIT 1`, id, id, id);
  if (used) throw conflict("ACCOUNT_IN_USE", "This account has transactions or sub-accounts. Deactivate it instead.");
  await batch(c.env.DB, [stmt(c.env.DB, `DELETE FROM accounts WHERE id = ? AND company_id = ?`, id, company.id), audit(c, "account.delete", "account", id)]);
  return c.json({ ok: true });
});

export default accounts;
