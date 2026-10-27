import { Hono } from "hono";
import { z } from "zod";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { all, batch, first, run, stmt } from "../lib/db";
import { AppError, badRequest, forbidden, notFound } from "../lib/errors";
import { body } from "../lib/validate";
import { newId } from "../lib/crypto";
import { audit, orgPermissions, rateLimit, requireAuth } from "../lib/auth";
import { PAID_PLANS, PLANS, TRIAL_DAYS, withGst, type Interval, type PlanId } from "@shared/plans";
import type { Role } from "@shared/permissions";
import { billingOn, cancelRazorpaySubscription, createRazorpayOrder, createRazorpaySubscription, fetchRazorpayPayment, markPaid, razorpayPlanId, recordAutopayCharge, subscription, usage, verifyCheckoutSignature, verifySubscriptionSignature, verifyWebhookSignature } from "../services/billing";

/** Subscriptions for the hosted edition: plan status, checkout through Razorpay, and the vendor's subscriber admin. */
const billing = new Hono<AppEnv>();

const gstPercent = (c: Context<AppEnv>) => Number(c.env.BILLING_GST_PERCENT ?? "18") || 0;

billing.get("/plans", (c) => c.json({ enabled: billingOn(c.env), plans: Object.values(PLANS), gst_percent: gstPercent(c), trial_days: TRIAL_DAYS }));

/**
 * Razorpay webhook. One-off payments: payment.captured / order.paid. Auto-renewal: subscription.charged extends the
 * plan; subscription.activated / pending / halted / cancelled / completed / paused / resumed keep the status current.
 * Works even if the buyer closed the browser. Every event is checked against its HMAC signature first.
 */
billing.post("/webhook", async (c) => {
  const raw = await c.req.text();
  const sig = c.req.header("x-razorpay-signature") ?? "";
  if (!c.env.RAZORPAY_WEBHOOK_SECRET || !(await verifyWebhookSignature(c.env.RAZORPAY_WEBHOOK_SECRET, raw, sig))) throw forbidden("Bad signature");
  const evt = JSON.parse(raw) as {
    event: string;
    payload?: { payment?: { entity?: { id: string; order_id?: string | null; status: string; amount: number } }; subscription?: { entity?: { id: string; status: string } } };
  };
  const pay = evt.payload?.payment?.entity;
  const sub = evt.payload?.subscription?.entity;
  if (evt.event.startsWith("subscription.") && sub?.id) {
    if (evt.event === "subscription.charged" && pay?.id && pay.status === "captured") await recordAutopayCharge(c.env, sub.id, pay.id, pay.amount);
    const status = { "subscription.activated": "active", "subscription.charged": "active", "subscription.resumed": "active", "subscription.pending": "pending",
      "subscription.halted": "halted", "subscription.cancelled": "cancelled", "subscription.completed": "completed", "subscription.paused": "paused" }[evt.event];
    if (status) await run(c.env.DB, `UPDATE org_subscriptions SET autopay_status = ?, updated_at = ? WHERE autopay_id = ?`, status, new Date().toISOString(), sub.id);
  } else if ((evt.event === "payment.captured" || evt.event === "order.paid") && pay?.order_id) {
    const row = await first<{ id: string; total: number }>(c.env.DB, `SELECT id, total FROM billing_payments WHERE provider_order_id = ?`, pay.order_id);
    if (row && pay.amount === row.total) await markPaid(c.env, row.id, pay.id);
  }
  return c.json({ ok: true });
});

// ── For the signed-in organisation owner ──
const org = new Hono<AppEnv>();
org.use("*", requireAuth);

async function member(c: Context<AppEnv>, orgId: string) {
  const m = await first<{ role: Role }>(c.env.DB, `SELECT role FROM memberships WHERE org_id = ? AND user_id = ?`, orgId, c.get("user").id);
  if (!m) throw notFound("Organisation");
  return { role: m.role, perms: await orgPermissions(c.env.DB, orgId, m.role) };
}

