import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { all, batch, first, stmt } from "../lib/db";
import { badRequest, notFound } from "../lib/errors";
import { body, shortText } from "../lib/validate";
import { audit, requireAnyPerm, requirePerm } from "../lib/auth";
import { INDIA_STATES, isValidGstin } from "@shared/tax";
import { taxIdProblem } from "@shared/countries";

/**
 * Tax check: entries and masters that would make a GST / VAT return wrong, each with a way to fix it — like the
 * "corrections needed" lists of desktop accounting software. Masters (customers, suppliers, products) are fixed right
 * here; issued invoices cannot change, so for those the fix is shown (correct the master, then a credit note if needed).
 */
export const taxcheck = new Hono<AppEnv>();

interface Issue { key: string; title: string; why: string; fix: "edit_contact" | "state_from_gstin" | "item_hsn" | "item_tax" | "open_document"; rows: Record<string, unknown>[] }

taxcheck.get("/", async (c) => {
  requireAnyPerm(c, "reports.read", "sales.view", "purchase.view");
  const co = c.get("company");
  const db = c.env.DB;
  const india = co.country === "IN";
  const registered = Boolean(co.tax_id);
  const issues: Issue[] = [];
  const contacts = await all<{ id: string; name: string; kind: string; tax_id: string | null; state_code: string | null; country: string | null; used: number }>(db,
    `SELECT ct.id, ct.name, ct.kind, ct.tax_id, ct.state_code, ct.country,
            (SELECT COUNT(*) FROM documents d WHERE d.contact_id = ct.id AND d.status IN ('posted','draft','open')) AS used
       FROM contacts ct WHERE ct.company_id = ? AND ct.is_active = 1`, co.id);

  if (india) {
    issues.push({ key: "bad_gstin", fix: "edit_contact", title: "Customers and suppliers with a wrong GSTIN",
      why: "A wrong GSTIN puts the invoice in the wrong place in GSTR-1, and the buyer cannot claim the credit.",
      rows: contacts.filter((x) => (x.country ?? "IN") === "IN" && x.tax_id && !isValidGstin(x.tax_id)).map((x) => ({ contact_id: x.id, name: x.name, kind: x.kind, gstin: x.tax_id })) });
    issues.push({ key: "state_mismatch", fix: "state_from_gstin", title: "State does not match the GSTIN",
      why: "The first two digits of a GSTIN are the state. A different state makes CGST + SGST and IGST come out wrong.",
      rows: contacts.filter((x) => (x.country ?? "IN") === "IN" && x.tax_id && isValidGstin(x.tax_id) && x.state_code !== x.tax_id.slice(0, 2))
        .map((x) => ({ contact_id: x.id, name: x.name, gstin: x.tax_id, state: x.state_code ? `${x.state_code} ${INDIA_STATES[x.state_code] ?? ""}` : "—", should_be: `${x.tax_id!.slice(0, 2)} ${INDIA_STATES[x.tax_id!.slice(0, 2)] ?? ""}` })) });
    issues.push({ key: "no_state", fix: "edit_contact", title: "Customers without a state",
      why: "The state is the place of supply: without it, the tax split (CGST + SGST or IGST) is guessed.",
      rows: contacts.filter((x) => (x.country ?? "IN") === "IN" && x.kind !== "supplier" && !x.state_code && !x.tax_id && x.used > 0).map((x) => ({ contact_id: x.id, name: x.name, documents: x.used })) });
    issues.push({ key: "item_hsn", fix: "item_hsn", title: "Products without a valid HSN / SAC code",
      why: "Invoices must show the HSN (goods) or SAC (services) code, with at least 4 digits (6 above ₹5 crore turnover), and GSTR-1 has an HSN summary.",
      rows: await all(db, `SELECT i.id AS item_id, i.name, i.kind, i.hsn_sac, t.name AS tax FROM items i LEFT JOIN tax_codes t ON t.id = i.tax_code_id
         WHERE i.company_id = ? AND i.is_active = 1 AND COALESCE(t.rate_bp, 0) > 0 AND (i.hsn_sac IS NULL OR length(i.hsn_sac) NOT IN (4, 6, 8) OR i.hsn_sac GLOB '*[^0-9]*')
         ORDER BY i.name LIMIT 300`, co.id) });
  } else {
    issues.push({ key: "bad_tax_id", fix: "edit_contact", title: "Customers and suppliers with a wrong tax number",
      why: "A tax number in the wrong format is rejected on returns and invoices.",
      rows: contacts.filter((x) => x.tax_id && taxIdProblem(x.country ?? co.country, x.tax_id)).map((x) => ({ contact_id: x.id, name: x.name, tax_number: x.tax_id, problem: taxIdProblem(x.country ?? co.country, x.tax_id) })) });
  }
  if (registered) {
    issues.push({ key: "item_tax", fix: "item_tax", title: "Products without a tax rate",
      why: "Without a tax code, a line is billed with no tax. Set the rate once on the product (zero-rated or exempt are fine too).",
      rows: await all(db, `SELECT i.id AS item_id, i.name, i.kind, i.hsn_sac FROM items i WHERE i.company_id = ? AND i.is_active = 1 AND i.tax_code_id IS NULL ORDER BY i.name LIMIT 300`, co.id) });
    issues.push({ key: "draft_no_tax", fix: "open_document", title: "Drafts with lines that have no tax",
      why: "Fix them before issuing: an issued invoice can only be corrected with a credit note.",
      rows: await all(db, `SELECT DISTINCT d.id AS document_id, d.doc_type, COALESCE(d.number, '(draft)') AS number, d.issue_date AS date, ct.name AS party
         FROM documents d JOIN document_lines l ON l.document_id = d.id JOIN contacts ct ON ct.id = d.contact_id
        WHERE d.company_id = ? AND d.status = 'draft' AND d.doc_type IN ('invoice','bill','credit_note','debit_note') AND l.tax_code_id IS NULL ORDER BY d.issue_date LIMIT 200`, co.id) });
  }
  if (india) {
    issues.push({ key: "posted_no_hsn", fix: "open_document", title: "Issued invoices with lines missing HSN / SAC",
      why: "These lines appear without a code in the GSTR-1 HSN summary. Add the code to the product for the future; if the invoice must show it, issue a credit note and a corrected invoice.",
      rows: await all(db, `SELECT d.id AS document_id, d.doc_type, d.number, d.issue_date AS date, ct.name AS party, COUNT(*) AS lines
         FROM documents d JOIN document_lines l ON l.document_id = d.id JOIN contacts ct ON ct.id = d.contact_id
        WHERE d.company_id = ? AND d.status = 'posted' AND d.doc_type IN ('invoice','credit_note') AND (l.hsn_sac IS NULL OR l.hsn_sac = '') AND (l.cgst + l.sgst + l.igst) > 0
        GROUP BY d.id ORDER BY d.issue_date DESC LIMIT 200`, co.id) });
  }
  return c.json({ issues: issues.map((i) => ({ ...i, count: i.rows.length })), registered });
});

