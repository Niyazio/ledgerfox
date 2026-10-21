import { formatMoney, CURRENCIES } from "@shared/currencies";
import { toDecimalString } from "@shared/money";

export { formatMoney };

export function money(minor: number | null | undefined, currency: string, locale = "en-IN") {
  if (minor === null || minor === undefined) return "—";
  return formatMoney(minor, currency, locale);
}

/** Minor units → plain decimal string for inputs (no grouping). */
export function toInput(minor: number | null | undefined, currency: string) {
  if (minor === null || minor === undefined) return "";
  return toDecimalString(minor, CURRENCIES[currency]?.exponent ?? 2);
}

export function qty(milli: number) {
  const s = (milli / 1000).toFixed(3).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
}

export function pct(bp: number) {
  return `${(bp / 100).toFixed(bp % 100 === 0 ? 0 : 2)}%`;
}

export function fmtDate(iso: string | null | undefined, format = "DD-MM-YYYY") {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  switch (format) {
    case "MM/DD/YYYY": return `${m}/${d}/${y}`;
    case "YYYY-MM-DD": return `${y}-${m}-${d}`;
    case "DD/MM/YYYY": return `${d}/${m}/${y}`;
    default: return `${d}-${m}-${y}`;
  }
}

export function fmtDateTime(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function fyStart(startMonth: number, ref = today()) {
  const [y, m] = ref.split("-").map(Number);
  const sy = m >= startMonth ? y : y - 1;
  return `${sy}-${String(startMonth).padStart(2, "0")}-01`;
}

export function monthStart(ref = today()) {
  return `${ref.slice(0, 7)}-01`;
}

export const DOC_LABELS: Record<string, { one: string; many: string; prefix: string }> = {
  quote: { one: "Quotation", many: "Quotations", prefix: "QT" },
  sales_order: { one: "Sales order", many: "Sales orders", prefix: "SO" },
  invoice: { one: "Invoice", many: "Invoices", prefix: "INV" },
  credit_note: { one: "Credit note", many: "Credit notes", prefix: "CN" },
  purchase_order: { one: "Purchase order", many: "Purchase orders", prefix: "PO" },
  bill: { one: "Bill", many: "Bills", prefix: "BILL" },
  debit_note: { one: "Debit note", many: "Debit notes", prefix: "DN" },
  proforma: { one: "Proforma invoice", many: "Proforma invoices", prefix: "PRF" },
  delivery_challan: { one: "Delivery challan", many: "Delivery challans", prefix: "DC" },
};

export const SALES_DOCS = ["quote", "sales_order", "invoice", "credit_note", "proforma", "delivery_challan"];
