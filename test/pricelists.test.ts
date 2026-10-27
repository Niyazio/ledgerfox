import { describe, expect, it } from "vitest";
import { Client, world, contact } from "./helpers";
import { listPrice } from "../src/shared/pricing";

describe("price lists", () => {
  it("picks the highest quantity break, else the list percentage, else the selling price", () => {
    const list = { id: "w", name: "Wholesale", adjust_bp: -1000 };
    const breaks = [{ item_id: "a", min_qty_milli: 0, price: 9000 }, { item_id: "a", min_qty_milli: 10_000, price: 8500 }, { item_id: "c", min_qty_milli: 5000, price: 100 }];
    expect(listPrice(10_000, null, breaks, "a", 1000)).toBe(10_000);
    expect(listPrice(10_000, list, breaks, "a", 9999)).toBe(9000);
    expect(listPrice(10_000, list, breaks, "a", 10_000)).toBe(8500);
    expect(listPrice(5000, list, breaks, "b", 1000)).toBe(4500); // not named: -10 %
    expect(listPrice(5000, list, breaks, "c", 1000)).toBe(4500); // below its only break
    expect(listPrice(333, { ...list, adjust_bp: 500 }, [], "x", 1000)).toBe(350); // +5 %, rounded to the paisa
  });

  it("links customers, sets counter rates for staff and protects lists in use", async () => {
    const W = await world();
    const soap = (await W.owner.post(W.c("/items"), { kind: "goods", name: "Soap", sale_price: "100" })).json.id;
    const oil = (await W.owner.post(W.c("/items"), { kind: "goods", name: "Oil", sale_price: "50" })).json.id;
    const list = await W.owner.post(W.c("/price-lists"), { name: "Wholesale", adjust_percent: "-10" });
    expect(list.status).toBe(201);
    expect((await W.owner.post(W.c("/price-lists"), { name: "Wholesale" })).status).toBe(409);
    expect((await W.owner.put(W.c(`/price-lists/${list.json.id}/prices`), { rows: [{ item_id: soap, price: "90" }, { item_id: soap, min_qty: "0", price: "80" }] })).status).toBe(400);
    expect((await W.owner.put(W.c(`/price-lists/${list.json.id}/prices`), { rows: [{ item_id: soap, price: "90" }, { item_id: soap, min_qty: "10", price: "85" }] })).json.rows).toBe(2);

    const shop = await contact(W, "customer", { name: "Shop", price_list_id: list.json.id });
    expect((await W.owner.post(W.c("/contacts"), { kind: "customer", name: "Bad", price_list_id: "nope" })).status).toBe(400);
    const p = (await W.owner.get(W.c(`/price-lists/for-contact/${shop}`))).json;
    expect(p.list).toMatchObject({ name: "Wholesale", adjust_bp: -1000 });
    expect(p.breaks).toHaveLength(2);
    // Editing a contact without sending the list keeps it.
    await W.owner.put(W.c(`/contacts/${shop}`), { kind: "customer", name: "Shop & Co", payment_terms_days: 30 });
    expect((await W.owner.get(W.c(`/price-lists/for-contact/${shop}`))).json.list?.name).toBe("Wholesale");

    const u = await W.owner.post(`/api/orgs/${W.orgId}/users`, { name: "Cashier", username: "pl.cashier", role: "billing" });
    const cl = new Client(W.env);
    await cl.post("/api/auth/login", { login: "pl.cashier", password: u.json.temporary_password });
    await cl.post("/api/auth/change-password", { current_password: u.json.temporary_password, new_password: "price list pass 1" });
    // 12 soap at the 10+ break (85) and 2 oil at 50 - 10 % = 45: 1,020 + 90 = 1,110.
    const sale = await cl.post(W.c("/pos/sale"), { contact_id: shop, lines: [{ item_id: soap, quantity: "12" }, { item_id: oil, quantity: "2" }], payments: [{ mode: "cash", amount: "1110" }] });
    expect(sale.status, JSON.stringify(sale.json)).toBe(201);
    expect(sale.json.total).toBe(111_000);
    // Staff may send the list rate, not their own; walk-in customers pay the selling price.
    expect((await cl.post(W.c("/pos/sale"), { contact_id: shop, lines: [{ item_id: soap, quantity: "1", unit_price: "90" }], payments: [{ mode: "cash", amount: "90" }] })).status).toBe(201);
    expect((await cl.post(W.c("/pos/sale"), { contact_id: shop, lines: [{ item_id: soap, quantity: "1", unit_price: "80" }], payments: [] })).json.error.code).toBe("PRICE_LOCKED");
    expect((await cl.post(W.c("/pos/sale"), { lines: [{ item_id: soap, quantity: "1", unit_price: "90" }], payments: [{ mode: "cash", amount: "90" }] })).json.error.code).toBe("PRICE_LOCKED");
    // A switched-off list stops applying; a list in use cannot be deleted.
    await W.owner.put(W.c(`/price-lists/${list.json.id}`), { name: "Wholesale", adjust_percent: "-10", is_active: false });
    expect((await W.owner.get(W.c(`/price-lists/for-contact/${shop}`))).json.list).toBeNull();
    expect((await W.owner.del(W.c(`/price-lists/${list.json.id}`))).status).toBe(409);
    expect((await W.owner.get(W.c("/price-lists"))).json.price_lists[0]).toMatchObject({ name: "Wholesale", prices: 2, customers: 1, is_active: 0 });
    // Billing staff cannot edit lists.
    expect((await cl.post(W.c("/price-lists"), { name: "Mine" })).status).toBe(403);
  });
});
