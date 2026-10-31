import { describe, expect, it } from "vitest";
import { BUSINESS_TYPES } from "@shared/industries";
import { DEFAULT_IN_GST_CODES } from "@shared/tax";
import { DEFAULT_ACCOUNTS } from "@shared/coa";
import { world } from "./helpers";

describe("business types", () => {
  it("use only real GST codes, known units and existing income accounts", () => {
    const gst = new Set(DEFAULT_IN_GST_CODES.map((t) => t.name));
    const keys = new Set<string>();
    for (const b of BUSINESS_TYPES) {
      expect(keys.has(b.key), `duplicate key ${b.key}`).toBe(false);
      keys.add(b.key);
      const codes = new Set([...DEFAULT_ACCOUNTS.map((a) => a.code), ...b.accounts.map((a) => a.code)]);
      const units = new Set(["nos", "kg", "ltr", "mtr", "box", "hrs", ...b.units.map(([u]) => u)]);
      for (const it of b.items) {
        if (it.gst) expect(gst.has(it.gst), `${b.key}: ${it.name} uses unknown "${it.gst}"`).toBe(true);
        if (it.income) expect(codes.has(it.income), `${b.key}: ${it.name} income ${it.income}`).toBe(true);
        expect(units.has(it.unit), `${b.key}: ${it.name} unit ${it.unit}`).toBe(true);
      }
    }
    expect([...keys]).toEqual(expect.arrayContaining(["jewellery", "clothing", "electronics", "pharmacy", "hardware", "automobile", "salon", "agri", "furniture", "realestate"]));
  });

  it("sets up a jewellery shop that bills gold by weight (3 decimals) with making charges at GST 3%", async () => {
    const W = await world();
    const co = (await W.owner.post(`/api/orgs/${W.orgId}/companies`, {
      name: "Lakshmi Jewellers", country: "IN", base_currency: "INR", fiscal_year_start_month: 4, state_code: "29", business_type: "jewellery", tax_id: "29ABCDE1234F1ZW",
    })).json.company_id;
    const c = (p: string) => `/api/c/${co}${p}`;
    const items = (await W.owner.get(c("/items?limit=50"))).json.items as any[];
    const gold = items.find((i) => i.name.startsWith("Gold 22K"));
    const making = items.find((i) => i.name.startsWith("Making charges"));
    expect(gold).toMatchObject({ unit: "g", hsn_sac: "7113", track_inventory: 1 });
    const settings = (await W.owner.get(c("/settings"))).json;
    const gst3 = settings.tax_codes.find((t: any) => t.name === "GST 3%");
    expect(gold.tax_code_id).toBe(gst3.id);
    expect((await W.owner.get(c("/accounts"))).json.accounts.map((a: any) => a.name)).toEqual(expect.arrayContaining(["Gold Jewellery Sales", "Old Gold Purchased (Exchange)"]));

    // Stock in 50.000 g, then sell a 12.345 g necklace with making charges.
    const supplier = (await W.owner.post(c("/contacts"), { kind: "supplier", name: "Bullion Traders", state_code: "29" })).json.id;
    const bill = (await W.owner.post(c("/documents"), { doc_type: "bill", contact_id: supplier, issue_date: "2026-05-02", lines: [{ item_id: gold.id, description: "22K gold", quantity: "50", unit_price: "6500", tax_code_id: gst3.id }] })).json;
    expect((await W.owner.post(c(`/documents/${bill.id}/issue`))).status).toBe(200);
    const customer = (await W.owner.post(c("/contacts"), { kind: "customer", name: "Priya Sharma", state_code: "29" })).json.id;
    const inv = (await W.owner.post(c("/documents"), { doc_type: "invoice", contact_id: customer, issue_date: "2026-05-03", lines: [
      { item_id: gold.id, description: "Necklace 22K, HUID AB12CD", quantity: "12.345", unit_price: "6800", tax_code_id: gold.tax_code_id },
      { item_id: making.id, description: "Making charges", quantity: "12.345", unit_price: "450", tax_code_id: making.tax_code_id },
    ] })).json;
    // 12.345 × 6,800 = 83,946.00; 12.345 × 450 = 5,555.25; taxable 89,501.25; GST 3% as CGST + SGST 1.5% each.
    expect(inv.totals).toMatchObject({ taxable_total: 8_950_125, tax_total: 268_504 });
    expect(inv.totals.cgst + inv.totals.sgst).toBe(268_504);
    const issued = await W.owner.post(c(`/documents/${inv.id}/issue`));
    expect(issued.status, JSON.stringify(issued.json)).toBe(200);
    expect(issued.json.number).toBeTruthy();
  });
});

describe("product codes", () => {
  it("gives starter items codes, and the 0025 update fills only missing codes without clashes", async () => {
    const { readFileSync } = await import("node:fs");
    const { rawQuery } = await import("./helpers");
    const W = await world();
    const co = (await W.owner.post(`/api/orgs/${W.orgId}/companies`, { name: "Shop", country: "IN", base_currency: "INR", fiscal_year_start_month: 4, state_code: "29", business_type: "retail" })).json.company_id;
    const codes = (await W.owner.get(`/api/c/${co}/items?limit=50`)).json.items.map((i: any) => i.code).sort();
    expect(codes).toEqual(["P000001", "P000002", "P000003", "P000004"]);
    // As for companies made before this fix: two products without codes, next to a later P000007.
    await rawQuery(W, `UPDATE items SET code = NULL WHERE company_id = ? AND code IN ('P000001','P000003')`, co);
    await rawQuery(W, `UPDATE items SET code = 'P000007' WHERE company_id = ? AND code = 'P000004'`, co);
    for (const sql of readFileSync("migrations/0025_item_codes.sql", "utf8").replace(/--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)) await rawQuery(W, sql);
    const after = (await rawQuery(W, `SELECT code FROM items WHERE company_id = ? ORDER BY code`, co)).map((r: any) => r.code);
    expect(after).toEqual(["P000002", "P000007", "P000008", "P000009"]);
  });
});
