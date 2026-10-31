import { describe, expect, it, vi, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { world, rawQuery, register, Client } from "./helpers";

const SECRET = "test_key_secret", HOOK = "test_webhook_secret";
const sign = (s: string, data: string) => createHmac("sha256", s).update(data).digest("hex");

async function billedWorld() {
  const W = await world();
  Object.assign(W.env, { BILLING_ENABLED: "true", RAZORPAY_KEY_ID: "rzp_test_x", RAZORPAY_KEY_SECRET: SECRET, RAZORPAY_WEBHOOK_SECRET: HOOK, VENDOR_ADMIN_EMAILS: "" });
  return W;
}

/** A small stand-in for Razorpay's API that records what LedgerFox asked for. */
function mockRazorpay(payments: Record<string, { amount: number; status: string }> = {}) {
  const calls: { method: string; path: string; body: any }[] = [];
  let n = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any, init: any) => {
    const path = String(url).replace("https://api.razorpay.com/v1", "");
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ method: init?.method ?? "GET", path, body });
    if (path === "/plans") return Response.json({ id: `plan_${++n}` });
    if (path === "/subscriptions") return Response.json({ id: `sub_${++n}`, status: "created" });
    if (/^\/subscriptions\/[^/]+\/cancel$/.test(path)) return Response.json({ id: path.split("/")[2], status: "cancelled" });
    const pay = /^\/payments\/(.+)$/.exec(path);
    if (pay) return payments[pay[1]] ? Response.json({ id: pay[1], ...payments[pay[1]] }) : new Response("{}", { status: 404 });
    throw new Error(`unexpected fetch ${url}`);
  });
  return calls;
}
const hook = (anon: Client, obj: unknown) => anon.req("POST", "/api/billing/webhook", obj, { "x-razorpay-signature": sign(HOOK, JSON.stringify(obj)), "x-requested-with": "" });
afterEach(() => vi.restoreAllMocks());

