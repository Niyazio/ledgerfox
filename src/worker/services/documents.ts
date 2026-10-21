/**
 * Sales & purchase documents.
 *
 * Posting rules (all amounts converted to base currency per component, receivable/payable = sum so the
 * entry always balances in base):
 *   invoice      Dr AR            / Cr income, Cr output tax (CGST/SGST/IGST or generic), ± round-off; Dr COGS / Cr Inventory for tracked goods
 *   credit_note  Dr income, Dr output tax / Cr AR;  Dr Inventory / Cr COGS for returned tracked goods
 *   bill         Dr expense or Inventory, Dr input tax / Cr AP
 *   debit_note   Dr AP / Cr expense or Inventory (at average cost, difference to inventory adjustments), Cr input tax
 * Quotes, sales orders and purchase orders are non-posting.
 */
import type { Context } from "hono";
import type { AppEnv, CompanyRow } from "../env";
import { all, batch, bumpSequence, first, nowIso, seqNumberExpr, stmt } from "../lib/db";
import { newId } from "../lib/crypto";
import { badRequest, conflict, notFound, unprocessable } from "../lib/errors";
import { audit } from "../lib/auth";
import { buildJournal, buildReversal, systemAccounts, assertOpenPeriod, type LineInput } from "./ledger";
import { companyPosition, defaultWarehouse, planIssues, stockMoveStmt } from "./inventory";
import { computeDocument, resolveTaxMode, schemeForCountry, type TaxCodeLike, type TaxMode } from "@shared/tax";
import { convertToBase, roundToWhole, RATE_SCALE_NUM, divRound } from "@shared/money";
import { currencyExponent } from "@shared/currencies";

export type DocType = "quote" | "sales_order" | "invoice" | "credit_note" | "purchase_order" | "bill" | "debit_note";
export const SALES_TYPES: DocType[] = ["quote", "sales_order", "invoice", "credit_note"];
export const PURCHASE_TYPES: DocType[] = ["purchase_order", "bill", "debit_note"];
export const POSTING_TYPES: DocType[] = ["invoice", "credit_note", "bill", "debit_note"];

export function isSales(t: DocType) {
  return SALES_TYPES.includes(t);
}

export interface DraftLine {
  item_id?: string | null;
  description: string;
  hsn_sac?: string | null;
  qty_milli: number;
  unit_price: number;
  discount_bp: number;
  account_id?: string | null;
  tax_code_id?: string | null;
  department_id?: string | null;
  project_id?: string | null;
  cost_centre_id?: string | null;
}

export interface DraftInput {
  doc_type: DocType;
  contact_id: string;
  issue_date: string;
  due_date?: string | null;
  currency?: string | null;
  fx_rate_scaled?: number | null;
  place_of_supply?: string | null;
  reference?: string | null;
  notes?: string | null;
  terms?: string | null;
  related_doc_id?: string | null;
  branch_id?: string | null;
  warehouse_id?: string | null;
  lines: DraftLine[];
}

function addDays(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function lookupRate(db: D1Database, company: CompanyRow, currency: string, date: string): Promise<number | null> {
  if (currency === company.base_currency) return RATE_SCALE_NUM;
  const r = await first<{ rate_scaled: number }>(
    db, `SELECT rate_scaled FROM exchange_rates WHERE company_id = ? AND currency = ? AND rate_date <= ? ORDER BY rate_date DESC LIMIT 1`, company.id, currency, date,
  );
  return r?.rate_scaled ?? null;
}

async function loadTaxCodes(db: D1Database, companyId: string, ids: string[]): Promise<Map<string, TaxCodeLike & { is_active: number }>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const rows = await all<TaxCodeLike & { is_active: number }>(
    db, `SELECT id, scheme, rate_bp, category, is_active FROM tax_codes WHERE company_id = ? AND id IN (${unique.map(() => "?").join(",")})`, companyId, ...unique,
  );
  if (rows.length !== unique.length) throw badRequest("Unknown tax code");
  return new Map(rows.map((r) => [r.id, r]));
}

