import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, CompanyRow } from "../env";
import { all, batch, first, run } from "../lib/db";
import { AppError, badRequest, notFound } from "../lib/errors";
import { body, shortText } from "../lib/validate";
import { audit, clientIp, rateLimit, requireAnyPerm, requirePerm } from "../lib/auth";
import {
  checkCheckoutSignature, checkRazorpayKeys, checkWebhookSignature, collectionSettings, createInvoiceOrder, documentToken, encryptSecret, onlineReady,
  payableInvoice, portalToken, secretsReady, settleOnlineOrder,
} from "../services/collect";
import { emailOn, siteUrl } from "../services/email";

// ── Company: settings for online payments and reminders; portal links ──

export const collect = new Hono<AppEnv>();

collect.get("/", async (c) => {
  requireAnyPerm(c, "company.manage", "sales.view");
  const company = c.get("company");
  const s = await collectionSettings(c.env, company.id);
  return c.json({
    online_enabled: Boolean(s?.online_enabled), razorpay_key_id: s?.razorpay_key_id ?? null, has_secret: Boolean(s?.razorpay_secret_enc), has_webhook_secret: Boolean(s?.razorpay_webhook_secret_enc),
    deposit_account_id: s?.deposit_account_id ?? null, ready: await onlineReady(c.env, company.id),
    reminders_enabled: Boolean(s?.reminders_enabled), remind_before_days: s?.remind_before_days ?? 3, remind_on_due: s ? Boolean(s.remind_on_due) : true,
    remind_every_days: s?.remind_every_days ?? 7, remind_max_after: s?.remind_max_after ?? 3,
    webhook_url: `${siteUrl(c.env, c.req.url)}/api/pay/webhook/${company.id}`,
    secrets_ready: secretsReady(c.env), email_ready: emailOn(c.env),
  });
});

collect.put("/", async (c) => {
  requirePerm(c, "company.manage");
  const company = c.get("company");
  const input = await body(c, z.object({
    online_enabled: z.boolean(),
    razorpay_key_id: z.string().trim().regex(/^rzp_(live|test)_[A-Za-z0-9]{6,40}$/, "The Key ID starts with rzp_live_ or rzp_test_").nullish().or(z.literal("")),
    razorpay_secret: shortText(200).nullish(),
    razorpay_webhook_secret: shortText(200).nullish(),
    deposit_account_id: z.string().max(64).nullish(),
    reminders_enabled: z.boolean(),
    remind_before_days: z.number().int().min(0).max(30),
    remind_on_due: z.boolean(),
    remind_every_days: z.number().int().min(1).max(60),
    remind_max_after: z.number().int().min(0).max(12),
  }));
  const cur = await collectionSettings(c.env, company.id);
  if (input.deposit_account_id) {
    const a = await first<{ subtype: string; is_group: number; is_active: number }>(c.env.DB, `SELECT subtype, is_group, is_active FROM accounts WHERE id = ? AND company_id = ?`, input.deposit_account_id, company.id);
    if (!a || a.is_group || !a.is_active || !["cash", "bank"].includes(a.subtype)) throw badRequest("Choose the bank account where online payments arrive");
  }
  const keyId = input.razorpay_key_id || null;
  let secretEnc = cur?.razorpay_secret_enc ?? null, hookEnc = cur?.razorpay_webhook_secret_enc ?? null;
  if (input.razorpay_secret || input.razorpay_webhook_secret) {
    if (!secretsReady(c.env)) throw new AppError(503, "DATA_KEY_MISSING", "Online payments are not available yet: the LedgerFox server needs its DATA_KEY secret. Please contact LedgerFox.");
  }
  if (input.razorpay_secret) {
    if (!keyId) throw badRequest("Enter the Razorpay Key ID with the Key Secret");
    await checkRazorpayKeys(keyId, input.razorpay_secret);
    secretEnc = await encryptSecret(c.env, input.razorpay_secret);
  }
  if (input.razorpay_webhook_secret) hookEnc = await encryptSecret(c.env, input.razorpay_webhook_secret);
  if (!keyId) { secretEnc = null; hookEnc = null; }
  if (input.online_enabled && (!keyId || !secretEnc || !input.deposit_account_id)) throw badRequest("To take payments online, enter the Razorpay Key ID and Key Secret and choose the bank account they arrive in");
  if (input.reminders_enabled && !emailOn(c.env)) throw new AppError(409, "EMAIL_OFF", "Reminders are sent by email, which is not set up on this LedgerFox yet. Please contact LedgerFox.");
  await batch(c.env.DB, [
    c.env.DB.prepare(`INSERT INTO collection_settings (company_id, online_enabled, razorpay_key_id, razorpay_secret_enc, razorpay_webhook_secret_enc, deposit_account_id,
        reminders_enabled, remind_before_days, remind_on_due, remind_every_days, remind_max_after, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT (company_id) DO UPDATE SET online_enabled = excluded.online_enabled, razorpay_key_id = excluded.razorpay_key_id, razorpay_secret_enc = excluded.razorpay_secret_enc,
        razorpay_webhook_secret_enc = excluded.razorpay_webhook_secret_enc, deposit_account_id = excluded.deposit_account_id, reminders_enabled = excluded.reminders_enabled,
        remind_before_days = excluded.remind_before_days, remind_on_due = excluded.remind_on_due, remind_every_days = excluded.remind_every_days,
        remind_max_after = excluded.remind_max_after, updated_at = excluded.updated_at`).bind(
      company.id, input.online_enabled ? 1 : 0, keyId, secretEnc, hookEnc, input.deposit_account_id || null, input.reminders_enabled ? 1 : 0,
      input.remind_before_days, input.remind_on_due ? 1 : 0, input.remind_every_days, input.remind_max_after, new Date().toISOString()),
    // Never the secrets themselves in the audit trail.
    audit(c, "company.collection_settings", "company", company.id, { online_enabled: input.online_enabled, key_id: keyId, secret_changed: Boolean(input.razorpay_secret), reminders: input.reminders_enabled }),
  ]);
  return c.json({ ok: true });
});

