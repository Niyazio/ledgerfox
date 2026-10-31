/**
 * Country packs: what a new company gets for its country — currency, financial year, the name and format of its tax
 * registration number, and ready tax codes. Rates are defaults from each country's published standard rates (late
 * 2026); they are ordinary data the customer can edit in Settings → Tax codes, and should be checked with a local
 * accountant. India keeps its own GST scheme (CGST/SGST/IGST) in tax.ts.
 */

export interface TaxCodeSeed { name: string; rate_bp: number; category: "standard" | "zero" | "exempt" | "non_gst" | "reverse_charge" }

export interface CountryPack {
  code: string;
  name: string;
  currency: string;
  /** Month the financial year usually starts (1 = January). */
  fyStart: number;
  /** What the tax is called on invoices and reports. */
  taxName: string;
  /** What the tax registration number is called, e.g. TRN or VAT number. */
  regLabel: string;
  /** Expected format, shown as a hint; with `strict` the number is checked when saved. */
  regPattern?: RegExp;
  regHint?: string;
  strict?: boolean;
  codes: TaxCodeSeed[];
  /** Gulf VAT invoices: "Tax Invoice" title, supplier and customer VAT numbers, Arabic labels where required. */
  gccVat?: boolean;
  /** Saudi Arabia (ZATCA): Arabic on invoices and the QR code with seller, VAT number, time, total and VAT. */
  zatca?: boolean;
}

const vat = (rate: number, extra: TaxCodeSeed[] = [], label = "VAT"): TaxCodeSeed[] => [
  { name: `${label} ${rate}%`, rate_bp: Math.round(rate * 100), category: "standard" },
  ...extra,
  { name: `${label} 0% (zero-rated)`, rate_bp: 0, category: "zero" },
  { name: `${label} exempt`, rate_bp: 0, category: "exempt" },
  { name: `Out of scope (no ${label})`, rate_bp: 0, category: "non_gst" },
];
const reduced = (label: string, ...rates: number[]): TaxCodeSeed[] => rates.map((r) => ({ name: `${label} ${r}% (reduced)`, rate_bp: Math.round(r * 100), category: "standard" as const }));

