import { describe, expect, it } from "vitest";
import { makeEnv, Client, register, world, rawQuery } from "./helpers";
import { regionName, regionProblem, regionsFor } from "../src/shared/regions";

const company = (country: string, currency: string, extra: Record<string, unknown> = {}) => ({ name: "Trading Co", country, base_currency: currency, fiscal_year_start_month: 1, ...extra });

describe("states and regions follow the company's country", () => {
  it("knows emirates, Saudi regions and more, and never offers Indian states abroad", () => {
    expect(regionName("AE", "DU")).toBe("Dubai");
    expect(regionName("SA", "01")).toBe("Riyadh");
    expect(regionsFor("IN")!["29"]).toBe("Karnataka");
    expect(regionsFor("SA")!["29"]).toBeUndefined();
    expect(regionProblem("SA", "29")).toMatch(/region/);
    expect(regionProblem("EG", "anything")).toBeNull(); // no list: no check
  });

  it("checks the region of a company and of its contacts against their country", async () => {
    const { env } = await makeEnv();
    const { client } = await register(env);
    const bad = await client.post("/api/orgs", { name: "Org", company: company("SA", "SAR", { state_code: "29" }) });
    expect([bad.status, bad.json.error.message]).toEqual([400, expect.stringMatching(/region/)]);
    const r = await client.post("/api/orgs", { name: "Org", company: company("SA", "SAR", { state_code: "01" }) });
    expect(r.status).toBe(201);
    const c = (p: string) => `/api/c/${r.json.company_id}${p}`;
    expect((await client.get(c("/settings"))).json.company.state_code).toBe("01");
    // A customer in Dubai; an Indian state for a UAE customer is refused.
    const dubai = await client.post(c("/contacts"), { kind: "customer", name: "Dubai Buyer", country: "AE", state_code: "DU", currency: "AED" });
    expect(dubai.status).toBe(201);
    expect((await client.get(c(`/contacts/${dubai.json.id}`))).json.contact).toMatchObject({ country: "AE", state_code: "DU", currency: "AED" });
    const wrong = await client.post(c("/contacts"), { kind: "customer", name: "Wrong", country: "AE", state_code: "29" });
    expect(wrong.status).toBe(400);
    // Settings keep working for the Saudi company.
    expect((await client.patch(c("/settings"), { name: "Trading Co", state_code: "04" })).status).toBe(200);
  });

  it("still lets an Indian company give a foreign customer the GST place of supply 96 (other country)", async () => {
    const W = await world();
    expect((await W.owner.post(W.c("/contacts"), { kind: "customer", name: "US Buyer", country: "US", state_code: "96", currency: "USD" })).status).toBe(201);
  });
});

/** Hosted edition with billing on, a LedgerFox admin, and a teacher. */
async function school() {
  const { env } = await makeEnv();
  const admin = await register(env, "LedgerFox staff");
  Object.assign(env, { BILLING_ENABLED: "true", VENDOR_ADMIN_EMAILS: admin.email });
  const teacher = await register(env, "Teacher");
  const login = async () => {
    const d = new Client(env);
    const r = await d.post("/api/auth/login", { login: teacher.email, password: "correct horse battery" });
    expect(r.status).toBe(200);
    return d;
  };
  return { env, admin: admin.client, teacher: teacher.client, email: teacher.email, login };
}

