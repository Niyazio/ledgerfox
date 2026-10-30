import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { CheckCircle2, Printer } from "lucide-react";
import { useCompany } from "../lib/company";
import { useApi } from "../lib/hooks";
import { api, errorMessage } from "../lib/api";
import { Alert, Badge, Button, Card, Field, Input, Spinner, TableWrap, useToast } from "../components/ui";
import { Wordmark } from "../components/Layout";
import { FEATURE_LABELS, PAID_PLANS, withGst, type Interval, type Plan } from "@shared/plans";
import { fmtDate, money as fmt } from "../lib/format";
import { printPage } from "../lib/download";
import { useSession } from "../lib/session";
import { DesktopPlanTab } from "./DesktopPlan";

const inr = (paise: number) => fmt(paise, "INR");

interface BillingInfo {
  enabled: boolean; can_buy: boolean; online: boolean; gst_percent: number; plans: Plan[];
  subscription: { enforced: boolean; plan: string; paid_plan: string | null; status: string; interval: Interval | null; trial_ends_at: string | null; paid_until: string | null; days_left: number | null };
  usage: { users: number; companies: number; branches: number };
  payments: { id: string; plan: string; billing_interval: string; total: number; invoice_number: string; period_start: string; period_end: string; paid_at: string; provider: string; provider_payment_id: string | null; provider_subscription_id: string | null }[];
  autopay: { id: string; status: string; plan: string; interval: Interval; total: number } | null;
  account_id: string;
  autopay_required?: boolean;
  renew_required?: boolean;
  trial_days?: number;
  demo_only?: boolean;
  role?: string;
}

const AUTOPAY: Record<string, string> = { active: "On", pending: "Last charge failed — Razorpay is retrying", halted: "Stopped after failed charges", paused: "Paused", cancelled: "Off", completed: "Finished" };
const autopayLive = (a: BillingInfo["autopay"]) => !!a && ["active", "pending", "halted", "paused"].includes(a.status);

/**
 * Checkout opens with a full page load: only /billing/* pages are allowed (by the Content-Security-Policy header) to
 * load Razorpay's script, and the policy belongs to the page that was loaded, not to the in-app route.
 */
const goCheckout = (url: string) => { window.location.assign(url); };

/** Largest amount a UPI AutoPay mandate can charge without extra approval (paise). */
const UPI_AUTOPAY_LIMIT = 15_000_00;

const STATUS: Record<string, string> = { trial: "Free trial", active: "Active", grace: "Payment due", free: "Ended — renew to continue", unlimited: "Unlimited" };

/** Settings → Plan & billing. */
export function PlanBillingTab() {
  const { me } = useSession();
  return me?.edition === "desktop" ? <DesktopPlanTab /> : <CloudPlanTab />;
}

