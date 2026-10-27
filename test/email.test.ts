import { describe, expect, it, vi, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { world, rawQuery, register, Client } from "./helpers";
import { dailyBillingReminders } from "../src/worker/services/notices";

const SECRET = "test_key_secret", HOOK = "test_webhook_secret";
const sign = (s: string, data: string) => createHmac("sha256", s).update(data).digest("hex");
const MAIL = { RESEND_API_KEY: "re_test", EMAIL_FROM: "LedgerFox <billing@ledgerfox.example>", APP_URL: "https://ledgerfox.example" };

/** Captures mail sent through Resend (and answers Razorpay's API for the billing tests). */
function mockOut(opts: { mailStatus?: number } = {}) {
  const mails: { to: string; subject: string; text: string }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any, init: any) => {
    const u = String(url);
    if (u === "https://api.resend.com/emails") {
      const b = JSON.parse(init.body);
      expect(init.headers.authorization).toBe("Bearer re_test");
      mails.push({ to: b.to[0], subject: b.subject, text: b.text });
      return new Response("{}", { status: opts.mailStatus ?? 200 });
    }
    if (u === "https://api.razorpay.com/v1/orders") return Response.json({ id: `order_${mails.length}_${Math.random().toString(36).slice(2, 8)}` });
    if (u.startsWith("https://api.razorpay.com/v1/plans")) return init?.method === "POST" ? Response.json({ id: "plan_1" }) : new Response("{}", { status: 401 });
    if (u === "https://api.razorpay.com/v1/subscriptions") return Response.json({ id: "sub_1", status: "created" });
    throw new Error(`unexpected fetch ${u}`);
  });
  return mails;
}
const linkIn = (text: string, path: string) => new URL(new RegExp(`https://ledgerfox\\.example${path}\\?token=[\\w-]+`).exec(text)![0]);
afterEach(() => vi.restoreAllMocks());

describe("email: verification and password reset", () => {
  it("confirms the address with a mailed link and resets a forgotten password without revealing who has an account", async () => {
    const W = await world();
    Object.assign(W.env, MAIL);
    const mails = mockOut();
    const { client, email } = await register(W.env, "Meera");
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: email, subject: "Confirm your email for LedgerFox" });
    let me = (await client.get("/api/auth/me")).json;
    expect(me).toMatchObject({ email_enabled: true, user: { email_verified: false, email_deliverable: true } });
    const verify = linkIn(mails[0].text, "/verify-email");
    expect((await new Client(W.env).post("/api/auth/verify-email", { token: verify.searchParams.get("token") })).status).toBe(200);
    expect((await new Client(W.env).post("/api/auth/verify-email", { token: verify.searchParams.get("token") })).status).toBe(400); // used once
    me = (await client.get("/api/auth/me")).json;
    expect(me.user.email_verified).toBe(true);

    // Forgot password: the same answer for a real and an unknown address; only the real one gets mail.
    const anon = new Client(W.env);
    expect((await anon.post("/api/auth/forgot", { email: "nobody@example.com" })).json).toEqual({ ok: true });
    expect((await anon.post("/api/auth/forgot", { email: email.toUpperCase() })).json).toEqual({ ok: true });
    expect(mails).toHaveLength(2);
    expect(mails[1]).toMatchObject({ to: email, subject: "Reset your LedgerFox password" });
    const reset = linkIn(mails[1].text, "/reset");
    expect((await anon.post("/api/auth/reset", { token: reset.searchParams.get("token"), new_password: "a brand new password" })).status).toBe(200);
    expect((await anon.post("/api/auth/reset", { token: reset.searchParams.get("token"), new_password: "another new password" })).status).toBe(400);
    // Old sessions are signed out; the new password works.
    expect((await client.get("/api/auth/me")).json.user).toBeNull();
    expect((await anon.post("/api/auth/login", { login: email, password: "a brand new password" })).status).toBe(200);
    // At most 3 reset mails per address per hour.
    for (let i = 0; i < 4; i++) await new Client(W.env).post("/api/auth/forgot", { email });
    expect(mails.filter((m) => m.subject.startsWith("Reset"))).toHaveLength(3);
  });

  it("keeps recovery codes as the only reset when email is not set up, and never mails made-up staff addresses", async () => {
    const W = await world();
    const mails = mockOut();
    expect((await new Client(W.env).post("/api/auth/forgot", { email: "x@example.com" })).status).toBe(503);
    expect((await W.owner.get("/api/auth/me")).json.email_enabled).toBe(false);
    Object.assign(W.env, MAIL);
    const u = await W.owner.post(`/api/orgs/${W.orgId}/users`, { name: "Counter", username: "counter.one", role: "billing" });
    expect(u.status).toBe(201);
    const staffEmail = (await rawQuery(W, `SELECT email FROM users WHERE username = 'counter.one'`))[0].email;
    await new Client(W.env).post("/api/auth/forgot", { email: staffEmail });
    expect(mails).toHaveLength(0);
  });
});

