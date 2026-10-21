import { Hono } from "hono";
import type { AppEnv } from "../env";
import { all, first, todayIso } from "../lib/db";
import { badRequest, notFound } from "../lib/errors";
import { assertBranchVisible, branchFilter, hasPerm, requireAnyPerm, requirePerm, resolveBranch } from "../lib/auth";
import { docFamily } from "@shared/permissions";

/**
 * Daybook: every transaction of a period in one list, with who created, last modified, approved, posted and
 * cancelled it and when. "Modified" and "cancelled" come from the append-only audit log.
 */
const daybook = new Hono<AppEnv>();

const ISO = /^\d{4}-\d{2}-\d{2}$/;

// Latest audit event of a kind for a record, as "name|timestamp".
const lastEvent = (type: string, idCol: string, actions: string) =>
  `(SELECT COALESCE(u.name, '?') || '|' || al.created_at FROM audit_logs al LEFT JOIN users u ON u.id = al.user_id
    WHERE al.entity_type = '${type}' AND al.entity_id = ${idCol} AND (${actions}) ORDER BY al.created_at DESC LIMIT 1)`;

daybook.get("/", async (c) => {
  requirePerm(c, "daybook.read");
  const company = c.get("company");
  const from = c.req.query("from") || todayIso();
  const to = c.req.query("to") || from;
  if (!ISO.test(from) || !ISO.test(to) || from > to) throw badRequest("Choose a valid date range");
  if ((Date.parse(to) - Date.parse(from)) / 86400_000 > 366) throw badRequest("The daybook covers at most one year at a time");
  const type = c.req.query("type") || "";
  const userId = c.req.query("user_id") || "";
  const branchId = c.req.query("branch_id") ? resolveBranch(c, c.req.query("branch_id")) : null;
  // Users only see the families they may view (e.g. billing staff see sales, not purchases or journals).
  const sales = hasPerm(c, "sales.view"), purchases = hasPerm(c, "purchase.view"), journals = hasPerm(c, "journal.view");
  const expenses = hasPerm(c, "expense.create") || hasPerm(c, "expense.approve") || journals;
  const parts: string[] = [];
  const params: (string | number)[] = [];
  const scoped = (col: string) => {
    const bf = branchFilter(c, col);
    params.push(...bf.params);
    if (branchId) params.push(branchId);
    return `${bf.sql}${branchId ? ` AND ${col} = ?` : ""}`;
  };
  const docTypes = [...(sales ? ["quote", "sales_order", "invoice", "credit_note"] : []), ...(purchases ? ["purchase_order", "bill", "debit_note"] : [])];
  if (docTypes.length && (!type || docTypes.includes(type))) {
    const types = type ? [type] : docTypes;
    params.push(company.id, from, to, ...types);
    const branch = scoped("d.branch_id");
    parts.push(`SELECT 'document' AS entity_type, d.id, d.doc_type AS type, d.number, d.issue_date AS date, ct.name AS party, d.total AS amount, d.currency, d.status,
        d.branch_id, d.created_by, cu.name AS created_by_name, d.created_at, pu.name AS posted_by_name, d.posted_at,
        au.name AS approved_by_name, da.approved_at,
        ${lastEvent("document", "d.id", "al.action LIKE '%.update'")} AS modified,
        ${lastEvent("document", "d.id", "al.action LIKE '%.void'")} AS cancelled
      FROM documents d LEFT JOIN contacts ct ON ct.id = d.contact_id LEFT JOIN users cu ON cu.id = d.created_by LEFT JOIN users pu ON pu.id = d.posted_by
      LEFT JOIN document_approvals da ON da.document_id = d.id LEFT JOIN users au ON au.id = da.approved_by
      WHERE d.company_id = ? AND d.issue_date BETWEEN ? AND ? AND d.doc_type IN (${types.map(() => "?").join(",")})${branch}`);
  }
  const dirs = [...(sales ? ["in"] : []), ...(purchases ? ["out"] : [])];
  if (dirs.length && (!type || type === "receipt" || type === "payment")) {
    const want = type ? [type === "receipt" ? "in" : "out"].filter((d) => dirs.includes(d)) : dirs;
    if (want.length) {
      params.push(company.id, from, to, ...want);
      const branch = scoped("p.branch_id");
      parts.push(`SELECT 'payment', p.id, CASE p.direction WHEN 'in' THEN 'receipt' ELSE 'payment' END, p.number, p.payment_date, ct.name, p.amount, p.currency, p.status,
          p.branch_id, p.created_by, cu.name, p.created_at, cu.name, p.created_at, NULL, NULL, NULL,
          ${lastEvent("payment", "p.id", "al.action = 'payment.void'")}
        FROM payments p LEFT JOIN contacts ct ON ct.id = p.contact_id LEFT JOIN users cu ON cu.id = p.created_by
        WHERE p.company_id = ? AND p.payment_date BETWEEN ? AND ? AND p.direction IN (${want.map(() => "?").join(",")})${branch}`);
    }
  }
  if (journals && (!type || type === "journal")) {
    params.push(company.id, from, to);
    const branch = scoped("j.branch_id");
    parts.push(`SELECT 'journal', j.id, 'journal', j.entry_number, j.entry_date, j.memo, j.total, '${company.base_currency}', CASE WHEN j.reversed_by_id IS NOT NULL THEN 'reversed' ELSE j.status END,
        j.branch_id, j.created_by, cu.name, j.created_at, pu.name, j.posted_at, NULL, NULL,
        ${lastEvent("journal", "j.id", "al.action = 'journal.update'")},
        ${lastEvent("journal", "j.id", "al.action = 'journal.reverse'")}
      FROM journal_entries j LEFT JOIN users cu ON cu.id = j.created_by LEFT JOIN users pu ON pu.id = j.posted_by
      WHERE j.company_id = ? AND j.entry_date BETWEEN ? AND ? AND j.source_type IS NULL${branch}`);
  }
  if (expenses && (!type || type === "expense")) {
    params.push(company.id, from, to);
    const branch = scoped("e.branch_id");
    parts.push(`SELECT 'expense', e.id, 'expense', e.number, e.expense_date, e.description, e.total, e.currency, e.status,
        e.branch_id, e.created_by, cu.name, e.created_at, au.name, e.approved_at, au.name, e.approved_at,
        ${lastEvent("expense", "e.id", "al.action = 'expense.update'")},
        ${lastEvent("expense", "e.id", "al.action = 'expense.reject'")}
      FROM expenses e LEFT JOIN users cu ON cu.id = e.created_by LEFT JOIN users au ON au.id = e.approved_by
      WHERE e.company_id = ? AND e.expense_date BETWEEN ? AND ?${branch}`);
  }
  if (!parts.length) return c.json({ from, to, entries: [] });
  const rows = await all<Record<string, unknown> & { modified: string | null; cancelled: string | null; created_by: string }>(c.env.DB,
    `SELECT x.*, b.name AS branch_name FROM (${parts.join(" UNION ALL ")}) x LEFT JOIN branches b ON b.id = x.branch_id
     ${userId ? "WHERE x.created_by = ?" : ""} ORDER BY x.date, x.created_at LIMIT 2000`, ...params, ...(userId ? [userId] : []));
  const split = (v: string | null) => (v ? { by: v.slice(0, v.lastIndexOf("|")), at: v.slice(v.lastIndexOf("|") + 1) } : null);
  return c.json({
    from, to,
    entries: rows.map(({ modified, cancelled, ...r }) => ({ ...r, modified: split(modified), cancelled: split(cancelled) })),
  });
});

