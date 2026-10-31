import { describe, expect, it, vi, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { makeEnv, Client, rawQuery } from "./helpers";

const SECRET = "test_key_secret", HOOK = "test_webhook_secret";
const sign = (s: string, data: string) => createHmac("sha256", s).update(data).digest("hex");
afterEach(() => vi.restoreAllMocks());

/** A business outside India: its own owner, organisation and company in that country. */
async function abroad(country: string, currency: string, tax_id?: string) {
  const { env } = await makeEnv();
  Object.assign(env, { BILLING_ENABLED: "true", RAZORPAY_KEY_ID: "rzp_test_x", RAZORPAY_KEY_SECRET: SECRET, RAZORPAY_WEBHOOK_SECRET: HOOK, BILLING_GST_PERCENT: "18" });
  const owner = new Client(env);
  await owner.post("/api/auth/register", { name: "Owner", email: `o-${country}-${Math.random().toString(36).slice(2, 7)}@example.com`, password: "correct horse battery", accept_terms: true });
  const r = await owner.post("/api/orgs", { name: "Gulf Org", company: { name: "Al Noor Trading", country, base_currency: currency, fiscal_year_start_month: 1, ...(tax_id ? { tax_id } : {}) } });
  return { env, owner, orgId: r.json.org_id as string, companyId: r.json.company_id as string, status: r.status, error: r.json.error };
}

describe("Gulf and international companies", () => {
  it("set up Saudi VAT, check the VAT number, and bill 15% VAT", async () => {
    const bad = await abroad("SA", "SAR", "123");
    expect([bad.status, bad.error.message]).toEqual([400, expect.stringMatching(/VAT number/)]);
    const W = await abroad("SA", "SAR", "310122393500003");
    const c = (p: string) => `/api/c/${W.companyId}${p}`;
    const settings = (await W.owner.get(c("/settings"))).json;
    expect(settings.tax_codes.map((t: any) => t.name)).toEqual(expect.arrayContaining(["VAT 15%", "VAT 0% (zero-rated)", "VAT exempt"]));
    const vat15 = settings.tax_codes.find((t: any) => t.name === "VAT 15%");
    const cust = (await W.owner.post(c("/contacts"), { kind: "customer", name: "Walk-in" })).json.id;
    const inv = await W.owner.post(c("/documents"), { doc_type: "invoice", contact_id: cust, issue_date: new Date().toISOString().slice(0, 10), lines: [{ description: "Dates 1 kg", quantity: "2", unit_price: "50", tax_code_id: vat15.id }] });
    expect(inv.status, JSON.stringify(inv.json)).toBe(201);
    expect(inv.json.totals).toMatchObject({ taxable_total: 10_000, tax_total: 1_500, total: 11_500 });
  });

  it("set up UAE VAT 5% with a TRN, and refuse a wrong TRN in Settings", async () => {
    const W = await abroad("AE", "AED", "100123456700003");
    expect(W.status).toBe(201);
    const c = (p: string) => `/api/c/${W.companyId}${p}`;
    expect((await W.owner.get(c("/settings"))).json.tax_codes.map((t: any) => t.name)).toEqual(expect.arrayContaining(["VAT 5%", "VAT 5% reverse charge (imports)"]));
    const r = await W.owner.patch(c("/settings"), { name: "Al Noor Trading", tax_id: "12AB" });
    expect([r.status, r.json.error.message]).toEqual([400, expect.stringMatching(/TRN/)]);
    expect((await W.owner.patch(c("/settings"), { name: "Al Noor Trading", print_language: "ar" })).status).toBe(200);
    expect((await W.owner.get(c("/settings"))).json.company.print_language).toBe("ar");
  });

  it("charge subscriptions in the customer's currency by card, without Indian GST", async () => {
    const W = await abroad("AE", "AED");
    const calls: any[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any, init: any) => {
      const path = String(url).replace("https://api.razorpay.com/v1", "");
      calls.push({ path, body: init?.body ? JSON.parse(init.body) : null });
      if (path === "/orders") return Response.json({ id: "order_ae" });
      if (path === "/plans") return Response.json({ id: "plan_ae" });
      if (path === "/subscriptions") return Response.json({ id: "sub_ae", status: "created" });
      throw new Error(`unexpected fetch ${path}`);
    });
    const info = (await W.owner.get(`/api/billing/org/${W.orgId}`)).json;
    expect(info).toMatchObject({ currency: "AED", gst_percent: 0 });
    expect(info.plans.find((p: any) => p.id === "business").price).toEqual({ monthly: 4_500, yearly: 45_000 });

    const co = (await W.owner.post(`/api/billing/org/${W.orgId}/checkout`, { plan: "business", interval: "monthly" })).json;
    expect(co).toMatchObject({ amount: 4_500, currency: "AED" });
    expect(calls.find((x) => x.path === "/orders").body).toMatchObject({ amount: 4_500, currency: "AED" });
    await W.owner.post(`/api/billing/org/${W.orgId}/verify`, { razorpay_order_id: "order_ae", razorpay_payment_id: "pay_ae", razorpay_signature: sign(SECRET, "order_ae|pay_ae") });
    const after = (await W.owner.get(`/api/billing/org/${W.orgId}`)).json;
    expect(after.subscription).toMatchObject({ status: "active", plan: "business" });
    expect(after.payments[0]).toMatchObject({ currency: "AED", total: 4_500 });
    const paid = (await rawQuery({ env: W.env } as any, `SELECT amount, gst, total, currency FROM billing_payments WHERE org_id = ?`, W.orgId))[0];
    expect(paid).toEqual({ amount: 4_500, gst: 0, total: 4_500, currency: "AED" });

    // Auto-renew: the Razorpay plan is made in AED, and each charge is recorded in AED.
    await W.owner.post(`/api/billing/org/${W.orgId}/autopay`, { plan: "starter", interval: "monthly" });
    expect(calls.find((x) => x.path === "/plans").body.item).toMatchObject({ amount: 1_900, currency: "AED" });
    const evt = { event: "subscription.charged", payload: { subscription: { entity: { id: "sub_ae", status: "active" } }, payment: { entity: { id: "pay_ae2", status: "captured", amount: 1_900 } } } };
    await new Client(W.env).req("POST", "/api/billing/webhook", evt, { "x-razorpay-signature": sign(HOOK, JSON.stringify(evt)), "x-requested-with": "" });
    const charge = (await rawQuery({ env: W.env } as any, `SELECT total, gst, currency FROM billing_payments WHERE provider_payment_id = 'pay_ae2'`))[0];
    expect(charge).toEqual({ total: 1_900, gst: 0, currency: "AED" });
  });

  it("use US dollars for other countries and rupees with GST in India", async () => {
    const us = await abroad("US", "USD");
    expect((await us.owner.get(`/api/billing/org/${us.orgId}`)).json).toMatchObject({ currency: "USD", gst_percent: 0 });
    const inIndia = await abroad("IN", "INR");
    expect((await inIndia.owner.get(`/api/billing/org/${inIndia.orgId}`)).json).toMatchObject({ currency: "INR", gst_percent: 18 });
  });
});
