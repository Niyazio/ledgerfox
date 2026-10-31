import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useApi } from "../lib/hooks";
import { api, errorMessage } from "../lib/api";
import { downloadCsv } from "../lib/csv";
import { fmtDate, money as fmt } from "../lib/format";
import { Alert, Badge, Button, Card, DownloadButtons, Field, Input, Modal, PageHeader, Select, Spinner, Stat, TableWrap, Tabs, useToast } from "../components/ui";
import { Wordmark } from "../components/Layout";
import { PAID_PLANS, type Interval } from "@shared/plans";
import { PromotionsAdmin, SetupCheck } from "./Billing";

/**
 * /vendor — the admin panel for the people selling LedgerFox (VENDOR_ADMIN_EMAILS): organisations, sign-in accounts,
 * subscriptions, trials, auto-pay, payments, set-up and promotions. Customers' business records are only counted.
 */

const inr = (paise: number, currency = "INR") => fmt(paise ?? 0, currency || "INR");
const day = (iso?: string | null) => (iso ? fmtDate(iso.slice(0, 10)) : "—");
const ago = (iso?: string | null) => {
  if (!iso) return "never";
  const d = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
};
const STATUS: Record<string, [string, "green" | "amber" | "blue" | "gray" | "red"]> = {
  active: ["Paying", "green"], trial: ["Free trial", "blue"], grace: ["Payment due", "amber"], free: ["Ended — renew", "red"], unlimited: ["Unlimited", "gray"],
};
const AUTOPAY: Record<string, string> = { active: "On", pending: "Retrying", halted: "Stopped", paused: "Paused", cancelled: "Off", completed: "Finished", created: "Not approved" };

type TabId = "overview" | "orgs" | "users" | "payments" | "history" | "setup";

/** Names for the billing history (billing_events.kind). */
const EVENT: Record<string, string> = {
  trial_started: "Free trial started", no_trial: "No trial (already had one)", trial_extended: "Trial extended", trial_extend: "Trial extended",
  autopay_started: "Auto-pay set up (waiting for approval)", autopay_start: "Auto-pay set up", autopay_approved: "Auto-pay approved", autopay_authenticated: "Auto-pay approved (Razorpay)",
  autopay_activated: "Auto-pay active", autopay_charged: "Auto-pay charged", autopay_pending: "Auto-pay charge failed (retrying)", autopay_halted: "Auto-pay stopped after failures",
  autopay_cancelled: "Auto-pay cancelled (Razorpay)", autopay_cancel: "Auto-pay cancelled by owner", autopay_cancelled_by_owner: "Auto-pay cancelled by owner", autopay_completed: "Auto-pay finished",
  autopay_paused: "Auto-pay paused", autopay_resumed: "Auto-pay resumed", payment: "Payment received", manual_payment: "Cash / bank payment recorded", manual_activate: "Cash / bank payment recorded",
  checkout: "Checkout opened", free_access: "Free access given", plan_ended_by_vendor: "Plan ended by admin", suspended: "Access paused", unsuspended: "Access resumed",
  password_reset_by_vendor: "Password reset by admin", user_blocked: "Sign-in blocked", user_unblocked: "Sign-in unblocked",
};
const eventColor = (k: string): "green" | "amber" | "blue" | "gray" | "red" =>
  /payment|charged|approved|authenticated|activated|free_access|unsuspended|unblocked/.test(k) ? "green" : /cancel|halted|suspended$|blocked$|ended/.test(k) ? "red" : /pending|paused/.test(k) ? "amber" : "blue";
const detailText = (raw: string | null) => {
  if (!raw) return "";
  try {
    const d = JSON.parse(raw) as Record<string, unknown>;
    return Object.entries(d).filter(([, v]) => v !== null && v !== "" && v !== undefined)
      .map(([k, v]) => `${k.replace(/_/g, " ")}: ${k === "total" || k === "amount" ? inr(Number(v), String(d.currency ?? "INR")) : typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v) ? day(v) : String(v)}`).join(" · ");
  } catch { return raw; }
};

