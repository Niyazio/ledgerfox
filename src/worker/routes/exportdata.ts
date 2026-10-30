import { Hono } from "hono";
import type { AppEnv } from "../env";
import { all, batch, first } from "../lib/db";
import { audit, requirePerm } from "../lib/auth";

const exportdata = new Hono<AppEnv>();

/** Company-scoped tables included in the JSON export (attachments: metadata only). */
const TABLES: [string, string][] = [
  ["branches", "SELECT * FROM branches WHERE company_id = ?"],
  ["departments", "SELECT * FROM departments WHERE company_id = ?"],
  ["projects", "SELECT * FROM projects WHERE company_id = ?"],
  ["cost_centres", "SELECT * FROM cost_centres WHERE company_id = ?"],
  ["number_sequences", "SELECT * FROM number_sequences WHERE company_id = ?"],
  ["exchange_rates", "SELECT * FROM exchange_rates WHERE company_id = ?"],
  ["fiscal_years", "SELECT * FROM fiscal_years WHERE company_id = ?"],
  ["fiscal_periods", "SELECT * FROM fiscal_periods WHERE company_id = ?"],
  ["accounts", "SELECT * FROM accounts WHERE company_id = ?"],
  ["contacts", "SELECT * FROM contacts WHERE company_id = ?"],
  ["tax_codes", "SELECT * FROM tax_codes WHERE company_id = ?"],
  ["units", "SELECT * FROM units WHERE company_id = ?"],
  ["warehouses", "SELECT * FROM warehouses WHERE company_id = ?"],
  ["items", "SELECT * FROM items WHERE company_id = ?"],
  ["journal_entries", "SELECT * FROM journal_entries WHERE company_id = ?"],
  ["journal_lines", "SELECT * FROM journal_lines WHERE company_id = ?"],
  ["documents", "SELECT * FROM documents WHERE company_id = ?"],
  ["document_lines", "SELECT * FROM document_lines WHERE company_id = ?"],
  ["payments", "SELECT * FROM payments WHERE company_id = ?"],
  ["allocations", "SELECT * FROM allocations WHERE company_id = ?"],
  ["stock_moves", "SELECT * FROM stock_moves WHERE company_id = ?"],
  ["expenses", "SELECT * FROM expenses WHERE company_id = ?"],
  ["recurring_templates", "SELECT * FROM recurring_templates WHERE company_id = ?"],
  ["attachments", "SELECT id, entity_type, entity_id, filename, mime_type, size_bytes, sha256, created_at FROM attachments WHERE company_id = ?"],
  ["bank_imports", "SELECT * FROM bank_imports WHERE company_id = ?"],
  ["bank_statement_lines", "SELECT * FROM bank_statement_lines WHERE company_id = ?"],
  ["bank_reconciliations", "SELECT * FROM bank_reconciliations WHERE company_id = ?"],
  ["fixed_assets", "SELECT * FROM fixed_assets WHERE company_id = ?"],
  ["depreciation_entries", "SELECT * FROM depreciation_entries WHERE company_id = ?"],
  ["budgets", "SELECT * FROM budgets WHERE company_id = ?"],
  ["budget_lines", "SELECT * FROM budget_lines WHERE company_id = ?"],
  ["audit_logs", "SELECT * FROM audit_logs WHERE company_id = ?"],
];

exportdata.get("/", async (c) => {
  requirePerm(c, "data.export");
  const company = c.get("company");
  const out: Record<string, unknown> = {
    format: "ledgerfox-company-export",
    version: 1,
    exported_at: new Date().toISOString(),
    note: "Money values are integer minor units; quantities are milli-units; exchange rates are scaled by 1e9. Attachment file contents are not included.",
    company,
  };
  for (const [name, sql] of TABLES) out[name] = await all(c.env.DB, sql, company.id);
  // The desktop app's automatic local copy runs every 15 minutes: record it in the audit trail once a day, not each time.
  const auto = c.req.header("x-ledgerfox-local-copy") === "1";
  const since = new Date(Date.now() - 86_400_000).toISOString();
  if (!auto || !(await first(c.env.DB, `SELECT 1 FROM audit_logs WHERE company_id = ? AND user_id = ? AND action = 'company.local_copy' AND created_at >= ? LIMIT 1`, company.id, c.get("user").id, since))) {
    await batch(c.env.DB, [audit(c, auto ? "company.local_copy" : "company.export", "company", company.id)]);
  }
  return new Response(JSON.stringify(out), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="ledgerfox-${company.name.replace(/[^\w-]+/g, "_")}-${out.exported_at as string}.json"`,
      "Cache-Control": "no-store",
    },
  });
});

export default exportdata;
