import { Hono } from "hono";
import type { AppEnv } from "../env";
import { all, first } from "../lib/db";
import { orgPermissions, requireAuth } from "../lib/auth";
import type { Role } from "@shared/permissions";

/**
 * Practice view for accountants and CAs: every company the signed-in user belongs to, with a few figures to see
 * which clients need attention. Figures are shown only where the user may read reports for the whole company
 * (not branch-limited); otherwise just the name.
 */
const clients = new Hono<AppEnv>();
clients.use("*", requireAuth);

clients.get("/", async (c) => {
  const db = c.env.DB;
  const user = c.get("user");
  const rows = await all<{ id: string; name: string; legal_name: string | null; tax_id: string | null; base_currency: string; org_id: string; org_name: string; role: Role; all_branches: number }>(db,
    `SELECT co.id, co.name, co.legal_name, co.tax_id, co.base_currency, co.org_id, o.name AS org_name, m.role, m.all_branches
     FROM memberships m JOIN organisations o ON o.id = m.org_id JOIN companies co ON co.org_id = m.org_id
     WHERE m.user_id = ? AND co.is_demo = 0 ORDER BY o.name, co.name`, user.id);
  const perms = new Map<string, Set<string>>();
  for (const r of rows) if (!perms.has(`${r.org_id}|${r.role}`)) perms.set(`${r.org_id}|${r.role}`, new Set(await orgPermissions(db, r.org_id, r.role)));
  const now = new Date();
  const monthStart = `${now.toISOString().slice(0, 7)}-01`;
  const today = now.toISOString().slice(0, 10);
  const out = [];
  for (const r of rows) {
    const p = perms.get(`${r.org_id}|${r.role}`)!;
    const figures = r.all_branches === 1 && p.has("reports.read");
    let stats = null;
    if (figures) {
      stats = await first<{ sales_month: number; receivables: number; payables: number; overdue: number; drafts: number; approvals: number; unmatched: number; last_entry: string | null }>(db,
        `SELECT
           COALESCE((SELECT SUM(CASE WHEN doc_type = 'credit_note' THEN -total_base ELSE total_base END) FROM documents
                     WHERE company_id = ?1 AND doc_type IN ('invoice','credit_note') AND status = 'posted' AND issue_date BETWEEN ?2 AND ?3), 0) AS sales_month,
           COALESCE((SELECT SUM(l.debit - l.credit) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
                     WHERE l.company_id = ?1 AND e.status = 'posted' AND a.system_key = 'AR'), 0) AS receivables,
           COALESCE((SELECT SUM(l.credit - l.debit) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
                     WHERE l.company_id = ?1 AND e.status = 'posted' AND a.system_key = 'AP'), 0) AS payables,
           (SELECT COUNT(*) FROM documents WHERE company_id = ?1 AND doc_type = 'invoice' AND status = 'posted' AND total > amount_settled AND due_date < ?3) AS overdue,
           (SELECT COUNT(*) FROM journal_entries WHERE company_id = ?1 AND status = 'draft') + (SELECT COUNT(*) FROM documents WHERE company_id = ?1 AND status = 'draft') AS drafts,
           (SELECT COUNT(*) FROM expenses WHERE company_id = ?1 AND status = 'submitted') AS approvals,
           (SELECT COUNT(*) FROM bank_statement_lines WHERE company_id = ?1 AND status = 'unmatched') AS unmatched,
           (SELECT MAX(entry_date) FROM journal_entries WHERE company_id = ?1 AND status = 'posted') AS last_entry`,
        r.id, monthStart, today);
    }
    out.push({ company_id: r.id, name: r.legal_name || r.name, gstin: r.tax_id, currency: r.base_currency, org_id: r.org_id, org_name: r.org_name, role: r.role, figures, stats });
  }
  return c.json({ clients: out, month: monthStart.slice(0, 7) });
});

export default clients;
