import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { CheckCircle2, Printer } from "lucide-react";
import { useCompany } from "../lib/company";
import { useApi } from "../lib/hooks";
import { api, errorMessage } from "../lib/api";
import { Alert, Badge, Button, Card, Field, Input, PageHeader, Select, Spinner, TableWrap, useToast } from "../components/ui";
import { Wordmark } from "../components/Layout";
import { FEATURE_LABELS, PAID_PLANS, withGst, type Interval, type Plan } from "@shared/plans";
import { fmtDate, money as fmt } from "../lib/format";

const inr = (paise: number) => fmt(paise, "INR");

interface BillingInfo {
  enabled: boolean; can_buy: boolean; online: boolean; gst_percent: number; plans: Plan[];
  subscription: { enforced: boolean; plan: string; paid_plan: string | null; status: string; interval: Interval | null; trial_ends_at: string | null; paid_until: string | null; days_left: number | null };
  usage: { users: number; companies: number; branches: number };
  payments: { id: string; plan: string; billing_interval: string; total: number; invoice_number: string; period_start: string; period_end: string; paid_at: string; provider: string }[];
}

const STATUS: Record<string, string> = { trial: "Free trial", active: "Active", grace: "Payment due", free: "Free plan", unlimited: "Unlimited" };

/** Settings → Plan & billing. */
export function PlanBillingTab() {
  const { settings } = useCompany();
  const orgId = settings!.company.org_id;
  const nav = useNavigate();
  const { data, error } = useApi<BillingInfo>(`/api/billing/org/${orgId}`);
  const [interval, setInterval] = useState<Interval>("yearly");
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Spinner />;
  if (!data.enabled) return <Card><p className="text-sm">All features are available. Subscriptions are not switched on for this LedgerFox.</p></Card>;
  const s = data.subscription;
  const current = data.plans.find((p) => p.id === s.plan)!;
  return (
    <div className="space-y-4">
      <Card title="Your plan">
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-xl font-semibold">{current.name}</p><Badge color={s.status === "active" ? "green" : s.status === "grace" || s.status === "free" ? "amber" : "blue"}>{STATUS[s.status]}</Badge>
          {s.status === "trial" && <span className="text-sm muted">{s.days_left} days left — every feature of the Business plan.</span>}
          {s.status === "active" && <span className="text-sm muted">Paid until {fmtDate(s.paid_until!.slice(0, 10))} ({s.interval})</span>}
          {s.status === "grace" && <span className="text-sm text-amber-700 dark:text-amber-300">Your plan ended on {fmtDate(s.paid_until!.slice(0, 10))}. Renew within {s.days_left} days to keep its features.</span>}
          {s.status === "free" && <span className="text-sm muted">Billing, accounts and reports keep working. Choose a plan for more users, branches, POS, payroll and GST returns.</span>}
        </div>
        <p className="mt-3 text-sm">Using {data.usage.users} of {current.limits.users} users · {data.usage.companies} of {current.limits.companies} companies · up to {data.usage.branches} of {current.limits.branches} branches per company</p>
      </Card>
      <div className="flex items-center gap-3"><span className="text-sm font-medium">Pay</span>
        <div className="flex gap-1">{(["monthly", "yearly"] as const).map((i) => <Button key={i} size="sm" variant={interval === i ? "primary" : "secondary"} onClick={() => setInterval(i)}>{i === "monthly" ? "Monthly" : "Yearly (2 months free)"}</Button>)}</div>
        <span className="text-xs muted">Prices plus {data.gst_percent}% GST</span></div>
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
                  ? <Button className="mt-4 w-full" onClick={() => nav(`/billing/${orgId}/checkout?plan=${p.id}&interval=${interval}`)}>{same ? "Renew" : "Choose"} {p.name}</Button>
                  : <p className="mt-4 text-xs muted">Online payment is not set up yet. Write to info@niyazio.com to pay by bank transfer.</p>
              ) : <p className="mt-4 text-xs muted">Only the owner can change the plan.</p>}
            </Card>
          );
        })}
      </div>
      {data.payments.length > 0 && (
        <Card title="Invoices" padded={false}>
          <TableWrap><table className="table text-sm"><thead><tr><th>Invoice</th><th>Plan</th><th>Period</th><th className="num">Amount</th><th /></tr></thead>
            <tbody>{data.payments.map((p) => (
              <tr key={p.id}><td>{p.invoice_number}</td><td>{data.plans.find((x) => x.id === p.plan)?.name} ({p.billing_interval})</td>
                <td>{fmtDate(p.period_start.slice(0, 10))} – {fmtDate(p.period_end.slice(0, 10))}</td><td className="num">{inr(p.total)}</td>
                <td className="text-right"><Link className="text-brand-700 hover:underline dark:text-brand-300" to={`/billing/${orgId}/invoice/${p.id}`} target="_blank">View</Link></td></tr>
            ))}</tbody></table></TableWrap>
        </Card>
      )}
    </div>
  );
}