/** A customer's private portal link (made on first use; `renew` replaces it, so the old link stops working). */
collect.post("/portal/:contactId", async (c) => {
  requireAnyPerm(c, "customers.write", "sales.view");
  const company = c.get("company");
  const input = await body(c, z.object({ renew: z.boolean().optional() }));
  const ct = await first<{ kind: string }>(c.env.DB, `SELECT kind FROM contacts WHERE id = ? AND company_id = ?`, c.req.param("contactId"), company.id);
  if (!ct || ct.kind === "supplier") throw notFound("Customer");
  if (input.renew) requirePerm(c, "customers.write");
  const token = await portalToken(c.env, company.id, c.req.param("contactId"), c.get("user").id, Boolean(input.renew));
  return c.json({ token, url: `${siteUrl(c.env, c.req.url)}/portal/${token}` });
});

// ── Public: paying an invoice online (the customer's invoice link) ──

export const payPublic = new Hono<AppEnv>();

async function docForToken(c: { env: AppEnv["Bindings"] }, token: string) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw notFound("Invoice");
  const v = await first<{ entity_id: string; entity_type: string }>(c.env.DB, `SELECT entity_type, entity_id FROM verifications WHERE token = ?`, token);
  if (!v || v.entity_type !== "document") throw notFound("Invoice");
  const doc = await payableInvoice(c.env, v.entity_id);
  if (!doc) throw notFound("Invoice");
  return doc;
}

payPublic.post("/:token/order", async (c) => {
  if (!(await rateLimit(c.env.DB, `payorder:${clientIp(c)}`, 20, 600))) throw new AppError(429, "RATE_LIMITED", "Too many attempts. Try again in a few minutes.");
  const doc = await docForToken(c, c.req.param("token"));
  const co = await first<{ name: string; legal_name: string | null }>(c.env.DB, `SELECT name, legal_name FROM companies WHERE id = ?`, doc.company_id);
  const order = await createInvoiceOrder(c.env, doc);
  return c.json({ ...order, name: co?.legal_name || co?.name, description: `Invoice ${doc.number}`, prefill: { name: doc.contact_name, email: doc.contact_email ?? undefined, contact: doc.contact_phone ?? undefined } });
});

payPublic.post("/:token/confirm", async (c) => {
  const doc = await docForToken(c, c.req.param("token"));
  const input = await body(c, z.object({ razorpay_order_id: z.string().max(64), razorpay_payment_id: z.string().max(64), razorpay_signature: z.string().max(200) }));
  const op = await first<{ document_id: string }>(c.env.DB, `SELECT document_id FROM online_payments WHERE provider_order_id = ?`, input.razorpay_order_id);
  if (!op || op.document_id !== doc.id) throw badRequest("This payment is not for this invoice");
  if (!(await checkCheckoutSignature(c.env, doc.company_id, input.razorpay_order_id, input.razorpay_payment_id, input.razorpay_signature))) throw badRequest("Payment could not be verified");
  const r = await settleOnlineOrder(c, input.razorpay_order_id, input.razorpay_payment_id);
  return c.json({ ok: true, already: r.already });
});

/** Razorpay → the business's webhook (payment.captured / order.paid), in case the customer closed the page early. */
payPublic.post("/webhook/:companyId", async (c) => {
  const companyId = c.req.param("companyId");
  const raw = await c.req.text();
  const sig = c.req.header("x-razorpay-signature") ?? "";
  if (!sig || !(await checkWebhookSignature(c.env, companyId, raw, sig))) throw new AppError(401, "BAD_SIGNATURE", "Invalid signature");
  const evt = JSON.parse(raw) as { event: string; payload?: { payment?: { entity?: { id: string; order_id?: string; status?: string } } } };
  const p = evt.payload?.payment?.entity;
  if ((evt.event === "payment.captured" || evt.event === "order.paid") && p?.order_id) {
    const op = await first<{ company_id: string }>(c.env.DB, `SELECT company_id FROM online_payments WHERE provider_order_id = ?`, p.order_id);
    if (op && op.company_id === companyId) await settleOnlineOrder(c, p.order_id, p.id);
  }
  return c.json({ ok: true });
});

