import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { all, batch, first, stmt, todayIso } from "../lib/db";
import { badRequest, conflict, notFound } from "../lib/errors";
import { body, idStr, isoDate, minor, optId, qty, reqText, shortText } from "../lib/validate";
import { newId } from "../lib/crypto";
import { audit, requireAnyPerm, requirePerm } from "../lib/auth";
import { currencyExponent } from "@shared/currencies";
import { prepareDraft } from "../services/documents";

/** Service desk: support tickets (time, notes, billing) and AMC / service contracts (period billing, renewals). */
export const service = new Hono<AppEnv>();

const view = (c: Parameters<typeof requireAnyPerm>[0]) => requireAnyPerm(c, "sales.view", "customers.write");
const edit = (c: Parameters<typeof requireAnyPerm>[0]) => requireAnyPerm(c, "sales.create", "customers.write");
/** Days to resolve, by priority (the ticket's due date). */
export const SLA_DAYS: Record<string, number> = { urgent: 0, high: 1, normal: 3, low: 7 };
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const addMonths = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 10); };

async function nextNumber(db: D1Database, table: "tickets" | "service_contracts", companyId: string, prefix: string) {
  const r = await first<{ n: number | null }>(db, `SELECT MAX(CAST(SUBSTR(number, ${prefix.length + 1}) AS INTEGER)) AS n FROM ${table} WHERE company_id = ? AND number LIKE ?`, companyId, `${prefix}%`);
  return `${prefix}${String((r?.n ?? 0) + 1).padStart(4, "0")}`;
}

/** The customer's active contract on a date, if any. */
export async function activeContract(db: D1Database, companyId: string, contactId: string, date: string) {
  return first<{ id: string; number: string; title: string; end_date: string }>(db,
    `SELECT id, number, title, end_date FROM service_contracts WHERE company_id = ? AND contact_id = ? AND status = 'active' AND start_date <= ? AND end_date >= ? ORDER BY end_date DESC LIMIT 1`,
    companyId, contactId, date, date);
}

