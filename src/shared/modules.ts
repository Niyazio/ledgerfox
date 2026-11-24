/**
 * Features a company can switch on or off (Settings → Features). Switched-off features disappear from the menus and
 * screens, so a school, an agency or a clinic does not see barcode scanning, POS or manufacturing it never uses.
 * Nothing is deleted: switching a feature back on shows everything again. Core accounting (invoices, bills, receipts,
 * payments, expenses, journals, reports) is always on.
 */
export type ModuleKey =
  | "scanning" | "labels" | "pos" | "stock" | "quotations" | "purchase_orders" | "recurring" | "projects"
  | "manufacturing" | "batches" | "serials" | "payroll" | "fixed_assets" | "price_lists";

export interface ModuleInfo { key: ModuleKey; label: string; description: string }

export const MODULES: ModuleInfo[] = [
  { key: "scanning", label: "Barcode & QR scanning", description: "Scan products with a USB scanner or the phone camera on invoices, POS and stock screens." },
  { key: "labels", label: "Product labels & QR codes", description: "Print barcode / QR labels for products." },
  { key: "stock", label: "Stock tracking", description: "Quantities in stock, warehouses, stock transfers and adjustments. Off: products and services are still on invoices, without stock." },
  { key: "pos", label: "POS / counter billing", description: "Fast counter billing screen with cash drawer style totals." },
  { key: "quotations", label: "Quotations, proformas, sales orders & delivery challans", description: "Documents before the invoice, and advances taken on them." },
  { key: "purchase_orders", label: "Purchase orders", description: "Orders to suppliers before their bill arrives." },
  { key: "recurring", label: "Recurring invoices", description: "Invoices created automatically every month, quarter or year (rent, fees, subscriptions)." },
  { key: "projects", label: "Projects & time billing", description: "Log hours per project and invoice them." },
  { key: "manufacturing", label: "Manufacturing", description: "Bills of materials and production (raw materials into finished goods)." },
  { key: "batches", label: "Batches & expiry dates", description: "Medicines, food, chemicals: stock by batch with expiry." },
  { key: "serials", label: "Serial / IMEI numbers", description: "Phones, appliances, machines: each unit tracked by its number." },
  { key: "payroll", label: "Payroll & timesheets", description: "Employees, salaries, payslips, statutory files." },
  { key: "fixed_assets", label: "Fixed assets & depreciation", description: "Machinery, vehicles, computers and their depreciation." },
  { key: "price_lists", label: "Price lists", description: "Different rates for wholesale, retail or particular customers." },
];
export const MODULE_KEYS = MODULES.map((m) => m.key);

const SERVICE: ModuleKey[] = ["scanning", "labels", "pos", "manufacturing", "batches", "serials", "price_lists"];
const SHOP: ModuleKey[] = ["projects", "manufacturing", "serials", "batches"];

/** What a new company of this business type starts without (it can switch anything back on). */
export function defaultModulesOff(businessType: string | null | undefined): ModuleKey[] {
  switch (businessType) {
    case "education": case "ngo": return [...SERVICE, "stock", "quotations"];
    case "software": case "services": case "realestate": case "transport": return [...SERVICE, "stock"];
    case "construction": return SERVICE;
    case "healthcare": return ["labels", "pos", "manufacturing", "serials", "price_lists"];
    case "salon": case "hotel": return ["labels", "manufacturing", "batches", "serials", "projects", "purchase_orders"];
    case "restaurant": return ["labels", "manufacturing", "serials", "projects", "quotations"];
    case "pharmacy": return ["projects", "manufacturing", "serials"];
    case "agri": return ["projects", "manufacturing", "serials"];
    case "electronics": return ["projects", "manufacturing", "batches"];
    case "manufacturing": return ["pos", "projects", "serials"];
    case "retail": case "clothing": case "hardware": case "furniture": case "jewellery": case "automobile": case "wholesale":
      return SHOP;
    default: return [];
  }
}

export function parseModulesOff(raw: string | null | undefined): ModuleKey[] {
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.filter((k): k is ModuleKey => MODULE_KEYS.includes(k)) : []; } catch { return []; }
}
