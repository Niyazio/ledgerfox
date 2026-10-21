import { describe, expect, it, beforeAll } from "vitest";
import { world, contact, register, type World } from "./helpers";
import { splitAddress } from "../src/worker/services/einvoice";

function gstin(state: string, pan: string) {
  const body = `${state}${pan}1Z`;
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let total = 0;
  for (let i = 0; i < 14; i++) { const p = chars.indexOf(body[i]) * (i % 2 === 0 ? 1 : 2); total += Math.floor(p / 36) + (p % 36); }
  return body + chars[(36 - (total % 36)) % 36];
}

const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;

describe("e-invoice and e-way bill JSON", () => {
  let W: World;
  const ours = gstin("29", "AAACL1234F");
  const theirsKa = gstin("29", "BBBCK5678G");
  const theirsMh = gstin("27", "CCCDM9012H");
  let ka: string, mh: string, b2c: string, inv: string, crn: string, igstInv: string;
  const issue = async (doc_type: string, contact_id: string, lines: any[], extra: Record<string, unknown> = {}) => {
    const d = await W.owner.post(W.c("/documents"), { doc_type, contact_id, issue_date: "2026-05-10", lines, ...extra });
    expect(d.status, JSON.stringify(d.json)).toBe(201);
    const r = await W.owner.post(W.c(`/documents/${d.json.id}/issue`));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    return d.json.id as string;
  };

  beforeAll(async () => {
    W = await world({ roundOff: true });
    expect((await W.owner.patch(W.c("/settings"), {
      name: "Acme Traders", legal_name: "Acme Traders Pvt Ltd", state_code: "29", tax_id: ours,
      address: "No 12, MG Road", city: "Bengaluru", postal_code: "560001", phone: "+91 80 4123 4567", email: "accounts@acme.example", round_off_invoices: true,
    })).status).toBe(200);
    ka = await contact(W, "customer", { name: "Kaveri Stores", tax_id: theirsKa, state_code: "29", billing_address: "45 Industrial Area, Peenya\nBengaluru - 560 058" });
    mh = await contact(W, "customer", { name: "Pune Mart", tax_id: theirsMh, state_code: "27", billing_address: "Plot 7, MIDC Bhosari, Pune 411026" });
    b2c = await contact(W, "customer", { name: "Walk-in", state_code: "29" });
    const g18 = W.tax["GST 18%"];
    inv = await issue("invoice", ka, [
      { description: "Steel almirah", hsn_sac: "9403", quantity: "3", unit_price: "333.33", discount_percent: "10", tax_code_id: g18 },
      { description: "Installation", hsn_sac: "998719", quantity: "1", unit_price: "500", tax_code_id: g18 },
    ]);
    igstInv = await issue("invoice", mh, [{ description: "Steel almirah", hsn_sac: "9403", quantity: "200", unit_price: "333.33", tax_code_id: g18 }]);
    crn = await issue("credit_note", ka, [{ description: "Steel almirah returned", hsn_sac: "9403", quantity: "1", unit_price: "300", tax_code_id: g18 }], { related_doc_id: inv });
  });

  it("splits a free-text address into lines, place and PIN", () => {
    expect(splitAddress("45 Industrial Area, Peenya\nBengaluru - 560 058")).toEqual({ addr1: "45 Industrial Area, Peenya", addr2: "", loc: "Bengaluru", pin: "560058" });
    expect(splitAddress("Shop 3, Main Bazaar, Madurai 625001, Tamil Nadu")).toMatchObject({ pin: "625001", loc: "Tamil Nadu" });
    expect(splitAddress(null)).toEqual({ addr1: "", addr2: "", loc: "", pin: "" });
  });

  it("builds an IRP 1.1 invoice whose amounts reconcile the way the portal checks them", async () => {
    const r = await W.owner.post(W.c(`/documents/${inv}/gst/einvoice`), {});
    expect(r.status).toBe(200);
    expect(r.json.problems).toEqual([]);
    const j = r.json.json;
    expect(j).toMatchObject({
      Version: "1.1", TranDtls: { TaxSch: "GST", SupTyp: "B2B", RegRev: "N" }, DocDtls: { Typ: "INV", Dt: "10/05/2026" },
      SellerDtls: { Gstin: ours, LglNm: "Acme Traders Pvt Ltd", Addr1: "No 12, MG Road", Loc: "Bengaluru", Pin: 560001, Stcd: "29", Ph: "918041234567" },
      BuyerDtls: { Gstin: theirsKa, LglNm: "Kaveri Stores", Pos: "29", Addr1: "45 Industrial Area, Peenya", Loc: "Bengaluru", Pin: 560058, Stcd: "29" },
    });
    expect(j.DocDtls.No).toMatch(/^INV-\d+$/);
    const [goods, svc] = j.ItemList;
    expect(goods).toMatchObject({ SlNo: "1", IsServc: "N", HsnCd: "9403", Qty: 3, Unit: "OTH" /* free-text line: no unit known */, UnitPrice: 333.33, TotAmt: 999.99, GstRt: 18, IgstAmt: 0 });
    expect(svc).toMatchObject({ SlNo: "2", IsServc: "Y", HsnCd: "998719", Qty: 1, UnitPrice: 500, TotAmt: 500, Discount: 0, AssAmt: 500, CgstAmt: 45, SgstAmt: 45, TotItemVal: 590 });
    expect(svc.Unit).toBeUndefined();
    for (const it of j.ItemList) {
      expect(Math.abs(it.UnitPrice * it.Qty - it.TotAmt)).toBeLessThanOrEqual(0.01);
      expect(sum([it.TotAmt, -it.Discount])).toBe(it.AssAmt);
      expect(sum([it.AssAmt, it.CgstAmt, it.SgstAmt, it.IgstAmt, it.OthChrg])).toBe(it.TotItemVal);
    }
    expect(goods.AssAmt).toBe(899.99); // 999.99 less 10 % = 899.991, as the invoice computed it
    const v = j.ValDtls;
    expect(v.AssVal).toBe(sum(j.ItemList.map((i: any) => i.AssAmt)));
    expect(v.CgstVal).toBe(sum(j.ItemList.map((i: any) => i.CgstAmt)));
    expect(sum([...j.ItemList.map((i: any) => i.TotItemVal), v.RndOffAmt])).toBe(v.TotInvVal);
    const doc = (await W.owner.get(W.c(`/documents/${inv}`))).json.document;
    expect(v.TotInvVal).toBe(doc.total / 100);
    expect(Math.abs(v.RndOffAmt)).toBeLessThan(1); // the company rounds invoices to the rupee
  });

  it("uses IGST between states, refers credit notes to the invoice and lists what is missing", async () => {
    const igst = (await W.owner.post(W.c(`/documents/${igstInv}/gst/einvoice`), {})).json.json;
    expect(igst.BuyerDtls).toMatchObject({ Pos: "27", Stcd: "27", Loc: "Pune", Pin: 411026 });
    expect(igst.ItemList[0]).toMatchObject({ AssAmt: 66666, IgstAmt: 11999.88, CgstAmt: 0, SgstAmt: 0, TotItemVal: 78665.88 });
    expect(igst.ValDtls).toMatchObject({ RndOffAmt: 0.12, TotInvVal: 78666 });

    const cn = (await W.owner.post(W.c(`/documents/${crn}/gst/einvoice`), {})).json.json;
    const invNo = (await W.owner.get(W.c(`/documents/${inv}`))).json.document.number;
    expect(cn.DocDtls.Typ).toBe("CRN");
    expect(cn.RefDtls.PrecDocDtls).toEqual([{ InvNo: invNo, InvDt: "10/05/2026" }]);

    const plain = await issue("invoice", b2c, [{ description: "Chair", quantity: "1", unit_price: "100", tax_code_id: W.tax["GST 18%"] }]);
    const p = (await W.owner.post(W.c(`/documents/${plain}/gst/einvoice`), {})).json.problems.join(" | ");
    expect(p).toMatch(/no valid GSTIN/);
    expect(p).toMatch(/Customer address is missing/);
    expect(p).toMatch(/Customer PIN code must be 6 digits/);
    expect(p).toMatch(/Line 1 \(Chair\): HSN\/SAC code needed/);
    // Missing details can be supplied for the export without changing the customer.
    const fixed = (await W.owner.post(W.c(`/documents/${plain}/gst/einvoice`), { buyer: { addr1: "Main Road", loc: "Mysuru", pin: "570001" } })).json;
    expect(fixed.json.BuyerDtls).toMatchObject({ Addr1: "Main Road", Loc: "Mysuru", Pin: 570001 });
    expect(fixed.problems.join(" | ")).not.toMatch(/Customer/);

    const draft = await W.owner.post(W.c("/documents"), { doc_type: "invoice", contact_id: ka, issue_date: "2026-05-10", lines: [{ description: "x", hsn_sac: "9403", quantity: "1", unit_price: "1" }] });
    expect((await W.owner.post(W.c(`/documents/${draft.json.id}/gst/einvoice`), {})).json.problems).toContain("Issue the document first");
  });

  it("builds e-way bill JSON: outward for invoices, inward from the customer for sales returns", async () => {
    const r = await W.owner.post(W.c(`/documents/${igstInv}/gst/eway`), { vehicle_no: "ka 01 ab 1234", distance_km: 840, trans_mode: "1" });
    expect(r.json.problems).toEqual([]);
    const b = r.json.json.billLists[0];
    expect(r.json.json.version).toBeTruthy();
    expect(b).toMatchObject({
      userGstin: ours, supplyType: "O", subSupplyType: 1, docType: "INV", docDate: "10/05/2026", transType: 1,
      fromGstin: ours, fromPincode: 560001, fromStateCode: 29, toGstin: theirsMh, toPlace: "Pune", toPincode: 411026, toStateCode: 27,
      totalValue: 66666, igstValue: 11999.88, cgstValue: 0, OthValue: 0.12, totInvValue: 78666, transMode: 1, transDistance: 840, vehicleNo: "KA01AB1234", vehicleType: "R",
      mainHsnCode: 9403,
    });
    expect(b.itemList).toEqual([expect.objectContaining({ itemNo: 1, hsnCode: 9403, quantity: 200, qtyUnit: "OTH", taxableAmount: 66666, igstRate: 18, cgstRate: 0, sgstRate: 0 })]);

    const ret = (await W.owner.post(W.c(`/documents/${crn}/gst/eway`), { vehicle_no: "KA05MN4321" })).json.json.billLists[0];
    expect(ret).toMatchObject({ supplyType: "I", subSupplyType: 7, docType: "CNT", fromGstin: theirsKa, fromPincode: 560058, toGstin: ours, toPincode: 560001 });

    const bad = (await W.owner.post(W.c(`/documents/${igstInv}/gst/eway`), { vehicle_no: "12345" })).json.problems.join(" | ");
    expect(bad).toMatch(/does not look like an Indian registration number/);
    expect((await W.owner.post(W.c(`/documents/${igstInv}/gst/eway`), {})).json.problems.join(" | ")).toMatch(/Enter a vehicle number/);
    // Small invoices get a hint that an e-way bill is usually not needed.
    expect((await W.owner.post(W.c(`/documents/${inv}/gst/eway`), { vehicle_no: "KA01AB1234" })).json.problems.join(" | ")).toMatch(/₹50,000 or less/);
  });

  it("records the IRN, signed QR and e-way bill number; validates them; needs the right to issue", async () => {
    const irn = "a".repeat(32) + "0123456789abcdef0123456789ABCDEF";
    const qr = "eyJhbGciOiJSUzI1NiJ9.eyJkYXRhIjoiZGVtbyJ9.c2lnbmF0dXJl";
    const ok = await W.owner.put(W.c(`/documents/${inv}/gst/refs`), { irn, ack_no: "112410012345678", ack_date: "2026-05-10 14:32:00", signed_qr: qr, ewb_no: "", ewb_date: null });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    const refs = (await W.owner.get(W.c(`/documents/${inv}`))).json.gst_refs;
    expect(refs).toMatchObject({ irn: irn.toLowerCase(), ack_no: "112410012345678", signed_qr: qr, ewb_no: null, irn_cancelled: 0 });
    expect((await W.owner.put(W.c(`/documents/${inv}/gst/refs`), { irn: "short" })).status).toBe(400);
    expect((await W.owner.put(W.c(`/documents/${inv}/gst/refs`), { ewb_no: "1234" })).status).toBe(400);
    expect((await W.owner.put(W.c(`/documents/${igstInv}/gst/refs`), { ewb_no: "331000123456", ewb_date: "2026-05-10", ewb_valid_until: "2026-05-14" })).status).toBe(200);
    expect((await W.owner.get(W.c(`/documents/${igstInv}`))).json.gst_refs.ewb_no).toBe("331000123456");

    const { client, email } = await register(W.env, "Viewer");
    const invite = await W.owner.post(`/api/orgs/${W.orgId}/invitations`, { email, role: "viewer" });
    expect((await client.post("/api/invitations/accept", { token: invite.json.token })).status).toBe(200);
    expect((await client.post(W.c(`/documents/${inv}/gst/einvoice`), {})).status).toBe(200);
    expect((await client.put(W.c(`/documents/${inv}/gst/refs`), { irn })).status).toBe(403);
  });
});
