import { afterEach, describe, expect, it, vi } from "vitest";
import { world, contact, rawQuery } from "./helpers";

afterEach(() => vi.restoreAllMocks());
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function issue(W: any, doc: any) {
  const d = await W.owner.post(W.c("/documents"), doc);
  if (d.status !== 201) return d;
  return W.owner.post(W.c(`/documents/${d.json.id}/issue`)).then((r: any) => ({ ...r, id: d.json.id }));
}

describe("serial numbers", () => {
  it("brings serials in on a bill, sells them one by one, takes returns back, and finds any serial", async () => {
    const W = await world();
    const supp = await contact(W, "supplier");
    const cust = await contact(W, "customer", { name: "Ravi" });
    const phone = (await W.owner.post(W.c("/items"), { kind: "goods", name: "Phone X", sale_price: "20000", purchase_price: "15000", track_inventory: true, track_serials: true })).json.id;
    const missing = await issue(W, { doc_type: "bill", contact_id: supp, issue_date: day(-5), lines: [{ item_id: phone, description: "Phone X", quantity: "2", unit_price: "15000", serials: ["imei-111"] }] });
    expect(missing.json.error.code).toBe("SERIALS_REQUIRED");
    const bill = await issue(W, { doc_type: "bill", contact_id: supp, issue_date: day(-5), lines: [{ item_id: phone, description: "Phone X", quantity: "2", unit_price: "15000", serials: ["imei-111", "IMEI-222"] }] });
    expect(bill.status, JSON.stringify(bill.json)).toBe(200);
    const sold = await issue(W, { doc_type: "invoice", contact_id: cust, issue_date: day(-2), lines: [{ item_id: phone, description: "Phone X", quantity: "1", unit_price: "20000", serials: ["IMEI-111"] }] });
    expect(sold.status, JSON.stringify(sold.json)).toBe(200);
    expect((await issue(W, { doc_type: "invoice", contact_id: cust, issue_date: day(-1), lines: [{ item_id: phone, description: "Phone X", quantity: "1", unit_price: "20000", serials: ["IMEI-111"] }] })).json.error.code).toBe("SERIAL_NOT_IN_STOCK");
    const found = (await W.owner.get(W.c("/items/serials/find?q=111"))).json.serials[0];
    expect(found).toMatchObject({ serial: "IMEI-111", status: "out", item_name: "Phone X", customer: "Ravi", out_type: "invoice" });
    // A sales return (credit note from the invoice) brings the same serial back.
    const cn = (await W.owner.post(W.c(`/documents/${sold.id}/convert`), { to: "credit_note" })).json;
    expect((await W.owner.post(W.c(`/documents/${cn.id}/issue`))).status).toBe(200);
    const list = (await W.owner.get(W.c(`/items/${phone}/serials`))).json.serials;
    expect(list.map((s: any) => [s.serial, s.status])).toEqual([["IMEI-111", "in_stock"], ["IMEI-222", "in_stock"]]);
    // Cancelling the bill is refused while one of its serials has moved since.
    const again = await issue(W, { doc_type: "invoice", contact_id: cust, issue_date: day(0), lines: [{ item_id: phone, description: "Phone X", quantity: "1", unit_price: "20000", serials: ["IMEI-222"] }] });
    expect(again.status).toBe(200);
    expect((await W.owner.post(W.c(`/documents/${again.id}/void`), {})).status).toBe(200); // cancelled invoice → serial back in stock
    expect((await rawQuery(W, `SELECT status FROM item_serials WHERE serial = 'IMEI-222'`))[0].status).toBe("in_stock");
  });
});

describe("project time billing", () => {
  it("logs hours and turns the unbilled ones into a draft invoice, once", async () => {
    const W = await world();
    const cust = await contact(W, "customer", { name: "Acme Corp" });
    await W.owner.post(W.c("/settings/projects"), { code: "WEB", name: "Website rebuild" });
    const p = (await W.owner.get(W.c("/projects"))).json.projects[0];
    expect((await W.owner.post(W.c(`/projects/${p.id}/invoice`), {})).status).toBe(400); // no customer yet
    await W.owner.patch(W.c(`/projects/${p.id}/billing`), { contact_id: cust, hourly_rate: "1000" });
    await W.owner.post(W.c(`/projects/${p.id}/time`), { work_date: day(-2), hours: "1.5", description: "Design" });
    await W.owner.post(W.c(`/projects/${p.id}/time`), { work_date: day(-1), hours: 2, description: "Build", rate: "1200" });
    await W.owner.post(W.c(`/projects/${p.id}/time`), { work_date: day(-1), hours: 1, description: "Internal call", billable: false });
    expect((await W.owner.get(W.c("/projects"))).json.projects[0]).toMatchObject({ unbilled_minutes: 210, unbilled_amount: 390_000, total_minutes: 270 });
    const inv = await W.owner.post(W.c(`/projects/${p.id}/invoice`), {});
    expect(inv.json.entries).toBe(2);
    const doc = (await W.owner.get(W.c(`/documents/${inv.json.id}`))).json;
    expect(doc.document).toMatchObject({ status: "draft", contact_id: cust, total: 390_000 });
    expect(doc.lines.map((l: any) => [l.qty_milli, l.unit_price, l.project_id])).toEqual([[1500, 100_000, p.id], [2000, 120_000, p.id]]);
    expect((await W.owner.post(W.c(`/projects/${p.id}/invoice`), {})).status).toBe(400); // nothing unbilled now
    // Deleting the draft makes the hours billable again.
    await W.owner.del(W.c(`/documents/${inv.json.id}`));
    expect((await W.owner.get(W.c("/projects"))).json.projects[0].unbilled_minutes).toBe(210);
  });
});