describe("auto-renewing subscriptions", () => {
  it("starts after the trial, records each charge once from the webhook, and can be turned off", async () => {
    const W = await billedWorld();
    const calls = mockRazorpay();
    const start = await W.owner.post(`/api/billing/org/${W.orgId}/autopay`, { plan: "business", interval: "monthly" });
    expect(start.status, JSON.stringify(start.json)).toBe(200);
    // ₹799 + 18% GST = ₹943 a month; the first charge waits for the 14-day trial to end.
    expect(start.json).toMatchObject({ subscription_id: "sub_2", amount: 94_300, key_id: "rzp_test_x" });
    expect(Date.parse(start.json.starts_at) - Date.now()).toBeGreaterThan(13 * 86_400_000);
    expect(calls[0]).toMatchObject({ path: "/plans", body: { period: "monthly", interval: 1, item: { amount: 94_300, currency: "INR" } } });
    expect(calls[1]).toMatchObject({ path: "/subscriptions", body: { plan_id: "plan_1", total_count: 120, start_at: expect.any(Number) } });
    // The Razorpay plan is created once and reused.
    await W.owner.post(`/api/billing/org/${W.orgId}/autopay`, { plan: "business", interval: "monthly" });
    expect(calls.filter((x) => x.path === "/plans")).toHaveLength(1);

    const sub = "sub_3";
    expect((await W.owner.post(`/api/billing/org/${W.orgId}/autopay/verify`, { razorpay_subscription_id: sub, razorpay_payment_id: "pay_auth", razorpay_signature: "0".repeat(64) })).status).toBe(400);
    const ok = await W.owner.post(`/api/billing/org/${W.orgId}/autopay/verify`, { razorpay_subscription_id: sub, razorpay_payment_id: "pay_auth", razorpay_signature: sign(SECRET, `pay_auth|${sub}`) });
    expect(ok.status).toBe(200);
    // The mandate check is not a charge: still on trial, no invoice yet.
    let b = (await W.owner.get(`/api/billing/org/${W.orgId}`)).json;
    expect(b.subscription.status).toBe("trial");
    expect(b.autopay).toMatchObject({ status: "active", plan: "business", interval: "monthly", total: 94_300 });
    expect(b.payments).toHaveLength(0);

    const anon = new Client(W.env);
    const charged = (id: string, amount = 94_300) => ({ event: "subscription.charged", payload: { subscription: { entity: { id: sub, status: "active" } }, payment: { entity: { id, amount, status: "captured" } } } });
    expect((await hook(anon, charged("pay_c1"))).status).toBe(200);
    expect((await hook(anon, charged("pay_c1"))).status).toBe(200); // Razorpay may send an event twice
    expect((await hook(anon, charged("pay_bad", 100))).status).toBe(200); // wrong amount is ignored
    b = (await W.owner.get(`/api/billing/org/${W.orgId}`)).json;
    expect(b.subscription).toMatchObject({ status: "active", plan: "business", interval: "monthly" });
    expect(b.payments).toHaveLength(1);
    expect(b.payments[0]).toMatchObject({ total: 94_300, invoice_number: expect.stringMatching(/^LF-\d{4}-00001$/) });
    await hook(anon, charged("pay_c2"));
    b = (await W.owner.get(`/api/billing/org/${W.orgId}`)).json;
    expect(b.payments).toHaveLength(2);
    expect(b.subscription.days_left).toBeGreaterThanOrEqual(58);

    // A second auto-renewal cannot be started while one is on.
    expect((await W.owner.post(`/api/billing/org/${W.orgId}/autopay`, { plan: "starter", interval: "yearly" })).status).toBe(409);
    // Failed renewals are reported by Razorpay; the paid days stay.
    await hook(anon, { event: "subscription.halted", payload: { subscription: { entity: { id: sub, status: "halted" } } } });
    expect((await W.owner.get(`/api/billing/org/${W.orgId}`)).json.autopay.status).toBe("halted");
    expect((await W.owner.post(`/api/billing/org/${W.orgId}/autopay/cancel`)).status).toBe(200);
    expect(calls.at(-1)).toMatchObject({ method: "POST", path: `/subscriptions/${sub}/cancel` });
    b = (await W.owner.get(`/api/billing/org/${W.orgId}`)).json;
    expect(b.autopay.status).toBe("cancelled");
    expect(b.subscription.status).toBe("active");
    // Forged events change nothing.
    expect((await anon.req("POST", "/api/billing/webhook", charged("pay_forged"), { "x-razorpay-signature": "00" })).status).toBe(403);
  });

  it("charges at once when there is no trial or paid period left, confirming the payment with Razorpay", async () => {
    const W = await billedWorld();
    await W.owner.get(`/api/billing/org/${W.orgId}`);
    await rawQuery(W, `UPDATE org_subscriptions SET trial_ends_at = ? WHERE org_id = ?`, "2020-01-01T00:00:00Z", W.orgId);
    const calls = mockRazorpay({ pay_now: { amount: 3_53_800, status: "captured" } });
    const start = (await W.owner.post(`/api/billing/org/${W.orgId}/autopay`, { plan: "starter", interval: "yearly" })).json;
    expect(start).toMatchObject({ amount: 3_53_900, starts_at: null }); // ₹2,999 + ₹540 GST
    expect(calls[1].body.start_at).toBeUndefined();
    expect(calls[1].body.total_count).toBe(10);
    // The browser's report of a payment for a different amount does not activate anything...
    await W.owner.post(`/api/billing/org/${W.orgId}/autopay/verify`, { razorpay_subscription_id: start.subscription_id, razorpay_payment_id: "pay_now", razorpay_signature: sign(SECRET, `pay_now|${start.subscription_id}`) });
    expect((await W.owner.get(`/api/billing/org/${W.orgId}`)).json.subscription.status).toBe("free");
  });

  it("activates straight from the checkout page when Razorpay confirms the first charge", async () => {
    const W = await billedWorld();
    await W.owner.get(`/api/billing/org/${W.orgId}`);
    await rawQuery(W, `UPDATE org_subscriptions SET trial_ends_at = ? WHERE org_id = ?`, "2020-01-01T00:00:00Z", W.orgId);
    mockRazorpay({ pay_now: { amount: 3_53_900, status: "captured" } });
    const start = (await W.owner.post(`/api/billing/org/${W.orgId}/autopay`, { plan: "starter", interval: "yearly" })).json;
    const v = await W.owner.post(`/api/billing/org/${W.orgId}/autopay/verify`, { razorpay_subscription_id: start.subscription_id, razorpay_payment_id: "pay_now", razorpay_signature: sign(SECRET, `pay_now|${start.subscription_id}`) });
    expect(v.json.subscription).toMatchObject({ status: "active", plan: "starter", interval: "yearly" });
    expect(v.json.subscription.days_left).toBeGreaterThanOrEqual(365);
  });

  it("only the owner can start or stop auto-renewal, and only for their own organisation", async () => {
    const W = await billedWorld();
    mockRazorpay();
    const u = await W.owner.post(`/api/orgs/${W.orgId}/users`, { name: "Admin", username: "auto.admin", role: "admin" });
    const adm = new Client(W.env);
    await adm.post("/api/auth/login", { login: "auto.admin", password: u.json.temporary_password });
    await adm.post("/api/auth/change-password", { current_password: u.json.temporary_password, new_password: "auto admin pass 1" });
    expect((await adm.post(`/api/billing/org/${W.orgId}/autopay`, { plan: "starter", interval: "monthly" })).status).toBe(403);
    expect((await adm.post(`/api/billing/org/${W.orgId}/autopay/cancel`)).status).toBe(403);
    const { client: otherOwner } = await register(W.env, "Stranger");
    expect([403, 404]).toContain((await otherOwner.post(`/api/billing/org/${W.orgId}/autopay`, { plan: "starter", interval: "monthly" })).status);
  });
});

