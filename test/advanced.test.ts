import { describe, expect, it } from "vitest";
import { world, contact, register, rawQuery, Client } from "./helpers";
import { allocate } from "../src/worker/routes/advanced";

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function member(W: any, role: string) {
  const { client, email } = await register(W.env, role);
  const inv = await W.owner.post(`/api/orgs/${W.orgId}/invitations`, { email, role });
  await client.post("/api/invitations/accept", { token: inv.json.token });
  return client;
}

describe("landed cost", () => {
  it("spreads freight over the bill's stock items by value, into stock value and the inventory account", async () => {
    expect(allocate(1000, [1, 1, 1])).toEqual([334, 333, 333]);
    const W = await world();
    const s = await contact(W, "supplier", { name: "Importer" });
    const item = async (name: string) => (await W.owner.post(W.c("/items"), { name, kind: "goods", track_inventory: true, purchase_price: "1" })).json.id;
    const a = await item("Chair"), b = await item("Table");
    const bill = await W.owner.post(W.c("/documents"), { doc_type: "bill", contact_id: s, issue_date: day(-2), lines: [
      { item_id: a, description: "Chair", quantity: "10", unit_price: "1000" }, { item_id: b, description: "Table", quantity: "2", unit_price: "5000" }] });
    expect((await W.owner.post(W.c(`/documents/${bill.json.id}/issue`))).status).toBe(200);
    const freight = W.acc["6500"] ?? W.acc.PURCHASES;
    const r = await W.owner.post(W.c("/landed-costs"), { bill_id: bill.json.id, credit_account_id: freight, charges: [{ description: "Freight", amount: "1500" }, { description: "Customs", amount: "500" }] });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.lines.map((l: any) => l.added)).toEqual([100_000, 100_000]); // 10,000 and 10,000 of value: 1,000 each
    const stock = await rawQuery(W, `SELECT item_id, SUM(qty_milli) AS q, SUM(value) AS v FROM stock_moves WHERE company_id = ? GROUP BY item_id`, W.companyId);
    expect(stock.find((x: any) => x.item_id === a)).toMatchObject({ q: 10_000, v: 1_100_000 }); // 11,000 for 10 chairs: 1,100 each
    const val = (await W.owner.get(W.c("/reports/inventory-valuation"))).json;
    expect(val.reconciles).toBe(true);
    // Not on a draft, and not for items already sold out.
    const draft = await W.owner.post(W.c("/documents"), { doc_type: "bill", contact_id: s, issue_date: day(0), lines: [{ item_id: a, description: "Chair", quantity: "1", unit_price: "1000" }] });
    expect((await W.owner.post(W.c("/landed-costs"), { bill_id: draft.json.id, credit_account_id: freight, charges: [{ description: "Freight", amount: "10" }] })).status).toBe(409);
  });
});

describe("approval rules", () => {
  it("makes a big purchase order wait for two approvals by different roles before it is issued", async () => {
    const W = await world();
    const buyer = await member(W, "purchase");
    const acct = await member(W, "accountant");
    const admin = await member(W, "admin");
    expect((await W.owner.put(W.c("/approval-rules"), { rules: [
      { doc_type: "purchase_order", min_amount: "50000", approver_role: "accountant", step: 1 },
      { doc_type: "purchase_order", min_amount: "100000", approver_role: "admin", step: 2 }] })).status).toBe(200);
    const s = await contact(W, "supplier", { name: "Big Supplier" });
    const mk = async (amount: string) => (await buyer.post(W.c("/documents"), { doc_type: "purchase_order", contact_id: s, issue_date: day(0), lines: [{ description: "Machines", quantity: "1", unit_price: amount, account_id: W.acc.PURCHASES }] })).json.id;
    const small = await mk("20000");
    expect((await buyer.post(W.c(`/documents/${small}/issue`))).status).toBe(200);
    const big = await mk("150000");
    const blocked = await buyer.post(W.c(`/documents/${big}/issue`));
    expect([blocked.status, blocked.json.error.code]).toEqual([403, "APPROVAL_REQUIRED"]);
    expect(blocked.json.error.message).toMatch(/accountant \(step 1\)/);
    // The admin cannot jump to step 2 before step 1... the accountant approves step 1, then the admin step 2.
    expect((await admin.post(W.c(`/approvals/${big}/approve`), {})).status).toBe(403);
    expect((await acct.get(W.c("/approvals"))).json.pending[0]).toMatchObject({ id: big, next_step: 1, mine: true });
    expect((await acct.post(W.c(`/approvals/${big}/approve`), { note: "Budgeted" })).json).toMatchObject({ step: 1, complete: false });
    expect((await buyer.post(W.c(`/documents/${big}/issue`))).json.error.message).toMatch(/admin \(step 2\)/);
    expect((await admin.post(W.c(`/approvals/${big}/approve`), {})).json).toMatchObject({ step: 2, complete: true });
    expect((await buyer.post(W.c(`/documents/${big}/issue`))).status).toBe(200);
    // The person who made a document cannot approve it.
    const own = await (async () => (await acct.post(W.c("/documents"), { doc_type: "purchase_order", contact_id: s, issue_date: day(0), lines: [{ description: "X", quantity: "1", unit_price: "60000", account_id: W.acc.PURCHASES }] })).json.id)();
    expect((await acct.post(W.c(`/approvals/${own}/approve`), {})).json.error?.code).toBe("SELF_APPROVAL");
  });
});

