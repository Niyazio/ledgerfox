import { Hono } from "hono";
import { z } from "zod";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { all, batch, first, run, stmt, todayIso } from "../lib/db";
import { badRequest, notFound } from "../lib/errors";
import { body, isoDate, reqText } from "../lib/validate";
import { newId } from "../lib/crypto";
import { assertBranchVisible, audit, requirePerm } from "../lib/auth";
import { issueDocument, prepareDraft, type DraftInput } from "../services/documents";

/**
 * Recurring invoices: copy an existing invoice on a schedule (rent, AMC, subscriptions, school fees).
 * Due invoices are created when someone runs them (the dashboard does this once a day); each becomes a draft,
 * or is issued straight away when `auto_issue` is on.
 */
const recurring = new Hono<AppEnv>();
recurring.use("*", async (c, next) => { requirePerm(c, "sales.create"); await next(); });

/** Next date for a frequency, keeping the anchor day of the month (31 → last day of shorter months). */
export function nextDate(date: string, freq: string, anchorDay: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (freq === "weekly") { d.setUTCDate(d.getUTCDate() + 7); return d.toISOString().slice(0, 10); }
  const months = freq === "monthly" ? 1 : freq === "quarterly" ? 3 : 12;
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + months;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(anchorDay, last))).toISOString().slice(0, 10);
}

const schema = z.object({
  template_document_id: z.string().min(1),
  name: reqText(120),
  frequency: z.enum(["weekly", "monthly", "quarterly", "yearly"]),
  next_date: isoDate,
  end_date: isoDate.nullish(),
  auto_issue: z.boolean().default(false),
});

recurring.get("/", async (c) => {
  const company = c.get("company");
  const rows = await all(c.env.DB,
    `SELECT r.*, d.number AS template_number, d.total, d.currency, ct.name AS contact_name, ld.number AS last_number
     FROM recurring_invoices r JOIN documents d ON d.id = r.template_document_id JOIN contacts ct ON ct.id = d.contact_id
     LEFT JOIN documents ld ON ld.id = r.last_document_id WHERE r.company_id = ? ORDER BY r.is_active DESC, r.next_date`, company.id);
  const due = rows.filter((r: any) => r.is_active && r.next_date <= todayIso() && (!r.end_date || r.next_date <= r.end_date)).length;
  return c.json({ schedules: rows, due });
});

async function template(c: Context<AppEnv>, id: string) {
  const d = await first<{ doc_type: string; status: string; branch_id: string | null }>(c.env.DB, `SELECT doc_type, status, branch_id FROM documents WHERE id = ? AND company_id = ?`, id, c.get("company").id);
  if (!d) throw notFound("Invoice");
  assertBranchVisible(c, d.branch_id);
  if (d.doc_type !== "invoice") throw badRequest("Choose an invoice to repeat");
  return d;
}