org.get("/:orgId", async (c) => {
  const orgId = c.req.param("orgId");
  const m = await member(c, orgId);
  const [sub, used] = await Promise.all([subscription(c.env, orgId), usage(c.env, orgId)]);
  const payments = m.role === "owner"
    ? await all(c.env.DB, `SELECT id, plan, billing_interval, amount, gst, total, provider, status, invoice_number, period_start, period_end, created_at, paid_at FROM billing_payments WHERE org_id = ? AND status = 'paid' ORDER BY created_at DESC LIMIT 50`, orgId)
    : [];
  const autopay = await first(c.env.DB, `SELECT autopay_status AS status, autopay_plan AS plan, autopay_interval AS "interval", autopay_total AS total FROM org_subscriptions WHERE org_id = ? AND autopay_id IS NOT NULL AND autopay_status <> 'created'`, orgId);
  return c.json({ enabled: billingOn(c.env), subscription: sub, usage: used, plans: Object.values(PLANS), gst_percent: gstPercent(c), can_buy: m.role === "owner", payments, online: Boolean(c.env.RAZORPAY_KEY_ID), autopay });
});

/** Each checkout asks Razorpay to create an order or subscription; keep that to a sensible number per organisation. */
async function paymentRate(c: Context<AppEnv>, orgId: string) {
  if (!(await rateLimit(c.env.DB, `billing:${orgId}`, 20, 3600))) throw new AppError(429, "RATE_LIMITED", "Too many payment attempts. Try again in an hour.");
}

const choice = z.object({ plan: z.enum(PAID_PLANS as [PlanId, ...PlanId[]]), interval: z.enum(["monthly", "yearly"]) });

org.post("/:orgId/checkout", async (c) => {
  const orgId = c.req.param("orgId");
  if ((await member(c, orgId)).role !== "owner") throw forbidden("Only the owner can buy a plan");
  if (!billingOn(c.env)) throw badRequest("Subscriptions are not switched on");
  await paymentRate(c, orgId);
  const input = await body(c, choice);
  const price = withGst(PLANS[input.plan].price[input.interval as Interval], gstPercent(c));
  const id = newId();
  const order = await createRazorpayOrder(c.env, price.total, id.slice(0, 40), { org_id: orgId, plan: input.plan, interval: input.interval });
  await batch(c.env.DB, [
    stmt(c.env.DB, `INSERT INTO billing_payments (id, org_id, plan, billing_interval, amount, gst, total, provider, provider_order_id, created_by) VALUES (?,?,?,?,?,?,?,'razorpay',?,?)`,
      id, orgId, input.plan, input.interval, price.amount, price.gst, price.total, order.id, c.get("user").id),
    audit(c, "billing.checkout", "billing_payment", id, { plan: input.plan, interval: input.interval, total: price.total }, { orgId, companyId: null }),
  ]);
  const user = c.get("user");
  return c.json({ payment_id: id, order_id: order.id, key_id: c.env.RAZORPAY_KEY_ID, amount: price.total, currency: "INR", name: PLANS[input.plan].name, prefill: { name: user.name, email: user.email.endsWith(".ledgerfox.local") ? "" : user.email } });
});

org.post("/:orgId/verify", async (c) => {
  const orgId = c.req.param("orgId");
  await member(c, orgId);
  const input = await body(c, z.object({ razorpay_order_id: z.string().min(1).max(64), razorpay_payment_id: z.string().min(1).max(64), razorpay_signature: z.string().min(1).max(200) }));
  const row = await first<{ id: string }>(c.env.DB, `SELECT id FROM billing_payments WHERE provider_order_id = ? AND org_id = ?`, input.razorpay_order_id, orgId);
  if (!row) throw notFound("Order");
  if (!c.env.RAZORPAY_KEY_SECRET || !(await verifyCheckoutSignature(c.env.RAZORPAY_KEY_SECRET, input.razorpay_order_id, input.razorpay_payment_id, input.razorpay_signature))) {
    throw new AppError(400, "BAD_SIGNATURE", "The payment could not be verified. If money was taken, it will be activated automatically or refunded by Razorpay.");
  }
  const r = await markPaid(c.env, row.id, input.razorpay_payment_id);
  return c.json({ ok: true, ...r, subscription: await subscription(c.env, orgId) });
});