describe("education mode by approval", () => {
  it("needs LedgerFox's approval, and allows one practice or demo company per organisation", async () => {
    const S = await school();
    const practice = company("IN", "INR", { name: "Class 11", is_practice: true, state_code: "29" });
    const refused = await S.teacher.post("/api/orgs", { name: "School", company: practice });
    expect([refused.status, refused.json.error.code]).toEqual([403, "EDUCATION_NOT_APPROVED"]);
    expect((await S.teacher.get("/api/education/me")).json.approved).toBe(false);
    // Only LedgerFox staff see the approvals.
    expect((await S.teacher.get("/api/education/admin")).status).toBe(404);
    expect((await S.admin.put(`/api/education/admin/${encodeURIComponent(S.email.toUpperCase())}`, { note: "ABC College" })).json.access).toMatchObject({ email: S.email, devices: 10 });
    expect((await S.teacher.get("/api/education/me")).json.approved).toBe(true);
    const ok = await S.teacher.post("/api/orgs", { name: "School", company: practice });
    expect(ok.status).toBe(201);
    // A second practice organisation, or a second practice company in it, is refused.
    expect((await S.teacher.post("/api/orgs", { name: "School 2", company: practice })).json.error.code).toBe("LEARNING_COMPANY_EXISTS");
    expect((await S.teacher.post(`/api/orgs/${ok.json.org_id}/companies`, { ...practice, name: "Class 12" })).json.error.code).toBe("LEARNING_COMPANY_EXISTS");
  });

  it("opens on up to the allowed number of devices; the owner frees a device; a 25-student pack raises it for 6 months", async () => {
    const S = await school();
    await S.admin.put(`/api/education/admin/${encodeURIComponent(S.email)}`, { devices: 2 });
    const r = (await S.teacher.post("/api/orgs", { name: "School", company: company("IN", "INR", { name: "Class", is_practice: true, state_code: "29" }) })).json;
    const c = (p: string) => `/api/c/${r.company_id}${p}`;
    // Device 1 (the teacher's browser), many requests, still one device.
    for (let i = 0; i < 3; i++) expect((await S.teacher.get(c("/settings"))).status).toBe(200);
    const second = await S.login();
    expect((await second.get(c("/settings"))).status).toBe(200);
    const third = await S.login();
    const blocked = await third.get(c("/settings"));
    expect([blocked.status, blocked.json.error.code]).toEqual([403, "EDUCATION_DEVICE_LIMIT"]);
    expect(blocked.json.error.message).toMatch(/25, 50 or 100 student pack/);
    // The owner sees two devices and removes the second one; the third device fits now.
    const info = (await S.teacher.get(`/api/education/orgs/${r.org_id}`)).json;
    expect([info.devices.length, info.allowed]).toEqual([2, 2]);
    expect((await S.teacher.del(`/api/education/orgs/${r.org_id}/devices/${encodeURIComponent(info.devices[0].device_id)}`)).status).toBe(200);
    expect((await third.get(c("/settings"))).status).toBe(200);
    // The teacher asks for a pack; LedgerFox sees the request and switches it on after payment.
    expect((await S.teacher.post(`/api/education/orgs/${r.org_id}/request`, { pack: "edu25" })).status).toBe(200);
    const admin = (await S.admin.get("/api/education/admin")).json;
    expect(admin.requests[0]).toMatchObject({ owner_email: S.email, details: { pack: "edu25", students: 25 } });
    const granted = (await S.admin.put(`/api/education/admin/${encodeURIComponent(S.email)}`, { pack: "edu25" })).json.access;
    expect(granted).toMatchObject({ pack: "edu25", pack_active: true, devices: 25 });
    const months = (Date.parse(granted.pack_until) - Date.now()) / (30.4 * 86_400_000);
    expect(months).toBeGreaterThan(5.8);
    expect(months).toBeLessThan(6.2);
    expect((await (await S.login()).get(c("/settings"))).status).toBe(200);
    // After the pack ends, the free allowance applies again.
    await rawQuery({ env: S.env } as any, `UPDATE education_access SET pack_until = '2020-01-01T00:00:00Z' WHERE email = ?`, S.email);
    expect((await S.teacher.get(`/api/education/orgs/${r.org_id}`)).json.allowed).toBe(2);
  });

  it("stops opening when LedgerFox removes the approval, and keeps the data", async () => {
    const S = await school();
    await S.admin.put(`/api/education/admin/${encodeURIComponent(S.email)}`, {});
    const r = (await S.teacher.post("/api/orgs", { name: "School", company: company("IN", "INR", { name: "Class", is_practice: true, state_code: "29" }) })).json;
    const c = (p: string) => `/api/c/${r.company_id}${p}`;
    expect((await S.teacher.post(c("/items"), { kind: "goods", name: "Practice item", sale_price: "10" })).status).toBe(201);
    expect((await S.admin.del(`/api/education/admin/${encodeURIComponent(S.email)}`)).status).toBe(200);
    const closed = await S.teacher.get(c("/settings"));
    expect([closed.status, closed.json.error.code]).toEqual([403, "EDUCATION_NOT_APPROVED"]);
    expect((await S.admin.get("/api/education/admin")).json.access[0]).toMatchObject({ email: S.email, revoked_at: expect.any(String) });
    // Given back: everything is still there.
    await S.admin.put(`/api/education/admin/${encodeURIComponent(S.email)}`, {});
    expect((await S.teacher.get(c("/items"))).json.items.map((i: any) => i.name)).toContain("Practice item");
  });
});
