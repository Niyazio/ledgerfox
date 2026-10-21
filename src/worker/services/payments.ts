/**
 * Receipts and payments with allocation to invoices/bills.
 *
 * Receipt (direction "in"):  Dr Bank (amount @ payment rate)
 *                            Cr AR per allocation (amount @ invoice rate)
 *                            Cr AR unallocated advance (amount @ payment rate)
 *                            ± Exchange gain/loss for the rate difference
 * Payment ("out") mirrors this against AP.
 */
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { all, batch, bumpSequence, first, seqNumberExpr, stmt, nowIso } from "../lib/db";
import { newId } from "../lib/crypto";
import { badRequest, conflict, notFound, unprocessable } from "../lib/errors";
import { audit } from "../lib/auth";
import { buildJournal, buildReversal, systemAccounts, assertOpenPeriod, type LineInput } from "./ledger";
import { convertToBase, RATE_SCALE_NUM } from "@shared/money";
import { currencyExponent } from "@shared/currencies";
import { lookupRate } from "./documents";

export interface PaymentInput {
  direction: "in" | "out";
  contact_id: string;
  payment_date: string;
  account_id: string;
  currency?: string | null;
  fx_rate_scaled?: number | null;
  amount: number;
  method?: string | null;
  reference?: string | null;
  notes?: string | null;
  idempotency_key?: string | null;
  branch_id?: string | null;
  allocations: { document_id: string; amount: number }[];
}