/** Compute and validate a draft; returns statements to persist it plus the computed totals. */
export async function prepareDraft(c: Context<AppEnv>, input: DraftInput, existingId?: string) {
  const db = c.env.DB;
  const company = c.get("company");
  const contact = await first<{ id: string; kind: string; state_code: string | null; currency: string | null; payment_terms_days: number; is_active: number; country: string | null }>(
    db, `SELECT * FROM contacts WHERE id = ? AND company_id = ?`, input.contact_id, company.id,
  );
  if (!contact) throw badRequest("Contact not found");
  const sales = isSales(input.doc_type);
  if (sales && contact.kind === "supplier") throw badRequest("Choose a customer for sales documents");
  if (!sales && contact.kind === "customer") throw badRequest("Choose a supplier for purchase documents");
  if (!input.lines.length) throw badRequest("Add at least one line");
  if (input.lines.length > 200) throw badRequest("A document can have at most 200 lines");

  const currency = input.currency || contact.currency || company.base_currency;
  currencyExponent(currency); // validates
  let fx = input.fx_rate_scaled ?? null;
  if (currency === company.base_currency) fx = RATE_SCALE_NUM;
  if (!fx) fx = await lookupRate(db, company, currency, input.issue_date);
  if (!fx) throw unprocessable("RATE_REQUIRED", `Enter the ${currency} → ${company.base_currency} exchange rate for ${input.issue_date}`);

  const scheme = schemeForCountry(company.country);
  const pos = input.place_of_supply ?? (sales ? contact.state_code : company.state_code) ?? company.state_code;
  const mode: TaxMode = sales
    ? resolveTaxMode(scheme, company.state_code, pos)
    : resolveTaxMode(scheme, contact.state_code ?? company.state_code, company.state_code);

  const taxCodes = await loadTaxCodes(db, company.id, input.lines.map((l) => l.tax_code_id ?? "").filter(Boolean));
  for (const l of input.lines) {
    if (l.item_id && !(await first(db, `SELECT 1 FROM items WHERE id = ? AND company_id = ?`, l.item_id, company.id))) throw badRequest("Item not found");
    if (l.account_id && !(await first(db, `SELECT 1 FROM accounts WHERE id = ? AND company_id = ? AND is_group = 0`, l.account_id, company.id))) throw badRequest("Line account not found or is a group");
  }
  const totals = computeDocument(
    input.lines.map((l) => ({ qty_milli: l.qty_milli, unit_price: l.unit_price, discount_bp: l.discount_bp, tax: l.tax_code_id ? taxCodes.get(l.tax_code_id) : null })),
    mode,
  );
  const exp = currencyExponent(currency);
  const roundOff = company.round_off_invoices && (input.doc_type === "invoice" || input.doc_type === "credit_note")
    ? roundToWhole(totals.total_before_round, exp) - totals.total_before_round : 0;
  const total = totals.total_before_round + roundOff;
  const totalBase = convertToBase(total, fx, exp, currencyExponent(company.base_currency));
  const due = input.due_date ?? (["invoice", "bill"].includes(input.doc_type) ? addDays(input.issue_date, contact.payment_terms_days) : null);

  if (input.related_doc_id) {
    const rel = await first(db, `SELECT 1 FROM documents WHERE id = ? AND company_id = ? AND contact_id = ?`, input.related_doc_id, company.id, input.contact_id);
    if (!rel) throw badRequest("Related document not found for this contact");
  }
  if (input.warehouse_id && !(await first(db, `SELECT 1 FROM warehouses WHERE id = ? AND company_id = ?`, input.warehouse_id, company.id))) throw badRequest("Warehouse not found");

  const id = existingId ?? newId();
  const stmts: D1PreparedStatement[] = [];
  if (existingId) {
    stmts.push(stmt(db, `DELETE FROM document_lines WHERE document_id = ? AND company_id = ?`, id, company.id));
    stmts.push(stmt(db,
      `UPDATE documents SET contact_id = ?, issue_date = ?, due_date = ?, currency = ?, fx_rate_scaled = ?, place_of_supply = ?, tax_mode = ?,
         reference = ?, subtotal = ?, discount_total = ?, tax_total = ?, round_off = ?, total = ?, total_base = ?, notes = ?, terms = ?,
         related_doc_id = ?, branch_id = ?, warehouse_id = ?, updated_at = ?
       WHERE id = ? AND company_id = ? AND status = 'draft'`,
      input.contact_id, input.issue_date, due, currency, fx, pos ?? null, mode, input.reference ?? null, totals.subtotal, totals.discount_total,
      totals.tax_total, roundOff, total, totalBase, input.notes ?? null, input.terms ?? null, input.related_doc_id ?? null,
      input.branch_id ?? null, input.warehouse_id ?? null, nowIso(), id, company.id));
  } else {
    stmts.push(stmt(db,
      `INSERT INTO documents (id, company_id, doc_type, contact_id, issue_date, due_date, status, currency, fx_rate_scaled, place_of_supply, tax_mode,
         reference, subtotal, discount_total, tax_total, round_off, total, total_base, notes, terms, related_doc_id, branch_id, warehouse_id, created_by)
       VALUES (?,?,?,?,?,?,'draft',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, company.id, input.doc_type, input.contact_id, input.issue_date, due, currency, fx, pos ?? null, mode, input.reference ?? null,
      totals.subtotal, totals.discount_total, totals.tax_total, roundOff, total, totalBase, input.notes ?? null, input.terms ?? null,
      input.related_doc_id ?? null, input.branch_id ?? null, input.warehouse_id ?? null, c.get("user").id));
  }
  input.lines.forEach((l, i) => {
    const t = totals.lines[i];
    stmts.push(stmt(db,
      `INSERT INTO document_lines (id, document_id, company_id, line_no, item_id, description, hsn_sac, qty_milli, unit_price, discount_bp, account_id,
         tax_code_id, taxable, cgst, sgst, igst, other_tax, line_total, department_id, project_id, cost_centre_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      newId(), id, company.id, i + 1, l.item_id ?? null, l.description, l.hsn_sac ?? null, l.qty_milli, l.unit_price, l.discount_bp,
      l.account_id ?? null, l.tax_code_id ?? null, t.taxable, t.cgst, t.sgst, t.igst, t.other_tax, t.line_total,
      l.department_id ?? null, l.project_id ?? null, l.cost_centre_id ?? null));
  });
  return { id, stmts, totals: { ...totals, round_off: roundOff, total, total_base: totalBase }, mode, currency, fx };
}