const LIVE_AUTOPAY = ["active", "pending", "halted", "paused"];

/**
 * Start auto-renewal. The first charge is taken now, or when the current paid period or trial ends, so nobody pays
 * twice for the same days. The buyer approves the mandate (UPI AutoPay, card or e-mandate) in Razorpay's window.
 */
org.post("/:orgId/autopay", async (c) => {
  const orgId = c.req.param("orgId");
  if ((await member(c, orgId)).role !== "owner") throw forbidden("Only the owner can buy a plan");
  if (!billingOn(c.env)) throw badRequest("Subscriptions are not switched on");
  await paymentRate(c, orgId);
  const input = await body(c, choice);
  const current = await subscription(c.env, orgId);
  const row = await first<{ autopay_id: string | null; autopay_status: string | null; paid_until: string | null; trial_ends_at: string | null }>(c.env.DB,
    `SELECT autopay_id, autopay_status, paid_until, trial_ends_at FROM org_subscriptions WHERE org_id = ?`, orgId);
  if (row?.autopay_id && LIVE_AUTOPAY.includes(row.autopay_status ?? "")) throw new AppError(409, "AUTOPAY_ON", "Auto-renew is already on. Turn it off first to change the plan.");
  const price = withGst(PLANS[input.plan].price[input.interval as Interval], gstPercent(c));
  const planId = await razorpayPlanId(c.env, input.plan, input.interval, price.total);
  const ends = Math.max(current.status === "active" || current.status === "grace" ? Date.parse(row?.paid_until ?? "") || 0 : 0, current.status === "trial" ? Date.parse(row?.trial_ends_at ?? "") || 0 : 0);
  const startAt = ends > Date.now() + 15 * 60_000 ? Math.floor(ends / 1000) : null;
  const created = await createRazorpaySubscription(c.env, planId, input.interval, startAt, { org_id: orgId, plan: input.plan, interval: input.interval });
  // An abandoned earlier attempt is simply replaced; it was never approved, so it cannot charge.
  await batch(c.env.DB, [
    stmt(c.env.DB, `INSERT INTO org_subscriptions (org_id, autopay_id, autopay_status, autopay_plan, autopay_interval, autopay_total) VALUES (?, ?, 'created', ?, ?, ?)
       ON CONFLICT (org_id) DO UPDATE SET autopay_id = excluded.autopay_id, autopay_status = 'created', autopay_plan = excluded.autopay_plan, autopay_interval = excluded.autopay_interval, autopay_total = excluded.autopay_total`,
      orgId, created.id, input.plan, input.interval, price.total),
    audit(c, "billing.autopay_start", "organisation", orgId, { plan: input.plan, interval: input.interval, total: price.total, starts: startAt ? new Date(startAt * 1000).toISOString() : "now" }, { orgId, companyId: null }),
  ]);
  const user = c.get("user");
  return c.json({ subscription_id: created.id, key_id: c.env.RAZORPAY_KEY_ID, amount: price.total, name: PLANS[input.plan].name, starts_at: startAt ? new Date(startAt * 1000).toISOString() : null,
    prefill: { name: user.name, email: user.email.endsWith(".ledgerfox.local") ? "" : user.email } });
});

