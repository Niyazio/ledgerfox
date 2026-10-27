/**
 * e-invoice (IRP schema 1.1) and e-way bill (bulk upload) JSON for one document.
 *
 * LedgerFox does not talk to the IRP or the e-way bill system (that needs a paid GSP or direct-API eligibility).
 * The user downloads the JSON, uploads it on the free government portal (einvoice1.gst.gov.in /
 * ewaybillgst.gov.in), and records the IRN, acknowledgement, signed QR and e-way bill number back here so they print
 * on the invoice. The portals validate every field; `problems` lists what we can already see is missing.
 */
import { all, first } from "../lib/db";
import type { CompanyRow } from "../env";
import { isValidGstin } from "@shared/tax";
import { uqcFor } from "./gstr";

const r2 = (paise: number) => Math.round(paise) / 100;
const q3 = (milli: number) => Math.round(milli) / 1000;
/** YYYY-MM-DD → DD/MM/YYYY (both portals). */
export const slashDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

export interface Place { addr1: string; addr2: string; loc: string; pin: string }

/** Best effort split of a free-text address into the portal's fields: lines, place and the last 6-digit PIN. */
export function splitAddress(text: string | null | undefined, knownPlace = false): Place {
  const raw = (text ?? "").replace(/\r/g, "");
  const pin = [...raw.matchAll(/(?<!\d)([1-9]\d{2}\s?\d{3})(?!\d)/g)].map((m) => m[1].replace(/\s/g, "")).pop() ?? "";
  const parts = raw.replace(/(?<!\d)[1-9]\d{2}\s?\d{3}(?!\d)/g, "").split(/[\n,]+/).map((s) => s.replace(/[-–\s]+$/, "").trim()).filter(Boolean);
  // Without a separate city field, the last part of the address is taken as the place.
  const loc = !knownPlace && parts.length > 1 ? parts[parts.length - 1] : "";
  const street = loc ? parts.slice(0, -1) : parts;
  const addr1 = street.join(", ").slice(0, 100);
  const addr2 = street.join(", ").slice(100, 200);
  return { addr1, addr2, loc: loc.slice(0, 50), pin };
}

export interface PartyOverrides { addr1?: string | null; addr2?: string | null; loc?: string | null; pin?: string | null }
export interface EinvoiceOverrides { seller?: PartyOverrides; buyer?: PartyOverrides }
export interface EwayOptions extends EinvoiceOverrides {
  sub_supply_type?: number | null; sub_supply_desc?: string | null;
  trans_mode?: "1" | "2" | "3" | "4" | null; distance_km?: number | null;
  transporter_id?: string | null; transporter_name?: string | null; trans_doc_no?: string | null; trans_doc_date?: string | null;
  vehicle_no?: string | null;
}

interface Doc {
  id: string; doc_type: string; variant: string | null; number: string | null; issue_date: string; status: string; currency: string;
  total: number; place_of_supply: string | null; branch_id: string | null; related_doc_id: string | null;
  contact_name: string; contact_gstin: string | null; contact_state: string | null; contact_address: string | null; contact_shipping: string | null;
  contact_phone: string | null; contact_email: string | null; branch_gstin: string | null; related_number: string | null; related_date: string | null;
}
interface Line {
  line_no: number; description: string; hsn_sac: string | null; qty_milli: number; unit_price: number; taxable: number;
  cgst: number; sgst: number; igst: number; other_tax: number; rate_bp: number | null; unit: string | null; item_kind: string | null;
  barcode: string | null; batch_no: string | null; expiry_date: string | null;
}

async function load(db: D1Database, company: CompanyRow, id: string) {
  const doc = await first<Doc>(db,
    `SELECT d.id, d.doc_type, d.variant, d.number, d.issue_date, d.status, d.currency, d.total, d.place_of_supply, d.branch_id, d.related_doc_id,
            ct.name AS contact_name, ct.tax_id AS contact_gstin, ct.state_code AS contact_state, ct.billing_address AS contact_address,
            ct.shipping_address AS contact_shipping, ct.phone AS contact_phone, ct.email AS contact_email, b.gstin AS branch_gstin,
            rd.number AS related_number, rd.issue_date AS related_date
     FROM documents d JOIN contacts ct ON ct.id = d.contact_id LEFT JOIN branches b ON b.id = d.branch_id LEFT JOIN documents rd ON rd.id = d.related_doc_id
     WHERE d.id = ? AND d.company_id = ?`, id, company.id);
  const lines = await all<Line>(db,
    `SELECT l.line_no, l.description, COALESCE(l.hsn_sac, i.hsn_sac) AS hsn_sac, l.qty_milli, l.unit_price, l.taxable, l.cgst, l.sgst, l.igst, l.other_tax,
            t.rate_bp, i.unit, i.kind AS item_kind, i.barcode, l.batch_no, l.expiry_date
     FROM document_lines l LEFT JOIN items i ON i.id = l.item_id LEFT JOIN tax_codes t ON t.id = l.tax_code_id
     WHERE l.document_id = ? ORDER BY l.line_no`, id);
  return { doc: doc!, lines };
}

