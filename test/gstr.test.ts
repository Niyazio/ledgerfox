import { describe, expect, it, beforeAll } from "vitest";
import { world, contact, type World } from "./helpers";

/** Builds a GSTIN with a correct mod-36 check digit. */
function gstin(state: string, pan: string) {
  const body = `${state}${pan}1Z`;
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let total = 0;
  for (let i = 0; i < 14; i++) { const p = chars.indexOf(body[i]) * (i % 2 === 0 ? 1 : 2); total += Math.floor(p / 36) + (p % 36); }
  return body + chars[(36 - (total % 36)) % 36];
}

// Company in Karnataka (29). Hand-computed May 2026:
//  INV-1  registered customer, Karnataka: 2 × 500 @18%     taxable 1,000  CGST 90  SGST 90   → B2B
//  INV-2  unregistered, Maharashtra: 1 × 1,50,000 @18%      taxable 1,50,000 IGST 27,000      → B2CL (> ₹1 lakh)
//  INV-3  unregistered, Karnataka: 200 @5% + 100 exempt     taxable 200 CGST 5 SGST 5 + exempt 100 → B2CS + nil
//  INV-4  unregistered, Maharashtra: 1,000 @18%             taxable 1,000 IGST 180            → B2CS inter
//  INV-5  voided                                                                               → documents: 1 cancelled
//  CRN-1  credit note to the registered customer: 100 @18%  CGST 9 SGST 9                     → CDNR
//  BILL   registered supplier, Karnataka: 400 @18%          CGST 36 SGST 36                    → ITC
describe("GSTR-1 and GSTR-3B", () => {
  let W: World;
  const companyGstin = gstin("29", "AAACL1234F");
  const custGstin = gstin("29", "BBBCK5678G");
  beforeAll(async () => {
    W = await world();
    expect((await W.owner.patch(W.c("/settings"), { name: "Acme Traders", state_code: "29", tax_id: companyGstin })).status).toBe(200);
    const reg = await contact(W, "customer", { tax_id: custGstin, state_code: "29" });
    const mh = await contact(W, "customer", { state_code: "27" });
    const ka = await contact(W, "customer", { state_code: "29" });
    const supp = await contact(W, "supplier", { tax_id: gstin("29", "CCCDS9012H"), state_code: "29" });
    const g18 = W.tax["GST 18%"], g5 = W.tax["GST 5%"], ex = W.tax["GST Exempt"];
    const issue = async (doc_type: string, contact_id: string, lines: any[]) => {
      const d = await W.owner.post(W.c("/documents"), { doc_type, contact_id, issue_date: "2026-05-10", lines });
      expect(d.status, JSON.stringify(d.json)).toBe(201);
      expect((await W.owner.post(W.c(`/documents/${d.json.id}/issue`))).status).toBe(200);
      return d.json.id as string;
    };
    await issue("invoice", reg, [{ description: "Tea", hsn_sac: "0902", quantity: "2", unit_price: "500", tax_code_id: g18 }]);
    await issue("invoice", mh, [{ description: "Machine", hsn_sac: "8438", quantity: "1", unit_price: "150000", tax_code_id: g18 }]);
    await issue("invoice", ka, [{ description: "Rice", hsn_sac: "1006", quantity: "1", unit_price: "200", tax_code_id: g5 }, { description: "Fresh vegetables", hsn_sac: "0709", quantity: "1", unit_price: "100", tax_code_id: ex }]);
    await issue("invoice", mh, [{ description: "Tea", hsn_sac: "0902", quantity: "1", unit_price: "1000", tax_code_id: g18 }]);
    const v = await issue("invoice", ka, [{ description: "Wrong", hsn_sac: "0902", quantity: "1", unit_price: "10", tax_code_id: g18 }]);
    expect((await W.owner.post(W.c(`/documents/${v}/void`), { date: "2026-05-10", reason: "Mistake" })).status).toBe(200);
    await issue("credit_note", reg, [{ description: "Tea return", hsn_sac: "0902", quantity: "1", unit_price: "100", tax_code_id: g18 }]);
    await issue("bill", supp, [{ description: "Packing", hsn_sac: "4819", quantity: "1", unit_price: "400", tax_code_id: g18 }]);
  });

  it("prepares GSTR-1 tables in the offline-tool layout", async () => {
    const r = await W.owner.get(W.c("/reports/gstr1?period=2026-05"));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const j = r.json.json;
    expect(j.gstin).toBe(companyGstin);
    expect(j.fp).toBe("052026");
    expect(j.b2b).toEqual([{ ctin: custGstin, inv: [expect.objectContaining({ idt: "10-05-2026", val: 1180, pos: "29", rchrg: "N", inv_typ: "R",
      itms: [{ num: 1, itm_det: { rt: 18, txval: 1000, iamt: 0, camt: 90, samt: 90, csamt: 0 } }] })] }]);
    expect(j.b2cl).toEqual([{ pos: "27", inv: [expect.objectContaining({ val: 177000, itms: [{ num: 1, itm_det: { rt: 18, txval: 150000, iamt: 27000, csamt: 0 } }] })] }]);
    const b2cs = Object.fromEntries(j.b2cs.map((x: any) => [`${x.sply_ty}-${x.pos}-${x.rt}`, x]));
    expect(b2cs["INTRA-29-5"]).toMatchObject({ typ: "OE", txval: 200, camt: 5, samt: 5 });
    expect(b2cs["INTER-27-18"]).toMatchObject({ typ: "OE", txval: 1000, iamt: 180 });
    expect(Object.keys(b2cs)).toHaveLength(2); // the voided invoice is not reported
    expect(j.cdnr).toEqual([{ ctin: custGstin, nt: [expect.objectContaining({ ntty: "C", val: 118, itms: [{ num: 1, itm_det: { rt: 18, txval: 100, iamt: 0, camt: 9, samt: 9, csamt: 0 } }] })] }]);
    expect(j.nil.inv).toEqual([{ sply_ty: "INTRAB2C", expt_amt: 100, nil_amt: 0, ngsup_amt: 0 }]);
    const tea = j.hsn.hsn_b2b.find((h: any) => h.hsn_sc === "0902");
    expect(tea).toMatchObject({ uqc: "OTH", qty: 1, rt: 18, txval: 900, camt: 81, samt: 81 }); // 1,000 invoiced − 100 returned
    expect(j.hsn.hsn_b2c.find((h: any) => h.hsn_sc === "8438")).toMatchObject({ txval: 150000, iamt: 27000 });
    expect(j.doc_issue.doc_det).toEqual([
      { doc_num: 1, docs: [expect.objectContaining({ totnum: 5, cancel: 1, net_issue: 4 })] },
      { doc_num: 5, docs: [expect.objectContaining({ totnum: 1, cancel: 0, net_issue: 1 })] },
    ]);
    const sheets = (await W.owner.get(W.c("/reports/gstr1?period=2026-05&format=sheets"))).json.sheets;
    expect(sheets.b2b.rows).toEqual([[custGstin, expect.any(String), "10-05-2026", 1180, "29", "N", "Regular B2B", 18, 1000, 0, 90, 90, 0]]);
  });

  it("prepares GSTR-3B: outward supplies, inter-state to unregistered, input tax credit, net payable", async () => {
    const r = (await W.owner.get(W.c("/reports/gstr3b?period=2026-05"))).json;
    expect(r.sup_details.osup_det).toEqual({ txval: 152100, iamt: 27180, camt: 86, samt: 86, csamt: 0 });
    expect(r.sup_details.osup_nil_exmp).toEqual({ txval: 100 });
    expect(r.inter_sup.unreg_details).toEqual([{ pos: "27", txval: 151000, iamt: 27180 }]);
    expect(r.itc_elg.itc_net).toEqual({ iamt: 0, camt: 36, samt: 36, csamt: 0 });
    expect(r.net_payable_before_set_off).toEqual({ iamt: 27180, camt: 50, samt: 50 });
  });

  it("refuses without a GSTIN, a bad period or someone else's GSTIN", async () => {
    expect((await W.owner.get(W.c("/reports/gstr1?period=2026-13"))).status).toBe(400);
    expect((await W.owner.get(W.c(`/reports/gstr1?period=2026-05&gstin=${gstin("27", "ZZZZZ9999Z")}`))).status).toBe(400);
    const other = await world();
    expect((await other.owner.get(other.c("/reports/gstr1?period=2026-05"))).status).toBe(400);
  });
});
