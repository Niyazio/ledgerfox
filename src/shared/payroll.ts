/**
 * Payslip arithmetic in integer minor units. Indian statutory defaults (current rules, verify with your adviser):
 * - EPF: employee 12% and employer 12% of basic, on a wage ceiling of ₹15,000 when capped; rounded to the rupee.
 * - ESI: employee 0.75% and employer 3.25% of gross, only when monthly gross ≤ ₹21,000; rounded up to the rupee.
 * - Professional tax and TDS are fixed monthly amounts set per employee (they depend on state slabs and declarations).
 * Statutory parts apply only when the company is in India and the currency is INR.
 */
import { divRound } from "./money";

export interface PayEmployee {
  pay_type: "monthly" | "hourly";
  monthly_basic: number;
  hra: number;
  other_allowances: number;
  hourly_rate: number;
  overtime_rate: number;
  pf_enabled: number | boolean;
  esi_enabled: number | boolean;
  pt_monthly: number;
  tds_monthly: number;
}

export interface PayInput {
  working_days: number;
  paid_days_milli: number;
  worked_minutes: number;
  overtime_minutes: number;
  other_deductions?: number;
  statutory_india: boolean;
  pf_capped?: boolean;
}

export interface Payslip {
  basic: number; hra: number; allowances: number; overtime: number; gross: number;
  pf_employee: number; esi_employee: number; pt: number; tds: number; other_deductions: number; total_deductions: number; net: number;
  pf_employer: number; esi_employer: number;
}

export const PF_RATE_BP = 1200;
export const PF_WAGE_CEILING = 1_500_000; // ₹15,000 in paise
export const ESI_GROSS_LIMIT = 2_100_000; // ₹21,000 in paise
export const ESI_EMPLOYEE_BP = 75;
export const ESI_EMPLOYER_BP = 325;

const B = BigInt;
const prorate = (amount: number, num: number, den: number) => (den <= 0 ? 0 : Number(divRound(B(amount) * B(num), B(den))));
const bp = (amount: number, rate: number) => Number(divRound(B(amount) * B(rate), 10000n));
const toRupee = (paise: number) => Number(divRound(B(paise), 100n)) * 100;
const ceilRupee = (paise: number) => Math.ceil(paise / 100) * 100;

export function computePayslip(e: PayEmployee, i: PayInput): Payslip {
  const den = i.working_days * 1000;
  const hourly = e.pay_type === "hourly";
  const basic = hourly ? prorate(e.hourly_rate, i.worked_minutes, 60) : prorate(e.monthly_basic, i.paid_days_milli, den);
  const hra = hourly ? 0 : prorate(e.hra, i.paid_days_milli, den);
  const allowances = hourly ? 0 : prorate(e.other_allowances, i.paid_days_milli, den);
  const overtime = prorate(e.overtime_rate, i.overtime_minutes, 60);
  const gross = basic + hra + allowances + overtime;

  let pf_employee = 0, pf_employer = 0, esi_employee = 0, esi_employer = 0;
  if (i.statutory_india && e.pf_enabled && basic > 0) {
    const pfWage = i.pf_capped === false ? basic : Math.min(basic, PF_WAGE_CEILING);
    pf_employee = toRupee(bp(pfWage, PF_RATE_BP));
    pf_employer = pf_employee;
  }
  if (i.statutory_india && e.esi_enabled && gross > 0 && gross <= ESI_GROSS_LIMIT) {
    esi_employee = ceilRupee(bp(gross, ESI_EMPLOYEE_BP));
    esi_employer = ceilRupee(bp(gross, ESI_EMPLOYER_BP));
  }
  const pt = gross > 0 ? Math.min(e.pt_monthly, gross) : 0;
  const after = gross - pf_employee - esi_employee - pt;
  const tds = Math.max(0, Math.min(e.tds_monthly, after));
  const other_deductions = Math.max(0, Math.min(i.other_deductions ?? 0, after - tds));
  const total_deductions = pf_employee + esi_employee + pt + tds + other_deductions;
  return { basic, hra, allowances, overtime, gross, pf_employee, esi_employee, pt, tds, other_deductions, total_deductions, net: gross - total_deductions, pf_employer, esi_employer };
}

/** Calendar days in a YYYY-MM period (used as working days unless the user overrides). */
export function daysInPeriod(period: string): number {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
