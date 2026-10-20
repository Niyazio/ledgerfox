import { describe, expect, it, beforeAll } from "vitest";
import { world, contact, type World } from "./helpers";

let w: World;
let cust: string;
beforeAll(async () => {
  w = await world();
  cust = await contact(w, "customer", { state_code: "29" });
  // Book side: capital 10,000 and a customer receipt 2,500 into the bank.
  await w.owner.post(w.c("/journals"), { entry_date: "2026-05-01", post: true, lines: [{ account_id: w.acc.BANK, debit: "10000" }, { account_id: w.acc.CAPITAL, credit: "10000" }] });
  const inv = await w.owner.post(w.c("/documents"), { doc_type: "invoice", contact_id: cust, issue_date: "2026-05-02", lines: [{ description: "Svc", quantity: "1", unit_price: "2500" }] });
  await w.owner.post(w.c(`/documents/${inv.json.id}/issue`));
  await w.owner.post(w.c("/payments"), { direction: "in", contact_id: cust, payment_date: "2026-05-05", account_id: w.acc.BANK, amount: "2500", reference: "NEFT-123", allocations: [{ document_id: inv.json.id, amount: "2500" }] });
});

const CSV = [
  "Date,Narration,Ref,Withdrawal,Deposit,Balance",
  "01/05/2026,Capital introduced,,,\"10,000.00\",\"10,000.00\"",
  "06/05/2026,NEFT-123 customer payment,NEFT-123,,2500.00,12500.00",
  "07/05/2026,Bank charges,,59.00,,12441.00",
].join("\n");
const mapping = { date_format: "DD/MM/YYYY", columns: { date: 0, description: 1, reference: 2, debit: 3, credit: 4, balance: 5 } };

describe("bank statement import and reconciliation", () => {
  it("previews and imports a CSV statement", async () => {
    const p = await w.owner.post(w.c("/banking/import"), { account_id: w.acc.BANK, csv: CSV, preview: true, ...mapping });
    expect(p.json.total).toBe(3);
    expect(p.json.rows[2]).toMatchObject({ txn_date: "2026-05-07", amount: -5900 });
    const r = await w.owner.post(w.c("/banking/import"), { account_id: w.acc.BANK, csv: CSV, filename: "may.csv", ...mapping });
    expect(r.status).toBe(201);
    expect(r.json.imported).toBe(3);
  });

  it("re-importing the same file detects duplicates", async () => {
    const r = await w.owner.post(w.c("/banking/import"), { account_id: w.acc.BANK, csv: CSV, ...mapping });
    expect(r.json).toMatchObject({ imported: 0, duplicates: 3 });
  });

  it("suggests the matching receipt and matches it", async () => {
    const lines = (await w.owner.get(w.c(`/banking/lines?account_id=${w.acc.BANK}`))).json.lines;
    const neft = lines.find((l: any) => l.reference === "NEFT-123");
    const s = await w.owner.get(w.c(`/banking/lines/${neft.id}/suggestions`));
    expect(s.json.suggestions.length).toBe(1);
    expect(s.json.suggestions[0].reason).toContain("Same amount");
    expect((await w.owner.post(w.c(`/banking/lines/${neft.id}/match`), { journal_line_id: s.json.suggestions[0].line_id })).status).toBe(200);
    const cap = lines.find((l: any) => l.description === "Capital introduced");
    const s2 = await w.owner.get(w.c(`/banking/lines/${cap.id}/suggestions`));
    await w.owner.post(w.c(`/banking/lines/${cap.id}/match`), { journal_line_id: s2.json.suggestions[0].line_id });
  });

  it("rejects matching to a line with a different amount", async () => {
    const lines = (await w.owner.get(w.c(`/banking/lines?account_id=${w.acc.BANK}&status=unmatched`))).json.lines;
    const charges = lines.find((l: any) => l.description === "Bank charges");
    const any = await w.env.DB.prepare(`SELECT l.id FROM journal_lines l WHERE l.account_id = ? AND l.debit = 1000000`).bind(w.acc.BANK).first<{ id: string }>();
    const r = await w.owner.post(w.c(`/banking/lines/${charges.id}/match`), { journal_line_id: any!.id });
    expect(r.status).toBe(422);
  });

  it("reconciliation is blocked until unrecorded items are booked", async () => {
    const r = await w.owner.post(w.c("/banking/reconcile"), { account_id: w.acc.BANK, statement_date: "2026-05-31", statement_balance: "12441.00" });
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe("NOT_RECONCILED");
  });

  it("books bank charges from the statement line, then reconciles to zero difference", async () => {
    const lines = (await w.owner.get(w.c(`/banking/lines?account_id=${w.acc.BANK}&status=unmatched`))).json.lines;
    const charges = lines.find((l: any) => l.description === "Bank charges");
    const ce = await w.owner.post(w.c(`/banking/lines/${charges.id}/create-entry`), { account_id: w.acc.BANK_CHARGES });
    expect(ce.status).toBe(201);
    const st = await w.owner.get(w.c(`/banking/reconcile?account_id=${w.acc.BANK}&date=2026-05-31`));
    expect(st.json.book_balance).toBe(1244100);
    expect(st.json.cleared_balance).toBe(1244100);
    const r = await w.owner.post(w.c("/banking/reconcile"), { account_id: w.acc.BANK, statement_date: "2026-05-31", statement_balance: "12441.00" });
    expect(r.status).toBe(201);
    const again = await w.owner.post(w.c("/banking/reconcile"), { account_id: w.acc.BANK, statement_date: "2026-05-31", statement_balance: "12441.00" });
    expect(again.status).toBe(409);
    // reconciled lines are frozen
    const locked = (await w.owner.get(w.c(`/banking/lines?account_id=${w.acc.BANK}`))).json.lines[0];
    expect((await w.owner.post(w.c(`/banking/lines/${locked.id}/unmatch`))).status).toBe(409);
  });
});

describe("recurring expense templates", () => {
  it("generates draft expenses for due periods and advances the schedule", async () => {
    const t = await w.owner.post(w.c("/expenses/templates"), {
      name: "Internet", frequency: "monthly", next_run_date: "2026-08-31",
      expense: { category_account_id: w.acc["6600"], paid_from_account_id: w.acc.BANK, description: "Broadband", amount: "999" },
    });
    expect(t.status).toBe(201);
    const run = await w.owner.post(w.c("/expenses/templates/run"));
    expect(run.json.created).toBeGreaterThanOrEqual(2); // Aug 31, Sep 30 (and Oct 31 is in the future)
    const list = await w.owner.get(w.c("/expenses?status=draft"));
    const dates = list.json.expenses.filter((e: any) => e.description === "Broadband").map((e: any) => e.expense_date).sort();
    expect(dates.slice(0, 2)).toEqual(["2026-08-31", "2026-09-30"]); // month-end clamped
    const again = await w.owner.post(w.c("/expenses/templates/run"));
    expect(again.json.created).toBe(0);
  });

  it("suggests expense categories from keywords (labelled, rule-based)", async () => {
    const s = await w.owner.get(w.c(`/expenses/suggest-category?description=${encodeURIComponent("Uber ride to client")}`));
    expect(s.json.suggestions[0].account_name).toBe("Travel & Conveyance");
  });
});
