import { describe, expect, it } from "vitest";
import { world, contact, rawQuery, Client } from "./helpers";

import { isValidGstin } from "../src/shared/tax";

/** A Maharashtra (27) GSTIN with a correct check digit. */
const VALID_27 = (() => { for (const ch of "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ") { const g = `27AAPFU0939F1Z${ch}`; if (isValidGstin(g)) return g; } throw new Error("no gstin"); })();
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

describe("tax check", () => {
  it("finds wrong GSTINs, a state that does not match the GSTIN and products without HSN, and fixes them in place", async () => {
    const W = await world();
    // Bad data arrives through imports and older records (the forms already refuse it), so it is put in directly.
    await rawQuery(W, `UPDATE companies SET tax_id = '29AAAAA0000A1Z5' WHERE id = ?`, W.companyId);
    const gst18 = Object.entries(W.tax).find(([n]) => /18/.test(n))![1];
    const bad = await contact(W, "customer", { name: "Bad GSTIN" });
    const wrongState = await contact(W, "supplier", { name: "Wrong State", state_code: "29" });
    await rawQuery(W, `UPDATE contacts SET tax_id = '29ABCDE1234F1Z' WHERE id = ?`, bad);
    await rawQuery(W, `UPDATE contacts SET tax_id = ? WHERE id = ?`, VALID_27, wrongState);
    const item = (await W.owner.post(W.c("/items"), { name: "Widget", kind: "goods", sale_price: "100", tax_code_id: gst18 })).json.id;
    const run = async () => Object.fromEntries((await W.owner.get(W.c("/tax-check"))).json.issues.map((i: any) => [i.key, i]));
    let by = await run();
    expect(by.bad_gstin.rows.map((r: any) => r.contact_id)).toContain(bad);
    expect(by.state_mismatch.rows[0]).toMatchObject({ contact_id: wrongState, should_be: expect.stringMatching(/^27 Maharashtra/) });
    expect(by.item_hsn.rows.map((r: any) => r.item_id)).toContain(item);
    // One-click fixes.
    expect((await W.owner.post(W.c("/tax-check/state-from-gstin"), { contact_id: wrongState })).json.state_code).toBe("27");
    expect((await W.owner.patch(W.c(`/tax-check/item/${item}`), { hsn_sac: "12" })).status).toBe(400);
    expect((await W.owner.patch(W.c(`/tax-check/item/${item}`), { hsn_sac: "847130" })).status).toBe(200);
    by = await run();
    expect(by.state_mismatch.count).toBe(0);
    expect(by.item_hsn.rows.map((r: any) => r.item_id)).not.toContain(item);
    // Fixes are in the audit log.
    expect((await rawQuery(W, `SELECT action FROM audit_logs WHERE action IN ('contact.fix_state','item.fix_tax')`)).length).toBe(2);
    // Another company's item cannot be touched.
    const O = await world();
    expect((await O.owner.patch(O.c(`/tax-check/item/${item}`), { hsn_sac: "8471" })).status).toBe(404);
  });
});

describe("supplier portal", () => {
  it("shows the supplier our purchase orders, their bills, our payments and what we owe, and lets them accept an order", async () => {
    const W = await world();
    const supp = await contact(W, "supplier", { name: "Steel Supplier" });
    const po = await W.owner.post(W.c("/documents"), { doc_type: "purchase_order", contact_id: supp, issue_date: day(-2), lines: [{ description: "Steel rods", quantity: "10", unit_price: "500", account_id: W.acc.PURCHASES }] });
    await W.owner.post(W.c(`/documents/${po.json.id}/issue`));
    const bill = await W.owner.post(W.c("/documents"), { doc_type: "bill", contact_id: supp, issue_date: day(-1), reference: "SS-1", lines: [{ description: "Steel rods", quantity: "1", unit_price: "3000", account_id: W.acc.PURCHASES }] });
    await W.owner.post(W.c(`/documents/${bill.json.id}/issue`));
    await W.owner.post(W.c("/payments"), { direction: "out", contact_id: supp, payment_date: day(0), account_id: W.acc.BANK, amount: "1000", allocations: [{ document_id: bill.json.id, amount: "1000" }] });

    const link = (await W.owner.post(W.c(`/collection/portal/${supp}`), {})).json;
    expect(link.url).toMatch(/\/portal\//);
    const pub = new Client(W.env);
    const p = (await pub.get(`/api/portal/${link.token}`)).json;
    expect(p.customer).toMatchObject({ name: "Steel Supplier", kind: "supplier" });
    expect(p.invoices).toEqual([]);
    expect(p.supplier.orders[0]).toMatchObject({ id: po.json.id, status: "open", total: 500_000 });
    expect(p.supplier.bills[0]).toMatchObject({ id: bill.json.id, total: 300_000 });
    expect(p.supplier.bills[0].link).toBeUndefined();
    expect(p.supplier.payments[0]).toMatchObject({ amount: 100_000 });
    expect(p.supplier.owed).toBe(200_000);
    // The order link shows the full order to the supplier.
    const v = (await pub.get(`/api/verify/${p.supplier.orders[0].link.split("/").pop()}`)).json;
    expect(v.valid).toBe(true);
    expect(v.lines?.length ?? v.document?.lines?.length).toBeGreaterThan(0);
    // Accept once; then it cannot change from the portal.
    expect((await pub.post(`/api/portal/${link.token}/orders/${po.json.id}/accept`)).json.status).toBe("accepted");
    expect((await pub.post(`/api/portal/${link.token}/orders/${po.json.id}/decline`)).status).toBe(409);
    // A bill is not an order; another supplier's link cannot touch this order.
    expect((await pub.post(`/api/portal/${link.token}/orders/${bill.json.id}/accept`)).status).toBe(404);
    const other = await contact(W, "supplier", { name: "Other" });
    const otherLink = (await W.owner.post(W.c(`/collection/portal/${other}`), {})).json;
    expect((await pub.post(`/api/portal/${otherLink.token}/orders/${po.json.id}/accept`)).status).toBe(404);
    // The accepted order still becomes a bill.
    const conv = await W.owner.post(W.c(`/documents/${po.json.id}/convert`), { to: "bill" });
    expect(conv.status, JSON.stringify(conv.json)).toBeLessThan(300);
  });
});
