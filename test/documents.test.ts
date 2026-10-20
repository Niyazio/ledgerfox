import { describe, expect, it, beforeAll } from "vitest";
import { world, contact, rawQuery, type World } from "./helpers";

let w: World;
let custIntra: string, custInter: string, supplier: string;
beforeAll(async () => {
  w = await world();
  custIntra = await contact(w, "customer", { state_code: "29" });
  custInter = await contact(w, "customer", { state_code: "27" });
  supplier = await contact(w, "supplier", { state_code: "29" });
});

const line = (description: string, quantity: string, unit_price: string, tax_code_id?: string, extra = {}) => ({ description, quantity, unit_price, tax_code_id, ...extra });

async function journalLines(entryId: string) {
  return rawQuery(w, `SELECT l.debit, l.credit, a.system_key, a.code FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = ?`, entryId);
}
function sumBy(lines: any[], key: string, side: "debit" | "credit") {
  return lines.filter((l) => l.system_key === key).reduce((t, l) => t + l[side], 0);
}

describe("sales invoice (intra-state GST)", () => {
  let invId: string;
  it("computes totals: 2×500.00 @18% + 1×250.50 @5% = 1,443.02", async () => {
    const r = await w.owner.post(w.c("/documents"), {
      doc_type: "invoice", contact_id: custIntra, issue_date: "2026-05-05",
      lines: [line("Consulting", "2", "500.00", w.tax["GST 18%"]), line("Books", "1", "250.50", w.tax["GST 5%"])],
    });
    expect(r.status).toBe(201);
    expect(r.json.totals).toMatchObject({ taxable_total: 125050, cgst: 9626, sgst: 9626, igst: 0, tax_total: 19252, total: 144302 });
    invId = r.json.id;
  });

  it("draft has no number and no ledger impact", async () => {
    const d = await w.owner.get(w.c(`/documents/${invId}`));
    expect(d.json.document.number).toBeNull();
    expect(d.json.document.journal_entry_id).toBeNull();
  });

  it("issuing posts a balanced journal: Dr AR / Cr Sales, CGST, SGST", async () => {
    const r = await w.owner.post(w.c(`/documents/${invId}/issue`));
    expect(r.status).toBe(200);
    expect(r.json.number).toBe("INV-00001");
    const d = await w.owner.get(w.c(`/documents/${invId}`));
    expect(d.json.document.status).toBe("posted");
    expect(d.json.document.due_date).toBe("2026-06-04"); // 30-day terms
    const lines = await journalLines(d.json.document.journal_entry_id);
    expect(sumBy(lines, "AR", "debit")).toBe(144302);
    expect(sumBy(lines, "SALES", "credit")).toBe(125050);
    expect(sumBy(lines, "OUT_CGST", "credit")).toBe(9626);
    expect(sumBy(lines, "OUT_SGST", "credit")).toBe(9626);
    expect(lines.reduce((t, l) => t + l.debit, 0)).toBe(lines.reduce((t, l) => t + l.credit, 0));
  });

  it("cannot be issued twice, edited or deleted after posting", async () => {
    expect((await w.owner.post(w.c(`/documents/${invId}/issue`))).status).toBe(409);
    expect((await w.owner.del(w.c(`/documents/${invId}`))).status).toBe(409);
    await expect(w.env.DB.prepare(`UPDATE documents SET total = 1 WHERE id = ?`).bind(invId).run()).rejects.toThrow(/POSTED_IMMUTABLE/);
    await expect(w.env.DB.prepare(`UPDATE document_lines SET unit_price = 1 WHERE document_id = ?`).bind(invId).run()).rejects.toThrow(/POSTED_IMMUTABLE/);
  });

  it("partial receipts reduce the outstanding balance; over-allocation is rejected", async () => {
    const p1 = await w.owner.post(w.c("/payments"), {
      direction: "in", contact_id: custIntra, payment_date: "2026-05-20", account_id: w.acc.BANK, amount: "1000.00",
      allocations: [{ document_id: invId, amount: "1000.00" }],
    });
    expect(p1.status).toBe(201);
    let d = await w.owner.get(w.c(`/documents/${invId}`));
    expect(d.json.document.total - d.json.document.amount_settled).toBe(44302);

    const over = await w.owner.post(w.c("/payments"), {
      direction: "in", contact_id: custIntra, payment_date: "2026-05-21", account_id: w.acc.BANK, amount: "500.00",
      allocations: [{ document_id: invId, amount: "500.00" }],
    });
    expect(over.status).toBe(422);

    const p2 = await w.owner.post(w.c("/payments"), {
      direction: "in", contact_id: custIntra, payment_date: "2026-05-21", account_id: w.acc.BANK, amount: "500.00",
      allocations: [{ document_id: invId, amount: "443.02" }],
    });
    expect(p2.status).toBe(201);
    d = await w.owner.get(w.c(`/documents/${invId}`));
    expect(d.json.document.amount_settled).toBe(144302);
    // the 56.98 surplus remains as an unapplied advance credited to AR for this customer
    const st = await w.owner.get(w.c(`/reports/statement/${custIntra}?from=2026-04-01&to=2026-12-31`));
    expect(st.json.closing).toBe(144302 - 100000 - 50000);
  });

  it("an invoice with payments cannot be voided", async () => {
    const r = await w.owner.post(w.c(`/documents/${invId}/void`), { date: "2026-05-25" });
    expect(r.status).toBe(409);
  });

  it("the database rejects over-allocation even when the API is bypassed", async () => {
    const pay = await rawQuery(w, `SELECT id FROM payments WHERE contact_id = ? LIMIT 1`, custIntra);
    await expect(w.env.DB.prepare(`INSERT INTO allocations (id, company_id, source_kind, payment_id, document_id, amount, allocation_date, created_by) VALUES ('zz', ?, 'payment', ?, ?, 1, '2026-05-25', (SELECT created_by FROM payments WHERE id = ?))`)
      .bind(w.companyId, pay[0].id, invId, pay[0].id).run()).rejects.toThrow(/OVER_ALLOCATED|CHECK/);
  });
});

