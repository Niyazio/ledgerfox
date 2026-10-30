import { describe, expect, it, vi, afterEach } from "vitest";
import app from "../src/worker/index";
import { world, makeEnv, register, rawQuery, Client } from "./helpers";
import { desktopLicenceState, OFFLINE_DAYS } from "../src/worker/services/licence";

const CLOUD = "https://cloud.ledgerfox.test";
const DAY = 86_400_000;

/** A website (billing on) and a desktop app whose licence requests go to that website. */
async function setup() {
  const W = await world();
  Object.assign(W.env, { BILLING_ENABLED: "true", BILLING_REQUIRE_AUTOPAY: "false" });
  const me = (await W.owner.get("/api/auth/me")).json.user;
  const { env: desk } = await makeEnv();
  Object.assign(desk, { APP_ENV: "desktop", LICENCE_SERVER: CLOUD, ALLOW_REGISTRATION: "true" });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any, init: any) => {
    const u = String(url);
    if (!u.startsWith(CLOUD)) throw new Error(`unexpected fetch ${u}`);
    return app.request(u.replace(CLOUD, "https://ledgerfox.example"), { ...init, headers: { ...init?.headers, "cf-connecting-ip": "10.9.9.9" } }, W.env);
  });
  const { client: deskOwner } = await register(desk, "Shop owner");
  const org = (await deskOwner.post("/api/orgs", { name: "Shop", company: { name: "Shop", country: "IN", base_currency: "INR", fiscal_year_start_month: 4, state_code: "29" } })).json;
  const c = (p: string) => `/api/c/${org.company_id}${p}`;
  return { W, me, desk, deskOwner, deskOrg: org.org_id, c };
}
const posSale = async (cl: Client, c: (p: string) => string) => {
  const item = (await cl.post(c("/items"), { kind: "goods", name: `Tea ${Math.random()}`, sale_price: "10" })).json.id;
  return cl.post(c("/pos/sale"), { lines: [{ item_id: item, quantity: "1" }], payments: [{ mode: "cash", amount: "10" }] });
};
afterEach(() => vi.restoreAllMocks());

