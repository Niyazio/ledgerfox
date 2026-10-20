import { describe, expect, it, beforeAll } from "vitest";
import { world, register, contact, Client, type World } from "./helpers";
import { computePayslip, type PayEmployee } from "../src/shared/payroll";

const base: PayEmployee = { pay_type: "monthly", monthly_basic: 0, hra: 0, other_allowances: 0, hourly_rate: 0, overtime_rate: 0, pf_enabled: 1, esi_enabled: 1, pt_monthly: 20000, tds_monthly: 0 };
const full = { working_days: 30, paid_days_milli: 30000, worked_minutes: 0, overtime_minutes: 0, statutory_india: true };

describe("payslip arithmetic", () => {
  it("caps PF at the ₹15,000 wage ceiling and skips ESI above ₹21,000 gross", () => {
    const p = computePayslip({ ...base, monthly_basic: 2_000_000, hra: 800_000 }, full);
    expect(p.gross).toBe(2_800_000);
    expect(p.pf_employee).toBe(180_000);
    expect(p.pf_employer).toBe(180_000);
    expect(p.esi_employee).toBe(0);
    expect(p.pt).toBe(20_000);
    expect(p.net).toBe(2_800_000 - 180_000 - 20_000);
  });

  it("applies ESI (0.75% / 3.25%, rounded up to the rupee) at or below ₹21,000 gross", () => {
    const p = computePayslip({ ...base, monthly_basic: 1_200_000, hra: 300_000 }, full);
    expect(p.gross).toBe(1_500_000);
    expect(p.pf_employee).toBe(144_000);
    expect(p.esi_employee).toBe(11_300);
    expect(p.esi_employer).toBe(48_800);
    expect(p.total_deductions).toBe(144_000 + 11_300 + 20_000);
  });

  it("prorates loss of pay, pays hourly staff from timesheets, and adds overtime", () => {
    expect(computePayslip({ ...base, monthly_basic: 3_000_000, pf_enabled: 0, esi_enabled: 0, pt_monthly: 0 }, { ...full, paid_days_milli: 15000 }).basic).toBe(1_500_000);
    const h = computePayslip({ ...base, pay_type: "hourly", hourly_rate: 150_000, overtime_rate: 200_000, pf_enabled: 0, esi_enabled: 0, pt_monthly: 0 }, { ...full, worked_minutes: 630, overtime_minutes: 90 });
    expect(h.basic).toBe(1_575_000);
    expect(h.overtime).toBe(300_000);
    expect(h.net).toBe(1_875_000);
  });

  it("never deducts more than the gross and skips statutory items outside India", () => {
    const p = computePayslip({ ...base, monthly_basic: 100_000, tds_monthly: 900_000 }, full);
    expect(p.net).toBeGreaterThanOrEqual(0);
    const us = computePayslip({ ...base, monthly_basic: 500_000 }, { ...full, statutory_india: false });
    expect(us.pf_employee + us.esi_employee).toBe(0);
  });
});

