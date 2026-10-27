import { describe, expect, it } from "vitest";
import { Client, world, contact } from "./helpers";

describe("manufacturing", () => {
  it("consumes components at average cost, adds labour, keeps stock and ledger in step, and voids cleanly", async () => {
    const W = await world();
    const item = async (name: string, extra: Record<string, unknown> = {}) => (await W.owner.post(W.c("/items"), { kind: "goods", name, sale_price: "60", track_inventory: true, unit: "kg", ...extra })).json.id as string;
    const flour = await item("Flour"), sugar = await item("Sugar"), bread = await item("Bread", { unit: "nos" });
    const service = (await W.owner.post(W.c("/items"), { kind: "service", name: "Baking" })).json.id;
    const wh = (await W.owner.get(W.c("/settings"))).json.warehouses[0].id;
    const opening = (item_id: string, quantity: string, unit_cost: string) => W.owner.post(W.c("/items/adjustments"), { item_id, warehouse_id: wh, date: "2026-05-01", quantity, unit_cost, reason: "opening" });
    expect((await opening(flour, "100", "40")).status).toBe(201);
    expect((await opening(sugar, "20", "50")).status).toBe(201);

    // 10 loaves need 5 kg flour + 1 kg sugar.
    const bad = await W.owner.post(W.c("/production/boms"), { item_id: bread, name: "Bread", output_quantity: "10", lines: [{ item_id: bread, quantity: "1" }] });
    expect(bad.json.error.message).toMatch(/cannot consume itself/);
    expect((await W.owner.post(W.c("/production/boms"), { item_id: bread, name: "Bread", lines: [{ item_id: service, quantity: "1" }] })).json.error.message).toMatch(/stock item/);
    const bom = await W.owner.post(W.c("/production/boms"), { item_id: bread, name: "Bread (10)", output_quantity: "10", lines: [{ item_id: flour, quantity: "5" }, { item_id: sugar, quantity: "1" }] });
    expect(bom.status).toBe(201);
    const plan = (await W.owner.get(W.c(`/production/boms/${bom.json.id}/plan?qty=20&warehouse_id=${wh}`))).json;
    expect(plan.components.map((x: any) => [x.required_milli, x.on_hand_milli, x.short_milli])).toEqual([[10_000, 100_000, 0], [2_000, 20_000, 0]]);
    expect(plan.estimated_material_cost).toBe(50_000); // 10 × 40 + 2 × 50

    // Make 20 with ₹150 of labour paid in cash: material 500, total 650, ₹32.50 a loaf.
    const made = await W.owner.post(W.c("/production/orders"), { bom_id: bom.json.id, quantity: "20", date: "2026-05-05", warehouse_id: wh, extra_cost: "150", extra_account_id: W.acc.CASH });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    expect(made.json).toMatchObject({ number: "PRD-00001", material_cost: 50_000, extra_cost: 15_000, total_cost: 65_000, unit_cost: 3_250 });
    const stock = async () => Object.fromEntries((await W.owner.get(W.c("/items/stock"))).json.stock.map((s: any) => [s.name, [s.qty_milli / 1000, s.value]]));
    expect(await stock()).toMatchObject({ Flour: [90, 360_000], Sugar: [18, 90_000], Bread: [20, 65_000] });
    const valuation = async () => (await W.owner.get(W.c("/reports/inventory-valuation?as_of=2026-12-31"))).json.reconciles;
    expect(await valuation()).toBe(true);
    const detail = (await W.owner.get(W.c(`/production/orders/${made.json.id}`))).json;
    expect(detail.lines.map((l: any) => [l.name, l.qty_milli, l.value])).toEqual([["Flour", 10_000, 40_000], ["Sugar", 2_000, 10_000]]);
    expect(detail.order.journal_number).toMatch(/^JV-/);

    // Actual consumption may differ from the recipe; shortages are refused.
    const actual = await W.owner.post(W.c("/production/orders"), { bom_id: bom.json.id, quantity: "10", date: "2026-05-06", warehouse_id: wh, components: [{ item_id: flour, quantity: "5.5" }, { item_id: sugar, quantity: "1" }] });
    expect(actual.json).toMatchObject({ material_cost: 27_000, total_cost: 27_000 });
    expect((await W.owner.post(W.c("/production/orders"), { bom_id: bom.json.id, quantity: "1000", date: "2026-05-06", warehouse_id: wh })).json.error.code).toBe("INSUFFICIENT_STOCK");
    expect((await W.owner.post(W.c("/production/orders"), { bom_id: bom.json.id, quantity: "1", date: "2026-05-06", warehouse_id: wh, extra_cost: "10" })).status).toBe(400);

    // Voiding returns the components and removes the bread; the labour journal is reversed.
    expect((await W.owner.post(W.c(`/production/orders/${actual.json.id}/void`), { date: "2026-05-07", reason: "test" })).status).toBe(200);
    expect(await stock()).toMatchObject({ Flour: [90, 360_000], Sugar: [18, 90_000], Bread: [20, 65_000] });
    expect((await W.owner.post(W.c(`/production/orders/${actual.json.id}/void`), {})).status).toBe(409);
    // Once the bread is sold it cannot be un-made.
    const cust = await contact(W, "customer");
    const inv = await W.owner.post(W.c("/documents"), { doc_type: "invoice", contact_id: cust, issue_date: "2026-05-08", warehouse_id: wh, lines: [{ item_id: bread, description: "Bread", quantity: "15", unit_price: "60" }] });
    expect((await W.owner.post(W.c(`/documents/${inv.json.id}/issue`))).status).toBe(200);
    expect((await W.owner.post(W.c(`/production/orders/${made.json.id}/void`), { date: "2026-05-09" })).json.error.message).toMatch(/Only 5 of the 20 made/);
    expect(await valuation()).toBe(true);
    expect((await W.owner.get(W.c("/production/orders"))).json.orders.map((o: any) => [o.number, o.status])).toEqual([["PRD-00002", "void"], ["PRD-00001", "posted"]]);

    // Billing staff cannot record production.
    const u = await W.owner.post(`/api/orgs/${W.orgId}/users`, { name: "Cashier", username: "mfg.cashier", role: "billing" });
    const cl = new Client(W.env);
    await cl.post("/api/auth/login", { login: "mfg.cashier", password: u.json.temporary_password });
    await cl.post("/api/auth/change-password", { current_password: u.json.temporary_password, new_password: "mfg cashier pass 1" });
    expect((await cl.post(W.c("/production/orders"), { bom_id: bom.json.id, quantity: "1", date: "2026-05-06", warehouse_id: wh })).status).toBe(403);
  });

  it("needs a batch for batch-tracked products and takes components first-expiry-first-out", async () => {
    const W = await world();
    const wh = (await W.owner.get(W.c("/settings"))).json.warehouses[0].id;
    const syrupBase = (await W.owner.post(W.c("/items"), { kind: "goods", name: "Syrup base", track_inventory: true, track_batches: true })).json.id;
    const syrup = (await W.owner.post(W.c("/items"), { kind: "goods", name: "Cough syrup", track_inventory: true, track_batches: true })).json.id;
    const add = (batch_no: string, expiry_date: string) => W.owner.post(W.c("/items/adjustments"), { item_id: syrupBase, warehouse_id: wh, date: "2026-05-01", quantity: "5", unit_cost: "10", reason: "opening", batch_no, expiry_date });
    await add("LATE", "2028-01-31"); await add("SOON", "2027-01-31");
    const bom = (await W.owner.post(W.c("/production/boms"), { item_id: syrup, name: "Syrup", lines: [{ item_id: syrupBase, quantity: "1" }] })).json.id;
    expect((await W.owner.post(W.c("/production/orders"), { bom_id: bom, quantity: "6", date: "2026-05-02", warehouse_id: wh })).json.error.code).toBe("BATCH_REQUIRED");
    const ok = await W.owner.post(W.c("/production/orders"), { bom_id: bom, quantity: "6", date: "2026-05-02", warehouse_id: wh, batch_no: "cs-01", expiry_date: "2027-06-30" });
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
    const rep = (await W.owner.get(W.c("/items/batches/report"))).json.batches.map((b: any) => [b.name, b.batch_no, b.qty_milli / 1000]);
    expect(rep).toEqual(expect.arrayContaining([["Syrup base", "LATE", 4], ["Cough syrup", "CS-01", 6]]));
    expect(rep.find((r: any) => r[1] === "SOON")).toBeUndefined();
  });
});
