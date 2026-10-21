import { describe, expect, it } from "vitest";
import { world, contact, Client } from "./helpers";

const line = (unit_price: string) => [{ description: "Goods", quantity: "1", unit_price }];

describe("proforma invoices and delivery challans", () => {
  it("are numbered in their own series, listed separately and convert to an invoice", async () => {
    const W = await world();
    const cust = await contact(W, "customer");
    const pf = await W.owner.post(W.c("/documents"), { doc_type: "proforma", contact_id: cust, issue_date: "2026-05-10", lines: line("1000") });
    expect(pf.status).toBe(201);
    expect((await W.owner.post(W.c(`/documents/${pf.json.id}/issue`))).json.number).toBe("PRF-00001");
    const q = await W.owner.post(W.c("/documents"), { doc_type: "quote", contact_id: cust, issue_date: "2026-05-10", lines: line("50") });
    expect((await W.owner.post(W.c(`/documents/${q.json.id}/issue`))).json.number).toBe("QT-00001");
    const dc = await W.owner.post(W.c("/documents"), { doc_type: "delivery_challan", contact_id: cust, issue_date: "2026-05-10", lines: line("700") });
    expect((await W.owner.post(W.c(`/documents/${dc.json.id}/issue`))).json.number).toBe("DC-00001");
    expect((await W.owner.get(W.c("/documents?type=proforma"))).json.documents.map((d: any) => d.number)).toEqual(["PRF-00001"]);
    expect((await W.owner.get(W.c("/documents?type=quote"))).json.documents.map((d: any) => d.number)).toEqual(["QT-00001"]);
    expect((await W.owner.get(W.c(`/documents/${dc.json.id}`))).json.document).toMatchObject({ doc_type: "sales_order", variant: "delivery_challan" });
    // No ledger effect until invoiced.
    expect((await W.owner.get(W.c("/journals"))).json.entries ?? []).toHaveLength(0);
    const inv = await W.owner.post(W.c(`/documents/${pf.json.id}/convert`), { to: "invoice" });
    expect(inv.status).toBe(201);
    expect((await W.owner.get(W.c(`/documents/${inv.json.id}`))).json.document).toMatchObject({ doc_type: "invoice", variant: null, total: 100_000 });
  });
});

describe("credit limit", () => {
  it("warns on the draft, blocks issue for billing staff and lets a manager confirm", async () => {
    const W = await world();
    const cust = await contact(W, "customer", { credit_limit: "1500" });
    const first = await W.owner.post(W.c("/documents"), { doc_type: "invoice", contact_id: cust, issue_date: "2026-05-10", lines: line("1000") });
    expect(first.json.warnings).toEqual([]);
    await W.owner.post(W.c(`/documents/${first.json.id}/issue`));
    const u = await W.owner.post(`/api/orgs/${W.orgId}/users`, { name: "Bill", username: "credit.bill", role: "billing" });
    const bill = new Client(W.env);
    await bill.post("/api/auth/login", { login: "credit.bill", password: u.json.temporary_password });
    await bill.post("/api/auth/change-password", { current_password: u.json.temporary_password, new_password: "credit bill pass 1" });
    const second = await bill.post(W.c("/documents"), { doc_type: "invoice", contact_id: cust, issue_date: "2026-05-11", lines: line("800") });
    expect(second.json.warnings[0]).toMatch(/credit limit of ₹1,500.00; open balance ₹1,000.00 plus this invoice makes ₹1,800.00/);
    const blocked = await bill.post(W.c(`/documents/${second.json.id}/issue`), { override_credit_limit: true });
    expect(blocked.status).toBe(409);
    expect(blocked.json.error.code).toBe("CREDIT_LIMIT");
    expect((await W.owner.post(W.c(`/documents/${second.json.id}/issue`))).status).toBe(409);
    expect((await W.owner.post(W.c(`/documents/${second.json.id}/issue`), { override_credit_limit: true })).status).toBe(200);
    const hist = (await W.owner.get(W.c(`/daybook/history/document/${second.json.id}`))).json.events.map((e: any) => e.action);
    expect(hist).toContain("invoice.credit_override");
    // After a receipt, a new invoice within the limit issues normally.
    await W.owner.post(W.c("/payments"), { direction: "in", contact_id: cust, payment_date: "2026-05-12", account_id: W.acc.BANK, amount: "1800", allocations: [{ document_id: first.json.id, amount: "1000" }, { document_id: second.json.id, amount: "800" }] });
    const third = await bill.post(W.c("/documents"), { doc_type: "invoice", contact_id: cust, issue_date: "2026-05-13", lines: line("1400") });
    expect((await bill.post(W.c(`/documents/${third.json.id}/issue`))).status).toBe(200);
  });
});