describe("payroll in the ledger", () => {
  let W: World;
  let emp1: string;
  let runId: string;

  beforeAll(async () => {
    W = await world();
    const e1 = await W.owner.post(W.c("/payroll/employees"), { code: "E001", name: "Asha", pay_type: "monthly", monthly_basic: "12000", hra: "3000", pf_enabled: true, esi_enabled: true, pt_monthly: "200", date_of_joining: "2026-01-01" });
    expect(e1.status).toBe(201);
    emp1 = e1.json.id;
    const e2 = await W.owner.post(W.c("/payroll/employees"), { code: "E002", name: "Ravi", pay_type: "hourly", hourly_rate: "500", overtime_rate: "750" });
    expect(e2.status).toBe(201);
    expect((await W.owner.post(W.c("/payroll/timesheets"), { employee_id: e2.json.id, work_date: "2026-05-04", hours: "8", overtime_hours: "2" })).status).toBe(201);
    expect((await W.owner.post(W.c("/payroll/timesheets"), { employee_id: e2.json.id, work_date: "2026-05-05", hours: "7.5" })).status).toBe(201);
    expect((await W.owner.post(W.c("/payroll/timesheets"), { employee_id: e2.json.id, work_date: "2026-05-06", hours: "30" })).status).toBe(400);
  });

  it("creates a draft run with payslips from salaries and timesheets", async () => {
    const r = await W.owner.post(W.c("/payroll/runs"), { period: "2026-05", pay_date: "2026-05-31" });
    expect(r.status).toBe(201);
    runId = r.json.id;
    expect((await W.owner.post(W.c("/payroll/runs"), { period: "2026-05", pay_date: "2026-05-31" })).status).toBe(409);
    const run = await W.owner.get(W.c(`/payroll/runs/${runId}`));
    const ravi = run.json.payslips.find((p: any) => p.code === "E002");
    expect(ravi.basic).toBe(775_000);    // 15.5 h × ₹500
    expect(ravi.overtime).toBe(150_000); // 2 h × ₹750
    const asha = run.json.payslips.find((p: any) => p.code === "E001");
    expect(asha.gross).toBe(1_500_000);
    // Two days loss of pay plus a ₹500 canteen deduction.
    const adj = await W.owner.put(W.c(`/payroll/runs/${runId}/payslips/${asha.id}`), { paid_days: "29", other_deductions: "500" });
    expect(adj.status).toBe(200);
    const after = (await W.owner.get(W.c(`/payroll/runs/${runId}`))).json.payslips.find((p: any) => p.code === "E001");
    expect(after.gross).toBe(1_403_226); // 29 of May's 31 days
    expect(after.other_deductions).toBe(50_000);
    expect(after.net).toBe(after.gross - after.total_deductions);
  });

  it("posts a balanced salary journal and records payment; posted payroll is frozen", async () => {
    const posted = await W.owner.post(W.c(`/payroll/runs/${runId}/post`));
    expect(posted.status).toBe(200);
    const tb = await W.owner.get(W.c("/reports/trial-balance?as_of=2026-05-31"));
    expect(tb.status).toBe(200);
    expect(tb.json.totals.debit).toBe(tb.json.totals.credit);
    const run = (await W.owner.get(W.c(`/payroll/runs/${runId}`))).json;
    expect(run.run.status).toBe("posted");
    const slip = run.payslips[0];
    expect((await W.owner.put(W.c(`/payroll/runs/${runId}/payslips/${slip.id}`), { paid_days: "10" })).status).toBe(409);
    expect((await W.owner.del(W.c(`/payroll/runs/${runId}`))).status).toBe(409);
    expect((await W.owner.post(W.c("/payroll/timesheets"), { employee_id: emp1, work_date: "2026-05-20", hours: "8" })).status).toBe(409);
    await expect(W.env.DB.prepare("UPDATE payslips SET net = 1 WHERE id = ?").bind(slip.id).run()).rejects.toThrow(/POSTED_IMMUTABLE/);
    const pay = await W.owner.post(W.c(`/payroll/runs/${runId}/pay`), { account_id: W.acc.BANK, date: "2026-05-31" });
    expect(pay.status).toBe(200);
    expect((await W.owner.post(W.c(`/payroll/runs/${runId}/pay`), { account_id: W.acc.BANK, date: "2026-05-31" })).status).toBe(409);
    const payable = await W.env.DB.prepare(`SELECT COALESCE(SUM(credit) - SUM(debit), 0) AS bal FROM journal_lines WHERE account_id = ?`).bind(W.acc.SALARY_PAYABLE).first<{ bal: number }>();
    expect(payable?.bal).toBe(0);
    const report = await W.owner.get(W.c("/payroll/report?from=2026-05&to=2026-05"));
    expect(report.json.rows).toHaveLength(2);
    const slipView = await W.owner.get(W.c(`/payroll/payslips/${slip.id}`));
    expect(slipView.json.payslip.period).toBe("2026-05");
  });

  it("salary data is hidden from read-only members", async () => {
    const { client, email } = await register(W.env, "Viewer");
    const inv = await W.owner.post(`/api/orgs/${W.orgId}/invitations`, { email, role: "viewer" });
    await client.post("/api/invitations/accept", { token: inv.json.token });
    expect((await client.get(W.c("/payroll/employees"))).status).toBe(403);
    expect((await client.get(W.c("/payroll/report"))).status).toBe(403);
  });
});

