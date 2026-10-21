/**
 * GSTR-1 and GSTR-3B preparation from posted documents.
 *
 * Output follows the layout of the GSTN offline tool (JSON keys b2b, b2cl, b2cs, cdnr, cdnur, nil, hsn, doc_issue;
 * amounts in rupees with two decimals). It is a preparation aid: the user uploads the JSON or copies the tables into
 * the offline tool, which validates them before filing. Nothing is sent to the GST portal from here.
 */
import { all, first } from "../lib/db";
import type { CompanyRow } from "../env";
import { isValidGstin } from "@shared/tax";

/** B2C inter-state invoices above this value (₹1 lakh, in paise) are reported invoice-wise (B2CL). */
export const B2CL_LIMIT = 10_000_000;

/** Units → GST Unique Quantity Codes. Anything unknown is reported as OTH (others). */
const UQC: Record<string, string> = {
  nos: "NOS", pcs: "PCS", kg: "KGS", ltr: "LTR", mtr: "MTR", box: "BOX", bag: "BAG", case: "CTN", cum: "CBM", dzn: "DOZ",
  km: "KME", pkt: "PAC", set: "SET", sqft: "SQF", ton: "TON", strip: "NOS", plate: "NOS", glass: "NOS",
};
export const uqcFor = (unit: string | null | undefined) => UQC[(unit ?? "").toLowerCase()] ?? "OTH";

/** Paise → rupees with two decimals, as numbers (the offline tool expects numbers). */
const r = (paise: number) => Math.round(paise) / 100;
/** YYYY-MM-DD → DD-MM-YYYY. */
const gstDate = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;

interface LineRow {
  doc_id: string; doc_type: "invoice" | "credit_note"; number: string; issue_date: string; status: string; currency: string; total: number;
  place_of_supply: string | null; related_number: string | null; related_date: string | null;
  contact_name: string; contact_gstin: string | null; contact_state: string | null; branch_gstin: string | null;
  description: string; hsn_sac: string | null; qty_milli: number; unit: string | null;
  taxable: number; cgst: number; sgst: number; igst: number; other_tax: number; rate_bp: number | null; category: string | null;
}

export interface GstrOptions { period: string; gstin?: string | null }