describe("inter-state invoice, credit note and void", () => {
  let invId: string;
  it("uses IGST: 10 × 100.00 @18% = 1,180.00", async () => {
    const r = await w.owner.post(w.c("/documents"), { doc_type: "invoice", contact_id: custInter, issue_date: "2026-05-06", lines: [line("Widgets", "10", "100.00", w.tax["GST 18%"])] });
    expect(r.json.totals).toMatchObject({ igst: 18000, cgst: 0, total: 118000 });
    invId = r.json.id;
    await w.owner.post(w.c(`/documents/${invId}/issue`));
  });

  it("credit note for 2 units (236.00) is applied to the invoice automatically", async () => {
    const conv = await w.owner.post(w.c(`/documents/${invId}/convert`), { to: "credit_note" });
    expect(conv.status).toBe(201);
    const cn = await w.owner.get(w.c(`/documents/${conv.json.id}`));
    const upd = await w.owner.put(w.c(`/documents/${conv.json.id}`), {
      doc_type: "credit_note", contact_id: custInter, issue_date: "2026-05-08", related_doc_id: invId,
      lines: [line("Widgets returned", "2", "100.00", w.tax["GST 18%"])],
    });
    expect(upd.json.totals.total).toBe(23600);
    expect(cn.json.document.related_doc_id).toBe(invId);
    const iss = await w.owner.post(w.c(`/documents/${conv.json.id}/issue`));
    expect(iss.json.number).toBe("CN-00001");
    const inv = await w.owner.get(w.c(`/documents/${invId}`));
    expect(inv.json.document.total - inv.json.document.amount_settled).toBe(94400);
    const lines = await journalLines((await w.owner.get(w.c(`/documents/${conv.json.id}`))).json.document.journal_entry_id);
    expect(sumBy(lines, "AR", "credit")).toBe(23600);
    expect(sumBy(lines, "SALES", "debit")).toBe(20000);
    expect(sumBy(lines, "OUT_IGST", "debit")).toBe(3600);
  });

  it("voiding an unpaid invoice reverses its journal", async () => {
    const r = await w.owner.post(w.c("/documents"), { doc_type: "invoice", contact_id: custInter, issue_date: "2026-05-09", lines: [line("Service", "1", "1000.00")] });
    await w.owner.post(w.c(`/documents/${r.json.id}/issue`));
    const v = await w.owner.post(w.c(`/documents/${r.json.id}/void`), { date: "2026-05-10", reason: "Raised in error" });
    expect(v.status).toBe(200);
    const d = await w.owner.get(w.c(`/documents/${r.json.id}`));
    expect(d.json.document.status).toBe("void");
    const je = await rawQuery(w, `SELECT reversed_by_id FROM journal_entries WHERE id = ?`, d.json.document.journal_entry_id);
    expect(je[0].reversed_by_id).toBeTruthy();
    expect((await w.owner.post(w.c(`/documents/${r.json.id}/void`), {})).status).toBe(409);
  });

  it("journals created by documents cannot be reversed directly from the journal screen", async () => {
    const d = await w.owner.get(w.c(`/documents/${invId}`));
    const r = await w.owner.post(w.c(`/journals/${d.json.document.journal_entry_id}/reverse`), {});
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("SOURCE_MANAGED");
  });
});

