import { describe, expect, it, beforeAll } from "vitest";
import { world, register, contact, Client, type World } from "./helpers";

let A: World;
let bClient: Client;
let bCompany: string;
let aInvoice: string;
let aCustomer: string;

beforeAll(async () => {
  A = await world();
  aCustomer = await contact(A, "customer", { state_code: "29" });
  const inv = await A.owner.post(A.c("/documents"), { doc_type: "invoice", contact_id: aCustomer, issue_date: "2026-05-05", lines: [{ description: "x", quantity: "1", unit_price: "100" }] });
  aInvoice = inv.json.id;
  await A.owner.post(A.c(`/documents/${aInvoice}/issue`));
  // Tenant B: a different user with their own organisation in the same database.
  const b = await register(A.env, "Intruder");
  bClient = b.client;
  const r = await bClient.post("/api/orgs", { name: "B Org", company: { name: "B Co", country: "IN", base_currency: "INR", fiscal_year_start_month: 4, state_code: "29" } });
  bCompany = r.json.company_id;
});

describe("authentication", () => {
  it("rejects unauthenticated access", async () => {
    const anon = new Client(A.env);
    expect((await anon.get(A.c("/settings"))).status).toBe(401);
    expect((await anon.get("/api/auth/me")).json.user).toBeNull();
  });

  it("rejects mutations without the CSRF header or from another origin", async () => {
    const noHeader = await A.owner.req("POST", A.c("/journals"), { entry_date: "2026-05-01", lines: [] }, { "x-requested-with": "" });
    expect(noHeader.status).toBe(403);
    const cross = await A.owner.req("POST", A.c("/journals"), { entry_date: "2026-05-01", lines: [] }, { origin: "https://evil.example" });
    expect(cross.status).toBe(403);
  });

  it("login, wrong password, logout, and rate limiting", async () => {
    const { email } = await register(A.env, "Login Tester");
    const c = new Client(A.env);
    expect((await c.post("/api/auth/login", { email, password: "wrong password!!" })).status).toBe(401);
    expect((await c.post("/api/auth/login", { email, password: "correct horse battery" })).status).toBe(200);
    expect((await c.get("/api/auth/me")).json.user.email).toBe(email);
    await c.post("/api/auth/logout");
    expect((await c.get("/api/auth/me")).json.user).toBeNull();
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await c.post("/api/auth/login", { email, password: "nope nope nope" })).status;
    expect(last).toBe(429);
  });

  it("does not reveal whether an email is registered", async () => {
    const c = new Client(A.env);
    const r = await c.post("/api/auth/login", { email: "nobody-here@example.com", password: "whatever123" });
    expect(r.status).toBe(401);
    expect(r.json.error.message).toBe("Invalid username or password");
  });

  it("recovery code resets the password exactly once", async () => {
    const { email, recovery } = await register(A.env, "Recover Me");
    const c = new Client(A.env);
    expect((await c.post("/api/auth/recover", { email, recovery_code: recovery[0], new_password: "a brand new password" })).status).toBe(200);
    expect((await c.post("/api/auth/recover", { email, recovery_code: recovery[0], new_password: "another new password" })).status).toBe(400);
    expect((await c.post("/api/auth/login", { email, password: "a brand new password" })).status).toBe(200);
  });

  it("enforces password length", async () => {
    const c = new Client(A.env);
    expect((await c.post("/api/auth/register", { name: "x", email: "short@example.com", password: "short", accept_terms: true })).status).toBe(400);
  });
});

