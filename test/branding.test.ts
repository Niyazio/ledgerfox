import { describe, expect, it, beforeAll } from "vitest";
import { world, register, type World } from "./helpers";

// 1×1 transparent PNG.
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
let W: World;
beforeAll(async () => { W = await world(); });

describe("logo, payment QR and UPI ID", () => {
  it("stores a logo and payment QR separately from company settings", async () => {
    expect((await W.owner.get(W.c("/settings/branding"))).json).toEqual({ logo: null, payment_qr: null });
    expect((await W.owner.put(W.c("/settings/branding"), { logo: PNG, payment_qr: PNG })).status).toBe(200);
    expect((await W.owner.get(W.c("/settings/branding"))).json).toEqual({ logo: PNG, payment_qr: PNG });
    // Updating one keeps the other; null removes.
    expect((await W.owner.put(W.c("/settings/branding"), { payment_qr: null })).status).toBe(200);
    expect((await W.owner.get(W.c("/settings/branding"))).json).toEqual({ logo: PNG, payment_qr: null });
    // Settings responses do not carry the images.
    expect(JSON.stringify((await W.owner.get(W.c("/settings"))).json)).not.toContain("base64");
  });

  it("rejects non-images, mismatched types and oversized files", async () => {
    expect((await W.owner.put(W.c("/settings/branding"), { logo: "data:text/html;base64,PHNjcmlwdD4=" })).status).toBe(400);
    expect((await W.owner.put(W.c("/settings/branding"), { logo: "data:image/jpeg;base64," + PNG.split(",")[1] })).status).toBe(400);
    expect((await W.owner.put(W.c("/settings/branding"), { logo: "data:image/png;base64," + "A".repeat(440_000) })).status).toBe(400);
    expect((await W.owner.put(W.c("/settings/branding"), { logo: "https://evil.example/x.png" })).status).toBe(400);
  });

  it("only managers can change branding; UPI ID can be set when creating a company", async () => {
    const { client, email } = await register(W.env, "Accountant");
    const inv = await W.owner.post(`/api/orgs/${W.orgId}/invitations`, { email, role: "accountant" });
    await client.post("/api/invitations/accept", { token: inv.json.token });
    expect((await client.put(W.c("/settings/branding"), { logo: PNG })).status).toBe(403);
    const r = await W.owner.post(`/api/orgs/${W.orgId}/companies`, { name: "UPI Co", country: "IN", base_currency: "INR", fiscal_year_start_month: 4, state_code: "29", upi_id: "upico@okbank" });
    expect(r.status).toBe(201);
    expect((await W.owner.get(`/api/c/${r.json.company_id}/settings`)).json.company.upi_id).toBe("upico@okbank");
    expect((await W.owner.post(`/api/orgs/${W.orgId}/companies`, { name: "Bad", country: "IN", base_currency: "INR", fiscal_year_start_month: 4, upi_id: "not a upi" })).status).toBe(400);
  });
});
