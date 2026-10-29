import { describe, expect, it, vi, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { world, rawQuery, register, Client } from "./helpers";

const SECRET = "test_key_secret", HOOK = "test_webhook_secret";
const sign = (s: string, data: string) => createHmac("sha256", s).update(data).digest("hex");

async function requiredWorld() {
  const W = await world();
  Object.assign(W.env, { BILLING_ENABLED: "true", BILLING_REQUIRE_AUTOPAY: "true", RAZORPAY_KEY_ID: "rzp_test_x", RAZORPAY_KEY_SECRET: SECRET, RAZORPAY_WEBHOOK_SECRET: HOOK, VENDOR_ADMIN_EMAILS: "vendor@ledgerfox.example", VENDOR_UDYAM: "UDYAM-KR-11-0094729" });
  return W;
}
function mockRazorpay() {
  let n = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any) => {
    const u = String(url);
    if (u.endsWith("/plans")) return Response.json({ id: "plan_1" });
    if (u.endsWith("/subscriptions")) return Response.json({ id: `sub_${++n}`, status: "created" });
    if (u.includes("/payments/")) return Response.json({ id: "pay_auth", amount: 500, status: "captured" });
    if (u.endsWith("/orders")) return Response.json({ id: `order_${++n}` });
    throw new Error(`unexpected fetch ${u}`);
  });
}
afterEach(() => vi.restoreAllMocks());

describe("30-day free trial that starts with auto-pay", () => {
  it("holds new entries until the owner sets up auto-pay; the ₹5 check is not a charge and the trial keeps running", async () => {
    const W = await requiredWorld();
    mockRazorpay();
    const b = (await W.owner.get(`/api/billing/org/${W.orgId}`)).json;
    expect(b).toMatchObject({ autopay_required: true, trial_days: 30, subscription: { status: "trial", days_left: 30 } });
    // Company set-up right after sign-up (details, logo) is allowed before the trial screen.
    expect((await W.owner.patch(W.c("/settings"), { name: "Acme Traders", state_code: "29", upi_id: "acme@okhdfcbank" })).status).toBe(200);
    const png = "data:image/png;base64," + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString("base64");
    expect((await W.owner.put(W.c("/settings/branding"), { logo: png, payment_qr: null })).status).not.toBe(402);
    // Viewing works; creating does not.
    expect((await W.owner.get(W.c("/items"))).status).toBe(200);
    const blocked = await W.owner.post(W.c("/items"), { kind: "goods", name: "Tea", sale_price: "10" });
    expect([blocked.status, blocked.json.error.code]).toEqual([402, "AUTOPAY_REQUIRED"]);
    expect(blocked.json.error.message).toContain("₹5");

    const start = (await W.owner.post(`/api/billing/org/${W.orgId}/autopay`, { plan: "business", interval: "monthly" })).json;
    expect(Date.parse(start.starts_at) - Date.now()).toBeGreaterThan(29 * 86_400_000); // first charge when the trial ends
    await W.owner.post(`/api/billing/org/${W.orgId}/autopay/verify`, { razorpay_subscription_id: start.subscription_id, razorpay_payment_id: "pay_auth", razorpay_signature: sign(SECRET, `pay_auth|${start.subscription_id}`) });
    const after = (await W.owner.get(`/api/billing/org/${W.orgId}`)).json;
    expect(after).toMatchObject({ autopay_required: false, subscription: { status: "trial" }, payments: [] });
    expect((await W.owner.post(W.c("/items"), { kind: "goods", name: "Tea", sale_price: "10" })).status).toBe(201);
  });

  it("also unlocks when Razorpay reports the mandate approved (browser closed early)", async () => {
    const W = await requiredWorld();
    mockRazorpay();
    const start = (await W.owner.post(`/api/billing/org/${W.orgId}/autopay`, { plan: "starter", interval: "monthly" })).json;
    const evt = { event: "subscription.authenticated", payload: { subscription: { entity: { id: start.subscription_id, status: "authenticated" } } } };
    await new Client(W.env).req("POST", "/api/billing/webhook", evt, { "x-razorpay-signature": sign(HOOK, JSON.stringify(evt)), "x-requested-with": "" });
    expect((await W.owner.get(`/api/billing/org/${W.orgId}`)).json.autopay_required).toBe(false);
  });

  it("never holds back the vendor's own staff, paying organisations, or anyone when the rule is off", async () => {
    const W = await requiredWorld();
    W.env.VENDOR_ADMIN_EMAILS = (await W.owner.get("/api/auth/me")).json.user.email;
    expect((await W.owner.post(W.c("/items"), { kind: "goods", name: "A", sale_price: "1" })).status).toBe(201);
    // Staff of the vendor's own organisation are not held back either.
    const u = await W.owner.post(`/api/orgs/${W.orgId}/users`, { name: "Staff", username: "vendor.staff", role: "admin" });
    const staff = new Client(W.env);
    await staff.post("/api/auth/login", { login: "vendor.staff", password: u.json.temporary_password });
    await staff.post("/api/auth/change-password", { current_password: u.json.temporary_password, new_password: "vendor staff pass 1" });
    expect((await staff.post(W.c("/items"), { kind: "goods", name: "S", sale_price: "1" })).status).toBe(201);
    expect((await staff.get(`/api/billing/org/${W.orgId}`)).json.autopay_required).toBe(false);
    W.env.VENDOR_ADMIN_EMAILS = "";
    expect((await staff.post(W.c("/items"), { kind: "goods", name: "S2", sale_price: "1" })).json.error.code).toBe("AUTOPAY_REQUIRED");
    W.env.BILLING_REQUIRE_AUTOPAY = "false";
    expect((await W.owner.post(W.c("/items"), { kind: "goods", name: "B", sale_price: "1" })).status).toBe(201);
    W.env.BILLING_REQUIRE_AUTOPAY = "true";
    await W.owner.get(`/api/billing/org/${W.orgId}`);
    await rawQuery(W, `UPDATE org_subscriptions SET plan = 'starter', paid_until = ? WHERE org_id = ?`, new Date(Date.now() + 10 * 86_400_000).toISOString(), W.orgId);
    expect((await W.owner.post(W.c("/items"), { kind: "goods", name: "C", sale_price: "1" })).status).toBe(201);
  });
});

