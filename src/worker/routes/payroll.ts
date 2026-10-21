import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, CompanyRow } from "../env";
import { all, batch, first, stmt } from "../lib/db";
import { badRequest, conflict, notFound } from "../lib/errors";
import { body, isoDate, reqText, shortText, optId, minor } from "../lib/validate";
import { newId } from "../lib/crypto";
import { audit, requirePerm } from "../lib/auth";
import { currencyExponent } from "@shared/currencies";
import { DEFAULT_ACCOUNTS } from "@shared/coa";
import { computePayslip, daysInPeriod, type PayEmployee } from "@shared/payroll";
import { buildJournal, assertOpenPeriod, assertPostable, type LineInput } from "../services/ledger";

const payroll = new Hono<AppEnv>();

const PAYROLL_KEYS = ["SALARY_EXP", "EMPLOYER_CONTRIB", "SALARY_PAYABLE", "PF_PAYABLE", "ESI_PAYABLE", "PT_PAYABLE", "TDS_PAYABLE", "PAYROLL_OTHER"];

/** Companies created before payroll existed get the payroll accounts added on first use. */
async function payrollAccounts(db: D1Database, company: CompanyRow): Promise<Record<string, string>> {
  const rows = await all<{ id: string; code: string; system_key: string | null }>(db, `SELECT id, code, system_key FROM accounts WHERE company_id = ?`, company.id);
  const byKey: Record<string, string> = {};
  for (const r of rows) if (r.system_key) byKey[r.system_key] = r.id;
  const codes = new Set(rows.map((r) => r.code));
  const parentByCode = new Map(rows.map((r) => [r.code, r.id]));
  const stmts: D1PreparedStatement[] = [];
  for (const key of PAYROLL_KEYS) {
    if (byKey[key]) continue;
    const seed = DEFAULT_ACCOUNTS.find((a) => a.key === key && (!a.countries || a.countries.includes(company.country)) && !(a.excludeCountries ?? []).includes(company.country))
      ?? DEFAULT_ACCOUNTS.find((a) => a.key === key)!;
    // Existing companies may already use 6100/2140 for the same purpose: adopt it rather than duplicating.
    const existing = rows.find((r) => r.code === seed.code && !r.system_key);
    if (existing) {
      stmts.push(stmt(db, `UPDATE accounts SET system_key = ? WHERE id = ?`, key, existing.id));
      byKey[key] = existing.id;
      continue;
    }
    let code = seed.code;
    while (codes.has(code)) code = String(Number(code) + 1);
    codes.add(code);
    const id = newId();
    stmts.push(stmt(db, `INSERT INTO accounts (id, company_id, code, name, type, subtype, parent_id, is_group, system_key) VALUES (?,?,?,?,?,?,?,0,?)`,
      id, company.id, code, seed.name, seed.type, seed.subtype, seed.parent ? parentByCode.get(seed.parent) ?? null : null, key));
    byKey[key] = id;
  }
  if (stmts.length) await batch(db, stmts);
  return byKey;
}

const money = (exp: number, field: string) => z.union([z.string(), z.number()]).nullish().transform((v) => (v === null || v === undefined || v === "" ? 0 : minor(v, exp, field)));

function employeeSchema(exp: number) {
  return z.object({
    code: reqText(30),
    name: reqText(160),
    designation: shortText(120).nullish(),
    department_id: optId,
    email: z.string().trim().email().max(254).nullish().or(z.literal("")),
    phone: shortText(40).nullish(),
    date_of_joining: isoDate.nullish(),
    date_of_leaving: isoDate.nullish(),
    pan: shortText(12).nullish(),
    uan: shortText(20).nullish(),
    esi_number: shortText(20).nullish(),
    bank_name: shortText(100).nullish(),
    bank_account: shortText(40).nullish(),
    ifsc: shortText(15).nullish(),
    pay_type: z.enum(["monthly", "hourly"]).default("monthly"),
    monthly_basic: money(exp, "basic salary"),
    hra: money(exp, "HRA"),
    other_allowances: money(exp, "allowances"),
    hourly_rate: money(exp, "hourly rate"),
    overtime_rate: money(exp, "overtime rate"),
    pf_enabled: z.boolean().default(false),
    esi_enabled: z.boolean().default(false),
    pt_monthly: money(exp, "professional tax"),
    tds_monthly: money(exp, "TDS"),
    is_active: z.boolean().default(true),
  });
}

