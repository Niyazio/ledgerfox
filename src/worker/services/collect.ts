/**
 * Getting paid: customers pay invoices online through the business's own Razorpay account (money goes straight to
 * the business, never through LedgerFox), and the receipt is recorded and matched to the invoice automatically.
 * Also: customer portal links and automatic payment reminders.
 *
 * The business's Razorpay key secret and webhook secret are stored encrypted with AES-GCM under the DATA_KEY Worker
 * secret; without DATA_KEY, online payments cannot be switched on. Secrets are never sent back to the browser.
 */
import type { Context } from "hono";
import type { AppEnv, CompanyRow, Env, SessionUser } from "../env";
import { all, first, run, todayIso } from "../lib/db";
import { AppError, badRequest } from "../lib/errors";
import { newId, randomToken } from "../lib/crypto";
import { recordPayment } from "./payments";
import { deliverable, sendMail, siteUrl } from "./email";
import { formatMoney as fmtMoney } from "@shared/currencies";

// ── Encryption of stored secrets ──

const enc = new TextEncoder();
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));

export const secretsReady = (env: Env) => Boolean(env.DATA_KEY && env.DATA_KEY.length >= 16);

async function aesKey(env: Env) {
  if (!secretsReady(env)) throw new AppError(503, "DATA_KEY_MISSING", "Online payments are not available yet: the LedgerFox server needs its DATA_KEY secret. Please contact LedgerFox.");
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(`ledgerfox-secrets:${env.DATA_KEY}`));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function encryptSecret(env: Env, plain: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env), enc.encode(plain)));
  return `v1.${b64(iv)}.${b64(ct)}`;
}
export async function decryptSecret(env: Env, stored: string) {
  const [v, iv, ct] = stored.split(".");
  if (v !== "v1" || !iv || !ct) throw new AppError(500, "SECRET_FORMAT", "Stored secret is unreadable");
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await aesKey(env), unb64(ct)));
}

// ── Settings ──

export interface CollectionSettings {
  online_enabled: number; razorpay_key_id: string | null; razorpay_secret_enc: string | null; razorpay_webhook_secret_enc: string | null; deposit_account_id: string | null;
  reminders_enabled: number; remind_before_days: number; remind_on_due: number; remind_every_days: number; remind_max_after: number;
}
export async function collectionSettings(env: Env, companyId: string): Promise<CollectionSettings | null> {
  return first<CollectionSettings>(env.DB, `SELECT * FROM collection_settings WHERE company_id = ?`, companyId);
}

/** Whether customers can pay this company's invoices online right now. */
export async function onlineReady(env: Env, companyId: string) {
  const s = await collectionSettings(env, companyId);
  return Boolean(s?.online_enabled && s.razorpay_key_id && s.razorpay_secret_enc && s.deposit_account_id && secretsReady(env));
}

// ── Razorpay with the business's keys ──