interface DocRow {
  id: string; company_id: string; doc_type: DocType; number: string | null; contact_id: string; issue_date: string; status: string;
  currency: string; fx_rate_scaled: number; tax_mode: TaxMode; total: number; round_off: number; amount_settled: number;
  related_doc_id: string | null; journal_entry_id: string | null; branch_id: string | null; warehouse_id: string | null; reference: string | null;
}

interface DocLineRow {
  id: string; item_id: string | null; description: string; qty_milli: number; account_id: string | null; tax_code_id: string | null;
  taxable: number; cgst: number; sgst: number; igst: number; other_tax: number;
  department_id: string | null; project_id: string | null; cost_centre_id: string | null;
  item_kind: string | null; track_inventory: number | null; item_name: string | null;
  income_account_id: string | null; expense_account_id: string | null; purchase_price: number | null;
}

export async function loadDoc(db: D1Database, companyId: string, id: string) {
  const doc = await first<DocRow>(db, `SELECT * FROM documents WHERE id = ? AND company_id = ?`, id, companyId);
  if (!doc) throw notFound("Document");
  const lines = await all<DocLineRow>(db,
    `SELECT l.*, i.kind AS item_kind, i.track_inventory, i.name AS item_name, i.income_account_id, i.expense_account_id, i.purchase_price
     FROM document_lines l LEFT JOIN items i ON i.id = l.item_id WHERE l.document_id = ? ORDER BY l.line_no`, id);
  return { doc, lines };
}

