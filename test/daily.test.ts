import { describe, expect, it, beforeAll } from "vitest";
import { world, contact, type World } from "./helpers";

// Hand-computed scenario (all amounts in paise):
//  01 May  opening bank balance ₹10,000 (journal)            → cash & bank 1,000,000
//  02 May  invoice ₹1,000 on credit, supplier bill ₹400       → income 100,000, expenses 40,000, no cash movement
//  03 May  receipt ₹600 into bank, payment ₹400 from cash,    → received 60,000, paid 40,000
//          cash expense ₹50                                    → expenses 5,000, cash out 45,000, cash in 60,000
describe("daily report and date filters", () => {
  let W: World;
  let inv: string;
  beforeAll(async () => {
    W = await world();
    const cust = await contact(W, "customer");
    const supp = await contact(W, "supplier");
    expect((await W.owner.post(W.c("/journals"), { entry_date: "2026-05-01", memo: "Opening bank", post: true, lines: [
      { account_id: W.acc.BANK, debit: "10000" }, { account_id: W.acc.OPENING_EQUITY, credit: "10000" }] })).status).toBe(201);
    const i = await W.owner.post(W.c("/documents"), { doc_type: "invoice", contact_id: cust, issue_date: "2026-05-02", lines: [{ description: "Goods", quantity: "1", unit_price: "1000" }] });
    inv = i.json.id;
    await W.owner.post(W.c(`/documents/${inv}/issue`));
    const b = await W.owner.post(W.c("/documents"), { doc_type: "bill", contact_id: supp, issue_date: "2026-05-02", lines: [{ description: "Stock", quantity: "1", unit_price: "400" }] });
    await W.owner.post(W.c(`/documents/${b.json.id}/issue`));
    expect((await W.owner.post(W.c("/payments"), { direction: "in", contact_id: cust, payment_date: "2026-05-03", account_id: W.acc.BANK, amount: "600", allocations: [{ document_id: inv, amount: "600" }] })).status).toBe(201);
    expect((await W.owner.post(W.c("/payments"), { direction: "out", contact_id: supp, payment_date: "2026-05-03", account_id: W.acc.CASH, amount: "400", allocations: [{ document_id: b.json.id, amount: "400" }] })).status).toBe(201);
    const accounts = (await W.owner.get(W.c("/accounts"))).json.accounts;
    const cat = accounts.find((a: any) => a.type === "expense" && !a.is_group && !a.system_key);
    const e = await W.owner.post(W.c("/expenses"), { expense_date: "2026-05-03", category_account_id: cat.id, paid_from_account_id: W.acc.CASH, description: "Tea for staff", amount: "50" });
    expect((await W.owner.post(W.c(`/expenses/${e.json.id}/approve`))).status).toBe(200);
  });

  it("gives opening, income, expenses, received, paid and closing for each day", async () => {
    const r = await W.owner.get(W.c("/reports/daily?from=2026-05-02&to=2026-05-03"));
    expect(r.status).toBe(200);
    expect(r.json.rows).toEqual([
      { date: "2026-05-02", opening: 1_000_000, income: 100_000, expenses: 40_000, sales_invoiced: 100_000, purchases_billed: 40_000, received: 0, paid: 0, cash_in: 0, cash_out: 0, closing: 1_000_000 },
      { date: "2026-05-03", opening: 1_000_000, income: 0, expenses: 5_000, sales_invoiced: 0, purchases_billed: 0, received: 60_000, paid: 40_000, cash_in: 60_000, cash_out: 45_000, closing: 1_015_000 },
    ]);
    expect(r.json.totals).toMatchObject({ opening: 1_000_000, closing: 1_015_000, income: 100_000, expenses: 45_000, profit: 55_000, received: 60_000, paid: 40_000 });
    // The closing balance agrees with the ledger: bank 10,000 + 600, cash −400 − 50.
    const gl = async (id: string) => (await W.owner.get(W.c(`/reports/general-ledger?account_id=${id}&from=2026-04-01&to=2026-05-03`))).json.closing;
    expect(await gl(W.acc.BANK)).toBe(1_060_000);
    expect(await gl(W.acc.CASH)).toBe(-45_000);
    expect((await W.owner.get(W.c("/reports/daily?from=2026-05-03&to=2026-05-02"))).status).toBe(400);
  });

  it("filters invoices, receipts and expenses by date with totals for the whole filtered set", async () => {
    const may2 = (await W.owner.get(W.c("/documents?type=invoice&from=2026-05-02&to=2026-05-02"))).json;
    expect(may2.documents.map((d: any) => d.id)).toEqual([inv]);
    expect(may2.summary).toEqual({ count: 1, amount: 100_000, settled: 60_000, outstanding: 40_000 });
    expect((await W.owner.get(W.c("/documents?type=invoice&from=2026-05-03&to=2026-05-31"))).json.total).toBe(0);
    const rec = (await W.owner.get(W.c("/payments?direction=in&from=2026-05-03&to=2026-05-03"))).json;
    expect(rec.summary).toEqual({ count: 1, amount: 60_000 });
    expect((await W.owner.get(W.c("/payments?direction=in&from=2026-05-04"))).json.total).toBe(0);
    expect((await W.owner.get(W.c("/expenses?from=2026-05-03&to=2026-05-03"))).json.summary).toEqual({ count: 1, amount: 5_000 });
    expect((await W.owner.get(W.c("/documents?type=invoice&from=2026-13-01"))).status).toBe(400);
  });
});

describe("cash book and bank book", () => {
  it("lists receipts and payments with running balance", async () => {
    const { world, contact } = await import("./helpers");
    const W = await world();
    const cust = await contact(W, "customer");
    const supp = await contact(W, "supplier");
    await W.owner.post(W.c("/journals"), { entry_date: "2026-05-01", memo: "Owner capital", post: true, lines: [{ account_id: W.acc.CASH, debit: "5000" }, { account_id: W.acc.OPENING_EQUITY, credit: "5000" }] });
    await W.owner.post(W.c("/payments"), { direction: "in", contact_id: cust, payment_date: "2026-05-03", account_id: W.acc.CASH, amount: "700" });
    await W.owner.post(W.c("/payments"), { direction: "out", contact_id: supp, payment_date: "2026-05-04", account_id: W.acc.CASH, amount: "200" });
    await W.owner.post(W.c("/payments"), { direction: "in", contact_id: cust, payment_date: "2026-05-04", account_id: W.acc.BANK, amount: "999" });
    const r = (await W.owner.get(W.c("/reports/cash-book?kind=cash&from=2026-05-02&to=2026-05-31"))).json;
    expect(r.opening).toBe(500_000);
    expect(r.entries.map((e: any) => [e.date, e.voucher.slice(0, 4), e.receipt, e.payment, e.balance])).toEqual([
      ["2026-05-03", "RCPT", 70_000, 0, 570_000],
      ["2026-05-04", "PAY-", 0, 20_000, 550_000],
    ]);
    expect(r.entries[0].particulars).toMatch(/customer/);
    expect([r.receipts, r.payments, r.closing]).toEqual([70_000, 20_000, 550_000]);
    const bank = (await W.owner.get(W.c("/reports/cash-book?kind=bank&from=2026-05-01&to=2026-05-31"))).json;
    expect([bank.opening, bank.receipts, bank.closing]).toEqual([0, 99_900, 99_900]);
  });
});