describe("tenant isolation", () => {
  it("another user cannot read the company (404, no existence leak)", async () => {
    expect((await bClient.get(A.c("/settings"))).status).toBe(404);
    expect((await bClient.get(A.c("/reports/trial-balance"))).status).toBe(404);
    expect((await bClient.get(A.c("/export"))).status).toBe(404);
    expect((await bClient.get(A.c(`/documents/${aInvoice}`))).status).toBe(404);
  });

  it("cannot reach A's records through B's own company by changing IDs", async () => {
    const bc = (p: string) => `/api/c/${bCompany}${p}`;
    expect((await bClient.get(bc(`/documents/${aInvoice}`))).status).toBe(404);
    expect((await bClient.get(bc(`/contacts/${aCustomer}`))).status).toBe(404);
    expect((await bClient.post(bc(`/documents/${aInvoice}/void`), {})).status).toBe(404);
    expect((await bClient.del(bc(`/contacts/${aCustomer}`))).status).toBe(404);
  });

  it("cannot post to A's accounts or pay A's invoice from B's company", async () => {
    const bc = (p: string) => `/api/c/${bCompany}${p}`;
    const bAcc = (await bClient.get(bc("/accounts"))).json.accounts.find((a: any) => a.system_key === "CASH").id;
    const j = await bClient.post(bc("/journals"), { entry_date: "2026-05-01", post: true, lines: [{ account_id: A.acc.BANK, debit: "10" }, { account_id: bAcc, credit: "10" }] });
    expect(j.status).toBe(422);
    const bCust = (await bClient.post(bc("/contacts"), { kind: "customer", name: "B cust" })).json.id;
    const p = await bClient.post(bc("/payments"), { direction: "in", contact_id: bCust, payment_date: "2026-05-02", account_id: bAcc, amount: "100", allocations: [{ document_id: aInvoice, amount: "100" }] });
    expect(p.status).toBeGreaterThanOrEqual(400);
    const doc = await bClient.post(bc("/documents"), { doc_type: "invoice", contact_id: aCustomer, issue_date: "2026-05-02", lines: [{ description: "x", quantity: "1", unit_price: "1" }] });
    expect(doc.status).toBe(400);
  });

  it("database composite keys reject cross-company references even without the API", async () => {
    const bAcc = (await bClient.get(`/api/c/${bCompany}/accounts`)).json.accounts.find((a: any) => a.system_key === "CASH").id;
    const ent = await A.env.DB.prepare(`SELECT id FROM journal_entries WHERE company_id = ? LIMIT 1`).bind(A.companyId).first<{ id: string }>();
    const draftId = "draft-x";
    await A.env.DB.prepare(`INSERT INTO journal_entries (id, company_id, entry_date, created_by) VALUES (?, ?, '2026-05-01', (SELECT created_by FROM journal_entries WHERE id = ?))`).bind(draftId, A.companyId, ent!.id).run();
    await expect(A.env.DB.prepare(`INSERT INTO journal_lines (id, entry_id, company_id, line_no, account_id, debit) VALUES ('l1', ?, ?, 1, ?, 5)`).bind(draftId, A.companyId, bAcc).run()).rejects.toThrow(/FOREIGN KEY/);
    await expect(A.env.DB.prepare(`INSERT INTO journal_lines (id, entry_id, company_id, line_no, account_id, debit) VALUES ('l2', ?, ?, 1, ?, 5)`).bind(draftId, bCompany, bAcc).run()).rejects.toThrow(/TENANT_MISMATCH|FOREIGN KEY/);
    await A.env.DB.prepare(`DELETE FROM journal_entries WHERE id = ?`).bind(draftId).run();
  });
});

describe("role-based access", () => {
  async function member(role: "admin" | "accountant" | "auditor" | "viewer") {
    const { client, email } = await register(A.env, role);
    const inv = await A.owner.post(`/api/orgs/${A.orgId}/invitations`, { email, role });
    expect(inv.status).toBe(201);
    expect((await client.post("/api/invitations/accept", { token: inv.json.token })).status).toBe(200);
    return client;
  }

  it("viewer: read-only", async () => {
    const v = await member("viewer");
    expect((await v.get(A.c("/reports/profit-loss"))).status).toBe(200);
    expect((await v.post(A.c("/journals"), { entry_date: "2026-05-01", lines: [{ account_id: A.acc.CASH, debit: "1" }, { account_id: A.acc.CAPITAL, credit: "1" }] })).status).toBe(403);
    expect((await v.post(A.c("/contacts"), { kind: "customer", name: "nope" })).status).toBe(403);
    expect((await v.get(A.c("/export"))).status).toBe(403);
    expect((await v.get(A.c("/settings/audit-log"))).status).toBe(403);
  });

  it("auditor: reads audit log, cannot change anything", async () => {
    const a = await member("auditor");
    expect((await a.get(A.c("/settings/audit-log"))).status).toBe(200);
    expect((await a.post(A.c(`/documents/${aInvoice}/void`), {})).status).toBe(403);
    expect((await a.post(A.c("/settings/periods/lock-through"), { date: "2026-04-30" })).status).toBe(403);
  });

  it("accountant: posts transactions but cannot manage members, periods or export", async () => {
    const acct = await member("accountant");
    expect((await acct.post(A.c("/journals"), { entry_date: "2026-05-01", post: true, lines: [{ account_id: A.acc.CASH, debit: "1" }, { account_id: A.acc.CAPITAL, credit: "1" }] })).status).toBe(201);
    expect((await acct.post(`/api/orgs/${A.orgId}/invitations`, { email: "x@example.com", role: "viewer" })).status).toBe(403);
    expect((await acct.get(A.c("/export"))).status).toBe(403);
    expect((await acct.post(A.c("/settings/periods/lock-through"), { date: "2026-04-30" })).status).toBe(403);
  });

  it("admin cannot create other admins; owner can; owner export works", async () => {
    const adm = await member("admin");
    expect((await adm.post(`/api/orgs/${A.orgId}/invitations`, { email: "y@example.com", role: "admin" })).status).toBe(403);
    expect((await adm.post(`/api/orgs/${A.orgId}/invitations`, { email: "y@example.com", role: "accountant" })).status).toBe(201);
    expect((await A.owner.post(`/api/orgs/${A.orgId}/invitations`, { email: "z@example.com", role: "admin" })).status).toBe(201);
    const ex = await A.owner.get(A.c("/export"));
    expect(ex.status).toBe(200);
    expect(ex.json.format).toBe("ledgerfox-company-export");
    expect(Array.isArray(ex.json.journal_entries)).toBe(true);
    expect(ex.json.users).toBeUndefined(); // no password hashes or other tenants' data
  });

  it("an invitation can only be accepted by the invited email", async () => {
    const inv = await A.owner.post(`/api/orgs/${A.orgId}/invitations`, { email: "someone-else@example.com", role: "viewer" });
    expect((await bClient.post("/api/invitations/accept", { token: inv.json.token })).status).toBe(403);
  });

  it("segregation of duties: an accountant cannot approve their own expense", async () => {
    const acct = await member("accountant");
    const acct2 = await member("accountant");
    const e = await acct.post(A.c("/expenses"), { expense_date: "2026-05-03", category_account_id: A.acc["6400"], paid_from_account_id: A.acc.CASH, description: "Printer paper", amount: "450.00", tax_code_id: A.tax["GST 18%"] });
    expect(e.status).toBe(201);
    expect(e.json.total).toBe(53100);
    expect((await acct.post(A.c(`/expenses/${e.json.id}/submit`))).status).toBe(200);
    expect((await acct.post(A.c(`/expenses/${e.json.id}/approve`))).status).toBe(403);
    const ok = await acct2.post(A.c(`/expenses/${e.json.id}/approve`));
    expect(ok.status).toBe(200);
    expect((await acct2.post(A.c(`/expenses/${e.json.id}/approve`))).status).toBe(409);
  });
});