describe("business types, demo companies and usernames", () => {
  let W: World;
  beforeAll(async () => { W = await world(); });

  it("a restaurant company gets food & beverage accounts, units and starter items with GST 5%", async () => {
    const r = await W.owner.post(`/api/orgs/${W.orgId}/companies`, { name: "Spice Route", country: "IN", base_currency: "INR", fiscal_year_start_month: 4, state_code: "29", business_type: "restaurant" });
    expect(r.status).toBe(201);
    const c = (p: string) => `/api/c/${r.json.company_id}${p}`;
    const accounts = (await W.owner.get(c("/accounts"))).json.accounts.map((a: any) => a.name);
    expect(accounts).toEqual(expect.arrayContaining(["Food Sales", "Beverage Sales", "Delivery Platform Commission"]));
    const items = (await W.owner.get(c("/items?limit=50"))).json.items;
    expect(items.length).toBe(4);
    const settings = (await W.owner.get(c("/settings"))).json;
    const gst5 = settings.tax_codes.find((t: any) => t.name === "GST 5%").id;
    expect(items.every((i: any) => i.tax_code_id === gst5)).toBe(true);
    expect(settings.company.business_type).toBe("restaurant");
  });

  it("demo companies can be deleted with all their posted data; real companies cannot", async () => {
    const r = await W.owner.post(`/api/orgs/${W.orgId}/companies`, { name: "Demo", country: "IN", base_currency: "INR", fiscal_year_start_month: 4, state_code: "29", business_type: "retail", is_demo: true });
    const demoId = r.json.company_id;
    const c = (p: string) => `/api/c/${demoId}${p}`;
    const cust = (await W.owner.post(c("/contacts"), { kind: "customer", name: "Walk-in", state_code: "29" })).json.id;
    const inv = await W.owner.post(c("/documents"), { doc_type: "invoice", contact_id: cust, issue_date: "2026-05-05", lines: [{ description: "x", quantity: "1", unit_price: "100" }] });
    expect((await W.owner.post(c(`/documents/${inv.json.id}/issue`))).status).toBe(200);
    const accs = (await W.owner.get(c("/accounts"))).json.accounts;
    const bank = accs.find((a: any) => a.system_key === "BANK").id;
    expect((await W.owner.post(c("/payments"), { direction: "in", contact_id: cust, payment_date: "2026-05-06", account_id: bank, amount: "50", allocations: [{ document_id: inv.json.id, amount: "50" }] })).status).toBe(201);
    expect((await W.owner.post(c("/payroll/employees"), { code: "E1", name: "Demo staff", monthly_basic: "10000" })).status).toBe(201);
    const run = await W.owner.post(c("/payroll/runs"), { period: "2026-05", pay_date: "2026-05-31" });
    expect((await W.owner.post(c(`/payroll/runs/${run.json.id}/post`))).status).toBe(200);
    expect((await W.owner.post(c("/verify"), { entity_type: "document", entity_id: inv.json.id })).status).toBe(200);
    const del = await W.owner.del(`/api/orgs/${W.orgId}/companies/${demoId}`);
    expect(del.status).toBe(200);
    expect((await W.owner.get(c("/settings"))).status).toBe(404);
    const left = await W.env.DB.prepare("SELECT (SELECT COUNT(*) FROM journal_entries WHERE company_id = ?) + (SELECT COUNT(*) FROM documents WHERE company_id = ?) AS n").bind(demoId, demoId).first<{ n: number }>();
    expect(left?.n).toBe(0);
    expect((await W.owner.del(`/api/orgs/${W.orgId}/companies/${W.companyId}`)).status).toBe(409);
    await expect(W.env.DB.prepare("INSERT INTO company_purge (company_id) VALUES (?)").bind(W.companyId).run()).rejects.toThrow(/NOT_DEMO/);
  });

  it("people can sign in with a username instead of an email", async () => {
    const c = new Client(W.env);
    const reg = await c.post("/api/auth/register", { name: "Uma", email: "uma@example.com", username: "uma.k", password: "correct horse battery" });
    expect(reg.status).toBe(201);
    const fresh = new Client(W.env);
    expect((await fresh.post("/api/auth/login", { login: "UMA.K", password: "correct horse battery" })).status).toBe(200);
    expect((await fresh.get("/api/auth/me")).json.user.username).toBe("uma.k");
    expect((await new Client(W.env).post("/api/auth/register", { name: "Dup", email: "dup@example.com", username: "uma.k", password: "correct horse battery" })).status).toBe(409);
  });
});



describe("QR verification", () => {
  it("returns only summary details for a valid token and nothing for unknown ones", async () => {
    const W = await world();
    const cust = await contact(W, "customer", { state_code: "29" });
    const inv = await W.owner.post(W.c("/documents"), { doc_type: "invoice", contact_id: cust, issue_date: "2026-05-05", lines: [{ description: "x", quantity: "2", unit_price: "500" }] });
    const draftTok = (await W.owner.post(W.c("/verify"), { entity_type: "document", entity_id: inv.json.id })).json.token;
    const anon = new Client(W.env);
    expect((await anon.get(`/api/verify/${draftTok}`)).json.valid).toBe(false);
    await W.owner.post(W.c(`/documents/${inv.json.id}/issue`));
    const again = await W.owner.post(W.c("/verify"), { entity_type: "document", entity_id: inv.json.id });
    expect(again.json.token).toBe(draftTok);
    const r = await anon.get(`/api/verify/${draftTok}`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ valid: true, kind: "Invoice", amount: 100_000, currency: "INR" });
    expect(JSON.stringify(r.json)).not.toMatch(/company_id|contact_id|email/);
    expect((await anon.get("/api/verify/abcdefghijklmnopqrstuv")).status).toBe(404);
    expect((await anon.get("/api/verify/x")).status).toBe(404);
    // Another company's member cannot mint tokens for this invoice.
    const other = await world();
    expect((await other.owner.post(other.c("/verify"), { entity_type: "document", entity_id: inv.json.id })).status).toBe(404);
  });
});