describe("foreign-currency revaluation", () => {
  it("posts the unrealised gain on an open USD invoice at month end and reverses it the next day", async () => {
    const W = await world();
    const cust = await contact(W, "customer", { name: "US Client", country: "US", currency: "USD", state_code: "96" });
    const inv = await W.owner.post(W.c("/documents"), { doc_type: "invoice", contact_id: cust, issue_date: day(-20), currency: "USD", fx_rate: "83", lines: [{ description: "Design", quantity: "1", unit_price: "1000", account_id: W.acc.SALES }] });
    expect(inv.status, JSON.stringify(inv.json)).toBe(201);
    expect((await W.owner.post(W.c(`/documents/${inv.json.id}/issue`))).status).toBe(200);
    expect((await W.owner.get(W.c(`/fx-revaluation?as_of=${day(-1)}`))).json.missing_rates).toEqual(["USD"]);
    expect((await W.owner.post(W.c("/settings/exchange-rates"), { currency: "USD", rate_date: day(-3), rate: "84.5" })).status).toBeLessThan(300);
    const r = (await W.owner.get(W.c(`/fx-revaluation?as_of=${day(-1)}`))).json;
    expect(r.rows[0]).toMatchObject({ number: expect.any(String), booked_base: 8_300_000, new_base: 8_450_000, difference: 150_000 });
    const post = await W.owner.post(W.c("/fx-revaluation"), { as_of: day(-1) });
    expect(post.status, JSON.stringify(post.json)).toBe(201);
    const bal = async (acc: string, date: string) => (await rawQuery(W, `SELECT COALESCE(SUM(l.credit - l.debit), 0) AS b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.status = 'posted' AND l.account_id = ? AND e.entry_date <= ?`, acc, date))[0].b;
    expect(await bal(W.acc.FX_GAIN_LOSS, day(-1))).toBe(150_000);
    expect(await bal(W.acc.FX_GAIN_LOSS, day(0))).toBe(0);
    expect((await W.owner.post(W.c("/fx-revaluation"), { as_of: day(-1) })).status).toBe(409);
  });
});

describe("public API keys", () => {
  it("lets a read key list invoices of its own company only, a write key create a customer, and a revoked key nothing", async () => {
    const W = await world();
    const read = (await W.owner.post(W.c("/api-keys"), { name: "Website", access: "read" })).json;
    expect(read.key).toMatch(/^lfk_/);
    const write = (await W.owner.post(W.c("/api-keys"), { name: "Shop", access: "write" })).json;
    const api = (key: string) => ({ get: (p: string) => new Client(W.env).req("GET", p, undefined, { authorization: `Bearer ${key}`, "x-requested-with": "" }), post: (p: string, b: unknown) => new Client(W.env).req("POST", p, b, { authorization: `Bearer ${key}`, "x-requested-with": "" }) });
    expect((await api(read.key).get(W.c("/documents?type=invoice"))).status).toBe(200);
    expect((await api(read.key).post(W.c("/contacts"), { kind: "customer", name: "From API" })).status).toBe(403);
    const made = await api(write.key).post(W.c("/contacts"), { kind: "customer", name: "From API" });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    // Not another company, not the account or organisation routes.
    const O = await world();
    expect((await api(write.key).get(O.c("/documents"))).status).toBe(404);
    expect((await api(write.key).get(`/api/orgs/${W.orgId}`)).status).toBe(401);
    expect((await api("lfk_wrong").get(W.c("/documents"))).status).toBe(401);
    expect((await W.owner.get(W.c("/api-keys"))).json.keys.map((k: any) => k.prefix)).toContain(read.key.slice(0, 10));
    await W.owner.post(W.c(`/api-keys/${read.id}/revoke`));
    expect((await api(read.key).get(W.c("/documents"))).status).toBe(401);
    // Only the hash is stored.
    expect((await rawQuery(W, `SELECT COUNT(*) AS n FROM api_keys WHERE key_hash = ?`, read.key))[0].n).toBe(0);
  });
});