describe("input validation and attachments", () => {
  it("validates bodies and rejects malformed JSON", async () => {
    expect((await A.owner.post(A.c("/journals"), { entry_date: "2026-13-45", lines: [] })).status).toBe(400);
    const r = await A.owner.req("POST", A.c("/journals"), new TextEncoder().encode("{bad json") as unknown as Uint8Array, { "content-type": "application/json" });
    expect(r.status).toBe(400);
    expect((await A.owner.post(A.c("/contacts"), { kind: "customer", name: "Bad GST", tax_id: "29ABCDE1234F1Z0" })).status).toBe(400);
  });

  it("SQL injection strings are treated as data", async () => {
    const r = await A.owner.get(A.c(`/contacts?q=${encodeURIComponent("' OR 1=1; DROP TABLE contacts; --")}`));
    expect(r.status).toBe(200);
    expect(r.json.contacts.length).toBe(0);
    expect((await A.owner.get(A.c("/contacts"))).json.contacts.length).toBeGreaterThan(0);
  });

  it("attachments: type sniffing, size limit and tenant scoping", async () => {
    const e = await A.owner.post(A.c("/expenses"), { expense_date: "2026-05-03", category_account_id: A.acc["6400"], paid_from_account_id: A.acc.CASH, description: "Receipt test", amount: "10" });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const up = await A.owner.req("POST", A.c(`/attachments?entity_type=expense&entity_id=${e.json.id}&filename=r.png`), png, { "content-type": "image/png" });
    expect(up.status).toBe(201);
    const fake = await A.owner.req("POST", A.c(`/attachments?entity_type=expense&entity_id=${e.json.id}&filename=x.png`), new TextEncoder().encode("<script>alert(1)</script>"), { "content-type": "image/png" });
    expect(fake.status).toBe(415);
    const html = await A.owner.req("POST", A.c(`/attachments?entity_type=expense&entity_id=${e.json.id}&filename=x.html`), new TextEncoder().encode("<html>"), { "content-type": "text/html" });
    expect(html.status).toBe(415);
    const big = new Uint8Array(1024 * 1024 + 10); big.set(png);
    expect((await A.owner.req("POST", A.c(`/attachments?entity_type=expense&entity_id=${e.json.id}&filename=big.png`), big, { "content-type": "image/png" })).status).toBe(413);
    const get = await A.owner.req("GET", A.c(`/attachments/${up.json.id}`));
    expect(get.status).toBe(200);
    expect(get.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await bClient.get(A.c(`/attachments/${up.json.id}`))).status).toBe(404);
    expect((await bClient.get(`/api/c/${bCompany}/attachments/${up.json.id}`)).status).toBe(404);
  });
});

describe("password hash upgrade", () => {
  it("re-hashes with a higher work factor on successful login", async () => {
    const { email } = await register(A.env, "Upgrade Me");
    const before = await A.env.DB.prepare(`SELECT password_iters FROM users WHERE email = ?`).bind(email).first<{ password_iters: number }>();
    const env2 = { ...A.env, PBKDF2_ITERATIONS: "2000" };
    const c = new Client(env2);
    expect((await c.post("/api/auth/login", { email, password: "correct horse battery" })).status).toBe(200);
    const after = await A.env.DB.prepare(`SELECT password_iters FROM users WHERE email = ?`).bind(email).first<{ password_iters: number }>();
    expect(before!.password_iters).toBe(1000);
    expect(after!.password_iters).toBe(2000);
    expect((await new Client(env2).post("/api/auth/login", { email, password: "correct horse battery" })).status).toBe(200);
  });
});
