import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { all, batch, first, stmt, todayIso } from "../lib/db";
import { badRequest, conflict, notFound } from "../lib/errors";
import { body, isoDate, minor, optId, reqText, shortText } from "../lib/validate";
import { newId } from "../lib/crypto";
import { audit, requireAnyPerm, requirePerm } from "../lib/auth";
import { currencyExponent } from "@shared/currencies";
import { prepareDraft } from "../services/documents";

/** CRM: leads through a sales pipeline, follow-ups, and turning a lead into a customer and a quotation. */
export const crm = new Hono<AppEnv>();

export const STAGES = ["new", "contacted", "qualified", "proposal", "won", "lost"] as const;
const view = (c: Parameters<typeof requireAnyPerm>[0]) => requireAnyPerm(c, "sales.view", "customers.write");
const edit = (c: Parameters<typeof requireAnyPerm>[0]) => requireAnyPerm(c, "sales.create", "customers.write");

crm.get("/leads", async (c) => {
  view(c);
  const co = c.get("company");
  const q = (c.req.query("q") ?? "").trim();
  const rows = await all<{ stage: string; value: number }>(c.env.DB,
    `SELECT l.*, u.name AS owner, d.number AS quote_number, d.status AS quote_status,
            (SELECT MIN(a.due_date) FROM lead_activities a WHERE a.lead_id = l.id AND a.done_at IS NULL AND a.due_date IS NOT NULL) AS next_follow_up
       FROM leads l LEFT JOIN users u ON u.id = l.owner_user_id LEFT JOIN documents d ON d.id = l.quote_id
      WHERE l.company_id = ? ${q ? "AND (l.title LIKE ? OR l.person LIKE ? OR l.organisation LIKE ? OR l.phone LIKE ?)" : ""}
      ORDER BY CASE l.stage WHEN 'won' THEN 1 WHEN 'lost' THEN 2 ELSE 0 END, l.updated_at DESC LIMIT 1000`,
    ...[co.id, ...(q ? Array(4).fill(`%${q}%`) : [])]);
  const pipeline = STAGES.map((s) => ({ stage: s, count: rows.filter((r) => r.stage === s).length, value: rows.filter((r) => r.stage === s).reduce((t, r) => t + r.value, 0) }));
  const closed = rows.filter((r) => r.stage === "won" || r.stage === "lost").length;
  return c.json({ leads: rows, pipeline, win_rate: closed ? rows.filter((r) => r.stage === "won").length / closed : null });
});

const leadSchema = z.object({
  title: reqText(150),
  person: shortText(120).nullish(),
  organisation: shortText(150).nullish(),
  phone: shortText(30).nullish(),
  email: z.string().trim().email().max(150).or(z.literal("")).nullish(),
  source: shortText(40).nullish(),
  stage: z.enum(STAGES).optional(),
  value: z.union([z.string(), z.number()]).nullish(),
  expected_close: isoDate.nullish(),
  owner_user_id: optId,
  notes: shortText(2000).nullish(),
  lost_reason: shortText(300).nullish(),
});

