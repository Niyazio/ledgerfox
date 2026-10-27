import { describe, expect, it } from "vitest";
import { world } from "./helpers";

describe("spreadsheet import", () => {
  it("imports customers and suppliers with loose headers, skips duplicates and rejects bad rows", async () => {
    const W = await world();
    const rows = [
      { "Party Name": "Sharma Traders", "GST No": "", "Mobile No": "98450 00001", State: "Karnataka", "Credit Days": "15" },
      { "Party Name": "Mehta Wholesale", Type: "Supplier", "Place of supply": "27", Email: "accounts@mehta.example", "Credit Limit": "₹50,000" },
      { "Party Name": "Sharma Traders", State: "29" },
    ];
    const dry = await W.owner.post(W.c("/import/contacts"), { rows, dry_run: true });
    expect(dry.json).toMatchObject({ dry_run: true, ok: true, created: 2, skipped: [{ row: 3, reason: "Sharma Traders already exists" }], errors: [] });
    expect((await W.owner.get(W.c("/contacts?kind=customer"))).json.total).toBe(0); // dry run saved nothing
    const done = await W.owner.post(W.c("/import/contacts"), { rows });
    expect(done.json).toMatchObject({ ok: true, created: 2 });
    const custs = (await W.owner.get(W.c("/contacts?kind=customer"))).json.contacts;
    expect(custs.map((x: any) => [x.name, x.state_code, x.payment_terms_days, x.phone])).toEqual([["Sharma Traders", "29", 15, "98450 00001"]]);
    const supp = (await W.owner.get(W.c("/contacts?kind=supplier"))).json.contacts[0];
    expect([supp.name, supp.state_code, supp.credit_limit]).toEqual(["Mehta Wholesale", "27", 5_000_000]);
    // Re-importing the same file creates nothing new; one bad row rejects the whole chunk.
    expect((await W.owner.post(W.c("/import/contacts"), { rows })).json.created).toBe(0);
    const bad = await W.owner.post(W.c("/import/contacts"), { rows: [{ Name: "Good Co" }, { Name: "Bad Co", GSTIN: "29ABCDE1234F1Z0" }, { Name: "", Phone: "1" }] });
    expect(bad.json.ok).toBe(false);
    expect(bad.json.errors).toEqual([{ row: 2, message: "GSTIN 29ABCDE1234F1Z0 is not valid" }, { row: 3, message: "Name is missing" }]);
    expect((await W.owner.get(W.c("/contacts?q=Good"))).json.total).toBe(0);
  });

  it("imports products with GST rate, units, codes and opening stock posted to the ledger", async () => {
    const W = await world();
    const rows = [
      { "Item Name": "Basmati Rice 5kg", "HSN Code": "1006", "GST %": "5", UOM: "bag", "Selling Price": "650", "Purchase Price": "520", "Opening Stock": "10", Barcode: "8901000000011" },
      { "Item Name": "Tea 250g", HSN: "0902", GST: "GST 5%", Unit: "pcs", MRP: "140", Cost: "100", "Opening Qty": "24", "Opening Rate": "95" },
      { "Item Name": "Delivery charge", Type: "Service", "HSN/SAC": "996812", "Tax Rate": "18%", Rate: "50" },
    ];
    const r = await W.owner.post(W.c("/import/items"), { rows, as_of: "2026-05-01" });
    expect(r.json, JSON.stringify(r.json)).toMatchObject({ ok: true, created: 3, new_units: ["bag", "pcs"] });
    const items = (await W.owner.get(W.c("/items?limit=50"))).json.items;
    const rice = items.find((i: any) => i.name === "Basmati Rice 5kg");
    expect(rice).toMatchObject({ unit: "bag", hsn_sac: "1006", sale_price: 65_000, purchase_price: 52_000, track_inventory: 1, barcode: "8901000000011", stock_qty_milli: 10_000, stock_value: 520_000 });
    expect(rice.code).toMatch(/^P\d{6}$/);
    const tea = items.find((i: any) => i.name === "Tea 250g");
    expect([tea.stock_qty_milli, tea.stock_value]).toEqual([24_000, 228_000]); // 24 × ₹95
    expect(items.find((i: any) => i.name === "Delivery charge")).toMatchObject({ kind: "service", track_inventory: 0, sale_price: 5_000 });
    // Opening stock ₹7,480 = 5,200 + 2,280, against opening balance equity; inventory valuation reconciles.
    const val = (await W.owner.get(W.c("/reports/inventory-valuation?as_of=2026-05-31"))).json;
    expect(val).toMatchObject({ stock_value: 748_000, ledger_value: 748_000, reconciles: true });
    // Errors are reported per row and nothing is saved.
    const bad = await W.owner.post(W.c("/import/items"), { rows: [{ Name: "X", GST: "13" }, { Name: "Y", HSN: "12" }, { Name: "Z", Barcode: "8901000000011" }, { Name: "W", "Opening Stock": "5" }] });
    expect(bad.json.errors.map((e: any) => e.row)).toEqual([1, 2, 3, 4]);
    expect(bad.json.errors[0].message).toBe('No tax code matches "13"');
  });

  it("respects permissions", async () => {
    const W = await world();
    const u = await W.owner.post(`/api/orgs/${W.orgId}/users`, { name: "Bill", username: "billing.imp", role: "billing" });
    const { Client } = await import("./helpers");
    const cl = new Client(W.env);
    await cl.post("/api/auth/login", { login: "billing.imp", password: u.json.temporary_password });
    await cl.post("/api/auth/change-password", { current_password: u.json.temporary_password, new_password: "billing own pass 1" });
    expect((await cl.post(W.c("/import/items"), { rows: [{ Name: "X" }] })).status).toBe(403);
    const sup = await cl.post(W.c("/import/contacts"), { rows: [{ Name: "Vendor", Type: "supplier" }] });
    expect(sup.json.errors[0].message).toBe("You may not add suppliers");
    expect((await cl.post(W.c("/import/contacts"), { rows: [{ Name: "Walk-in" }] })).json.created).toBe(1);
  });
});