describe("advances on quotations", () => {
  it("takes an advance against a quotation and applies it to the invoice made from it", async () => {
    const W = await world();
    const cust = await contact(W, "customer");
    const q = await issue(W, { doc_type: "quote", contact_id: cust, issue_date: day(-3), lines: [{ description: "Wedding cake", quantity: "1", unit_price: "9000", account_id: W.acc.SALES }] });
    const adv = await W.owner.post(W.c(`/documents/${q.id}/advance`), { amount: "3000", payment_date: day(-2), account_id: W.acc.CASH });
    expect(adv.status, JSON.stringify(adv.json)).toBe(201);
    expect((await W.owner.get(W.c(`/documents/${q.id}/advances`))).json.advances[0]).toMatchObject({ amount: 300_000, applied: 0 });
    const inv = (await W.owner.post(W.c(`/documents/${q.id}/convert`), { to: "invoice" })).json;
    expect((await W.owner.post(W.c(`/documents/${inv.id}/issue`))).status).toBe(200);
    expect((await W.owner.get(W.c(`/documents/${inv.id}`))).json.document.amount_settled).toBe(300_000);
    expect((await W.owner.get(W.c(`/documents/${q.id}/advances`))).json.advances[0].applied).toBe(300_000);
  });
});

describe("exchange rates", () => {
  it("fetches today's rate for the currencies in use and keeps a rate typed by hand", async () => {
    const W = await world();
    await contact(W, "customer", { name: "US client", currency: "USD", country: "US", state_code: "96" });
    await contact(W, "customer", { name: "Dubai client", currency: "AED", country: "AE" });
    await W.owner.post(W.c("/settings/exchange-rates"), { currency: "AED", rate_date: day(0), rate: "22.75" });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any) => {
      expect(String(url)).toBe("https://open.er-api.com/v6/latest/INR");
      return Response.json({ result: "success", rates: { INR: 1, USD: 0.012, AED: 0.044 } });
    });
    const r = (await W.owner.post(W.c("/settings/exchange-rates/fetch"))).json;
    expect(r.currencies).toEqual(["USD"]);
    const rates = await rawQuery(W, `SELECT currency, rate_scaled FROM exchange_rates WHERE rate_date = ? ORDER BY currency`, day(0));
    expect(rates).toEqual([{ currency: "AED", rate_scaled: 22_750_000_000 }, { currency: "USD", rate_scaled: 83_333_333_333 }]);
  });
});

describe("GSTR-2B matching", () => {
  it("matches supplier invoices by GSTIN and number, and lists what is missing on either side", async () => {
    const W = await world();
    const supp = await contact(W, "supplier", { name: "Steel Traders", tax_id: "29ABCDE1234F1ZW", state_code: "29" });
    const month = day(0).slice(0, 7);
    const d = (n: number) => `${month}-${String(n).padStart(2, "0")}`;
    const bill = (ref: string, amount: string) => issue(W, { doc_type: "bill", contact_id: supp, issue_date: d(1), reference: ref, lines: [{ description: "Steel", quantity: "1", unit_price: amount, account_id: W.acc.PURCHASES, tax_code_id: W.tax["GST 18%"] }] });
    await bill("ST/0077", "1000");
    await bill("ST-0078", "2000");
    await bill("ST-0079", "500");
    const file = { data: { rtnprd: `${month.slice(5)}${month.slice(0, 4)}`, docdata: { b2b: [{ ctin: "29ABCDE1234F1ZW", trdnm: "STEEL TRADERS", inv: [
      { inum: "ST-77", dt: `01-${month.slice(5)}-${month.slice(0, 4)}`, val: 1180, txval: 1000, cgst: 90, sgst: 90, igst: 0, cess: 0 },
      { inum: "ST-0078", dt: `01-${month.slice(5)}-${month.slice(0, 4)}`, val: 2950, txval: 2500, cgst: 225, sgst: 225, igst: 0, cess: 0 },
      { inum: "ST-0090", dt: `02-${month.slice(5)}-${month.slice(0, 4)}`, val: 590, txval: 500, cgst: 45, sgst: 45, igst: 0, cess: 0 },
    ] }] } } };
    const r = (await W.owner.post(W.c("/reports/gstr2b-match"), { file })).json;
    expect(r.counts).toEqual({ matched: 1, mismatch: 1, missing_in_books: 1, missing_in_2b: 1 });
    expect(r.rows.find((x: any) => x.status === "missing_in_2b").number).toBe("ST-0079");
    expect(r.tax).toMatchObject({ matched: 18_000, missing_in_books: 9_000, missing_in_2b: 9_000 });
    expect((await W.owner.post(W.c("/reports/gstr2b-match"), { file: { hello: 1 } })).status).toBe(400);
  });
});