export async function recordPayment(c: Context<AppEnv>, input: PaymentInput) {
  const db = c.env.DB;
  const company = c.get("company");
  const user = c.get("user");
  if (input.idempotency_key) {
    const dup = await first<{ id: string }>(db, `SELECT id FROM payments WHERE company_id = ? AND idempotency_key = ?`, company.id, input.idempotency_key);
    if (dup) return { id: dup.id, duplicate: true };
  }
  const contact = await first<{ id: string; kind: string; currency: string | null }>(db, `SELECT id, kind, currency FROM contacts WHERE id = ? AND company_id = ?`, input.contact_id, company.id);
  if (!contact) throw badRequest("Contact not found");
  const bank = await first<{ subtype: string; is_group: number; is_active: number }>(db, `SELECT subtype, is_group, is_active FROM accounts WHERE id = ? AND company_id = ?`, input.account_id, company.id);
  if (!bank || bank.is_group || !bank.is_active || !["cash", "bank"].includes(bank.subtype)) throw badRequest("Choose an active cash or bank account");
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw badRequest("Amount must be positive");
  await assertOpenPeriod(db, company.id, input.payment_date);

  const currency = input.currency || contact.currency || company.base_currency;
  const exp = currencyExponent(currency);
  const baseExp = currencyExponent(company.base_currency);
  let fx = currency === company.base_currency ? RATE_SCALE_NUM : input.fx_rate_scaled ?? (await lookupRate(db, company, currency, input.payment_date));
  if (!fx) throw unprocessable("RATE_REQUIRED", `Enter the ${currency} exchange rate for ${input.payment_date}`);
  fx = Number(fx);

  const docType = input.direction === "in" ? "invoice" : "bill";
  const allocated = input.allocations.reduce((s, a) => s + a.amount, 0);
  if (allocated > input.amount) throw unprocessable("OVER_ALLOCATED", "Allocations exceed the payment amount");
  const seen = new Set<string>();
  const docs: { id: string; fx_rate_scaled: number; amount: number }[] = [];
  for (const a of input.allocations) {
    if (!Number.isSafeInteger(a.amount) || a.amount <= 0) throw badRequest("Allocation amounts must be positive");
    if (seen.has(a.document_id)) throw badRequest("A document appears twice in the allocations");
    seen.add(a.document_id);
    const d = await first<{ id: string; doc_type: string; status: string; contact_id: string; currency: string; total: number; amount_settled: number; fx_rate_scaled: number; number: string }>(
      db, `SELECT * FROM documents WHERE id = ? AND company_id = ?`, a.document_id, company.id,
    );
    if (!d) throw badRequest("Allocated document not found");
    if (d.doc_type !== docType || d.status !== "posted") throw unprocessable("ALLOCATION_INVALID", `${d.number ?? "Document"} cannot receive this payment`);
    if (d.contact_id !== input.contact_id) throw unprocessable("ALLOCATION_INVALID", `${d.number} belongs to a different contact`);
    if (d.currency !== currency) throw unprocessable("ALLOCATION_INVALID", `${d.number} is in ${d.currency}; record the payment in the same currency`);
    if (a.amount > d.total - d.amount_settled) throw unprocessable("OVER_ALLOCATED", `${d.number}: allocation exceeds the outstanding balance`);
    docs.push({ id: d.id, fx_rate_scaled: d.fx_rate_scaled, amount: a.amount });
  }

  const acc = await systemAccounts(db, company.id, ["AR", "AP", "FX_GAIN_LOSS"]);
  const control = input.direction === "in" ? acc.AR : acc.AP;
  const cashSide: "debit" | "credit" = input.direction === "in" ? "debit" : "credit";
  const ctrlSide: "debit" | "credit" = input.direction === "in" ? "credit" : "debit";
  const amountBase = convertToBase(input.amount, fx, exp, baseExp);
  const lines: LineInput[] = [{ account_id: input.account_id, [cashSide]: amountBase, currency, fx_rate_scaled: fx, amount_fc: input.amount, description: input.reference ?? null }];
  let controlBase = 0;
  for (const d of docs) {
    const b = convertToBase(d.amount, d.fx_rate_scaled, exp, baseExp);
    controlBase += b;
    lines.push({ account_id: control, [ctrlSide]: b, contact_id: input.contact_id, currency, fx_rate_scaled: d.fx_rate_scaled, amount_fc: d.amount, description: "Settlement" });
  }
  const unallocated = input.amount - allocated;
  if (unallocated > 0) {
    const b = convertToBase(unallocated, fx, exp, baseExp);
    controlBase += b;
    lines.push({ account_id: control, [ctrlSide]: b, contact_id: input.contact_id, currency, fx_rate_scaled: fx, amount_fc: unallocated, description: "Advance / unapplied" });
  }
  const fxDiff = amountBase - controlBase; // receipt: positive = gain (credit); payment: positive = loss (debit)
  if (fxDiff !== 0) {
    // A positive difference needs extra on the control side, a negative one on the cash side.
    lines.push(fxDiff > 0
      ? { account_id: acc.FX_GAIN_LOSS, [ctrlSide]: fxDiff, description: "Realised exchange difference" }
      : { account_id: acc.FX_GAIN_LOSS, [cashSide]: -fxDiff, description: "Realised exchange difference" });
  }

  const id = newId();
  const seqKey = input.direction === "in" ? "payment_in" : "payment_out";
  const built = buildJournal(db, {
    company_id: company.id, entry_date: input.payment_date, kind: "system",
    memo: `${input.direction === "in" ? "Receipt" : "Payment"}${input.reference ? ` ${input.reference}` : ""}`,
    source_type: input.direction === "in" ? "receipt" : "payment", source_id: id, branch_id: input.branch_id ?? null, created_by: user.id, post: true, lines,
  });
  const stmts: D1PreparedStatement[] = [
    ...built.stmts,
    ...bumpSequence(db, company.id, seqKey, input.direction === "in" ? "RCPT-" : "PAY-"),
    stmt(db,
      `INSERT INTO payments (id, company_id, direction, number, contact_id, payment_date, account_id, currency, fx_rate_scaled, amount, amount_base,
         method, reference, notes, status, journal_entry_id, idempotency_key, created_by, branch_id)
       VALUES (?,?,?,${seqNumberExpr()},?,?,?,?,?,?,?,?,?,?,'posted',?,?,?,?)`,
      id, company.id, input.direction, company.id, seqKey, input.contact_id, input.payment_date, input.account_id, currency, fx, input.amount, amountBase,
      input.method ?? null, input.reference ?? null, input.notes ?? null, built.id, input.idempotency_key ?? null, user.id, input.branch_id ?? null),
  ];
  for (const d of docs) {
    stmts.push(stmt(db, `INSERT INTO allocations (id, company_id, source_kind, payment_id, document_id, amount, allocation_date, created_by) VALUES (?,?,?,?,?,?,?,?)`,
      newId(), company.id, "payment", id, d.id, d.amount, input.payment_date, user.id));
  }
  stmts.push(audit(c, input.direction === "in" ? "receipt.create" : "payment.create", "payment", id, { amount: input.amount, currency, allocations: docs.length }));
  await batch(db, stmts);
  return { id, journal_id: built.id };
}

