import { describe, expect, it } from "vitest";
import { world, contact, Client } from "./helpers";

describe("requests for quotation", () => {
  it("sends an RFQ to suppliers, takes quotes from the portal and from the buyer, compares them and awards a PO", async () => {
    const W = await world();
    const a = await contact(W, "supplier", { name: "Alpha Steel" });
    const b = await contact(W, "supplier", { name: "Beta Metals" });
    const cst = await contact(W, "supplier", { name: "Gamma Traders" });
    const r = await W.owner.post(W.c("/purchasing/rfqs"), { title: "Steel for March", respond_by: "2030-01-31", supplier_ids: [a, b, cst],
      lines: [{ description: "Steel rod 12mm", quantity: "100", unit: "kg" }, { description: "Steel sheet 2mm", quantity: "10", unit: "nos" }] });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.number).toBe("RFQ-0001");
    const x0 = (await W.owner.get(W.c(`/purchasing/rfqs/${r.json.id}`))).json;
    const [l1, l2] = x0.lines.map((l: any) => l.id);
    // Not open for quotes until sent.
    expect((await W.owner.post(W.c(`/purchasing/rfqs/${r.json.id}/quotes/${a}`), { prices: [{ line_id: l1, unit_price: "60" }] })).status).toBe(409);
    const sent = (await W.owner.post(W.c(`/purchasing/rfqs/${r.json.id}/send`))).json;
    expect(sent.links).toHaveLength(3);
    const tokenOf = (id: string) => sent.links.find((x: any) => x.contact_id === id).url.split("/portal/")[1];
    const pub = new Client(W.env);
    // Alpha quotes in the portal; Beta's emailed quote is typed in by the buyer; Gamma declines.
    const portal = (await pub.get(`/api/portal/${tokenOf(a)}`)).json;
    expect(portal.supplier.rfqs[0]).toMatchObject({ number: "RFQ-0001", my_status: "invited" });
    expect(portal.supplier.rfqs[0].lines).toHaveLength(2);
    expect((await pub.post(`/api/portal/${tokenOf(a)}/rfqs/${r.json.id}/quote`, { prices: [{ line_id: l1, unit_price: "62" }, { line_id: l2, unit_price: "900" }], delivery_days: 7 })).status).toBe(200);
    expect((await W.owner.post(W.c(`/purchasing/rfqs/${r.json.id}/quotes/${b}`), { prices: [{ line_id: l1, unit_price: "58" }, { line_id: l2, unit_price: "980" }], delivery_days: 10 })).status).toBe(200);
    expect((await pub.post(`/api/portal/${tokenOf(cst)}/rfqs/${r.json.id}/decline`, { notes: "Out of stock" })).status).toBe(200);
    // Another supplier's link cannot quote on an RFQ it was not sent.
    const other = await contact(W, "supplier", { name: "Not invited" });
    const otherToken = (await W.owner.post(W.c(`/collection/portal/${other}`), {})).json.token;
    expect((await pub.post(`/api/portal/${otherToken}/rfqs/${r.json.id}/quote`, { prices: [{ line_id: l1, unit_price: "1" }] })).status).toBe(404);
    const x = (await W.owner.get(W.c(`/purchasing/rfqs/${r.json.id}`))).json;
    expect(x.totals.find((t: any) => t.contact_id === a).total).toBe(1_520_000); // 100 × 62 + 10 × 900 = 15,200
    expect(x.totals.find((t: any) => t.contact_id === b).total).toBe(1_560_000); // 5,800 + 9,800
    expect(x.best).toBe(a);
    expect(x.lowest[l1]).toBe(5_800);
    const award = await W.owner.post(W.c(`/purchasing/rfqs/${r.json.id}/award`), { contact_id: a });
    expect(award.status, JSON.stringify(award.json)).toBe(201);
    const po = (await W.owner.get(W.c(`/documents/${award.json.po_id}`))).json;
    expect(po.document).toMatchObject({ doc_type: "purchase_order", status: "draft", contact_id: a, reference: "RFQ-0001" });
    expect(po.lines.map((l: any) => l.unit_price)).toEqual([6_200, 90_000]);
    expect((await W.owner.post(W.c(`/purchasing/rfqs/${r.json.id}/award`), { contact_id: b })).status).toBe(409);
    // The winner sees it was won; the others see they were not selected.
    expect((await pub.get(`/api/portal/${tokenOf(a)}`)).json.supplier.rfqs[0].outcome).toBe("won");
    expect((await pub.get(`/api/portal/${tokenOf(b)}`)).json.supplier.rfqs[0].outcome).toBe("not_selected");
  });
});

