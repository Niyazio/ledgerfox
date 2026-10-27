import { describe, expect, it } from "vitest";
import { Client, world, contact, register } from "./helpers";

describe("practice view for accountants", () => {
  it("lists every client company with figures only where the user may see them all", async () => {
    // Two businesses invite the same accountant.
    const A = await world();
    const cust = await contact(A, "customer");
    const inv = await A.owner.post(A.c("/documents"), { doc_type: "invoice", contact_id: cust, issue_date: new Date().toISOString().slice(0, 10), lines: [{ description: "Work", quantity: "1", unit_price: "1000" }] });
    expect((await A.owner.post(A.c(`/documents/${inv.json.id}/issue`))).status).toBe(200);
    await A.owner.post(A.c("/documents"), { doc_type: "invoice", contact_id: cust, issue_date: "2026-05-01", lines: [{ description: "Draft", quantity: "1", unit_price: "5" }] });
    const second = await A.owner.post("/api/orgs", { name: "Second Org", company: { name: "Second Co", country: "IN", base_currency: "INR", fiscal_year_start_month: 4, state_code: "29" } });
    expect(second.status).toBe(201);

    const { client: ca, email } = await register(A.env, "CA Meera");
    for (const [orgId, role] of [[A.orgId, "accountant"], [second.json.org_id, "viewer"]]) {
      const inviteRes = await A.owner.post(`/api/orgs/${orgId}/invitations`, { email, role });
      expect(inviteRes.status).toBe(201);
      expect((await ca.post("/api/invitations/accept", { token: inviteRes.json.token })).status).toBe(200);
    }
    const r = (await ca.get("/api/clients")).json;
    const byName = Object.fromEntries(r.clients.map((x: any) => [x.name, x]));
    expect(Object.keys(byName).sort()).toEqual(["Acme Traders", "Second Co"]);
    expect(byName["Acme Traders"]).toMatchObject({ role: "accountant", figures: true, stats: { sales_month: 100_000, receivables: 100_000, payables: 0, drafts: 1 } });
    expect(byName["Second Co"]).toMatchObject({ role: "viewer", figures: true, stats: { sales_month: 0, receivables: 0 } });
    // Someone with no memberships sees nothing.
    const { client: stranger } = await register(A.env, "Stranger");
    expect((await stranger.get("/api/clients")).json.clients).toEqual([]);
  });

  it("hides figures from members limited to some branches", async () => {
    const W = await world();
    const blr = (await W.owner.post(W.c("/settings/branches"), { name: "Bengaluru", code: "BLR" })).json.id;
    const u = await W.owner.post(`/api/orgs/${W.orgId}/users`, { name: "Branch Clerk", username: "branch.clerk", role: "accountant", branches: { company_id: W.companyId, all_branches: false, branch_ids: [blr] } });
    expect(u.status, JSON.stringify(u.json)).toBe(201);
    const cl = new Client(W.env);
    await cl.post("/api/auth/login", { login: "branch.clerk", password: u.json.temporary_password });
    await cl.post("/api/auth/change-password", { current_password: u.json.temporary_password, new_password: "branch clerk pass 1" });
    const r = (await cl.get("/api/clients")).json;
    expect(r.clients).toEqual([expect.objectContaining({ name: "Acme Traders", figures: false, stats: null })]);
  });
});
