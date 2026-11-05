import { describe, expect, it } from "vitest";
import { world, contact } from "./helpers";

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

describe("report click-through", () => {
  it("leads from a profit & loss figure to the account's ledger, and from each ledger line to its invoice, receipt and customer", async () => {
    const W = await world();
    const cust = await contact(W, "customer", { name: "Lakeside Cafe" });
    const d = await W.owner.post(W.c("/documents"), { doc_type: "invoice", contact_id: cust, issue_date: day(-3), lines: [{ description: "Catering", quantity: "1", unit_price: "5000", account_id: W.acc.SALES }] });
    const inv = (await W.owner.post(W.c(`/documents/${d.json.id}/issue`))).json;
    await (W.owner.post(W.c("/payments"), { direction: "in", contact_id: cust, payment_date: day(-1), account_id: W.acc.CASH, amount: "2000", allocations: [{ document_id: d.json.id, amount: "2000" }] }));
    const from = day(-10), to = day(0);

    // The P&L shows Sales by its account id: that is what the link opens.
    const pl = (await W.owner.get(W.c(`/reports/profit-loss?from=${from}&to=${to}`))).json;
    const salesLine = pl.sections.flatMap((s: any) => s.lines).find((l: any) => l.id === W.acc.SALES);
    expect(salesLine.amount).toBe(500_000);

    const sales = (await W.owner.get(W.c(`/reports/general-ledger?account_id=${W.acc.SALES}&from=${from}&to=${to}`))).json;
    expect(sales.lines).toHaveLength(1);
    expect(sales.lines[0]).toMatchObject({ source_type: "invoice", source_id: d.json.id, source_number: inv.number, credit: 500_000 });

    // Receivables: the invoice and the receipt, each with its number and the customer.
    const ar = (await W.owner.get(W.c(`/reports/general-ledger?account_id=${W.acc.AR}&from=${from}&to=${to}`))).json;
    expect(ar.lines.map((l: any) => [l.source_type, l.source_number, l.contact_id])).toEqual([["invoice", inv.number, cust], ["receipt", expect.stringMatching(/^RCPT-/), cust]]);
    expect(ar.closing).toBe(300_000);

    // Narrowed to a branch with no entries, the ledger is empty (as on that branch's profit & loss).
    const br = (await W.owner.post(W.c("/settings/branches"), { code: "B2", name: "Second shop" })).json;
    const none = (await W.owner.get(W.c(`/reports/general-ledger?account_id=${W.acc.SALES}&from=${from}&to=${to}&branch_id=${br.id}`))).json;
    expect([none.lines.length, none.opening]).toEqual([0, 0]);
  });
});