describe("goods receipt and 3-way match", () => {
  it("records what arrived and what was rejected, and flags short receipts, over-billing and higher prices", async () => {
    const W = await world();
    const s = await contact(W, "supplier", { name: "Alpha Steel" });
    const po = await W.owner.post(W.c("/documents"), { doc_type: "purchase_order", contact_id: s, issue_date: "2026-11-01",
      lines: [{ description: "Steel rod", quantity: "100", unit_price: "60", account_id: W.acc.PURCHASES }, { description: "Bolts", quantity: "50", unit_price: "5", account_id: W.acc.PURCHASES }] });
    expect((await W.owner.post(W.c("/purchasing/grns"), { po_id: po.json.id, lines: [{ line_no: 1, received: "10" }] })).status).toBe(409); // not issued
    await W.owner.post(W.c(`/documents/${po.json.id}/issue`));
    expect((await W.owner.get(W.c(`/purchasing/match/${po.json.id}`))).json.status).toBe("open");
    expect((await W.owner.post(W.c("/purchasing/grns"), { po_id: po.json.id, lines: [{ line_no: 1, received: "90", rejected: "5" }] })).status).toBe(400); // no reason
    const g = await W.owner.post(W.c("/purchasing/grns"), { po_id: po.json.id, supplier_ref: "DC-77", lines: [{ line_no: 1, received: "90", rejected: "5", reject_reason: "Rusted" }, { line_no: 2, received: "50" }] });
    expect(g.status, JSON.stringify(g.json)).toBe(201);
    expect(g.json.number).toBe("GRN-0001");
    // The supplier bills the full 100 rods at a higher price.
    const bill = await W.owner.post(W.c(`/documents/${po.json.id}/convert`), { to: "bill" });
    const draft = (await W.owner.get(W.c(`/documents/${bill.json.id}`))).json;
    const upd = await W.owner.put(W.c(`/documents/${bill.json.id}`), { doc_type: "bill", contact_id: s, issue_date: draft.document.issue_date, reference: "AS/991",
      lines: draft.lines.map((l: any, i: number) => ({ description: l.description, quantity: i === 0 ? "100" : "50", unit_price: i === 0 ? "62" : "5", account_id: W.acc.PURCHASES })) });
    expect(upd.status, JSON.stringify(upd.json)).toBe(200);
    expect((await W.owner.post(W.c(`/documents/${bill.json.id}/issue`))).status).toBe(200);
    const m = (await W.owner.get(W.c(`/purchasing/match/${po.json.id}`))).json;
    expect(m.status).toBe("mismatch");
    expect(m.rows[0]).toMatchObject({ ordered: 100_000, received: 90_000, accepted: 85_000, rejected: 5_000, billed: 100_000, order_price: 6_000, bill_price: 6_200 });
    expect(m.rows[0].issues).toEqual(expect.arrayContaining(["short_receipt", "billed_more_than_received", "price_above_order", "rejected"]));
    expect(m.rows[1].issues).toEqual([]);
    const list = (await W.owner.get(W.c("/purchasing/match"))).json.orders;
    expect(list[0]).toMatchObject({ status: "mismatch" });
    expect((await W.owner.get(W.c("/purchasing/grns"))).json.grns[0]).toMatchObject({ number: "GRN-0001", rejected: 5_000, supplier: "Alpha Steel" });
    // Cancelling the GRN takes its quantities out of the match.
    expect((await W.owner.post(W.c(`/purchasing/grns/${g.json.id}/void`), { reason: "Entered twice" })).status).toBe(200);
    expect((await W.owner.get(W.c(`/purchasing/match/${po.json.id}`))).json.rows[0].received).toBe(0);
  });
});
