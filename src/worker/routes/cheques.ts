import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { all, batch, first, stmt, todayIso } from "../lib/db";
import { badRequest, conflict, notFound } from "../lib/errors";
import { body, idStr, isoDate, minor, optId, reqText, shortText } from "../lib/validate";
import { newId } from "../lib/crypto";
import { audit, requireAnyPerm, requirePerm } from "../lib/auth";
import { currencyExponent } from "@shared/currencies";
import { recordPayment, voidPayment } from "../services/payments";

/**
 * Cheque register (with post-dated cheques). A cheque is a promise until it clears: it posts nothing to the books.
 * Clearing records the receipt or payment (applied to the invoices or bills chosen); a bounce reverses that payment.
 */
export const cheques = new Hono<AppEnv>();

const perm = (direction: string) => (direction === "in" ? "sales.post" : "purchase.post") as "sales.post" | "purchase.post";
type Row = { id: string; direction: string; contact_id: string; cheque_no: string; cheque_date: string; currency: string; amount: number; account_id: string | null; status: string; payment_id: string | null; allocations: string | null };

async function load(c: { env: AppEnv["Bindings"]; get: (k: "company") => { id: string } }, id: string) {
  const r = await first<Row>(c.env.DB, `SELECT * FROM cheques WHERE id = ? AND company_id = ?`, id, c.get("company").id);
  if (!r) throw notFound("Cheque");
  return r;
}

cheques.get("/", async (c) => {
  requireAnyPerm(c, "sales.view", "purchase.view");
  const co = c.get("company");
  const status = c.req.query("status");
  const direction = c.req.query("direction");
  const rows = await all(c.env.DB,
    `SELECT q.*, ct.name AS party, a.name AS account, p.number AS payment_number FROM cheques q JOIN contacts ct ON ct.id = q.contact_id
       LEFT JOIN accounts a ON a.id = q.account_id LEFT JOIN payments p ON p.id = q.payment_id
      WHERE q.company_id = ? ${status ? "AND q.status = ?" : ""} ${direction ? "AND q.direction = ?" : ""}
      ORDER BY CASE WHEN q.status IN ('pending','deposited') THEN 0 ELSE 1 END, q.cheque_date, q.created_at LIMIT 500`,
    ...[co.id, ...(status ? [status] : []), ...(direction ? [direction] : [])]);
  const today = todayIso();
  const open = (rows as { status: string; direction: string; amount: number; cheque_date: string }[]).filter((r) => r.status === "pending" || r.status === "deposited");
  return c.json({
    cheques: rows,
    summary: {
      to_receive: open.filter((r) => r.direction === "in").reduce((s, r) => s + r.amount, 0),
      to_pay: open.filter((r) => r.direction === "out").reduce((s, r) => s + r.amount, 0),
      due_now: open.filter((r) => r.cheque_date <= today).length,
    },
  });
});

cheques.get("/:id", async (c) => {
  requireAnyPerm(c, "sales.view", "purchase.view");
  const r = await first(c.env.DB,
    `SELECT q.*, ct.name AS party, a.name AS account FROM cheques q JOIN contacts ct ON ct.id = q.contact_id LEFT JOIN accounts a ON a.id = q.account_id
      WHERE q.id = ? AND q.company_id = ?`, c.req.param("id"), c.get("company").id);
  if (!r) throw notFound("Cheque");
  return c.json({ cheque: r });
});

const chequeSchema = z.object({
  direction: z.enum(["in", "out"]),
  contact_id: idStr,
  cheque_no: reqText(20),
  bank_name: shortText(80).nullish(),
  cheque_date: isoDate,
  amount: z.union([z.string(), z.number()]),
  account_id: optId,
  payee_name: shortText(120).nullish(),
  notes: shortText(300).nullish(),
  allocations: z.array(z.object({ document_id: idStr, amount: z.union([z.string(), z.number()]) })).max(50).optional(),
});

