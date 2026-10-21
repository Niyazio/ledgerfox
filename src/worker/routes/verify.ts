/**
 * QR verification. Printed invoices, receipts and payslips carry a QR code pointing to /verify/<token>; anyone can
 * scan it to confirm the document exists in this company's books with the same number, date and amount.
 * Tokens are 128-bit random values created on demand; nothing else about the company is exposed.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { all, first, run } from "../lib/db";
import { AppError, notFound } from "../lib/errors";
import { body } from "../lib/validate";
import { randomToken } from "../lib/crypto";
import { assertBranchVisible, clientIp, rateLimit, requirePerm } from "../lib/auth";
import { docFamily, SALES_DOC_TYPES } from "@shared/permissions";

/** Company-scoped: get (or create) the token for a document, payment or payslip. */
export const verifyToken = new Hono<AppEnv>();

verifyToken.post("/", async (c) => {
  const company = c.get("company");
  const input = await body(c, z.object({ entity_type: z.enum(["document", "payment", "payslip"]), entity_id: z.string().min(1).max(64) }));
  const table = { document: "documents", payment: "payments", payslip: "payslips" }[input.entity_type];
  const row = await first<{ status?: string; doc_type?: string; direction?: string; branch_id?: string | null }>(c.env.DB, `SELECT * FROM ${table} WHERE id = ? AND company_id = ?`, input.entity_id, company.id);
  if (!row) throw notFound("Record");
  // Whoever may see the record may share it (e.g. billing staff sending an invoice to the customer).
  if (input.entity_type === "payslip") requirePerm(c, "payroll.read");
  else if (input.entity_type === "document") requirePerm(c, `${docFamily(row.doc_type!)}.view`);
  else requirePerm(c, row.direction === "in" ? "sales.view" : "purchase.view");
  if (input.entity_type !== "payslip") assertBranchVisible(c, row.branch_id);
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
  const co = await first<{ name: string; legal_name: string | null; tax_id: string | null; country: string; address: string | null; city: string | null; phone: string | null; email: string | null; upi_id: string | null; base_currency: string }>(c.env.DB,
    `SELECT name, legal_name, tax_id, country, address, city, phone, email, upi_id, base_currency FROM companies WHERE id = ?`, v.company_id);
  const issuer = { name: co?.legal_name || co?.name, tax_id: co?.tax_id ?? null, country: co?.country };
  if (v.entity_type === "document") {
    const d = await first<Record<string, unknown>>(c.env.DB,
      `SELECT d.doc_type, d.number, d.issue_date, d.due_date, d.status, d.currency, d.total, d.amount_settled, d.subtotal, d.discount_total, d.tax_total, d.round_off, d.notes, d.terms,
              ct.name AS party, ct.billing_address AS party_address, ct.tax_id AS party_tax_id
       FROM documents d JOIN contacts ct ON ct.id = d.contact_id WHERE d.id = ?`, v.entity_id);
    if (!d) throw notFound("Document");
    const base = { valid: d.status !== "void" && d.status !== "draft", kind: LABELS[d.doc_type as string] ?? "Document", issuer, number: d.number, date: d.issue_date, status: d.status,
      currency: d.currency, amount: d.total, settled: d.amount_settled, party: d.party };
    // Sales documents are what customers receive, so the link also shows the full document and how to pay.
    // Purchase documents only confirm that they exist.
    if (!SALES_DOC_TYPES.includes(d.doc_type as string) || !base.valid) return c.json(base);
    const lines = await all(c.env.DB,
      `SELECT l.description, l.hsn_sac, l.qty_milli, l.unit_price, l.discount_bp, l.taxable, l.cgst, l.sgst, l.igst, l.other_tax, l.line_total, i.unit
       FROM document_lines l LEFT JOIN items i ON i.id = l.item_id WHERE l.document_id = ? ORDER BY l.line_no`, v.entity_id);
    const balance = (d.total as number) - (d.amount_settled as number);
    return c.json({
      ...base, due_date: d.due_date, balance, subtotal: d.subtotal, discount_total: d.discount_total, tax_total: d.tax_total, round_off: d.round_off,
      notes: d.notes, terms: d.terms, party_address: d.party_address, party_tax_id: d.party_tax_id, lines,
      issuer: { ...issuer, address: [co?.address, co?.city].filter(Boolean).join(", ") || null, phone: co?.phone ?? null, email: co?.email ?? null },
      pay: d.doc_type === "invoice" && d.status === "posted" && balance > 0 && co?.upi_id && d.currency === "INR" ? { upi_id: co.upi_id, payee: issuer.name, amount: balance } : null,
    });
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