/** A one-time password created by the admin, shown once to pass on to the customer. */
function TempPassword({ result, onClose }: { result: { sign_in_id: string; email: string; temporary_password: string } | null; onClose: () => void }) {
  if (!result) return null;
  const text = `LedgerFox sign-in\nID: ${result.sign_in_id}\nOne-time password: ${result.temporary_password}\nYou will choose your own password after signing in.`;
  return (
    <Modal open title="New one-time password" onClose={onClose}>
      <div className="space-y-3 text-sm">
        <p>Give these to the customer (for example on WhatsApp or by phone). They must choose their own password when they sign in. This is shown only once.</p>
        <pre className="select-all whitespace-pre-wrap rounded-lg bg-[var(--surface-2)] p-3 font-mono text-sm">{text}</pre>
        <div className="flex gap-2"><Button size="sm" onClick={() => void navigator.clipboard?.writeText(text)}>Copy</Button><Button size="sm" variant="secondary" onClick={onClose}>Done</Button></div>
        <p className="text-xs muted">Their old password no longer works, they are signed out everywhere, and two-factor sign-in is switched off until they set it up again.</p>
      </div>
    </Modal>
  );
}

/** Reset password / block / unblock buttons for one customer account. */
function AccountActions({ user, onDone }: { user: { id: string; name: string; is_disabled: number | boolean }; onDone: () => void }) {
  const toast = useToast();
  const [result, setResult] = useState<{ sign_in_id: string; email: string; temporary_password: string } | null>(null);
  const reset = async () => {
    if (!confirm(`Create a new one-time password for ${user.name}? Their current password stops working.`)) return;
    try { setResult(await api.post(`/api/billing/vendor/users/${user.id}/temporary-password`)); onDone(); } catch (e) { toast("error", errorMessage(e)); }
  };
  const block = async (disabled: boolean) => {
    if (disabled && !confirm(`Block ${user.name} from signing in? They are signed out at once. Their data is kept.`)) return;
    try { await api.post(`/api/billing/vendor/users/${user.id}/access`, { disabled }); toast("success", disabled ? "Sign-in blocked" : "Sign-in unblocked"); onDone(); } catch (e) { toast("error", errorMessage(e)); }
  };
  return (
    <span className="inline-flex gap-1 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
      <Button size="sm" variant="secondary" onClick={() => void reset()}>Reset password</Button>
      {user.is_disabled ? <Button size="sm" variant="secondary" onClick={() => void block(false)}>Unblock</Button> : <Button size="sm" variant="secondary" onClick={() => void block(true)}>Block</Button>}
      <TempPassword result={result} onClose={() => setResult(null)} />
    </span>
  );
}

/** The billing history of every organisation, or of one. */
function History({ orgId, onOpen }: { orgId?: string; onOpen?: (id: string) => void }) {
  const [kind, setKind] = useState("");
  const { data, error } = useApi<{ events: any[] }>(`/api/billing/vendor/events?${new URLSearchParams({ ...(orgId ? { org_id: orgId } : {}), ...(kind ? { kind } : {}) })}`);
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Spinner />;
  const exportRows = () => downloadCsv("ledgerfox-billing-history", ["Date", "Organisation", "Account ID", "Event", "Details", "By"],
    data.events.map((e) => [e.created_at.replace("T", " ").slice(0, 16), e.org_name ?? e.user_email ?? "", e.org_id ?? "", EVENT[e.kind] ?? e.kind, detailText(e.details), e.actor ?? ""]));
  const count = (re: RegExp) => data.events.filter((e) => re.test(e.kind)).length;
  return (
    <Card padded={false}>
      <div className="flex flex-wrap items-end gap-3 p-4">
        {!orgId && <Field label="Show">{(id) => <Select id={id} value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">Everything</option><option value="autopay">Auto-pay</option><option value="autopay_cancel">Auto-pay cancelled</option><option value="payment">Payments</option>
          <option value="trial">Trials</option><option value="free_access">Free access</option><option value="suspended">Paused</option><option value="password">Password resets</option>
        </Select>}</Field>}
        <span className="flex-1 text-sm muted">{data.events.length} events · auto-pay set up {count(/^autopay_start/)} · approved {count(/^autopay_(approved|authenticated)/)} · cancelled {count(/^autopay_cancel/)} · payments {count(/^payment$/)}</span>
        <DownloadButtons size="sm" onDownload={exportRows} />
      </div>
      <TableWrap><table className="table text-sm">
        <thead><tr><th>When</th>{!orgId && <th>Organisation</th>}<th>What happened</th><th>Details</th><th>By</th></tr></thead>
        <tbody>{data.events.map((e) => (
          <tr key={e.id} className={onOpen && e.org_id ? "cursor-pointer hover:bg-[var(--surface-2)]" : ""} onClick={() => onOpen && e.org_id && onOpen(e.org_id)}>
            <td className="whitespace-nowrap">{e.created_at.replace("T", " ").slice(0, 16)}</td>{!orgId && <td>{e.org_name ?? e.user_email ?? "—"}</td>}
            <td><Badge color={eventColor(e.kind)}>{EVENT[e.kind] ?? e.kind}</Badge></td><td className="text-xs">{detailText(e.details)}</td><td className="text-xs muted">{e.actor ?? ""}</td></tr>
        ))}</tbody>
      </table></TableWrap>
      {!data.events.length && <p className="p-4 text-sm muted">Nothing yet.</p>}
    </Card>
  );
}

