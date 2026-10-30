import { stmt } from "../lib/db";
import { newId } from "../lib/crypto";
import { seedAccountsFor } from "@shared/coa";
import { DEFAULT_IN_GST_CODES, schemeForCountry } from "@shared/tax";
import { businessType } from "@shared/industries";
import { parseDecimal } from "@shared/money";
import { currencyExponent } from "@shared/currencies";

export const SEQUENCES: [string, string][] = [
  ["JV", "JV-"],
  ["invoice", "INV-"],
  ["credit_note", "CN-"],
  ["quote", "QT-"],
  ["sales_order", "SO-"],
  ["purchase_order", "PO-"],
  ["bill", "BILL-"],
  ["debit_note", "DN-"],
  ["payment_in", "RCPT-"],
  ["payment_out", "PAY-"],
  ["expense", "EXP-"],
];

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function lastDayOfMonth(y: number, m: number) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-based
}

/** Fiscal year that contains `date` for a company whose year starts in `startMonth`. */
export function fiscalYearFor(date: string, startMonth: number) {
  const [y, m] = date.split("-").map(Number);
  const startYear = m >= startMonth ? y : y - 1;
  const start = `${startYear}-${pad(startMonth)}-01`;
  const endMonth = startMonth === 1 ? 12 : startMonth - 1;
  const endYear = startMonth === 1 ? startYear : startYear + 1;
  const end = `${endYear}-${pad(endMonth)}-${pad(lastDayOfMonth(endYear, endMonth))}`;
  const name = startMonth === 1 ? `FY ${startYear}` : `FY ${startYear}-${String(endYear).slice(2)}`;
  return { start, end, name };
}