const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");
const isService = (l: Line) => l.item_kind === "service" || (l.hsn_sac ?? "").startsWith("99");
const pick = (o: PartyOverrides | undefined, base: Place): Place => ({
  addr1: (o?.addr1 ?? base.addr1).trim(), addr2: (o?.addr2 ?? base.addr2).trim(), loc: (o?.loc ?? base.loc).trim(), pin: digits(o?.pin ?? base.pin),
});

function parties(company: CompanyRow, doc: Doc, o: EinvoiceOverrides) {
  const sellerGstin = doc.branch_gstin && isValidGstin(doc.branch_gstin) ? doc.branch_gstin : company.tax_id ?? "";
  const companyPlace = splitAddress(company.address, Boolean(company.city));
  const seller = pick(o.seller, { ...companyPlace, loc: company.city || companyPlace.loc, pin: company.postal_code || companyPlace.pin });
  const buyer = pick(o.buyer, splitAddress(doc.contact_address));
  const buyerGstin = (doc.contact_gstin ?? "").toUpperCase();
  return { sellerGstin, seller, buyer, buyerGstin };
}

function placeProblems(who: string, p: Place, problems: string[]) {
  if (p.addr1.length < 3) problems.push(`${who} address is missing`);
  if (p.loc.length < 3) problems.push(`${who} place (city/town) is missing`);
  if (!/^[1-9]\d{5}$/.test(p.pin)) problems.push(`${who} PIN code must be 6 digits`);
}

function lineProblems(lines: Line[], problems: string[]) {
  lines.forEach((l) => {
    if (!/^\d{4,8}$/.test(l.hsn_sac ?? "")) problems.push(`Line ${l.line_no} (${l.description}): HSN/SAC code needed (4–8 digits)`);
    if (l.other_tax) problems.push(`Line ${l.line_no}: cess / other tax is sent as "other charges"; check it on the portal`);
  });
}

