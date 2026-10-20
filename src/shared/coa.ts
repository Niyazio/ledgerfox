/** Account types, subtypes and the default chart of accounts seeded for new companies. */

export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";

export const SUBTYPES: Record<AccountType, { value: string; label: string }[]> = {
  asset: [
    { value: "cash", label: "Cash" },
    { value: "bank", label: "Bank" },
    { value: "receivable", label: "Accounts receivable" },
    { value: "inventory", label: "Inventory" },
    { value: "tax_input", label: "Input tax" },
    { value: "current_asset", label: "Other current asset" },
    { value: "fixed_asset", label: "Fixed asset" },
    { value: "accumulated_depreciation", label: "Accumulated depreciation" },
    { value: "non_current_asset", label: "Other non-current asset" },
  ],
  liability: [
    { value: "payable", label: "Accounts payable" },
    { value: "tax_output", label: "Output tax" },
    { value: "current_liability", label: "Other current liability" },
    { value: "long_term_liability", label: "Long-term liability" },
  ],
  equity: [
    { value: "equity", label: "Equity" },
    { value: "retained_earnings", label: "Retained earnings" },
  ],
  income: [
    { value: "operating_income", label: "Operating income" },
    { value: "other_income", label: "Other income" },
  ],
  expense: [
    { value: "cogs", label: "Cost of goods sold" },
    { value: "operating_expense", label: "Operating expense" },
    { value: "depreciation", label: "Depreciation" },
    { value: "other_expense", label: "Other expense" },
  ],
};

export function isValidSubtype(type: AccountType, subtype: string): boolean {
  return SUBTYPES[type]?.some((s) => s.value === subtype) ?? false;
}

/** Debit-normal accounts carry positive balances on the debit side. */
export function isDebitNormal(type: AccountType): boolean {
  return type === "asset" || type === "expense";
}

/** Cash-flow statement classification of balance-sheet subtypes (indirect method). */
export function cashFlowSection(subtype: string): "cash" | "operating" | "investing" | "financing" | null {
  switch (subtype) {
    case "cash":
    case "bank":
      return "cash";
    case "receivable":
    case "inventory":
    case "tax_input":
    case "current_asset":
    case "accumulated_depreciation":
    case "payable":
    case "tax_output":
    case "current_liability":
      return "operating";
    case "fixed_asset":
    case "non_current_asset":
      return "investing";
    case "long_term_liability":
    case "equity":
    case "retained_earnings":
      return "financing";
    default:
      return null;
  }
}

export interface SeedAccount {
  code: string;
  name: string;
  type: AccountType;
  subtype: string;
  group?: boolean;
  parent?: string;
  key?: string;
  countries?: string[]; // only seed for these countries
  excludeCountries?: string[];
}

