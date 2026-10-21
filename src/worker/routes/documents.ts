import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { all, batch, first, stmt, todayIso } from "../lib/db";
import { AppError, badRequest, conflict, notFound } from "../lib/errors";
import { body, isoDate, shortText, optId, minor, qty, rate, percentBp, pageParams } from "../lib/validate";
import { audit, changes, requirePerm, hasPerm, resolveBranch, assertBranchVisible, branchFilter } from "../lib/auth";
import { docFamily, type Permission } from "@shared/permissions";
import type { Context } from "hono";
import { currencyExponent } from "@shared/currencies";
import { prepareDraft, issueDocument, voidDocument, loadDoc, POSTING_TYPES, type DocType, type DraftInput } from "../services/documents";
import { applyCredit } from "../services/payments";
import { duplicateBillCheck } from "../services/insights";

const documents = new Hono<AppEnv>();

const famPerm = (docType: string, action: "view" | "create" | "post" | "void") => `${docFamily(docType)}.${action}` as Permission;

/** Load a document's access facts; 404 when missing or in a branch the member cannot see; 403 without permission. */
async function access(c: Context<AppEnv>, id: string, action: "view" | "create" | "post" | "void") {
  const d = await first<{ doc_type: DocType; status: string; branch_id: string | null; total_base: number }>(c.env.DB,
    `SELECT doc_type, status, branch_id, total_base FROM documents WHERE id = ? AND company_id = ?`, id, c.get("company").id);
  if (!d) throw notFound("Document");
  assertBranchVisible(c, d.branch_id);
  requirePerm(c, famPerm(d.doc_type, action));
  return d;
}

/** Billing discount limit: discounts above it need `sales.discount_any`. */
function checkDiscounts(c: Context<AppEnv>, docType: string, lines: { discount_bp: number }[]) {
  const limit = c.get("company").billing_discount_limit_bp;
  if (docFamily(docType) !== "sales" || limit === null || limit === undefined || hasPerm(c, "sales.discount_any")) return;
  if (lines.some((l) => l.discount_bp > limit)) throw new AppError(403, "DISCOUNT_LIMIT", `Discounts above ${limit / 100}% need a manager's approval`);
}
const DOC_TYPES = ["quote", "sales_order", "invoice", "credit_note", "purchase_order", "bill", "debit_note"] as const;

const lineSchema = z.object({
  item_id: optId,
  description: z.string().trim().min(1, "Description is required").max(500),
  hsn_sac: z.string().trim().max(8).nullish(),
  quantity: z.union([z.string(), z.number()]),
  unit_price: z.union([z.string(), z.number()]),
  discount_percent: z.union([z.string(), z.number()]).nullish(),
  account_id: optId,
  tax_code_id: optId,
  department_id: optId,
  project_id: optId,
  cost_centre_id: optId,
});

