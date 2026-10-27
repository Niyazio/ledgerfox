import { describe, expect, it } from "vitest";
import { world, contact, type World } from "./helpers";

function gstin(state: string, pan: string) {
  const body = `${state}${pan}1Z`;
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let total = 0;
  for (let i = 0; i < 14; i++) { const p = chars.indexOf(body[i]) * (i % 2 === 0 ? 1 : 2); total += Math.floor(p / 36) + (p % 36); }
  return body + chars[(36 - (total % 36)) % 36];
}

/** Closing balance by account name (debit positive). */
async function balances(W: World) {
  const tb = (await W.owner.get(W.c("/reports/trial-balance?from=2026-04-01&to=2026-12-31"))).json;
  expect(tb.balanced).toBe(true);
  return Object.fromEntries(tb.rows.map((r: any) => [r.name, r.closing]));
}

async function issue(W: World, doc_type: string, contact_id: string, lines: any[], extra: Record<string, unknown> = {}) {
  const d = await W.owner.post(W.c("/documents"), { doc_type, contact_id, issue_date: "2026-05-10", lines, ...extra });
  expect(d.status, JSON.stringify(d.json)).toBe(201);
  const r = await W.owner.post(W.c(`/documents/${d.json.id}/issue`));
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return d.json.id as string;
}

describe("TDS on receipts and payments", () => {
  it("settles the full invoice or bill with cash plus TDS, and reverses cleanly", async () => {
    const W = await world();
    const cust = await contact(W, "customer"), supp = await contact(W, "supplier");
    const inv = await issue(W, "invoice", cust, [{ description: "Consulting", quantity: "1", unit_price: "10000" }]);
    const bill = await issue(W, "bill", supp, [{ description: "Contract work", quantity: "1", unit_price: "50000" }]);

    // Customer pays ₹9,800 and deducts ₹200 TDS (194J): the invoice is fully settled.
    const rcpt = await W.owner.post(W.c("/payments"), { direction: "in", contact_id: cust, payment_date: "2026-05-20", account_id: W.acc.BANK, amount: "9800", tds_amount: "200", tds_section: "194j", allocations: [{ document_id: inv, amount: "10000" }] });
    expect(rcpt.status, JSON.stringify(rcpt.json)).toBe(201);
    // We pay the contractor ₹49,000 after deducting ₹1,000 TDS (194C).
    const pay = await W.owner.post(W.c("/payments"), { direction: "out", contact_id: supp, payment_date: "2026-05-20", account_id: W.acc.BANK, amount: "49000", tds_amount: "1000", tds_section: "194C", allocations: [{ document_id: bill, amount: "50000" }] });
    expect(pay.status, JSON.stringify(pay.json)).toBe(201);
    const docs = async () => Promise.all([inv, bill].map(async (id) => { const d = (await W.owner.get(W.c(`/documents/${id}`))).json.document; return d.total - d.amount_settled; }));
    expect(await docs()).toEqual([0, 0]);
    let b = await balances(W);
    expect([b["TDS Receivable"], b["TDS Payable"]]).toEqual([20_000, -100_000]);
    expect((await W.owner.get(W.c(`/payments/${pay.json.id}`))).json.payment).toMatchObject({ amount: 4_900_000, tds_amount: 100_000, tds_section: "194C" });

    // Over-allocation counts the TDS; TDS on a foreign-currency payment is refused.
    const bill2 = await issue(W, "bill", supp, [{ description: "More work", quantity: "1", unit_price: "1000" }]);
    expect((await W.owner.post(W.c("/payments"), { direction: "out", contact_id: supp, payment_date: "2026-05-21", account_id: W.acc.BANK, amount: "900", tds_amount: "10", allocations: [{ document_id: bill2, amount: "1000" }] })).json.error.code).toBe("OVER_ALLOCATED");
    // An advance with TDS can be applied later in full (cash + TDS).
    const adv = await W.owner.post(W.c("/payments"), { direction: "out", contact_id: supp, payment_date: "2026-05-21", account_id: W.acc.BANK, amount: "990", tds_amount: "10", tds_section: "194C" });
    expect((await W.owner.post(W.c(`/payments/${adv.json.id}/apply`), { document_id: bill2, amount: "1000", date: "2026-05-22" })).status).toBe(200);

    // Voiding the supplier payment reopens the bill and removes the TDS liability.
    expect((await W.owner.post(W.c(`/payments/${pay.json.id}/void`), { date: "2026-05-25", reason: "test" })).status).toBe(200);
    expect(await docs()).toEqual([0, 5_000_000]);
    b = await balances(W);
    expect(b["TDS Payable"]).toBe(-1_000); // only the advance's ₹10 remains
  });
});

describe("GST reverse charge", () => {
  it("pays the supplier the value before tax, books the tax as credit and liability, and reports it in GSTR-3B", async () => {
    const W = await world();
    const ours = gstin("29", "AAACL1234F");
    expect((await W.owner.patch(W.c("/settings"), { name: "Acme Traders", state_code: "29", tax_id: ours })).status).toBe(200);
    const advocate = await contact(W, "supplier", { name: "Advocate", state_code: "29" });
    const cust = await contact(W, "customer", { state_code: "29" });
    const g18 = W.tax["GST 18%"];
    await issue(W, "invoice", cust, [{ description: "Goods", hsn_sac: "9403", quantity: "1", unit_price: "20000", tax_code_id: g18 }]);
    const bill = await issue(W, "bill", advocate, [{ description: "Legal fees", hsn_sac: "998213", quantity: "1", unit_price: "10000", tax_code_id: g18 }], { reverse_charge: true });
    const d = (await W.owner.get(W.c(`/documents/${bill}`))).json.document;
    expect([d.reverse_charge, d.tax_total, d.total]).toEqual([1, 180_000, 1_000_000]);
    const b = await balances(W);
    expect(b["Accounts Payable"]).toBe(-1_000_000);
    expect(b["GST Payable (Reverse Charge)"]).toBe(-180_000);
    expect([b["Input CGST"], b["Input SGST"]]).toEqual([90_000, 90_000]);

    const r = (await W.owner.get(W.c("/reports/gstr3b?period=2026-05"))).json;
    expect(r.sup_details.isup_rev).toEqual({ txval: 10_000, iamt: 0, camt: 900, samt: 900, csamt: 0 });
    expect(r.itc_elg.itc_avl).toEqual([
      { ty: "ISRC", iamt: 0, camt: 900, samt: 900, csamt: 0 },
      { ty: "OTH", iamt: 0, camt: 0, samt: 0, csamt: 0 },
    ]);
    expect(r.reverse_charge_cash).toEqual({ iamt: 0, camt: 900, samt: 900 });
    // Output CGST/SGST 1,800 each on the sale, less the 900 each reverse-charge credit, before set-off.
    expect(r.net_payable_before_set_off).toEqual({ iamt: 0, camt: 900, samt: 900 });

    // Not for sales documents.
    const bad = await W.owner.post(W.c("/documents"), { doc_type: "invoice", contact_id: cust, issue_date: "2026-05-10", reverse_charge: true, lines: [{ description: "x", quantity: "1", unit_price: "1" }] });
    expect(bad.status).toBe(400);
  });
});
