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
