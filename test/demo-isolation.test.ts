import { describe, expect, it } from "vitest";
import { world, contact } from "./helpers";

describe("demo company is separate from the real one", () => {
  it("loading, using and deleting a demo leaves the real company's data exactly as it was", async () => {
    const W = await world();
    // Real company: customer, product, posted invoice, receipt.
    const cust = await contact(W, "customer", { name: "Real Customer" });
    await W.owner.post(W.c("/items"), { kind: "goods", name: "Real Product", sale_price: "50" });
    const inv = await W.owner.post(W.c("/documents"), { doc_type: "invoice", contact_id: cust, issue_date: "2026-05-05", lines: [{ description: "Work", quantity: "2", unit_price: "500" }] });
    expect((await W.owner.post(W.c(`/documents/${inv.json.id}/issue`))).status).toBe(200);
    await W.owner.post(W.c("/payments"), { direction: "in", contact_id: cust, payment_date: "2026-05-06", account_id: W.acc.BANK, amount: "400", allocations: [{ document_id: inv.json.id, amount: "400" }] });
    const snapshot = async () => ({
      tb: (await W.owner.get(W.c("/reports/trial-balance?from=2026-04-01&to=2027-03-31"))).json.rows.map((r: any) => [r.code, r.closing]),
      contacts: (await W.owner.get(W.c("/contacts?limit=500"))).json.contacts.map((c: any) => c.name).sort(),
      items: (await W.owner.get(W.c("/items?limit=500"))).json.items.map((i: any) => i.name).sort(),
      docs: (await W.owner.get(W.c("/documents?type=invoice"))).json.documents.map((d: any) => [d.number, d.total, d.amount_settled]),
    });
    const before = await snapshot();

    // Demo company in the same organisation, with its own data.
    const demo = (await W.owner.post(`/api/orgs/${W.orgId}/companies`, { name: "Demo", country: "IN", base_currency: "INR", fiscal_year_start_month: 4, state_code: "29", business_type: "retail", is_demo: true })).json.company_id;
    const d = (p: string) => `/api/c/${demo}${p}`;
    const dc = (await W.owner.post(d("/contacts"), { kind: "customer", name: "Demo Customer", state_code: "29" })).json.id;
    const di = await W.owner.post(d("/documents"), { doc_type: "invoice", contact_id: dc, issue_date: "2026-05-07", lines: [{ description: "Demo", quantity: "1", unit_price: "999" }] });
    expect((await W.owner.post(d(`/documents/${di.json.id}/issue`))).status).toBe(200);
    // Work continues in the real company while the demo exists.
    const later = await W.owner.post(W.c("/documents"), { doc_type: "invoice", contact_id: cust, issue_date: "2026-05-08", lines: [{ description: "More", quantity: "1", unit_price: "250" }] });
    expect((await W.owner.post(W.c(`/documents/${later.json.id}/issue`))).status).toBe(200);
    const withLater = await snapshot();
    expect(withLater.contacts).toEqual(before.contacts); // no demo customers leak in
    expect(withLater.docs).toHaveLength(2);

    expect((await W.owner.del(`/api/orgs/${W.orgId}/companies/${demo}`)).status).toBe(200);
    expect(await snapshot()).toEqual(withLater);
    expect((await W.owner.get(d("/settings"))).status).toBe(404);
  });
});
