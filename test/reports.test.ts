/**
 * End-to-end scenario with independently hand-calculated figures (₹):
 *   01-Apr  Asset bought from bank            36,000  (SLM, 36 months → 1,000/month)
 *   05-Apr  Owner capital into bank          100,000
 *   10-Apr  Rent expense paid from bank       20,000
 *   15-Apr  Invoice 50,000 + 18% GST (intra)  59,000
 *   20-Apr  Bill 10,000 + 18% GST (unpaid)    11,800
 *   25-Apr  Receipt against invoice           30,000
 *   Apr–May depreciation                       2,000
 * Expected P&L Apr–May: 50,000 − 10,000 − 20,000 − 2,000 = 18,000 profit.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { world, contact, type World } from "./helpers";

let w: World;
const R = (n: number) => n * 100; // rupees → paise

beforeAll(async () => {
  w = await world();
  const cust = await contact(w, "customer", { state_code: "29" });
  const supp = await contact(w, "supplier", { state_code: "29" });
  const ok = (r: { status: number; json: any }) => { if (r.status >= 300) throw new Error(JSON.stringify(r.json)); return r; };
  ok(await w.owner.post(w.c("/assets"), { code: "FA-001", name: "Laptop", acquisition_date: "2026-04-01", cost: "36000", method: "slm", useful_life_months: 36, asset_account_id: w.acc.FIXED_ASSET, paid_from_account_id: w.acc.BANK }));
  ok(await w.owner.post(w.c("/journals"), { entry_date: "2026-04-05", post: true, memo: "Capital", lines: [{ account_id: w.acc.BANK, debit: "100000" }, { account_id: w.acc.CAPITAL, credit: "100000" }] }));
  const e = ok(await w.owner.post(w.c("/expenses"), { expense_date: "2026-04-10", category_account_id: w.acc["6200"], paid_from_account_id: w.acc.BANK, description: "April office rent", amount: "20000" }));
  ok(await w.owner.post(w.c(`/expenses/${e.json.id}/approve`)));
  const inv = ok(await w.owner.post(w.c("/documents"), { doc_type: "invoice", contact_id: cust, issue_date: "2026-04-15", lines: [{ description: "Project", quantity: "1", unit_price: "50000", tax_code_id: w.tax["GST 18%"] }] }));
  ok(await w.owner.post(w.c(`/documents/${inv.json.id}/issue`)));
  const bill = ok(await w.owner.post(w.c("/documents"), { doc_type: "bill", contact_id: supp, issue_date: "2026-04-20", lines: [{ description: "Materials", quantity: "1", unit_price: "10000", tax_code_id: w.tax["GST 18%"] }] }));
  ok(await w.owner.post(w.c(`/documents/${bill.json.id}/issue`)));
  ok(await w.owner.post(w.c("/payments"), { direction: "in", contact_id: cust, payment_date: "2026-04-25", account_id: w.acc.BANK, amount: "30000", allocations: [{ document_id: inv.json.id, amount: "30000" }] }));
  const dep = ok(await w.owner.post(w.c("/assets/depreciation/run"), { through: "2026-05" }));
  if (dep.json.journals !== 2) throw new Error("expected 2 depreciation journals");
});

describe("financial statements reconcile with hand calculations", () => {
  it("trial balance balances", async () => {
    const tb = await w.owner.get(w.c("/reports/trial-balance?from=2026-04-01&to=2026-05-31"));
    expect(tb.json.balanced).toBe(true);
    expect(tb.json.totals.closing_debit).toBe(tb.json.totals.closing_credit);
  });

  it("profit and loss", async () => {
    const pl = await w.owner.get(w.c("/reports/profit-loss?from=2026-04-01&to=2026-05-31"));
    expect(pl.json.revenue).toBe(R(50000));
    expect(pl.json.gross_profit).toBe(R(40000));
    expect(pl.json.operating_profit).toBe(R(18000));
    expect(pl.json.net_profit).toBe(R(18000));
    expect(pl.json.explanation.length).toBeGreaterThan(0);
    expect(pl.json.explanation[0]).toContain("18,000.00");
  });

  it("balance sheet: assets 138,800 = liabilities 20,800 + equity 118,000", async () => {
    const bs = await w.owner.get(w.c("/reports/balance-sheet?as_of=2026-05-31"));
    expect(bs.json.assets.total).toBe(R(138800));
    expect(bs.json.liabilities.total).toBe(R(20800));
    expect(bs.json.equity.total).toBe(R(118000));
    expect(bs.json.balanced).toBe(true);
    const bank = bs.json.assets.lines.find((l: any) => l.id === w.acc.BANK);
    expect(bank.amount).toBe(R(74000));
    const earnings = bs.json.equity.lines.find((l: any) => l.id === "current-earnings");
    expect(earnings.amount).toBe(R(18000));
  });

  it("cash flow (indirect) reconciles to the change in cash", async () => {
    const cf = await w.owner.get(w.c("/reports/cash-flow?from=2026-04-01&to=2026-05-31"));
    expect(cf.json.net_profit).toBe(R(18000));
    expect(cf.json.operating.total).toBe(R(10000));
    expect(cf.json.investing.total).toBe(R(-36000));
    expect(cf.json.financing.total).toBe(R(100000));
    expect(cf.json.net_change).toBe(R(74000));
    expect(cf.json.cash_change_per_ledger).toBe(R(74000));
    expect(cf.json.reconciles).toBe(true);
  });

  it("general ledger running balance for the bank", async () => {
    const gl = await w.owner.get(w.c(`/reports/general-ledger?account_id=${w.acc.BANK}&from=2026-04-01&to=2026-05-31`));
    expect(gl.json.opening).toBe(0);
    expect(gl.json.closing).toBe(R(74000));
    expect(gl.json.lines.at(-1).balance).toBe(R(74000));
  });

  it("aged receivables match the AR control account", async () => {
    const ar = await w.owner.get(w.c("/reports/aging/receivable?as_of=2026-06-30"));
    expect(ar.json.totals.total).toBe(R(29000));
    expect(ar.json.totals["31_60"]).toBe(R(29000)); // due 15-May, 46 days overdue on 30-Jun
    expect(ar.json.ledger_balance).toBe(R(29000));
    expect(ar.json.unreconciled_difference).toBe(0);
    const ap = await w.owner.get(w.c("/reports/aging/payable?as_of=2026-05-31"));
    expect(ap.json.totals.total).toBe(R(11800));
    expect(ap.json.unreconciled_difference).toBe(0);
  });

  it("GST summary: output 9,000 − input 1,800 = 7,200 payable", async () => {
    const g = await w.owner.get(w.c("/reports/gst-summary?from=2026-04-01&to=2026-05-31"));
    expect(g.json.output_tax).toBe(R(9000));
    expect(g.json.input_tax).toBe(R(1800));
    expect(g.json.net_payable).toBe(R(7200));
  });

  it("budget vs actual", async () => {
    const fy = await w.owner.get(w.c("/settings/fiscal-years"));
    const fy26 = fy.json.fiscal_years.find((f: any) => f.start_date === "2026-04-01");
    const b = await w.owner.post(w.c("/reports/budgets"), { name: "FY26 plan", fiscal_year_id: fy26.id, lines: [{ account_id: w.acc["6200"], period_month: "2026-04", amount: "25000" }, { account_id: w.acc.SALES, period_month: "2026-04", amount: "60000" }] });
    expect(b.status).toBe(201);
    const r = await w.owner.get(w.c(`/reports/budgets/${b.json.id}`));
    const rent = r.json.rows.find((x: any) => x.account_id === w.acc["6200"]);
    expect(rent).toMatchObject({ amount: R(25000), actual: R(20000), variance: R(5000), favourable: true });
    const sales = r.json.rows.find((x: any) => x.account_id === w.acc.SALES);
    expect(sales).toMatchObject({ actual: R(50000), variance: R(-10000), favourable: false });
  });

  it("dashboard figures come from the ledger", async () => {
    const d = await w.owner.get(w.c("/reports/dashboard"));
    const bank = d.json.cash.find((a: any) => a.id === w.acc.BANK);
    expect(bank.balance).toBe(R(74000));
    expect(d.json.receivables.ar).toBe(R(29000));
    expect(d.json.receivables.ap).toBe(R(11800));
    expect(d.json.months.length).toBe(6);
  });

  it("depreciation re-run is idempotent and asset disposal books the loss", async () => {
    const again = await w.owner.post(w.c("/assets/depreciation/run"), { through: "2026-05" });
    expect(again.json.journals).toBe(0);
    const list = await w.owner.get(w.c("/assets"));
    const a = list.json.assets[0];
    expect(a.accumulated_depreciation).toBe(R(2000));
    // sell for 30,000: book value 34,000 → loss 4,000
    const d = await w.owner.post(w.c(`/assets/${a.id}/dispose`), { date: "2026-06-01", proceeds: "30000", deposit_account_id: w.acc.BANK });
    expect(d.status).toBe(200);
    expect(d.json.gain).toBe(R(-4000));
    const bs = await w.owner.get(w.c("/reports/balance-sheet?as_of=2026-06-30"));
    expect(bs.json.balanced).toBe(true);
  });
});