describe("desktop app licence", () => {
  it("runs on the Free plan until connected, then uses the account's plan; never shares secrets", async () => {
    const { W, me, desk, deskOwner, deskOrg, c } = await setup();
    // Not connected: Free plan limits (POS is a paid feature; a second user is over the limit).
    expect((await deskOwner.get("/api/desktop/licence")).json).toMatchObject({ connected: false, plan: "free", reason: "not_connected" });
    expect((await posSale(deskOwner, c)).json.error.code).toBe("PLAN_FEATURE");
    expect((await deskOwner.post(`/api/orgs/${deskOrg}/users`, { name: "Staff", username: "desk.staff", role: "billing" })).json.error.code).toBe("PLAN_LIMIT");
    // Everyday billing still works on the Free plan.
    expect((await deskOwner.post(c("/items"), { kind: "goods", name: "Soap", sale_price: "5" })).status).toBe(201);

    // Wrong password: refused by the website, nothing stored.
    const bad = await deskOwner.post("/api/desktop/licence/connect", { login: me.email, password: "wrong password!!" });
    expect(bad.status).toBe(401);
    // Connect with the website account (on its 30-day trial).
    const ok = await deskOwner.post("/api/desktop/licence/connect", { login: me.email, password: "correct horse battery" });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json).toMatchObject({ connected: true, status: "trial", plan: "business", reason: "ok", email: me.email, org_name: "Test Org" });
    expect((await posSale(deskOwner, c)).status).toBe(201);
    expect(JSON.stringify(ok.json)).not.toMatch(/device_token|private/);
    // The website records the computer (only a hash of its token).
    const dev = await rawQuery(W, `SELECT org_id, token_hash, revoked_at FROM desktop_devices`);
    expect(dev).toHaveLength(1);
    expect(dev[0].org_id).toBe(W.orgId);

    // Paid on the website: the next check brings the paid plan.
    await rawQuery(W, `UPDATE org_subscriptions SET plan = 'multi_branch', paid_until = ?, trial_ends_at = NULL WHERE org_id = ?`, new Date(Date.now() + 30 * DAY).toISOString(), W.orgId);
    expect((await deskOwner.post("/api/desktop/licence/refresh")).json).toMatchObject({ status: "active", plan: "multi_branch" });

    // Offline for more than the allowed days: back to the Free plan until it can check again.
    const late = await desktopLicenceState(desk, Date.now() + (OFFLINE_DAYS + 1) * DAY);
    expect(late).toMatchObject({ plan: "free", reason: "check_overdue" });

    // A licence edited on the computer is rejected.
    const row = (await rawQuery({ env: desk } as any, `SELECT token FROM desktop_licence`))[0];
    const [body, sig] = row.token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), plan: "multi_branch", plan_until: "2099-01-01T00:00:00Z" })).toString("base64url");
    await rawQuery({ env: desk } as any, `UPDATE desktop_licence SET token = ?`, `${forged}.${sig}`);
    expect((await deskOwner.get("/api/desktop/licence")).json).toMatchObject({ plan: "free", reason: "invalid" });

    // Disconnect: Free plan again; data untouched.
    expect((await deskOwner.post("/api/desktop/licence/disconnect")).json).toMatchObject({ connected: false, plan: "free" });
    expect((await deskOwner.get(c("/items"))).json.items.length).toBeGreaterThan(0);
  });

  it("follows the website: a revoked computer keeps its last licence only until the offline window ends; trial ended means Free", async () => {
    const { W, me, desk, deskOwner } = await setup();
    await deskOwner.post("/api/desktop/licence/connect", { login: me.email, password: "correct horse battery" });
    await rawQuery(W, `UPDATE desktop_devices SET revoked_at = ?`, new Date().toISOString());
    const r = (await deskOwner.post("/api/desktop/licence/refresh")).json;
    expect(r.last_error).toMatch(/no longer connected/);
    expect(r.plan).toBe("business"); // still within the offline window
    // Trial over on the website, connected again: Free plan.
    await rawQuery(W, `UPDATE org_subscriptions SET trial_ends_at = ? WHERE org_id = ?`, new Date(Date.now() - DAY).toISOString(), W.orgId);
    const again = (await deskOwner.post("/api/desktop/licence/connect", { login: me.email, password: "correct horse battery" })).json;
    expect(again).toMatchObject({ connected: true, plan: "free", reason: "plan_ended" });
    expect(await desktopLicenceState(desk)).toMatchObject({ plan: "free" });
  });

  it("explains that the trial starts once auto-pay is set up on the website", async () => {
    const { W, me, deskOwner } = await setup();
    W.env.BILLING_REQUIRE_AUTOPAY = "true";
    const r = (await deskOwner.post("/api/desktop/licence/connect", { login: me.email, password: "correct horse battery" })).json;
    expect(r).toMatchObject({ connected: true, plan: "free", reason: "autopay_required" });
  });

  it("asks which organisation when the account manages several, and only owners or admins on the computer may connect", async () => {
    const { W, me, desk, deskOwner, deskOrg } = await setup();
    await W.owner.post("/api/orgs", { name: "Second", company: { name: "Second Shop", country: "IN", base_currency: "INR", fiscal_year_start_month: 4, state_code: "29" } });
    const choose = await deskOwner.post("/api/desktop/licence/connect", { login: me.email, password: "correct horse battery" });
    expect([choose.status, choose.json.error.code]).toEqual([409, "CHOOSE_ORG"]);
    expect(choose.json.error.details.organisations).toHaveLength(2);
    const ok = await deskOwner.post("/api/desktop/licence/connect", { login: me.email, password: "correct horse battery", org_id: W.orgId });
    expect(ok.json.org_name).toBe("Test Org");
    // A billing clerk on the computer cannot change the licence.
    desk.DESKTOP_LICENSING = "off"; // let the owner add a user on this test computer
    const u = await deskOwner.post(`/api/orgs/${deskOrg}/users`, { name: "Clerk", username: "desk.clerk", role: "billing" });
    delete desk.DESKTOP_LICENSING;
    const clerk = new Client(desk);
    clerk.ip = "127.0.0.1"; // one-time passwords work only on the computer itself
    await clerk.post("/api/auth/login", { login: "desk.clerk", password: u.json.temporary_password });
    await clerk.post("/api/auth/change-password", { current_password: u.json.temporary_password, new_password: "clerk pass 12345" });
    expect((await clerk.post("/api/desktop/licence/disconnect")).status).toBe(403);
  });

  it("is switched off on the website itself and for self-built copies", async () => {
    const W = await world();
    expect((await W.owner.get("/api/desktop/licence")).status).toBe(404);
    const { env: desk } = await makeEnv();
    Object.assign(desk, { APP_ENV: "desktop", DESKTOP_LICENSING: "off", ALLOW_REGISTRATION: "true" });
    const { client } = await register(desk, "Self host");
    const o = (await client.post("/api/orgs", { name: "S", company: { name: "S", country: "IN", base_currency: "INR", fiscal_year_start_month: 4, state_code: "29" } })).json;
    expect((await client.get(`/api/billing/org/${o.org_id}`)).json.subscription.status).toBe("unlimited");
  });
});