export async function einvoiceJson(db: D1Database, company: CompanyRow, id: string, o: EinvoiceOverrides = {}) {
  const { doc, lines } = await load(db, company, id);
  const problems: string[] = [];
  const kind = doc.doc_type === "invoice" ? "INV" : doc.doc_type === "credit_note" ? "CRN" : null;
  if (!kind) problems.push("e-invoices are made for invoices and credit notes only");
  if (doc.status !== "posted") problems.push(doc.status === "void" ? "This document is void" : "Issue the document first");
  if (doc.currency !== "INR") problems.push("Only rupee invoices are supported (exports are not)");
  const { sellerGstin, seller, buyer, buyerGstin } = parties(company, doc, o);
  if (!isValidGstin(sellerGstin)) problems.push("Your GSTIN is missing (Settings → Company, or the branch GSTIN)");
  if (!isValidGstin(buyerGstin)) problems.push("e-invoicing applies to registered buyers: the customer has no valid GSTIN (B2C invoices only need the dynamic UPI QR)");
  placeProblems("Your", seller, problems);
  placeProblems("Customer", buyer, problems);
  lineProblems(lines, problems);
  const number = (doc.number ?? "").toUpperCase();
  if (number && !/^[A-Z1-9][A-Z0-9/-]{0,15}$/.test(number)) problems.push(`Document number ${number} must be at most 16 characters of A–Z, 0–9, / and -, not starting with 0, / or -`);

  const items = lines.map((l, i) => {
    const gross = Math.round((l.unit_price * l.qty_milli) / 1000);
    const discount = Math.max(0, gross - l.taxable);
    const svc = isService(l);
    const totItem = l.taxable + l.cgst + l.sgst + l.igst + l.other_tax;
    return {
      SlNo: String(i + 1), PrdDesc: l.description.slice(0, 300), IsServc: svc ? "Y" : "N", HsnCd: l.hsn_sac ?? "",
      ...(l.barcode && !svc ? { Barcde: l.barcode.slice(0, 30) } : {}),
      Qty: q3(l.qty_milli), FreeQty: 0, ...(svc ? {} : { Unit: uqcFor(l.unit) }),
      UnitPrice: r2(l.unit_price), TotAmt: r2(gross), Discount: r2(discount), PreTaxVal: 0, AssAmt: r2(l.taxable),
      GstRt: (l.rate_bp ?? 0) / 100, IgstAmt: r2(l.igst), CgstAmt: r2(l.cgst), SgstAmt: r2(l.sgst),
      CesRt: 0, CesAmt: 0, CesNonAdvlAmt: 0, StateCesRt: 0, StateCesAmt: 0, StateCesNonAdvlAmt: 0, OthChrg: r2(l.other_tax),
      TotItemVal: r2(totItem),
      ...(l.batch_no ? { BchDtls: { Nm: l.batch_no.slice(0, 20), ...(l.expiry_date ? { ExpDt: slashDate(l.expiry_date) } : {}) } } : {}),
    };
  });
  const sum = (k: "taxable" | "cgst" | "sgst" | "igst" | "other_tax") => lines.reduce((t, l) => t + l[k], 0);
  const itemTotal = lines.reduce((t, l) => t + l.taxable + l.cgst + l.sgst + l.igst + l.other_tax, 0);
  const json = {
    Version: "1.1",
    TranDtls: { TaxSch: "GST", SupTyp: "B2B", RegRev: "N", IgstOnIntra: "N" },
    DocDtls: { Typ: kind ?? "INV", No: number, Dt: slashDate(doc.issue_date) },
    SellerDtls: {
      Gstin: sellerGstin, LglNm: (company.legal_name || company.name).slice(0, 100), TrdNm: company.name.slice(0, 100),
      Addr1: seller.addr1, ...(seller.addr2 ? { Addr2: seller.addr2 } : {}), Loc: seller.loc, Pin: Number(seller.pin) || 0, Stcd: sellerGstin.slice(0, 2),
      ...(digits(company.phone).length >= 6 ? { Ph: digits(company.phone).slice(-12) } : {}), ...(company.email ? { Em: company.email.slice(0, 100) } : {}),
    },
    BuyerDtls: {
      Gstin: buyerGstin, LglNm: doc.contact_name.slice(0, 100), TrdNm: doc.contact_name.slice(0, 100),
      Pos: doc.place_of_supply || doc.contact_state || buyerGstin.slice(0, 2),
      Addr1: buyer.addr1, ...(buyer.addr2 ? { Addr2: buyer.addr2 } : {}), Loc: buyer.loc, Pin: Number(buyer.pin) || 0, Stcd: buyerGstin.slice(0, 2) || doc.contact_state || "",
      ...(digits(doc.contact_phone).length >= 6 ? { Ph: digits(doc.contact_phone).slice(-12) } : {}), ...(doc.contact_email ? { Em: doc.contact_email.slice(0, 100) } : {}),
    },
    ItemList: items,
    ValDtls: {
      AssVal: r2(sum("taxable")), CgstVal: r2(sum("cgst")), SgstVal: r2(sum("sgst")), IgstVal: r2(sum("igst")), CesVal: 0, StCesVal: 0,
      Discount: 0, OthChrg: 0, RndOffAmt: r2(doc.total - itemTotal), TotInvVal: r2(doc.total),
    },
    ...(kind === "CRN" && doc.related_number && doc.related_date
      ? { RefDtls: { PrecDocDtls: [{ InvNo: doc.related_number.toUpperCase(), InvDt: slashDate(doc.related_date) }] } }
      : {}),
  };
  return { json, problems, places: { seller, buyer }, filename: `einvoice-${number || doc.id}.json` };
}

/** Sub-supply types the e-way bill system uses (outward unless noted). */
export const SUB_SUPPLY = { 1: "Supply", 4: "Job work", 5: "For own use", 7: "Sales return (inward)", 8: "Others", 10: "Line sales", 11: "Recipient not known", 12: "Exhibition or fairs" } as const;