/** Thin banner when the trial is about to end or a renewal is due. */
export function PlanBanner() {
  const { settings, id } = useCompany();
  const { data } = useApi<BillingInfo>(settings ? `/api/billing/org/${settings.company.org_id}` : null);
  const s = data?.subscription;
  if (!s?.enforced) return null;
  const show = (s.status === "trial" && (s.days_left ?? 99) <= 3) || s.status === "grace" || (s.status === "active" && (s.days_left ?? 99) <= 5);
  if (!show) return null;
  const text = s.status === "trial" ? `Free trial ends in ${s.days_left} day(s).` : s.status === "grace" ? `Your plan has ended — renew within ${s.days_left} day(s) to keep all features.` : `Your plan renews in ${s.days_left} day(s).`;
  return <div className="no-print border-b border-amber-300 bg-amber-50 px-4 py-1.5 text-center text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">{text} <Link className="font-medium underline" to={`/app/${id}/settings?tab=billing`}>Plan & billing</Link></div>;
}

declare global { interface Window { Razorpay?: new (opts: Record<string, unknown>) => { open: () => void; on: (e: string, cb: (r: unknown) => void) => void } } }

/** /billing/:orgId/checkout — the only page allowed to load Razorpay's checkout script. */
export function CheckoutPage() {
  const { orgId } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [state, setState] = useState<"loading" | "ready" | "paying" | "done" | "error">("loading");
  const [message, setMessage] = useState("");
  const plan = params.get("plan"), interval = params.get("interval");
  useEffect(() => {
    if (window.Razorpay) { setState("ready"); return; }
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.onload = () => setState("ready");
    s.onerror = () => { setState("error"); setMessage("Could not load the payment window. Check your internet connection."); };
    document.body.appendChild(s);
  }, []);
  const pay = async () => {
    setState("paying");
    try {
      const o = await api.post<{ order_id: string; key_id: string; amount: number; currency: string; name: string; prefill: Record<string, string> }>(`/api/billing/org/${orgId}/checkout`, { plan, interval });
      const rz = new window.Razorpay!({
        key: o.key_id, order_id: o.order_id, amount: o.amount, currency: o.currency, name: "LedgerFox", description: `${o.name} plan (${interval})`, prefill: o.prefill, theme: { color: "#1d4ed8" },
        handler: async (r: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => {
          try { await api.post(`/api/billing/org/${orgId}/verify`, r); setState("done"); }
          catch (e) { setState("error"); setMessage(errorMessage(e)); }
        },
        modal: { ondismiss: () => setState("ready") },
      });
      rz.on("payment.failed", () => { setState("error"); setMessage("The payment did not go through. No money was taken, or it will be refunded automatically."); });
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
            <p className="mt-3 text-lg font-semibold">Payment received — your plan is active</p>
            <Button className="mt-4" onClick={() => nav(-1)}>Back to LedgerFox</Button>
          </> : <>
            <p className="text-lg font-semibold">Pay for your LedgerFox plan</p>
            <p className="mt-1 text-sm muted">Secure payment by Razorpay (UPI, cards, net banking). LedgerFox never sees your card or UPI PIN.</p>
            {message && <Alert className="mt-4 text-left">{message}</Alert>}
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
      <div className="no-print mb-4 flex justify-end"><Button onClick={() => window.print()}><Printer className="h-4 w-4" />Print / Save PDF</Button></div>
      <div className="flex justify-between"><div><p className="text-lg font-semibold">{s.name}</p>{s.address && <p>{s.address}</p>}{s.gstin && <p>GSTIN {s.gstin}</p>}<p>{s.email}</p></div>
        <div className="text-right"><p className="text-xl font-semibold">{s.gstin ? "Tax Invoice" : "Invoice"}</p><p>No. {p.invoice_number}</p><p>Date {fmtDate(p.paid_at.slice(0, 10))}</p></div></div>
      <div className="mt-6"><p className="text-slate-500">Bill to</p><p className="font-medium">{b.legal_name || b.name || b.org_name}</p>{b.address && <p>{[b.address, b.city].filter(Boolean).join(", ")}</p>}{b.tax_id && <p>GSTIN {b.tax_id}</p>}</div>
      <table className="mt-6 w-full border-collapse"><thead><tr className="border-b border-slate-300 text-left"><th className="py-2">Description</th><th>SAC</th><th className="text-right">Amount</th></tr></thead>
        <tbody><tr className="border-b border-slate-200"><td className="py-2">LedgerFox {p.plan.replace("_", "-")} plan, {p.billing_interval} subscription<br /><span className="text-slate-500">{fmtDate(p.period_start.slice(0, 10))} to {fmtDate(p.period_end.slice(0, 10))}</span></td><td>{data.sac}</td><td className="text-right">{inr(p.amount)}</td></tr></tbody></table>
      <dl className="ml-auto mt-3 w-64 space-y-1">
        {intra ? <><div className="flex justify-between"><dt>CGST</dt><dd>{inr(p.gst / 2)}</dd></div><div className="flex justify-between"><dt>SGST</dt><dd>{inr(p.gst / 2)}</dd></div></>
          : <div className="flex justify-between"><dt>{s.gstin ? "IGST" : "GST"}</dt><dd>{inr(p.gst)}</dd></div>}
        <div className="flex justify-between border-t border-slate-300 pt-1 font-semibold"><dt>Total paid</dt><dd>{inr(p.total)}</dd></div>
      </dl>
      <p className="mt-6 text-xs text-slate-500">Paid {p.provider === "razorpay" ? "online via Razorpay" : "by bank transfer"}. This is a computer-generated invoice.</p>
    </div>
  );
}

/** /vendor — subscribers, revenue and manual activation, for the people selling LedgerFox. */
export function VendorAdmin() {
  const toast = useToast();
  const { data, error, reload } = useApi<any>("/api/billing/vendor/subscribers");
  const [act, setAct] = useState<{ org: string; plan: string; interval: Interval; note: string } | null>(null);
  if (error) return <div className="p-8"><Alert>{error}</Alert></div>;
  if (!data) return <Spinner />;
  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <PageHeader title="Subscribers" subtitle={data.enabled ? "Billing is on." : "Billing is off (BILLING_ENABLED is not set) — nobody is limited yet."} />
      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        <Card><p className="text-xs muted">Revenue, last 30 days (before GST)</p><p className="text-xl font-semibold">{inr(data.revenue.month)}</p></Card>
        <Card><p className="text-xs muted">Revenue, all time</p><p className="text-xl font-semibold">{inr(data.revenue.total)}</p></Card>
        <Card><p className="text-xs muted">Paying</p><p className="text-xl font-semibold">{(data.counts.active ?? 0) + (data.counts.grace ?? 0)}</p></Card>
        <Card><p className="text-xs muted">On trial / free</p><p className="text-xl font-semibold">{data.counts.trial ?? 0} / {data.counts.free ?? 0}</p></Card>
      </div>
      <Card padded={false}><TableWrap><table className="table text-sm">
        <thead><tr><th>Organisation</th><th>Owner</th><th>Since</th><th>Users</th><th>Plan</th><th>Status</th><th>Until</th><th /></tr></thead>
        <tbody>{data.subscribers.map((s: any) => (
          <tr key={s.org_id}><td>{s.org_name}</td><td>{s.owner_name}<span className="block text-xs muted">{s.owner_email}</span></td><td>{fmtDate(s.created_at.slice(0, 10))}</td><td>{s.users}</td>
            <td>{s.subscription.plan}</td><td>{STATUS[s.subscription.status]}</td><td>{s.subscription.paid_until?.slice(0, 10) ?? s.subscription.trial_ends_at?.slice(0, 10) ?? "—"}</td>
            <td className="whitespace-nowrap text-right"><Button size="sm" variant="ghost" onClick={() => setAct({ org: s.org_id, plan: "business", interval: "yearly", note: "" })}>Record payment</Button>
              <Button size="sm" variant="ghost" onClick={async () => { const d = Number(prompt("Extend the trial by how many days?", "14")); if (d) { try { await api.post(`/api/billing/vendor/orgs/${s.org_id}/trial`, { days: d }); reload(); } catch (e) { toast("error", errorMessage(e)); } } }}>Extend trial</Button></td></tr>
        ))}</tbody></table></TableWrap></Card>
      {act && (
        <Card title="Record a payment received outside Razorpay" className="mt-4">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Plan">{(fid) => <Select id={fid} value={act.plan} onChange={(e) => setAct({ ...act, plan: e.target.value })}>{PAID_PLANS.map((p) => <option key={p}>{p}</option>)}</Select>}</Field>
            <Field label="Period">{(fid) => <Select id={fid} value={act.interval} onChange={(e) => setAct({ ...act, interval: e.target.value as Interval })}><option value="monthly">1 month</option><option value="yearly">1 year</option></Select>}</Field>
            <Field label="Note (e.g. UTR)">{(fid) => <Input id={fid} value={act.note} onChange={(e) => setAct({ ...act, note: e.target.value })} />}</Field>
            <Button onClick={async () => { try { await api.post(`/api/billing/vendor/orgs/${act.org}/activate`, { plan: act.plan, interval: act.interval, note: act.note || null }); setAct(null); reload(); toast("success", "Activated"); } catch (e) { toast("error", errorMessage(e)); } }}>Activate</Button>
            <Button variant="secondary" onClick={() => setAct(null)}>Cancel</Button>
          </div>
        </Card>
      )}
    </div>
  );
}