describe("quotes and orders", () => {
  it("quote → sales order → invoice conversion keeps lines and links", async () => {
    const q = await w.owner.post(w.c("/documents"), { doc_type: "quote", contact_id: custIntra, issue_date: "2026-05-01", lines: [line("Design", "3", "1500.00", w.tax["GST 18%"])] });
    expect((await w.owner.post(w.c(`/documents/${q.json.id}/issue`))).json.number).toBe("QT-00001");
    const so = await w.owner.post(w.c(`/documents/${q.json.id}/convert`), { to: "sales_order" });
    await w.owner.post(w.c(`/documents/${so.json.id}/issue`));
    const inv = await w.owner.post(w.c(`/documents/${so.json.id}/convert`), { to: "invoice" });
    const d = await w.owner.get(w.c(`/documents/${inv.json.id}`));
    expect(d.json.document.status).toBe("draft");
    expect(d.json.document.total).toBe(531000); // 4,500 + 18%
    expect(d.json.document.related_doc_id).toBe(so.json.id);
    const qd = await w.owner.get(w.c(`/documents/${q.json.id}`));
    expect(qd.json.document.status).toBe("converted");
    // non-posting documents never touch the ledger
    expect(qd.json.document.journal_entry_id).toBeNull();
  });
});

describe("purchases", () => {
  it("bill posts Dr Purchases + input GST / Cr AP; payment settles it", async () => {
    const b = await w.owner.post(w.c("/documents"), { doc_type: "bill", contact_id: supplier, issue_date: "2026-05-07", reference: "SUP-778", lines: [line("Raw material", "5", "1000.00", w.tax["GST 18%"])] });
    expect(b.json.totals.total).toBe(590000);
    await w.owner.post(w.c(`/documents/${b.json.id}/issue`));
    const d = await w.owner.get(w.c(`/documents/${b.json.id}`));
    const lines = await journalLines(d.json.document.journal_entry_id);
    expect(sumBy(lines, "AP", "credit")).toBe(590000);
    expect(sumBy(lines, "PURCHASES", "debit")).toBe(500000);
    expect(sumBy(lines, "IN_CGST", "debit")).toBe(45000);
    expect(sumBy(lines, "IN_SGST", "debit")).toBe(45000);
    const dup = await w.owner.post(w.c("/documents"), { doc_type: "bill", contact_id: supplier, issue_date: "2026-05-08", reference: "SUP-778", lines: [line("Raw material", "5", "1000.00", w.tax["GST 18%"])] });
    expect(dup.json.warnings.length).toBeGreaterThan(0); // duplicate warning, not a block
    await w.owner.del(w.c(`/documents/${dup.json.id}`));
    const p = await w.owner.post(w.c("/payments"), { direction: "out", contact_id: supplier, payment_date: "2026-05-30", account_id: w.acc.BANK, amount: "5900.00", allocations: [{ document_id: b.json.id, amount: "5900.00" }] });
    expect(p.status).toBe(201);
    const after = await w.owner.get(w.c(`/documents/${b.json.id}`));
    expect(after.json.document.amount_settled).toBe(590000);
  });

  it("voiding a payment restores the outstanding balance", async () => {
    const b = await w.owner.post(w.c("/documents"), { doc_type: "bill", contact_id: supplier, issue_date: "2026-05-10", lines: [line("Packaging", "1", "300.00")] });
    await w.owner.post(w.c(`/documents/${b.json.id}/issue`));
    const p = await w.owner.post(w.c("/payments"), { direction: "out", contact_id: supplier, payment_date: "2026-05-11", account_id: w.acc.CASH, amount: "300.00", allocations: [{ document_id: b.json.id, amount: "300.00" }] });
    expect((await w.owner.post(w.c(`/payments/${p.json.id}/void`), { date: "2026-05-12" })).status).toBe(200);
    const d = await w.owner.get(w.c(`/documents/${b.json.id}`));
    expect(d.json.document.amount_settled).toBe(0);
    expect((await w.owner.post(w.c(`/payments/${p.json.id}/void`), {})).status).toBe(409);
  });
});

