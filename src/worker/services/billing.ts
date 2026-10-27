import type { Context } from "hono";
import type { AppEnv, Env } from "../env";
import { first, run, stmt } from "../lib/db";
import { AppError } from "../lib/errors";
import { newId } from "../lib/crypto";
import { sendReceipt } from "./notices";
import { FEATURE_LABELS, GRACE_DAYS, PLANS, TRIAL_DAYS, TRIAL_PLAN, withGst, type Feature, type Interval, type PlanId } from "@shared/plans";

/** Billing applies only to the hosted edition with BILLING_ENABLED=true; desktop and phone copies are never limited. */
export const billingOn = (env: Env) => env.BILLING_ENABLED === "true" && env.APP_ENV !== "desktop" && env.APP_ENV !== "offline";

export interface Subscription {
  enforced: boolean;
  plan: PlanId;                 // plan whose limits apply now
  paid_plan: PlanId | null;     // plan paid for (may be in grace)
  status: "unlimited" | "trial" | "active" | "grace" | "free";
  interval: Interval | null;
  trial_ends_at: string | null;
  paid_until: string | null;
  days_left: number | null;
}

const DAY = 86_400_000;

export async function subscription(env: Env, orgId: string): Promise<Subscription> {
  if (!billingOn(env)) return { enforced: false, plan: "multi_branch", paid_plan: null, status: "unlimited", interval: null, trial_ends_at: null, paid_until: null, days_left: null };
  let row = await first<{ plan: PlanId; billing_interval: Interval | null; trial_ends_at: string | null; paid_until: string | null }>(env.DB, `SELECT plan, billing_interval, trial_ends_at, paid_until FROM org_subscriptions WHERE org_id = ?`, orgId);
  if (!row) {
    // First look after billing is switched on: every organisation starts with a free trial.
    const trialEnds = new Date(Date.now() + TRIAL_DAYS * DAY).toISOString();
    await run(env.DB, `INSERT INTO org_subscriptions (org_id, plan, trial_ends_at) VALUES (?, 'free', ?) ON CONFLICT (org_id) DO NOTHING`, orgId, trialEnds);
    row = await first(env.DB, `SELECT plan, billing_interval, trial_ends_at, paid_until FROM org_subscriptions WHERE org_id = ?`, orgId);
  }
  const now = Date.now();
  const paidUntil = row!.paid_until ? Date.parse(row!.paid_until) : 0;
  const trialEnds = row!.trial_ends_at ? Date.parse(row!.trial_ends_at) : 0;
  const base = { enforced: true, interval: row!.billing_interval, trial_ends_at: row!.trial_ends_at, paid_until: row!.paid_until };
  if (row!.plan !== "free" && paidUntil >= now) return { ...base, plan: row!.plan, paid_plan: row!.plan, status: "active", days_left: Math.ceil((paidUntil - now) / DAY) };
  if (row!.plan !== "free" && paidUntil && paidUntil + GRACE_DAYS * DAY >= now) return { ...base, plan: row!.plan, paid_plan: row!.plan, status: "grace", days_left: Math.ceil((paidUntil + GRACE_DAYS * DAY - now) / DAY) };
  if (trialEnds >= now) return { ...base, plan: TRIAL_PLAN, paid_plan: null, status: "trial", days_left: Math.ceil((trialEnds - now) / DAY) };
  return { ...base, plan: "free", paid_plan: null, status: "free", days_left: null };
}

const upgradeHint = (s: Subscription) => (s.status === "free" && s.paid_plan === null ? "Choose a plan in Settings → Plan & billing." : "Upgrade in Settings → Plan & billing.");

export async function hasFeature(c: Context<AppEnv>, orgId: string, feature: Feature) {
  const s = await subscription(c.env, orgId);
  return !s.enforced || PLANS[s.plan].features.includes(feature);
}