const EMP_COLS = ["code", "name", "designation", "department_id", "email", "phone", "date_of_joining", "date_of_leaving", "pan", "uan", "esi_number", "bank_name", "bank_account", "ifsc",
  "pay_type", "monthly_basic", "hra", "other_allowances", "hourly_rate", "overtime_rate", "pf_enabled", "esi_enabled", "pt_monthly", "tds_monthly", "is_active"] as const;

function empValues(v: Record<string, unknown>) {
  return EMP_COLS.map((k) => {
    const x = v[k];
    if (typeof x === "boolean") return x ? 1 : 0;
    if (x === undefined || x === "") return null;
    return x as string | number | null;
  });
}

payroll.get("/employees", async (c) => {
  requirePerm(c, "payroll.read");
  const rows = await all(c.env.DB, `SELECT * FROM employees WHERE company_id = ? ORDER BY is_active DESC, code`, c.get("company").id);
  return c.json({ employees: rows });
});

payroll.post("/employees", async (c) => {
  requirePerm(c, "payroll.manage");
  const company = c.get("company");
  const input = await body(c, employeeSchema(currencyExponent(company.base_currency)));
  const id = newId();
  await batch(c.env.DB, [
    stmt(c.env.DB, `INSERT INTO employees (id, company_id, ${EMP_COLS.join(", ")}) VALUES (?, ?, ${EMP_COLS.map(() => "?").join(", ")})`, id, company.id, ...empValues(input)),
    audit(c, "employee.create", "employee", id, { code: input.code, name: input.name }),
  ]);
  return c.json({ id }, 201);
});

payroll.put("/employees/:id", async (c) => {
  requirePerm(c, "payroll.manage");
  const company = c.get("company");
  const id = c.req.param("id");
  if (!(await first(c.env.DB, `SELECT 1 FROM employees WHERE id = ? AND company_id = ?`, id, company.id))) throw notFound("Employee");
  const input = await body(c, employeeSchema(currencyExponent(company.base_currency)));
  await batch(c.env.DB, [
    stmt(c.env.DB, `UPDATE employees SET ${EMP_COLS.map((k) => `${k} = ?`).join(", ")} WHERE id = ? AND company_id = ?`, ...empValues(input), id, company.id),
    audit(c, "employee.update", "employee", id, { code: input.code }),
  ]);
  return c.json({ ok: true });
});

// Timesheets ------------------------------------------------------------------------------------------------------

const hoursToMinutes = (v: string | number | null | undefined, field: string) => {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 24) throw badRequest(`${field} must be between 0 and 24 hours`);
  return Math.round(n * 60);
};

async function periodLocked(db: D1Database, companyId: string, date: string) {
  return Boolean(await first(db, `SELECT 1 FROM payroll_runs WHERE company_id = ? AND period = ? AND status <> 'draft'`, companyId, date.slice(0, 7)));
}

payroll.get("/timesheets", async (c) => {
  requirePerm(c, "payroll.read");
  const company = c.get("company");
  const from = c.req.query("from") ?? "0000-01-01";
  const to = c.req.query("to") ?? "9999-12-31";
  const emp = c.req.query("employee_id");
  const rows = await all(c.env.DB,
    `SELECT t.*, e.name AS employee_name, e.code AS employee_code, p.name AS project_name FROM timesheets t
     JOIN employees e ON e.id = t.employee_id LEFT JOIN projects p ON p.id = t.project_id
     WHERE t.company_id = ? AND t.work_date BETWEEN ? AND ? ${emp ? "AND t.employee_id = ?" : ""} ORDER BY t.work_date DESC, e.code LIMIT 1000`,
    ...(emp ? [company.id, from, to, emp] : [company.id, from, to]));
  return c.json({ timesheets: rows });
});

