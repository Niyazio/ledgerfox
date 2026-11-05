import { describe, expect, it } from "vitest";
import { world, contact, Client } from "./helpers";

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

describe("product page", () => {
  it("brings stock, batches, sales, purchases, payments (cash / bank), outstanding and profit together", async () => {
    const W = await world();
    const supp = await contact(W, "supplier", { name: "Pharma Distributors" });
    const cust = await contact(W, "customer", { name: "City Clinic" });
    const item = (await W.owner.post(W.c("/items"), { kind: "goods", name: "Syrup 100ml", sale_price: "150", purchase_price: "100", track_inventory: true, track_batches: true })).json.id;
    const issue = async (doc: any) => {
      const d = await W.owner.post(W.c("/documents"), doc);
      expect(d.status, JSON.stringify(d.json)).toBe(201);
      expect((await W.owner.post(W.c(`/documents/${d.json.id}/issue`))).status).toBe(200);
      return d.json.id as string;
    };
    // Bought 10 at 100 in batch B1 (expires 2027-12-31), paid in full from the bank.
    const bill = await issue({ doc_type: "bill", contact_id: supp, issue_date: day(-5), lines: [{ item_id: item, description: "Syrup", quantity: "10", unit_price: "100", batch_no: "B1", expiry_date: "2027-12-31" }] });
    await W.owner.post(W.c("/payments"), { direction: "out", contact_id: supp, payment_date: day(-4), account_id: W.acc.BANK, amount: "1000", allocations: [{ document_id: bill, amount: "1000" }] });
    // Sold 4 at 150; the customer paid 300 in cash and 100 by bank, 200 is still due.
    const inv = await issue({ doc_type: "invoice", contact_id: cust, issue_date: day(-2), lines: [{ item_id: item, description: "Syrup", quantity: "4", unit_price: "150" }] });
    await W.owner.post(W.c("/payments"), { direction: "in", contact_id: cust, payment_date: day(-1), account_id: W.acc.CASH, amount: "300", allocations: [{ document_id: inv, amount: "300" }] });
    await W.owner.post(W.c("/payments"), { direction: "in", contact_id: cust, payment_date: day(-1), account_id: W.acc.BANK, amount: "100", allocations: [{ document_id: inv, amount: "100" }] });

    const r = await W.owner.get(W.c(`/items/${item}/insights`));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const p = r.json;
    expect(p.stock).toMatchObject({ qty_milli: 6000, value: 60_000, avg_cost: 10_000 });
    expect(p.warehouses[0]).toMatchObject({ qty_milli: 6000, sold_milli: 4000, bought_milli: 10_000 });
    expect(p.batches[0]).toMatchObject({ batch_no: "B1", expiry_date: "2027-12-31", qty_milli: 6000, source_type: "bill", source_id: bill });
    expect(p.sales.summary).toMatchObject({ qty_milli: 4000, revenue: 60_000, cost: 40_000, profit: 20_000, margin_bp: 3333, invoices: 1, customers: 1 });
    expect(p.sales.rows[0]).toMatchObject({ document_id: inv, contact: "City Clinic", qty_milli: 4000, cost: 40_000 });
    expect(p.sales.rows[0].paid_via).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "cash", amount: 30_000 }), expect.objectContaining({ kind: "bank", amount: 10_000 })]));
    expect(p.sales.payments).toMatchObject({ documents: 1, total: 60_000, settled: 40_000, outstanding: 20_000, cash: 30_000, bank: 10_000 });
    expect(p.sales.top_customers[0]).toMatchObject({ name: "City Clinic", revenue: 60_000 });
    expect(p.sales.monthly.reduce((s: number, m: any) => s + m.revenue - m.cost, 0)).toBe(20_000);
    expect(p.purchases.payments).toMatchObject({ total: 100_000, settled: 100_000, outstanding: 0, bank: 100_000 });
    expect(p.purchases.suppliers[0]).toMatchObject({ name: "Pharma Distributors", qty_milli: 10_000, spent: 100_000 });

    // The customer's page: products bought, cash and bank received, outstanding and the profit on their invoices.
    const cu = (await W.owner.get(W.c(`/contacts/${cust}/insights`))).json;
    expect(cu.sales.summary).toMatchObject({ documents: 1, amount: 60_000, settled: 40_000, cash: 30_000, bank: 10_000, outstanding: 20_000, cost: 40_000, profit: 20_000 });
    expect(cu.sales.products[0]).toMatchObject({ item_id: item, name: "Syrup 100ml", qty_milli: 4000, amount: 60_000, cost: 40_000 });
    expect(cu.payments.map((x: any) => x.subtype).sort()).toEqual(["bank", "cash"]);
    expect(cu.purchases).toBeNull();
    // The supplier's page: what they supplied, paid by bank, nothing outstanding.
    const su = (await W.owner.get(W.c(`/contacts/${supp}/insights`))).json;
    expect(su.purchases.summary).toMatchObject({ amount: 100_000, settled: 100_000, bank: 100_000, outstanding: 0 });
    expect(su.purchases.products[0]).toMatchObject({ name: "Syrup 100ml", qty_milli: 10_000 });
    expect(su.sales).toBeNull();
    // A date range before anything happened shows nothing.
    expect((await W.owner.get(W.c(`/contacts/${cust}/insights?to=2020-01-01`))).json.sales.summary.amount).toBe(0);

    // A counter cashier sees the product, sales and stock, but no costs, profit or purchases.
    const u = await W.owner.post(`/api/orgs/${W.orgId}/users`, { name: "Cashier", username: "p360.cashier", role: "billing" });
    const cl = new Client(W.env);
    await cl.post("/api/auth/login", { login: "p360.cashier", password: u.json.temporary_password });
    await cl.post("/api/auth/change-password", { current_password: u.json.temporary_password, new_password: "p360 cashier pass 1" });
    const q = (await cl.get(W.c(`/items/${item}/insights`))).json;
    expect(q.stock.qty_milli).toBe(6000);
    expect(q.stock.value).toBeUndefined();
    expect(q.sales.summary.profit).toBeUndefined();
    expect(q.sales.rows[0].cost).toBeUndefined();
    expect(q.purchases).toBeNull();
    expect(q.item.purchase_price).toBeUndefined();
  });
});