/**
 * Apply an existing unapplied payment (advance) or a credit/debit note to an open invoice/bill.
 * When the source and target were booked at different exchange rates, the difference is posted to Exchange Gain/Loss.
 */
export async function applyCredit(c: Context<AppEnv>, src: { kind: "payment" | "note"; id: string }, documentId: string, amount: number, date: string) {
  const db = c.env.DB;
  const company = c.get("company");
  const user = c.get("user");
  if (!Number.isSafeInteger(amount) || amount <= 0) throw badRequest("Amount must be positive");
  const doc = await first<{ id: string; doc_type: string; status: string; contact_id: string; currency: string; total: number; amount_settled: number; fx_rate_scaled: number }>(
    db, `SELECT * FROM documents WHERE id = ? AND company_id = ?`, documentId, company.id,
  );
  if (!doc) throw notFound("Document");
  if (amount > doc.total - doc.amount_settled) throw unprocessable("OVER_ALLOCATED", "Amount exceeds the document's outstanding balance");
  let srcRate: number;
  let srcContact: string;
  let srcCurrency: string;
  let direction: "in" | "out";
  if (src.kind === "payment") {
    const p = await first<{ id: string; direction: "in" | "out"; contact_id: string; currency: string; fx_rate_scaled: number; amount: number; status: string }>(
      db, `SELECT * FROM payments WHERE id = ? AND company_id = ?`, src.id, company.id,
    );
    if (!p) throw notFound("Payment");
    if (p.status !== "posted") throw conflict("VOID", "Payment is void");
    const used = await first<{ s: number }>(db, `SELECT COALESCE(SUM(amount),0) AS s FROM allocations WHERE payment_id = ?`, p.id);
    if (amount > p.amount - (used?.s ?? 0)) throw unprocessable("OVER_ALLOCATED", "Amount exceeds the unapplied balance of the payment");
    srcRate = p.fx_rate_scaled; srcContact = p.contact_id; srcCurrency = p.currency; direction = p.direction;
  } else {
    const n = await first<{ id: string; doc_type: string; status: string; contact_id: string; currency: string; fx_rate_scaled: number; total: number; amount_settled: number }>(
      db, `SELECT * FROM documents WHERE id = ? AND company_id = ?`, src.id, company.id,
    );
    if (!n || !["credit_note", "debit_note"].includes(n.doc_type)) throw notFound("Credit/debit note");
    if (n.status !== "posted") throw conflict("NOT_POSTED", "The note is not posted");
    if (amount > n.total - n.amount_settled) throw unprocessable("OVER_ALLOCATED", "Amount exceeds the unapplied balance of the note");
    srcRate = n.fx_rate_scaled; srcContact = n.contact_id; srcCurrency = n.currency; direction = n.doc_type === "credit_note" ? "in" : "out";
  }
  if (srcContact !== doc.contact_id || srcCurrency !== doc.currency) throw unprocessable("ALLOCATION_INVALID", "Contact and currency must match");
  if ((direction === "in" && doc.doc_type !== "invoice") || (direction === "out" && doc.doc_type !== "bill")) throw unprocessable("ALLOCATION_INVALID", "Cannot apply to this document type");

  const stmts: D1PreparedStatement[] = [];
  const exp = currencyExponent(doc.currency);
  const baseExp = currencyExponent(company.base_currency);
  const diff = convertToBase(amount, srcRate, exp, baseExp) - convertToBase(amount, doc.fx_rate_scaled, exp, baseExp);
  if (diff !== 0) {
    await assertOpenPeriod(db, company.id, date);
    const acc = await systemAccounts(db, company.id, ["AR", "AP", "FX_GAIN_LOSS"]);
    const control = direction === "in" ? acc.AR : acc.AP;
    // Receivable side: the advance sits as a credit at srcRate; the invoice as a debit at docRate.
    // Clearing both leaves `diff` (positive for "in" = gain). Payables mirror.
    const gain = direction === "in" ? diff : -diff;
    const built = buildJournal(db, {
      company_id: company.id, entry_date: date, kind: "system", memo: "Exchange difference on settlement",
      source_type: "fx_settlement", source_id: newId(), created_by: user.id, post: true,
      lines: gain > 0
        ? [{ account_id: control, debit: gain, contact_id: doc.contact_id }, { account_id: acc.FX_GAIN_LOSS, credit: gain }]
        : [{ account_id: acc.FX_GAIN_LOSS, debit: -gain }, { account_id: control, credit: -gain, contact_id: doc.contact_id }],
    });
    stmts.push(...built.stmts);
  }
  stmts.push(src.kind === "payment"
    ? stmt(db, `INSERT INTO allocations (id, company_id, source_kind, payment_id, document_id, amount, allocation_date, created_by) VALUES (?,?,?,?,?,?,?,?)`,
        newId(), company.id, "payment", src.id, documentId, amount, date, user.id)
    : stmt(db, `INSERT INTO allocations (id, company_id, source_kind, note_id, document_id, amount, allocation_date, created_by) VALUES (?,?,?,?,?,?,?,?)`,
        newId(), company.id, direction === "in" ? "credit_note" : "debit_note", src.id, documentId, amount, date, user.id));
  stmts.push(audit(c, "allocation.create", "document", documentId, { source: src, amount }));
  await batch(db, stmts);
}