/** One click: set the customer's / supplier's state from their GSTIN. */
taxcheck.post("/state-from-gstin", async (c) => {
  const input = await body(c, z.object({ contact_id: z.string().max(64) }));
  const ct = await first<{ kind: string; tax_id: string | null; state_code: string | null }>(c.env.DB, `SELECT kind, tax_id, state_code FROM contacts WHERE id = ? AND company_id = ?`, input.contact_id, c.get("company").id);
  if (!ct) throw notFound("Contact");
  requireAnyPerm(c, ...(ct.kind === "supplier" ? ["suppliers.write"] : ct.kind === "customer" ? ["customers.write"] : ["customers.write", "suppliers.write"]) as never[]);
  if (!ct.tax_id || !isValidGstin(ct.tax_id)) throw badRequest("This contact has no valid GSTIN");
  const state = ct.tax_id.slice(0, 2);
  await batch(c.env.DB, [
    stmt(c.env.DB, `UPDATE contacts SET state_code = ? WHERE id = ?`, state, input.contact_id),
    audit(c, "contact.fix_state", "contact", input.contact_id, { from: ct.state_code, to: state, via: "tax check" }),
  ]);
  return c.json({ state_code: state });
});

/** Fix a product's HSN / SAC code or tax rate in place. */
taxcheck.patch("/item/:id", async (c) => {
  requirePerm(c, "items.write");
  const co = c.get("company");
  const input = await body(c, z.object({ hsn_sac: shortText(8).nullish(), tax_code_id: z.string().max(64).nullish() }));
  const it = await first<{ hsn_sac: string | null; tax_code_id: string | null }>(c.env.DB, `SELECT hsn_sac, tax_code_id FROM items WHERE id = ? AND company_id = ?`, c.req.param("id"), co.id);
  if (!it) throw notFound("Item");
  if (input.hsn_sac !== undefined && input.hsn_sac !== null && !/^\d{4}(\d{2}(\d{2})?)?$/.test(input.hsn_sac)) throw badRequest("HSN / SAC is 4, 6 or 8 digits");
  if (input.tax_code_id && !(await first(c.env.DB, `SELECT 1 FROM tax_codes WHERE id = ? AND company_id = ? AND is_active = 1`, input.tax_code_id, co.id))) throw badRequest("Unknown tax code");
  await batch(c.env.DB, [
    stmt(c.env.DB, `UPDATE items SET hsn_sac = COALESCE(?, hsn_sac), tax_code_id = COALESCE(?, tax_code_id) WHERE id = ?`, input.hsn_sac ?? null, input.tax_code_id ?? null, c.req.param("id")),
    audit(c, "item.fix_tax", "item", c.req.param("id"), { before: it, after: input, via: "tax check" }),
  ]);
  return c.json({ ok: true });
});
