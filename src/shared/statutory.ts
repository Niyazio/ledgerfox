/**
 * Statutory payroll files for India, built from posted payslips (amounts in paise in, rupees out).
 *
 * - EPF ECR (EPFO unified portal, "ECR 2.0" text upload): one line per member, fields joined by "#~#":
 *   UAN, name, gross wages, EPF wages, EPS wages, EDLI wages, EPF contribution (employee 12 %),
 *   EPS contribution (8.33 % of EPS wages), EPF–EPS difference (employer share minus EPS), NCP days, refund of advances.
 * - ESIC monthly contribution: the columns of ESIC's upload template (IP number, name, days, wages, reason, last day).
 * - Form 24Q (TDS on salary) deductee rows for the NSDL Return Preparation Utility.
 * The portals validate the files; check the first upload against your records.
 */
import { PF_WAGE_CEILING } from "./payroll";

export const EPS_RATE_BP = 833;
export const EDLI_RATE_BP = 50;
export const EPF_ADMIN_RATE_BP = 50;
export const EPF_ADMIN_MINIMUM = 50_000; // ₹500 a month

export interface StatSlip {
  code: string; name: string; uan: string | null; esi_number: string | null; pan: string | null;
  working_days: number; paid_days_milli: number; basic: number; gross: number;
  pf_employee: number; pf_employer: number; esi_employee: number; esi_employer: number; tds: number;
  date_of_leaving?: string | null;
}

const rupees = (paise: number) => Math.round(paise / 100);
/** Round half up to the rupee, as EPFO does. */
const pctRupees = (paiseBase: number, bp: number) => Math.round((rupees(paiseBase) * bp) / 10_000);

export function ecrRow(s: StatSlip) {
  // LedgerFox computes PF on basic up to the ₹15,000 ceiling, so EPF, EPS and EDLI wages are the same figure.
  const capped = Math.min(s.basic, PF_WAGE_CEILING);
  const epf = rupees(s.pf_employee);
  const eps = Math.min(pctRupees(capped, EPS_RATE_BP), rupees(s.pf_employer));
  const ncp = Math.max(0, Math.round(s.working_days - s.paid_days_milli / 1000));
  return {
    uan: (s.uan ?? "").replace(/\D/g, ""), name: s.name.toUpperCase().replace(/[^A-Z .]/g, " ").replace(/\s+/g, " ").trim(),
    gross: rupees(s.gross), epf_wages: rupees(capped), eps_wages: rupees(capped), edli_wages: rupees(capped),
    epf, eps, diff: rupees(s.pf_employer) - eps, ncp, refund: 0,
  };
}

export function ecrFile(slips: StatSlip[]) {
  const members = slips.filter((s) => s.pf_employee > 0);
  const problems: string[] = [];
  const rows = members.map((s) => {
    const r = ecrRow(s);
    if (!/^\d{12}$/.test(r.uan)) problems.push(`${s.code} ${s.name}: UAN must be 12 digits`);
    return r;
  });
  const text = rows.map((r) => [r.uan, r.name, r.gross, r.epf_wages, r.eps_wages, r.edli_wages, r.epf, r.eps, r.diff, r.ncp, r.refund].join("#~#")).join("\n");
  const sum = (k: keyof (typeof rows)[number]) => rows.reduce((t, r) => t + (r[k] as number), 0);
  const epfWages = sum("epf_wages"), edliWages = sum("edli_wages");
  // Challan heads: A/c 1 = employee + employer EPF difference, 2 = admin charges, 10 = EPS, 21 = EDLI, 22 = EDLI admin (nil).
  const summary = {
    members: rows.length, epf_wages: epfWages, ac1: sum("epf") + sum("diff"), ac2: rows.length ? Math.max(Math.round((epfWages * EPF_ADMIN_RATE_BP) / 10_000), rupees(EPF_ADMIN_MINIMUM)) : 0,
    ac10: sum("eps"), ac21: Math.round((edliWages * EDLI_RATE_BP) / 10_000), ac22: 0,
  };
  return { text, rows, problems, summary: { ...summary, total: summary.ac1 + summary.ac2 + summary.ac10 + summary.ac21 + summary.ac22 } };
}

/** ESIC: days paid, wages; reason 2 = left service (with the last working day), otherwise 0. */
export function esiRows(slips: StatSlip[], period: string) {
  const covered = slips.filter((s) => s.esi_employee > 0 || s.esi_employer > 0);
  const problems: string[] = [];
  const [y, m] = period.split("-");
  const rows = covered.map((s) => {
    const ip = (s.esi_number ?? "").replace(/\D/g, "");
    if (!/^\d{10}$/.test(ip)) problems.push(`${s.code} ${s.name}: ESI IP number must be 10 digits`);
    const days = Math.round(s.paid_days_milli / 1000);
    const left = s.date_of_leaving && s.date_of_leaving.startsWith(`${y}-${m}`);
    return {
      ip_number: ip, name: s.name, days, wages: rupees(s.gross), reason: left ? 2 : 0,
      last_working_day: left ? `${s.date_of_leaving!.slice(8, 10)}/${s.date_of_leaving!.slice(5, 7)}/${s.date_of_leaving!.slice(0, 4)}` : "",
      employee_share: rupees(s.esi_employee), employer_share: rupees(s.esi_employer),
    };
  });
  return { rows, problems, header: ["IP Number", "IP Name", "No of Days for which wages paid/payable during the month", "Total Monthly Wages", "Reason Code for Zero workings days", "Last Working Day"] };
}

/** Form 24Q annexure I: one row per employee per month with TDS. */
export function tds24qRows(slips: (StatSlip & { pay_date: string })[]) {
  const problems: string[] = [];
  const rows = slips.filter((s) => s.tds > 0).map((s) => {
    const pan = (s.pan ?? "").toUpperCase();
    if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(pan)) problems.push(`${s.code} ${s.name}: PAN missing or invalid (TDS at 20 % applies without a PAN)`);
    const d = `${s.pay_date.slice(8, 10)}/${s.pay_date.slice(5, 7)}/${s.pay_date.slice(0, 4)}`;
    return { employee_ref: s.code, pan, name: s.name, section: "192", payment_date: d, amount_paid: rupees(s.gross), tds: rupees(s.tds), deduction_date: d };
  });
  return { rows, problems, header: ["Employee reference no.", "PAN of the employee", "Name of the employee", "Section code", "Date of payment/credit", "Amount paid/credited", "TDS (income tax)", "Date of deduction"] };
}
