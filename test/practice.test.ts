import { describe, expect, it } from "vitest";
import { world, register, rawQuery, contact } from "./helpers";

const practice = { name: "Learning Traders", country: "IN", base_currency: "INR", fiscal_year_start_month: 4, state_code: "29", is_practice: true };

async function learner(W: Awaited<ReturnType<typeof world>>) {
  const { client } = await register(W.env, "Student");
  const r = (await client.post("/api/orgs", { name: "My learning", company: practice })).json;
  return { client, orgId: r.org_id as string, c: (p: string) => `/api/c/${r.company_id}${p}`, companyId: r.company_id as string };
}

describe("education mode (practice companies)", () => {
  it("is free with every feature on any plan, says so in its name, and never asks for auto-pay", async () => {
    const W = await world();
    Object.assign(W.env, { BILLING_ENABLED: "true", BILLING_REQUIRE_AUTOPAY: "true" });
    const L = await learner(W);
    expect((await L.client.get(L.c("/settings"))).json.company).toMatchObject({ name: "Learning Traders (Practice)", is_practice: 1 });
    // Even with the trial over and no plan, POS (a paid feature) works in the practice company.
    await L.client.get(`/api/billing/org/${L.orgId}`);
    await rawQuery(W, `UPDATE org_subscriptions SET trial_ends_at = ? WHERE org_id = ?`, "2020-01-01T00:00:00Z", L.orgId);
    expect((await L.client.get(`/api/billing/org/${L.orgId}`)).json).toMatchObject({ demo_only: true, autopay_required: false });
    const item = (await L.client.post(L.c("/items"), { kind: "goods", name: "Pen", sale_price: "10" })).json.id;
    expect(item).toBeTruthy();
    // A learning-only organisation can hold a class (more users than the Free plan's 1).
    for (let i = 0; i < 3; i++) expect((await L.client.post(`/api/orgs/${L.orgId}/users`, { name: `Student ${i}`, username: `student.${i}.${Date.now()}`, role: "accountant" })).status).toBe(201);
    // Buying a plan for a learning-only organisation is refused.
    expect((await L.client.post(`/api/billing/org/${L.orgId}/checkout`, { plan: "starter", interval: "monthly" })).json.error.code).toBe("DEMO_ONLY");
  });

  it("accepts entries only on the 1st, 2nd and last day of a month, like Tally's educational mode", async () => {
    const W = await world();
    const L = await learner(W);
    const cust = (await L.client.post(L.c("/contacts"), { kind: "customer", name: "Ravi" })).json.id;
    const inv = (date: string) => L.client.post(L.c("/documents"), { doc_type: "invoice", contact_id: cust, issue_date: date, lines: [{ description: "Pen", quantity: "1", unit_price: "10" }] });
    for (const [date, ok] of [["2026-05-01", true], ["2026-05-02", true], ["2026-05-31", true], ["2026-04-30", true], ["2026-05-15", false], ["2026-05-30", false]] as const) {
      const d = (await inv(date)).json.id;
      const posted = await L.client.post(L.c(`/documents/${d}/issue`));
      expect([date, posted.status === 200 ? "posted" : posted.json.error.code]).toEqual([date, ok ? "posted" : "PRACTICE_DATE"]);
    }
    // February's last day counts too (2028 is a leap year).
    const feb = (await inv("2028-02-29")).json.id;
    await L.client.post(L.c("/settings/fiscal-years"), { name: "FY 2027-28", start_date: "2027-04-01", end_date: "2028-03-31" });
    expect((await L.client.post(L.c(`/documents/${feb}/issue`))).status).toBe(200);
    // Manual journals follow the same rule.
    const acc = (await L.client.get(L.c("/accounts"))).json.accounts;
    const cash = acc.find((a: any) => a.system_key === "CASH").id, sales = acc.find((a: any) => a.code === "4000" || a.type === "income").id;
    const j = await L.client.post(L.c("/journals"), { entry_date: "2026-06-10", lines: [{ account_id: cash, debit: "5" }, { account_id: sales, credit: "5" }] });
    expect(j.json.error?.code).toBe("PRACTICE_DATE");
  });

  it("cannot produce real e-invoice / e-way bill files or public verification codes; real companies are unaffected", async () => {
    const W = await world();
    const L = await learner(W);
    const cust = (await L.client.post(L.c("/contacts"), { kind: "customer", name: "Ravi", tax_id: null })).json.id;
    const d = (await L.client.post(L.c("/documents"), { doc_type: "invoice", contact_id: cust, issue_date: "2026-05-01", lines: [{ description: "Pen", quantity: "1", unit_price: "10" }] })).json.id;
    await L.client.post(L.c(`/documents/${d}/issue`));
    expect((await L.client.post(L.c(`/documents/${d}/gst/einvoice`), {})).json.error.code).toBe("PRACTICE_MODE");
    expect((await L.client.post(L.c(`/documents/${d}/gst/eway`), {})).json.error.code).toBe("PRACTICE_MODE");
    expect((await L.client.post(L.c("/verify"), { entity_type: "document", entity_id: d })).json.error.code).toBe("PRACTICE_MODE");
    // A normal company in the same database: any date, QR codes work.
    const real = await contact(W, "customer");
    const rd = (await W.owner.post(W.c("/documents"), { doc_type: "invoice", contact_id: real, issue_date: "2026-05-15", lines: [{ description: "x", quantity: "1", unit_price: "10" }] })).json.id;
    expect((await W.owner.post(W.c(`/documents/${rd}/issue`))).status).toBe(200);
    expect((await W.owner.post(W.c("/verify"), { entity_type: "document", entity_id: rd })).status).toBe(200);
  });
});
