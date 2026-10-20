/**
 * QR verification. Printed invoices, receipts and payslips carry a QR code pointing to /verify/<token>; anyone can
 * scan it to confirm the document exists in this company's books with the same number, date and amount.
 * Tokens are 128-bit random values created on demand; nothing else about the company is exposed.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { first, run } from "../lib/db";
import { AppError, notFound } from "../lib/errors";
import { body } from "../lib/validate";
import { randomToken } from "../lib/crypto";
import { clientIp, rateLimit, requirePerm } from "../lib/auth";

/** Company-scoped: get (or create) the token for a document, payment or payslip. */
export const verifyToken = new Hono<AppEnv>();

verifyToken.post("/", async (c) => {
  requirePerm(c, "reports.read");
  const company = c.get("company");
  const input = await body(c, z.object({ entity_type: z.enum(["document", "payment", "payslip"]), entity_id: z.string().min(1).max(64) }));
  if (input.entity_type === "payslip") requirePerm(c, "payroll.read");
  const table = { document: "documents", payment: "payments", payslip: "payslips" }[input.entity_type];
  const row = await first<{ status?: string }>(c.env.DB, `SELECT * FROM ${table} WHERE id = ? AND company_id = ?`, input.entity_id, company.id);
  if (!row) throw notFound("Record");
  const existing = await first<{ token: string }>(c.env.DB, `SELECT token FROM verifications WHERE entity_type = ? AND entity_id = ?`, input.entity_type, input.entity_id);
  if (existing) return c.json({ token: existing.token });
  const token = randomToken(16);
  await run(c.env.DB, `INSERT INTO verifications (token, company_id, entity_type, entity_id) VALUES (?,?,?,?) ON CONFLICT (entity_type, entity_id) DO NOTHING`,
    token, company.id, input.entity_type, input.entity_id);
  const saved = await first<{ token: string }>(c.env.DB, `SELECT token FROM verifications WHERE entity_type = ? AND entity_id = ?`, input.entity_type, input.entity_id);
  return c.json({ token: saved!.token });
});

/** Public lookup used by the /verify page. */
export const verifyPublic = new Hono<AppEnv>();

const LABELS: Record<string, string> = {
  quote: "Quotation", sales_order: "Sales order", invoice: "Invoice", credit_note: "Credit note",
  purchase_order: "Purchase order", bill: "Bill", debit_note: "Debit note",
};

verifyPublic.get("/:token", async (c) => {
  if (!(await rateLimit(c.env.DB, `verify:${clientIp(c)}`, 60, 600))) throw new AppError(429, "RATE_LIMITED", "Too many checks. Try again in a few minutes.");
  const token = c.req.param("token");
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw notFound("Verification code");
  const v = await first<{ company_id: string; entity_type: string; entity_id: string }>(c.env.DB, `SELECT company_id, entity_type, entity_id FROM verifications WHERE token = ?`, token);
  if (!v) throw notFound("Verification code");
  const co = await first<{ name: string; legal_name: string | null; tax_id: string | null; country: string }>(c.env.DB, `SELECT name, legal_name, tax_id, country FROM companies WHERE id = ?`, v.company_id);
  const issuer = { name: co?.legal_name || co?.name, tax_id: co?.tax_id ?? null, country: co?.country };
  if (v.entity_type === "document") {
    const d = await first<Record<string, unknown>>(c.env.DB,
      `SELECT d.doc_type, d.number, d.issue_date, d.due_date, d.status, d.currency, d.total, d.amount_settled, ct.name AS party FROM documents d JOIN contacts ct ON ct.id = d.contact_id WHERE d.id = ?`, v.entity_id);
    if (!d) throw notFound("Document");
    return c.json({ valid: d.status !== "void" && d.status !== "draft", kind: LABELS[d.doc_type as string] ?? "Document", issuer, number: d.number, date: d.issue_date, status: d.status,
      currency: d.currency, amount: d.total, settled: d.amount_settled, party: d.party });
  }
  if (v.entity_type === "payment") {
    const p = await first<Record<string, unknown>>(c.env.DB,
      `SELECT p.direction, p.number, p.payment_date, p.status, p.currency, p.amount, ct.name AS party FROM payments p JOIN contacts ct ON ct.id = p.contact_id WHERE p.id = ?`, v.entity_id);
    if (!p) throw notFound("Payment");
    return c.json({ valid: p.status === "posted", kind: p.direction === "in" ? "Payment receipt" : "Payment voucher", issuer, number: p.number, date: p.payment_date, status: p.status,
      currency: p.currency, amount: p.amount, party: p.party });
  }
  const s = await first<Record<string, unknown>>(c.env.DB,
    `SELECT r.period, r.status, p.gross, p.net, e.name, e.code FROM payslips p JOIN payroll_runs r ON r.id = p.run_id JOIN employees e ON e.id = p.employee_id WHERE p.id = ?`, v.entity_id);
  if (!s) throw notFound("Payslip");
  const cur = await first<{ base_currency: string }>(c.env.DB, `SELECT base_currency FROM companies WHERE id = ?`, v.company_id);
  return c.json({ valid: s.status !== "draft", kind: "Payslip", issuer, number: `${s.code} · ${s.period}`, date: s.period, status: s.status,
    currency: cur?.base_currency, amount: s.net, gross: s.gross, party: s.name });
});
