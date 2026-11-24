import { describe, expect, it } from "vitest";
import { world, contact, register, rawQuery } from "./helpers";
import { numberGaps } from "../src/worker/services/auditchecks";
import { defaultModulesOff } from "../src/shared/modules";

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

describe("features on / off", () => {
  it("starts a school without scanning, POS or labels, keeps practice companies complete, and closes switched-off features", async () => {
    expect(defaultModulesOff("education")).toEqual(expect.arrayContaining(["scanning", "pos", "labels"]));
    expect(defaultModulesOff("general")).toEqual([]);
    const W = await world();
    const school = (await W.owner.post(`/api/orgs/${W.orgId}/companies`, { name: "Bright School", country: "IN", base_currency: "INR", fiscal_year_start_month: 4, state_code: "29", business_type: "education" })).json.company_id;
    const s = (await W.owner.get(`/api/c/${school}/settings`)).json.company;
    expect(JSON.parse(s.modules_off)).toEqual(expect.arrayContaining(["scanning", "pos"]));
    // Existing companies (before this feature) have everything on.
    await rawQuery(W, `UPDATE companies SET modules_off = NULL WHERE id = ?`, W.companyId);
    expect((await W.owner.get(W.c("/projects"))).status).toBe(200);
    expect((await W.owner.put(W.c("/settings/modules"), { off: ["projects", "payroll"] })).json.off).toEqual(["projects", "payroll"]);
    const closed = await W.owner.get(W.c("/projects"));
    expect([closed.status, closed.json.error.code]).toEqual([403, "MODULE_OFF"]);
    expect(closed.json.error.message).toMatch(/Settings → Features/);
    expect((await W.owner.put(W.c("/settings/modules"), { off: ["nonsense"] })).status).toBe(400);
    await W.owner.put(W.c("/settings/modules"), { off: [] });
    expect((await W.owner.get(W.c("/projects"))).status).toBe(200);
    // A cashier cannot change the features.
    const { client } = await register(W.env, "Someone else");
    expect((await client.put(W.c("/settings/modules"), { off: [] })).status).toBeGreaterThanOrEqual(403);
  });
});

describe("contra entries", () => {
  it("moves cash to the bank as one numbered entry, and cancels it with a reversal", async () => {
    const W = await world();
    expect((await W.owner.post(W.c("/banking/contra"), { entry_date: day(0), from_account_id: W.acc.CASH, to_account_id: W.acc.CASH, amount: "100" })).status).toBe(400);
    expect((await W.owner.post(W.c("/banking/contra"), { entry_date: day(0), from_account_id: W.acc.CASH, to_account_id: W.acc.SALES, amount: "100" })).status).toBe(400);
    const r = await W.owner.post(W.c("/banking/contra"), { entry_date: day(0), from_account_id: W.acc.CASH, to_account_id: W.acc.BANK, amount: "5000", reference: "Deposit slip 42" });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.entry_number).toBeTruthy();
    const list = (await W.owner.get(W.c("/banking/contra"))).json.contras;
    expect(list[0]).toMatchObject({ from_account: expect.stringMatching(/Cash/), to_account: expect.stringMatching(/Bank/), total: 500_000, memo: expect.stringMatching(/Cash deposited/) });
    const bal = async (acc: string) => (await rawQuery(W, `SELECT COALESCE(SUM(debit - credit),0) AS b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.status = 'posted' AND l.account_id = ?`, acc))[0].b;
    expect([await bal(W.acc.CASH), await bal(W.acc.BANK)]).toEqual([-500_000, 500_000]);
    expect((await W.owner.post(W.c(`/banking/contra/${r.json.id}/cancel`), { reason: "Wrong account" })).status).toBe(200);
    expect([await bal(W.acc.CASH), await bal(W.acc.BANK)]).toEqual([0, 0]);
    expect((await W.owner.post(W.c(`/banking/contra/${r.json.id}/cancel`), {})).status).toBe(409);
  });
});

describe("audit checks", () => {
  it("finds number gaps in any series", () => {
    expect(numberGaps(["INV-00001", "INV-00002", "INV-00005", "CN-0001"])).toEqual([{ series: "INV-", missing: "INV-00003" }, { series: "INV-", missing: "INV-00004" }]);
    expect(numberGaps(["INV-00001", "INV-00002"])).toEqual([]);
  });

  it("flags big cash payments and receipts, negative cash, duplicate bills, manual journals and late entries", async () => {
    const W = await world();
    const supp = await contact(W, "supplier", { name: "Cash Vendor" });
    const cust = await contact(W, "customer", { name: "Big Cash Buyer" });
    const pay = (direction: string, contact_id: string, amount: string, date = day(-2)) => W.owner.post(W.c("/payments"), { direction, contact_id, payment_date: date, account_id: W.acc.CASH, amount });
    await pay("in", cust, "250000");
    await pay("out", supp, "8000");
    await pay("out", supp, "7000");                 // 15,000 in cash to one supplier that day
    await pay("out", supp, "300000", day(-1));       // more than the cash there is
    for (const ref of ["SB-9", "sb-9"]) {
      const b = await W.owner.post(W.c("/documents"), { doc_type: "bill", contact_id: supp, issue_date: day(-3), reference: ref, lines: [{ description: "Goods", quantity: "1", unit_price: "100", account_id: W.acc.PURCHASES }] });
      await W.owner.post(W.c(`/documents/${b.json.id}/issue`));
    }
    const jv = await W.owner.post(W.c("/journals"), { entry_date: day(-40), memo: "Adjust customer balance", lines: [{ account_id: W.acc.AR, debit: "100", contact_id: cust }, { account_id: W.acc.SALES, credit: "100" }] });
    await W.owner.post(W.c(`/journals/${jv.json.id}/post`));
    const r = (await W.owner.get(W.c(`/reports/audit-checks?from=${day(-60)}&to=${day(0)}`))).json;
    const by = Object.fromEntries(r.checks.map((c: any) => [c.key, c]));
    expect(by.cash_payments_40a3).toMatchObject({ ok: false, count: 2 }); // 8,000 + 7,000 on one day, and the 3,00,000 next day
    expect(by.cash_payments_40a3.rows[0]).toMatchObject({ party: "Cash Vendor", amount: 1_500_000 });
    expect(by.cash_receipts_269st.rows[0]).toMatchObject({ party: "Big Cash Buyer", amount: 25_000_000 });
    expect(by.negative_cash.ok).toBe(false);
    expect(by.duplicate_bills.rows[0]).toMatchObject({ reference: "SB-9", bills: 2 });
    expect(by.manual_to_control.rows.length).toBeGreaterThan(0);
    expect(by.backdated.rows[0]).toMatchObject({ days_late: 40 });
    expect(by.number_gaps.ok).toBe(true);
    expect(by.periods_locked.ok).toBe(false);
  });
});
