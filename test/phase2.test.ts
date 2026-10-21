import { describe, expect, it, beforeAll } from "vitest";
import { world, contact, Client, type World } from "./helpers";
import { ROLES, defaultPermissions, effectivePermissions } from "../src/shared/permissions";

const line = (description: string, quantity: string, unit_price: string, extra = {}) => ({ description, quantity, unit_price, ...extra });

/** Create a staff user through the API and sign them in with their one-time password, then set their own. */
async function staff(w: World, username: string, role: string, branches?: { all_branches: boolean; branch_ids: string[] }) {
  const r = await w.owner.post(`/api/orgs/${w.orgId}/users`, { name: username, username, role, ...(branches ? { branches: { company_id: w.companyId, ...branches } } : {}) });
  expect(r.status).toBe(201);
  const temp = r.json.temporary_password as string;
  const cl = new Client(w.env);
  expect((await cl.post("/api/auth/login", { login: username, password: temp })).status).toBe(200);
  // Until the password is changed nothing else is allowed.
  expect((await cl.get(w.c("/settings"))).status).toBe(403);
  expect((await cl.post("/api/auth/change-password", { current_password: temp, new_password: `${username}-own-secret` })).status).toBe(200);
  return { client: cl, temp, id: r.json.id as string };
}

describe("permission model", () => {
  it("has seven default roles and the owner can never be reduced", () => {
    expect(ROLES).toEqual(["owner", "admin", "billing", "purchase", "accountant", "inventory", "auditor"]);
    expect(effectivePermissions("owner", [{ permission: "sales.view", allowed: 0 }])).toContain("sales.view");
    expect(effectivePermissions("billing", [{ permission: "roles.manage", allowed: 1 }])).not.toContain("roles.manage");
    expect(effectivePermissions("billing", [{ permission: "purchase.view", allowed: 1 }])).toContain("purchase.view");
    expect(defaultPermissions("auditor").some((p) => /\.(create|post|void|write|manage|adjust|transfer)$/.test(p))).toBe(false);
  });
});

