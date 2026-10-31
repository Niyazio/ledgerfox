import type { Env } from "../env";
import { all, first, run } from "../lib/db";
import { PLANS, type PlanId } from "@shared/plans";
import { billingOn } from "./billing";
import { emailOn, sendMail, siteUrl } from "./email";

/**
 * Billing emails to the organisation's owner: receipts, failed auto-renewal charges, and the daily reminders (trial
 * ending, plan ending, plan ended). Each notice is recorded in billing_notices and sent at most once.
 */

/** An amount in minor units with its currency, e.g. ₹943.00 or USD 12.00. */
const amountIn = (minor: number, currency = "INR") =>
  `${currency === "INR" ? "₹" : `${currency} `}${(minor / 100).toLocaleString(currency === "INR" ? "en-IN" : "en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });

async function owner(env: Env, orgId: string) {
  return first<{ email: string; name: string; org_name: string }>(env.DB,
    `SELECT u.email, u.name, o.name AS org_name FROM organisations o JOIN users u ON u.id = o.owner_user_id WHERE o.id = ?`, orgId);
}

/** Send once per (organisation, key). Returns true when this call sent it. */
async function once(env: Env, orgId: string, key: string, compose: (o: { email: string; name: string; org_name: string }, url: string) => { subject: string; text: string }) {
  if (!emailOn(env)) return false;
  const claim = await run(env.DB, `INSERT INTO billing_notices (org_id, notice_key) VALUES (?, ?) ON CONFLICT DO NOTHING`, orgId, key);
  if (!claim.meta.changes) return false;
  const o = await owner(env, orgId);
  if (!o) return false;
  const sent = await sendMail(env, { to: o.email, ...compose(o, siteUrl(env)) });
  // Not sent (e.g. the provider was down): forget the claim so tomorrow's run tries again.
  if (!sent) await run(env.DB, `DELETE FROM billing_notices WHERE org_id = ? AND notice_key = ?`, orgId, key);
  return sent;
}

const plansLink = (url: string) => `${url}/app (Settings → Plan & billing)`;

export async function sendReceipt(env: Env, paymentRowId: string) {
  const p = await first<{ org_id: string; plan: PlanId; billing_interval: string; total: number; currency: string; invoice_number: string | null; period_start: string; period_end: string; provider: string; provider_payment_id: string | null; provider_subscription_id: string | null }>(env.DB,
    `SELECT org_id, plan, billing_interval, total, currency, invoice_number, period_start, period_end, provider, provider_payment_id, provider_subscription_id FROM billing_payments WHERE id = ? AND status = 'paid'`, paymentRowId);
  if (!p) return false;
  return once(env, p.org_id, `receipt:${paymentRowId}`, (o, url) => ({
    subject: `Payment received — LedgerFox ${PLANS[p.plan].name} plan (invoice ${p.invoice_number ?? ""})`,
    text: [`Hello ${o.name},`, "", `Thank you. We received ${amountIn(p.total, p.currency)} for ${o.org_name}.`, "",
      `Plan: ${PLANS[p.plan].name} (${p.billing_interval})`, `Period: ${day(p.period_start)} to ${day(p.period_end)}`, `Invoice number: ${p.invoice_number ?? "—"}`,
      ...(p.provider_payment_id ? [`Payment ID: ${p.provider_payment_id}`] : []), ...(p.provider_subscription_id ? [`Auto-renew subscription ID: ${p.provider_subscription_id}`] : []),
      `Account ID: ${p.org_id}`, "", `Your tax invoice: ${url}/billing/${p.org_id}/invoice/${paymentRowId}`, "",
      p.provider_subscription_id ? "Your plan renews automatically. You can turn this off any time in Settings → Plan & billing." : "", "LedgerFox"].join("\n"),
  }));
}

export async function sendAutopayProblem(env: Env, subscriptionId: string, status: "pending" | "halted") {
  const s = await first<{ org_id: string; autopay_plan: PlanId; paid_until: string | null }>(env.DB, `SELECT org_id, autopay_plan, paid_until FROM org_subscriptions WHERE autopay_id = ?`, subscriptionId);
  if (!s) return false;
  return once(env, s.org_id, `autopay-${status}:${subscriptionId}:${s.paid_until ?? ""}`, (o, url) => ({
    subject: status === "halted" ? "Action needed: your LedgerFox plan could not be renewed" : "Your LedgerFox renewal payment did not go through",
    text: [`Hello ${o.name},`, "",
      status === "halted"
        ? `We could not charge the renewal of the ${PLANS[s.autopay_plan].name} plan for ${o.org_name} after several tries, so auto-renew has stopped.`
        : `The renewal charge for the ${PLANS[s.autopay_plan].name} plan of ${o.org_name} failed. Razorpay will try again over the next few days.`,
      "", "Please check your card, UPI app or bank, or pay once from:", plansLink(url), "",
      ...(s.paid_until ? [`Your paid period ends on ${day(s.paid_until)}; after that there are 7 days of grace, then new entries pause until you renew. Your data is never deleted and stays viewable.`] : []),
      "", `Subscription ID: ${subscriptionId}`, "", "LedgerFox"].join("\n"),
  }));
}

const DAY = 86_400_000;

/** The daily job: trial and plan reminders. Returns how many emails were sent. */
export async function dailyBillingReminders(env: Env, now = Date.now()) {
  if (!billingOn(env) || !emailOn(env)) return 0;
  const rows = await all<{ org_id: string; plan: PlanId; trial_ends_at: string | null; paid_until: string | null; autopay_status: string | null }>(env.DB,
    `SELECT org_id, plan, trial_ends_at, paid_until, autopay_status FROM org_subscriptions`);
  let sent = 0;
  for (const r of rows) {
    const autopay = ["active", "pending"].includes(r.autopay_status ?? "");
    const paid = r.paid_until ? Date.parse(r.paid_until) : 0;
    const trial = r.trial_ends_at ? Date.parse(r.trial_ends_at) : 0;
    if (r.plan === "free" && trial > now && trial - now <= 3 * DAY && !autopay) {
      if (await once(env, r.org_id, `trial-end:${r.trial_ends_at!.slice(0, 10)}`, (o, url) => ({
        subject: "Your LedgerFox free trial ends soon",
        text: [`Hello ${o.name},`, "", `The free trial of ${o.org_name} ends on ${day(r.trial_ends_at!)}.`, "",
          "To keep working after that, choose a plan (auto-renew starts after the trial, so you are not charged early):", plansLink(url), "",
          "If you do nothing, new entries pause after the trial until you choose a plan. Your data stays safe and you can still view and export it.", "", "LedgerFox"].join("\n"),
      }))) sent++;
    } else if (r.plan !== "free" && paid > now && paid - now <= 5 * DAY && !autopay) {
      if (await once(env, r.org_id, `renew:${r.paid_until!.slice(0, 10)}`, (o, url) => ({
        subject: `Your LedgerFox ${PLANS[r.plan].name} plan ends on ${day(r.paid_until!)}`,
        text: [`Hello ${o.name},`, "", `The ${PLANS[r.plan].name} plan of ${o.org_name} is paid until ${day(r.paid_until!)}.`, "",
          "Renew now, or turn on auto-renew so you never have to think about it:", plansLink(url), "", "LedgerFox"].join("\n"),
      }))) sent++;
    } else if (r.plan !== "free" && paid && paid <= now && now - paid <= 7 * DAY) {
      if (await once(env, r.org_id, `grace:${r.paid_until!.slice(0, 10)}`, (o, url) => ({
        subject: "Your LedgerFox plan has ended — 7 days to renew",
        text: [`Hello ${o.name},`, "", `The ${PLANS[r.plan].name} plan of ${o.org_name} ended on ${day(r.paid_until!)}. Everything keeps working for 7 more days.`, "",
          "Renew here to keep working:", plansLink(url), "", "After that, new entries pause until you renew. Your data is never deleted.", "", "LedgerFox"].join("\n"),
      }))) sent++;
    }
  }
  return sent;
}
