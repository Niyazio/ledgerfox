/** Links between the connected pages: documents, contacts, products, payments. */
const SALES = ["quote", "sales_order", "invoice", "credit_note", "proforma", "delivery_challan"];

export function docPath(companyId: string, docType: string, docId: string, variant?: string | null) {
  const type = variant || docType;
  return `/app/${companyId}/${SALES.includes(type) ? "sales" : "purchases"}/${type}/${docId}`;
}
export const contactPath = (companyId: string, contactId: string) => `/app/${companyId}/contacts/${contactId}`;
export const productPath = (companyId: string, itemId: string) => `/app/${companyId}/inventory/${itemId}`;
export const paymentPath = (companyId: string, paymentId: string) => `/app/${companyId}/payments/view/${paymentId}`;

/** Where a stock movement came from, for links: a bill, an invoice, a production entry… */
export function sourcePath(companyId: string, sourceType: string | null, sourceId: string | null) {
  if (!sourceType || !sourceId) return null;
  if (sourceType.startsWith("production")) return `/app/${companyId}/production`;
  const t = sourceType.replace(/_void$/, "");
  return ["invoice", "credit_note", "bill", "debit_note"].includes(t) ? docPath(companyId, t, sourceId) : null;
}

/** Where a journal entry came from: the invoice, bill, receipt, payment, expense, payroll run, asset… */
export function journalSourcePath(companyId: string, sourceType: string | null, sourceId: string | null): string | null {
  if (!sourceType || !sourceId) return null;
  const t = sourceType.replace(/_void$/, "");
  if (["invoice", "credit_note", "bill", "debit_note"].includes(t)) return docPath(companyId, t, sourceId);
  if (t === "receipt" || t === "payment") return paymentPath(companyId, sourceId);
  if (t === "expense") return `/app/${companyId}/expenses?open=${sourceId}`;
  if (t === "production") return `/app/${companyId}/production`;
  if (t === "payroll" || t === "payroll_payment") return `/app/${companyId}/payroll`;
  if (t.startsWith("asset") || t === "depreciation_run") return `/app/${companyId}/assets`;
  if (t === "bank_line") return `/app/${companyId}/banking`;
  if (["transfer", "stock_adjustment", "stock_import"].includes(t)) return `/app/${companyId}/inventory?tab=movements`;
  return null;
}

const SOURCE_NAMES: Record<string, string> = {
  invoice: "Invoice", credit_note: "Credit note", bill: "Bill", debit_note: "Debit note", receipt: "Receipt", payment: "Payment", expense: "Expense",
  production: "Production", payroll: "Payroll", payroll_payment: "Salary payment", asset_acquisition: "Asset bought", asset_disposal: "Asset sold",
  depreciation_run: "Depreciation", bank_line: "Bank statement", transfer: "Stock transfer", stock_adjustment: "Stock adjustment", stock_import: "Opening stock", fx_settlement: "Exchange difference",
};
export const sourceName = (t: string | null | undefined) => (t ? `${SOURCE_NAMES[t.replace(/_void$/, "")] ?? t.replace(/_/g, " ")}${t.endsWith("_void") ? " (cancelled)" : ""}` : "Journal");

/** An account's ledger for a period (from a report figure). */
export function ledgerPath(companyId: string, accountId: string, from: string, to: string, extra: Record<string, string | null | undefined> = {}) {
  const q = new URLSearchParams({ account_id: accountId, from, to });
  for (const [k, v] of Object.entries(extra)) if (v) q.set(k, v);
  return `/app/${companyId}/reports/general-ledger?${q}`;
}
