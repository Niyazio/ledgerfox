import { describe, expect, it } from "vitest";
import { world, contact, rawQuery, Client } from "./helpers";

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

describe("UPI payments straight to the business's bank", () => {
  it("records a UPI payment with its UTR once, and refuses the same UTR again", async () => {
    const W = await world();
    const cust = await contact(W, "customer", { name: "Green Café" });
    const inv = await W.owner.post(W.c("/documents"), { doc_type: "invoice", contact_id: cust, issue_date: day(-2), lines: [{ description: "Website", quantity: "1", unit_price: "5000", account_id: W.acc.SALES }] });
    await W.owner.post(W.c(`/documents/${inv.json.id}/issue`));
    const pay = (utr: string, amount = "2000") => W.owner.post(W.c("/payments"), { direction: "in", contact_id: cust, payment_date: day(0), account_id: W.acc.BANK, amount, method: "upi", reference: utr, allocations: [{ document_id: inv.json.id, amount }] });
    expect((await pay("412345678901")).status).toBe(201);
    const again = await pay("4123 4567 8901");
    expect([again.status, again.json.error.code]).toEqual([409, "DUPLICATE_REFERENCE"]);
    expect(again.json.error.message).toMatch(/already recorded on/);
    expect((await rawQuery(W, `SELECT amount_settled FROM documents WHERE id = ?`, inv.json.id))[0].amount_settled).toBe(200_000);
    // A different UTR is a different payment.
    expect((await pay("412345678902", "1000")).status).toBe(201);
    // Cash and cheque references are not checked (cheque numbers repeat across banks).
    const cash = () => W.owner.post(W.c("/payments"), { direction: "in", contact_id: cust, payment_date: day(0), account_id: W.acc.CASH, amount: "100", method: "cash", reference: "Counter", allocations: [] });
    expect([(await cash()).status, (await cash()).status]).toEqual([201, 201]);
  });

  it("shows Pay by UPI in the customer portal when the business has a UPI ID", async () => {
    const W = await world();
    const cust = await contact(W, "customer", { name: "Kumar Motors" });
    const link = (await W.owner.post(W.c(`/collection/portal/${cust}`), {})).json;
    const pub = new Client(W.env);
    expect((await pub.get(`/api/portal/${link.token}`)).json.upi_pay).toBe(false);
    expect((await W.owner.patch(W.c("/settings"), { name: "Acme Traders", upi_id: "acme@okhdfcbank" })).status).toBe(200);
    expect((await pub.get(`/api/portal/${link.token}`)).json.upi_pay).toBe(true);
  });
});