async function hmacHex(secret: string, data: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function sameText(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function razorpayKeys(env: Env, companyId: string) {
  const s = await collectionSettings(env, companyId);
  if (!s?.online_enabled || !s.razorpay_key_id || !s.razorpay_secret_enc || !s.deposit_account_id) throw new AppError(409, "ONLINE_PAY_OFF", "This business does not take online payments yet. Please pay by UPI or bank transfer.");
  return { s, keyId: s.razorpay_key_id, secret: await decryptSecret(env, s.razorpay_secret_enc) };
}

/** Checks the business's keys with Razorpay (used when saving them). */
export async function checkRazorpayKeys(keyId: string, secret: string) {
  const res = await fetch("https://api.razorpay.com/v1/orders?count=1", { headers: { authorization: `Basic ${btoa(`${keyId}:${secret}`)}` } });
  if (res.status === 401) throw badRequest("Razorpay did not accept these keys. Copy the Key ID and Key Secret again from Razorpay → Account & Settings → API Keys.");
  if (!res.ok) throw new AppError(502, "RAZORPAY_UNAVAILABLE", "Could not reach Razorpay to check the keys. Try again in a minute.");
}

interface PayableDoc { id: string; company_id: string; contact_id: string; number: string; currency: string; total: number; amount_settled: number; status: string; doc_type: string; branch_id: string | null; contact_name: string; contact_email: string | null; contact_phone: string | null }

export async function payableInvoice(env: Env, documentId: string) {
  return first<PayableDoc>(env.DB,
    `SELECT d.id, d.company_id, d.contact_id, d.number, d.currency, d.total, d.amount_settled, d.status, d.doc_type, d.branch_id,
            ct.name AS contact_name, ct.email AS contact_email, ct.phone AS contact_phone
       FROM documents d JOIN contacts ct ON ct.id = d.contact_id WHERE d.id = ?`, documentId);
}

/** A Razorpay order for what is still due on the invoice, in its currency. */
export async function createInvoiceOrder(env: Env, doc: PayableDoc) {
  if (doc.doc_type !== "invoice" || doc.status !== "posted") throw badRequest("Only issued invoices can be paid online");
  const due = doc.total - doc.amount_settled;
  if (due <= 0) throw new AppError(409, "ALREADY_PAID", "This invoice is already paid. Thank you!");
  const { keyId, secret } = await razorpayKeys(env, doc.company_id);
  const res = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Basic ${btoa(`${keyId}:${secret}`)}` },
    body: JSON.stringify({ amount: due, currency: doc.currency, receipt: (doc.number ?? doc.id).slice(0, 40), notes: { ledgerfox_document: doc.id, ledgerfox_company: doc.company_id } }),
  });
  if (!res.ok) {
    console.error(JSON.stringify({ level: "error", code: "INVOICE_ORDER_FAILED", status: res.status }));
    throw new AppError(502, "RAZORPAY_ORDER_FAILED", res.status === 401 ? "The business's online payment settings need attention. Please pay by another method." : "Could not start the payment. Try again in a minute.");
  }
  const order = (await res.json()) as { id: string };
  await run(env.DB, `INSERT INTO online_payments (id, company_id, document_id, provider_order_id, amount, currency) VALUES (?,?,?,?,?,?)`,
    newId(), doc.company_id, doc.id, order.id, due, doc.currency);
  return { order_id: order.id, key_id: keyId, amount: due, currency: doc.currency };
}

/** Checkout's success signature: HMAC-SHA256(order_id|payment_id) with the business's key secret. */
export async function checkCheckoutSignature(env: Env, companyId: string, orderId: string, paymentId: string, signature: string) {
  const { secret } = await razorpayKeys(env, companyId);
  return sameText(await hmacHex(secret, `${orderId}|${paymentId}`), signature);
}
export async function checkWebhookSignature(env: Env, companyId: string, rawBody: string, signature: string) {
  const s = await collectionSettings(env, companyId);
  if (!s?.razorpay_webhook_secret_enc) return false;
  return sameText(await hmacHex(await decryptSecret(env, s.razorpay_webhook_secret_enc), rawBody), signature);
}

/**
 * Records a paid online order as a receipt into the deposit account, matched to the invoice (idempotent: the browser
 * and Razorpay's webhook may both report the same payment). Runs as the organisation's owner.
 */
export async function settleOnlineOrder(c: Context<AppEnv>, orderId: string, paymentId: string) {
  const db = c.env.DB;
  const op = await first<{ id: string; company_id: string; document_id: string; amount: number; currency: string; status: string; payment_id: string | null }>(db,
    `SELECT id, company_id, document_id, amount, currency, status, payment_id FROM online_payments WHERE provider_order_id = ?`, orderId);
  if (!op) throw badRequest("Unknown payment order");
  if (op.status === "paid" && op.payment_id) return { payment_id: op.payment_id, already: true };
  const company = await first<CompanyRow>(db, `SELECT * FROM companies WHERE id = ?`, op.company_id);
  const owner = await first<{ id: string; email: string; name: string }>(db, `SELECT u.id, u.email, u.name FROM organisations o JOIN users u ON u.id = o.owner_user_id WHERE o.id = ?`, company!.org_id);
  const s = await collectionSettings(c.env, op.company_id);
  const doc = await payableInvoice(c.env, op.document_id);
  if (!company || !owner || !s?.deposit_account_id || !doc) throw new AppError(500, "SETTLE_FAILED", "Could not record the payment");
  c.set("company", company);
  c.set("user", { id: owner.id, email: owner.email, name: owner.name, username: null, must_change_password: false, session_id: "online-payment" } satisfies SessionUser);
  // Pay what is still due; anything more (the invoice was settled some other way meanwhile) stays as the customer's advance.
  const due = Math.max(0, doc.total - doc.amount_settled);
  const r = await recordPayment(c, {
    direction: "in", contact_id: doc.contact_id, payment_date: todayIso(), account_id: s.deposit_account_id, currency: op.currency, amount: op.amount,
    method: "online", reference: `Razorpay ${paymentId}`, notes: `Paid online for invoice ${doc.number}`, idempotency_key: `rzp:${paymentId}`, branch_id: doc.branch_id,
    allocations: due > 0 ? [{ document_id: doc.id, amount: Math.min(due, op.amount) }] : [],
  });
  await run(db, `UPDATE online_payments SET status = 'paid', provider_payment_id = ?, payment_id = ?, paid_at = ? WHERE id = ?`, paymentId, r.id, new Date().toISOString(), op.id);
  return { payment_id: r.id, already: Boolean((r as { duplicate?: boolean }).duplicate) };
}

// ── Customer portal links ──

export async function portalToken(env: Env, companyId: string, contactId: string, userId: string, renew = false) {
  if (!renew) {
    const have = await first<{ token: string }>(env.DB, `SELECT token FROM portal_links WHERE company_id = ? AND contact_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`, companyId, contactId);
    if (have) return have.token;
  }
  await run(env.DB, `UPDATE portal_links SET revoked_at = ? WHERE company_id = ? AND contact_id = ? AND revoked_at IS NULL`, new Date().toISOString(), companyId, contactId);
  const token = randomToken(24);
  await run(env.DB, `INSERT INTO portal_links (token, company_id, contact_id, created_by) VALUES (?,?,?,?)`, token, companyId, contactId, userId);
  return token;
}

/** The public verification token of a document (the customer's link to view and pay it), made on first use. */
export async function documentToken(env: Env, companyId: string, documentId: string) {
  const have = await first<{ token: string }>(env.DB, `SELECT token FROM verifications WHERE entity_type = 'document' AND entity_id = ?`, documentId);
  if (have) return have.token;
  await run(env.DB, `INSERT INTO verifications (token, company_id, entity_type, entity_id) VALUES (?,?,?,?) ON CONFLICT (entity_type, entity_id) DO NOTHING`, randomToken(16), companyId, "document", documentId);
  return (await first<{ token: string }>(env.DB, `SELECT token FROM verifications WHERE entity_type = 'document' AND entity_id = ?`, documentId))!.token;
}

// ── Automatic payment reminders (daily job) ──

const DAY = 86_400_000;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

/** Which reminder (if any) is due today for an invoice due on `dueDate`. */
export function reminderKind(s: Pick<CollectionSettings, "remind_before_days" | "remind_on_due" | "remind_every_days" | "remind_max_after">, dueDate: string, today: string): string | null {
  const late = daysBetween(dueDate, today);
  if (late < 0) return s.remind_before_days > 0 && -late === s.remind_before_days ? "before" : null;
  if (late === 0) return s.remind_on_due ? "due" : null;
  if (late % s.remind_every_days !== 0) return null;
  const n = late / s.remind_every_days;
  return n <= s.remind_max_after ? `after${n}` : null;
}

export async function sendPaymentReminders(env: Env, today = todayIso()) {
  let sent = 0;
  const companies = await all<{ company_id: string } & CollectionSettings>(env.DB, `SELECT * FROM collection_settings WHERE reminders_enabled = 1`);
  for (const s of companies) {
    const co = await first<{ name: string; legal_name: string | null; email: string | null; phone: string | null; upi_id: string | null; number_locale: string | null }>(env.DB,
      `SELECT name, legal_name, email, phone, upi_id, number_locale FROM companies WHERE id = ?`, s.company_id);
    if (!co) continue;
    const invoices = await all<{ id: string; number: string; due_date: string; currency: string; total: number; amount_settled: number; contact_id: string; contact_name: string; email: string | null }>(env.DB,
      `SELECT d.id, d.number, d.due_date, d.currency, d.total, d.amount_settled, d.contact_id, ct.name AS contact_name, ct.email
         FROM documents d JOIN contacts ct ON ct.id = d.contact_id
        WHERE d.company_id = ? AND d.doc_type = 'invoice' AND d.status = 'posted' AND d.total > d.amount_settled AND d.due_date IS NOT NULL
          AND d.due_date BETWEEN date(?, '-400 days') AND date(?, '+31 days')`, s.company_id, today, today);
    for (const inv of invoices) {
      const kind = reminderKind(s, inv.due_date, today);
      if (!kind || !deliverable(inv.email)) continue;
      // Claim the reminder first, so a re-run never sends it twice.
      const claimed = await run(env.DB, `INSERT OR IGNORE INTO invoice_reminders (document_id, kind, sent_to) VALUES (?,?,?)`, inv.id, kind, inv.email);
      if (!claimed.meta.changes) continue;
      const link = `${siteUrl(env)}/verify/${await documentToken(env, s.company_id, inv.id)}`;
      const due = fmtMoney(inv.total - inv.amount_settled, inv.currency, co.number_locale ?? "en-IN");
      const seller = co.legal_name || co.name;
      const when = kind === "before" ? `is due on ${inv.due_date}` : kind === "due" ? "is due today" : `was due on ${inv.due_date}`;
      const ok = await sendMail(env, {
        to: inv.email!, replyTo: co.email ?? undefined,
        subject: `${kind.startsWith("after") ? "Overdue: " : "Reminder: "}invoice ${inv.number} from ${seller} — ${due}`,
        text: `Dear ${inv.contact_name},\n\nThis is a friendly reminder that invoice ${inv.number} for ${due} ${when}.\n\nView and pay it here:\n${link}\n\nIf you have already paid, please ignore this message — thank you.\n\n${seller}${co.phone ? `\n${co.phone}` : ""}${co.email ? `\n${co.email}` : ""}`,
      });
      if (ok) sent++;
      else await run(env.DB, `DELETE FROM invoice_reminders WHERE document_id = ? AND kind = ?`, inv.id, kind); // not sent: do not mark it as sent
    }
  }
  return sent;
}