// ── Public: the customer portal ──

export const portalPublic = new Hono<AppEnv>();

async function portalFor(c: { env: AppEnv["Bindings"] }, token: string) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw notFound("Portal");
  const l = await first<{ company_id: string; contact_id: string }>(c.env.DB, `SELECT company_id, contact_id FROM portal_links WHERE token = ? AND revoked_at IS NULL`, token);
  if (!l) throw notFound("Portal");
  return l;
}

portalPublic.get("/:token", async (c) => {
  if (!(await rateLimit(c.env.DB, `portal:${clientIp(c)}`, 120, 600))) throw new AppError(429, "RATE_LIMITED", "Too many requests. Try again in a few minutes.");
  const token = c.req.param("token");
  const l = await portalFor(c, token);
  const co = await first<{ name: string; legal_name: string | null; email: string | null; phone: string | null; address: string | null; city: string | null; base_currency: string; upi_id: string | null }>(c.env.DB,
    `SELECT name, legal_name, email, phone, address, city, base_currency, upi_id FROM companies WHERE id = ?`, l.company_id);
  const ct = await first<{ name: string; email: string | null; currency: string | null }>(c.env.DB, `SELECT name, email, currency FROM contacts WHERE id = ?`, l.contact_id);
  const docs = await all<{ id: string; doc_type: string; variant: string | null; number: string; issue_date: string; due_date: string | null; status: string; currency: string; total: number; amount_settled: number }>(c.env.DB,
    `SELECT id, doc_type, variant, number, issue_date, due_date, status, currency, total, amount_settled FROM documents
      WHERE company_id = ? AND contact_id = ? AND doc_type IN ('invoice','credit_note','quote','sales_order') AND status NOT IN ('draft','void')
      ORDER BY issue_date DESC LIMIT 200`, l.company_id, l.contact_id);
  const withLinks = await Promise.all(docs.map(async (d) => ({ ...d, link: `/verify/${await documentToken(c.env, l.company_id, d.id)}` })));
  const receipts = await all(c.env.DB,
    `SELECT number, payment_date, currency, amount, method, reference FROM payments WHERE company_id = ? AND contact_id = ? AND direction = 'in' AND status = 'posted' ORDER BY payment_date DESC LIMIT 100`,
    l.company_id, l.contact_id);
  const today = new Date().toISOString().slice(0, 10);
  const open = withLinks.filter((d) => d.doc_type === "invoice" && d.status === "posted" && d.total > d.amount_settled);
  await run(c.env.DB, `UPDATE portal_links SET last_opened_at = ? WHERE token = ?`, new Date().toISOString(), token);
  return c.json({
    business: { name: co?.legal_name || co?.name, email: co?.email, phone: co?.phone, address: [co?.address, co?.city].filter(Boolean).join(", ") || null },
    customer: { name: ct?.name },
    online_pay: await onlineReady(c.env, l.company_id),
    summary: {
      outstanding: open.reduce((s, d) => s + d.total - d.amount_settled, 0),
      overdue: open.filter((d) => d.due_date && d.due_date < today).reduce((s, d) => s + d.total - d.amount_settled, 0),
      currency: ct?.currency ?? co?.base_currency, mixed: new Set(open.map((d) => d.currency)).size > 1,
    },
    invoices: withLinks.filter((d) => d.doc_type === "invoice" || d.doc_type === "credit_note"),
    quotes: withLinks.filter((d) => d.doc_type === "quote" || d.doc_type === "sales_order"),
    receipts,
  });
});

/** The customer accepts or declines an open quotation from the portal. */
portalPublic.post("/:token/quotes/:docId/:action{accept|decline}", async (c) => {
  const l = await portalFor(c, c.req.param("token"));
  const d = await first<{ status: string; number: string; doc_type: string }>(c.env.DB, `SELECT status, number, doc_type FROM documents WHERE id = ? AND company_id = ? AND contact_id = ?`, c.req.param("docId"), l.company_id, l.contact_id);
  if (!d || d.doc_type !== "quote") throw notFound("Quotation");
  if (d.status !== "open") throw new AppError(409, "NOT_OPEN", "This quotation can no longer be changed");
  const status = c.req.param("action") === "accept" ? "accepted" : "declined";
  c.set("company", (await first<CompanyRow>(c.env.DB, `SELECT * FROM companies WHERE id = ?`, l.company_id))!);
  await batch(c.env.DB, [
    c.env.DB.prepare(`UPDATE documents SET status = ?, updated_at = ? WHERE id = ? AND status = 'open'`).bind(status, new Date().toISOString(), c.req.param("docId")),
    audit(c, `document.${status}_by_customer`, "document", c.req.param("docId"), { number: d.number, via: "portal" }),
  ]);
  return c.json({ status });
});