export function VendorPanel() {
  const [tab, setTab] = useState<TabId>("overview");
  const [openOrg, setOpenOrg] = useState<string | null>(null);
  const probe = useApi<any>("/api/billing/vendor/overview");
  if (probe.error) return <div className="mx-auto max-w-xl p-8"><Alert>{probe.error}</Alert><p className="mt-3 text-sm muted">This page is for LedgerFox's own staff (VENDOR_ADMIN_EMAILS).</p></div>;
  if (!probe.data) return <Spinner />;
  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <div className="mb-4 flex items-center justify-between"><Link to="/app"><Wordmark iconClass="h-7 w-7" /></Link><Link className="text-sm text-brand-700 hover:underline dark:text-brand-300" to="/app">Back to the app</Link></div>
      <PageHeader title="Admin panel" subtitle={probe.data.enabled ? "Subscriptions are on." : "Subscriptions are off (BILLING_ENABLED) — nobody is limited."} />
      <Tabs<TabId> value={tab} onChange={setTab} tabs={[
        { value: "overview", label: "Overview" }, { value: "orgs", label: "Organisations" }, { value: "users", label: "Accounts" },
        { value: "payments", label: "Payments" }, { value: "history", label: "Billing history" }, { value: "setup", label: "Set-up & promotions" },
      ]} />
      <div className="mt-4">
        {tab === "overview" && <Overview data={probe.data} onOpen={setOpenOrg} />}
        {tab === "orgs" && <Organisations onOpen={setOpenOrg} />}
        {tab === "users" && <Accounts />}
        {tab === "payments" && <Payments onOpen={setOpenOrg} />}
        {tab === "history" && <History onOpen={setOpenOrg} />}
        {tab === "setup" && <><SetupCheck /><PromotionsAdmin /></>}
      </div>
      {openOrg && <OrgDetail id={openOrg} onClose={() => setOpenOrg(null)} />}
    </div>
  );
}