crm.post("/leads", async (c) => {
  edit(c);
  const co = c.get("company");
  const input = await body(c, leadSchema);
  if (!input.person && !input.organisation && !input.phone && !input.email) throw badRequest("Give a name, company, phone or email for the lead");
  const id = newId();
  const value = input.value ? minor(input.value, currencyExponent(co.base_currency), "expected value") : 0;
  await batch(c.env.DB, [
    stmt(c.env.DB, `INSERT INTO leads (id, company_id, title, person, organisation, phone, email, source, stage, value, currency, expected_close, owner_user_id, notes, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, co.id, input.title, input.person ?? null, input.organisation ?? null, input.phone ?? null, input.email || null, input.source ?? null, input.stage ?? "new",
      value, co.base_currency, input.expected_close ?? null, input.owner_user_id ?? c.get("user").id, input.notes ?? null, c.get("user").id),
    audit(c, "lead.create", "lead", id, { title: input.title, source: input.source ?? null }),
  ]);
  return c.json({ id }, 201);
});

async function lead(c: { env: AppEnv["Bindings"] }, companyId: string, id: string) {
  const l = await first<{ id: string; title: string; stage: string; person: string | null; organisation: string | null; phone: string | null; email: string | null; value: number; currency: string; contact_id: string | null; quote_id: string | null; notes: string | null }>(c.env.DB,
    `SELECT * FROM leads WHERE id = ? AND company_id = ?`, id, companyId);
  if (!l) throw notFound("Lead");
  return l;
}

crm.get("/leads/:id", async (c) => {
  view(c);
  const co = c.get("company");
  const l = await first(c.env.DB, `SELECT l.*, u.name AS owner, d.number AS quote_number, d.status AS quote_status, ct.name AS customer
      FROM leads l LEFT JOIN users u ON u.id = l.owner_user_id LEFT JOIN documents d ON d.id = l.quote_id LEFT JOIN contacts ct ON ct.id = l.contact_id
     WHERE l.id = ? AND l.company_id = ?`, c.req.param("id"), co.id);
  if (!l) throw notFound("Lead");
  const activities = await all(c.env.DB, `SELECT a.*, u.name AS user FROM lead_activities a LEFT JOIN users u ON u.id = a.user_id WHERE a.lead_id = ? ORDER BY COALESCE(a.done_at, a.created_at) DESC`, c.req.param("id"));
  return c.json({ lead: l, activities });
});

crm.patch("/leads/:id", async (c) => {
  edit(c);
  const co = c.get("company");
  const before = await lead(c, co.id, c.req.param("id"));
  const input = await body(c, leadSchema.partial());
  if (input.stage === "lost" && !input.lost_reason && before.stage !== "lost") throw badRequest("Give the reason the lead was lost");
  const value = input.value === undefined || input.value === null ? null : minor(input.value, currencyExponent(before.currency), "expected value");
  const closing = input.stage && input.stage !== before.stage && (input.stage === "won" || input.stage === "lost");
  const reopening = input.stage && input.stage !== "won" && input.stage !== "lost";
  const set: [string, string | number | null][] = [];
  for (const k of ["title", "person", "organisation", "phone", "source", "stage", "expected_close", "owner_user_id", "notes", "lost_reason"] as const) if (input[k] !== undefined) set.push([k, (input[k] as string | null | undefined) ?? null]);
  if (input.email !== undefined) set.push(["email", input.email || null]);
  if (value !== null) set.push(["value", value]);
  if (closing) set.push(["closed_at", todayIso()]);
  if (reopening) set.push(["closed_at", null]);
  if (!set.length) return c.json({ ok: true });
  await batch(c.env.DB, [
    stmt(c.env.DB, `UPDATE leads SET ${set.map(([k]) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, ...set.map(([, v]) => v), new Date().toISOString(), before.id),
    ...(input.stage && input.stage !== before.stage ? [stmt(c.env.DB, `INSERT INTO lead_activities (id, company_id, lead_id, kind, summary, done_at, user_id) VALUES (?,?,?,?,?,?,?)`,
      newId(), co.id, before.id, "note", `Stage: ${before.stage} → ${input.stage}${input.lost_reason ? ` (${input.lost_reason})` : ""}`, new Date().toISOString(), c.get("user").id)] : []),
    audit(c, "lead.update", "lead", before.id, { stage: input.stage, from: before.stage }),
  ]);
  return c.json({ ok: true });
});

const activitySchema = z.object({
  kind: z.enum(["call", "meeting", "email", "whatsapp", "note", "task"]),
  summary: reqText(1000),
  due_date: isoDate.nullish(),
  done: z.boolean().optional(),
});

crm.post("/leads/:id/activities", async (c) => {
  edit(c);
  const co = c.get("company");
  const l = await lead(c, co.id, c.req.param("id"));
  const input = await body(c, activitySchema);
  // A task or a planned call has a due date and is done later; anything else is logged as done now.
  const done = input.done ?? !input.due_date;
  const id = newId();
  await batch(c.env.DB, [
    stmt(c.env.DB, `INSERT INTO lead_activities (id, company_id, lead_id, kind, summary, due_date, done_at, user_id) VALUES (?,?,?,?,?,?,?,?)`,
      id, co.id, l.id, input.kind, input.summary, input.due_date ?? null, done ? new Date().toISOString() : null, c.get("user").id),
    stmt(c.env.DB, `UPDATE leads SET updated_at = ?, stage = CASE WHEN stage = 'new' AND ? THEN 'contacted' ELSE stage END WHERE id = ?`, new Date().toISOString(), done && input.kind !== "note" ? 1 : 0, l.id),
  ]);
  return c.json({ id }, 201);
});

crm.post("/activities/:id/done", async (c) => {
  edit(c);
  const a = await first<{ lead_id: string; done_at: string | null }>(c.env.DB, `SELECT lead_id, done_at FROM lead_activities WHERE id = ? AND company_id = ?`, c.req.param("id"), c.get("company").id);
  if (!a) throw notFound("Follow-up");
  const input = await body(c, z.object({ outcome: shortText(500).nullish() }));
  await batch(c.env.DB, [
    stmt(c.env.DB, `UPDATE lead_activities SET done_at = ?, summary = summary || ? WHERE id = ?`, new Date().toISOString(), input.outcome ? ` — ${input.outcome}` : "", c.req.param("id")),
    stmt(c.env.DB, `UPDATE leads SET updated_at = ?, stage = CASE WHEN stage = 'new' THEN 'contacted' ELSE stage END WHERE id = ?`, new Date().toISOString(), a.lead_id),
  ]);
  return c.json({ ok: true });
});

/** Follow-ups not done yet, due within the next week (and the overdue ones), for everyone or for me. */
crm.get("/follow-ups", async (c) => {
  view(c);
  const co = c.get("company");
  const mine = c.req.query("mine") === "1";
  const until = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  const rows = await all(c.env.DB,
    `SELECT a.*, l.title, l.person, l.organisation, l.phone, l.stage, u.name AS user FROM lead_activities a JOIN leads l ON l.id = a.lead_id LEFT JOIN users u ON u.id = a.user_id
      WHERE a.company_id = ? AND a.done_at IS NULL AND a.due_date IS NOT NULL AND a.due_date <= ? ${mine ? "AND (l.owner_user_id = ? OR a.user_id = ?)" : ""}
      ORDER BY a.due_date LIMIT 300`, ...[co.id, until, ...(mine ? [c.get("user").id, c.get("user").id] : [])]);
  return c.json({ follow_ups: rows, today: todayIso() });
});

/** The lead becomes a customer (or is linked to an existing one) and, if asked, gets a draft quotation for its value. */
crm.post("/leads/:id/convert", async (c) => {
  requirePerm(c, "customers.write");
  const co = c.get("company");
  const l = await lead(c, co.id, c.req.param("id"));
  const input = await body(c, z.object({ contact_id: optId, quotation: z.boolean().optional() }));
  if (input.quotation) requirePerm(c, "sales.create");
  let contactId = input.contact_id ?? l.contact_id;
  const stmts: D1PreparedStatement[] = [];
  if (contactId) {
    if (!(await first(c.env.DB, `SELECT 1 FROM contacts WHERE id = ? AND company_id = ? AND kind IN ('customer','both')`, contactId, co.id))) throw badRequest("Choose a customer");
  } else {
    const name = l.organisation || l.person;
    if (!name) throw badRequest("Give the lead a person or company name first");
    if (await first(c.env.DB, `SELECT 1 FROM contacts WHERE company_id = ? AND lower(name) = lower(?)`, co.id, name)) throw conflict("CONTACT_EXISTS", `A customer named “${name}” already exists: choose it instead`);
    contactId = newId();
    await batch(c.env.DB, [
      stmt(c.env.DB, `INSERT INTO contacts (id, company_id, kind, name, email, phone, country, payment_terms_days) VALUES (?,?,?,?,?,?,?,?)`, contactId, co.id, "customer", name, l.email, l.phone, co.country, 30),
      audit(c, "contact.create", "contact", contactId, { name, from_lead: l.id }),
    ]);
  }
  let quoteId: string | null = l.quote_id;
  if (input.quotation && !l.quote_id) {
    const acc = await first<{ id: string }>(c.env.DB, `SELECT id FROM accounts WHERE company_id = ? AND system_key IN ('SERVICE_INCOME','SALES') ORDER BY system_key = 'SERVICE_INCOME' DESC LIMIT 1`, co.id);
    const prepared = await prepareDraft(c, {
      doc_type: "quote", contact_id: contactId, issue_date: todayIso(), currency: l.currency, reference: l.title,
      lines: [{ description: l.title, qty_milli: 1000, unit_price: l.value, discount_bp: 0, account_id: acc?.id ?? null }],
    });
    stmts.push(...prepared.stmts);
    quoteId = prepared.id;
  }
  stmts.push(stmt(c.env.DB, `UPDATE leads SET contact_id = ?, quote_id = ?, stage = CASE WHEN ? AND stage IN ('new','contacted','qualified') THEN 'proposal' ELSE stage END, updated_at = ? WHERE id = ?`,
    contactId, quoteId, quoteId ? 1 : 0, new Date().toISOString(), l.id));
  stmts.push(audit(c, "lead.convert", "lead", l.id, { contact_id: contactId, quote_id: quoteId }));
  await batch(c.env.DB, stmts);
  return c.json({ contact_id: contactId, quote_id: quoteId });
});

/** Where the leads come from and how many are won. */
crm.get("/report", async (c) => {
  view(c);
  const co = c.get("company");
  const from = c.req.query("from") ?? `${todayIso().slice(0, 4)}-01-01`;
  const rows = await all(c.env.DB,
    `SELECT COALESCE(source, '(not given)') AS source, COUNT(*) AS leads, SUM(stage = 'won') AS won, SUM(stage = 'lost') AS lost,
            SUM(CASE WHEN stage = 'won' THEN value ELSE 0 END) AS won_value, SUM(CASE WHEN stage NOT IN ('won','lost') THEN value ELSE 0 END) AS open_value
       FROM leads WHERE company_id = ? AND created_at >= ? GROUP BY COALESCE(source, '(not given)') ORDER BY leads DESC`, co.id, from);
  const lost = await all(c.env.DB, `SELECT lost_reason, COUNT(*) AS n FROM leads WHERE company_id = ? AND stage = 'lost' AND created_at >= ? GROUP BY lost_reason ORDER BY n DESC LIMIT 10`, co.id, from);
  return c.json({ from, by_source: rows, lost_reasons: lost });
});