/** Issue (number + post) a draft. Returns the new document number. */
export async function issueDocument(c: Context<AppEnv>, id: string) {
  const db = c.env.DB;
  const company = c.get("company");
  const user = c.get("user");
  const { doc, lines } = await loadDoc(db, company.id, id);
  if (doc.status !== "draft") throw conflict("ALREADY_ISSUED", "Only drafts can be issued");
  if (!lines.length) throw badRequest("Add at least one line");

  // Branches with their own prefix number their documents separately, e.g. BLR-INV-0001.
  const branch = doc.branch_id ? await first<{ invoice_prefix: string | null }>(db, `SELECT invoice_prefix FROM branches WHERE id = ? AND company_id = ?`, doc.branch_id, company.id) : null;
  const seqKey = branch?.invoice_prefix ? `${doc.doc_type}@${doc.branch_id}` : doc.doc_type;
  const numberStmts = [
    ...bumpSequence(db, company.id, seqKey, `${branch?.invoice_prefix ? `${branch.invoice_prefix}-` : ""}${doc.doc_type.toUpperCase().slice(0, 3)}-`),
  ];

  if (!POSTING_TYPES.includes(doc.doc_type)) {
    await batch(db, [
      ...numberStmts,
      stmt(db, `UPDATE documents SET status = 'open', number = ${seqNumberExpr()}, posted_by = ?, posted_at = ?, updated_at = ? WHERE id = ? AND company_id = ? AND status = 'draft'`,
        company.id, seqKey, user.id, nowIso(), nowIso(), id, company.id),
      audit(c, `${doc.doc_type}.issue`, "document", id),
    ]);
    return (await first<{ number: string }>(db, `SELECT number FROM documents WHERE id = ?`, id))?.number;
  }

  await assertOpenPeriod(db, company.id, doc.issue_date);
  const baseExp = currencyExponent(company.base_currency);
  const exp = currencyExponent(doc.currency);
  const toBase = (v: number) => convertToBase(v, doc.fx_rate_scaled, exp, baseExp);
  const sales = doc.doc_type === "invoice" || doc.doc_type === "credit_note";
  const reverseSide = doc.doc_type === "credit_note" || doc.doc_type === "debit_note";
  const acc = await systemAccounts(db, company.id, [
    "AR", "AP", "SALES", "SERVICE_INCOME", "PURCHASES", "INVENTORY", "COGS", "INV_ADJ", "ROUND_OFF",
    ...(schemeForCountry(company.country) === "in_gst"
      ? (sales ? ["OUT_CGST", "OUT_SGST", "OUT_IGST"] : ["IN_CGST", "IN_SGST", "IN_IGST"])
      : [sales ? "OUT_TAX" : "IN_TAX"]),
  ]);
  const taxAcc = sales
    ? { cgst: acc.OUT_CGST, sgst: acc.OUT_SGST, igst: acc.OUT_IGST, other: acc.OUT_TAX }
    : { cgst: acc.IN_CGST, sgst: acc.IN_SGST, igst: acc.IN_IGST, other: acc.IN_TAX };

  // "Natural" side of the revenue/expense lines: invoice→credit, credit_note→debit, bill→debit, debit_note→credit.
  const lineSide: "debit" | "credit" = sales ? (reverseSide ? "debit" : "credit") : (reverseSide ? "credit" : "debit");
  const ledger: LineInput[] = [];
  const add = (account: string, amount: number, side: "debit" | "credit", extra: Partial<LineInput> = {}) => {
    if (!amount) return;
    if (amount < 0) { side = side === "debit" ? "credit" : "debit"; amount = -amount; }
    ledger.push({ account_id: account, [side]: amount, ...extra });
  };

  const warehouseId = doc.warehouse_id ?? (lines.some((l) => l.track_inventory) ? await defaultWarehouse(db, company.id) : null);
  const stockMoves: { item_id: string; qty_milli: number; value: number }[] = [];
  const cogs: { amount: number }[] = [];

  // Inventory planning for issues (invoice / debit note) — costed at moving average.
  const tracked = lines.filter((l) => l.track_inventory && l.item_id);
  const issuing = doc.doc_type === "invoice" || doc.doc_type === "debit_note";
  const issuePlan = issuing && tracked.length
    ? await planIssues(db, company.id, tracked.map((l) => ({ item_id: l.item_id!, qty_milli: l.qty_milli, warehouse_id: warehouseId!, name: l.item_name ?? l.description })))
    : [];
  let issueIdx = 0;

  for (const l of lines) {
    const taxableBase = toBase(l.taxable);
    const dims = { department_id: l.department_id, project_id: l.project_id, cost_centre_id: l.cost_centre_id, tax_code_id: l.tax_code_id, description: l.description, branch_id: doc.branch_id };
    const isTracked = Boolean(l.track_inventory && l.item_id);
    if (sales) {
      const account = l.account_id ?? l.income_account_id ?? (l.item_kind === "service" ? acc.SERVICE_INCOME : acc.SALES);
      add(account, taxableBase, lineSide, dims);
      if (isTracked) {
        if (doc.doc_type === "invoice") {
          const plan = issuePlan[issueIdx++];
          stockMoves.push({ item_id: l.item_id!, qty_milli: -l.qty_milli, value: -plan.value });
          cogs.push({ amount: plan.value });
          add(acc.COGS, plan.value, "debit", { description: `COGS: ${l.description}` });
          add(acc.INVENTORY, plan.value, "credit", { description: `Stock out: ${l.description}` });
        } else {
          // Sales return: restock at current average cost (or the item's purchase price if no stock remains).
          const posn = await companyPosition(db, company.id, l.item_id!);
          const value = posn.qty_milli > 0
            ? Number(divRound(BigInt(posn.value) * BigInt(l.qty_milli), BigInt(posn.qty_milli)))
            : Number(divRound(BigInt(l.purchase_price ?? 0) * BigInt(l.qty_milli), 1000n));
          stockMoves.push({ item_id: l.item_id!, qty_milli: l.qty_milli, value });
          add(acc.INVENTORY, value, "debit", { description: `Stock returned: ${l.description}` });
          add(acc.COGS, value, "credit", { description: `COGS reversal: ${l.description}` });
        }
      }
    } else {
      const account = isTracked ? acc.INVENTORY : (l.account_id ?? l.expense_account_id ?? acc.PURCHASES);
      if (isTracked && doc.doc_type === "debit_note") {
        const plan = issuePlan[issueIdx++];
        stockMoves.push({ item_id: l.item_id!, qty_milli: -l.qty_milli, value: -plan.value });
        add(acc.INVENTORY, plan.value, "credit", dims);
        add(acc.INV_ADJ, taxableBase - plan.value, "credit", { description: `Purchase return price difference: ${l.description}` });
      } else {
        add(account, taxableBase, lineSide, dims);
        if (isTracked) stockMoves.push({ item_id: l.item_id!, qty_milli: l.qty_milli, value: taxableBase });
      }
    }
    add(taxAcc.cgst, toBase(l.cgst), lineSide, { tax_code_id: l.tax_code_id, description: "CGST" });
    add(taxAcc.sgst, toBase(l.sgst), lineSide, { tax_code_id: l.tax_code_id, description: "SGST" });
    add(taxAcc.igst, toBase(l.igst), lineSide, { tax_code_id: l.tax_code_id, description: "IGST" });
    add(taxAcc.other, toBase(l.other_tax), lineSide, { tax_code_id: l.tax_code_id, description: "Tax" });
  }
  // Round-off adjusts the receivable; posted to the Round Off account on the revenue side.
  if (doc.round_off) add(acc.ROUND_OFF, toBase(doc.round_off), lineSide, { description: "Rounding off" });

  // Control account (AR/AP) balances the entry in base currency.
  const dr = ledger.reduce((s, l) => s + (l.debit ?? 0), 0);
  const cr = ledger.reduce((s, l) => s + (l.credit ?? 0), 0);
  const control = sales ? acc.AR : acc.AP;
  const diff = dr - cr; // positive → control must be credited
  const controlLine: LineInput = {
    account_id: control, contact_id: doc.contact_id, currency: doc.currency, fx_rate_scaled: doc.fx_rate_scaled, amount_fc: doc.total,
    description: `${doc.doc_type.replace("_", " ")} ${doc.reference ?? ""}`.trim(),
    ...(diff > 0 ? { credit: diff } : { debit: -diff }),
  };
  if (diff === 0) throw unprocessable("ZERO_DOCUMENT", "Document total cannot be zero");
  ledger.unshift(controlLine);

  const built = buildJournal(db, {
    company_id: company.id, entry_date: doc.issue_date, kind: "system", memo: `${labelFor(doc.doc_type)} ${doc.reference ? `(${doc.reference})` : ""}`.trim(),
    source_type: doc.doc_type, source_id: doc.id, branch_id: doc.branch_id, created_by: user.id, post: true, lines: ledger,
  });

  // Order: number the document, insert the journal header, label it with the number, then lines + post.
  const [header, ...rest] = built.stmts;
  const stmts: D1PreparedStatement[] = [
    ...numberStmts,
    stmt(db, `UPDATE documents SET number = ${seqNumberExpr()} WHERE id = ? AND company_id = ? AND status = 'draft'`, company.id, seqKey, id, company.id),
    header,
    stmt(db, `UPDATE journal_entries SET memo = memo || ' ' || (SELECT number FROM documents WHERE id = ?) WHERE id = ? AND status = 'draft'`, id, built.id),
    ...rest,
    stmt(db, `UPDATE documents SET status = 'posted', journal_entry_id = ?, posted_by = ?, posted_at = ?, updated_at = ? WHERE id = ? AND company_id = ? AND status = 'draft'`,
      built.id, user.id, nowIso(), nowIso(), id, company.id),
  ];
  for (const m of stockMoves) {
    stmts.push(stockMoveStmt(db, {
      company_id: company.id, item_id: m.item_id, warehouse_id: warehouseId!, move_date: doc.issue_date, qty_milli: m.qty_milli, value: m.value,
      kind: doc.doc_type === "invoice" ? "sale" : doc.doc_type === "bill" ? "purchase" : doc.doc_type === "credit_note" ? "return_in" : "return_out",
      source_type: doc.doc_type, source_id: doc.id, journal_entry_id: built.id, created_by: user.id,
    }));
  }
  // Credit/debit notes linked to an original document are applied against it immediately (up to its balance).
  if (reverseSide && doc.related_doc_id) {
    const orig = await first<{ total: number; amount_settled: number; status: string; doc_type: string; currency: string }>(
      db, `SELECT total, amount_settled, status, doc_type, currency FROM documents WHERE id = ? AND company_id = ?`, doc.related_doc_id, company.id,
    );
    const expected = doc.doc_type === "credit_note" ? "invoice" : "bill";
    if (orig && orig.status === "posted" && orig.doc_type === expected && orig.currency === doc.currency) {
      const amt = Math.min(doc.total, orig.total - orig.amount_settled);
      if (amt > 0) {
        stmts.push(stmt(db,
          `INSERT INTO allocations (id, company_id, source_kind, note_id, document_id, amount, allocation_date, created_by) VALUES (?,?,?,?,?,?,?,?)`,
          newId(), company.id, doc.doc_type, id, doc.related_doc_id, amt, doc.issue_date, user.id));
      }
    }
  }
  stmts.push(audit(c, `${doc.doc_type}.post`, "document", id, { total: doc.total, currency: doc.currency }));
  await batch(db, stmts);
  return (await first<{ number: string }>(db, `SELECT number FROM documents WHERE id = ?`, id))?.number;
}