payroll.post("/timesheets", async (c) => {
  requirePerm(c, "payroll.manage");
  const company = c.get("company");
  const input = await body(c, z.object({
    employee_id: z.string(), work_date: isoDate, hours: z.union([z.string(), z.number()]), overtime_hours: z.union([z.string(), z.number()]).nullish(),
    project_id: optId, description: shortText(500).nullish(),
  }));
  const minutes = hoursToMinutes(input.hours, "Hours");
  if (minutes <= 0) throw badRequest("Enter the hours worked");
  if (!(await first(c.env.DB, `SELECT 1 FROM employees WHERE id = ? AND company_id = ?`, input.employee_id, company.id))) throw notFound("Employee");
  if (await periodLocked(c.env.DB, company.id, input.work_date)) throw conflict("PAYROLL_POSTED", "Payroll for this month is already posted");
  const id = newId();
  await batch(c.env.DB, [
    stmt(c.env.DB, `INSERT INTO timesheets (id, company_id, employee_id, work_date, minutes, overtime_minutes, project_id, description, created_by) VALUES (?,?,?,?,?,?,?,?,?)`,
      id, company.id, input.employee_id, input.work_date, minutes, hoursToMinutes(input.overtime_hours, "Overtime"), input.project_id ?? null, input.description ?? null, c.get("user").id),
  ]);
  return c.json({ id }, 201);
});

payroll.delete("/timesheets/:id", async (c) => {
  requirePerm(c, "payroll.manage");
  const company = c.get("company");
  const t = await first<{ work_date: string }>(c.env.DB, `SELECT work_date FROM timesheets WHERE id = ? AND company_id = ?`, c.req.param("id"), company.id);
  if (!t) throw notFound("Timesheet entry");
  if (await periodLocked(c.env.DB, company.id, t.work_date)) throw conflict("PAYROLL_POSTED", "Payroll for this month is already posted");
  await batch(c.env.DB, [stmt(c.env.DB, `DELETE FROM timesheets WHERE id = ? AND company_id = ?`, c.req.param("id"), company.id)]);
  return c.json({ ok: true });
});

// Payroll runs ----------------------------------------------------------------------------------------------------

type EmpRow = PayEmployee & { id: string; code: string; name: string; date_of_joining: string | null; date_of_leaving: string | null };

