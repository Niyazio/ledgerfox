import { describe, expect, it, vi, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { world, rawQuery, Client } from "./helpers";

const SECRET = "test_key_secret", HOOK = "test_webhook_secret";
const sign = (s: string, data: string) => createHmac("sha256", s).update(data).digest("hex");

async function billedWorld() {
  const W = await world();
  Object.assign(W.env, { BILLING_ENABLED: "true", RAZORPAY_KEY_ID: "rzp_test_x", RAZORPAY_KEY_SECRET: SECRET, RAZORPAY_WEBHOOK_SECRET: HOOK, VENDOR_ADMIN_EMAILS: "" });
  return W;
}
function mockRazorpay() {
  let n = 0;
  const orders: any[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any, init: any) => {
    if (String(url) === "https://api.razorpay.com/v1/orders") {
      orders.push({ auth: init.headers.authorization, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ id: `order_${++n}` }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return orders;
}
afterEach(() => vi.restoreAllMocks());

describe("subscriptions", () => {
  it("changes nothing while billing is off", async () => {
    const W = await world();
    const b = (await W.owner.get(`/api/billing/org/${W.orgId}`)).json;
    expect(b).toMatchObject({ enabled: false, subscription: { enforced: false, status: "unlimited" } });
  });

  it("starts with a 30-day trial; afterwards there is no Free plan: view and export only until renewal", async () => {
    const W = await billedWorld();
    const b = (await W.owner.get(`/api/billing/org/${W.orgId}`)).json;
    expect(b.subscription).toMatchObject({ enforced: true, status: "trial", plan: "business", days_left: 30 });
    expect(b.renew_required).toBe(false);
    const item = (await W.owner.post(W.c("/items"), { kind: "goods", name: "Tea", sale_price: "10" })).json.id;
    expect((await W.owner.post(W.c("/pos/sale"), { lines: [{ item_id: item, quantity: "1" }], payments: [{ mode: "cash", amount: "10" }] })).status).toBe(201);
    await rawQuery(W, `UPDATE org_subscriptions SET trial_ends_at = ? WHERE org_id = ?`, "2020-01-01T00:00:00Z", W.orgId);
    const ended = (await W.owner.get(`/api/billing/org/${W.orgId}`)).json;
    expect(ended.subscription).toMatchObject({ status: "free", plan: "free" });
    expect(ended.renew_required).toBe(true);
    const pos = await W.owner.post(W.c("/pos/sale"), { lines: [{ item_id: item, quantity: "1" }], payments: [{ mode: "cash", amount: "10" }] });
    expect([pos.status, pos.json.error.code]).toEqual([402, "RENEW_REQUIRED"]);
    const cust = (await W.owner.post(W.c("/contacts"), { type: "customer", name: "Late" })).json;
    expect(cust.error.code).toBe("RENEW_REQUIRED");
    expect(cust.error.message).toMatch(/Renew/);
    expect((await W.owner.post(`/api/orgs/${W.orgId}/users`, { name: "A", username: "free.user", role: "billing" })).json.error.code).toBe("PLAN_LIMIT");
    // The data itself stays readable and exportable.
    expect((await W.owner.get(W.c("/documents"))).status).toBe(200);
    expect((await W.owner.get(W.c("/export"))).status).not.toBe(402);
    // Paying lifts the hold at once.
    await rawQuery(W, `UPDATE org_subscriptions SET plan = 'business', paid_until = ? WHERE org_id = ?`, new Date(Date.now() + 30 * 86_400_000).toISOString(), W.orgId);
    expect((await W.owner.post(W.c("/pos/sale"), { lines: [{ item_id: item, quantity: "1" }], payments: [{ mode: "cash", amount: "10" }] })).status).toBe(201);
  });

  it("checks out through Razorpay, verifies the signature and activates once even if the webhook races the browser", async () => {
    const W = await billedWorld();
    const orders = mockRazorpay();
    const co = await W.owner.post(`/api/billing/org/${W.orgId}/checkout`, { plan: "business", interval: "monthly" });
    expect(co.status, JSON.stringify(co.json)).toBe(200);
    // ₹799 + 18% GST (₹143.82 → ₹144) = ₹943
    expect(co.json).toMatchObject({ order_id: "order_1", amount: 94_300, key_id: "rzp_test_x", currency: "INR" });
    expect(orders[0].body).toMatchObject({ amount: 94_300, currency: "INR" });
    expect(orders[0].auth).toBe(`Basic ${Buffer.from(`rzp_test_x:${SECRET}`).toString("base64")}`);
    const bad = await W.owner.post(`/api/billing/org/${W.orgId}/verify`, { razorpay_order_id: "order_1", razorpay_payment_id: "pay_1", razorpay_signature: "0".repeat(64) });
    expect(bad.status).toBe(400);
    const hookObj = { event: "payment.captured", payload: { payment: { entity: { id: "pay_1", order_id: "order_1", status: "captured", amount: 94_300 } } } };
    const hookBody = JSON.stringify(hookObj);
    const anon = new Client(W.env);
    const [v, h] = await Promise.all([
      W.owner.post(`/api/billing/org/${W.orgId}/verify`, { razorpay_order_id: "order_1", razorpay_payment_id: "pay_1", razorpay_signature: sign(SECRET, "order_1|pay_1") }),
      anon.req("POST", "/api/billing/webhook", hookObj, { "x-razorpay-signature": sign(HOOK, hookBody), "x-requested-with": "" }),
    ]);
    expect(v.status).toBe(200);
    expect(h.status).toBe(200);
    const sub = (await W.owner.get(`/api/billing/org/${W.orgId}`)).json;
    expect(sub.subscription).toMatchObject({ status: "active", plan: "business", interval: "monthly" });
    expect(sub.subscription.days_left).toBeGreaterThanOrEqual(28);
    expect(sub.subscription.days_left).toBeLessThanOrEqual(31);
    expect(sub.payments).toHaveLength(1);
    expect(sub.payments[0].invoice_number).toMatch(/^LF-\d{4}-00001$/);
    // Renewing the same plan adds a month to the end of the paid period.
    await W.owner.post(`/api/billing/org/${W.orgId}/checkout`, { plan: "business", interval: "monthly" });
    await W.owner.post(`/api/billing/org/${W.orgId}/verify`, { razorpay_order_id: "order_2", razorpay_payment_id: "pay_2", razorpay_signature: sign(SECRET, "order_2|pay_2") });
    const renewed = (await W.owner.get(`/api/billing/org/${W.orgId}`)).json;
    expect(renewed.subscription.days_left).toBeGreaterThanOrEqual(58);
    expect(renewed.payments.map((p: any) => p.invoice_number).sort()).toEqual([expect.stringMatching(/00001$/), expect.stringMatching(/00002$/)]);
    // Forged webhook is refused.
    expect((await anon.req("POST", "/api/billing/webhook", hookObj, { "x-razorpay-signature": "deadbeef" })).status).toBe(403);
  });

  it("only the owner buys; only vendor staff see the subscriber admin", async () => {
    const W = await billedWorld();
    mockRazorpay();
    const u = await W.owner.post(`/api/orgs/${W.orgId}/users`, { name: "Admin", username: "bill.admin", role: "admin" });
    const adm = new Client(W.env);
    await adm.post("/api/auth/login", { login: "bill.admin", password: u.json.temporary_password });
    await adm.post("/api/auth/change-password", { current_password: u.json.temporary_password, new_password: "bill admin pass 1" });
    expect((await adm.post(`/api/billing/org/${W.orgId}/checkout`, { plan: "starter", interval: "yearly" })).status).toBe(403);
    expect((await W.owner.get("/api/billing/vendor/subscribers")).status).toBe(404);
    const me = (await W.owner.get("/api/auth/me")).json.user.email;
    W.env.VENDOR_ADMIN_EMAILS = `someone@else.example, ${me.toUpperCase()}`;
    const list = (await W.owner.get("/api/billing/vendor/subscribers")).json;
    expect(list.subscribers.find((s: any) => s.org_id === W.orgId)).toMatchObject({ users: 2, subscription: { status: "trial" } });
    const act = await W.owner.post(`/api/billing/vendor/orgs/${W.orgId}/activate`, { plan: "multi_branch", interval: "yearly", note: "Bank transfer UTR 123" });
    expect(act.status).toBe(200);
    const sub = (await W.owner.get(`/api/billing/org/${W.orgId}`)).json.subscription;
    expect(sub).toMatchObject({ status: "active", plan: "multi_branch", interval: "yearly" });
    expect(sub.days_left).toBeGreaterThanOrEqual(365);
  });
});