export const COUNTRY_PACKS: CountryPack[] = [
  { code: "IN", name: "India", currency: "INR", fyStart: 4, taxName: "GST", regLabel: "GSTIN", regHint: "15 characters, validated with its check digit", codes: [] },
  // ── Gulf (GCC) ──
  { code: "AE", name: "United Arab Emirates", currency: "AED", fyStart: 1, taxName: "VAT", regLabel: "TRN", regPattern: /^\d{15}$/, regHint: "15-digit Tax Registration Number", strict: true, gccVat: true,
    codes: vat(5, [{ name: "VAT 5% reverse charge (imports)", rate_bp: 500, category: "reverse_charge" }]) },
  { code: "SA", name: "Saudi Arabia", currency: "SAR", fyStart: 1, taxName: "VAT", regLabel: "VAT number", regPattern: /^3\d{13}3$/, regHint: "15 digits, starts and ends with 3", strict: true, gccVat: true, zatca: true,
    codes: vat(15, [{ name: "VAT 15% reverse charge (imports)", rate_bp: 1500, category: "reverse_charge" }]) },
  { code: "BH", name: "Bahrain", currency: "BHD", fyStart: 1, taxName: "VAT", regLabel: "VAT account number", regPattern: /^\d{15}$/, regHint: "15 digits", gccVat: true, codes: vat(10) },
  { code: "OM", name: "Oman", currency: "OMR", fyStart: 1, taxName: "VAT", regLabel: "VATIN", regPattern: /^OM\d{10}$/, regHint: "OM followed by 10 digits", gccVat: true, codes: vat(5) },
  { code: "QA", name: "Qatar", currency: "QAR", fyStart: 1, taxName: "Tax", regLabel: "Tax card number", codes: [{ name: "No VAT", rate_bp: 0, category: "non_gst" }] },
  { code: "KW", name: "Kuwait", currency: "KWD", fyStart: 1, taxName: "Tax", regLabel: "Commercial registration", codes: [{ name: "No VAT", rate_bp: 0, category: "non_gst" }] },
  // ── Rest of the world ──
  { code: "US", name: "United States", currency: "USD", fyStart: 1, taxName: "Sales tax", regLabel: "EIN / sales tax permit", regHint: "Add your state and local sales tax rates in Settings → Tax codes",
    codes: [{ name: "No sales tax", rate_bp: 0, category: "exempt" }] },
  { code: "GB", name: "United Kingdom", currency: "GBP", fyStart: 4, taxName: "VAT", regLabel: "VAT number", regPattern: /^(GB)?(\d{9}|\d{12})$/, regHint: "GB followed by 9 digits", codes: vat(20, reduced("VAT", 5)) },
  { code: "SG", name: "Singapore", currency: "SGD", fyStart: 1, taxName: "GST", regLabel: "GST reg. no.", codes: vat(9, [], "GST") },
  { code: "MY", name: "Malaysia", currency: "MYR", fyStart: 1, taxName: "SST", regLabel: "SST registration no.",
    codes: [{ name: "Sales tax 10%", rate_bp: 1000, category: "standard" }, { name: "Sales tax 5%", rate_bp: 500, category: "standard" },
      { name: "Service tax 8%", rate_bp: 800, category: "standard" }, { name: "Service tax 6%", rate_bp: 600, category: "standard" }, { name: "SST exempt", rate_bp: 0, category: "exempt" }] },
  { code: "AU", name: "Australia", currency: "AUD", fyStart: 7, taxName: "GST", regLabel: "ABN", regPattern: /^\d{11}$/, regHint: "11-digit ABN", codes: vat(10, [], "GST") },
  { code: "NZ", name: "New Zealand", currency: "NZD", fyStart: 4, taxName: "GST", regLabel: "GST number", regPattern: /^\d{8,9}$/, regHint: "8 or 9 digits", codes: vat(15, [], "GST") },
  { code: "CA", name: "Canada", currency: "CAD", fyStart: 1, taxName: "GST/HST", regLabel: "Business number (GST/HST)", regPattern: /^\d{9}(RT\d{4})?$/, regHint: "9 digits, e.g. 123456789RT0001",
    codes: [{ name: "GST 5%", rate_bp: 500, category: "standard" }, { name: "HST 13% (Ontario)", rate_bp: 1300, category: "standard" }, { name: "HST 15% (Atlantic provinces)", rate_bp: 1500, category: "standard" },
      { name: "GST zero-rated", rate_bp: 0, category: "zero" }, { name: "GST exempt", rate_bp: 0, category: "exempt" }] },
  { code: "ZA", name: "South Africa", currency: "ZAR", fyStart: 3, taxName: "VAT", regLabel: "VAT number", regPattern: /^4\d{9}$/, regHint: "10 digits starting with 4", codes: vat(15) },
  { code: "KE", name: "Kenya", currency: "KES", fyStart: 7, taxName: "VAT", regLabel: "KRA PIN", regPattern: /^[AP]\d{9}[A-Z]$/, regHint: "e.g. P051234567X", codes: vat(16, reduced("VAT", 8)) },
  { code: "NP", name: "Nepal", currency: "NPR", fyStart: 7, taxName: "VAT", regLabel: "PAN / VAT no.", regPattern: /^\d{9}$/, regHint: "9 digits", codes: vat(13) },
  { code: "LK", name: "Sri Lanka", currency: "LKR", fyStart: 4, taxName: "VAT", regLabel: "VAT / TIN", codes: vat(18) },
  { code: "BD", name: "Bangladesh", currency: "BDT", fyStart: 7, taxName: "VAT", regLabel: "BIN", regPattern: /^\d{9}(\d{4})?$/, regHint: "9 or 13 digits", codes: vat(15) },
  { code: "DE", name: "Germany", currency: "EUR", fyStart: 1, taxName: "USt", regLabel: "USt-IdNr. (VAT ID)", regPattern: /^(DE)?\d{9}$/, regHint: "DE followed by 9 digits", codes: vat(19, reduced("VAT", 7)) },
  { code: "FR", name: "France", currency: "EUR", fyStart: 1, taxName: "TVA", regLabel: "N° TVA (VAT ID)", regPattern: /^(FR)?[0-9A-Z]{2}\d{9}$/, regHint: "FR + 2 characters + 9 digits", codes: vat(20, reduced("VAT", 10, 5.5)) },
  { code: "NL", name: "Netherlands", currency: "EUR", fyStart: 1, taxName: "BTW", regLabel: "BTW-id (VAT ID)", regPattern: /^(NL)?\d{9}B\d{2}$/, regHint: "NL123456789B01", codes: vat(21, reduced("VAT", 9)) },
  { code: "IE", name: "Ireland", currency: "EUR", fyStart: 1, taxName: "VAT", regLabel: "VAT number", regPattern: /^(IE)?\d{7}[A-W][A-I]?$/, regHint: "IE1234567T", codes: vat(23, reduced("VAT", 13.5, 9)) },
  { code: "IT", name: "Italy", currency: "EUR", fyStart: 1, taxName: "IVA", regLabel: "Partita IVA (VAT ID)", regPattern: /^(IT)?\d{11}$/, regHint: "IT followed by 11 digits", codes: vat(22, reduced("VAT", 10, 4)) },
  { code: "ES", name: "Spain", currency: "EUR", fyStart: 1, taxName: "IVA", regLabel: "NIF-IVA (VAT ID)", regPattern: /^(ES)?[0-9A-Z]\d{7}[0-9A-Z]$/, regHint: "ES + 9 characters", codes: vat(21, reduced("VAT", 10, 4)) },
];

const OTHER: CountryPack = { code: "XX", name: "Other country", currency: "USD", fyStart: 1, taxName: "Tax", regLabel: "Tax registration number", codes: [{ name: "No tax", rate_bp: 0, category: "exempt" }] };

export const countryPack = (code: string | null | undefined): CountryPack => COUNTRY_PACKS.find((c) => c.code === code) ?? { ...OTHER, code: code ?? "XX" };

/** The registration number in a comparable form (spaces and dashes removed, upper case). */
export const normaliseTaxId = (v: string) => v.replace(/[\s-]/g, "").toUpperCase();

/** A problem with a tax registration number for this country, or null when it looks right (or is not checked). */
export function taxIdProblem(country: string, taxId: string | null | undefined): string | null {
  if (!taxId || country === "IN") return null;
  const p = countryPack(country);
  if (!p.strict || !p.regPattern) return null;
  return p.regPattern.test(normaliseTaxId(taxId)) ? null : `${p.regLabel} ${taxId} is not valid for ${p.name} (${p.regHint})`;
}