function payslipStatement(db: D1Database, companyId: string, runId: string, emp: EmpRow, period: string, workingDays: number, paidDaysMilli: number,
  worked: number, ot: number, otherDed: number, india: boolean, existingId?: string) {
  const p = computePayslip(emp, { working_days: workingDays, paid_days_milli: paidDaysMilli, worked_minutes: worked, overtime_minutes: ot, other_deductions: otherDed, statutory_india: india });
  const vals = [workingDays, paidDaysMilli, worked, ot, p.basic, p.hra, p.allowances, p.overtime, p.gross, p.pf_employee, p.esi_employee, p.pt, p.tds, p.other_deductions, p.total_deductions, p.net, p.pf_employer, p.esi_employer];
  const cols = "working_days, paid_days_milli, worked_minutes, overtime_minutes, basic, hra, allowances, overtime, gross, pf_employee, esi_employee, pt, tds, other_deductions, total_deductions, net, pf_employer, esi_employer";
  if (existingId) return stmt(db, `UPDATE payslips SET ${cols.split(", ").map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...vals, existingId);
  return stmt(db, `INSERT INTO payslips (id, company_id, run_id, employee_id, ${cols}) VALUES (?,?,?,?,${vals.map(() => "?").join(",")})`, newId(), companyId, runId, emp.id, ...vals);
}

function runTotalsStatement(db: D1Database, runId: string) {
  return stmt(db, `UPDATE payroll_runs SET gross = (SELECT COALESCE(SUM(gross),0) FROM payslips WHERE run_id = ?), deductions = (SELECT COALESCE(SUM(total_deductions),0) FROM payslips WHERE run_id = ?),
    net = (SELECT COALESCE(SUM(net),0) FROM payslips WHERE run_id = ?), employer_cost = (SELECT COALESCE(SUM(gross + pf_employer + esi_employer),0) FROM payslips WHERE run_id = ?) WHERE id = ?`,
    runId, runId, runId, runId, runId);
}

const isIndia = (co: CompanyRow) => co.country === "IN" && co.base_currency === "INR";

payroll.get("/runs", async (c) => {
  requirePerm(c, "payroll.read");
  const rows = await all(c.env.DB, `SELECT r.*, (SELECT COUNT(*) FROM payslips p WHERE p.run_id = r.id) AS employees FROM payroll_runs r WHERE r.company_id = ? ORDER BY period DESC`, c.get("company").id);
  return c.json({ runs: rows });
});

payroll.post("/runs", async (c) => {
  requirePerm(c, "payroll.manage");
  const company = c.get("company");
  const input = await body(c, z.object({ period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use YYYY-MM"), pay_date: isoDate, working_days: z.number().int().min(1).max(31).nullish() }));
  if (await first(c.env.DB, `SELECT 1 FROM payroll_runs WHERE company_id = ? AND period = ?`, company.id, input.period)) throw conflict("DUPLICATE", "A payroll for this month already exists");
  const start = `${input.period}-01`;
  const days = daysInPeriod(input.period);
  const end = `${input.period}-${String(days).padStart(2, "0")}`;
  const workingDays = input.working_days ?? days;
  const emps = await all<EmpRow>(c.env.DB,
    `SELECT * FROM employees WHERE company_id = ? AND is_active = 1 AND (date_of_joining IS NULL OR date_of_joining <= ?) AND (date_of_leaving IS NULL OR date_of_leaving >= ?) ORDER BY code`,
    company.id, end, start);
  if (!emps.length) throw badRequest("No active employees for this month. Add employees first.");
  const hours = await all<{ employee_id: string; m: number; ot: number }>(c.env.DB,
    `SELECT employee_id, SUM(minutes) AS m, SUM(overtime_minutes) AS ot FROM timesheets WHERE company_id = ? AND work_date BETWEEN ? AND ? GROUP BY employee_id`, company.id, start, end);
  const hoursBy = new Map(hours.map((h) => [h.employee_id, h]));
  const runId = newId();
  const stmts = [stmt(c.env.DB, `INSERT INTO payroll_runs (id, company_id, period, pay_date, created_by) VALUES (?,?,?,?,?)`, runId, company.id, input.period, input.pay_date, c.get("user").id)];
  for (const e of emps) {
    // Joiners and leavers are paid for the days they were employed in the month.
    const from = e.date_of_joining && e.date_of_joining > start ? Number(e.date_of_joining.slice(8)) : 1;
    const to = e.date_of_leaving && e.date_of_leaving < end ? Number(e.date_of_leaving.slice(8)) : days;
    const employedDays = Math.max(0, to - from + 1);
    const paidMilli = Math.min(workingDays, Math.round((employedDays * workingDays) / days)) * 1000;
    const h = hoursBy.get(e.id);
    stmts.push(payslipStatement(c.env.DB, company.id, runId, e, input.period, workingDays, paidMilli, h?.m ?? 0, h?.ot ?? 0, 0, isIndia(company)));
  }
  stmts.push(runTotalsStatement(c.env.DB, runId), audit(c, "payroll.create", "payroll_run", runId, { period: input.period, employees: emps.length }));
  await batch(c.env.DB, stmts);
  return c.json({ id: runId }, 201);
});

payroll.get("/runs/:id", async (c) => {
  requirePerm(c, "payroll.read");
  const company = c.get("company");
  const run = await first(c.env.DB, `SELECT * FROM payroll_runs WHERE id = ? AND company_id = ?`, c.req.param("id"), company.id);
  if (!run) throw notFound("Payroll");
  const slips = await all(c.env.DB, `SELECT p.*, e.code, e.name, e.designation, e.pay_type FROM payslips p JOIN employees e ON e.id = p.employee_id WHERE p.run_id = ? ORDER BY e.code`, c.req.param("id"));
  return c.json({ run, payslips: slips });
});

/** Adjust paid days (loss of pay) or other deductions on a draft payslip. */
payroll.put("/runs/:id/payslips/:payslipId", async (c) => {
  requirePerm(c, "payroll.manage");
  const company = c.get("company");
  const exp = currencyExponent(company.base_currency);
  const input = await body(c, z.object({ paid_days: z.union([z.string(), z.number()]), other_deductions: z.union([z.string(), z.number()]).nullish() }));
  const row = await first<{ id: string; status: string; period: string; working_days: number; worked_minutes: number; overtime_minutes: number; employee_id: string }>(c.env.DB,
    `SELECT p.id, r.status, r.period, p.working_days, p.worked_minutes, p.overtime_minutes, p.employee_id FROM payslips p JOIN payroll_runs r ON r.id = p.run_id
     WHERE p.id = ? AND p.run_id = ? AND p.company_id = ?`, c.req.param("payslipId"), c.req.param("id"), company.id);
  if (!row) throw notFound("Payslip");
  if (row.status !== "draft") throw conflict("POSTED_IMMUTABLE", "This payroll is already posted");
  const paid = Number(input.paid_days);
  if (!Number.isFinite(paid) || paid < 0 || paid > row.working_days) throw badRequest(`Paid days must be between 0 and ${row.working_days}`);
  const emp = await first<EmpRow>(c.env.DB, `SELECT * FROM employees WHERE id = ?`, row.employee_id);
  const other = input.other_deductions ? minor(input.other_deductions, exp, "other deductions") : 0;
  await batch(c.env.DB, [
    payslipStatement(c.env.DB, company.id, c.req.param("id"), emp!, row.period, row.working_days, Math.round(paid * 1000), row.worked_minutes, row.overtime_minutes, other, isIndia(company), row.id),
    runTotalsStatement(c.env.DB, c.req.param("id")),
  ]);
  return c.json({ ok: true });
});

payroll.delete("/runs/:id", async (c) => {
  requirePerm(c, "payroll.manage");
  const company = c.get("company");
  const run = await first<{ status: string }>(c.env.DB, `SELECT status FROM payroll_runs WHERE id = ? AND company_id = ?`, c.req.param("id"), company.id);
  if (!run) throw notFound("Payroll");
  if (run.status !== "draft") throw conflict("POSTED_IMMUTABLE", "Posted payroll cannot be deleted");
  await batch(c.env.DB, [stmt(c.env.DB, `DELETE FROM payroll_runs WHERE id = ? AND company_id = ? AND status = 'draft'`, c.req.param("id"), company.id)]);
  return c.json({ ok: true });
});

/** Post the salary journal: expense and employer contributions against salaries payable and statutory liabilities. */
payroll.post("/runs/:id/post", async (c) => {
  requirePerm(c, "payroll.manage");
  const company = c.get("company");
  const runId = c.req.param("id");
  const run = await first<{ status: string; period: string; pay_date: string }>(c.env.DB, `SELECT status, period, pay_date FROM payroll_runs WHERE id = ? AND company_id = ?`, runId, company.id);
  if (!run) throw notFound("Payroll");
  if (run.status !== "draft") throw conflict("ALREADY_POSTED", "This payroll is already posted");
  const t = await first<Record<string, number>>(c.env.DB,
    `SELECT SUM(gross) gross, SUM(net) net, SUM(pf_employee) pfe, SUM(pf_employer) pfr, SUM(esi_employee) esie, SUM(esi_employer) esir, SUM(pt) pt, SUM(tds) tds, SUM(other_deductions) oth
     FROM payslips WHERE run_id = ?`, runId);
  if (!t || !t.gross) throw badRequest("Nothing to post: total gross pay is zero");
  await assertOpenPeriod(c.env.DB, company.id, run.pay_date);
  const acc = await payrollAccounts(c.env.DB, company);
  const lines: LineInput[] = [
    { account_id: acc.SALARY_EXP, debit: t.gross, description: `Salaries ${run.period}` },
    { account_id: acc.EMPLOYER_CONTRIB, debit: t.pfr + t.esir, description: "Employer PF / ESI" },
    { account_id: acc.SALARY_PAYABLE, credit: t.net, description: "Net pay" },
    { account_id: acc.PF_PAYABLE, credit: t.pfe + t.pfr, description: "Provident fund" },
    { account_id: acc.ESI_PAYABLE, credit: t.esie + t.esir, description: "ESI" },
    { account_id: acc.PT_PAYABLE, credit: t.pt, description: "Professional tax" },
    { account_id: acc.TDS_PAYABLE, credit: t.tds, description: "TDS on salary" },
    { account_id: acc.PAYROLL_OTHER, credit: t.oth, description: "Other deductions" },
  ];
  const built = buildJournal(c.env.DB, {
    company_id: company.id, entry_date: run.pay_date, kind: "system", memo: `Payroll ${run.period}`, source_type: "payroll", source_id: runId,
    created_by: c.get("user").id, post: true, lines,
  });
  await batch(c.env.DB, [
    ...built.stmts,
    stmt(c.env.DB, `UPDATE payroll_runs SET status = 'posted', journal_entry_id = ? WHERE id = ? AND status = 'draft'`, built.id, runId),
    audit(c, "payroll.post", "payroll_run", runId, { period: run.period, gross: t.gross, net: t.net }),
  ]);
  return c.json({ ok: true, journal_entry_id: built.id });
});

/** Record that net salaries were paid from a bank/cash account. */
payroll.post("/runs/:id/pay", async (c) => {
  requirePerm(c, "payroll.manage");
  const company = c.get("company");
  const runId = c.req.param("id");
  const input = await body(c, z.object({ account_id: z.string(), date: isoDate }));
  const run = await first<{ status: string; period: string; net: number }>(c.env.DB, `SELECT status, period, net FROM payroll_runs WHERE id = ? AND company_id = ?`, runId, company.id);
  if (!run) throw notFound("Payroll");
  if (run.status !== "posted") throw conflict("INVALID_STATUS", run.status === "paid" ? "Salaries are already marked paid" : "Post the payroll first");
  await assertPostable(c.env.DB, company.id, input.account_id, "Payment account");
  const acc = await payrollAccounts(c.env.DB, company);
  const built = buildJournal(c.env.DB, {
    company_id: company.id, entry_date: input.date, kind: "system", memo: `Salary payment ${run.period}`, source_type: "payroll_payment", source_id: runId,
    created_by: c.get("user").id, post: true,
    lines: [{ account_id: acc.SALARY_PAYABLE, debit: run.net }, { account_id: input.account_id, credit: run.net }],
  });
  await batch(c.env.DB, [
    ...built.stmts,
    stmt(c.env.DB, `UPDATE payroll_runs SET status = 'paid', payment_entry_id = ? WHERE id = ? AND status = 'posted'`, built.id, runId),
    audit(c, "payroll.pay", "payroll_run", runId, { net: run.net }),
  ]);
  return c.json({ ok: true, journal_entry_id: built.id });
});

payroll.get("/payslips/:id", async (c) => {
  requirePerm(c, "payroll.read");
  const company = c.get("company");
  const slip = await first(c.env.DB,
    `SELECT p.*, r.period, r.pay_date, r.status AS run_status, e.code, e.name, e.designation, e.pan, e.uan, e.esi_number, e.bank_name, e.bank_account, e.ifsc, e.date_of_joining, e.pay_type
     FROM payslips p JOIN payroll_runs r ON r.id = p.run_id JOIN employees e ON e.id = p.employee_id WHERE p.id = ? AND p.company_id = ?`, c.req.param("id"), company.id);
  if (!slip) throw notFound("Payslip");
  return c.json({ payslip: slip });
});

/** Salary register: one row per employee per month across posted payrolls. */
payroll.get("/report", async (c) => {
  requirePerm(c, "payroll.read");
  const company = c.get("company");
  const from = c.req.query("from") ?? "0000-01";
  const to = c.req.query("to") ?? "9999-12";
  const rows = await all(c.env.DB,
    `SELECT r.period, e.code, e.name, p.paid_days_milli, p.basic, p.hra, p.allowances, p.overtime, p.gross, p.pf_employee, p.esi_employee, p.pt, p.tds, p.other_deductions,
            p.total_deductions, p.net, p.pf_employer, p.esi_employer, r.status
     FROM payslips p JOIN payroll_runs r ON r.id = p.run_id JOIN employees e ON e.id = p.employee_id
     WHERE p.company_id = ? AND r.status <> 'draft' AND r.period BETWEEN ? AND ? ORDER BY r.period, e.code`, company.id, from, to);
  return c.json({ rows });
});

export default payroll;