export async function ewayJson(db: D1Database, company: CompanyRow, id: string, o: EwayOptions = {}) {
  const { doc, lines } = await load(db, company, id);
  const problems: string[] = [];
  const challan = doc.variant === "delivery_challan";
  const inward = doc.doc_type === "credit_note";
  if (!(doc.doc_type === "invoice" || inward || challan)) problems.push("e-way bills are made for invoices, delivery challans and sales returns");
  if (!doc.number || doc.status === "draft") problems.push("Issue the document first");
  if (doc.status === "void") problems.push("This document is void");
  const { sellerGstin, seller, buyer, buyerGstin } = parties(company, doc, o);
  if (!isValidGstin(sellerGstin)) problems.push("Your GSTIN is missing (Settings → Company, or the branch GSTIN)");
  placeProblems("Your", seller, problems);
  placeProblems("Customer", buyer, problems);
  lineProblems(lines, problems);
  const sub = o.sub_supply_type ?? (inward ? 7 : challan ? 8 : 1);
  const subDesc = (o.sub_supply_desc ?? (sub === 8 ? "Delivery challan" : "")).slice(0, 20);
  const vehicle = (o.vehicle_no ?? "").toUpperCase().replace(/[\s-]/g, "");
  const transporterId = (o.transporter_id ?? "").toUpperCase().trim();
  if (vehicle && !/^[A-Z]{2}[0-9A-Z]{1,3}[A-Z]{0,3}[0-9]{4}$|^TM[0-9A-Z]{6}$/.test(vehicle)) problems.push(`Vehicle number ${vehicle} does not look like an Indian registration number`);
  if (transporterId && !isValidGstin(transporterId) && !/^\d{2}[A-Z0-9]{13}$/.test(transporterId)) problems.push("Transporter ID must be a GSTIN or transporter enrolment number");
  if (!vehicle && !transporterId) problems.push("Enter a vehicle number (or a transporter ID to let them fill Part B)");
  const totalValue = lines.reduce((t, l) => t + l.taxable, 0);
  if (!inward && !challan && doc.total < 5_000_000) problems.push("Goods worth ₹50,000 or less usually do not need an e-way bill (check your state's limit)");

  const us = { gstin: sellerGstin, name: company.legal_name || company.name, place: seller, state: Number(sellerGstin.slice(0, 2)) || Number(company.state_code) || 0 };
  const them = {
    gstin: isValidGstin(buyerGstin) ? buyerGstin : "URP", name: doc.contact_name, place: buyer,
    state: Number(doc.place_of_supply || doc.contact_state || buyerGstin.slice(0, 2)) || 0,
  };
  const [from, to] = inward ? [them, us] : [us, them];
  const taxed = lines.some((l) => l.cgst || l.sgst || l.igst);
  const hsnOf = (l: Line) => Number(l.hsn_sac) || 0;
  const goods = lines.filter((l) => !isService(l));
  const main = [...goods].sort((a, b) => b.taxable - a.taxable)[0];
  const bill = {
    userGstin: sellerGstin,
    supplyType: inward ? "I" : "O", subSupplyType: sub, subSupplyDesc: subDesc,
    docType: inward ? "CNT" : challan ? "CHL" : taxed ? "INV" : "BIL", docNo: (doc.number ?? "").toUpperCase(), docDate: slashDate(doc.issue_date), transType: 1,
    fromGstin: from.gstin, fromTrdName: from.name.slice(0, 100), fromAddr1: from.place.addr1.slice(0, 120), fromAddr2: from.place.addr2.slice(0, 120),
    fromPlace: from.place.loc, fromPincode: Number(from.place.pin) || 0, fromStateCode: from.state, actualFromStateCode: from.state,
    toGstin: to.gstin, toTrdName: to.name.slice(0, 100), toAddr1: to.place.addr1.slice(0, 120), toAddr2: to.place.addr2.slice(0, 120),
    toPlace: to.place.loc, toPincode: Number(to.place.pin) || 0, toStateCode: to.state, actualToStateCode: to.state,
    totalValue: r2(totalValue), cgstValue: r2(lines.reduce((t, l) => t + l.cgst, 0)), sgstValue: r2(lines.reduce((t, l) => t + l.sgst, 0)),
    igstValue: r2(lines.reduce((t, l) => t + l.igst, 0)), cessValue: 0, TotNonAdvolVal: 0, OthValue: r2(doc.total - totalValue - lines.reduce((t, l) => t + l.cgst + l.sgst + l.igst, 0)),
    totInvValue: r2(doc.total),
    transMode: Number(o.trans_mode ?? "1"), transDistance: Math.max(0, Math.round(o.distance_km ?? 0)),
    transporterName: (o.transporter_name ?? "").slice(0, 100), transporterId, transDocNo: (o.trans_doc_no ?? "").slice(0, 15),
    transDocDate: o.trans_doc_date ? slashDate(o.trans_doc_date) : "", vehicleNo: vehicle, vehicleType: "R",
    mainHsnCode: main ? hsnOf(main) : 0,
    itemList: lines.map((l, i) => {
      const rate = (l.rate_bp ?? 0) / 100;
      return {
        itemNo: i + 1, productName: l.description.slice(0, 100), productDesc: l.description.slice(0, 100), hsnCode: hsnOf(l),
        quantity: q3(l.qty_milli), qtyUnit: isService(l) ? "OTH" : uqcFor(l.unit), taxableAmount: r2(l.taxable),
        sgstRate: l.sgst ? rate / 2 : 0, cgstRate: l.cgst ? rate / 2 : 0, igstRate: l.igst ? rate : 0, cessRate: 0, cessNonAdvol: 0,
      };
    }),
  };
  if (!goods.length) problems.push("There are no goods on this document (services do not need an e-way bill)");
  return { json: { version: "1.0.0621", billLists: [bill] }, problems, places: { seller, buyer }, filename: `ewaybill-${doc.number ?? doc.id}.json` };
}
