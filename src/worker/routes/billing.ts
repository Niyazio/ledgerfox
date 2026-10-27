import { Hono } from "hono";
import { z } from "zod";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { all, batch, first, stmt } from "../lib/db";
import { AppError, badRequest, forbidden, notFound } from "../lib/errors";
import { body } from "../lib/validate";
import { newId } from "../lib/crypto";
import { audit, orgPermissions, requireAuth } from "../lib/auth";
import { PAID_PLANS, PLANS, TRIAL_DAYS, withGst, type Interval, type PlanId } from "@shared/plans";
import type { Role } from "@shared/permissions";
import { billingOn, createRazorpayOrder, markPaid, subscription, usage, verifyCheckoutSignature, verifyWebhookSignature } from "../services/billing";

/** Subscriptions for the hosted edition: plan status, checkout through Razorpay, and the vendor's subscriber admin. */
const billing = new Hono<AppEnv>();

const gstPercent = (c: Context<AppEnv>) => Number(c.env.BILLING_GST_PERCENT ?? "18") || 0;

billing.get("/plans", (c) => c.json({ enabled: billingOn(c.env), plans: Object.values(PLANS), gst_percent: gstPercent(c), trial_days: TRIAL_DAYS }));

/** Razorpay webhook (payment.captured / order.paid). Activates the plan even if the buyer closed the browser. */
billing.post("/webhook", async (c) => {
  const raw = await c.req.text();
  const sig = c.req.header("x-razorpay-signature") ?? "";
  if (!c.env.RAZORPAY_WEBHOOK_SECRET || !(await verifyWebhookSignature(c.env.RAZORPAY_WEBHOOK_SECRET, raw, sig))) throw forbidden("Bad signature");
  const evt = JSON.parse(raw) as { event: string; payload?: { payment?: { entity?: { id: string; order_id: string; status: string; amount: number } } } };
  const pay = evt.payload?.payment?.entity;
  if ((evt.event === "payment.captured" || evt.event === "order.paid") && pay?.order_id) {
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
  return c.json({ enabled: billingOn(c.env), subscription: sub, usage: used, plans: Object.values(PLANS), gst_percent: gstPercent(c), can_buy: m.role === "owner", payments, online: Boolean(c.env.RAZORPAY_KEY_ID) });
});

const choice = z.object({ plan: z.enum(PAID_PLANS as [PlanId, ...PlanId[]]), interval: z.enum(["monthly", "yearly"]) });

org.post("/:orgId/checkout", async (c) => {
  const orgId = c.req.param("orgId");
  if ((await member(c, orgId)).role !== "owner") throw forbidden("Only the owner can buy a plan");
  if (!billingOn(c.env)) throw badRequest("Subscriptions are not switched on");
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

/** Tax invoice data for one paid subscription payment (printed by the browser). */
org.get("/:orgId/invoice/:paymentId", async (c) => {
  const orgId = c.req.param("orgId");
  if ((await member(c, orgId)).role !== "owner") throw forbidden();
  const p = await first(c.env.DB, `SELECT * FROM billing_payments WHERE id = ? AND org_id = ? AND status = 'paid'`, c.req.param("paymentId"), orgId);
  if (!p) throw notFound("Invoice");
  const buyer = await first(c.env.DB, `SELECT o.name AS org_name, co.legal_name, co.name, co.tax_id, co.address, co.city, co.state_code FROM organisations o LEFT JOIN companies co ON co.org_id = o.id AND co.is_demo = 0 WHERE o.id = ? ORDER BY co.created_at LIMIT 1`, orgId);
  return c.json({ payment: p, buyer, seller: { name: c.env.VENDOR_LEGAL_NAME ?? "Niyazio", gstin: c.env.VENDOR_GSTIN ?? null, address: c.env.VENDOR_ADDRESS ?? null, state_code: c.env.VENDOR_STATE_CODE ?? null, email: "info@niyazio.com" }, sac: "998431" });
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

billing.route("/vendor", vendor);
export default billing;
