import { describe, expect, it } from "vitest";
import { world, rawQuery, register, Client } from "./helpers";

/** A billed world, plus a vendor (admin panel) account. */
async function adminWorld() {
  const W = await world();
  const vendor = await register(W.env, "Vendor");
  Object.assign(W.env, { BILLING_ENABLED: "true", VENDOR_ADMIN_EMAILS: vendor.email });
  const me = (await W.owner.get("/api/auth/me")).json.user;
  return { W, admin: vendor.client, ownerId: me.id as string, ownerLogin: me.email as string };
}

describe("admin panel controls", () => {
  it("resets a forgotten password (never shows the old one) and blocks / unblocks sign-in", async () => {
    const { W, admin, ownerId, ownerLogin } = await adminWorld();
    // Customers cannot use these.
    expect((await W.owner.post(`/api/billing/vendor/users/${ownerId}/temporary-password`)).status).toBe(404);
    const users = (await admin.get("/api/billing/vendor/users")).json.users;
    expect(JSON.stringify(users)).not.toMatch(/password_hash|password_salt|correct horse/);

    const r = await admin.post(`/api/billing/vendor/users/${ownerId}/temporary-password`);
    expect(r.status).toBe(200);
    expect(r.json.sign_in_id).toBe(ownerLogin);
    expect(r.json.temporary_password.length).toBeGreaterThanOrEqual(10);
    // The old session ends and the old password stops working; the new one-time password asks for a new password.
    expect((await W.owner.get("/api/auth/me")).json.user).toBeNull();
    const c = new Client(W.env);
    expect((await c.post("/api/auth/login", { login: ownerLogin, password: "correct horse battery" })).status).toBe(401);
    const ok = await c.post("/api/auth/login", { login: ownerLogin, password: r.json.temporary_password });
    expect(ok.json.must_change_password).toBe(true);

    expect((await admin.post(`/api/billing/vendor/users/${ownerId}/access`, { disabled: true })).status).toBe(200);
    expect((await c.get("/api/auth/me")).json.user).toBeNull();
    expect((await new Client(W.env).post("/api/auth/login", { login: ownerLogin, password: r.json.temporary_password })).status).not.toBe(200);
    await admin.post(`/api/billing/vendor/users/${ownerId}/access`, { disabled: false });
    expect((await new Client(W.env).post("/api/auth/login", { login: ownerLogin, password: r.json.temporary_password })).status).toBe(200);

    const kinds = (await admin.get("/api/billing/vendor/events")).json.events.map((e: any) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["password_reset_by_vendor", "user_blocked", "user_unblocked"]));
  });

  it("gives free access, ends a plan, and pauses / resumes an organisation (export always works)", async () => {
    const { W, admin } = await adminWorld();
    await W.owner.get(`/api/billing/org/${W.orgId}`); // trial starts
    const free = await admin.post(`/api/billing/vendor/orgs/${W.orgId}/free-access`, { plan: "multi_branch", months: 3, note: "cash received" });
    expect(free.status).toBe(200);
    expect(free.json.subscription).toMatchObject({ status: "active", plan: "multi_branch" });
    expect(free.json.subscription.days_left).toBeGreaterThan(85);

    await admin.post(`/api/billing/vendor/orgs/${W.orgId}/end-plan`, {});
    expect((await W.owner.get(`/api/billing/org/${W.orgId}`)).json).toMatchObject({ renew_required: true, subscription: { status: "free" } });
    expect((await W.owner.post(W.c("/items"), { kind: "goods", name: "Tea", sale_price: "10" })).json.error.code).toBe("RENEW_REQUIRED");
    await admin.post(`/api/billing/vendor/orgs/${W.orgId}/free-access`, { plan: "business", months: 1 });

    expect((await admin.post(`/api/billing/vendor/orgs/${W.orgId}/suspend`, { reason: "Cheque bounced" })).status).toBe(200);
    const blocked = await W.owner.get(W.c("/items"));
    expect([blocked.status, blocked.json.error.code]).toEqual([403, "ACCOUNT_SUSPENDED"]);
    expect((await W.owner.get(W.c("/export"))).status).toBe(200);
    const orgs = (await admin.get("/api/billing/vendor/orgs")).json.organisations;
    expect(orgs.find((o: any) => o.id === W.orgId)).toMatchObject({ suspended_reason: "Cheque bounced" });
    await admin.post(`/api/billing/vendor/orgs/${W.orgId}/unsuspend`);
    expect((await W.owner.post(W.c("/items"), { kind: "goods", name: "Tea", sale_price: "10" })).status).toBe(201);

    const detail = (await admin.get(`/api/billing/vendor/orgs/${W.orgId}/detail`)).json;
    expect(detail.events.map((e: any) => e.kind)).toEqual(expect.arrayContaining(["trial_started", "free_access", "plan_ended_by_vendor", "suspended", "unsuspended"]));
    // The vendor's own organisation cannot be paused by mistake.
    const own = (await admin.post("/api/orgs", { name: "Vendor Org", company: { name: "Vendor Co", country: "IN", base_currency: "INR", state_code: "29", fiscal_year_start_month: 4 } })).json.org_id;
    expect((await admin.post(`/api/billing/vendor/orgs/${own}/suspend`, { reason: "x" })).status).toBe(400);
  });

  it("records auto-pay set-up and cancellation in the billing history", async () => {
    const { W, admin } = await adminWorld();
    await rawQuery(W, `INSERT INTO org_subscriptions (org_id, autopay_id, autopay_status) VALUES (?, 'sub_x', 'active') ON CONFLICT (org_id) DO UPDATE SET autopay_id = 'sub_x', autopay_status = 'active'`, W.orgId);
    Object.assign(W.env, { RAZORPAY_KEY_ID: "rzp_test_x", RAZORPAY_KEY_SECRET: "s" });
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ id: "sub_x", status: "cancelled" })) as typeof fetch;
    try { expect((await W.owner.post(`/api/billing/org/${W.orgId}/autopay/cancel`)).status).toBe(200); } finally { globalThis.fetch = orig; }
    const ev = (await admin.get(`/api/billing/vendor/events?org_id=${W.orgId}&kind=autopay_cancel`)).json.events;
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: "autopay_cancelled_by_owner", org_id: W.orgId });
    expect((await admin.get("/api/billing/vendor/orgs")).json.organisations.find((o: any) => o.id === W.orgId).autopay_cancellations).toBe(1);
  });
});

