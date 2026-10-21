import { describe, expect, it } from "vitest";
import { world, Client, rawQuery } from "./helpers";
import { currentStep, totpAt } from "../src/worker/lib/totp";

describe("two-factor sign-in", () => {
  it("enrols with an authenticator app, then asks for a code at sign-in", async () => {
    const W = await world();
    const me = (await W.owner.get("/api/auth/me")).json.user;
    expect((await W.owner.post("/api/auth/2fa/setup", { current_password: "wrong" })).status).toBe(400);
    const setup = await W.owner.post("/api/auth/2fa/setup", { current_password: "correct horse battery" });
    expect(setup.json.otpauth_url).toMatch(/^otpauth:\/\/totp\/LedgerFox%3A.+\?secret=[A-Z2-7]{32}&issuer=LedgerFox/);
    const secret = setup.json.secret as string;
    expect((await W.owner.post("/api/auth/2fa/enable", { code: "000000" })).status).toBe(400);
    const en = await W.owner.post("/api/auth/2fa/enable", { code: await totpAt(secret, currentStep()) });
    expect(en.status).toBe(200);
    expect(en.json.recovery_codes).toHaveLength(8);
    expect((await W.owner.get("/api/auth/me")).json.user.totp_enabled).toBe(true);

    const c = new Client(W.env);
    const first = await c.post("/api/auth/login", { login: me.email, password: "correct horse battery" });
    expect([first.status, first.json.error.code]).toEqual([401, "TOTP_REQUIRED"]);
    expect(c.cookie).toBe(""); // no session without the second step
    expect((await c.post("/api/auth/login", { login: me.email, password: "correct horse battery", totp: "123456" })).json.error.code).toBe("TOTP_INVALID");
    // Next step's code (the enable step was consumed, so the current one cannot be replayed).
    const next = await totpAt(secret, currentStep() + 1);
    expect((await c.post("/api/auth/login", { login: me.email, password: "correct horse battery", totp: next })).status).toBe(200);
    const again = new Client(W.env);
    expect((await again.post("/api/auth/login", { login: me.email, password: "correct horse battery", totp: next })).json.error.code).toBe("TOTP_INVALID");
    // A recovery code works once, with or without dashes.
    const rc = en.json.recovery_codes[0] as string;
    expect((await again.post("/api/auth/login", { login: me.email, password: "correct horse battery", recovery_code: rc.replace(/-/g, "").toLowerCase() })).status).toBe(200);
    expect((await new Client(W.env).post("/api/auth/login", { login: me.email, password: "correct horse battery", recovery_code: rc })).status).toBe(401);
  });

  it("owner can require it for everyone; a password reset by the owner clears a lost phone", async () => {
    const W = await world();
    const u = await W.owner.post(`/api/orgs/${W.orgId}/users`, { name: "Staff", username: "tf.staff", role: "accountant" });
    const staff = new Client(W.env);
    await staff.post("/api/auth/login", { login: "tf.staff", password: u.json.temporary_password });
    await staff.post("/api/auth/change-password", { current_password: u.json.temporary_password, new_password: "tf staff pass 12" });
    expect((await W.owner.patch(`/api/orgs/${W.orgId}`, { name: "Test Org", require_2fa: true })).status).toBe(400); // owner must enrol first
    const s = await W.owner.post("/api/auth/2fa/setup", { current_password: "correct horse battery" });
    await W.owner.post("/api/auth/2fa/enable", { code: await totpAt(s.json.secret, currentStep()) });
    expect((await staff.patch(`/api/orgs/${W.orgId}`, { name: "Test Org", require_2fa: false })).status).toBe(403);
    expect((await W.owner.patch(`/api/orgs/${W.orgId}`, { name: "Test Org", require_2fa: true })).status).toBe(200);
    const blocked = await staff.get(W.c("/settings"));
    expect([blocked.status, blocked.json.error.code]).toEqual([403, "TWO_FACTOR_REQUIRED"]);
    const ss = await staff.post("/api/auth/2fa/setup", { current_password: "tf staff pass 12" });
    await staff.post("/api/auth/2fa/enable", { code: await totpAt(ss.json.secret, currentStep()) });
    expect((await staff.get(W.c("/settings"))).status).toBe(200);
    expect((await staff.post("/api/auth/2fa/disable", { current_password: "tf staff pass 12", code: await totpAt(ss.json.secret, currentStep() + 1) })).status).toBe(403);
    // Lost phone: the owner issues a new one-time password, which also switches 2FA off for that person.
    const reset = await W.owner.post(`/api/orgs/${W.orgId}/members/${u.json.id}/temporary-password`);
    expect(reset.status).toBe(200);
    const [row] = await rawQuery(W, `SELECT totp_enabled, totp_secret FROM users WHERE id = ?`, u.json.id);
    expect(row).toEqual({ totp_enabled: 0, totp_secret: null });
  });
});