describe("billing emails", () => {
  async function billed() {
    const W = await world();
    Object.assign(W.env, MAIL, { BILLING_ENABLED: "true", RAZORPAY_KEY_ID: "rzp_test_x", RAZORPAY_KEY_SECRET: SECRET, RAZORPAY_WEBHOOK_SECRET: HOOK, VENDOR_ADMIN_EMAILS: "" });
    return W;
  }

  it("mails one receipt per payment with the invoice, payment and account ids", async () => {
    const W = await billed();
    const mails = mockOut();
    const co = (await W.owner.post(`/api/billing/org/${W.orgId}/checkout`, { plan: "starter", interval: "monthly" })).json;
    const body = { razorpay_order_id: co.order_id, razorpay_payment_id: "pay_R1", razorpay_signature: sign(SECRET, `${co.order_id}|pay_R1`) };
    await W.owner.post(`/api/billing/org/${W.orgId}/verify`, body);
    await W.owner.post(`/api/billing/org/${W.orgId}/verify`, body);
    const receipts = mails.filter((m) => m.subject.startsWith("Payment received"));
    expect(receipts).toHaveLength(1);
    expect(receipts[0].text).toContain("Payment ID: pay_R1");
    expect(receipts[0].text).toContain(`Account ID: ${W.orgId}`);
    expect(receipts[0].text).toMatch(/Invoice number: LF-\d{4}-00001/);
    expect(receipts[0].text).toContain(`https://ledgerfox.example/billing/${W.orgId}/invoice/`);
    const b = (await W.owner.get(`/api/billing/org/${W.orgId}`)).json;
    expect(b.account_id).toBe(W.orgId);
    expect(b.payments[0]).toMatchObject({ provider_payment_id: "pay_R1", provider_order_id: co.order_id });
  });

  it("warns once when an auto-renew charge fails", async () => {
    const W = await billed();
    const mails = mockOut();
    await W.owner.post(`/api/billing/org/${W.orgId}/autopay`, { plan: "business", interval: "monthly" });
    const anon = new Client(W.env);
    const evt = { event: "subscription.pending", payload: { subscription: { entity: { id: "sub_1", status: "pending" } } } };
    for (let i = 0; i < 2; i++) await anon.req("POST", "/api/billing/webhook", evt, { "x-razorpay-signature": sign(HOOK, JSON.stringify(evt)), "x-requested-with": "" });
    const warn = mails.filter((m) => m.subject.includes("did not go through"));
    expect(warn).toHaveLength(1);
    expect(warn[0].text).toContain("Subscription ID: sub_1");
  });

  it("sends trial, renewal and grace reminders once each, and retries a reminder whose mail failed", async () => {
    const W = await billed();
    await W.owner.get(`/api/billing/org/${W.orgId}`);
    const DAY = 86_400_000, now = Date.now();
    mockOut({ mailStatus: 500 });
    await rawQuery(W, `UPDATE org_subscriptions SET trial_ends_at = ? WHERE org_id = ?`, new Date(now + 2 * DAY).toISOString(), W.orgId);
    expect(await dailyBillingReminders(W.env, now)).toBe(0); // provider down: nothing recorded
    vi.restoreAllMocks();
    const mails = mockOut();
    expect(await dailyBillingReminders(W.env, now)).toBe(1);
    expect(await dailyBillingReminders(W.env, now)).toBe(0);
    expect(mails[0].subject).toBe("Your LedgerFox free trial ends soon");
    await rawQuery(W, `UPDATE org_subscriptions SET plan = 'starter', paid_until = ?, trial_ends_at = NULL WHERE org_id = ?`, new Date(now + 4 * DAY).toISOString(), W.orgId);
    expect(await dailyBillingReminders(W.env, now)).toBe(1);
    expect(mails[1].subject).toMatch(/^Your LedgerFox Starter plan ends on/);
    await rawQuery(W, `UPDATE org_subscriptions SET paid_until = ? WHERE org_id = ?`, new Date(now - DAY).toISOString(), W.orgId);
    expect(await dailyBillingReminders(W.env, now)).toBe(1);
    expect(mails[2].subject).toBe("Your LedgerFox plan has ended — 7 days to renew");
    // Auto-renew on: no "please renew" reminders.
    await rawQuery(W, `UPDATE org_subscriptions SET paid_until = ?, autopay_status = 'active' WHERE org_id = ?`, new Date(now + 3 * DAY).toISOString(), W.orgId);
    expect(await dailyBillingReminders(W.env, now)).toBe(0);
  });

  it("shows vendor staff what the server can see of the set-up, never the secrets", async () => {
    const W = await billed();
    mockOut();
    W.env.VENDOR_ADMIN_EMAILS = (await W.owner.get("/api/auth/me")).json.user.email;
    const r = (await W.owner.get("/api/billing/vendor/setup")).json;
    expect(r).toMatchObject({ billing_enabled: true, razorpay: { key_id: true, mode: "test", key_secret: true, webhook_secret: true, api: "rejected" }, email: { enabled: true } });
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(JSON.stringify(r)).not.toContain(HOOK);
    expect(JSON.stringify(r)).not.toContain("re_test");
    const { client: stranger } = await register(W.env, "Stranger");
    expect((await stranger.get("/api/billing/vendor/setup")).status).toBe(404);
    expect((await new Client(W.env).get("/api/billing/plans")).json.online).toBe(true);
  });
});