export const DEFAULT_ACCOUNTS: SeedAccount[] = [
  { code: "1000", name: "Assets", type: "asset", subtype: "current_asset", group: true },
  { code: "1100", name: "Current Assets", type: "asset", subtype: "current_asset", group: true, parent: "1000" },
  { code: "1110", name: "Cash in Hand", type: "asset", subtype: "cash", parent: "1100", key: "CASH" },
  { code: "1120", name: "Bank Accounts", type: "asset", subtype: "bank", group: true, parent: "1100" },
  { code: "1121", name: "Primary Bank Account", type: "asset", subtype: "bank", parent: "1120", key: "BANK" },
  { code: "1130", name: "Accounts Receivable", type: "asset", subtype: "receivable", parent: "1100", key: "AR" },
  { code: "1140", name: "Inventory", type: "asset", subtype: "inventory", parent: "1100", key: "INVENTORY" },
  { code: "1150", name: "Input CGST", type: "asset", subtype: "tax_input", parent: "1100", key: "IN_CGST", countries: ["IN"] },
  { code: "1151", name: "Input SGST", type: "asset", subtype: "tax_input", parent: "1100", key: "IN_SGST", countries: ["IN"] },
  { code: "1152", name: "Input IGST", type: "asset", subtype: "tax_input", parent: "1100", key: "IN_IGST", countries: ["IN"] },
  { code: "1155", name: "Input Tax Recoverable", type: "asset", subtype: "tax_input", parent: "1100", key: "IN_TAX" },
  { code: "1160", name: "Prepaid Expenses", type: "asset", subtype: "current_asset", parent: "1100" },
  { code: "1170", name: "Advances to Suppliers", type: "asset", subtype: "current_asset", parent: "1100" },
  { code: "1180", name: "TDS Receivable", type: "asset", subtype: "current_asset", parent: "1100", countries: ["IN"] },
  { code: "1200", name: "Fixed Assets", type: "asset", subtype: "fixed_asset", group: true, parent: "1000" },
  { code: "1210", name: "Furniture & Fixtures", type: "asset", subtype: "fixed_asset", parent: "1200" },
  { code: "1220", name: "Computers & Office Equipment", type: "asset", subtype: "fixed_asset", parent: "1200", key: "FIXED_ASSET" },
  { code: "1230", name: "Plant & Machinery", type: "asset", subtype: "fixed_asset", parent: "1200" },
  { code: "1240", name: "Vehicles", type: "asset", subtype: "fixed_asset", parent: "1200" },
  { code: "1290", name: "Accumulated Depreciation", type: "asset", subtype: "accumulated_depreciation", parent: "1200", key: "ACCUM_DEP" },
  { code: "1300", name: "Security Deposits", type: "asset", subtype: "non_current_asset", parent: "1000" },

  { code: "2000", name: "Liabilities", type: "liability", subtype: "current_liability", group: true },
  { code: "2100", name: "Current Liabilities", type: "liability", subtype: "current_liability", group: true, parent: "2000" },
  { code: "2110", name: "Accounts Payable", type: "liability", subtype: "payable", parent: "2100", key: "AP" },
  { code: "2120", name: "Output CGST", type: "liability", subtype: "tax_output", parent: "2100", key: "OUT_CGST", countries: ["IN"] },
  { code: "2121", name: "Output SGST", type: "liability", subtype: "tax_output", parent: "2100", key: "OUT_SGST", countries: ["IN"] },
  { code: "2122", name: "Output IGST", type: "liability", subtype: "tax_output", parent: "2100", key: "OUT_IGST", countries: ["IN"] },
  { code: "2125", name: "Sales Tax / VAT Payable", type: "liability", subtype: "tax_output", parent: "2100", key: "OUT_TAX" },
  { code: "2130", name: "Accrued Expenses", type: "liability", subtype: "current_liability", parent: "2100" },
  { code: "2140", name: "Salaries Payable", type: "liability", subtype: "current_liability", parent: "2100", key: "SALARY_PAYABLE" },
  { code: "2150", name: "TDS Payable", type: "liability", subtype: "current_liability", parent: "2100", key: "TDS_PAYABLE", countries: ["IN"] },
  { code: "2151", name: "Employee Income Tax Withheld", type: "liability", subtype: "current_liability", parent: "2100", key: "TDS_PAYABLE", excludeCountries: ["IN"] },
  { code: "2152", name: "Provident Fund Payable", type: "liability", subtype: "current_liability", parent: "2100", key: "PF_PAYABLE", countries: ["IN"] },
  { code: "2153", name: "ESI Payable", type: "liability", subtype: "current_liability", parent: "2100", key: "ESI_PAYABLE", countries: ["IN"] },
  { code: "2154", name: "Professional Tax Payable", type: "liability", subtype: "current_liability", parent: "2100", key: "PT_PAYABLE", countries: ["IN"] },
  { code: "2155", name: "Other Payroll Deductions Payable", type: "liability", subtype: "current_liability", parent: "2100", key: "PAYROLL_OTHER" },
  { code: "2160", name: "Customer Advances", type: "liability", subtype: "current_liability", parent: "2100" },
  { code: "2200", name: "Long-term Liabilities", type: "liability", subtype: "long_term_liability", group: true, parent: "2000" },
  { code: "2210", name: "Term Loans", type: "liability", subtype: "long_term_liability", parent: "2200" },

  { code: "3000", name: "Equity", type: "equity", subtype: "equity", group: true },
  { code: "3100", name: "Owner's Capital", type: "equity", subtype: "equity", parent: "3000", key: "CAPITAL" },
  { code: "3200", name: "Retained Earnings", type: "equity", subtype: "retained_earnings", parent: "3000", key: "RETAINED" },
  { code: "3300", name: "Opening Balance Equity", type: "equity", subtype: "equity", parent: "3000", key: "OPENING_EQUITY" },
  { code: "3400", name: "Drawings", type: "equity", subtype: "equity", parent: "3000" },

  { code: "4000", name: "Income", type: "income", subtype: "operating_income", group: true },
  { code: "4100", name: "Sales", type: "income", subtype: "operating_income", parent: "4000", key: "SALES" },
  { code: "4200", name: "Service Income", type: "income", subtype: "operating_income", parent: "4000", key: "SERVICE_INCOME" },
  { code: "4900", name: "Other Income", type: "income", subtype: "other_income", parent: "4000" },
  { code: "4910", name: "Interest Income", type: "income", subtype: "other_income", parent: "4000" },
  { code: "4950", name: "Exchange Gain / Loss", type: "income", subtype: "other_income", parent: "4000", key: "FX_GAIN_LOSS" },
  { code: "4960", name: "Gain / Loss on Asset Disposal", type: "income", subtype: "other_income", parent: "4000", key: "ASSET_DISPOSAL" },

  { code: "5000", name: "Cost of Sales", type: "expense", subtype: "cogs", group: true },
  { code: "5100", name: "Cost of Goods Sold", type: "expense", subtype: "cogs", parent: "5000", key: "COGS" },
  { code: "5200", name: "Purchases", type: "expense", subtype: "cogs", parent: "5000", key: "PURCHASES" },
  { code: "5300", name: "Inventory Adjustments", type: "expense", subtype: "cogs", parent: "5000", key: "INV_ADJ" },

  { code: "6000", name: "Operating Expenses", type: "expense", subtype: "operating_expense", group: true },
  { code: "6100", name: "Salaries & Wages", type: "expense", subtype: "operating_expense", parent: "6000", key: "SALARY_EXP" },
  { code: "6110", name: "Employer Contributions (PF / ESI)", type: "expense", subtype: "operating_expense", parent: "6000", key: "EMPLOYER_CONTRIB" },
  { code: "6200", name: "Rent", type: "expense", subtype: "operating_expense", parent: "6000" },
  { code: "6300", name: "Electricity & Utilities", type: "expense", subtype: "operating_expense", parent: "6000" },
  { code: "6400", name: "Office Supplies & Stationery", type: "expense", subtype: "operating_expense", parent: "6000" },
  { code: "6500", name: "Travel & Conveyance", type: "expense", subtype: "operating_expense", parent: "6000" },
  { code: "6600", name: "Telephone & Internet", type: "expense", subtype: "operating_expense", parent: "6000" },
  { code: "6700", name: "Professional & Legal Fees", type: "expense", subtype: "operating_expense", parent: "6000" },
  { code: "6750", name: "Software & Subscriptions", type: "expense", subtype: "operating_expense", parent: "6000" },
  { code: "6800", name: "Bank Charges", type: "expense", subtype: "operating_expense", parent: "6000", key: "BANK_CHARGES" },
  { code: "6850", name: "Repairs & Maintenance", type: "expense", subtype: "operating_expense", parent: "6000" },
  { code: "6870", name: "Advertising & Marketing", type: "expense", subtype: "operating_expense", parent: "6000" },
  { code: "6880", name: "Insurance", type: "expense", subtype: "operating_expense", parent: "6000" },
  { code: "6890", name: "Meals & Entertainment", type: "expense", subtype: "operating_expense", parent: "6000" },
  { code: "6900", name: "Depreciation", type: "expense", subtype: "depreciation", parent: "6000", key: "DEP_EXPENSE" },
  { code: "6950", name: "Rounding Off", type: "expense", subtype: "other_expense", parent: "6000", key: "ROUND_OFF" },
  { code: "6990", name: "Miscellaneous Expenses", type: "expense", subtype: "operating_expense", parent: "6000", key: "MISC_EXPENSE" },
];

export function seedAccountsFor(country: string): SeedAccount[] {
  return DEFAULT_ACCOUNTS.filter(
    (a) => (!a.countries || a.countries.includes(country)) && !(a.excludeCountries ?? []).includes(country),
  );
}