/** Open a ticket (used by staff and by the customer portal). */
export async function createTicket(db: D1Database, companyId: string, input: { contact_id: string; subject: string; description?: string | null; category?: string | null; asset?: string | null; priority?: string; assigned_user_id?: string | null; source: "staff" | "portal" }, userId: string | null) {
  const id = newId();
  const number = await nextNumber(db, "tickets", companyId, "TKT-");
  const priority = input.priority ?? "normal";
  const today = todayIso();
  const contract = await activeContract(db, companyId, input.contact_id, today);
  await batch(db, [stmt(db, `INSERT INTO tickets (id, company_id, number, contact_id, contract_id, subject, description, category, asset, priority, assigned_user_id, due_date, source, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, companyId, number, input.contact_id, contract?.id ?? null, input.subject, input.description ?? null, input.category ?? null, input.asset ?? null, priority,
    input.assigned_user_id ?? null, addDays(today, SLA_DAYS[priority] ?? 3), input.source, userId)]);
  return { id, number, contract };
}

// ── Tickets ──

service.get("/tickets", async (c) => {
  view(c);
  const co = c.get("company");
  const status = c.req.query("status") ?? "active";
  const mine = c.req.query("mine") === "1";
  const where = status === "active" ? "t.status IN ('open','in_progress','waiting')" : status === "all" ? "1 = 1" : "t.status = ?";
  const rows = await all<{ status: string; due_date: string | null }>(c.env.DB,
    `SELECT t.*, ct.name AS customer, u.name AS assignee, sc.number AS contract_number,
            (SELECT COALESCE(SUM(minutes), 0) FROM ticket_notes n WHERE n.ticket_id = t.id) AS minutes
       FROM tickets t JOIN contacts ct ON ct.id = t.contact_id LEFT JOIN users u ON u.id = t.assigned_user_id LEFT JOIN service_contracts sc ON sc.id = t.contract_id
      WHERE t.company_id = ? AND ${where} ${mine ? "AND t.assigned_user_id = ?" : ""}
      ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.due_date, t.created_at LIMIT 500`,
    ...[co.id, ...(status !== "active" && status !== "all" ? [status] : []), ...(mine ? [c.get("user").id] : [])]);
  const counts = await all<{ status: string; n: number }>(c.env.DB, `SELECT status, COUNT(*) AS n FROM tickets WHERE company_id = ? GROUP BY status`, co.id);
  const overdue = await first<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM tickets WHERE company_id = ? AND status IN ('open','in_progress','waiting') AND due_date < ?`, co.id, todayIso());
  return c.json({ tickets: rows, counts: Object.fromEntries(counts.map((x) => [x.status, x.n])), overdue: overdue?.n ?? 0, today: todayIso() });
});

const ticketSchema = z.object({
  contact_id: idStr, subject: reqText(200), description: shortText(4000).nullish(), category: shortText(60).nullish(), asset: shortText(120).nullish(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(), assigned_user_id: optId,
});

service.post("/tickets", async (c) => {
  edit(c);
  const co = c.get("company");
  const input = await body(c, ticketSchema);
  if (!(await first(c.env.DB, `SELECT 1 FROM contacts WHERE id = ? AND company_id = ? AND kind IN ('customer','both')`, input.contact_id, co.id))) throw badRequest("Choose a customer");
  const t = await createTicket(c.env.DB, co.id, { ...input, source: "staff" }, c.get("user").id);
  await batch(c.env.DB, [audit(c, "ticket.create", "ticket", t.id, { number: t.number, subject: input.subject })]);
  return c.json({ id: t.id, number: t.number, contract: t.contract }, 201);
});

service.get("/tickets/:id", async (c) => {
  view(c);
  const t = await first(c.env.DB, `SELECT t.*, ct.name AS customer, ct.phone, ct.email, u.name AS assignee, sc.number AS contract_number, sc.title AS contract_title, sc.end_date AS contract_end, d.number AS invoice_number
      FROM tickets t JOIN contacts ct ON ct.id = t.contact_id LEFT JOIN users u ON u.id = t.assigned_user_id LEFT JOIN service_contracts sc ON sc.id = t.contract_id LEFT JOIN documents d ON d.id = t.invoice_id
     WHERE t.id = ? AND t.company_id = ?`, c.req.param("id"), c.get("company").id);
  if (!t) throw notFound("Ticket");
  const notes = await all(c.env.DB, `SELECT n.*, u.name AS user FROM ticket_notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.ticket_id = ? ORDER BY n.created_at`, c.req.param("id"));
  return c.json({ ticket: t, notes });
});

service.patch("/tickets/:id", async (c) => {
  edit(c);
  const co = c.get("company");
  const t = await first<{ id: string; status: string; number: string; priority: string; created_at: string }>(c.env.DB, `SELECT id, status, number, priority, created_at FROM tickets WHERE id = ? AND company_id = ?`, c.req.param("id"), co.id);
  if (!t) throw notFound("Ticket");
  const input = await body(c, z.object({
    status: z.enum(["open", "in_progress", "waiting", "resolved", "closed"]).optional(), priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
    assigned_user_id: optId, resolution: shortText(2000).nullish(), category: shortText(60).nullish(), due_date: isoDate.nullish(),
  }));
  if ((input.status === "resolved" || input.status === "closed") && t.status !== "resolved" && t.status !== "closed" && !input.resolution) throw badRequest("Say how it was resolved");
  const set: [string, string | number | null][] = [];
  for (const k of ["status", "priority", "assigned_user_id", "resolution", "category", "due_date"] as const) if (input[k] !== undefined) set.push([k, input[k] ?? null]);
  if (input.priority && input.priority !== t.priority && input.due_date === undefined) set.push(["due_date", addDays(t.created_at.slice(0, 10), SLA_DAYS[input.priority])]);
  if (input.status === "resolved" || input.status === "closed") set.push(["resolved_at", new Date().toISOString()]);
  if (input.status && input.status !== "resolved" && input.status !== "closed") set.push(["resolved_at", null]);
  if (!set.length) return c.json({ ok: true });
  await batch(c.env.DB, [
    stmt(c.env.DB, `UPDATE tickets SET ${set.map(([k]) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, ...set.map(([, v]) => v), new Date().toISOString(), t.id),
    audit(c, "ticket.update", "ticket", t.id, { number: t.number, ...input }),
  ]);
  return c.json({ ok: true });
});

service.post("/tickets/:id/notes", async (c) => {
  edit(c);
  const t = await first<{ id: string; status: string }>(c.env.DB, `SELECT id, status FROM tickets WHERE id = ? AND company_id = ?`, c.req.param("id"), c.get("company").id);
  if (!t) throw notFound("Ticket");
  const input = await body(c, z.object({ note: reqText(4000), minutes: z.number().int().min(0).max(24 * 60).optional(), public: z.boolean().optional() }));
  await batch(c.env.DB, [
    stmt(c.env.DB, `INSERT INTO ticket_notes (id, ticket_id, user_id, note, minutes, public) VALUES (?,?,?,?,?,?)`, newId(), t.id, c.get("user").id, input.note, input.minutes ?? 0, input.public ? 1 : 0),
    stmt(c.env.DB, `UPDATE tickets SET updated_at = ?, status = CASE WHEN status = 'open' THEN 'in_progress' ELSE status END WHERE id = ?`, new Date().toISOString(), t.id),
  ]);
  return c.json({ ok: true }, 201);
});

/** A draft invoice for the work on a ticket: the time spent at an hourly rate, plus any parts. */
service.post("/tickets/:id/invoice", async (c) => {
  requirePerm(c, "sales.create");
  const co = c.get("company");
  const t = await first<{ id: string; number: string; subject: string; contact_id: string; invoice_id: string | null }>(c.env.DB, `SELECT id, number, subject, contact_id, invoice_id FROM tickets WHERE id = ? AND company_id = ?`, c.req.param("id"), co.id);
  if (!t) throw notFound("Ticket");
  if (t.invoice_id) throw conflict("ALREADY_BILLED", "This ticket is already billed");
  const input = await body(c, z.object({
    hourly_rate: z.union([z.string(), z.number()]).nullish(),
    lines: z.array(z.object({ item_id: optId, description: reqText(300), quantity: z.union([z.string(), z.number()]), unit_price: z.union([z.string(), z.number()]) })).max(50).optional(),
  }));
  const exp = currencyExponent(co.base_currency);
  const minutes = (await first<{ m: number }>(c.env.DB, `SELECT COALESCE(SUM(minutes), 0) AS m FROM ticket_notes WHERE ticket_id = ?`, t.id))?.m ?? 0;
  const acc = await first<{ id: string }>(c.env.DB, `SELECT id FROM accounts WHERE company_id = ? AND system_key IN ('SERVICE_INCOME','SALES') ORDER BY system_key = 'SERVICE_INCOME' DESC LIMIT 1`, co.id);
  const items = (input.lines ?? []).filter((l) => l.item_id);
  const tax = items.length ? await all<{ id: string; tax_code_id: string | null; hsn_sac: string | null }>(c.env.DB, `SELECT id, tax_code_id, hsn_sac FROM items WHERE company_id = ? AND id IN (${items.map(() => "?").join(",")})`, co.id, ...items.map((l) => l.item_id!)) : [];
  const lines = [
    ...(input.hourly_rate && minutes ? [{ description: `Service (${t.number}: ${t.subject}) — ${(minutes / 60).toFixed(2)} h`, qty_milli: Math.round((minutes * 1000) / 60), unit_price: minor(input.hourly_rate, exp, "hourly rate"), discount_bp: 0, account_id: acc?.id ?? null }] : []),
    ...(input.lines ?? []).map((l) => {
      const it = tax.find((x) => x.id === l.item_id);
      return { item_id: l.item_id ?? null, description: l.description, qty_milli: qty(l.quantity), unit_price: minor(l.unit_price, exp, "price"), discount_bp: 0, account_id: l.item_id ? null : acc?.id ?? null, tax_code_id: it?.tax_code_id ?? null, hsn_sac: it?.hsn_sac ?? null };
    }),
  ];
  if (!lines.length) throw badRequest(minutes ? "Give an hourly rate or the charges" : "No time is logged on this ticket: give the charges");
  const prepared = await prepareDraft(c, { doc_type: "invoice", contact_id: t.contact_id, issue_date: todayIso(), currency: co.base_currency, reference: t.number, lines });
  await batch(c.env.DB, [...prepared.stmts, stmt(c.env.DB, `UPDATE tickets SET invoice_id = ? WHERE id = ?`, prepared.id, t.id), audit(c, "ticket.invoice", "ticket", t.id, { number: t.number, invoice_id: prepared.id })]);
  return c.json({ id: prepared.id }, 201);
});

// ── AMC / service contracts ──

const PERIOD_MONTHS: Record<string, number> = { monthly: 1, quarterly: 3, yearly: 12 };

service.get("/contracts", async (c) => {
  view(c);
  const co = c.get("company");
  const today = todayIso();
  const rows = await all<{ status: string; end_date: string; start_date: string; billing: string; billed_to: string | null }>(c.env.DB,
    `SELECT sc.*, ct.name AS customer, (SELECT COUNT(*) FROM tickets t WHERE t.contract_id = sc.id) AS tickets FROM service_contracts sc JOIN contacts ct ON ct.id = sc.contact_id
      WHERE sc.company_id = ? ORDER BY CASE WHEN sc.status = 'active' THEN 0 ELSE 1 END, sc.end_date LIMIT 500`, co.id);
  const soon = addDays(today, 30);
  return c.json({
    contracts: rows.map((r) => ({
      ...r,
      state: r.status !== "active" ? r.status : r.end_date < today ? "expired" : r.start_date > today ? "upcoming" : r.end_date <= soon ? "expiring" : "active",
      to_bill: r.status === "active" && (r.billing === "once" ? !r.billed_to : (r.billed_to ?? addDays(r.start_date, -1)) < r.end_date && (r.billed_to ?? addDays(r.start_date, -1)) < today),
    })),
    today,
  });
});

const contractSchema = z.object({
  contact_id: idStr, title: reqText(150), start_date: isoDate, end_date: isoDate,
  billing: z.enum(["once", "monthly", "quarterly", "yearly"]), amount: z.union([z.string(), z.number()]),
  visits_included: z.number().int().min(0).max(1000).nullish(), covers: shortText(1000).nullish(), notes: shortText(1000).nullish(),
});

service.post("/contracts", async (c) => {
  edit(c);
  const co = c.get("company");
  const input = await body(c, contractSchema);
  if (input.end_date < input.start_date) throw badRequest("The end date is before the start date");
  const ct = await first<{ currency: string | null }>(c.env.DB, `SELECT currency FROM contacts WHERE id = ? AND company_id = ? AND kind IN ('customer','both')`, input.contact_id, co.id);
  if (!ct) throw badRequest("Choose a customer");
  const currency = ct.currency || co.base_currency;
  const id = newId();
  const number = await nextNumber(c.env.DB, "service_contracts", co.id, "AMC-");
  await batch(c.env.DB, [
    stmt(c.env.DB, `INSERT INTO service_contracts (id, company_id, number, contact_id, title, start_date, end_date, billing, amount, currency, visits_included, covers, notes, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, co.id, number, input.contact_id, input.title, input.start_date, input.end_date, input.billing, minor(input.amount, currencyExponent(currency)), currency,
      input.visits_included ?? null, input.covers ?? null, input.notes ?? null, c.get("user").id),
    audit(c, "contract.create", "service_contract", id, { number, title: input.title }),
  ]);
  return c.json({ id, number }, 201);
});

/** A draft invoice for the contract's next unbilled period (or the whole contract, for one-time billing). */
service.post("/contracts/:id/invoice", async (c) => {
  requirePerm(c, "sales.create");
  const co = c.get("company");
  const k = await first<{ id: string; number: string; title: string; contact_id: string; start_date: string; end_date: string; billing: string; amount: number; currency: string; billed_to: string | null; status: string }>(c.env.DB,
    `SELECT * FROM service_contracts WHERE id = ? AND company_id = ?`, c.req.param("id"), co.id);
  if (!k) throw notFound("Contract");
  if (k.status !== "active") throw conflict("NOT_ACTIVE", "This contract is not active");
  if (k.amount <= 0) throw badRequest("This contract has no amount to bill");
  let from: string, to: string;
  if (k.billing === "once") {
    if (k.billed_to) throw conflict("ALREADY_BILLED", "This contract is already billed");
    [from, to] = [k.start_date, k.end_date];
  } else {
    from = k.billed_to ? addDays(k.billed_to, 1) : k.start_date;
    if (from > k.end_date) throw conflict("ALREADY_BILLED", "Every period of this contract is billed");
    to = addDays(addMonths(from, PERIOD_MONTHS[k.billing]), -1);
    if (to > k.end_date) to = k.end_date;
  }
  const acc = await first<{ id: string }>(c.env.DB, `SELECT id FROM accounts WHERE company_id = ? AND system_key IN ('SERVICE_INCOME','SALES') ORDER BY system_key = 'SERVICE_INCOME' DESC LIMIT 1`, co.id);
  const prepared = await prepareDraft(c, {
    doc_type: "invoice", contact_id: k.contact_id, issue_date: todayIso(), currency: k.currency, reference: k.number,
    lines: [{ description: `${k.title} (${k.number}) — ${from} to ${to}`, qty_milli: 1000, unit_price: k.amount, discount_bp: 0, account_id: acc?.id ?? null }],
  });
  await batch(c.env.DB, [...prepared.stmts, stmt(c.env.DB, `UPDATE service_contracts SET billed_to = ? WHERE id = ?`, to, k.id), audit(c, "contract.invoice", "service_contract", k.id, { number: k.number, from, to, invoice_id: prepared.id })]);
  return c.json({ id: prepared.id, from, to }, 201);
});

/** Renew: a new contract for the next term (same length unless given), starting the day after this one ends. */
service.post("/contracts/:id/renew", async (c) => {
  edit(c);
  const co = c.get("company");
  const k = await first<{ id: string; number: string; title: string; contact_id: string; start_date: string; end_date: string; billing: string; amount: number; currency: string; visits_included: number | null; covers: string | null; status: string }>(c.env.DB,
    `SELECT * FROM service_contracts WHERE id = ? AND company_id = ?`, c.req.param("id"), co.id);
  if (!k) throw notFound("Contract");
  if (k.status !== "active") throw conflict("NOT_ACTIVE", "Only an active contract can be renewed");
  const input = await body(c, z.object({ months: z.number().int().min(1).max(120).optional(), amount: z.union([z.string(), z.number()]).nullish() }));
  const start = addDays(k.end_date, 1);
  const months = input.months ?? Math.max(1, Math.round((Date.parse(k.end_date) - Date.parse(k.start_date)) / (30.44 * 86_400_000)));
  const end = addDays(addMonths(start, months), -1);
  const id = newId();
  const number = await nextNumber(c.env.DB, "service_contracts", co.id, "AMC-");
  await batch(c.env.DB, [
    stmt(c.env.DB, `INSERT INTO service_contracts (id, company_id, number, contact_id, title, start_date, end_date, billing, amount, currency, visits_included, covers, renewed_from, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, co.id, number, k.contact_id, k.title, start, end, k.billing, input.amount ? minor(input.amount, currencyExponent(k.currency)) : k.amount, k.currency, k.visits_included, k.covers, k.id, c.get("user").id),
    stmt(c.env.DB, `UPDATE service_contracts SET status = 'renewed' WHERE id = ?`, k.id),
    audit(c, "contract.renew", "service_contract", k.id, { from: k.number, to: number }),
  ]);
  return c.json({ id, number, start_date: start, end_date: end }, 201);
});

service.post("/contracts/:id/cancel", async (c) => {
  edit(c);
  const k = await first<{ number: string; status: string }>(c.env.DB, `SELECT number, status FROM service_contracts WHERE id = ? AND company_id = ?`, c.req.param("id"), c.get("company").id);
  if (!k) throw notFound("Contract");
  if (k.status !== "active") throw conflict("NOT_ACTIVE", "This contract is not active");
  await batch(c.env.DB, [stmt(c.env.DB, `UPDATE service_contracts SET status = 'cancelled' WHERE id = ?`, c.req.param("id")), audit(c, "contract.cancel", "service_contract", c.req.param("id"), { number: k.number })]);
  return c.json({ ok: true });
});