/** Throws 402 when the organisation's plan does not include the feature. */
export async function requireFeature(c: Context<AppEnv>, orgId: string, feature: Feature) {
  const s = await subscription(c.env, orgId);
  if (!s.enforced || PLANS[s.plan].features.includes(feature)) return;
  throw new AppError(402, "PLAN_FEATURE", `${FEATURE_LABELS[feature]} is not included in the ${PLANS[s.plan].name} plan. ${upgradeHint(s)}`);
}

/** Throws 402 when adding one more user/branch/company would exceed the plan. */
export async function requireCapacity(c: Context<AppEnv>, orgId: string, kind: "users" | "branches" | "companies", companyId?: string) {
  const s = await subscription(c.env, orgId);
  if (!s.enforced) return;
  const limit = PLANS[s.plan].limits[kind];
  const sql = {
    users: [`SELECT COUNT(*) AS n FROM memberships WHERE org_id = ?`, orgId],
    branches: [`SELECT COUNT(*) AS n FROM branches WHERE company_id = ? AND is_active = 1`, companyId ?? ""],
    companies: [`SELECT COUNT(*) AS n FROM companies WHERE org_id = ? AND is_demo = 0`, orgId],
  }[kind] as [string, string];
  const used = (await first<{ n: number }>(c.env.DB, sql[0], sql[1]))?.n ?? 0;
  if (used + 1 > limit) {
    const what = { users: "users", branches: "active branches per company", companies: "companies" }[kind];
    throw new AppError(402, "PLAN_LIMIT", `The ${PLANS[s.plan].name} plan allows ${limit} ${what}. ${upgradeHint(s)}`);
  }
}

export async function usage(env: Env, orgId: string) {
  const r = await first<{ users: number; companies: number; branches: number }>(env.DB,
    `SELECT (SELECT COUNT(*) FROM memberships WHERE org_id = ?) AS users,
            (SELECT COUNT(*) FROM companies WHERE org_id = ? AND is_demo = 0) AS companies,
            (SELECT COALESCE(MAX(n),0) FROM (SELECT COUNT(*) AS n FROM branches b JOIN companies co ON co.id = b.company_id WHERE co.org_id = ? AND b.is_active = 1 GROUP BY b.company_id)) AS branches`, orgId, orgId, orgId);
  return r ?? { users: 0, companies: 0, branches: 0 };
}

// ── Razorpay ──

async function hmacHex(secret: string, data: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Checkout success: signature = HMAC-SHA256(order_id|payment_id, key secret). */
export async function verifyCheckoutSignature(secret: string, orderId: string, paymentId: string, signature: string) {
  return safeEqual(await hmacHex(secret, `${orderId}|${paymentId}`), signature);
}

/** Webhook: signature = HMAC-SHA256(raw body, webhook secret). */
export async function verifyWebhookSignature(secret: string, rawBody: string, signature: string) {
  return safeEqual(await hmacHex(secret, rawBody), signature);
}

export async function createRazorpayOrder(env: Env, amount: number, receipt: string, notes: Record<string, string>): Promise<{ id: string }> {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) throw new AppError(503, "BILLING_NOT_CONFIGURED", "Online payment is not set up yet. Contact support to pay by bank transfer.");
  const res = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Basic ${btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`)}` },
    body: JSON.stringify({ amount, currency: "INR", receipt, notes }),
  });
  if (!res.ok) throw new AppError(502, "PAYMENT_PROVIDER", `Razorpay refused the order (${res.status})`);
  return (await res.json()) as { id: string };
}

/**
 * Mark a billing payment as paid (idempotent) and extend the subscription: a renewal of the same plan starts where
 * the current paid period ends; a new or different plan starts now.
 */