function monthRange(period: string) {
  const [y, m] = period.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${period}-01`, to: `${period}-${String(last).padStart(2, "0")}`, fp: `${String(m).padStart(2, "0")}${y}` };
}

/** GSTINs this company reports under: the company's own plus any branch GSTINs. */
export async function companyGstins(db: D1Database, company: CompanyRow): Promise<string[]> {
  const rows = await all<{ gstin: string }>(db, `SELECT DISTINCT gstin FROM branches WHERE company_id = ? AND gstin IS NOT NULL AND gstin <> ''`, company.id);
  return [...new Set([company.tax_id ?? "", ...rows.map((x) => x.gstin)].filter((g) => g && isValidGstin(g)))];
}

async function outwardLines(db: D1Database, company: CompanyRow, from: string, to: string): Promise<LineRow[]> {
  return all<LineRow>(db,
    `SELECT d.id AS doc_id, d.doc_type, d.number, d.issue_date, d.status, d.currency, d.total, d.place_of_supply,
            rd.number AS related_number, rd.issue_date AS related_date,
            ct.name AS contact_name, ct.tax_id AS contact_gstin, ct.state_code AS contact_state, b.gstin AS branch_gstin,
            l.description, COALESCE(l.hsn_sac, i.hsn_sac) AS hsn_sac, l.qty_milli, i.unit,
            l.taxable, l.cgst, l.sgst, l.igst, l.other_tax, t.rate_bp, t.category
     FROM documents d JOIN document_lines l ON l.document_id = d.id JOIN contacts ct ON ct.id = d.contact_id
     LEFT JOIN documents rd ON rd.id = d.related_doc_id LEFT JOIN branches b ON b.id = d.branch_id
     LEFT JOIN items i ON i.id = l.item_id LEFT JOIN tax_codes t ON t.id = l.tax_code_id
     WHERE d.company_id = ? AND d.doc_type IN ('invoice','credit_note') AND d.status IN ('posted','void')
       AND d.number IS NOT NULL AND d.issue_date BETWEEN ? AND ?
     ORDER BY d.issue_date, d.number, l.line_no`, company.id, from, to);
}

/** Which GSTIN a document belongs to: its branch's GSTIN, else the company's. */
const docGstin = (l: LineRow, company: CompanyRow) => (l.branch_gstin && isValidGstin(l.branch_gstin) ? l.branch_gstin : company.tax_id ?? "");

type Tax = { txval: number; iamt: number; camt: number; samt: number; csamt: number };
const zero = (): Tax => ({ txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 });
const addTax = (t: Tax, l: { taxable: number; igst: number; cgst: number; sgst: number }, sign = 1) => {
  t.txval += sign * l.taxable; t.iamt += sign * l.igst; t.camt += sign * l.cgst; t.samt += sign * l.sgst;
};
const rupees = (t: Tax) => ({ txval: r(t.txval), iamt: r(t.iamt), camt: r(t.camt), samt: r(t.samt), csamt: r(t.csamt) });

export async function gstr1(db: D1Database, company: CompanyRow, opts: GstrOptions) {
  const { from, to, fp } = monthRange(opts.period);
  const gstin = opts.gstin || company.tax_id || "";
  const homeState = gstin.slice(0, 2) || company.state_code || "";
  const all_ = (await outwardLines(db, company, from, to)).filter((l) => docGstin(l, company) === gstin);
  const warnings: string[] = [];
  const foreign = new Set(all_.filter((l) => l.currency !== company.base_currency).map((l) => l.number));
  if (foreign.size) warnings.push(`${foreign.size} foreign-currency document(s) (${[...foreign].slice(0, 5).join(", ")}) are left out: exports (EXP table) are not prepared yet.`);
  const lines = all_.filter((l) => l.currency === company.base_currency);
  const posted = lines.filter((l) => l.status === "posted");
  const missingHsn = new Set(posted.filter((l) => !l.hsn_sac && l.category === "standard").map((l) => l.number));
  if (missingHsn.size) warnings.push(`${missingHsn.size} document(s) have lines without an HSN/SAC code: ${[...missingHsn].slice(0, 5).join(", ")}.`);

  // Group lines into documents.
  const docs = new Map<string, { head: LineRow; lines: LineRow[] }>();
  for (const l of posted) {
    const d = docs.get(l.doc_id) ?? { head: l, lines: [] };
    d.lines.push(l);
    docs.set(l.doc_id, d);
  }

  const b2b = new Map<string, any[]>(), cdnr = new Map<string, any[]>();
  const b2cl = new Map<string, any[]>(), cdnur: any[] = [];
  const b2cs = new Map<string, Tax & { sply_ty: string; pos: string; rt: number }>();
  const nil = new Map<string, { expt_amt: number; nil_amt: number; ngsup_amt: number }>();
  const hsn = { b2b: new Map<string, any>(), b2c: new Map<string, any>() };

  for (const { head, lines: ls } of docs.values()) {
    const registered = !!head.contact_gstin && isValidGstin(head.contact_gstin);
    const pos = head.place_of_supply || head.contact_state || homeState;
    const inter = pos !== homeState;
    const sign = head.doc_type === "credit_note" ? -1 : 1;
    // Items grouped by rate (the return reports one row per rate per document).
    const byRate = new Map<number, Tax>();
    for (const l of ls) {
      if (l.category && l.category !== "standard") {
        const key = `${inter ? "INTR" : "INTRA"}${registered ? "B2B" : "B2C"}`;
        const n = nil.get(key) ?? { expt_amt: 0, nil_amt: 0, ngsup_amt: 0 };
        if (l.category === "exempt") n.expt_amt += sign * l.taxable;
        else if (l.category === "nil") n.nil_amt += sign * l.taxable;
        else n.ngsup_amt += sign * l.taxable;
        nil.set(key, n);
        continue;
      }
      const rt = (l.rate_bp ?? 0) / 100;
      const t = byRate.get(rt) ?? zero();
      addTax(t, l);
      byRate.set(rt, t);
      // HSN summary (credit notes reduce the figures).
      const h = registered ? hsn.b2b : hsn.b2c;
      const code = l.hsn_sac || "";
      const k = `${code}|${uqcFor(l.unit)}|${rt}`;
      const e = h.get(k) ?? { hsn_sc: code, desc: l.description.slice(0, 30), uqc: uqcFor(l.unit), qty: 0, rt, ...zero() };
      e.qty += sign * l.qty_milli;
      addTax(e, l, sign);
      h.set(k, e);
    }
    if (!byRate.size) continue;
    const itms = [...byRate.entries()].map(([rt, t], i) => ({ num: i + 1, itm_det: { rt, ...rupees(t) } }));
    const val = r(head.total);
    if (head.doc_type === "invoice") {
      if (registered) {
        const list = b2b.get(head.contact_gstin!) ?? [];
        list.push({ inum: head.number, idt: gstDate(head.issue_date), val, pos, rchrg: "N", inv_typ: "R", itms });
        b2b.set(head.contact_gstin!, list);
      } else if (inter && head.total > B2CL_LIMIT) {
        const list = b2cl.get(pos) ?? [];
        list.push({ inum: head.number, idt: gstDate(head.issue_date), val, itms: itms.map((x) => ({ num: x.num, itm_det: { rt: x.itm_det.rt, txval: x.itm_det.txval, iamt: x.itm_det.iamt, csamt: 0 } })) });
        b2cl.set(pos, list);
      } else {
        for (const [rt, t] of byRate) {
          const k = `${inter ? "INTER" : "INTRA"}|${pos}|${rt}`;
          const e = b2cs.get(k) ?? { sply_ty: inter ? "INTER" : "INTRA", pos, rt, ...zero() };
          addTax(e, { taxable: t.txval, igst: t.iamt, cgst: t.camt, sgst: t.samt });
          b2cs.set(k, e);
        }
      }
    } else {
      const note = { nt_num: head.number, nt_dt: gstDate(head.issue_date), ntty: "C", val, pos, rchrg: "N", inv_typ: "R", itms };
      if (registered) {
        const list = cdnr.get(head.contact_gstin!) ?? [];
        list.push(note);
        cdnr.set(head.contact_gstin!, list);
      } else if (inter && head.total > B2CL_LIMIT) {
        cdnur.push({ typ: "B2CL", ...note });
      } else {
        // Small B2C credit notes are netted against the B2CS figures for the same state and rate.
        for (const [rt, t] of byRate) {
          const k = `${inter ? "INTER" : "INTRA"}|${pos}|${rt}`;
          const e = b2cs.get(k) ?? { sply_ty: inter ? "INTER" : "INTRA", pos, rt, ...zero() };
          addTax(e, { taxable: t.txval, igst: t.iamt, cgst: t.camt, sgst: t.samt }, -1);
          b2cs.set(k, e);
        }
      }
    }
  }

  // Documents issued: number range per type, with cancelled (void) counts.
  const docIssue = (["invoice", "credit_note"] as const).map((type, i) => {
    const nums = [...new Map(lines.filter((l) => l.doc_type === type).map((l) => [l.doc_id, l])).values()];
    if (!nums.length) return null;
    const sorted = nums.map((n) => n.number).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const cancelled = nums.filter((n) => n.status === "void").length;
    return { doc_num: i === 0 ? 1 : 5, docs: [{ num: 1, from: sorted[0], to: sorted[sorted.length - 1], totnum: nums.length, cancel: cancelled, net_issue: nums.length - cancelled }] };
  }).filter(Boolean);

  const hsnRows = (m: Map<string, any>) => [...m.values()].map((e, i) => ({ num: i + 1, hsn_sc: e.hsn_sc, desc: e.desc, uqc: e.uqc, qty: e.qty / 1000, rt: e.rt, ...rupees(e) }));
  const json = {
    gstin, fp, version: "GST3.2", hash: "hash",
    b2b: [...b2b.entries()].map(([ctin, inv]) => ({ ctin, inv })),
    b2cl: [...b2cl.entries()].map(([pos, inv]) => ({ pos, inv })),
    b2cs: [...b2cs.values()].filter((e) => e.txval).map((e) => ({ sply_ty: e.sply_ty, pos: e.pos, typ: "OE", rt: e.rt, ...rupees(e), ...(e.sply_ty === "INTER" ? { camt: undefined, samt: undefined } : { iamt: undefined }) })),
    cdnr: [...cdnr.entries()].map(([ctin, nt]) => ({ ctin, nt })),
    cdnur,
    nil: { inv: [...nil.entries()].map(([sply_ty, n]) => ({ sply_ty, expt_amt: r(n.expt_amt), nil_amt: r(n.nil_amt), ngsup_amt: r(n.ngsup_amt) })) },
    hsn: { hsn_b2b: hsnRows(hsn.b2b), hsn_b2c: hsnRows(hsn.b2c) },
    doc_issue: { doc_det: docIssue },
  };
  const sum = (rows: { itm_det: Tax }[]) => rows.reduce((t, x) => ({ txval: t.txval + x.itm_det.txval, tax: t.tax + x.itm_det.iamt + (x.itm_det.camt ?? 0) + (x.itm_det.samt ?? 0) }), { txval: 0, tax: 0 });
  const summary = {
    b2b: { invoices: json.b2b.reduce((n, x) => n + x.inv.length, 0), ...sum(json.b2b.flatMap((x) => x.inv.flatMap((i: any) => i.itms))) },
    b2cl: { invoices: json.b2cl.reduce((n, x) => n + x.inv.length, 0), ...sum(json.b2cl.flatMap((x) => x.inv.flatMap((i: any) => i.itms))) },
    b2cs: { rows: json.b2cs.length, txval: json.b2cs.reduce((t, x) => t + x.txval, 0), tax: json.b2cs.reduce((t, x) => t + (x.iamt ?? 0) + (x.camt ?? 0) + (x.samt ?? 0), 0) },
    cdnr: { notes: json.cdnr.reduce((n, x) => n + x.nt.length, 0), ...sum(json.cdnr.flatMap((x) => x.nt.flatMap((i: any) => i.itms))) },
    cdnur: { notes: cdnur.length },
  };
  return { period: opts.period, gstin, json, summary, warnings, gstins: await companyGstins(db, company) };
}

/** GSTR-3B tables 3.1, 3.2, 4 and 5 from the same documents plus bills, debit notes and expenses. */
export async function gstr3b(db: D1Database, company: CompanyRow, opts: GstrOptions) {
  const { from, to } = monthRange(opts.period);
  const g1 = await gstr1(db, company, opts);
  const gstin = g1.gstin;
  const homeState = gstin.slice(0, 2) || company.state_code || "";
  const out = zero(), nilOut = { nil_exempt: 0, non_gst: 0 };
  const lines = (await outwardLines(db, company, from, to)).filter((l) => docGstin(l, company) === gstin && l.status === "posted" && l.currency === company.base_currency);
  const interUnreg = new Map<string, { txval: number; iamt: number }>();
  for (const l of lines) {
    const sign = l.doc_type === "credit_note" ? -1 : 1;
    if (l.category && l.category !== "standard") {
      if (l.category === "non_gst") nilOut.non_gst += sign * l.taxable; else nilOut.nil_exempt += sign * l.taxable;
      continue;
    }
    addTax(out, l, sign);
    const pos = l.place_of_supply || l.contact_state || homeState;
    if (pos !== homeState && !(l.contact_gstin && isValidGstin(l.contact_gstin))) {
      const e = interUnreg.get(pos) ?? { txval: 0, iamt: 0 };
      e.txval += sign * l.taxable; e.iamt += sign * l.igst;
      interUnreg.set(pos, e);
    }
  }
  // Inward: supplier bills and debit notes (base currency), and posted expenses with GST.
  const inward = await all<{ doc_type: string; taxable: number; cgst: number; sgst: number; igst: number; category: string | null; inter: number }>(db,
    `SELECT d.doc_type, l.taxable, l.cgst, l.sgst, l.igst, t.category, CASE WHEN d.tax_mode = 'inter' THEN 1 ELSE 0 END AS inter
     FROM documents d JOIN document_lines l ON l.document_id = d.id LEFT JOIN tax_codes t ON t.id = l.tax_code_id LEFT JOIN branches b ON b.id = d.branch_id
     WHERE d.company_id = ? AND d.doc_type IN ('bill','debit_note') AND d.status = 'posted' AND d.currency = ? AND d.issue_date BETWEEN ? AND ?
       AND COALESCE(NULLIF(b.gstin,''), ?) = ?`, company.id, company.base_currency, from, to, company.tax_id ?? "", gstin);
  const itc = zero(), exemptIn = { inter: 0, intra: 0 };
  for (const l of inward) {
    const sign = l.doc_type === "debit_note" ? -1 : 1;
    if (l.category && l.category !== "standard") { exemptIn[l.inter ? "inter" : "intra"] += sign * l.taxable; continue; }
    addTax(itc, l, sign);
  }
  const exp = await all<{ tax_amount: number; tax_mode: string; amount: number; fx: number }>(db,
    `SELECT e.tax_amount, e.tax_mode, e.amount, e.fx_rate_scaled AS fx FROM expenses e LEFT JOIN branches b ON b.id = e.branch_id
     WHERE e.company_id = ? AND e.status = 'posted' AND e.tax_amount > 0 AND e.currency = ? AND e.expense_date BETWEEN ? AND ?
       AND COALESCE(NULLIF(b.gstin,''), ?) = ?`, company.id, company.base_currency, from, to, company.tax_id ?? "", gstin);
  for (const e of exp) {
    itc.txval += e.amount;
    if (e.tax_mode === "inter") itc.iamt += e.tax_amount;
    else { const half = Math.floor(e.tax_amount / 2); itc.camt += half; itc.samt += e.tax_amount - half; }
  }
  const payable = { iamt: out.iamt - itc.iamt, camt: out.camt - itc.camt, samt: out.samt - itc.samt };
  const companyName = (await first<{ name: string }>(db, `SELECT COALESCE(legal_name, name) AS name FROM companies WHERE id = ?`, company.id))?.name;
  return {
    period: opts.period, gstin, legal_name: companyName,
    sup_details: {
      osup_det: rupees(out),
      osup_zero: rupees(zero()),
      osup_nil_exmp: { txval: r(nilOut.nil_exempt) },
      isup_rev: rupees(zero()),
      osup_nongst: { txval: r(nilOut.non_gst) },
    },
    inter_sup: { unreg_details: [...interUnreg.entries()].map(([pos, e]) => ({ pos, txval: r(e.txval), iamt: r(e.iamt) })) },
    itc_elg: { itc_avl: [{ ty: "OTH", iamt: r(itc.iamt), camt: r(itc.camt), samt: r(itc.samt), csamt: 0 }], itc_net: { iamt: r(itc.iamt), camt: r(itc.camt), samt: r(itc.samt), csamt: 0 } },
    inward_sup: { isup_details: [{ ty: "GST", inter: r(exemptIn.inter), intra: r(exemptIn.intra) }] },
    net_payable_before_set_off: { iamt: r(payable.iamt), camt: r(payable.camt), samt: r(payable.samt) },
    warnings: [
      ...g1.warnings,
      "Input tax credit is taken from your bills and expenses. Check it against GSTR-2B before filing; reverse charge, ineligible credit and reversals are not calculated.",
      "Net payable is before set-off and before any cash/credit ledger balance; the portal applies the utilisation order.",
    ],
  };
}

/** Flat tables matching the offline tool's Excel sheets, for CSV download. */
export function gstr1Sheets(g: Awaited<ReturnType<typeof gstr1>>) {
  const j = g.json;
  return {
    b2b: { head: ["GSTIN/UIN of Recipient", "Invoice Number", "Invoice date", "Invoice Value", "Place Of Supply", "Reverse Charge", "Invoice Type", "Rate", "Taxable Value", "Integrated Tax", "Central Tax", "State/UT Tax", "Cess Amount"],
      rows: j.b2b.flatMap((x) => x.inv.flatMap((i: any) => i.itms.map((t: any) => [x.ctin, i.inum, i.idt, i.val, i.pos, "N", "Regular B2B", t.itm_det.rt, t.itm_det.txval, t.itm_det.iamt, t.itm_det.camt, t.itm_det.samt, 0]))) },
    b2cl: { head: ["Invoice Number", "Invoice date", "Invoice Value", "Place Of Supply", "Rate", "Taxable Value", "Integrated Tax", "Cess Amount"],
      rows: j.b2cl.flatMap((x) => x.inv.flatMap((i: any) => i.itms.map((t: any) => [i.inum, i.idt, i.val, x.pos, t.itm_det.rt, t.itm_det.txval, t.itm_det.iamt, 0]))) },
    b2cs: { head: ["Type", "Place Of Supply", "Rate", "Taxable Value", "Integrated Tax", "Central Tax", "State/UT Tax", "Cess Amount"],
      rows: j.b2cs.map((x: any) => ["OE", x.pos, x.rt, x.txval, x.iamt ?? 0, x.camt ?? 0, x.samt ?? 0, 0]) },
    cdnr: { head: ["GSTIN/UIN of Recipient", "Note Number", "Note Date", "Note Type", "Place Of Supply", "Note Value", "Rate", "Taxable Value", "Integrated Tax", "Central Tax", "State/UT Tax", "Cess Amount"],
      rows: j.cdnr.flatMap((x) => x.nt.flatMap((n: any) => n.itms.map((t: any) => [x.ctin, n.nt_num, n.nt_dt, "C", n.pos, n.val, t.itm_det.rt, t.itm_det.txval, t.itm_det.iamt, t.itm_det.camt, t.itm_det.samt, 0]))) },
    hsn: { head: ["Section", "HSN", "Description", "UQC", "Total Quantity", "Rate", "Taxable Value", "Integrated Tax", "Central Tax", "State/UT Tax", "Cess Amount"],
      rows: [...j.hsn.hsn_b2b.map((h: any) => ["B2B", h.hsn_sc, h.desc, h.uqc, h.qty, h.rt, h.txval, h.iamt, h.camt, h.samt, 0]), ...j.hsn.hsn_b2c.map((h: any) => ["B2C", h.hsn_sc, h.desc, h.uqc, h.qty, h.rt, h.txval, h.iamt, h.camt, h.samt, 0])] },
    docs: { head: ["Nature of Document", "Sr. No. From", "Sr. No. To", "Total Number", "Cancelled"],
      rows: j.doc_issue.doc_det.map((d: any) => [d.doc_num === 1 ? "Invoices for outward supply" : "Credit Note", d.docs[0].from, d.docs[0].to, d.docs[0].totnum, d.docs[0].cancel]) },
  };
}