export async function voidPayment(c: Context<AppEnv>, id: string, date: string, reason?: string | null) {
  const db = c.env.DB;
  const company = c.get("company");
  const user = c.get("user");
  const p = await first<{ id: string; status: string; journal_entry_id: string; number: string; direction: string }>(db, `SELECT * FROM payments WHERE id = ? AND company_id = ?`, id, company.id);
  if (!p) throw notFound("Payment");
  if (p.status === "void") throw conflict("ALREADY_VOID", "Payment is already void");
  const matched = await first(db, `SELECT 1 FROM bank_statement_lines WHERE matched_line_id IN (SELECT id FROM journal_lines WHERE entry_id = ?) AND reconciliation_id IS NOT NULL`, p.journal_entry_id);
  if (matched) throw conflict("RECONCILED", "This payment is part of a completed bank reconciliation and cannot be voided");
  const rev = await buildReversal(db, company.id, p.journal_entry_id, date, user.id, `Void ${p.number}${reason ? ` — ${reason}` : ""}`, { allowSourced: true });
  const allocs = await all<{ id: string; amount: number; document_id: string }>(
    db, `SELECT a.id, a.amount, a.document_id FROM allocations a WHERE a.payment_id = ? AND a.amount > 0 AND NOT EXISTS (SELECT 1 FROM allocations r WHERE r.reverses_id = a.id)`, id,
  );
  const stmts = [...rev.stmts];
  for (const a of allocs) {
    stmts.push(stmt(db, `INSERT INTO allocations (id, company_id, source_kind, payment_id, document_id, amount, reverses_id, allocation_date, created_by) VALUES (?,?,?,?,?,?,?,?,?)`,
      newId(), company.id, "payment", id, a.document_id, -a.amount, a.id, date, user.id));
  }
  stmts.push(stmt(db, `UPDATE bank_statement_lines SET status = 'unmatched', matched_line_id = NULL WHERE company_id = ? AND matched_line_id IN (SELECT id FROM journal_lines WHERE entry_id = ?) AND reconciliation_id IS NULL`, company.id, p.journal_entry_id));
  stmts.push(stmt(db, `UPDATE payments SET status = 'void' WHERE id = ? AND company_id = ?`, id, company.id));
  stmts.push(audit(c, "payment.void", "payment", id, { reason, reversal_id: rev.id, at: nowIso() }));
  await batch(db, stmts);
}