function Overview({ data, onOpen }: { data: any; onOpen: (id: string) => void }) {
  const t = data.totals, st = data.statuses ?? {};
  const max = Math.max(1, ...data.daily.map((d: any) => d.n));
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Organisations" value={t.organisations} sub={`${t.companies} companies · ${t.users} accounts`} />
        <Stat label="Paying" value={(st.active ?? 0) + (st.grace ?? 0)} sub={`${st.grace ?? 0} with payment due · ${t.autopay_active} on auto-pay`} tone="good" />
        <Stat label="Free trial / Free plan" value={`${st.trial ?? 0} / ${st.free ?? 0}`} />
        <Stat label="Revenue (before GST)" value={inr(t.revenue_30d)} sub={`last 30 days · ${inr(t.revenue_total)} all time · ${t.payments} payments${(data.revenue_foreign ?? []).map((f: any) => ` · ${inr(f.total, f.currency)} international`).join("")}`} />
        <Stat label="New sign-ups" value={t.signups_7d} sub={`last 7 days · ${t.signups_30d} in 30 days`} />
        <Stat label="Active accounts" value={t.active_7d} sub={`signed in within 7 days · ${t.active_30d} within 30`} />
        <Stat label="Documents created" value={t.documents} sub="invoices, bills, quotes… across all customers" />
      </div>
      <Card title="New organisations, last 30 days">
        {data.daily.length ? (
          <div className="flex h-32 items-end gap-1" aria-label="New organisations per day">
            {data.daily.map((d: any) => <div key={d.day} title={`${day(d.day)}: ${d.n}`} className="flex-1 rounded-t bg-brand-500" style={{ height: `${(d.n / max) * 100}%`, minHeight: 4 }} />)}
          </div>
        ) : <p className="text-sm muted">No sign-ups in the last 30 days.</p>}
      </Card>
      <Card title="Latest organisations" padded={false}>
        <TableWrap><table className="table text-sm"><thead><tr><th>Organisation</th><th>Owner</th><th>Signed up</th></tr></thead>
          <tbody>{data.recent.map((o: any) => (
            <tr key={o.id} className="cursor-pointer hover:bg-[var(--surface-2)]" onClick={() => onOpen(o.id)}><td className="font-medium">{o.name}</td><td>{o.owner_name}<span className="block text-xs muted">{o.owner_email}</span></td><td>{day(o.created_at)}</td></tr>
          ))}</tbody></table></TableWrap>
      </Card>
    </div>
  );
}

function Organisations({ onOpen }: { onOpen: (id: string) => void }) {
  const { data, error } = useApi<{ organisations: any[] }>("/api/billing/vendor/orgs");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const rows = useMemo(() => (data?.organisations ?? []).filter((o) =>
    (!status || (status === "paused" ? Boolean(o.suspended_at) : o.subscription.status === status || (status === "autopay" && o.autopay_status === "active"))) &&
    (!q || `${o.name} ${o.owner_name} ${o.owner_email} ${o.phone ?? ""} ${o.city ?? ""} ${o.id}`.toLowerCase().includes(q.toLowerCase()))), [data, q, status]);
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Spinner />;
  const exportRows = () => downloadCsv("ledgerfox-organisations", ["Organisation", "Account ID", "Owner", "Owner email", "Phone", "City", "Signed up", "Last sign-in", "Users", "Companies", "Documents", "Status", "Plan", "Trial ends", "Paid until", "Auto-pay", "Subscription ID", "Revenue (₹)"],
    rows.map((o) => [o.name, o.id, o.owner_name, o.owner_email, o.phone, o.city, o.created_at.slice(0, 10), o.last_login_at?.slice(0, 10) ?? "", o.users, o.companies, o.documents, STATUS[o.subscription.status]?.[0] ?? o.subscription.status,
      o.subscription.plan, o.subscription.trial_ends_at?.slice(0, 10) ?? "", o.subscription.paid_until?.slice(0, 10) ?? "", AUTOPAY[o.autopay_status] ?? "", o.autopay_id ?? "", (o.revenue / 100).toFixed(2)]));
  return (
    <Card padded={false}>
      <div className="flex flex-wrap items-end gap-3 p-4">
        <Field label="Search">{(id) => <Input id={id} placeholder="Name, email, phone, city or account ID" value={q} onChange={(e) => setQ(e.target.value)} />}</Field>
        <Field label="Status">{(id) => <Select id={id} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All</option><option value="trial">Free trial</option><option value="active">Paying</option><option value="grace">Payment due</option><option value="free">Ended — renew</option><option value="autopay">Auto-pay on</option><option value="paused">Paused</option>
        </Select>}</Field>
        <span className="flex-1 text-sm muted">{rows.length} of {data.organisations.length}</span>
        <DownloadButtons size="sm" onDownload={exportRows} />
      </div>
      <TableWrap><table className="table text-sm">
        <thead><tr><th>Organisation</th><th>Owner</th><th>Signed up</th><th>Last sign-in</th><th className="num">Users</th><th className="num">Docs</th><th>Status</th><th>Until</th><th>Auto-pay</th><th className="num">Revenue</th></tr></thead>
        <tbody>{rows.map((o) => {
          const [label, color] = STATUS[o.subscription.status] ?? [o.subscription.status, "gray"];
          return (
            <tr key={o.id} className="cursor-pointer hover:bg-[var(--surface-2)]" onClick={() => onOpen(o.id)}>
              <td className="font-medium">{o.name}<span className="block text-xs muted">{o.companies} compan{o.companies === 1 ? "y" : "ies"}{o.city ? ` · ${o.city}` : ""}</span></td>
              <td>{o.owner_name}<span className="block text-xs muted">{o.owner_email}{o.phone ? ` · ${o.phone}` : ""}</span></td>
              <td>{day(o.created_at)}</td><td>{ago(o.last_login_at)}</td><td className="num">{o.users}</td><td className="num">{o.documents}</td>
              <td>{o.suspended_at ? <Badge color="red">Paused</Badge> : <Badge color={color}>{label}</Badge>}<span className="block text-xs muted">{o.subscription.plan}</span></td>
              <td>{day(o.subscription.paid_until ?? o.subscription.trial_ends_at)}</td>
              <td>{AUTOPAY[o.autopay_status] ?? "—"}{o.autopay_cancellations > 0 && <span className="block text-xs text-red-700 dark:text-red-300">cancelled {o.autopay_cancellations}×</span>}</td><td className="num">{inr(o.revenue, o.revenue_currency)}</td>
            </tr>
          );
        })}</tbody>
      </table></TableWrap>
    </Card>
  );
}