describe("demo companies and subscriptions", () => {
  it("puts a demo company in the person's own organisation and never asks a demo-only organisation to subscribe", async () => {
    const W = await requiredWorld();
    mockRazorpay();
    const demo = { name: "FreshMart (demo)", country: "IN", base_currency: "INR", fiscal_year_start_month: 4, state_code: "29", is_demo: true };
    const r = await W.owner.post("/api/orgs", { name: "Demo organisation", company: demo });
    expect(r.json.org_id).toBe(W.orgId); // not a second organisation
    expect((await rawQuery(W, `SELECT COUNT(*) AS n FROM organisations`))[0].n).toBe(1);

    // Someone whose only organisation holds demo companies: no trial screen, no checkout.
    const { client: fresh } = await register(W.env, "Fresh");
    const d = (await fresh.post("/api/orgs", { name: "Demo organisation", company: demo })).json;
    const b = (await fresh.get(`/api/billing/org/${d.org_id}`)).json;
    expect(b).toMatchObject({ demo_only: true, autopay_required: false });
    expect((await fresh.post(`/api/c/${d.company_id}/items`, { kind: "goods", name: "Soap", sale_price: "10" })).status).toBe(201);
    const buy = await fresh.post(`/api/billing/org/${d.org_id}/autopay`, { plan: "starter", interval: "monthly" });
    expect([buy.status, buy.json.error.code]).toEqual([409, "DEMO_ONLY"]);
    expect((await fresh.post(`/api/billing/org/${d.org_id}/checkout`, { plan: "starter", interval: "monthly" })).json.error.code).toBe("DEMO_ONLY");
  });
});

