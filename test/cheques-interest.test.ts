import { describe, expect, it } from "vitest";
import { world, contact, rawQuery } from "./helpers";

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function invoice(W: any, cust: string, amount: string, issue: string, due: string) {
  const d = await W.owner.post(W.c("/documents"), { doc_type: "invoice", contact_id: cust, issue_date: issue, due_date: due, lines: [{ description: "Work", quantity: "1", unit_price: amount, account_id: W.acc.SALES }] });
  expect((await W.owner.post(W.c(`/documents/${d.json.id}/issue`))).status).toBe(200);
  return d.json.id as string;
}

describe("cheque register", () => {
  it("keeps a post-dated cheque off the books until it clears, applies it to the invoice, and reverses it when it bounces", async () => {
    const W = await world();
    const cust = await contact(W, "customer", { name: "Sharma Traders" });
    const inv = await invoice(W, cust, "10000", day(-5), day(25));
    const pdc = await W.owner.post(W.c("/cheques"), { direction: "in", contact_id: cust, cheque_no: "000123", bank_name: "HDFC Bank", cheque_date: day(10), amount: "10000", allocations: [{ document_id: inv, amount: "10000" }] });
    expect(pdc.status, JSON.stringify(pdc.json)).toBe(201);
    const list = (await W.owner.get(W.c("/cheques"))).json;
    expect(list.summary).toMatchObject({ to_receive: 1_000_000, to_pay: 0, due_now: 0 });
    expect((await rawQuery(W, `SELECT COUNT(*) AS n FROM payments WHERE company_id = ?`, W.companyId))[0].n).toBe(0);
    // Not before its date.
    expect((await W.owner.post(W.c(`/cheques/${pdc.json.id}/clear`), { date: day(0), account_id: W.acc.BANK })).status).toBe(400);
    expect((await W.owner.post(W.c(`/cheques/${pdc.json.id}/deposit`), { account_id: W.acc.BANK })).status).toBe(200);
    const cleared = await W.owner.post(W.c(`/cheques/${pdc.json.id}/clear`), { date: day(10) });
    expect(cleared.status, JSON.stringify(cleared.json)).toBe(200);
    expect((await rawQuery(W, `SELECT amount_settled FROM documents WHERE id = ?`, inv))[0].amount_settled).toBe(1_000_000);
    expect((await rawQuery(W, `SELECT method, reference FROM payments WHERE id = ?`, cleared.json.payment_id))[0]).toMatchObject({ method: "cheque", reference: "Cheque 000123" });
    expect((await W.owner.post(W.c(`/cheques/${pdc.json.id}/clear`), {})).status).toBe(409);
    // Bounce: the receipt is reversed and the invoice is unpaid again.
    expect((await W.owner.post(W.c(`/cheques/${pdc.json.id}/bounce`), { date: day(12), reason: "Insufficient funds" })).status).toBe(200);
    expect((await rawQuery(W, `SELECT amount_settled FROM documents WHERE id = ?`, inv))[0].amount_settled).toBe(0);
    expect((await rawQuery(W, `SELECT status FROM payments WHERE id = ?`, cleared.json.payment_id))[0].status).toBe("void");
    expect((await W.owner.get(W.c(`/cheques/${pdc.json.id}`))).json.cheque).toMatchObject({ status: "bounced", bounce_reason: "Insufficient funds" });
  });

  it("issues a cheque to a supplier from a bank account, prints it, and cancels an uncleared one", async () => {
    const W = await world();
    const supp = await contact(W, "supplier", { name: "Mehta Wholesale" });
    expect((await W.owner.post(W.c("/cheques"), { direction: "out", contact_id: supp, cheque_no: "500001", cheque_date: day(0), amount: "2500" })).status).toBe(400);
    expect((await W.owner.post(W.c("/cheques"), { direction: "out", contact_id: supp, cheque_no: "500001", cheque_date: day(0), amount: "2500", account_id: W.acc.CASH })).status).toBe(400);
    const q = await W.owner.post(W.c("/cheques"), { direction: "out", contact_id: supp, cheque_no: "500001", cheque_date: day(0), amount: "2500", account_id: W.acc.BANK, payee_name: "Mehta Wholesale Pvt Ltd" });
    expect(q.status).toBe(201);
    expect((await W.owner.post(W.c(`/cheques/${q.json.id}/printed`))).status).toBe(200);
    expect((await W.owner.put(W.c("/cheques/layout"), { width: 203, height: 92, date: { x: 160, y: 8, spacing: 4.5 }, payee: { x: 20, y: 22 }, words: { x: 30, y: 31, width: 140, line2_y: 39 }, figures: { x: 160, y: 40 }, ac_payee: true })).status).toBe(200);
    expect((await W.owner.post(W.c(`/cheques/${q.json.id}/cancel`), { reason: "Wrong amount" })).status).toBe(200);
    expect((await W.owner.post(W.c(`/cheques/${q.json.id}/clear`), {})).status).toBe(409);
    const out = await W.owner.post(W.c("/cheques"), { direction: "out", contact_id: supp, cheque_no: "500002", cheque_date: day(0), amount: "1500", account_id: W.acc.BANK });
    const paid = await W.owner.post(W.c(`/cheques/${out.json.id}/clear`), {});
    expect(paid.status, JSON.stringify(paid.json)).toBe(200);
    expect((await rawQuery(W, `SELECT direction, amount FROM payments WHERE id = ?`, paid.json.payment_id))[0]).toEqual({ direction: "out", amount: 150_000 });
  });
});

describe("interest on overdue invoices", () => {
  it("works out simple interest after the grace days, makes a draft interest invoice, and does not charge the same days twice", async () => {
    const W = await world();
    const cust = await contact(W, "customer", { name: "Late Payer" });
    await invoice(W, cust, "36500", day(-70), day(-40));      // 40 days overdue
    await invoice(W, cust, "1000", day(-10), day(20));         // not due yet
    expect((await W.owner.put(W.c("/interest/settings"), { rate_percent: 18, grace_days: 10 })).status).toBe(200);
    const r = (await W.owner.get(W.c(`/interest?as_of=${day(0)}`))).json;
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ days: 30, outstanding: 3_650_000, interest: 54_000 }); // 36,500 × 18% × 30/365 = 540
    expect(r.customers[0]).toMatchObject({ party: "Late Payer", interest: 54_000, invoices: 1 });
    const made = await W.owner.post(W.c("/interest/invoice"), { contact_id: cust, as_of: day(0) });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    const draft = (await W.owner.get(W.c(`/documents/${made.json.id}`))).json;
    expect(draft.document).toMatchObject({ status: "draft", total: 54_000 });
    expect(draft.lines[0].description).toMatch(/Interest @ 18% p.a. on .* 30 days/);
    // Billed up to today: nothing more until later.
    expect((await W.owner.get(W.c(`/interest?as_of=${day(0)}`))).json.rows).toHaveLength(0);
    expect((await W.owner.post(W.c("/interest/invoice"), { contact_id: cust, as_of: day(0) })).status).toBe(400);
    expect((await W.owner.get(W.c(`/interest?as_of=${day(10)}`))).json.rows[0]).toMatchObject({ days: 10 });
  });
});
