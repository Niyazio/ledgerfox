import { describe, expect, it } from "vitest";
import { world } from "./helpers";
import { accountKind } from "../src/worker/routes/imports";

describe("chart of accounts import", () => {
  it("knows account types as people write them", () => {
    expect(accountKind("Income")).toEqual({ type: "income", subtype: "operating_income" });
    expect(accountKind("Fixed Asset")).toEqual({ type: "asset", subtype: "fixed_asset" });
    expect(accountKind("Indirect Expenses")).toEqual({ type: "expense", subtype: "operating_expense" });
    expect(accountKind("Duties & Taxes")).toEqual({ type: "liability", subtype: "current_liability" });
    expect(accountKind("banana")).toBeNull();
  });

  it("adds accounts under the right groups, skips existing codes and names, and products can then use them", async () => {
    const W = await world();
    const rows = [
      { Code: "4210", "Account name": "Website & Software Development Income", Type: "Income" },
      { Code: "6630", "Account name": "AI Tools & Subscriptions", Type: "Expense" },
      { Code: "1310", "Account name": "Cameras & Photography Equipment", Type: "Fixed Asset" },
      { Code: "4200", "Account name": "Something else", Type: "Income" },          // code exists
      { Code: "6999", "Account name": "Software & Subscriptions", Type: "Expense" }, // name exists
    ];
    const check = (await W.owner.post(W.c("/import/accounts"), { rows, dry_run: true })).json;
    expect([check.errors, check.created, check.skipped.length]).toEqual([[], 3, 2]);
    expect((await W.owner.post(W.c("/import/accounts"), { rows: [{ Code: "7", "Account name": "X", Type: "banana" }] })).json.errors[0].message).toMatch(/type "banana"/);
    expect((await W.owner.post(W.c("/import/accounts"), { rows })).json.created).toBe(3);
    const accs = (await W.owner.get(W.c("/accounts"))).json.accounts as any[];
    const by = (code: string) => accs.find((a) => a.code === code);
    expect(by("4210")).toMatchObject({ type: "income", subtype: "operating_income", parent_id: by("4000").id });
    expect(by("6630")).toMatchObject({ type: "expense", parent_id: by("6000").id });
    expect(by("1310")).toMatchObject({ type: "asset", subtype: "fixed_asset", parent_id: by("1200").id });
    // Importing again changes nothing.
    expect((await W.owner.post(W.c("/import/accounts"), { rows })).json).toMatchObject({ created: 0, errors: [] });

    // Products: a new one with its income account, and existing ones moved to another income account.
    await W.owner.post(W.c("/import/items"), { rows: [{ Name: "Logo Design", SKU: "GFX-1", "Selling Price": "2000" }] });
    const r = (await W.owner.post(W.c("/import/items"), { rows: [{ Name: "Website", SKU: "WEB-1", "Selling Price": "15000", "Income Account": "4210" }] })).json;
    expect([r.errors, r.created]).toEqual([[], 1]);
    expect((await W.owner.post(W.c("/import/items"), { rows: [{ Name: "Bad", "Income Account": "9999" }] })).json.errors[0].message).toMatch(/No income account "9999"/);
    const up = (await W.owner.post(W.c("/import/items"), { rows: [{ SKU: "GFX-1", Name: "Logo Design", "Income Account": "4210 Website & Software Development Income", "Expense Account": "AI Tools & Subscriptions" }], update_existing: true })).json;
    expect([up.errors, up.updated]).toEqual([[], 1]);
    const items = (await W.owner.get(W.c("/items"))).json.items as any[];
    expect(items.find((i) => i.sku === "WEB-1").income_account_id).toBe(by("4210").id);
    expect(items.find((i) => i.sku === "GFX-1")).toMatchObject({ income_account_id: by("4210").id, expense_account_id: by("6630").id, sale_price: 200_000 });
  });
});