describe("foreign currency", () => {
  it("USD invoice at 83.00, receipt at 84.00 → realised FX gain of ₹1,000.00", async () => {
    const usd = await contact(w, "customer", { currency: "USD", country: "US", state_code: "96" });
    await w.owner.post(w.c("/settings/exchange-rates"), { currency: "USD", rate_date: "2026-05-01", rate: "83.00" });
    const inv = await w.owner.post(w.c("/documents"), { doc_type: "invoice", contact_id: usd, issue_date: "2026-05-10", lines: [line("Export services", "1", "1000.00", w.tax["GST 0% (Nil rated)"])] });
    expect(inv.json.totals.total_base).toBe(8300000);
    await w.owner.post(w.c(`/documents/${inv.json.id}/issue`));
    const rec = await w.owner.post(w.c("/payments"), { direction: "in", contact_id: usd, payment_date: "2026-06-10", account_id: w.acc.BANK, amount: "1000.00", fx_rate: "84", allocations: [{ document_id: inv.json.id, amount: "1000.00" }] });
    expect(rec.status).toBe(201);
    const lines = await journalLines(rec.json.journal_id);
    expect(sumBy(lines, "BANK", "debit")).toBe(8400000);
    expect(sumBy(lines, "AR", "credit")).toBe(8300000);
    expect(sumBy(lines, "FX_GAIN_LOSS", "credit")).toBe(100000);
    const fc = await rawQuery(w, `SELECT currency, amount_fc FROM journal_lines WHERE entry_id = ? AND account_id = ?`, rec.json.journal_id, w.acc.AR);
    expect(fc[0]).toMatchObject({ currency: "USD", amount_fc: 100000 });
  });

  it("requires an exchange rate when none is on file", async () => {
    const eur = await contact(w, "customer", { currency: "EUR", country: "DE" });
    const r = await w.owner.post(w.c("/documents"), { doc_type: "invoice", contact_id: eur, issue_date: "2026-05-10", lines: [line("x", "1", "10")] });
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe("RATE_REQUIRED");
  });
});

describe("invoice round-off", () => {
  it("rounds 118.48 to 118.00 and posts −0.48 to Rounding Off", async () => {
    const w2 = await world({ roundOff: true });
    const cust = await contact(w2, "customer", { state_code: "29" });
    const r = await w2.owner.post(w2.c("/documents"), { doc_type: "invoice", contact_id: cust, issue_date: "2026-05-05", lines: [line("Item", "1", "100.40", w2.tax["GST 18%"])] });
    expect(r.json.totals).toMatchObject({ cgst: 904, sgst: 904, round_off: -48, total: 11800 });
    await w2.owner.post(w2.c(`/documents/${r.json.id}/issue`));
    const d = await w2.owner.get(w2.c(`/documents/${r.json.id}`));
    const lines = await rawQuery(w2, `SELECT l.debit, l.credit, a.system_key FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = ?`, d.json.document.journal_entry_id);
    expect(lines.find((l) => l.system_key === "ROUND_OFF")).toMatchObject({ debit: 48, credit: 0 });
    expect(lines.find((l) => l.system_key === "AR")).toMatchObject({ debit: 11800 });
  });
});