export async function markPaid(env: Env, paymentRowId: string, providerPaymentId: string | null) {
  const p = await first<{ id: string; org_id: string; plan: PlanId; billing_interval: Interval; status: string }>(env.DB, `SELECT id, org_id, plan, billing_interval, status FROM billing_payments WHERE id = ?`, paymentRowId);
  if (!p) throw new AppError(404, "NOT_FOUND", "Payment not found");
  if (p.status === "paid") return { already: true };
  const sub = await first<{ plan: PlanId; paid_until: string | null }>(env.DB, `SELECT plan, paid_until FROM org_subscriptions WHERE org_id = ?`, p.org_id);
  const now = new Date();
  const start = sub?.plan === p.plan && sub.paid_until && Date.parse(sub.paid_until) > now.getTime() ? new Date(sub.paid_until) : now;
  const end = new Date(start);
  if (p.billing_interval === "yearly") end.setUTCFullYear(end.getUTCFullYear() + 1); else end.setUTCMonth(end.getUTCMonth() + 1);
  // One transaction, each step guarded by changes() of the previous one: only the call that flips the payment to
  // paid takes an invoice number and extends the subscription (the webhook and the browser may both report it).
  const done = await env.DB.batch([
    stmt(env.DB, `INSERT OR IGNORE INTO billing_counters (name, next_value) VALUES ('invoice', 1)`),
    stmt(env.DB, `UPDATE billing_payments SET status = 'paid', provider_payment_id = COALESCE(?, provider_payment_id), paid_at = ?, period_start = ?, period_end = ?
       WHERE id = ? AND status <> 'paid'`, providerPaymentId, now.toISOString(), start.toISOString(), end.toISOString(), p.id),
    stmt(env.DB, `UPDATE billing_counters SET next_value = next_value + 1 WHERE name = 'invoice' AND changes() > 0`),
    stmt(env.DB, `UPDATE billing_payments SET invoice_number = 'LF-' || ? || '-' || printf('%05d', (SELECT next_value - 1 FROM billing_counters WHERE name = 'invoice'))
       WHERE id = ? AND invoice_number IS NULL AND changes() > 0`, String(now.getUTCFullYear()), p.id),
    stmt(env.DB, `INSERT INTO org_subscriptions (org_id, plan, billing_interval, paid_until, updated_at) SELECT ?, ?, ?, ?, ? WHERE changes() > 0
       ON CONFLICT (org_id) DO UPDATE SET plan = excluded.plan, billing_interval = excluded.billing_interval, paid_until = excluded.paid_until, updated_at = excluded.updated_at`,
      p.org_id, p.plan, p.billing_interval, end.toISOString(), now.toISOString()),
  ]);
  const inv = await first<{ invoice_number: string }>(env.DB, `SELECT invoice_number FROM billing_payments WHERE id = ?`, p.id);
  const invoice = inv?.invoice_number ?? null;
  const already = !done[1].meta.changes;
  if (!already) await sendReceipt(env, p.id);
  return { already, period_end: end.toISOString(), invoice_number: invoice };
}

// ── Auto-renewal (Razorpay Subscriptions: UPI AutoPay, cards, e-mandate) ──