/** The buyer approved the mandate in Razorpay's window. */
org.post("/:orgId/autopay/verify", async (c) => {
  const orgId = c.req.param("orgId");
  await member(c, orgId);
  const input = await body(c, z.object({ razorpay_subscription_id: z.string().min(1).max(64), razorpay_payment_id: z.string().min(1).max(64), razorpay_signature: z.string().min(1).max(200) }));
  const row = await first<{ autopay_status: string }>(c.env.DB, `SELECT autopay_status FROM org_subscriptions WHERE org_id = ? AND autopay_id = ?`, orgId, input.razorpay_subscription_id);
  if (!row) throw notFound("Subscription");
  if (!c.env.RAZORPAY_KEY_SECRET || !(await verifySubscriptionSignature(c.env.RAZORPAY_KEY_SECRET, input.razorpay_payment_id, input.razorpay_subscription_id, input.razorpay_signature))) {
    throw new AppError(400, "BAD_SIGNATURE", "The payment could not be verified. If money was taken, it will be activated automatically or refunded by Razorpay.");
  }
  await run(c.env.DB, `UPDATE org_subscriptions SET autopay_status = 'active', updated_at = ? WHERE org_id = ? AND autopay_id = ? AND autopay_status = 'created'`, new Date().toISOString(), orgId, input.razorpay_subscription_id);
  // When the first charge was taken now (not a small mandate check), ask Razorpay for it and record it straight away;
  // otherwise the subscription.charged webhook records each charge.
  const p = await fetchRazorpayPayment(c.env, input.razorpay_payment_id).catch(() => null);
  if (p?.status === "captured") await recordAutopayCharge(c.env, input.razorpay_subscription_id, p.id, p.amount);
  return c.json({ ok: true, subscription: await subscription(c.env, orgId) });
});

/** Stop future charges. The days already paid for are kept. */
org.post("/:orgId/autopay/cancel", async (c) => {
  const orgId = c.req.param("orgId");
  if ((await member(c, orgId)).role !== "owner") throw forbidden("Only the owner can change the plan");
  const row = await first<{ autopay_id: string | null; autopay_status: string | null }>(c.env.DB, `SELECT autopay_id, autopay_status FROM org_subscriptions WHERE org_id = ?`, orgId);
  if (!row?.autopay_id || !LIVE_AUTOPAY.includes(row.autopay_status ?? "")) throw badRequest("Auto-renew is not on");
  await cancelRazorpaySubscription(c.env, row.autopay_id);
  await batch(c.env.DB, [
    stmt(c.env.DB, `UPDATE org_subscriptions SET autopay_status = 'cancelled', updated_at = ? WHERE org_id = ?`, new Date().toISOString(), orgId),
    audit(c, "billing.autopay_cancel", "organisation", orgId, { autopay_id: row.autopay_id }, { orgId, companyId: null }),
  ]);
  return c.json({ ok: true });
});

/** Tax invoice data for one paid subscription payment (printed by the browser). */
org.get("/:orgId/invoice/:paymentId", async (c) => {
  const orgId = c.req.param("orgId");
  if ((await member(c, orgId)).role !== "owner") throw forbidden();
  const p = await first(c.env.DB, `SELECT * FROM billing_payments WHERE id = ? AND org_id = ? AND status = 'paid'`, c.req.param("paymentId"), orgId);
  if (!p) throw notFound("Invoice");
  const buyer = await first(c.env.DB, `SELECT o.name AS org_name, co.legal_name, co.name, co.tax_id, co.address, co.city, co.state_code FROM organisations o LEFT JOIN companies co ON co.org_id = o.id AND co.is_demo = 0 WHERE o.id = ? ORDER BY co.created_at LIMIT 1`, orgId);
  return c.json({ payment: p, buyer, seller: { name: c.env.VENDOR_LEGAL_NAME ?? "Niyazio", gstin: c.env.VENDOR_GSTIN ?? null, address: c.env.VENDOR_ADDRESS ?? null, state_code: c.env.VENDOR_STATE_CODE ?? null, email: "info@niyazio.com" }, sac: "998431" });
});

// ── Promotions for the Free plan: first-party text cards, no ad scripts inside the app ──

interface Promo { id: string; title: string; body: string; cta: string; link_url: string | null; to: string | null; sponsor: string | null }
const HOUSE: Promo[] = [
  { id: "house-plans", title: "Remove these messages", body: "Paid plans show no promotions and add GST returns, POS billing, payroll and more users.", cta: "See plans", link_url: null, to: "settings?tab=billing", sponsor: null },
  { id: "house-desktop", title: "Work without internet", body: "The free LedgerFox desktop app keeps your books on your own computer and shares them over the office network.", cta: "Download", link_url: "/download", to: null, sponsor: null },
];