describe("demo companies, terms and old desktop files", () => {
  it("allows a demo company only with a paid plan, one at a time", async () => {
    const { W, admin } = await adminWorld();
    const demo = { name: "Demo Shop", country: "IN", base_currency: "INR", state_code: "29", fiscal_year_start_month: 4, is_demo: true };
    const onTrial = await W.owner.post(`/api/orgs/${W.orgId}/companies`, demo);
    expect([onTrial.status, onTrial.json.error.code]).toEqual([402, "DEMO_NEEDS_PLAN"]);
    expect(onTrial.json.error.message).toMatch(/practice company/);
    // Practice companies stay free on the trial.
    expect((await W.owner.post(`/api/orgs/${W.orgId}/companies`, { ...demo, is_demo: false, is_practice: true, name: "Class" })).status).toBe(201);
    await admin.post(`/api/billing/vendor/orgs/${W.orgId}/free-access`, { plan: "business", months: 1 });
    expect((await W.owner.post(`/api/orgs/${W.orgId}/companies`, demo)).status).toBe(201);
    expect((await W.owner.post(`/api/orgs/${W.orgId}/companies`, demo)).json.error.code).toBe("DEMO_EXISTS");
    // Someone without a business of their own cannot start with a demo either.
    const { client: fresh } = await register(W.env, "Fresh");
    expect((await fresh.post("/api/orgs", { name: "X", company: demo })).json.error.code).toBe("DEMO_NEEDS_PLAN");
  });

  it("needs the terms accepted to create an account, and records when", async () => {
    const W = await world();
    const c = new Client(W.env);
    const no = await c.post("/api/auth/register", { name: "N", email: "noterms@example.com", password: "correct horse battery" });
    expect(no.status).toBe(400);
    expect((await c.post("/api/auth/register", { name: "Y", email: "terms@example.com", password: "correct horse battery", accept_terms: true })).status).toBe(201);
    const row = (await rawQuery(W, `SELECT terms_accepted_at FROM users WHERE email = 'terms@example.com'`))[0];
    expect(Date.parse(row.terms_accepted_at)).toBeGreaterThan(Date.now() - 60_000);
  });

  it("opens an old desktop data file view-only", async () => {
    const W = await world();
    Object.assign(W.env, { DESKTOP_READONLY: "true" });
    expect((await W.owner.get(W.c("/items"))).status).toBe(200);
    const r = await W.owner.post(W.c("/items"), { kind: "goods", name: "Tea", sale_price: "10" });
    expect([r.status, r.json.error.code]).toEqual([403, "READ_ONLY_FILE"]);
  });
});