const docSchema = z.object({
  doc_type: z.enum(DOC_TYPES),
  contact_id: z.string().min(1),
  issue_date: isoDate,
  due_date: isoDate.nullish(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullish(),
  fx_rate: z.union([z.string(), z.number()]).nullish(),
  place_of_supply: z.string().max(4).nullish(),
  reference: shortText(100).nullish(),
  notes: shortText(2000).nullish(),
  terms: shortText(4000).nullish(),
  related_doc_id: optId,
  branch_id: optId,
  warehouse_id: optId,
  lines: z.array(lineSchema).min(1).max(200),
});

async function toDraftInput(db: D1Database, companyBase: string, companyId: string, input: z.infer<typeof docSchema>): Promise<DraftInput> {
  let currency = input.currency ?? null;
  if (!currency) {
    const ct = await first<{ currency: string | null }>(db, `SELECT currency FROM contacts WHERE id = ? AND company_id = ?`, input.contact_id, companyId);
    currency = ct?.currency ?? companyBase;
  }
  const exp = currencyExponent(currency);
  return {
    doc_type: input.doc_type,
    contact_id: input.contact_id,
    issue_date: input.issue_date,
    due_date: input.due_date ?? null,
    currency,
    fx_rate_scaled: input.fx_rate ? rate(input.fx_rate) : null,
    place_of_supply: input.place_of_supply ?? null,
    reference: input.reference ?? null,
    notes: input.notes ?? null,
    terms: input.terms ?? null,
    related_doc_id: input.related_doc_id ?? null,
    branch_id: input.branch_id ?? null,
    warehouse_id: input.warehouse_id ?? null,
    lines: input.lines.map((l, i) => {
      const q = qty(l.quantity, `Line ${i + 1} quantity`);
      if (q <= 0) throw badRequest(`Line ${i + 1}: quantity must be positive`);
      const price = minor(l.unit_price, exp, `Line ${i + 1} price`);
      if (price < 0) throw badRequest(`Line ${i + 1}: price cannot be negative`);
      const disc = percentBp(l.discount_percent, `Line ${i + 1} discount`);
      if (disc < 0 || disc > 10000) throw badRequest(`Line ${i + 1}: discount must be 0–100%`);
      return {
        item_id: l.item_id ?? null, description: l.description, hsn_sac: l.hsn_sac || null, qty_milli: q, unit_price: price, discount_bp: disc,
        account_id: l.account_id ?? null, tax_code_id: l.tax_code_id ?? null, department_id: l.department_id ?? null,
        project_id: l.project_id ?? null, cost_centre_id: l.cost_centre_id ?? null,
      };
    }),
  };
}

documents.get("/", async (c) => {
  const company = c.get("company");
  const { limit, offset } = pageParams(c);
  const type = c.req.query("type");
  const status = c.req.query("status");
  const q = c.req.query("q");
  const contactId = c.req.query("contact_id");
  const where = ["d.company_id = ?"];
  const params: (string | number)[] = [company.id];
  if (type && (DOC_TYPES as readonly string[]).includes(type)) {
    requirePerm(c, famPerm(type, "view"));
    where.push("d.doc_type = ?"); params.push(type);
  } else {
    const visible = DOC_TYPES.filter((t) => hasPerm(c, famPerm(t, "view")));
    if (!visible.length) requirePerm(c, "sales.view");
    where.push(`d.doc_type IN (${visible.map(() => "?").join(",")})`); params.push(...visible);
  }
  const bf = branchFilter(c, "d.branch_id");
  if (bf.sql) { where.push(bf.sql.replace(/^ AND /, "")); params.push(...bf.params); }
  if (status === "outstanding") where.push("d.status = 'posted' AND d.total > d.amount_settled");
  else if (status === "overdue") { where.push("d.status = 'posted' AND d.total > d.amount_settled AND d.due_date < ?"); params.push(todayIso()); }
  else if (status) { where.push("d.status = ?"); params.push(status); }
  if (contactId) { where.push("d.contact_id = ?"); params.push(contactId); }
  if (q) { where.push("(d.number LIKE ? OR d.reference LIKE ? OR ct.name LIKE ?)"); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const rows = await all(c.env.DB,
    `SELECT d.id, d.doc_type, d.number, d.issue_date, d.due_date, d.status, d.currency, d.total, d.total_base, d.amount_settled, d.reference,
            d.contact_id, ct.name AS contact_name
     FROM documents d JOIN contacts ct ON ct.id = d.contact_id
     WHERE ${where.join(" AND ")} ORDER BY d.issue_date DESC, d.created_at DESC LIMIT ? OFFSET ?`, ...params, limit, offset);
  const total = await first<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM documents d JOIN contacts ct ON ct.id = d.contact_id WHERE ${where.join(" AND ")}`, ...params);
  return c.json({ documents: rows, total: total?.n ?? 0 });
});

documents.get("/:id", async (c) => {
  const company = c.get("company");
  const id = c.req.param("id");
  await access(c, id, "view");
  const doc = await first(c.env.DB,
    `SELECT d.*, ct.name AS contact_name, ct.email AS contact_email, ct.tax_id AS contact_tax_id, ct.billing_address AS contact_address,
            ct.shipping_address AS contact_shipping_address, ct.state_code AS contact_state_code, ct.phone AS contact_phone,
            rd.number AS related_number, rd.doc_type AS related_type, je.entry_number AS journal_number
     FROM documents d JOIN contacts ct ON ct.id = d.contact_id LEFT JOIN documents rd ON rd.id = d.related_doc_id
     LEFT JOIN journal_entries je ON je.id = d.journal_entry_id
     WHERE d.id = ? AND d.company_id = ?`, id, company.id);
  if (!doc) throw notFound("Document");
  const lines = await all(c.env.DB,
    `SELECT l.*, i.name AS item_name, i.unit, t.name AS tax_code_name, t.rate_bp, a.name AS account_name
     FROM document_lines l LEFT JOIN items i ON i.id = l.item_id LEFT JOIN tax_codes t ON t.id = l.tax_code_id LEFT JOIN accounts a ON a.id = l.account_id
     WHERE l.document_id = ? ORDER BY l.line_no`, id);
  const allocations = await all(c.env.DB,
    `SELECT a.id, a.source_kind, a.amount, a.allocation_date, a.reverses_id, p.number AS payment_number, p.id AS payment_id, n.number AS note_number, n.id AS note_id,
            t.number AS target_number, t.id AS target_id
     FROM allocations a LEFT JOIN payments p ON p.id = a.payment_id LEFT JOIN documents n ON n.id = a.note_id LEFT JOIN documents t ON t.id = a.document_id
     WHERE a.document_id = ? OR a.note_id = ? ORDER BY a.created_at`, id, id);
  const children = await all(c.env.DB, `SELECT id, doc_type, number, status FROM documents WHERE related_doc_id = ? AND company_id = ?`, id, company.id);
  return c.json({ document: doc, lines, allocations, related: children });
});

documents.post("/", async (c) => {
  const input = await body(c, docSchema);
  requirePerm(c, famPerm(input.doc_type, "create"));
  const company = c.get("company");
  const draft = await toDraftInput(c.env.DB, company.base_currency, company.id, { ...input, branch_id: resolveBranch(c, input.branch_id) });
  checkDiscounts(c, input.doc_type, draft.lines);
  const prepared = await prepareDraft(c, draft);
  await batch(c.env.DB, [...prepared.stmts, audit(c, `${input.doc_type}.create`, "document", prepared.id, { total: prepared.totals.total })]);
  const warnings = input.doc_type === "bill" ? await duplicateBillCheck(c.env.DB, company.id, input.contact_id, input.reference ?? null, prepared.totals.total, prepared.id) : [];
  return c.json({ id: prepared.id, totals: prepared.totals, warnings }, 201);
});

documents.put("/:id", async (c) => {
  const input = await body(c, docSchema);
  const company = c.get("company");
  const id = c.req.param("id");
  const existing = await access(c, id, "create");
  if (existing.status !== "draft") throw conflict("POSTED_IMMUTABLE", "Only drafts can be edited");
  if (existing.doc_type !== input.doc_type) throw badRequest("Document type cannot change");
  const draft = await toDraftInput(c.env.DB, company.base_currency, company.id, { ...input, branch_id: resolveBranch(c, input.branch_id ?? existing.branch_id) });
  checkDiscounts(c, input.doc_type, draft.lines);
  const before = await first<Record<string, unknown>>(c.env.DB, `SELECT contact_id, issue_date, due_date, reference, currency, total, branch_id FROM documents WHERE id = ?`, id);
  const prepared = await prepareDraft(c, draft, id);
  const after = { contact_id: input.contact_id, issue_date: input.issue_date, due_date: input.due_date ?? null, reference: input.reference ?? null, currency: draft.currency, total: prepared.totals.total, branch_id: draft.branch_id ?? null };
  await batch(c.env.DB, [...prepared.stmts, audit(c, `${input.doc_type}.update`, "document", id, { total: prepared.totals.total, changes: changes(before ?? {}, after) })]);
  return c.json({ id, totals: prepared.totals });
});

documents.delete("/:id", async (c) => {
  const company = c.get("company");
  const id = c.req.param("id");
  const d = await access(c, id, "create");
  if (d.status !== "draft") throw conflict("POSTED_IMMUTABLE", "Only drafts can be deleted. Void issued documents instead.");
  await batch(c.env.DB, [
    stmt(c.env.DB, `UPDATE documents SET related_doc_id = NULL WHERE related_doc_id = ? AND company_id = ? AND status = 'draft'`, id, company.id),
    stmt(c.env.DB, `DELETE FROM documents WHERE id = ? AND company_id = ? AND status = 'draft'`, id, company.id),
    audit(c, `${d.doc_type}.delete_draft`, "document", id),
  ]);
  return c.json({ ok: true });
});

documents.post("/:id/issue", async (c) => {
  const company = c.get("company");
  const id = c.req.param("id");
  const d = await access(c, id, "view");
  requirePerm(c, famPerm(d.doc_type, POSTING_TYPES.includes(d.doc_type) ? "post" : "create"));
  // Purchases above the approval limit need an approval by someone with purchase.approve (who may post directly).
  const limit = company.purchase_approval_limit;
  if (docFamily(d.doc_type) === "purchase" && POSTING_TYPES.includes(d.doc_type) && limit !== null && limit !== undefined && d.total_base > limit && !hasPerm(c, "purchase.approve")) {
    const ok = await first(c.env.DB, `SELECT 1 FROM document_approvals WHERE document_id = ? AND approved_at IS NOT NULL`, id);
    if (!ok) throw new AppError(403, "APPROVAL_REQUIRED", "This purchase is above the approval limit. Request approval first.");
  }
  const number = await issueDocument(c, id);
  return c.json({ ok: true, number });
});

documents.post("/:id/void", async (c) => {
  await access(c, c.req.param("id"), "void");
  const input = await body(c, z.object({ date: isoDate.optional(), reason: shortText(300).nullish() }));
  await voidDocument(c, c.req.param("id"), input.date ?? todayIso(), input.reason);
  return c.json({ ok: true });
});

/** Quote → sales order/invoice, sales order → invoice, purchase order → bill. Creates a draft. */
documents.post("/:id/convert", async (c) => {
  await access(c, c.req.param("id"), "create");
  const input = await body(c, z.object({ to: z.enum(["sales_order", "invoice", "bill", "credit_note", "debit_note"]) }));
  requirePerm(c, famPerm(input.to, "create"));
  const company = c.get("company");
  const { doc, lines } = await loadDoc(c.env.DB, company.id, c.req.param("id"));
  const allowed: Record<string, string[]> = {
    quote: ["sales_order", "invoice"], sales_order: ["invoice"], purchase_order: ["bill"], invoice: ["credit_note"], bill: ["debit_note"],
  };
  if (!allowed[doc.doc_type]?.includes(input.to)) throw badRequest(`A ${doc.doc_type.replace("_", " ")} cannot be converted to a ${input.to.replace("_", " ")}`);
  if (!["open", "accepted", "posted"].includes(doc.status)) throw conflict("NOT_ISSUED", "Issue the document before converting it");
  const full = await all<{ item_id: string | null; description: string; hsn_sac: string | null; qty_milli: number; unit_price: number; discount_bp: number; account_id: string | null; tax_code_id: string | null; department_id: string | null; project_id: string | null; cost_centre_id: string | null }>(
    c.env.DB, `SELECT * FROM document_lines WHERE document_id = ? ORDER BY line_no`, doc.id);
  void lines;
  const prepared = await prepareDraft(c, {
    doc_type: input.to, contact_id: doc.contact_id, issue_date: todayIso(), currency: doc.currency,
    fx_rate_scaled: doc.currency === company.base_currency ? null : doc.fx_rate_scaled,
    reference: doc.number, related_doc_id: doc.id, branch_id: doc.branch_id, warehouse_id: doc.warehouse_id,
    lines: full.map((l) => ({ ...l })),
  });
  const stmts = [...prepared.stmts];
  if (!POSTING_TYPES.includes(doc.doc_type)) {
    stmts.push(stmt(c.env.DB, `UPDATE documents SET status = 'converted' WHERE id = ? AND company_id = ? AND status IN ('open','accepted')`, doc.id, company.id));
  }
  stmts.push(audit(c, `${doc.doc_type}.convert`, "document", doc.id, { to: input.to, new_id: prepared.id }));
  await batch(c.env.DB, stmts);
  return c.json({ id: prepared.id }, 201);
});

documents.post("/:id/status", async (c) => {
  await access(c, c.req.param("id"), "create");
  const input = await body(c, z.object({ status: z.enum(["accepted", "declined", "closed", "open"]) }));
  const company = c.get("company");
  const d = await first<{ doc_type: string; status: string }>(c.env.DB, `SELECT doc_type, status FROM documents WHERE id = ? AND company_id = ?`, c.req.param("id"), company.id);
  if (!d) throw notFound("Document");
  if (POSTING_TYPES.includes(d.doc_type as DocType)) throw badRequest("Status of financial documents is managed by posting, payments and voiding");
  if (!["open", "accepted", "declined", "closed"].includes(d.status)) throw conflict("INVALID_STATUS", "This document's status cannot be changed");
  await batch(c.env.DB, [
    stmt(c.env.DB, `UPDATE documents SET status = ? WHERE id = ? AND company_id = ?`, input.status, c.req.param("id"), company.id),
    audit(c, `${d.doc_type}.status`, "document", c.req.param("id"), input),
  ]);
  return c.json({ ok: true });
});

/** Apply a credit/debit note to an invoice/bill. */
documents.post("/:id/apply", async (c) => {
  await access(c, c.req.param("id"), "post");
  const input = await body(c, z.object({ document_id: z.string(), amount: z.union([z.string(), z.number()]), date: isoDate.optional() }));
  const company = c.get("company");
  const note = await first<{ currency: string }>(c.env.DB, `SELECT currency FROM documents WHERE id = ? AND company_id = ?`, c.req.param("id"), company.id);
  if (!note) throw notFound("Note");
  await applyCredit(c, { kind: "note", id: c.req.param("id") }, input.document_id, minor(input.amount, currencyExponent(note.currency)), input.date ?? todayIso());
  return c.json({ ok: true });
});

/** Ask for approval of a purchase above the approval limit. */
documents.post("/:id/request-approval", async (c) => {
  const id = c.req.param("id");
  const d = await access(c, id, "create");
  if (docFamily(d.doc_type) !== "purchase") throw badRequest("Only purchases need approval");
  if (d.status !== "draft") throw conflict("INVALID_STATUS", "Only drafts can be sent for approval");
  const note = (await body(c, z.object({ note: shortText(300).nullish() }))).note ?? null;
  await batch(c.env.DB, [
    stmt(c.env.DB, `INSERT INTO document_approvals (document_id, company_id, requested_by, note) VALUES (?,?,?,?)
      ON CONFLICT (document_id) DO UPDATE SET requested_by = excluded.requested_by, requested_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), approved_by = NULL, approved_at = NULL, note = excluded.note`,
      id, c.get("company").id, c.get("user").id, note),
    audit(c, `${d.doc_type}.approval_requested`, "document", id, { note }),
  ]);
  return c.json({ ok: true });
});

/** Approve a purchase. Approvers cannot approve a request they made themselves (unless they are the owner). */
documents.post("/:id/approve", async (c) => {
  const id = c.req.param("id");
  const d = await access(c, id, "view");
  requirePerm(c, "purchase.approve");
  const req = await first<{ requested_by: string; approved_at: string | null }>(c.env.DB, `SELECT requested_by, approved_at FROM document_approvals WHERE document_id = ?`, id);
  if (!req) throw conflict("NOT_REQUESTED", "Approval has not been requested for this document");
  if (req.approved_at) throw conflict("ALREADY_APPROVED", "Already approved");
  if (req.requested_by === c.get("user").id && c.get("role") !== "owner") throw new AppError(403, "SELF_APPROVAL", "You cannot approve your own request");
  await batch(c.env.DB, [
    stmt(c.env.DB, `UPDATE document_approvals SET approved_by = ?, approved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE document_id = ?`, c.get("user").id, id),
    audit(c, `${d.doc_type}.approved`, "document", id),
  ]);
  return c.json({ ok: true });
});

export default documents;