export function labelFor(t: DocType) {
  return ({ quote: "Quotation", sales_order: "Sales order", invoice: "Sales invoice", credit_note: "Credit note", purchase_order: "Purchase order", bill: "Supplier bill", debit_note: "Debit note" } as const)[t];
}

/** Void a posted document (no settlements) by reversing its journal and stock; or cancel a non-posting doc. */
export async function voidDocument(c: Context<AppEnv>, id: string, date: string, reason?: string | null) {
  const db = c.env.DB;
  const company = c.get("company");
  const user = c.get("user");
  const { doc } = await loadDoc(db, company.id, id);
  if (doc.status === "void") throw conflict("ALREADY_VOID", "Document is already void");
  if (doc.status === "draft") throw conflict("IS_DRAFT", "Delete the draft instead");
  if (!POSTING_TYPES.includes(doc.doc_type)) {
    await batch(db, [
      stmt(db, `UPDATE documents SET status = 'void', updated_at = ? WHERE id = ? AND company_id = ?`, nowIso(), id, company.id),
      audit(c, `${doc.doc_type}.void`, "document", id, { reason }),
    ]);
    return;
  }
  const isNote = doc.doc_type === "credit_note" || doc.doc_type === "debit_note";
  if (!isNote && doc.amount_settled > 0) {
    throw conflict("SETTLED", "This document has payments or credit notes applied. Void those first.");
  }
  if (!doc.journal_entry_id) throw conflict("NO_JOURNAL", "Document has no journal to reverse");
  const rev = await buildReversal(db, company.id, doc.journal_entry_id, date, user.id, `Void ${doc.number}${reason ? ` — ${reason}` : ""}`, { allowSourced: true });
  const moves = await all<{ item_id: string; warehouse_id: string; qty_milli: number; value: number }>(
    db, `SELECT item_id, warehouse_id, qty_milli, value FROM stock_moves WHERE company_id = ? AND source_type = ? AND source_id = ?`, company.id, doc.doc_type, id,
  );
  const stmts = [...rev.stmts];
  for (const m of moves) {
    stmts.push(stockMoveStmt(db, {
      company_id: company.id, item_id: m.item_id, warehouse_id: m.warehouse_id, move_date: date, qty_milli: -m.qty_milli, value: -m.value,
      kind: m.qty_milli > 0 ? "return_out" : "return_in", source_type: `${doc.doc_type}_void`, source_id: id, journal_entry_id: rev.id, created_by: user.id,
    }));
  }
  // Reverse note applications (credit note voided → its allocation against the invoice is reversed).
  const allocs = await all<{ id: string; amount: number; document_id: string }>(
    db, `SELECT a.id, a.amount, a.document_id FROM allocations a WHERE a.note_id = ? AND a.amount > 0 AND NOT EXISTS (SELECT 1 FROM allocations r WHERE r.reverses_id = a.id)`, id,
  );
  for (const a of allocs) {
    stmts.push(stmt(db, `INSERT INTO allocations (id, company_id, source_kind, note_id, document_id, amount, reverses_id, allocation_date, created_by) VALUES (?,?,?,?,?,?,?,?,?)`,
      newId(), company.id, doc.doc_type, id, a.document_id, -a.amount, a.id, date, user.id));
  }
  stmts.push(stmt(db, `UPDATE documents SET status = 'void', updated_at = ? WHERE id = ? AND company_id = ?`, nowIso(), id, company.id));
  stmts.push(audit(c, `${doc.doc_type}.void`, "document", id, { reason, reversal_id: rev.id }));
  await batch(db, stmts);
}
