/**
 * Tax rules, kept separate from the accounting engine.
 * The ledger only receives computed tax amounts + the accounts to post them to.
 */
import { applyBp, applyBpFraction, lineAmount, sum } from "./money";

export type TaxScheme = "in_gst" | "simple" | "none";
export type TaxMode = "intra" | "inter" | "simple" | "none";

export interface TaxCodeLike {
  id: string;
  scheme: TaxScheme;
  rate_bp: number;
  category: string;
}

/** Indian GST state / UT codes (first two digits of a GSTIN). */
export const INDIA_STATES: Record<string, string> = {
  "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh",
  "05": "Uttarakhand", "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh",
  "10": "Bihar", "11": "Sikkim", "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur",
  "15": "Mizoram", "16": "Tripura", "17": "Meghalaya", "18": "Assam", "19": "West Bengal",
  "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh", "24": "Gujarat",
  "26": "Dadra and Nagar Haveli and Daman and Diu", "27": "Maharashtra", "29": "Karnataka",
  "30": "Goa", "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry",
  "35": "Andaman and Nicobar Islands", "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh",
  "97": "Other Territory", "96": "Other Country (export)",
};

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** Validates GSTIN format and its mod-36 check digit. */
export function isValidGstin(gstin: string): boolean {
  const g = gstin.trim().toUpperCase();
  if (!GSTIN_RE.test(g)) return false;
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let total = 0;
  for (let i = 0; i < 14; i++) {
    const v = chars.indexOf(g[i]);
    const prod = v * (i % 2 === 0 ? 1 : 2);
    total += Math.floor(prod / 36) + (prod % 36);
  }
  const check = chars[(36 - (total % 36)) % 36];
  return check === g[14];
}

/** Jurisdiction capability matrix — reported honestly in the UI and COSTS/README docs. */
export const JURISDICTIONS: Record<string, { name: string; status: "implemented" | "partial" | "unsupported"; notes: string; scheme: TaxScheme }> = {
  IN: {
    name: "India",
    status: "partial",
    scheme: "in_gst",
    notes:
      "GST tax codes, CGST/SGST vs IGST by place of supply, GSTIN validation, HSN/SAC on invoices, GST summary report. " +
      "Not implemented: GSTR filing/JSON export, e-invoicing (IRN/QR), e-way bills, TDS/TCS, reverse-charge posting.",
  },
  DEFAULT: {
    name: "Other countries",
    status: "partial",
    scheme: "simple",
    notes: "Single-rate sales tax/VAT codes with input/output tax accounts. No country-specific statutory reports or filing.",
  },
};

export function schemeForCountry(country: string): TaxScheme {
  return country === "IN" ? "in_gst" : "simple";
}

/**
 * Decide how GST applies: intra-state (CGST+SGST) when supplier state == place of supply, else IGST.
 */
export function resolveTaxMode(scheme: TaxScheme, companyState?: string | null, placeOfSupply?: string | null): TaxMode {
  if (scheme === "none") return "none";
  if (scheme === "simple") return "simple";
  if (!companyState || !placeOfSupply) return "intra";
  return companyState === placeOfSupply ? "intra" : "inter";
}

export interface LineInput {
  qty_milli: number;
  unit_price: number;
  discount_bp?: number;
  tax?: TaxCodeLike | null;
}

export interface LineTax {
  gross: number;
  discount: number;
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  other_tax: number;
  tax: number;
  line_total: number;
}

/**
 * Line-level tax computation. Each component is rounded half-up to the minor unit independently,
 * which is the common practice for GST invoices (CGST and SGST each at half the rate).
 */
export function computeLine(line: LineInput, mode: TaxMode): LineTax {
  const gross = lineAmount(line.qty_milli, line.unit_price);
  const discount = applyBp(gross, line.discount_bp ?? 0);
  const taxable = gross - discount;
  let cgst = 0, sgst = 0, igst = 0, other = 0;
  const t = line.tax;
  const taxable_rate = t && t.category === "standard" ? t.rate_bp : 0;
  if (t && taxable_rate > 0 && mode !== "none") {
    if (t.scheme === "in_gst" && mode === "intra") {
      cgst = applyBpFraction(taxable, taxable_rate, 2);
      sgst = applyBpFraction(taxable, taxable_rate, 2);
    } else if (t.scheme === "in_gst" && mode === "inter") {
      igst = applyBp(taxable, taxable_rate);
    } else {
      other = applyBp(taxable, taxable_rate);
    }
  }
  const tax = cgst + sgst + igst + other;
  return { gross, discount, taxable, cgst, sgst, igst, other_tax: other, tax, line_total: taxable + tax };
}

export interface DocTotals {
  lines: LineTax[];
  subtotal: number;
  discount_total: number;
  taxable_total: number;
  cgst: number;
  sgst: number;
  igst: number;
  other_tax: number;
  tax_total: number;
  total_before_round: number;
}

export function computeDocument(lines: LineInput[], mode: TaxMode): DocTotals {
  const computed = lines.map((l) => computeLine(l, mode));
  const pick = (k: keyof LineTax) => sum(computed.map((c) => c[k]));
  const taxable_total = pick("taxable");
  const tax_total = pick("tax");
  return {
    lines: computed,
    subtotal: pick("gross"),
    discount_total: pick("discount"),
    taxable_total,
    cgst: pick("cgst"),
    sgst: pick("sgst"),
    igst: pick("igst"),
    other_tax: pick("other_tax"),
    tax_total,
    total_before_round: taxable_total + tax_total,
  };
}

/**
 * Default GST codes seeded for Indian companies, reflecting the slab rationalisation effective
 * 22 Sep 2025 (5% / 18% / 40%, plus special 3% and 0.25% rates). 12% and 28% are seeded inactive
 * for historical documents. Rates are data, not code: verify against current notifications and
 * edit in Settings → Tax codes. Compensation cess is not modelled.
 */
export const DEFAULT_IN_GST_CODES: { name: string; rate_bp: number; category: string; active?: boolean }[] = [
  { name: "GST 0% (Nil rated)", rate_bp: 0, category: "nil" },
  { name: "GST Exempt", rate_bp: 0, category: "exempt" },
  { name: "GST 0.25%", rate_bp: 25, category: "standard" },
  { name: "GST 3%", rate_bp: 300, category: "standard" },
  { name: "GST 5%", rate_bp: 500, category: "standard" },
  { name: "GST 18%", rate_bp: 1800, category: "standard" },
  { name: "GST 40%", rate_bp: 4000, category: "standard" },
  { name: "GST 12% (legacy)", rate_bp: 1200, category: "standard", active: false },
  { name: "GST 28% (legacy)", rate_bp: 2800, category: "standard", active: false },
  { name: "Non-GST supply", rate_bp: 0, category: "non_gst" },
];