describe("one free trial", () => {
  it("is given once per owner: a second organisation starts on the Free plan, and stopping auto-pay never restarts it", async () => {
    const W = await requiredWorld();
    mockRazorpay();
    const first = (await W.owner.get(`/api/billing/org/${W.orgId}`)).json.subscription;
    expect(first.status).toBe("trial");
    // Stop and restart auto-pay: the trial end date does not move.
    const start = (await W.owner.post(`/api/billing/org/${W.orgId}/autopay`, { plan: "starter", interval: "monthly" })).json;
    await W.owner.post(`/api/billing/org/${W.orgId}/autopay/verify`, { razorpay_subscription_id: start.subscription_id, razorpay_payment_id: "pay_auth", razorpay_signature: sign(SECRET, `pay_auth|${start.subscription_id}`) });
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ id: start.subscription_id, status: "cancelled" }));
    expect((await W.owner.post(`/api/billing/org/${W.orgId}/autopay/cancel`)).status).toBe(200);
    expect((await W.owner.get(`/api/billing/org/${W.orgId}`)).json.subscription.trial_ends_at).toBe(first.trial_ends_at);

    // A new organisation for the same owner: no second trial.
    const second = (await W.owner.post("/api/orgs", { name: "Second Org", company: { name: "Second Shop", country: "IN", base_currency: "INR", fiscal_year_start_month: 4, state_code: "29" } })).json;
    const s2 = (await W.owner.get(`/api/billing/org/${second.org_id}`)).json;
    expect(s2.subscription.status).toBe("free");
    expect(s2.autopay_required).toBe(false);

    // A different person still gets their own first trial.
    const { client } = await register(W.env, "Other owner");
    const o = (await client.post("/api/orgs", { name: "Other", company: { name: "Other Shop", country: "IN", base_currency: "INR", fiscal_year_start_month: 4, state_code: "29" } })).json;
    expect((await client.get(`/api/billing/org/${o.org_id}`)).json.subscription.status).toBe("trial");
  });

  it("is not used up by a demo company loaded first", async () => {
    const W = await requiredWorld();
    const { client } = await register(W.env, "Demo first");
    const demo = { name: "FreshMart (demo)", country: "IN", base_currency: "INR", fiscal_year_start_month: 4, state_code: "29", is_demo: true };
    const d = (await client.post("/api/orgs", { name: "Demo organisation", company: demo })).json;
    await client.get(`/api/billing/org/${d.org_id}`);
    const real = (await client.post(`/api/orgs/${d.org_id}/companies`, { name: "Real Shop", country: "IN", base_currency: "INR", fiscal_year_start_month: 4, state_code: "29" })).json;
    expect(real.company_id).toBeTruthy();
    expect((await client.get(`/api/billing/org/${d.org_id}`)).json.subscription.status).toBe("trial");
  });
});

describe("admin panel", () => {
  it("tracks organisations, accounts, sign-ins, companies and payments for vendor staff only", async () => {
    const W = await requiredWorld();
    mockRazorpay();
    const me = (await W.owner.get("/api/auth/me")).json.user;
    const { client: other } = await register(W.env, "Second Shop");
    expect((await W.owner.get("/api/billing/vendor/overview")).status).toBe(404);
    W.env.VENDOR_ADMIN_EMAILS = me.email;

    const o = (await W.owner.get("/api/billing/vendor/overview")).json;
    expect(o.totals).toMatchObject({ organisations: 1, users: 2, companies: 1, signups_7d: 2, active_7d: 2 });
    expect(o.statuses.trial).toBe(1);

    const orgs = (await W.owner.get("/api/billing/vendor/orgs")).json.organisations;
    expect(orgs[0]).toMatchObject({ id: W.orgId, owner_email: me.email, users: 1, companies: 1, subscription: { status: "trial" } });
    expect(orgs[0].last_login_at).toBeTruthy();

    const detail = (await W.owner.get(`/api/billing/vendor/orgs/${W.orgId}/detail`)).json;
    expect(detail.members[0]).toMatchObject({ email: me.email, role: "owner", login_count: 1 });
    expect(detail.companies[0]).toMatchObject({ name: "Acme Traders", documents: 0 });
    expect(detail.companies[0]).not.toHaveProperty("password_hash");
    expect(JSON.stringify(detail)).not.toMatch(/password_hash|totp_secret|token/);

    const users = (await W.owner.get("/api/billing/vendor/users")).json.users;
    expect(users).toHaveLength(2);
    expect(JSON.stringify(users)).not.toMatch(/password|totp_secret/);

    // A bank transfer recorded from the panel shows in payments, and its invoice carries the Udyam number.
    await W.owner.post(`/api/billing/vendor/orgs/${W.orgId}/activate`, { plan: "starter", interval: "monthly", note: "UTR 1" });
    const pays = (await W.owner.get("/api/billing/vendor/payments")).json.payments;
    expect(pays[0]).toMatchObject({ org_id: W.orgId, status: "paid", provider: "manual" });
    const inv = (await W.owner.get(`/api/billing/org/${W.orgId}/invoice/${pays[0].id}`)).json;
    expect(inv.seller.udyam).toBe("UDYAM-KR-11-0094729");
    // Other customers cannot use any of it.
    expect((await other.get("/api/billing/vendor/orgs")).status).toBe(404);
    expect((await other.get(`/api/billing/vendor/orgs/${W.orgId}/detail`)).status).toBe(404);
    expect([403, 404]).toContain((await other.get(`/api/billing/org/${W.orgId}/invoice/${pays[0].id}`)).status);
  });
});