export function monthlyPeriods(start: string, end: string) {
  const out: { name: string; start: string; end: string }[] = [];
  let [y, m] = start.split("-").map(Number);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  for (;;) {
    const s = `${y}-${pad(m)}-01`;
    if (s > end) break;
    out.push({ name: `${months[m - 1]} ${y}`, start: s, end: `${y}-${pad(m)}-${pad(lastDayOfMonth(y, m))}` });
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

export function fiscalYearStatements(db: D1Database, companyId: string, fy: { start: string; end: string; name: string }) {
  const fyId = newId();
  const stmts = [stmt(db, `INSERT INTO fiscal_years (id, company_id, name, start_date, end_date) VALUES (?,?,?,?,?)`, fyId, companyId, fy.name, fy.start, fy.end)];
  for (const p of monthlyPeriods(fy.start, fy.end)) {
    stmts.push(stmt(db, `INSERT INTO fiscal_periods (id, company_id, fiscal_year_id, name, start_date, end_date) VALUES (?,?,?,?,?,?)`, newId(), companyId, fyId, p.name, p.start, p.end));
  }
  return { fyId, stmts };
}

export interface CompanyInput {
  org_id: string;
  /** Education mode: free, every feature, entries only on the 1st, 2nd and last day of a month. */
  is_practice?: boolean;
  name: string;
  legal_name?: string | null;
  country: string;
  base_currency: string;
  fiscal_year_start_month: number;
  tax_id?: string | null;
  state_code?: string | null;
  address?: string | null;
  city?: string | null;
  postal_code?: string | null;
  phone?: string | null;
  email?: string | null;
  number_locale?: string;
  business_type?: string | null;
  is_demo?: boolean;
  upi_id?: string | null;
}

export function companySetupStatements(db: D1Database, input: CompanyInput, today: string) {
  const companyId = newId();
  const stmts: D1PreparedStatement[] = [
    stmt(
      db,
      `INSERT INTO companies (id, org_id, name, legal_name, country, base_currency, fiscal_year_start_month, tax_id, state_code,
         address, city, postal_code, phone, email, number_locale, business_type, is_demo, upi_id, is_practice)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      companyId, input.org_id, input.name, input.legal_name ?? null, input.country, input.base_currency,
      input.fiscal_year_start_month, input.tax_id ?? null, input.state_code ?? null, input.address ?? null,
      input.city ?? null, input.postal_code ?? null, input.phone ?? null, input.email ?? null,
      input.number_locale ?? (input.country === "IN" ? "en-IN" : "en-US"), businessType(input.business_type).key, input.is_demo ? 1 : 0, input.upi_id || null, input.is_practice ? 1 : 0,
    ),
  ];
  const biz = businessType(input.business_type);

  // Chart of accounts — parents first (array order guarantees this).
  const idByCode = new Map<string, string>();
  for (const a of [...seedAccountsFor(input.country), ...biz.accounts]) {
    const id = newId();
    idByCode.set(a.code, id);
    stmts.push(
      stmt(
        db,
        `INSERT INTO accounts (id, company_id, code, name, type, subtype, parent_id, is_group, system_key) VALUES (?,?,?,?,?,?,?,?,?)`,
        id, companyId, a.code, a.name, a.type, a.subtype, a.parent ? idByCode.get(a.parent)! : null, a.group ? 1 : 0, a.key ?? null,
      ),
    );
  }

  const scheme = schemeForCountry(input.country);
  const taxIdByName = new Map<string, string>();
  if (scheme === "in_gst") {
    for (const t of DEFAULT_IN_GST_CODES) {
      const id = newId();
      taxIdByName.set(t.name, id);
      stmts.push(stmt(db, `INSERT INTO tax_codes (id, company_id, name, scheme, rate_bp, category, is_active) VALUES (?,?,?,?,?,?,?)`,
        id, companyId, t.name, "in_gst", t.rate_bp, t.category, t.active === false ? 0 : 1));
    }
  } else {
    stmts.push(stmt(db, `INSERT INTO tax_codes (id, company_id, name, scheme, rate_bp, category) VALUES (?,?,?,?,?,?)`, newId(), companyId, "No tax", "simple", 0, "exempt"));
  }

  for (const [key, prefix] of SEQUENCES) {
    stmts.push(stmt(db, `INSERT INTO number_sequences (company_id, key, prefix, next_value) VALUES (?,?,?,1)`, companyId, key, prefix));
  }

  stmts.push(stmt(db, `INSERT INTO warehouses (id, company_id, name, code) VALUES (?,?,?,?)`, newId(), companyId, "Main Warehouse", "MAIN"));
  const units = new Map<string, string>([["nos", "Numbers"], ["kg", "Kilograms"], ["ltr", "Litres"], ["mtr", "Metres"], ["box", "Boxes"], ["hrs", "Hours"], ...biz.units]);
  for (const [code, name] of units) {
    stmts.push(stmt(db, `INSERT INTO units (id, company_id, code, name) VALUES (?,?,?,?)`, newId(), companyId, code, name));
  }
  // Starter items for the business type (prices in the company currency; editable later).
  const exp = currencyExponent(input.base_currency);
  for (const it of biz.items) {
    stmts.push(stmt(db,
      `INSERT INTO items (id, company_id, kind, name, unit, hsn_sac, sale_price, tax_code_id, income_account_id, track_inventory) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      newId(), companyId, it.kind, it.name, it.unit, scheme === "in_gst" ? it.hsn ?? null : null, parseDecimal(it.price, exp),
      scheme === "in_gst" && it.gst ? taxIdByName.get(it.gst) ?? null : null, it.income ? idByCode.get(it.income) ?? null : null, it.track ? 1 : 0));
  }
  stmts.push(stmt(db, `INSERT INTO branches (id, company_id, name, code, state_code) VALUES (?,?,?,?,?)`, newId(), companyId, "Head Office", "HO", input.state_code ?? null));

  const fy = fiscalYearFor(today, input.fiscal_year_start_month);
  stmts.push(...fiscalYearStatements(db, companyId, fy).stmts);

  return { companyId, stmts };
}