function Accounts() {
  const { data, error, reload } = useApi<{ users: any[] }>("/api/billing/vendor/users");
  const [q, setQ] = useState("");
  const rows = useMemo(() => (data?.users ?? []).filter((u) => !q || `${u.name} ${u.email} ${u.username ?? ""} ${u.organisations ?? ""}`.toLowerCase().includes(q.toLowerCase())), [data, q]);
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Spinner />;
  const exportRows = () => downloadCsv("ledgerfox-accounts", ["Name", "Email", "Username", "Organisations (role)", "Created", "Last sign-in", "Sign-ins", "Email confirmed", "Two-factor", "Disabled"],
    rows.map((u) => [u.name, u.email.endsWith(".ledgerfox.local") ? "" : u.email, u.username ?? "", u.organisations ?? "", u.created_at.slice(0, 10), u.last_login_at?.slice(0, 10) ?? "", u.login_count, u.email_verified_at ? "yes" : "no", u.totp_enabled ? "yes" : "no", u.is_disabled ? "yes" : "no"]));
  return (
    <Card padded={false}>
      <div className="flex flex-wrap items-end gap-3 p-4">
        <Field label="Search">{(id) => <Input id={id} placeholder="Name, email, username or organisation" value={q} onChange={(e) => setQ(e.target.value)} />}</Field>
        <span className="flex-1 text-sm muted">{rows.length} of {data.users.length} accounts · passwords are stored only as one-way hashes, so they can't be shown — use Reset password</span>
        <DownloadButtons size="sm" onDownload={exportRows} />
      </div>
      <TableWrap><table className="table text-sm">
        <thead><tr><th>Name</th><th>Sign-in ID (email / username)</th><th>Organisations</th><th>Created</th><th>Last sign-in</th><th className="num">Sign-ins</th><th>Checks</th><th /></tr></thead>
        <tbody>{rows.map((u) => (
          <tr key={u.id}><td className="font-medium">{u.name}</td>
            <td>{u.email.endsWith(".ledgerfox.local") ? <span className="muted">staff login</span> : u.email}{u.username && <span className="block text-xs muted">@{u.username}</span>}</td>
            <td className="text-xs">{u.organisations ?? "—"}</td><td>{day(u.created_at)}</td><td>{ago(u.last_login_at)}</td><td className="num">{u.login_count}</td>
            <td className="space-x-1 whitespace-nowrap">{u.email_verified_at && <Badge color="green">email ✓</Badge>}{u.totp_enabled ? <Badge color="blue">2FA</Badge> : null}{u.is_disabled ? <Badge color="red">blocked</Badge> : null}{u.one_time_login ? <Badge color="amber">one-time password</Badge> : null}</td>
            <td><AccountActions user={u} onDone={reload} /></td></tr>
        ))}</tbody>
      </table></TableWrap>
    </Card>
  );
}