describe("inventory (moving weighted average)", () => {
  let item: string;
  let wh2: string;
  it("purchases 10 @ 100 and 10 @ 120 → 20 units worth 2,200.00", async () => {
    const it = await w.owner.post(w.c("/items"), { kind: "goods", name: "Widget", sku: "WID-1", track_inventory: true, sale_price: "200", purchase_price: "100", reorder_level: "16" });
    item = it.json.id;
    for (const [q, p, dt] of [["10", "100.00", "2026-05-01"], ["10", "120.00", "2026-05-02"]]) {
      const b = await w.owner.post(w.c("/documents"), { doc_type: "bill", contact_id: supplier, issue_date: dt, lines: [line("Widget", q, p, undefined, { item_id: item })] });
      expect((await w.owner.post(w.c(`/documents/${b.json.id}/issue`))).status).toBe(200);
    }
    const v = await w.owner.get(w.c("/reports/inventory-valuation"));
    const row = v.json.items.find((i: any) => i.item_id === item);
    expect(row).toMatchObject({ qty_milli: 20000, value: 220000, avg_cost: 11000 });
  });

  it("sale of 5 costs 550.00 to COGS; valuation reconciles with the ledger", async () => {
    const inv = await w.owner.post(w.c("/documents"), { doc_type: "invoice", contact_id: custIntra, issue_date: "2026-05-03", lines: [line("Widget", "5", "200.00", undefined, { item_id: item })] });
    expect((await w.owner.post(w.c(`/documents/${inv.json.id}/issue`))).status).toBe(200);
    const d = await w.owner.get(w.c(`/documents/${inv.json.id}`));
    const lines = await journalLines(d.json.document.journal_entry_id);
    expect(sumBy(lines, "COGS", "debit")).toBe(55000);
    expect(sumBy(lines, "INVENTORY", "credit")).toBe(55000);
    const v = await w.owner.get(w.c("/reports/inventory-valuation"));
    expect(v.json.items.find((i: any) => i.item_id === item)).toMatchObject({ qty_milli: 15000, value: 165000, below_reorder: true });
    expect(v.json.reconciles).toBe(true);
  });

  it("overselling is blocked", async () => {
    const inv = await w.owner.post(w.c("/documents"), { doc_type: "invoice", contact_id: custIntra, issue_date: "2026-05-04", lines: [line("Widget", "50", "200.00", undefined, { item_id: item })] });
    const r = await w.owner.post(w.c(`/documents/${inv.json.id}/issue`));
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe("INSUFFICIENT_STOCK");
    await w.owner.del(w.c(`/documents/${inv.json.id}`));
  });

  it("transfers keep total value; adjustments post to inventory adjustments", async () => {
    const wh = await w.owner.post(w.c("/items/warehouses"), { name: "Branch store", code: "BR1" });
    wh2 = wh.json.id;
    const s = await w.owner.get(w.c("/settings"));
    const main = s.json.warehouses.find((x: any) => x.code === "MAIN").id;
    expect((await w.owner.post(w.c("/items/transfers"), { item_id: item, from_warehouse_id: main, to_warehouse_id: wh2, date: "2026-05-05", quantity: "5" })).status).toBe(201);
    const adj = await w.owner.post(w.c("/items/adjustments"), { item_id: item, warehouse_id: wh2, date: "2026-05-06", quantity: "-1" });
    expect(adj.status).toBe(201);
    expect(adj.json.value).toBe(-11000);
    const v = await w.owner.get(w.c("/reports/inventory-valuation"));
    expect(v.json.items.find((i: any) => i.item_id === item)).toMatchObject({ qty_milli: 14000, value: 154000 });
    expect(v.json.reconciles).toBe(true);
    await expect(w.env.DB.prepare(`DELETE FROM stock_moves`).run()).rejects.toThrow(/STOCK_IMMUTABLE/);
  });
});
