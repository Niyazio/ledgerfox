import { describe, expect, it } from "vitest";
import { world } from "./helpers";
import { priceAndUnit } from "../src/worker/routes/imports";
import { tableFromPieces, type TextPiece } from "../src/web/lib/pdfTable";

describe("product list import", () => {
  it("reads rate cards: 'Service / SKU' columns, ₹8,000/month rates, and a Description column", async () => {
    expect(priceAndUnit("₹8,000/month")).toEqual({ amount: "8000", unit: "month" });
    expect(priceAndUnit("Rs 1,000 per hour")).toEqual({ amount: "1000", unit: "hour" });
    expect(priceAndUnit("₹5,000 onwards")).toEqual({ amount: "5000", unit: "" });
    const W = await world();
    const rows = [
      { "No.": "35", "Service / SKU": "Social Media Management / MNCG-DM-001", Rate: "₹8,000/month", Description: "Complete social media account management." },
      { "No.": "55", "Service / SKU": "IT Consultation / MNCG-IT-009", Rate: "₹1,000/hour", Description: "Professional IT consultation." },
      { "No.": "43", "Service / SKU": "Google Business Profile Setup / MNCG-DM-009", Rate: "₹1,500", Description: "Profile creation." },
    ];
    const r = (await W.owner.post(W.c("/import/items"), { rows })).json;
    expect([r.errors, r.created]).toEqual([[], 3]);
    const items = (await W.owner.get(W.c("/items"))).json.items;
    expect(items.find((i: any) => i.sku === "MNCG-DM-001")).toMatchObject({ name: "Social Media Management", kind: "service", sale_price: 800_000, unit: "month", description: "Complete social media account management." });
    // Without a Type column or a "Service" heading, a plain price is goods and a monthly rate is a service.
    await W.owner.post(W.c("/import/items"), { rows: [{ Name: "Cement bag", Price: "400" }, { Name: "AMC", Price: "₹500/month" }] });
    const after = (await W.owner.get(W.c("/items"))).json.items;
    expect([after.find((i: any) => i.name === "Cement bag").kind, after.find((i: any) => i.name === "AMC").kind]).toEqual(["goods", "service"]);
    expect(items.find((i: any) => i.sku === "MNCG-IT-009")).toMatchObject({ unit: "hour", sale_price: 100_000 });
    expect(items.find((i: any) => i.sku === "MNCG-DM-009")).toMatchObject({ unit: "nos", sale_price: 150_000 });
    // A sheet whose only text column is "Description" still uses it as the name.
    expect((await W.owner.post(W.c("/import/items"), { rows: [{ Description: "Plain item", Price: "10" }] })).json.created).toBe(1);
  });

  it("skips existing products, or updates their price, tax, HSN and description when asked — never their stock", async () => {
    const W = await world();
    await W.owner.post(W.c("/import/items"), { rows: [{ Name: "Logo Design", SKU: "GFX-1", "Selling Price": "2000", Description: "Old text", "Opening Stock": "0" }] });
    const again = [{ Name: "logo design", "Selling Price": "2500", HSN: "998391", "GST %": "18", Description: "Two concepts, three revisions" }];
    const skip = (await W.owner.post(W.c("/import/items"), { rows: again, dry_run: true })).json;
    expect([skip.created, skip.updated, skip.skipped.length]).toEqual([0, 0, 1]);
    const check = (await W.owner.post(W.c("/import/items"), { rows: again, dry_run: true, update_existing: true })).json;
    expect([check.created, check.updated]).toEqual([0, 1]);
    let item = (await W.owner.get(W.c("/items"))).json.items.find((i: any) => i.sku === "GFX-1");
    expect(item.sale_price).toBe(200_000); // a check saves nothing
    expect((await W.owner.post(W.c("/import/items"), { rows: again, update_existing: true })).json.updated).toBe(1);
    item = (await W.owner.get(W.c("/items"))).json.items.find((i: any) => i.sku === "GFX-1");
    expect(item).toMatchObject({ name: "Logo Design", sale_price: 250_000, hsn_sac: "998391", description: "Two concepts, three revisions" });
    expect(item.tax_code_id).toBeTruthy();
    // A blank column leaves the value as it was.
    await W.owner.post(W.c("/import/items"), { rows: [{ SKU: "GFX-1", Name: "Logo Design", "Selling Price": "", Description: "" }], update_existing: true });
    expect((await W.owner.get(W.c("/items"))).json.items.find((i: any) => i.sku === "GFX-1")).toMatchObject({ sale_price: 250_000, description: "Two concepts, three revisions" });
  });
});

describe("reading a table from a PDF", () => {
  const t = (str: string, x: number, y: number, page = 1): TextPiece => ({ str, x, y, w: str.length * 5, h: 10, page });
  it("finds the header, the columns, joins wrapped descriptions and leaves out section titles and page numbers", () => {
    const pieces = [
      t("MNCG Rate Card", 40, 800),
      t("No.", 40, 760), t("Service / SKU", 80, 760), t("Rate", 300, 760), t("Description", 380, 760),
      t("D. Digital Marketing", 40, 740),
      t("35", 40, 720), t("Social Media Management / MNCG-DM-001", 80, 720), t("₹8,000/month", 300, 720), t("Complete social media management,", 380, 720),
      t("content planning and posting.", 380, 708),
      t("36", 40, 690), t("Instagram Management / MNCG-DM-002", 80, 690), t("₹6,000/month", 300, 690), t("Instagram account management.", 380, 690),
      t("Page 1 of 2", 380, 40),
      t("No.", 40, 760, 2), t("Service / SKU", 80, 760, 2), t("Rate", 300, 760, 2), t("Description", 380, 760, 2),
      t("47", 40, 720, 2), t("Accounting Software Setup / MNCG-IT-001", 80, 720, 2), t("₹3,000", 300, 720, 2), t("Installation and training.", 380, 720, 2),
    ];
    expect(tableFromPieces(pieces)).toEqual([
      ["No.", "Service / SKU", "Rate", "Description"],
      ["35", "Social Media Management / MNCG-DM-001", "₹8,000/month", "Complete social media management, content planning and posting."],
      ["36", "Instagram Management / MNCG-DM-002", "₹6,000/month", "Instagram account management."],
      ["47", "Accounting Software Setup / MNCG-IT-001", "₹3,000", "Installation and training."],
    ]);
    expect(tableFromPieces([t("Just a letter", 40, 700)])).toEqual([]);
  });
});