describe("Free-plan promotions", () => {
  it("are shown only on the Free plan, carry only safe https links, and are managed by vendor staff", async () => {
    const W = await billedWorld();
    expect((await W.owner.get(`/api/billing/org/${W.orgId}/promo`)).json.promo).toBeNull(); // on trial
    await rawQuery(W, `UPDATE org_subscriptions SET trial_ends_at = ? WHERE org_id = ?`, "2020-01-01T00:00:00Z", W.orgId);
    const house = (await W.owner.get(`/api/billing/org/${W.orgId}/promo`)).json.promo;
    expect(house.id).toMatch(/^house-/);

    expect((await W.owner.post("/api/billing/vendor/promotions", { title: "x", body: "y", link_url: "https://a.example" })).status).toBe(404);
    W.env.VENDOR_ADMIN_EMAILS = (await W.owner.get("/api/auth/me")).json.user.email;
    for (const bad of ["javascript:alert(1)", "http://plain.example", "https://user:pw@evil.example", "data:text/html,hi"]) {
      expect((await W.owner.post("/api/billing/vendor/promotions", { title: "T", body: "B", link_url: bad })).status, bad).toBe(400);
    }
    const created = await W.owner.post("/api/billing/vendor/promotions", { title: "Move your old books in a day", body: "Our partner moves your old books for you.", link_url: "https://partner.example/offer", sponsor: "Partner Co", weight: 10 });
    expect(created.status).toBe(201);
    const seen = new Set<string>();
    for (let i = 0; i < 30; i++) seen.add((await W.owner.get(`/api/billing/org/${W.orgId}/promo`)).json.promo.id);
    expect(seen.has(created.json.id)).toBe(true);
    await W.owner.post(`/api/billing/org/${W.orgId}/promo/${created.json.id}/click`);
    const list = (await W.owner.get("/api/billing/vendor/promotions")).json.promotions;
    expect(list[0]).toMatchObject({ sponsor: "Partner Co", clicks: 1 });
    expect(list[0].views).toBeGreaterThan(0);

    // Paying organisations see nothing.
    await W.owner.post(`/api/billing/vendor/orgs/${W.orgId}/activate`, { plan: "starter", interval: "monthly" });
    expect((await W.owner.get(`/api/billing/org/${W.orgId}/promo`)).json.promo).toBeNull();
  });

  it("are never shown while billing is off (desktop and self-hosted)", async () => {
    const W = await world();
    expect((await W.owner.get(`/api/billing/org/${W.orgId}/promo`)).json.promo).toBeNull();
  });
});

describe("payment hardening", () => {
  it("explains Razorpay's refusal instead of a bare status code", async () => {
    const W = await billedWorld();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any) => {
      if (String(url).endsWith("/plans")) return Response.json({ error: { code: "BAD_REQUEST_ERROR", description: "The requested URL was not found on the server." } }, { status: 400 });
      if (String(url).endsWith("/orders")) return Response.json({ error: { description: "Authentication failed" } }, { status: 401 });
      throw new Error(`unexpected fetch ${url}`);
    });
    const auto = await W.owner.post(`/api/billing/org/${W.orgId}/autopay`, { plan: "starter", interval: "monthly" });
    expect(auto.status).toBe(502);
    expect(auto.json.error.message).toContain("The requested URL was not found on the server.");
    expect(auto.json.error.message).toContain("untick “Renew automatically” to pay once");
    const once = await W.owner.post(`/api/billing/org/${W.orgId}/checkout`, { plan: "starter", interval: "monthly" });
    expect(once.json.error.message).toMatch(/did not accept the API keys/);
    expect(JSON.stringify([auto.json, once.json])).not.toContain(SECRET);
  });

  it("limits how many checkouts an organisation can start in an hour", async () => {
    const W = await billedWorld();
    mockRazorpay();
    for (let i = 0; i < 20; i++) expect((await W.owner.post(`/api/billing/org/${W.orgId}/autopay`, { plan: "starter", interval: "monthly" })).status).toBe(200);
    const r = await W.owner.post(`/api/billing/org/${W.orgId}/autopay`, { plan: "starter", interval: "monthly" });
    expect([r.status, r.json.error.code]).toEqual([429, "RATE_LIMITED"]);
  });

  it("tells browsers to use https only", async () => {
    const W = await world();
    expect((await new Client(W.env, "https://ledgerfox.example").get("/api/health")).headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
    expect((await new Client(W.env).get("/api/health")).headers.get("strict-transport-security")).toBeNull();
  });
});

describe("plan features", () => {
  it("lets the background recurring run pass quietly on the Free plan but still explains the limit to a person", async () => {
    const W = await billedWorld();
    await W.owner.get(`/api/billing/org/${W.orgId}`);
    await rawQuery(W, `UPDATE org_subscriptions SET trial_ends_at = ? WHERE org_id = ?`, "2020-01-01T00:00:00Z", W.orgId);
    expect((await W.owner.post(W.c("/recurring/run?auto=1"))).json).toEqual({ created: [], errors: [] });
    expect((await W.owner.post(W.c("/recurring/run"))).status).toBe(402);
  });
});