async function razorpay<T>(env: Env, method: "GET" | "POST", path: string, payload?: unknown): Promise<T> {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) throw new AppError(503, "BILLING_NOT_CONFIGURED", "Online payment is not set up yet. Contact support to pay by bank transfer.");
  const res = await fetch(`https://api.razorpay.com/v1${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Basic ${btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`)}` },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  if (!res.ok) throw new AppError(502, "PAYMENT_PROVIDER", `Razorpay refused the request (${res.status})`);
  return (await res.json()) as T;
}

/** The Razorpay plan for this plan, interval and price; created the first time it is needed and remembered. */
export async function razorpayPlanId(env: Env, plan: PlanId, interval: Interval, total: number) {
  const key = `${plan}:${interval}:${total}`;
  const known = await first<{ razorpay_plan_id: string }>(env.DB, `SELECT razorpay_plan_id FROM billing_rzp_plans WHERE plan_key = ?`, key);
  if (known) return known.razorpay_plan_id;
  const created = await razorpay<{ id: string }>(env, "POST", "/plans", {
    period: interval, interval: 1,
    item: { name: `LedgerFox ${PLANS[plan].name} (${interval})`, amount: total, currency: "INR", description: "Including GST" },
    notes: { plan, interval },
  });
  await run(env.DB, `INSERT INTO billing_rzp_plans (plan_key, razorpay_plan_id) VALUES (?, ?) ON CONFLICT (plan_key) DO NOTHING`, key, created.id);
  return (await first<{ razorpay_plan_id: string }>(env.DB, `SELECT razorpay_plan_id FROM billing_rzp_plans WHERE plan_key = ?`, key))!.razorpay_plan_id;
}

/** Ten years of renewals at most; the customer can cancel any time. */
const RENEWALS: Record<Interval, number> = { monthly: 120, yearly: 10 };

export async function createRazorpaySubscription(env: Env, planId: string, interval: Interval, startAt: number | null, notes: Record<string, string>) {
  return razorpay<{ id: string; status: string }>(env, "POST", "/subscriptions", {
    plan_id: planId, total_count: RENEWALS[interval], customer_notify: 1, notes, ...(startAt ? { start_at: startAt } : {}),
  });
}

export async function cancelRazorpaySubscription(env: Env, subscriptionId: string) {
  return razorpay<{ id: string; status: string }>(env, "POST", `/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, { cancel_at_cycle_end: 0 });
}

export async function fetchRazorpayPayment(env: Env, paymentId: string) {
  return razorpay<{ id: string; amount: number; status: string; order_id?: string | null; invoice_id?: string | null }>(env, "GET", `/payments/${encodeURIComponent(paymentId)}`);
}

/** Checkout success for a subscription: signature = HMAC-SHA256(payment_id|subscription_id, key secret). */
export async function verifySubscriptionSignature(secret: string, paymentId: string, subscriptionId: string, signature: string) {
  return safeEqual(await hmacHex(secret, `${paymentId}|${subscriptionId}`), signature);
}

/**
 * Record one auto-renewal charge (from the webhook or the checkout page) and extend the paid period. Idempotent: the
 * Razorpay payment id is unique, so a repeated event finds the same row and markPaid does nothing the second time.
 */
export async function recordAutopayCharge(env: Env, subscriptionId: string, paymentId: string, amount: number) {
  const s = await first<{ org_id: string; autopay_plan: PlanId; autopay_interval: Interval; autopay_total: number }>(env.DB,
    `SELECT org_id, autopay_plan, autopay_interval, autopay_total FROM org_subscriptions WHERE autopay_id = ?`, subscriptionId);
  if (!s || amount !== s.autopay_total) return { recorded: false };
  // Split the charged total into price and GST; a later price change does not affect subscriptions already running.
  const now = withGstFor(env, s.autopay_plan, s.autopay_interval);
  const base = now.total === amount ? now.amount : Math.round(amount / (1 + gstPercentOf(env) / 100));
  const price = { amount: base, gst: amount - base, total: amount };
  await run(env.DB, `INSERT INTO billing_payments (id, org_id, plan, billing_interval, amount, gst, total, provider, provider_payment_id, provider_subscription_id)
     VALUES (?,?,?,?,?,?,?,'razorpay',?,?) ON CONFLICT (provider_payment_id) DO NOTHING`,
    newId(), s.org_id, s.autopay_plan, s.autopay_interval, price.amount, price.gst, price.total, paymentId, subscriptionId);
  const row = await first<{ id: string }>(env.DB, `SELECT id FROM billing_payments WHERE provider_payment_id = ? AND org_id = ?`, paymentId, s.org_id);
  if (!row) return { recorded: false };
  return { recorded: true, ...(await markPaid(env, row.id, paymentId)) };
}

export const gstPercentOf = (env: Env) => Number(env.BILLING_GST_PERCENT ?? "18") || 0;
export const withGstFor = (env: Env, plan: PlanId, interval: Interval) => withGst(PLANS[plan].price[interval], gstPercentOf(env));