function CloudPlanTab() {
  const { settings } = useCompany();
  const orgId = settings!.company.org_id;
  const { data, error, reload } = useApi<BillingInfo>(`/api/billing/org/${orgId}`);
  const [interval, setInterval] = useState<Interval>("yearly");
  const [auto, setAuto] = useState(true);
  const [stopping, setStopping] = useState(false);
  const toast = useToast();
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Spinner />;
  if (!data.enabled) return <Card><p className="text-sm">All features are available. Subscriptions are not switched on for this LedgerFox.</p></Card>;
  if (data.demo_only) return <Card><p className="text-sm">This is a demo company, so there is nothing to subscribe for here. Open your own company (company switcher at the top) and choose a plan in its Settings → Plan & billing.</p></Card>;
  const s = data.subscription;
  const current = data.plans.find((p) => p.id === s.plan)!;
  return (
    <div className="space-y-4">
      <Card title="Your plan">
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-xl font-semibold">{s.status === "free" ? "No active plan" : current.name}</p><Badge color={s.status === "active" ? "green" : s.status === "grace" || s.status === "free" ? "amber" : "blue"}>{STATUS[s.status]}</Badge>
          {s.status === "trial" && <span className="text-sm muted">{s.days_left} days left — every feature of the Business plan.</span>}
          {s.status === "active" && <span className="text-sm muted">Paid until {fmtDate(s.paid_until!.slice(0, 10))} ({s.interval})</span>}
          {s.status === "grace" && <span className="text-sm text-amber-700 dark:text-amber-300">Your plan ended on {fmtDate(s.paid_until!.slice(0, 10))}. Renew within {s.days_left} days to keep its features.</span>}
          {s.status === "free" && <span className="text-sm text-amber-700 dark:text-amber-300">Your free trial or plan has ended. Choose a plan below to continue adding entries. You can still view, print and export everything.</span>}
        </div>
        {data.autopay && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <span>Auto-renew: <strong>{AUTOPAY[data.autopay.status] ?? data.autopay.status}</strong>{autopayLive(data.autopay) && <> · {data.plans.find((p) => p.id === data.autopay!.plan)?.name}, {inr(data.autopay.total)} every {data.autopay.interval === "monthly" ? "month" : "year"}</>}</span>
            {autopayLive(data.autopay) && data.can_buy && (
              <Button size="sm" variant="secondary" loading={stopping} onClick={async () => {
                if (!confirm("Turn off auto-renew? No more charges will be taken. The days already paid for are kept.")) return;
                setStopping(true);
                try { await api.post(`/api/billing/org/${orgId}/autopay/cancel`); toast("success", "Auto-renew is off"); reload(); }
                catch (e) { toast("error", errorMessage(e)); } finally { setStopping(false); }
              }}>Turn off auto-renew</Button>
            )}
          </div>
        )}
        <p className="mt-2 text-xs muted">Account ID <span className="select-all font-mono">{data.account_id}</span>{data.autopay && <> · Auto-renew subscription ID <span className="select-all font-mono">{data.autopay.id}</span></>} — quote these when you contact support.</p>
        <p className="mt-3 text-sm">Using {data.usage.users} of {current.limits.users} users · {data.usage.companies} of {current.limits.companies} companies · up to {data.usage.branches} of {current.limits.branches} branches per company</p>
      </Card>
      <div className="flex items-center gap-3"><span className="text-sm font-medium">Pay</span>
        <div className="flex gap-1">{(["monthly", "yearly"] as const).map((i) => <Button key={i} size="sm" variant={interval === i ? "primary" : "secondary"} onClick={() => setInterval(i)}>{i === "monthly" ? "Monthly" : "Yearly (2 months free)"}</Button>)}</div>
        <span className="text-xs muted">Prices plus {data.gst_percent}% GST</span>
        {data.can_buy && data.online && !autopayLive(data.autopay) && (
          <label className="ml-auto flex items-center gap-2 text-sm"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            Renew automatically <span className="text-xs muted">(UPI AutoPay, card or bank mandate — cancel any time)</span></label>
        )}</div>
      <div className="grid gap-4 md:grid-cols-3">
        {data.plans.filter((p) => PAID_PLANS.includes(p.id)).map((p) => {
          const price = p.price[interval];
          const same = s.paid_plan === p.id;
          return (
            <Card key={p.id} className={same ? "border-brand-500" : ""}>
              <p className="text-lg font-semibold">{p.name}</p><p className="text-sm muted">{p.tagline}</p>
              <p className="mt-3 text-2xl font-bold">{inr(price)}<span className="text-sm font-normal muted"> / {interval === "monthly" ? "month" : "year"}</span></p>
              <p className="text-xs muted">{inr(withGst(price, data.gst_percent).total)} including GST</p>
              <ul className="mt-3 space-y-1 text-sm">
                <li>{p.limits.users} users · {p.limits.branches} branch{p.limits.branches > 1 ? "es" : ""} · {p.limits.companies} compan{p.limits.companies > 1 ? "ies" : "y"}</li>
                {p.features.map((f) => <li key={f} className="flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />{FEATURE_LABELS[f]}</li>)}
              </ul>
              {data.can_buy ? (
                data.online
                  ? <Button className="mt-4 w-full" onClick={() => goCheckout(`/billing/${orgId}/checkout?plan=${p.id}&interval=${interval}${auto && !autopayLive(data.autopay) ? "&mode=autopay" : ""}`)}>{same ? "Renew" : "Choose"} {p.name}</Button>
                  : <p className="mt-4 text-xs muted">Online payment is not available right now. Write to info@niyazio.com with your account ID to pay by bank transfer.</p>
              ) : <p className="mt-4 text-xs muted">Only the owner can change the plan.</p>}
            </Card>
          );
        })}
      </div>
      {data.payments.length > 0 && (
        <Card title="Invoices" padded={false}>
          <TableWrap><table className="table text-sm"><thead><tr><th>Invoice</th><th>Plan</th><th>Period</th><th>Payment ID</th><th className="num">Amount</th><th /></tr></thead>
            <tbody>{data.payments.map((p) => (
              <tr key={p.id}><td>{p.invoice_number}</td><td>{data.plans.find((x) => x.id === p.plan)?.name} ({p.billing_interval})</td>
                <td>{fmtDate(p.period_start.slice(0, 10))} – {fmtDate(p.period_end.slice(0, 10))}</td>
                <td className="font-mono text-xs">{p.provider_payment_id ?? (p.provider === "manual" ? "Bank transfer" : "—")}{p.provider_subscription_id && <span className="block muted">auto-renew</span>}</td><td className="num">{inr(p.total)}</td>
                <td className="text-right"><Link className="text-brand-700 hover:underline dark:text-brand-300" to={`/billing/${orgId}/invoice/${p.id}`} target="_blank">View</Link></td></tr>
            ))}</tbody></table></TableWrap>
        </Card>
      )}
    </div>
  );
}

/**
 * Start-of-trial screen: with auto-pay required, a new organisation chooses the plan to continue with and approves a
 * Razorpay mandate (₹5 check, refunded). Nothing is charged until the trial ends; it can be cancelled before then.
 * Everything stays viewable behind it; new entries are held by the server until auto-pay is set up.
 */
export function TrialGate() {
  const { settings } = useCompany();
  const { logout } = useSession();
  const orgId = settings?.company.org_id;
  const { data } = useApi<BillingInfo>(orgId ? `/api/billing/org/${orgId}` : null);
  const [interval, setInterval] = useState<Interval>("monthly");
  const [plan, setPlan] = useState("business");
  if (!data?.autopay_required) return null;
  const ends = data.subscription.trial_ends_at ? fmtDate(data.subscription.trial_ends_at.slice(0, 10)) : "";
  return (
    <div className="no-print fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-900/60 p-4" role="dialog" aria-modal="true" aria-labelledby="trial-title">
      <div className="w-full max-w-3xl rounded-2xl bg-[var(--surface)] p-6 shadow-xl">
        <h2 id="trial-title" className="text-xl font-semibold">Start your {data.trial_days ?? 30}-day free trial</h2>
        <p className="mt-1 text-sm muted">Every feature is free until <b>{ends}</b>. Choose the plan to continue with after that and set up auto-pay with UPI AutoPay, a card or a bank mandate.</p>
        <ul className="mt-3 space-y-1 text-sm">
          <li className="flex gap-2"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />Razorpay takes <b>₹5 to check</b> your UPI or card and <b>refunds it</b>.</li>
          <li className="flex gap-2"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />No charge until {ends}. Turn off auto-renew any time before that in Settings → Plan & billing.</li>
          <li className="flex gap-2"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />Your data is never deleted, whatever you decide.</li>
        </ul>
        {data.can_buy ? <>
          <div className="mt-4 flex gap-1">{(["monthly", "yearly"] as const).map((i) => <Button key={i} size="sm" variant={interval === i ? "primary" : "secondary"} onClick={() => setInterval(i)}>{i === "monthly" ? "Monthly" : "Yearly (2 months free)"}</Button>)}</div>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            {data.plans.filter((p) => PAID_PLANS.includes(p.id)).map((p) => (
              <button key={p.id} onClick={() => setPlan(p.id)} className={`rounded-xl border p-3 text-left ${plan === p.id ? "border-brand-600 ring-2 ring-brand-600/30" : "border-[var(--border)] hover:bg-[var(--surface-2)]"}`}>
                <p className="font-semibold">{p.name}</p>
                <p className="text-sm">{inr(withGst(p.price[interval], data.gst_percent).total)} / {interval === "monthly" ? "month" : "year"}</p>
                <p className="mt-1 text-xs muted">{p.limits.users} users · {p.limits.branches} branch{p.limits.branches > 1 ? "es" : ""}{p.features.length ? ` · ${p.features.map((f) => FEATURE_LABELS[f]).join(", ")}` : ""}</p>
              </button>
            ))}
          </div>
          {(() => { const chosen = data.plans.find((p) => p.id === plan); return chosen && withGst(chosen.price[interval], data.gst_percent).total > UPI_AUTOPAY_LIMIT
            ? <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">UPI AutoPay allows up to ₹15,000 a charge, so for this plan use a debit/credit card or a bank mandate (or choose monthly).</p> : null; })()}
          {data.online
            ? <Button className="mt-5 w-full" onClick={() => goCheckout(`/billing/${orgId}/checkout?plan=${plan}&interval=${interval}&mode=autopay`)}>Start free trial — set up auto-pay</Button>
            : <Alert className="mt-4">Online payment is not available right now. Write to info@niyazio.com with your account ID {data.account_id}.</Alert>}
        </> : <Alert kind="info" className="mt-4">Your organisation's owner needs to start the free trial (Settings → Plan & billing). You can look around meanwhile.</Alert>}
        <div className="mt-3 flex justify-between text-sm"><span className="muted">Account ID {data.account_id}</span><button className="muted hover:underline" onClick={() => void logout()}>Sign out</button></div>
      </div>
    </div>
  );
}

/**
 * There is no Free plan: when the trial or plan has ended (or the desktop app has no valid licence) this asks to
 * renew. It can be put aside to look things up, view and export; new entries are held by the server until renewal.
 */
export function RenewGate() {
  const { settings, id } = useCompany();
  const { me } = useSession();
  const navigate = useNavigate();
  const { data, reload } = useApi<BillingInfo>(settings ? `/api/billing/org/${settings.company.org_id}` : null);
  const [later, setLater] = useState(() => { try { return sessionStorage.getItem("lf-renew-later") === "1"; } catch { return false; } });
  useEffect(() => {
    const on = () => void reload();
    window.addEventListener("ledgerfox-licence", on);
    return () => window.removeEventListener("ledgerfox-licence", on);
  }, [reload]);
  if (!data?.renew_required || settings?.company.is_practice) return null;
  const desktop = me?.edition === "desktop";
  const owner = desktop ? data.role === "owner" || data.role === "admin" : data.can_buy;
  const go = () => { setLater(true); navigate(`/app/${id}/settings?tab=billing`); };
  const bar = (
    <div className="no-print border-b border-red-300 bg-red-50 px-4 py-1.5 text-center text-xs text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
      {desktop ? "Sign in or renew your plan to continue adding entries." : "Your plan has ended. Renew to continue adding entries."} Viewing and exports still work.{" "}
      <Link className="font-medium underline" to={`/app/${id}/settings?tab=billing`}>{desktop ? "Plan & billing" : "Renew now"}</Link>
    </div>
  );
  // The desktop app has its own, more specific reminder bar (DesktopLicenceBanner).
  if (later) return desktop ? null : bar;
  return <>
    {!desktop && bar}
    <div className="no-print fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-900/60 p-4" role="dialog" aria-modal="true" aria-labelledby="renew-title">
      <div className="w-full max-w-lg rounded-2xl bg-[var(--surface)] p-6 shadow-xl">
        <h2 id="renew-title" className="text-xl font-semibold">{desktop && data.subscription.status === "free" ? "Sign in or renew to continue" : "Renew your plan to continue"}</h2>
        <p className="mt-2 text-sm">{desktop
          ? "This computer needs a current LedgerFox plan. Sign in with your LedgerFox account (new accounts get a free trial), or renew on the website and click “Check now”."
          : "Your free trial or paid plan has ended. Choose a plan to continue adding invoices, payments and entries."}</p>
        <ul className="mt-3 space-y-1 text-sm">
          <li className="flex gap-2"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />Your data is safe and never deleted.</li>
          <li className="flex gap-2"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />You can still view, print and export everything meanwhile.</li>
        </ul>
        {!owner && <Alert kind="info" className="mt-4">Ask your organisation's owner to renew in Settings → Plan & billing.</Alert>}
        <div className="mt-5 flex flex-wrap gap-2">
          {owner && <Button onClick={go}>{desktop ? "Sign in / renew" : "Renew now"}</Button>}
          <Button variant="secondary" onClick={() => { setLater(true); try { sessionStorage.setItem("lf-renew-later", "1"); } catch { /* private window */ } }}>View only for now</Button>
        </div>
        <p className="mt-3 text-xs muted">Account ID {data.account_id} · Questions? info@niyazio.com</p>
      </div>
    </div>
  </>;
}

/** Thin banner when the trial is about to end or a renewal is due. */
export function PlanBanner() {
  const { settings, id } = useCompany();
  const { data } = useApi<BillingInfo>(settings ? `/api/billing/org/${settings.company.org_id}` : null);
  const s = data?.subscription;
  if (!s?.enforced) return null;
  const show = (s.status === "trial" && (s.days_left ?? 99) <= 3) || s.status === "grace" || (s.status === "active" && (s.days_left ?? 99) <= 5);
  if (!show) return null;
  const text = s.status === "trial" ? `Free trial ends in ${s.days_left} day(s).` : s.status === "grace" ? `Your plan has ended — renew within ${s.days_left} day(s) to keep working.` : `Your plan renews in ${s.days_left} day(s).`;
  return <div className="no-print border-b border-amber-300 bg-amber-50 px-4 py-1.5 text-center text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">{text} <Link className="font-medium underline" to={`/app/${id}/settings?tab=billing`}>Plan & billing</Link></div>;
}

/** Thin banner until the signed-in person confirms their email address (hosted website with email switched on). */
export function VerifyEmailBanner() {
  const { me } = useSession();
  const toast = useToast();
  const [sent, setSent] = useState(false);
  const u = me?.user;
  if (!me?.email_enabled || !u || u.email_verified || !u.email_deliverable) return null;
  return (
    <div className="no-print border-b border-sky-200 bg-sky-50 px-4 py-1.5 text-center text-xs text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200">
      Please confirm your email ({u.email}) so password reset links, receipts and reminders reach you.{" "}
      {sent ? <span>Sent — check your inbox.</span> : <button className="font-medium underline" onClick={async () => {
        try { await api.post("/api/auth/verify-email/send"); setSent(true); } catch (e) { toast("error", errorMessage(e)); }
      }}>Send the link again</button>}
    </div>
  );
}

declare global { interface Window { Razorpay?: new (opts: Record<string, unknown>) => { open: () => void; on: (e: string, cb: (r: unknown) => void) => void } } }

/** /billing/:orgId/checkout — the only page allowed to load Razorpay's checkout script. */
export function CheckoutPage() {
  const { orgId } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [state, setState] = useState<"loading" | "ready" | "paying" | "done" | "error">("loading");
  const [message, setMessage] = useState("");
  const plan = params.get("plan"), interval = params.get("interval"), autopay = params.get("mode") === "autopay";
  const [startsAt, setStartsAt] = useState<string | null>(null);
  useEffect(() => {
    if (window.Razorpay) { setState("ready"); return; }
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.onload = () => setState("ready");
    s.onerror = () => { setState("error"); setMessage("Could not load the payment window. Check your internet connection."); };
    document.body.appendChild(s);
  }, []);
  const failed = () => { setState("error"); setMessage("The payment did not go through. No money was taken, or it will be refunded automatically."); };
  const pay = async () => {
    setState("paying");
    try {
      if (autopay) {
        const o = await api.post<{ subscription_id: string; key_id: string; amount: number; name: string; starts_at: string | null; prefill: Record<string, string> }>(`/api/billing/org/${orgId}/autopay`, { plan, interval });
        setStartsAt(o.starts_at);
        const rz = new window.Razorpay!({
          key: o.key_id, subscription_id: o.subscription_id, name: "LedgerFox", description: `${o.name} plan, renews every ${interval === "monthly" ? "month" : "year"}`, prefill: o.prefill, theme: { color: "#1d4ed8" },
          handler: async (r: { razorpay_subscription_id: string; razorpay_payment_id: string; razorpay_signature: string }) => {
            try { await api.post(`/api/billing/org/${orgId}/autopay/verify`, r); setState("done"); }
            catch (e) { setState("error"); setMessage(errorMessage(e)); }
          },
          modal: { ondismiss: () => setState("ready") },
        });
        rz.on("payment.failed", failed);
        rz.open();
        return;
      }
      const o = await api.post<{ order_id: string; key_id: string; amount: number; currency: string; name: string; prefill: Record<string, string> }>(`/api/billing/org/${orgId}/checkout`, { plan, interval });
      const rz = new window.Razorpay!({
        key: o.key_id, order_id: o.order_id, amount: o.amount, currency: o.currency, name: "LedgerFox", description: `${o.name} plan (${interval})`, prefill: o.prefill, theme: { color: "#1d4ed8" },
        handler: async (r: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => {
          try { await api.post(`/api/billing/org/${orgId}/verify`, r); setState("done"); }
          catch (e) { setState("error"); setMessage(errorMessage(e)); }
        },
        modal: { ondismiss: () => setState("ready") },
      });
      rz.on("payment.failed", failed);
      rz.open();
    } catch (e) { setState("error"); setMessage(errorMessage(e)); }
  };
  return (
    <div className="flex min-h-full items-center justify-center px-4 py-10">
      <div className="w-full max-w-md text-center">
        <div className="mb-6 flex justify-center text-lg"><Wordmark iconClass="h-8 w-8" /></div>
        <Card>
          {state === "done" ? <>
            <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-600" />
            <p className="mt-3 text-lg font-semibold">{autopay ? (startsAt ? "Auto-pay is set up — enjoy your free trial" : "Payment received — auto-renew is on") : "Payment received — your plan is active"}</p>
            {autopay && <p className="mt-1 text-sm muted">{startsAt ? `Your free trial is running. The ₹5 check is refunded by Razorpay; the first charge is on ${fmtDate(startsAt.slice(0, 10))}.` : "Your plan is active. It will renew by itself; you can turn this off in Plan & billing."} It can take a minute to show in LedgerFox.</p>}
            <Button className="mt-4" onClick={() => nav(-1)}>Back to LedgerFox</Button>
          </> : <>
            <p className="text-lg font-semibold">{autopay ? "Set up auto-renew for your LedgerFox plan" : "Pay for your LedgerFox plan"}</p>
            <p className="mt-1 text-sm muted">{autopay ? "Approve a UPI AutoPay, card or bank mandate with Razorpay. If your free trial or paid period is still running, Razorpay only takes ₹5 now to check it (refunded) and the first charge waits until the period ends. You are then charged each period until you turn it off in Plan & billing." : "Secure payment by Razorpay (UPI, cards, net banking)."} LedgerFox never sees your card details or UPI PIN.</p>
            {message && <Alert className="mt-4 text-left">{message}</Alert>}
            {autopay && state === "error" && <Button variant="secondary" className="mt-3 w-full" onClick={() => window.location.assign(`/billing/${orgId}/checkout?plan=${plan}&interval=${interval}`)}>Pay once instead (no auto-renew)</Button>}
            <Button className="mt-4 w-full" loading={state === "loading" || state === "paying"} onClick={() => void pay()}>Continue to payment</Button>
            <button className="mt-3 text-sm muted hover:underline" onClick={() => nav(-1)}>Cancel</button>
          </>}
        </Card>
      </div>
    </div>
  );
}

/** Tax invoice for a subscription payment. */
export function BillingInvoice() {
  const { orgId, paymentId } = useParams();
  const { data, error } = useApi<any>(`/api/billing/org/${orgId}/invoice/${paymentId}`);
  if (error) return <div className="p-8"><Alert>{error}</Alert></div>;
  if (!data) return <Spinner />;
  const p = data.payment, b = data.buyer ?? {}, s = data.seller;
  const intra = s.state_code && b.state_code && s.state_code === b.state_code;
  return (
    <div className="mx-auto max-w-3xl bg-white p-8 text-sm text-slate-900">
      <div className="no-print mb-4 flex justify-end"><Button onClick={printPage}><Printer className="h-4 w-4" />Print / Save PDF</Button></div>
      <div className="flex justify-between"><div><p className="text-lg font-semibold">{s.name}</p>{s.address && <p>{s.address}</p>}{s.gstin && <p>GSTIN {s.gstin}</p>}{s.udyam && <p>Udyam {s.udyam}</p>}<p>{s.email}</p></div>
        <div className="text-right"><p className="text-xl font-semibold">{s.gstin ? "Tax Invoice" : "Invoice"}</p><p>No. {p.invoice_number}</p><p>Date {fmtDate(p.paid_at.slice(0, 10))}</p></div></div>
      <div className="mt-6"><p className="text-slate-500">Bill to</p><p className="font-medium">{b.legal_name || b.name || b.org_name}</p>{b.address && <p>{[b.address, b.city].filter(Boolean).join(", ")}</p>}{b.tax_id && <p>GSTIN {b.tax_id}</p>}</div>
      <table className="mt-6 w-full border-collapse"><thead><tr className="border-b border-slate-300 text-left"><th className="py-2">Description</th><th>SAC</th><th className="text-right">Amount</th></tr></thead>
        <tbody><tr className="border-b border-slate-200"><td className="py-2">LedgerFox {p.plan.replace("_", "-")} plan, {p.billing_interval} subscription<br /><span className="text-slate-500">{fmtDate(p.period_start.slice(0, 10))} to {fmtDate(p.period_end.slice(0, 10))}</span></td><td>{data.sac}</td><td className="text-right">{inr(p.amount)}</td></tr></tbody></table>
      <dl className="ml-auto mt-3 w-64 space-y-1">
        {intra ? <><div className="flex justify-between"><dt>CGST</dt><dd>{inr(p.gst / 2)}</dd></div><div className="flex justify-between"><dt>SGST</dt><dd>{inr(p.gst / 2)}</dd></div></>
          : <div className="flex justify-between"><dt>{s.gstin ? "IGST" : "GST"}</dt><dd>{inr(p.gst)}</dd></div>}
        <div className="flex justify-between border-t border-slate-300 pt-1 font-semibold"><dt>Total paid</dt><dd>{inr(p.total)}</dd></div>
      </dl>
      <dl className="mt-6 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-xs text-slate-600">
        <dt>Account ID</dt><dd className="font-mono">{p.org_id}</dd>
        {p.provider_payment_id && <><dt>Payment ID</dt><dd className="font-mono">{p.provider_payment_id}</dd></>}
        {p.provider_order_id && <><dt>Order ID</dt><dd className="font-mono">{p.provider_order_id}</dd></>}
        {p.provider_subscription_id && <><dt>Subscription ID</dt><dd className="font-mono">{p.provider_subscription_id}</dd></>}
      </dl>
      <p className="mt-4 text-xs text-slate-500">Paid {p.provider === "razorpay" ? (p.provider_subscription_id ? "online via Razorpay (auto-renew)" : "online via Razorpay") : "by bank transfer"}. This is a computer-generated invoice.</p>
    </div>
  );
}

const OK = ({ ok, children }: { ok: boolean; children: React.ReactNode }) => (
  <li className="flex items-start gap-2"><span className={ok ? "text-emerald-600" : "text-red-600"}>{ok ? "✓" : "✗"}</span><span>{children}</span></li>
);

/** What the live server can see of the payment and email set-up (never secret values). */
export function SetupCheck() {
  const { data, error, reload, loading } = useApi<any>("/api/billing/vendor/setup");
  if (error) return <Alert className="mb-4">{error}</Alert>;
  if (!data) return null;
  const r = data.razorpay;
  return (
    <Card title="Set-up check" className="mb-4">
      <ul className="space-y-1 text-sm">
        <OK ok={data.billing_enabled}>Subscriptions switched on (BILLING_ENABLED)</OK>
        <OK ok={r.key_id}>RAZORPAY_KEY_ID {r.key_id ? <>found — <strong>{r.mode === "live" ? "LIVE mode" : r.mode === "test" ? "TEST mode (no real money)" : "unknown key type"}</strong></> : "missing — the Pay buttons stay hidden until it is added as a secret of the ledgerfox Worker"}</OK>
        <OK ok={r.key_secret}>RAZORPAY_KEY_SECRET {r.key_secret ? "found" : "missing"}</OK>
        <OK ok={r.api === "ok"}>Razorpay accepts the keys: {{ ok: "yes", rejected: "no — the key id and secret do not match, or belong to a different mode", unreachable: "could not reach Razorpay", not_checked: "not checked (keys missing)" }[r.api as string]}</OK>
        <OK ok={r.subscriptions === "ok"}>Auto-renew (Razorpay Subscriptions): {r.subscriptions === "ok" ? "available" : r.subscriptions === "unavailable" ? <>not available{r.subscriptions_detail ? ` (${r.subscriptions_detail})` : ""} — switch on Subscriptions in the Razorpay dashboard; until then customers can untick “Renew automatically” and pay once</> : "not checked"}</OK>
        <OK ok={r.webhook_secret}>RAZORPAY_WEBHOOK_SECRET {r.webhook_secret ? "found" : "missing — payments made after the browser is closed, and auto-renew charges, are not recorded"}. Webhook URL: <span className="select-all font-mono text-xs">{data.webhook_url}</span></OK>
        <OK ok={data.email.enabled}>Email {data.email.enabled ? <>on, from {data.email.from}</> : "off — add RESEND_API_KEY (secret) and EMAIL_FROM for reset links, receipts and reminders"}</OK>
        <OK ok={Boolean(data.vendor.legal_name && data.vendor.address && data.vendor.state_code && (data.vendor.gstin || !data.vendor.gst_registered))}>Seller details on invoices: {data.vendor.legal_name ?? "VENDOR_LEGAL_NAME missing"}{data.vendor.gst_registered ? (data.vendor.gstin ? " · GSTIN set" : " · VENDOR_GSTIN missing (GST is being charged)") : " · not GST-registered, no GST charged"}{data.vendor.udyam ? ` · Udyam ${data.vendor.udyam}` : ""}</OK>
        <OK ok>Free trial: {data.trial_days} days{data.require_autopay ? " · auto-pay (₹5 refundable check) required to start it" : " · auto-pay optional"}</OK>
      </ul>
      <Button className="mt-3" size="sm" variant="secondary" loading={loading} onClick={reload}>Check again</Button>
    </Card>
  );
}

const EMPTY_PROMO = { title: "", body: "", cta: "Learn more", link_url: "https://", sponsor: "", starts_on: "", ends_on: "", weight: 1, is_active: true };

/** Promotions shown to Free-plan organisations: text and an https link only. */
export function PromotionsAdmin() {
  const toast = useToast();
  const { data, reload } = useApi<{ promotions: any[] }>("/api/billing/vendor/promotions");
  const [edit, setEdit] = useState<(typeof EMPTY_PROMO & { id?: string }) | null>(null);
  const save = async () => {
    if (!edit) return;
    const { id, ...rest } = edit;
    const payload = { ...rest, sponsor: rest.sponsor || null, starts_on: rest.starts_on || null, ends_on: rest.ends_on || null, weight: Number(rest.weight) || 1 };
    try {
      if (id) await api.put(`/api/billing/vendor/promotions/${id}`, payload); else await api.post("/api/billing/vendor/promotions", payload);
      setEdit(null); reload(); toast("success", "Saved");
    } catch (e) { toast("error", errorMessage(e)); }
  };
  return (
    <Card title="Promotions on the Free plan" className="mt-6">
      <p className="mb-3 text-sm muted">One small card on the dashboard of organisations on the Free plan (never trial, paid or desktop users). Text and a link only — no ad scripts run inside the app. Your own messages about paid plans and the desktop app are shown too.</p>
      {data && data.promotions.length > 0 && (
        <TableWrap><table className="table text-sm"><thead><tr><th>Message</th><th>Sponsor</th><th>Dates</th><th className="num">Views</th><th className="num">Clicks</th><th>Status</th><th /></tr></thead>
          <tbody>{data.promotions.map((p) => (
            <tr key={p.id}><td><span className="font-medium">{p.title}</span><span className="block text-xs muted">{p.link_url}</span></td><td>{p.sponsor ?? "—"}</td>
              <td>{p.starts_on ?? "…"} – {p.ends_on ?? "…"}</td><td className="num">{p.views}</td><td className="num">{p.clicks}</td><td>{p.is_active ? "On" : "Off"}</td>
              <td className="whitespace-nowrap text-right"><Button size="sm" variant="ghost" onClick={() => setEdit({ ...EMPTY_PROMO, ...p, sponsor: p.sponsor ?? "", starts_on: p.starts_on ?? "", ends_on: p.ends_on ?? "", is_active: !!p.is_active })}>Edit</Button>
                <Button size="sm" variant="ghost" onClick={async () => { if (confirm(`Delete "${p.title}"?`)) { await api.del(`/api/billing/vendor/promotions/${p.id}`); reload(); } }}>Delete</Button></td></tr>
          ))}</tbody></table></TableWrap>
      )}
      {edit ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Title (60)">{(fid) => <Input id={fid} maxLength={60} value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />}</Field>
          <Field label="Sponsor (blank for your own message)">{(fid) => <Input id={fid} maxLength={60} value={edit.sponsor} onChange={(e) => setEdit({ ...edit, sponsor: e.target.value })} />}</Field>
          <Field label="Text (160)" className="sm:col-span-2">{(fid) => <Input id={fid} maxLength={160} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} />}</Field>
          <Field label="Link (https://)">{(fid) => <Input id={fid} value={edit.link_url} onChange={(e) => setEdit({ ...edit, link_url: e.target.value })} />}</Field>
          <Field label="Button text">{(fid) => <Input id={fid} maxLength={20} value={edit.cta} onChange={(e) => setEdit({ ...edit, cta: e.target.value })} />}</Field>
          <Field label="From">{(fid) => <Input id={fid} type="date" value={edit.starts_on} onChange={(e) => setEdit({ ...edit, starts_on: e.target.value })} />}</Field>
          <Field label="Until">{(fid) => <Input id={fid} type="date" value={edit.ends_on} onChange={(e) => setEdit({ ...edit, ends_on: e.target.value })} />}</Field>
          <Field label="Share (1–10)">{(fid) => <Input id={fid} type="number" min={1} max={10} value={edit.weight} onChange={(e) => setEdit({ ...edit, weight: Number(e.target.value) })} />}</Field>
          <label className="flex items-center gap-2 self-end text-sm"><input type="checkbox" checked={edit.is_active} onChange={(e) => setEdit({ ...edit, is_active: e.target.checked })} />Show it</label>
          <div className="flex gap-2 sm:col-span-2"><Button onClick={() => void save()}>Save</Button><Button variant="secondary" onClick={() => setEdit(null)}>Cancel</Button></div>
        </div>
      ) : <Button className="mt-3" size="sm" onClick={() => setEdit({ ...EMPTY_PROMO })}>Add a promotion</Button>}
    </Card>
  );
}