function Payments({ onOpen }: { onOpen: (id: string) => void }) {
  const { data, error } = useApi<{ payments: any[] }>("/api/billing/vendor/payments");
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Spinner />;
  const exportRows = () => downloadCsv("ledgerfox-payments", ["Date", "Invoice", "Organisation", "Account ID", "Plan", "Period", "Amount (₹)", "GST (₹)", "Total (₹)", "Method", "Status", "Payment ID", "Order ID", "Subscription ID", "Period start", "Period end"],
    data.payments.map((p) => [(p.paid_at ?? p.created_at).slice(0, 10), p.invoice_number ?? "", p.org_name, p.org_id, p.plan, p.billing_interval, (p.amount / 100).toFixed(2), (p.gst / 100).toFixed(2), (p.total / 100).toFixed(2),
      p.provider === "manual" ? "bank transfer" : p.provider_subscription_id ? "Razorpay auto-pay" : "Razorpay", p.status, p.provider_payment_id ?? "", p.provider_order_id ?? "", p.provider_subscription_id ?? "", p.period_start?.slice(0, 10) ?? "", p.period_end?.slice(0, 10) ?? ""]));
  return (
    <Card padded={false}>
      <div className="flex items-center justify-between p-4"><span className="text-sm muted">{data.payments.length} payments (paid, and checkouts not completed)</span><DownloadButtons size="sm" onDownload={exportRows} /></div>
      <TableWrap><table className="table text-sm">
        <thead><tr><th>Date</th><th>Invoice</th><th>Organisation</th><th>Plan</th><th className="num">Total</th><th>Method</th><th>Status</th><th>Payment ID</th></tr></thead>
        <tbody>{data.payments.map((p) => (
          <tr key={p.id} className="cursor-pointer hover:bg-[var(--surface-2)]" onClick={() => onOpen(p.org_id)}>
            <td>{day(p.paid_at ?? p.created_at)}</td><td>{p.invoice_number ?? "—"}</td><td>{p.org_name}</td><td>{p.plan} ({p.billing_interval})</td><td className="num">{inr(p.total, p.currency)}</td>
            <td>{p.provider === "manual" ? "Bank transfer" : p.provider_subscription_id ? "Auto-pay" : "Razorpay"}</td>
            <td><Badge color={p.status === "paid" ? "green" : "gray"}>{p.status === "paid" ? "Paid" : "Not completed"}</Badge></td>
            <td className="font-mono text-xs">{p.provider_payment_id ?? "—"}</td></tr>
        ))}</tbody>
      </table></TableWrap>
    </Card>
  );
}

function OrgDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const toast = useToast();
  const { data, error, reload } = useApi<any>(`/api/billing/vendor/orgs/${id}/detail`);
  const [act, setAct] = useState<{ plan: string; interval: Interval; note: string } | null>(null);
  const [free, setFree] = useState<{ plan: string; months: string; note: string } | null>(null);
  const post = async (path: string, payload: unknown, done: string) => {
    try { await api.post(`/api/billing/vendor/orgs/${id}/${path}`, payload); toast("success", done); reload(); } catch (e) { toast("error", errorMessage(e)); }
  };
  const giveFree = async () => {
    if (!free) return;
    await post("free-access", { plan: free.plan, months: Number(free.months), note: free.note || null }, "Free access given");
    setFree(null);
  };
  const pause = async () => {
    const reason = prompt("Why is access paused? (kept in the history; the customer is told to contact info@niyazio.com)");
    if (reason) await post("suspend", { reason }, "Access paused");
  };
  const endPlan = async () => {
    if (confirm("End this organisation's plan or trial now? They will be asked to renew (they can still view and export). Auto-pay is not cancelled.")) await post("end-plan", {}, "Plan ended");
  };
  const extend = async () => {
    const d = Number(prompt("Extend the free trial by how many days?", "14"));
    if (!d) return;
    try { await api.post(`/api/billing/vendor/orgs/${id}/trial`, { days: d }); toast("success", "Trial extended"); reload(); } catch (e) { toast("error", errorMessage(e)); }
  };
  const activate = async () => {
    if (!act) return;
    try { await api.post(`/api/billing/vendor/orgs/${id}/activate`, { plan: act.plan, interval: act.interval, note: act.note || null }); setAct(null); toast("success", "Plan activated and invoice issued"); reload(); }
    catch (e) { toast("error", errorMessage(e)); }
  };
  return (
    <Modal open title={data?.organisation.name ?? "Organisation"} onClose={onClose}>
      {error ? <Alert>{error}</Alert> : !data ? <Spinner /> : (
        <div className="space-y-4 text-sm">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="muted">Account ID</dt><dd className="select-all font-mono text-xs">{id}</dd>
            <dt className="muted">Owner</dt><dd>{data.organisation.owner_name} · {data.organisation.owner_email}</dd>
            <dt className="muted">Signed up</dt><dd>{day(data.organisation.created_at)}</dd>
            <dt className="muted">Subscription</dt><dd><Badge color={STATUS[data.subscription.status]?.[1] ?? "gray"}>{STATUS[data.subscription.status]?.[0] ?? data.subscription.status}</Badge> {data.subscription.plan}
              {data.subscription.trial_ends_at && <> · trial until {day(data.subscription.trial_ends_at)}</>}{data.subscription.paid_until && <> · paid until {day(data.subscription.paid_until)}</>}</dd>
            <dt className="muted">Auto-pay</dt><dd>{AUTOPAY[data.subscription_row?.autopay_status] ?? "—"}{data.subscription_row?.autopay_id && <span className="ml-2 select-all font-mono text-xs">{data.subscription_row.autopay_id}</span>}
              {data.subscription_row?.autopay_total ? ` · ${inr(data.subscription_row.autopay_total, data.subscription_row.autopay_currency)} ${data.subscription_row.autopay_interval} (${data.subscription_row.autopay_plan})` : ""}</dd>
          </dl>
          {data.organisation.suspended_at && <Alert>Access paused on {day(data.organisation.suspended_at)}: {data.organisation.suspended_reason}</Alert>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => void extend()}>Extend trial</Button>
            <Button size="sm" variant="secondary" onClick={() => setAct({ plan: "business", interval: "yearly", note: "" })}>Record cash / bank payment</Button>
            <Button size="sm" variant="secondary" onClick={() => setFree({ plan: "business", months: "1", note: "" })}>Give free access</Button>
            <Button size="sm" variant="secondary" onClick={() => void endPlan()}>End plan now</Button>
            {data.organisation.suspended_at
              ? <Button size="sm" onClick={() => void post("unsuspend", {}, "Access resumed")}>Resume access</Button>
              : <Button size="sm" variant="danger" onClick={() => void pause()}>Pause access</Button>}
          </div>
          {free && (
            <div className="flex flex-wrap items-end gap-2 rounded-lg border border-[var(--border)] p-3">
              <Field label="Plan">{(fid) => <Select id={fid} value={free.plan} onChange={(e) => setFree({ ...free, plan: e.target.value })}>{PAID_PLANS.map((p) => <option key={p}>{p}</option>)}</Select>}</Field>
              <Field label="Months">{(fid) => <Input id={fid} type="number" min={1} max={36} value={free.months} onChange={(e) => setFree({ ...free, months: e.target.value })} />}</Field>
              <Field label="Note">{(fid) => <Input id={fid} value={free.note} placeholder="e.g. partner, cash received" onChange={(e) => setFree({ ...free, note: e.target.value })} />}</Field>
              <Button size="sm" onClick={() => void giveFree()}>Give free access</Button><Button size="sm" variant="secondary" onClick={() => setFree(null)}>Cancel</Button>
            </div>
          )}
          {act && (
            <div className="flex flex-wrap items-end gap-2 rounded-lg border border-[var(--border)] p-3">
              <Field label="Plan">{(fid) => <Select id={fid} value={act.plan} onChange={(e) => setAct({ ...act, plan: e.target.value })}>{PAID_PLANS.map((p) => <option key={p}>{p}</option>)}</Select>}</Field>
              <Field label="Period">{(fid) => <Select id={fid} value={act.interval} onChange={(e) => setAct({ ...act, interval: e.target.value as Interval })}><option value="monthly">1 month</option><option value="yearly">1 year</option></Select>}</Field>
              <Field label="Note (UTR)">{(fid) => <Input id={fid} value={act.note} onChange={(e) => setAct({ ...act, note: e.target.value })} />}</Field>
              <Button size="sm" onClick={() => void activate()}>Activate</Button><Button size="sm" variant="secondary" onClick={() => setAct(null)}>Cancel</Button>
            </div>
          )}
          <section><h3 className="mb-1 font-semibold">People ({data.members.length})</h3>
            <TableWrap><table className="table text-xs"><thead><tr><th>Name</th><th>Sign-in ID</th><th>Role</th><th>Last sign-in</th><th className="num">Sign-ins</th><th /></tr></thead>
              <tbody>{data.members.map((m: any) => <tr key={m.id}><td>{m.name}{m.is_disabled ? " (blocked)" : ""}</td><td>{m.email.endsWith(".ledgerfox.local") ? m.username : m.email}{m.username && !m.email.endsWith(".ledgerfox.local") ? <span className="block muted">{m.username}</span> : null}{m.email_verified_at ? " ✓" : ""}</td><td>{m.role}</td><td>{ago(m.last_login_at)}</td><td className="num">{m.login_count}</td>
                <td><AccountActions user={m} onDone={reload} /></td></tr>)}</tbody></table></TableWrap>
          </section>
          <section><h3 className="mb-1 font-semibold">Companies ({data.companies.length})</h3>
            <TableWrap><table className="table text-xs"><thead><tr><th>Company</th><th>GSTIN / place</th><th>Contact</th><th className="num">Docs</th><th className="num">Customers / suppliers</th><th className="num">Products</th><th>Last activity</th></tr></thead>
              <tbody>{data.companies.map((co: any) => <tr key={co.id}><td>{co.name}{co.is_demo ? " (demo)" : ""}{co.is_practice ? " · education" : ""}<span className="block muted">{co.business_type}</span></td><td>{co.tax_id ?? "—"}<span className="block muted">{[co.city, co.state_code].filter(Boolean).join(" · ")}</span></td>
                <td>{co.phone ?? ""}<span className="block muted">{co.email ?? ""}</span></td><td className="num">{co.documents}</td><td className="num">{co.contacts}</td><td className="num">{co.items}</td><td>{ago(co.last_activity)}</td></tr>)}</tbody></table></TableWrap>
          </section>
          <section><h3 className="mb-1 font-semibold">Payments ({data.payments.length})</h3>
            {data.payments.length ? <TableWrap><table className="table text-xs"><thead><tr><th>Date</th><th>Invoice</th><th>Plan</th><th className="num">Total</th><th>Status</th><th>Payment ID</th></tr></thead>
              <tbody>{data.payments.map((p: any) => <tr key={p.id}><td>{day(p.paid_at ?? p.created_at)}</td><td>{p.invoice_number ? <Link className="text-brand-700 hover:underline dark:text-brand-300" to={`/billing/${id}/invoice/${p.id}`} target="_blank">{p.invoice_number}</Link> : "—"}</td>
                <td>{p.plan} ({p.billing_interval})</td><td className="num">{inr(p.total, p.currency)}</td><td>{p.status}</td><td className="font-mono">{p.provider_payment_id ?? "—"}</td></tr>)}</tbody></table></TableWrap> : <p className="muted">None yet.</p>}
          </section>
          {data.devices?.length > 0 && <section><h3 className="mb-1 font-semibold">Desktop computers ({data.devices.length})</h3>
            <TableWrap><table className="table text-xs"><thead><tr><th>Computer</th><th>Connected by</th><th>Since</th><th>Last check</th><th>Status</th></tr></thead>
              <tbody>{data.devices.map((d: any) => <tr key={d.id}><td>{d.device_name ?? "—"}</td><td>{d.email}</td><td>{day(d.created_at)}</td><td>{ago(d.last_seen_at)}</td><td>{d.revoked_at ? "Disconnected" : "Connected"}</td></tr>)}</tbody></table></TableWrap>
          </section>}
          <section><h3 className="mb-1 font-semibold">Billing history</h3><History orgId={id} /></section>
          {data.notices.length > 0 && <section><h3 className="mb-1 font-semibold">Emails sent</h3><ul className="text-xs muted">{data.notices.map((n: any) => <li key={n.notice_key}>{day(n.sent_at)} — {n.notice_key}</li>)}</ul></section>}
        </div>
      )}
    </Modal>
  );
}