/** One card for an organisation on the Free plan; nothing for trial, paid or unlimited (desktop) organisations. */
org.get("/:orgId/promo", async (c) => {
  const orgId = c.req.param("orgId");
  await member(c, orgId);
  const sub = await subscription(c.env, orgId);
  if (!sub.enforced || sub.status !== "free") return c.json({ promo: null });
  const today = new Date().toISOString().slice(0, 10);
  const rows = await all<Promo & { weight: number }>(c.env.DB,
    `SELECT id, title, body, cta, link_url, NULL AS "to", sponsor, weight FROM promotions
     WHERE is_active = 1 AND (starts_on IS NULL OR starts_on <= ?) AND (ends_on IS NULL OR ends_on >= ?)`, today, today);
  const pool: (Promo & { weight: number })[] = [...rows, ...HOUSE.map((h) => ({ ...h, weight: 1 }))];
  let pick = Math.random() * pool.reduce((t, p) => t + Math.max(1, p.weight), 0);
  const chosen = pool.find((p) => (pick -= Math.max(1, p.weight)) < 0) ?? pool[0];
  if (!chosen.id.startsWith("house-")) await run(c.env.DB, `UPDATE promotions SET views = views + 1 WHERE id = ?`, chosen.id);
  const { weight: _w, ...promo } = chosen;
  return c.json({ promo });
});

org.post("/:orgId/promo/:promoId/click", async (c) => {
  const orgId = c.req.param("orgId");
  await member(c, orgId);
  await run(c.env.DB, `UPDATE promotions SET clicks = clicks + 1 WHERE id = ?`, c.req.param("promoId"));
  return c.json({ ok: true });
});

billing.route("/org", org);

