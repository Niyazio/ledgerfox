import { describe, expect, it } from "vitest";
import { world, contact } from "./helpers";
import { isoFromAny } from "../src/worker/routes/imports";

describe("batches and expiry", () => {
  it("buys by batch, sells first-expiry-first-out, refuses expired stock and keeps batches through voids, write-offs and transfers", async () => {
    // Expiry status is judged against the real date, so every date here is relative to today.
    const d = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
    const LATE = d(400), SOON = d(60), OLD = d(-18);
    const W = await world();
    const supp = await contact(W, "supplier");
    const cust = await contact(W, "customer");
    const item = (await W.owner.post(W.c("/items"), { kind: "goods", name: "Paracetamol 500mg", sale_price: "30", purchase_price: "20", track_inventory: true, track_batches: true })).json.id;
    const bill = async (lines: any[]) => {
      const b = await W.owner.post(W.c("/documents"), { doc_type: "bill", contact_id: supp, issue_date: d(-20), lines });
      return W.owner.post(W.c(`/documents/${b.json.id}/issue`));
    };
    const noBatch = await bill([{ item_id: item, description: "Para", quantity: "10", unit_price: "20" }]);
    expect(noBatch.json.error.code).toBe("BATCH_REQUIRED");
    expect((await bill([
      { item_id: item, description: "Para", quantity: "10", unit_price: "20", batch_no: "b-late", expiry_date: LATE },
      { item_id: item, description: "Para", quantity: "5", unit_price: "20", batch_no: "B-SOON", expiry_date: SOON },
      { item_id: item, description: "Para", quantity: "4", unit_price: "20", batch_no: "B-OLD", expiry_date: OLD },
    ])).status).toBe(200);
    const batches = async () => Object.fromEntries((await W.owner.get(W.c("/items/batches/report?days=200"))).json.batches.map((b: any) => [b.batch_no, [b.qty_milli / 1000, b.status]]));
    const before = await batches();
    expect(before["B-LATE"][0]).toBe(10);
    expect(before["B-OLD"][1]).toBe("expired");
    // Sell 7 after B-OLD expired: expired B-OLD is skipped; 5 from B-SOON, then 2 from B-LATE.
    const inv = await W.owner.post(W.c("/documents"), { doc_type: "invoice", contact_id: cust, issue_date: d(-15), lines: [{ item_id: item, description: "Para", quantity: "7", unit_price: "30" }] });
    expect((await W.owner.post(W.c(`/documents/${inv.json.id}/issue`))).status).toBe(200);
    expect(await batches()).toMatchObject({ "B-LATE": [8, "ok"], "B-OLD": [4, "expired"] });
    expect((await batches())["B-SOON"]).toBeUndefined();
    // Explicitly choosing the expired batch is refused; asking for more than unexpired stock explains why.
    const exp = await W.owner.post(W.c("/documents"), { doc_type: "invoice", contact_id: cust, issue_date: d(-14), lines: [{ item_id: item, description: "Para", quantity: "1", unit_price: "30", batch_no: "B-OLD" }] });
    expect((await W.owner.post(W.c(`/documents/${exp.json.id}/issue`))).json.error.code).toBe("BATCH_EXPIRED");
    const many = await W.owner.post(W.c("/documents"), { doc_type: "invoice", contact_id: cust, issue_date: d(-14), lines: [{ item_id: item, description: "Para", quantity: "10", unit_price: "30" }] });
    const short = await W.owner.post(W.c(`/documents/${many.json.id}/issue`));
    expect(short.json.error.message).toMatch(/short by 2; 4 more is expired/);
    // Voiding the sale puts the units back into the same batches.
    expect((await W.owner.post(W.c(`/documents/${inv.json.id}/void`), { date: d(-13), reason: "test" })).status).toBe(200);
    expect(await batches()).toMatchObject({ "B-LATE": [10, "ok"], "B-SOON": [5, "expiring"] });
    // Expired stock is written off with an adjustment.
    const wh = (await W.owner.get(W.c("/settings"))).json.warehouses[0].id;
    expect((await W.owner.post(W.c("/items/adjustments"), { item_id: item, warehouse_id: wh, date: d(-13), quantity: "-4", batch_no: "B-OLD", memo: "Expired" })).status).toBe(201);
    expect((await batches())["B-OLD"]).toBeUndefined();
    // Transfers carry batch and expiry to the other warehouse.
    const wh2 = (await W.owner.post(W.c("/items/warehouses"), { name: "Shop 2", code: "S2" })).json.id;
    expect((await W.owner.post(W.c("/items/transfers"), { item_id: item, from_warehouse_id: wh, to_warehouse_id: wh2, date: d(-13), quantity: "6" })).status).toBe(201);
    const rep = (await W.owner.get(W.c("/items/batches/report"))).json.batches.map((b: any) => [b.warehouse_name, b.batch_no, b.qty_milli / 1000, b.expiry_date]);
    expect(rep).toEqual(expect.arrayContaining([["Shop 2", "B-SOON", 5, SOON], ["Shop 2", "B-LATE", 1, LATE], [expect.any(String), "B-LATE", 9, LATE]]));
    // Inventory value still reconciles with the ledger.
    expect((await W.owner.get(W.c(`/reports/inventory-valuation?as_of=${d(0)}`))).json.reconciles).toBe(true);
    // Batch tracking cannot be switched off while stock exists.
    expect((await W.owner.put(W.c(`/items/${item}`), { kind: "goods", name: "Paracetamol 500mg", sale_price: "30", track_inventory: true, track_batches: false })).status).toBe(409);
  });

  it("imports opening stock with batch and expiry, and reads spreadsheet dates", async () => {
    expect(isoFromAny("31-03-2027")).toBe("2027-03-31");
    expect(isoFromAny("2027-3-1")).toBe("2027-03-01");
    expect(isoFromAny("02/2028")).toBe("2028-02-29");
    expect(isoFromAny("46387")).toBe("2026-12-31");
    expect(isoFromAny("31-02-2027")).toBeNull();
    const W = await world();
    const r = await W.owner.post(W.c("/import/items"), { as_of: "2026-05-01", rows: [
      { Name: "Cough syrup", "Opening Stock": "12", "Opening Rate": "55", Batch: "cs01", Expiry: "06/2027" },
      { Name: "Antacid", "Opening Stock": "5", "Purchase Price": "10", "Track batches": "yes" },
    ] });
    expect(r.json.errors).toEqual([{ row: 2, message: "Give the batch number of the opening stock" }]);
    const ok = await W.owner.post(W.c("/import/items"), { as_of: "2026-05-01", rows: [{ Name: "Cough syrup", "Opening Stock": "12", "Opening Rate": "55", Batch: "cs01", Expiry: "06/2027" }] });
    expect(ok.json.created).toBe(1);
    expect((await W.owner.get(W.c("/items/batches/report"))).json.batches).toEqual([expect.objectContaining({ batch_no: "CS01", expiry_date: "2027-06-30", qty_milli: 12_000 })]);
  });
});