cheques.post("/", async (c) => {
  const input = await body(c, chequeSchema);
  requirePerm(c, perm(input.direction));
  const co = c.get("company");
  const ct = await first<{ kind: string; currency: string | null; name: string }>(c.env.DB, `SELECT kind, currency, name FROM contacts WHERE id = ? AND company_id = ?`, input.contact_id, co.id);
  if (!ct) throw badRequest("Choose the customer or supplier");
  const currency = ct.currency || co.base_currency;
  const exp = currencyExponent(currency);
  const amount = minor(input.amount, exp);
  if (amount <= 0) throw badRequest("Amount must be positive");
  if (input.direction === "out" && !input.account_id) throw badRequest("Choose the bank account the cheque is drawn on");
  if (input.account_id) {
    const a = await first<{ subtype: string }>(c.env.DB, `SELECT subtype FROM accounts WHERE id = ? AND company_id = ? AND is_group = 0 AND is_active = 1`, input.account_id, co.id);
    if (!a || a.subtype !== "bank") throw badRequest("Choose a bank account");
  }
  const allocations = (input.allocations ?? []).map((x) => ({ document_id: x.document_id, amount: minor(x.amount, exp) })).filter((x) => x.amount > 0);
  if (allocations.reduce((s, x) => s + x.amount, 0) > amount) throw badRequest("The invoices chosen add up to more than the cheque");
  const id = newId();
  await batch(c.env.DB, [
    stmt(c.env.DB, `INSERT INTO cheques (id, company_id, direction, contact_id, cheque_no, bank_name, cheque_date, currency, amount, account_id, allocations, payee_name, notes, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, co.id, input.direction, input.contact_id, input.cheque_no, input.bank_name ?? null, input.cheque_date, currency, amount, input.account_id ?? null,
      allocations.length ? JSON.stringify(allocations) : null, input.payee_name ?? null, input.notes ?? null, c.get("user").id),
    audit(c, "cheque.create", "cheque", id, { direction: input.direction, cheque_no: input.cheque_no, cheque_date: input.cheque_date, amount, party: ct.name }),
  ]);
  return c.json({ id }, 201);
});

/** Cheque received: handed to the bank (still not cleared). */
cheques.post("/:id/deposit", async (c) => {
  const q = await load(c, c.req.param("id"));
  requirePerm(c, perm(q.direction));
  const input = await body(c, z.object({ date: isoDate.optional(), account_id: optId }));
  if (q.status !== "pending") throw conflict("NOT_PENDING", "Only a cheque in hand can be deposited");
  await batch(c.env.DB, [
    stmt(c.env.DB, `UPDATE cheques SET status = 'deposited', status_date = ?, account_id = COALESCE(?, account_id) WHERE id = ?`, input.date ?? todayIso(), input.account_id ?? null, q.id),
    audit(c, "cheque.deposit", "cheque", q.id, { cheque_no: q.cheque_no }),
  ]);
  return c.json({ ok: true });
});

/** The cheque cleared: the receipt or payment is recorded now. */
cheques.post("/:id/clear", async (c) => {
  const q = await load(c, c.req.param("id"));
  requirePerm(c, perm(q.direction));
  const input = await body(c, z.object({ date: isoDate.optional(), account_id: optId }));
  if (q.status !== "pending" && q.status !== "deposited") throw conflict("NOT_OPEN", "This cheque is already cleared, bounced or cancelled");
  const date = input.date ?? (q.cheque_date > todayIso() ? q.cheque_date : todayIso());
  if (date < q.cheque_date) throw badRequest(`This cheque is dated ${q.cheque_date}: it cannot clear before that date`);
  const account = input.account_id ?? q.account_id;
  if (!account) throw badRequest("Choose the bank account the cheque was deposited into");
  const p = await recordPayment(c, {
    direction: q.direction as "in" | "out", contact_id: q.contact_id, payment_date: date, account_id: account, currency: q.currency, amount: q.amount,
    method: "cheque", reference: `Cheque ${q.cheque_no}`, notes: null, idempotency_key: `cheque:${q.id}`,
    allocations: q.allocations ? JSON.parse(q.allocations) : [],
  });
  await batch(c.env.DB, [
    stmt(c.env.DB, `UPDATE cheques SET status = 'cleared', status_date = ?, payment_id = ?, account_id = ? WHERE id = ?`, date, p.id, account, q.id),
    audit(c, "cheque.clear", "cheque", q.id, { cheque_no: q.cheque_no, payment_id: p.id }),
  ]);
  return c.json({ ok: true, payment_id: p.id });
});

/** The cheque bounced: if it had cleared, its receipt or payment is reversed, so the invoice or bill is unpaid again. */
cheques.post("/:id/bounce", async (c) => {
  const q = await load(c, c.req.param("id"));
  requirePerm(c, perm(q.direction));
  const input = await body(c, z.object({ date: isoDate.optional(), reason: shortText(200).nullish() }));
  if (q.status === "bounced" || q.status === "cancelled") throw conflict("NOT_OPEN", "This cheque is already bounced or cancelled");
  const date = input.date ?? todayIso();
  if (q.payment_id) await voidPayment(c, q.payment_id, date, `Cheque ${q.cheque_no} bounced${input.reason ? `: ${input.reason}` : ""}`);
  await batch(c.env.DB, [
    stmt(c.env.DB, `UPDATE cheques SET status = 'bounced', status_date = ?, bounce_reason = ? WHERE id = ?`, date, input.reason ?? null, q.id),
    audit(c, "cheque.bounce", "cheque", q.id, { cheque_no: q.cheque_no, reason: input.reason ?? null, reversed_payment: q.payment_id }),
  ]);
  return c.json({ ok: true });
});

cheques.post("/:id/cancel", async (c) => {
  const q = await load(c, c.req.param("id"));
  requirePerm(c, perm(q.direction));
  const input = await body(c, z.object({ reason: shortText(200).nullish() }));
  if (q.status !== "pending" && q.status !== "deposited") throw conflict("NOT_OPEN", "Only an uncleared cheque can be cancelled (a cleared one bounces or its payment is cancelled)");
  await batch(c.env.DB, [
    stmt(c.env.DB, `UPDATE cheques SET status = 'cancelled', status_date = ?, bounce_reason = ? WHERE id = ?`, todayIso(), input.reason ?? null, q.id),
    audit(c, "cheque.cancel", "cheque", q.id, { cheque_no: q.cheque_no, reason: input.reason ?? null }),
  ]);
  return c.json({ ok: true });
});

cheques.post("/:id/printed", async (c) => {
  const q = await load(c, c.req.param("id"));
  requirePerm(c, perm(q.direction));
  await stmt(c.env.DB, `UPDATE cheques SET printed_at = ? WHERE id = ?`, new Date().toISOString(), q.id).run();
  return c.json({ ok: true });
});

/** Where each part of the cheque is printed (millimetres from the cheque's top-left corner), for the company's bank. */
const layoutSchema = z.object({
  width: z.number().min(100).max(250), height: z.number().min(50).max(120),
  date: z.object({ x: z.number(), y: z.number(), spacing: z.number().min(0).max(10) }),
  payee: z.object({ x: z.number(), y: z.number() }),
  words: z.object({ x: z.number(), y: z.number(), width: z.number(), line2_y: z.number() }),
  figures: z.object({ x: z.number(), y: z.number() }),
  ac_payee: z.boolean(),
});
cheques.put("/layout", async (c) => {
  requirePerm(c, "company.manage");
  const input = await body(c, layoutSchema);
  await batch(c.env.DB, [
    stmt(c.env.DB, `UPDATE companies SET cheque_layout = ? WHERE id = ?`, JSON.stringify(input), c.get("company").id),
    audit(c, "company.cheque_layout", "company", c.get("company").id, input),
  ]);
  return c.json({ ok: true });
});