// ── Vendor admin: the people who sell LedgerFox (emails listed in VENDOR_ADMIN_EMAILS) ──
const vendor = new Hono<AppEnv>();
vendor.use("*", requireAuth, async (c, next) => {
  const allowed = (c.env.VENDOR_ADMIN_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (!allowed.includes(c.get("user").email.toLowerCase())) throw notFound("Page");
  await next();
});

vendor.get("/subscribers", async (c) => {
  const rows = await all<{ org_id: string; org_name: string; owner_email: string; owner_name: string; created_at: string; users: number; companies: number }>(c.env.DB,
    `SELECT o.id AS org_id, o.name AS org_name, u.email AS owner_email, u.name AS owner_name, o.created_at,
       (SELECT COUNT(*) FROM memberships m WHERE m.org_id = o.id) AS users, (SELECT COUNT(*) FROM companies co WHERE co.org_id = o.id AND co.is_demo = 0) AS companies
     FROM organisations o JOIN users u ON u.id = o.owner_user_id ORDER BY o.created_at DESC LIMIT 1000`);
  const subs = await Promise.all(rows.map(async (r) => ({ ...r, subscription: await subscription(c.env, r.org_id) })));
  const revenue = await first<{ total: number; month: number }>(c.env.DB,
    `SELECT COALESCE(SUM(amount),0) AS total, COALESCE(SUM(CASE WHEN paid_at >= ? THEN amount END),0) AS month FROM billing_payments WHERE status = 'paid'`, new Date(Date.now() - 30 * 86_400_000).toISOString());
  const counts = subs.reduce((m, s) => ({ ...m, [s.subscription.status]: (m[s.subscription.status] ?? 0) + 1 }), {} as Record<string, number>);
  return c.json({ enabled: billingOn(c.env), subscribers: subs, revenue, counts });
});

/** Record a payment received outside Razorpay (bank transfer, cash) and activate the plan. */
vendor.post("/orgs/:orgId/activate", async (c) => {
  const orgId = c.req.param("orgId");
  const input = await body(c, choice.extend({ amount_received: z.union([z.string(), z.number()]).nullish(), note: z.string().max(300).nullish() }));
  if (!(await first(c.env.DB, `SELECT 1 FROM organisations WHERE id = ?`, orgId))) throw notFound("Organisation");
  const price = withGst(PLANS[input.plan].price[input.interval], gstPercent(c));
  const id = newId();
  await batch(c.env.DB, [
    stmt(c.env.DB, `INSERT INTO billing_payments (id, org_id, plan, billing_interval, amount, gst, total, provider, created_by) VALUES (?,?,?,?,?,?,?,'manual',?)`,
      id, orgId, input.plan, input.interval, price.amount, price.gst, price.total, c.get("user").id),
    stmt(c.env.DB, `INSERT INTO org_subscriptions (org_id, note) VALUES (?, ?) ON CONFLICT (org_id) DO UPDATE SET note = excluded.note`, orgId, input.note ?? "Manual payment"),
    audit(c, "billing.manual_activate", "billing_payment", id, input, { orgId, companyId: null }),
  ]);
  return c.json(await markPaid(c.env, id, null));
});

vendor.post("/orgs/:orgId/trial", async (c) => {
  const orgId = c.req.param("orgId");
  const input = await body(c, z.object({ days: z.number().int().min(1).max(90) }));
  await subscription(c.env, orgId); // make sure a row exists
  const until = new Date(Date.now() + input.days * 86_400_000).toISOString();
  await batch(c.env.DB, [
    stmt(c.env.DB, `UPDATE org_subscriptions SET trial_ends_at = ?, updated_at = ? WHERE org_id = ?`, until, new Date().toISOString(), orgId),
    audit(c, "billing.trial_extend", "organisation", orgId, input, { orgId, companyId: null }),
  ]);
  return c.json({ ok: true, trial_ends_at: until });
});

const httpsUrl = z.string().trim().max(500).refine((v) => { try { const u = new URL(v); return u.protocol === "https:" && !u.username && !u.password; } catch { return false; } }, "Use a full https:// link");
const promoInput = z.object({
  title: z.string().trim().min(1).max(60), body: z.string().trim().min(1).max(160), cta: z.string().trim().min(1).max(20).default("Learn more"),
  link_url: httpsUrl, sponsor: z.string().trim().max(60).nullish(), is_active: z.boolean().default(true),
  starts_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(), ends_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(), weight: z.number().int().min(1).max(10).default(1),
});

vendor.get("/promotions", async (c) => c.json({ promotions: await all(c.env.DB, `SELECT * FROM promotions ORDER BY created_at DESC`) }));

vendor.post("/promotions", async (c) => {
  const input = await body(c, promoInput);
  const id = newId();
  await batch(c.env.DB, [
    stmt(c.env.DB, `INSERT INTO promotions (id, title, body, cta, link_url, sponsor, is_active, starts_on, ends_on, weight, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      id, input.title, input.body, input.cta, input.link_url, input.sponsor || null, input.is_active ? 1 : 0, input.starts_on ?? null, input.ends_on ?? null, input.weight, c.get("user").id),
  ]);
  return c.json({ id }, 201);
});

vendor.put("/promotions/:id", async (c) => {
  const input = await body(c, promoInput);
  const r = await run(c.env.DB, `UPDATE promotions SET title = ?, body = ?, cta = ?, link_url = ?, sponsor = ?, is_active = ?, starts_on = ?, ends_on = ?, weight = ? WHERE id = ?`,
    input.title, input.body, input.cta, input.link_url, input.sponsor || null, input.is_active ? 1 : 0, input.starts_on ?? null, input.ends_on ?? null, input.weight, c.req.param("id"));
  if (!r.meta.changes) throw notFound("Promotion");
  return c.json({ ok: true });
});

vendor.delete("/promotions/:id", async (c) => {
  await run(c.env.DB, `DELETE FROM promotions WHERE id = ?`, c.req.param("id"));
  return c.json({ ok: true });
});

billing.route("/vendor", vendor);
export default billing;