/** Full history of one record (who did what, when, with previous → new values where recorded). */
daybook.get("/history/:type/:id", async (c) => {
  requireAnyPerm(c, "audit.read", "daybook.read", "sales.view", "purchase.view", "journal.view", "expense.create", "expense.approve");
  const company = c.get("company");
  const type = c.req.param("type");
  const id = c.req.param("id");
  const tables: Record<string, string> = { document: "documents", payment: "payments", journal: "journal_entries", expense: "expenses", item: "items", contact: "contacts" };
  const table = tables[type];
  if (!table) throw notFound("Record type");
  const row = await first<Record<string, unknown>>(c.env.DB, `SELECT * FROM ${table} WHERE id = ? AND company_id = ?`, id, company.id);
  if (!row) throw notFound("Record");
  if ("branch_id" in row) assertBranchVisible(c, row.branch_id as string | null);
  // The viewer must be allowed to see the record itself.
  const allowed =
    type === "document" ? hasPerm(c, `${docFamily(String(row.doc_type))}.view`) :
    type === "payment" ? hasPerm(c, row.direction === "in" ? "sales.view" : "purchase.view") :
    type === "journal" ? hasPerm(c, "journal.view") :
    type === "expense" ? hasPerm(c, "expense.create") || hasPerm(c, "expense.approve") || hasPerm(c, "journal.view") :
    type === "item" ? hasPerm(c, "inventory.view") :
    hasPerm(c, row.kind === "supplier" ? "purchase.view" : "sales.view");
  if (!allowed && !hasPerm(c, "audit.read")) throw notFound("Record");
  const events = await all<{ details: string | null }>(c.env.DB,
    `SELECT al.id, al.action, al.created_at, al.details, al.ip, u.name AS user_name, u.username
     FROM audit_logs al LEFT JOIN users u ON u.id = al.user_id
     WHERE al.entity_type = ? AND al.entity_id = ? AND al.company_id = ? ORDER BY al.created_at`, type, id, company.id);
  const showIp = hasPerm(c, "audit.read");
  return c.json({
    events: events.map((e) => {
      let details: unknown;
      try { details = e.details ? JSON.parse(e.details) : null; } catch { details = e.details; }
      const { ip, ...rest } = e as typeof e & { ip: string | null };
      return { ...rest, details, ...(showIp ? { ip } : {}) };
    }),
  });
});

export default daybook;
