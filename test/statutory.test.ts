import { describe, expect, it } from "vitest";
import { world } from "./helpers";
import { ecrRow } from "../src/shared/statutory";

describe("statutory payroll files", () => {
  it("splits the employer PF share into EPS and EPF the way EPFO expects", () => {
    // Basic ₹15,000 or more: EPF 1,800, EPS 1,250 (8.33 % of 15,000 rounded), difference 550.
    expect(ecrRow({ code: "E1", name: "Asha K.", uan: "1002-0030-0400", esi_number: null, pan: null, working_days: 30, paid_days_milli: 30_000, basic: 2_500_000, gross: 3_000_000, pf_employee: 180_000, pf_employer: 180_000, esi_employee: 0, esi_employer: 0, tds: 0 }))
      .toEqual({ uan: "100200300400", name: "ASHA K.", gross: 30_000, epf_wages: 15_000, eps_wages: 15_000, edli_wages: 15_000, epf: 1800, eps: 1250, diff: 550, ncp: 0, refund: 0 });
  });

  it("makes the ECR, ESIC and Form 24Q rows from a posted payroll", async () => {
    const W = await world();
    const emp = (b: Record<string, unknown>) => W.owner.post(W.c("/payroll/employees"), { pay_type: "monthly", date_of_joining: "2026-01-01", ...b });
    expect((await emp({ code: "E001", name: "Asha Rao", monthly_basic: "20000", hra: "5000", pf_enabled: true, uan: "100200300400", pan: "ABCDE1234F", tds_monthly: "1500" })).status).toBe(201);
    expect((await emp({ code: "E002", name: "Ravi", monthly_basic: "10000", pf_enabled: true, esi_enabled: true, uan: "123", esi_number: "1234567890" })).status).toBe(201);
    const run = (await W.owner.post(W.c("/payroll/runs"), { period: "2026-05", pay_date: "2026-05-31" })).json.id;
    expect((await W.owner.get(W.c(`/payroll/runs/${run}/statutory`))).status).toBe(409); // draft
    const asha = (await W.owner.get(W.c(`/payroll/runs/${run}`))).json.payslips.find((p: any) => p.code === "E001");
    await W.owner.put(W.c(`/payroll/runs/${run}/payslips/${asha.id}`), { paid_days: "29" });
    expect((await W.owner.post(W.c(`/payroll/runs/${run}/post`))).status).toBe(200);

    const f = (await W.owner.get(W.c(`/payroll/runs/${run}/statutory`))).json;
    // Asha: 29 of 31 days → basic 18,709.68 (capped 15,000), gross 23,387.10; Ravi: 10,000 basic, EPS 833, difference 367.
    expect(f.ecr.text.split("\n")).toEqual([
      "100200300400#~#ASHA RAO#~#23387#~#15000#~#15000#~#15000#~#1800#~#1250#~#550#~#2#~#0",
      "123#~#RAVI#~#10000#~#10000#~#10000#~#10000#~#1200#~#833#~#367#~#0#~#0",
    ]);
    expect(f.ecr.problems).toEqual(["E002 Ravi: UAN must be 12 digits"]);
    // A/c 1 = 1,800 + 550 + 1,200 + 367; A/c 2 = 0.5 % of 25,000 = 125 → minimum 500; A/c 10 = 2,083; A/c 21 = 125.
    expect(f.ecr.summary).toEqual({ members: 2, epf_wages: 25_000, ac1: 3917, ac2: 500, ac10: 2083, ac21: 125, ac22: 0, total: 6625 });
    expect(f.esi.rows).toEqual([{ ip_number: "1234567890", name: "Ravi", days: 31, wages: 10_000, reason: 0, last_working_day: "", employee_share: 75, employer_share: 325 }]);
    expect(f.esi.problems).toEqual([]);

    const q = (await W.owner.get(W.c("/payroll/tds-24q?fy=2026&quarter=1"))).json;
    expect(q.months).toEqual(["2026-04", "2026-05", "2026-06"]);
    expect(q.rows).toEqual([{ employee_ref: "E001", pan: "ABCDE1234F", name: "Asha Rao", section: "192", payment_date: "31/05/2026", amount_paid: 23_387, tds: 1500, deduction_date: "31/05/2026" }]);
    expect((await W.owner.get(W.c("/payroll/tds-24q?fy=2026&quarter=4"))).json.months).toEqual(["2027-01", "2027-02", "2027-03"]);
    expect((await W.owner.get(W.c("/payroll/tds-24q?fy=2026&quarter=5"))).status).toBe(400);
  });
});