describe("roles, branches and approvals through the API", () => {
  let W: World;
  let blr: string, mys: string;
  let whBlr: string, whMys: string;
  let cust: string, supp: string;
  let billing: Client, billingMys: Client, purchase: Client, auditor: Client, inventory: Client;
  let blrInvoice: string, mysInvoice: string;

  beforeAll(async () => {
    W = await world();
    const b1 = await W.owner.post(W.c("/settings/branches"), { name: "Bengaluru", code: "BLR", invoice_prefix: "BLR" });
    const b2 = await W.owner.post(W.c("/settings/branches"), { name: "Mysuru", code: "MYS" });
    expect(b1.status).toBe(201);
    blr = b1.json.id; mys = b2.json.id;
    whBlr = (await W.owner.post(W.c("/items/warehouses"), { name: "BLR store", code: "WB", branch_id: blr })).json.id;
    whMys = (await W.owner.post(W.c("/items/warehouses"), { name: "MYS store", code: "WM", branch_id: mys })).json.id;
    cust = await contact(W, "customer");
    supp = await contact(W, "supplier");
    billing = (await staff(W, "bill.blr", "billing", { all_branches: false, branch_ids: [blr] })).client;
    billingMys = (await staff(W, "bill.mys", "billing", { all_branches: false, branch_ids: [mys] })).client;
    purchase = (await staff(W, "buyer", "purchase")).client;
    auditor = (await staff(W, "auditor1", "auditor")).client;
    inventory = (await staff(W, "store1", "inventory", { all_branches: false, branch_ids: [blr] })).client;
  });

  it("gives every new user a different random one-time password", async () => {
    const a = await W.owner.post(`/api/orgs/${W.orgId}/users`, { name: "A", username: "temp.a", role: "viewer" });
    const b = await W.owner.post(`/api/orgs/${W.orgId}/users`, { name: "B", username: "temp.b", role: "viewer" });
    expect(a.json.temporary_password).toMatch(/^[A-Za-z2-9]{5}-[A-Za-z2-9]{5}-[A-Za-z2-9]{5}$/);
    expect(a.json.temporary_password).not.toBe(b.json.temporary_password);
    const reset = await W.owner.post(`/api/orgs/${W.orgId}/members/${a.json.id}/temporary-password`);
    expect(reset.status).toBe(200);
    expect(reset.json.temporary_password).not.toBe(a.json.temporary_password);
    // Billing staff cannot create users.
    expect((await billing.post(`/api/orgs/${W.orgId}/users`, { name: "X", username: "sneaky", role: "admin" })).status).toBe(403);
  });

  it("settings report the member's effective permissions and branch scope", async () => {
    const s = (await billing.get(W.c("/settings"))).json;
    expect(s.permissions).toContain("sales.create");
    expect(s.permissions).not.toContain("purchase.view");
    expect(s.branch_scope).toEqual({ all: false, ids: [blr] });
  });

  it("billing staff create invoices in their own branch only, numbered by branch", async () => {
    const r = await billing.post(W.c("/documents"), { doc_type: "invoice", contact_id: cust, issue_date: "2026-05-05", lines: [line("Tea", "2", "100.00")] });
    expect(r.status).toBe(201);
    blrInvoice = r.json.id;
    const doc = (await billing.get(W.c(`/documents/${blrInvoice}`))).json.document;
    expect(doc.branch_id).toBe(blr); // defaulted to the member's branch
    const issued = await billing.post(W.c(`/documents/${blrInvoice}/issue`));
    expect(issued.status).toBe(200);
    expect(issued.json.number).toMatch(/^BLR-INV-/);
    const other = await billing.post(W.c("/documents"), { doc_type: "invoice", contact_id: cust, issue_date: "2026-05-05", branch_id: mys, lines: [line("Tea", "1", "100.00")] });
    expect(other.status).toBe(403);
    const m = await billingMys.post(W.c("/documents"), { doc_type: "invoice", contact_id: cust, issue_date: "2026-05-05", lines: [line("Coffee", "1", "80.00")] });
    mysInvoice = m.json.id;
    expect((await billingMys.post(W.c(`/documents/${mysInvoice}/issue`))).json.number).toMatch(/^INV-/);
  });

  it("isolates branches: lists, details and reports exclude other branches", async () => {
    const list = (await billing.get(W.c("/documents?type=invoice"))).json.documents.map((d: any) => d.id);
    expect(list).toContain(blrInvoice);
    expect(list).not.toContain(mysInvoice);
    expect((await billing.get(W.c(`/documents/${mysInvoice}`))).status).toBe(404);
    expect((await billing.post(W.c(`/documents/${mysInvoice}/void`), { reason: "x" })).status).toBe(404);
    // The owner sees both.
    const all = (await W.owner.get(W.c("/documents?type=invoice"))).json.documents.map((d: any) => d.id);
    expect(all).toEqual(expect.arrayContaining([blrInvoice, mysInvoice]));
  });

  it("billing staff cannot see purchases, journals or purchase costs", async () => {
    expect((await billing.get(W.c("/documents?type=bill"))).status).toBe(403);
    expect((await billing.get(W.c("/journals"))).status).toBe(403);
    const item = await W.owner.post(W.c("/items"), { kind: "goods", name: "Biscuits", sale_price: "30", purchase_price: "18", barcode: "8901234567890" });
    expect(item.status).toBe(201);
    expect(item.json.code).toMatch(/^P\d{6}$/);
    const seen = (await billing.get(W.c(`/items/${item.json.id}`))).json.item;
    expect(seen.sale_price).toBe(3000);
    expect(seen.purchase_price).toBeUndefined();
    expect((await W.owner.get(W.c(`/items/${item.json.id}`))).json.item.purchase_price).toBe(1800);
  });

  it("scanner lookup finds a product by QR payload, barcode, code or SKU, without prices in the QR", async () => {
    const item = await W.owner.post(W.c("/items"), { kind: "goods", name: "Rice 5kg", sku: "RICE5", sale_price: "450", barcode: "8900000000017" });
    const code = item.json.code;
    for (const v of [`LF1|P|${code}`, "8900000000017", code.toLowerCase(), "RICE5"]) {
      const r = await billing.get(W.c(`/items/lookup?code=${encodeURIComponent(v)}`));
      expect(r.status).toBe(200);
      expect(r.json.item.id).toBe(item.json.id);
    }
    expect((await billing.get(W.c("/items/lookup?code=NOPE"))).status).toBe(404);
    expect((await W.owner.post(W.c("/items"), { kind: "goods", name: "Dup", barcode: "8900000000017" })).status).toBe(409);
  });

  it("enforces the billing discount limit unless the user may give any discount", async () => {
    expect((await W.owner.patch(W.c("/settings"), { name: "Acme Traders", state_code: "29", billing_discount_limit: "10" })).status).toBe(200);
    const big = await billing.post(W.c("/documents"), { doc_type: "invoice", contact_id: cust, issue_date: "2026-05-06", lines: [line("Tea", "1", "100.00", { discount_percent: "15" })] });
    expect(big.status).toBe(403);
    expect(big.json.error.code).toBe("DISCOUNT_LIMIT");
    expect((await billing.post(W.c("/documents"), { doc_type: "invoice", contact_id: cust, issue_date: "2026-05-06", lines: [line("Tea", "1", "100.00", { discount_percent: "10" })] })).status).toBe(201);
    expect((await W.owner.post(W.c("/documents"), { doc_type: "invoice", contact_id: cust, issue_date: "2026-05-06", lines: [line("Tea", "1", "100.00", { discount_percent: "15" })] })).status).toBe(201);
  });

  it("purchases above the approval limit need approval by someone else", async () => {
    expect((await W.owner.patch(W.c("/settings"), { name: "Acme Traders", state_code: "29", purchase_approval_limit: "5000" })).status).toBe(200);
    const small = await purchase.post(W.c("/documents"), { doc_type: "bill", contact_id: supp, issue_date: "2026-05-06", lines: [line("Sugar", "1", "1000.00")] });
    expect((await purchase.post(W.c(`/documents/${small.json.id}/issue`))).status).toBe(200);
    const big = await purchase.post(W.c("/documents"), { doc_type: "bill", contact_id: supp, issue_date: "2026-05-06", lines: [line("Oil", "10", "1000.00")] });
    const blocked = await purchase.post(W.c(`/documents/${big.json.id}/issue`));
    expect(blocked.status).toBe(403);
    expect(blocked.json.error.code).toBe("APPROVAL_REQUIRED");
    expect((await purchase.post(W.c(`/documents/${big.json.id}/request-approval`), {})).status).toBe(200);
    expect((await purchase.post(W.c(`/documents/${big.json.id}/approve`), {})).status).toBe(403);
    expect((await W.owner.post(W.c(`/documents/${big.json.id}/approve`), {})).status).toBe(200);
    expect((await purchase.post(W.c(`/documents/${big.json.id}/issue`))).status).toBe(200);
  });

  it("auditors read everything but change nothing", async () => {
    expect((await auditor.get(W.c("/documents?type=invoice"))).status).toBe(200);
    expect((await auditor.get(W.c("/reports/trial-balance"))).status).toBe(200);
    expect((await auditor.get(W.c("/settings/audit-log"))).status).toBe(200);
    expect((await auditor.post(W.c("/documents"), { doc_type: "invoice", contact_id: cust, issue_date: "2026-05-06", lines: [line("x", "1", "1")] })).status).toBe(403);
    expect((await auditor.post(W.c("/contacts"), { kind: "customer", name: "Nope" })).status).toBe(403);
    expect((await auditor.post(W.c("/items"), { kind: "service", name: "Nope" })).status).toBe(403);
    expect((await auditor.post(W.c("/journals"), { entry_date: "2026-05-06", lines: [] })).status).toBe(403);
  });

  it("inventory staff transfer stock from their branch, and the transfer records both branches", async () => {
    const item = await W.owner.post(W.c("/items"), { kind: "goods", name: "Soap", sale_price: "40", purchase_price: "25", track_inventory: true });
    expect((await W.owner.post(W.c("/items/adjustments"), { item_id: item.json.id, warehouse_id: whBlr, date: "2026-05-01", quantity: "10", unit_cost: "25", reason: "opening" })).status).toBe(201);
    expect((await inventory.post(W.c("/items/adjustments"), { item_id: item.json.id, warehouse_id: whMys, date: "2026-05-01", quantity: "-1" })).status).toBe(404);
    const t = await inventory.post(W.c("/items/transfers"), { item_id: item.json.id, from_warehouse_id: whBlr, to_warehouse_id: whMys, date: "2026-05-02", quantity: "4" });
    expect(t.status).toBe(201);
    const back = await inventory.post(W.c("/items/transfers"), { item_id: item.json.id, from_warehouse_id: whMys, to_warehouse_id: whBlr, date: "2026-05-02", quantity: "1" });
    expect(back.status).toBe(404);
    const list = (await W.owner.get(W.c("/items/transfers/list"))).json.transfers;
    expect(list[0]).toMatchObject({ from_branch_id: blr, to_branch_id: mys, qty_milli: 4000, from_branch: "Bengaluru", to_branch: "Mysuru" });
    // Inventory staff cannot post invoices or see costs.
    expect((await inventory.post(W.c("/documents"), { doc_type: "invoice", contact_id: cust, issue_date: "2026-05-06", lines: [line("x", "1", "1")] })).status).toBe(403);
    expect((await inventory.get(W.c("/items/transfers/list"))).json.transfers[0].value).toBeUndefined();
  });

  it("owner customises a role and the change applies on the next request", async () => {
    expect((await billing.get(W.c("/documents?type=bill"))).status).toBe(403);
    const r = await W.owner.put(`/api/orgs/${W.orgId}/roles/billing`, { permissions: [...defaultPermissions("billing"), "purchase.view"] });
    expect(r.status).toBe(200);
    expect((await billing.get(W.c("/documents?type=bill"))).status).toBe(200);
    const roles = (await W.owner.get(`/api/orgs/${W.orgId}/roles`)).json.roles;
    expect(roles.find((x: any) => x.role === "billing").customised).toBe(true);
    expect((await W.owner.del(`/api/orgs/${W.orgId}/roles/billing`)).status).toBe(200);
    expect((await billing.get(W.c("/documents?type=bill"))).status).toBe(403);
    // Only the owner customises roles; the owner role itself cannot be customised.
    expect((await W.owner.put(`/api/orgs/${W.orgId}/roles/owner`, { permissions: [] })).status).toBe(400);
  });

  it("daybook lists who created, posted, approved and cancelled each transaction, scoped by permission", async () => {
    const own = (await W.owner.get(W.c("/daybook?from=2026-05-01&to=2026-05-31"))).json.entries;
    const inv = own.find((e: any) => e.id === blrInvoice);
    expect(inv).toMatchObject({ entity_type: "document", type: "invoice", branch_name: "Bengaluru", created_by_name: "bill.blr", posted_by_name: "bill.blr" });
    const bill = own.find((e: any) => e.type === "bill" && e.approved_by_name);
    expect(bill.approved_by_name).toBe("Owner");
    expect(own.some((e: any) => e.type === "bill")).toBe(true);
    // Billing staff have no daybook by default; once granted, they see only sales of their branch.
    expect((await billing.get(W.c("/daybook"))).status).toBe(403);
    await W.owner.put(`/api/orgs/${W.orgId}/roles/billing`, { permissions: [...defaultPermissions("billing"), "daybook.read"] });
    const mine = (await billing.get(W.c("/daybook?from=2026-05-01&to=2026-05-31"))).json.entries;
    expect(mine.some((e: any) => e.id === blrInvoice)).toBe(true);
    expect(mine.every((e: any) => ["invoice", "quote", "sales_order", "credit_note", "receipt"].includes(e.type))).toBe(true);
    expect(mine.some((e: any) => e.id === mysInvoice)).toBe(false);
    await W.owner.del(`/api/orgs/${W.orgId}/roles/billing`);
    // Inventory staff have no daybook access.
    expect((await inventory.get(W.c("/daybook"))).status).toBe(403);
  });

  it("record history shows every action with previous and new values", async () => {
    const draft = await W.owner.post(W.c("/documents"), { doc_type: "invoice", contact_id: cust, issue_date: "2026-05-07", lines: [line("Tea", "1", "100.00")] });
    await W.owner.put(W.c(`/documents/${draft.json.id}`), { doc_type: "invoice", contact_id: cust, issue_date: "2026-05-08", lines: [line("Tea", "2", "100.00")] });
    await W.owner.post(W.c(`/documents/${draft.json.id}/issue`));
    await W.owner.post(W.c(`/documents/${draft.json.id}/void`), { date: "2026-05-09", reason: "Wrong customer" });
    const h = (await W.owner.get(W.c(`/daybook/history/document/${draft.json.id}`))).json.events;
    expect(h.map((e: any) => e.action)).toEqual(["invoice.create", "invoice.update", "invoice.post", "invoice.void"]);
    expect(h[1].details.changes.issue_date).toEqual({ from: "2026-05-07", to: "2026-05-08" });
    expect(h[1].details.changes.total).toEqual({ from: 10000, to: 20000 });
    expect(h[0].user_name).toBe("Owner");
    // Other branches' records have no visible history.
    expect((await billing.get(W.c(`/daybook/history/document/${mysInvoice}`))).status).toBe(404);
  });
});