recurring.post("/", async (c) => {
  const input = await body(c, schema);
  await template(c, input.template_document_id);
  if (input.end_date && input.end_date < input.next_date) throw badRequest("The end date is before the first date");
  if (input.auto_issue) requirePerm(c, "sales.post");
  const id = newId();
  await batch(c.env.DB, [
    stmt(c.env.DB, `INSERT INTO recurring_invoices (id, company_id, template_document_id, name, frequency, next_date, anchor_day, end_date, auto_issue, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      id, c.get("company").id, input.template_document_id, input.name, input.frequency, input.next_date, Number(input.next_date.slice(8, 10)), input.end_date ?? null, input.auto_issue ? 1 : 0, c.get("user").id),
    audit(c, "recurring.create", "recurring_invoice", id, input),
  ]);
  return c.json({ id }, 201);
});

recurring.patch("/:id", async (c) => {
  const input = await body(c, z.object({ name: reqText(120).optional(), is_active: z.boolean().optional(), next_date: isoDate.optional(), end_date: isoDate.nullish(), auto_issue: z.boolean().optional() }));
  const company = c.get("company");
  const r = await first(c.env.DB, `SELECT 1 FROM recurring_invoices WHERE id = ? AND company_id = ?`, c.req.param("id"), company.id);
  if (!r) throw notFound("Schedule");
  if (input.auto_issue) requirePerm(c, "sales.post");
  await batch(c.env.DB, [
    stmt(c.env.DB, `UPDATE recurring_invoices SET name = COALESCE(?, name), is_active = COALESCE(?, is_active), next_date = COALESCE(?, next_date),
       anchor_day = COALESCE(?, anchor_day), end_date = CASE WHEN ? THEN ? ELSE end_date END, auto_issue = COALESCE(?, auto_issue) WHERE id = ? AND company_id = ?`,
      input.name ?? null, input.is_active === undefined ? null : input.is_active ? 1 : 0, input.next_date ?? null, input.next_date ? Number(input.next_date.slice(8, 10)) : null,
      input.end_date !== undefined ? 1 : 0, input.end_date ?? null, input.auto_issue === undefined ? null : input.auto_issue ? 1 : 0, c.req.param("id"), company.id),
    audit(c, "recurring.update", "recurring_invoice", c.req.param("id"), input),
  ]);
  return c.json({ ok: true });
});

recurring.delete("/:id", async (c) => {
  const company = c.get("company");
  await batch(c.env.DB, [
    stmt(c.env.DB, `DELETE FROM recurring_invoices WHERE id = ? AND company_id = ?`, c.req.param("id"), company.id),
    audit(c, "recurring.delete", "recurring_invoice", c.req.param("id")),
  ]);
  return c.json({ ok: true });
});

/** Create every invoice that is due (catching up missed periods, at most 12 per schedule per run). */
recurring.post("/run", async (c) => {
  const company = c.get("company");
  const today = todayIso();
  const due = await all<{ id: string; template_document_id: string; frequency: string; next_date: string; anchor_day: number; end_date: string | null; auto_issue: number; name: string }>(c.env.DB,
    `SELECT * FROM recurring_invoices WHERE company_id = ? AND is_active = 1 AND next_date <= ? AND (end_date IS NULL OR next_date <= end_date) LIMIT 50`, company.id, today);
  const created: { schedule: string; id: string; number: string | null; date: string }[] = [];
  const errors: { schedule: string; message: string }[] = [];
  for (const r of due) {
    const tpl = await first<Record<string, any>>(c.env.DB, `SELECT * FROM documents WHERE id = ? AND company_id = ?`, r.template_document_id, company.id);
    const lines = await all<Record<string, any>>(c.env.DB, `SELECT * FROM document_lines WHERE document_id = ? ORDER BY line_no`, r.template_document_id);
    if (!tpl || !lines.length) { errors.push({ schedule: r.name, message: "The template invoice no longer exists" }); continue; }
    let date = r.next_date;
    for (let n = 0; n < 12 && date <= today && (!r.end_date || date <= r.end_date); n++) {
      const next = nextDate(date, r.frequency, r.anchor_day);
      // Claim this period first so two simultaneous runs cannot both create it.
      const claim = await run(c.env.DB, `UPDATE recurring_invoices SET next_date = ? WHERE id = ? AND next_date = ?`, next, r.id, date);
      if (!claim.meta.changes) break;
      try {
        const input: DraftInput = {
          doc_type: "invoice", contact_id: tpl.contact_id, issue_date: date, currency: tpl.currency, place_of_supply: tpl.place_of_supply,
          reference: tpl.reference, notes: tpl.notes, terms: tpl.terms, branch_id: tpl.branch_id, warehouse_id: tpl.warehouse_id,
          lines: lines.map((l) => ({ item_id: l.item_id, description: l.description, hsn_sac: l.hsn_sac, qty_milli: l.qty_milli, unit_price: l.unit_price, discount_bp: l.discount_bp,
            account_id: l.account_id, tax_code_id: l.tax_code_id, department_id: l.department_id, project_id: l.project_id, cost_centre_id: l.cost_centre_id })),
        };
        const prepared = await prepareDraft(c, input);
        await batch(c.env.DB, [
          ...prepared.stmts,
          stmt(c.env.DB, `UPDATE recurring_invoices SET last_document_id = ? WHERE id = ?`, prepared.id, r.id),
          audit(c, "invoice.recurring_create", "document", prepared.id, { schedule: r.name, date }),
        ]);
        const made = { schedule: r.name, id: prepared.id, number: null as string | null, date };
        created.push(made);
        if (r.auto_issue) {
          try { made.number = (await issueDocument(c, prepared.id)) ?? null; }
          catch (e) { errors.push({ schedule: r.name, message: `Invoice for ${date} was saved as a draft but not issued: ${(e as Error).message}` }); }
        }
        date = next;
      } catch (e) {
        // Give the period back so it is retried next time (only if nothing was created for it).
        if (!created.some((x) => x.schedule === r.name && x.date === date)) await run(c.env.DB, `UPDATE recurring_invoices SET next_date = ? WHERE id = ? AND next_date = ?`, date, r.id, next);
        errors.push({ schedule: r.name, message: (e as Error).message });
        break;
      }
    }
  }
  return c.json({ created, errors });
});

export default recurring;
