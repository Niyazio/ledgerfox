import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { CheckCircle2 } from "lucide-react";
import { useApi } from "../lib/hooks";
import { api, ApiError, errorMessage } from "../lib/api";
import { useCompany } from "../lib/company";
import { fmtDate } from "../lib/format";
import { Alert, Badge, Button, Card, Field, Input, Select, Spinner, useToast } from "../components/ui";
import { FEATURE_LABELS, PLANS, TRIAL_DAYS, type PlanId } from "@shared/plans";

export interface LicenceState {
  connected: boolean; plan: PlanId; status: "trial" | "active" | "grace" | "free";
  reason: "not_connected" | "ok" | "plan_ended" | "check_overdue" | "invalid" | "autopay_required";
  org_name: string | null; email: string | null; plan_until: string | null; check_by: string | null;
  last_checked_at: string | null; last_error: string | null; server: string; offline_days: number;
}

const STATUS: Record<string, [string, "green" | "blue" | "amber" | "gray"]> = {
  trial: ["Free trial", "blue"], active: ["Active", "green"], grace: ["Payment due", "amber"], free: ["Renew to continue", "amber"],
};
/** Tell the reminder bar that the licence changed (connect, check now, disconnect). */
const changed = () => window.dispatchEvent(new Event("ledgerfox-licence"));
const day = (iso: string | null) => (iso ? fmtDate(iso.slice(0, 10)) : "—");

/** What a licence state means for the person at the desk, in one sentence. */
export function licenceMessage(l: LicenceState) {
  if (l.reason === "not_connected") return `Sign in to your LedgerFox account to continue. New accounts get a ${TRIAL_DAYS}-day free trial. Until then you can view and export, but not add entries.`;
  if (l.reason === "check_overdue") return `Connect to the internet so this computer can check your plan (needed at least every ${l.offline_days} days), then click “Check now”. Until then you can view and export, but not add entries.`;
  if (l.reason === "autopay_required") return `Start your ${TRIAL_DAYS}-day free trial: set up auto-pay on the LedgerFox website (₹5 check, refunded; nothing is charged until the trial ends), then click “Check now”.`;
  if (l.reason === "plan_ended") return "Your trial or plan has ended. Renew on the LedgerFox website, then click “Check now” to continue adding entries. Your data is safe.";
  if (l.reason === "invalid") return "The licence on this computer could not be verified. Connect your LedgerFox account again.";
  return null;
}

/** Desktop app → Settings → Plan & billing: connect this computer to the customer's LedgerFox account. */
export function DesktopPlanTab() {
  const toast = useToast();
  const { settings } = useCompany();
  const { data, error, setData } = useApi<LicenceState>("/api/desktop/licence");
  const usage = useApi<any>(settings ? `/api/billing/org/${settings.company.org_id}` : null);
  const [form, setForm] = useState({ login: "", password: "", totp: "", org_id: "" });
  const [orgs, setOrgs] = useState<{ id: string; name: string }[] | null>(null);
  const [needCode, setNeedCode] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Spinner />;
  const plan = PLANS[data.plan];
  const [label, color] = STATUS[data.status];
  const note = licenceMessage(data);
  const buy = `${data.server}/app`;

  const connect = async (e: FormEvent) => {
    e.preventDefault();
    setBusy("connect"); setProblem(null);
    try {
      const r = await api.post<LicenceState>("/api/desktop/licence/connect", { login: form.login, password: form.password, totp: form.totp || undefined, org_id: form.org_id || undefined });
      setData(r); changed(); setForm({ login: "", password: "", totp: "", org_id: "" }); setOrgs(null); setNeedCode(false);
      toast("success", "This computer is connected to your LedgerFox account");
      usage.reload();
    } catch (err) {
      if (err instanceof ApiError && err.code === "CHOOSE_ORG") { setOrgs((err.details as any)?.organisations ?? []); setProblem("Choose the organisation this computer belongs to, then connect again."); }
      else if (err instanceof ApiError && err.code === "TOTP_REQUIRED") { setNeedCode(true); setProblem(err.message); }
      else setProblem(errorMessage(err));
    } finally { setBusy(null); }
  };

  return (
    <div className="space-y-4">
      <Card title="Plan on this computer">
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-xl font-semibold">{plan.name}</p><Badge color={color}>{label}</Badge>
          {data.status === "trial" && <span className="text-sm muted">until {day(data.plan_until)}: every feature of the {PLANS.business.name} plan.</span>}
          {(data.status === "active" || data.status === "grace") && <span className="text-sm muted">valid until {day(data.plan_until)}</span>}
        </div>
        {note && <Alert kind="info" className="mt-3">{note}</Alert>}
        {usage.data && <p className="mt-3 text-sm">Using {usage.data.usage.users} of {plan.limits.users} users · {usage.data.usage.companies} of {plan.limits.companies} companies · up to {usage.data.usage.branches} of {plan.limits.branches} branches per company</p>}
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {(Object.keys(FEATURE_LABELS) as (keyof typeof FEATURE_LABELS)[]).map((f) => (
            <li key={f} className={plan.features.includes(f) ? "" : "muted line-through"}><CheckCircle2 className={`mr-1 inline h-3.5 w-3.5 ${plan.features.includes(f) ? "text-emerald-600" : "text-slate-400"}`} />{FEATURE_LABELS[f]}</li>
          ))}
        </ul>
        <p className="mt-3 text-xs muted">Your data always stays on this computer. Billing, accounts, reports and exports work on every plan; nothing is ever locked or deleted.</p>
      </Card>

      {data.connected ? (
        <Card title="LedgerFox account">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="muted">Account</dt><dd>{data.email ?? "—"}</dd>
            <dt className="muted">Organisation</dt><dd>{data.org_name ?? "—"}</dd>
            <dt className="muted">Last checked</dt><dd>{data.last_checked_at ? new Date(data.last_checked_at).toLocaleString() : "—"}</dd>
            <dt className="muted">Next check needed by</dt><dd>{day(data.check_by)} <span className="muted">(checked automatically when online)</span></dd>
          </dl>
          {data.last_error && <Alert className="mt-3">Last check failed: {data.last_error}</Alert>}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button loading={busy === "refresh"} onClick={async () => { setBusy("refresh"); try { setData(await api.post<LicenceState>("/api/desktop/licence/refresh")); changed(); usage.reload(); } catch (e) { toast("error", errorMessage(e)); } finally { setBusy(null); } }}>Check now</Button>
            <a className="inline-flex items-center rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-medium hover:bg-[var(--surface-2)]" href={buy} target="_blank" rel="noreferrer">Buy or manage plan online</a>
            <Button variant="ghost" loading={busy === "disconnect"} onClick={async () => {
              if (!confirm("Disconnect this computer? You will not be able to add entries until you connect again. Your data stays on this computer.")) return;
              setBusy("disconnect"); try { setData(await api.post<LicenceState>("/api/desktop/licence/disconnect")); changed(); usage.reload(); } catch (e) { toast("error", errorMessage(e)); } finally { setBusy(null); }
            }}>Disconnect</Button>
          </div>
        </Card>
      ) : (
        <Card title="Connect your LedgerFox account">
          <p className="mb-3 text-sm">Sign in with the account you use on <a className="underline" href={buy} target="_blank" rel="noreferrer">ledgerfox.niyazio.com</a>. One subscription covers the website and your computers.</p>
          <div className="mb-4 rounded-lg border border-brand-200 bg-brand-50 p-3 text-sm dark:border-brand-900 dark:bg-brand-950/30">
            <p className="font-medium">New to LedgerFox? Start your {TRIAL_DAYS}-day free trial</p>
            <ol className="mt-1 list-decimal space-y-0.5 pl-5">
              <li>Create your free account and company on the website.</li>
              <li>Set up auto-pay there: Razorpay takes ₹5 to check it and refunds it; nothing is charged until the trial ends.</li>
              <li>Come back here and connect this computer with the same email and password.</li>
            </ol>
            <a className="mt-2 inline-flex rounded-lg bg-brand-700 px-3 py-1.5 font-medium text-white hover:bg-brand-800" href={`${data.server}/register`} target="_blank" rel="noreferrer">Create free account</a>
          </div>
          <form onSubmit={connect} className="grid gap-3 sm:grid-cols-2">
            {problem && <Alert className="sm:col-span-2">{problem}</Alert>}
            <Field label="Email or username">{(id) => <Input id={id} required autoComplete="username" value={form.login} onChange={(e) => setForm({ ...form, login: e.target.value })} />}</Field>
            <Field label="Password">{(id) => <Input id={id} type="password" required autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />}</Field>
            {needCode && <Field label="Two-factor code">{(id) => <Input id={id} inputMode="numeric" autoComplete="one-time-code" value={form.totp} onChange={(e) => setForm({ ...form, totp: e.target.value })} />}</Field>}
            {orgs && <Field label="Organisation">{(id) => <Select id={id} required value={form.org_id} onChange={(e) => setForm({ ...form, org_id: e.target.value })}><option value="">Choose…</option>{orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select>}</Field>}
            <div className="sm:col-span-2 flex flex-wrap items-center gap-3">
              <Button type="submit" loading={busy === "connect"}>Connect this computer</Button>
              <span className="text-xs muted">Needs internet once; afterwards your plan is checked automatically (at least every {data.offline_days} days).</span>
            </div>
          </form>
        </Card>
      )}
      <p className="text-xs muted">Questions? Write to info@niyazio.com.</p>
    </div>
  );
}

/** Thin bar in the desktop app while the plan needs renewing (or connecting) or the trial is about to end. */
export function DesktopLicenceBanner() {
  const { id } = useCompany();
  const { data, reload } = useApi<LicenceState>("/api/desktop/licence");
  useEffect(() => {
    const on = () => void reload();
    window.addEventListener("ledgerfox-licence", on);
    return () => window.removeEventListener("ledgerfox-licence", on);
  }, [reload]);
  if (!data) return null;
  const note = licenceMessage(data);
  const soon = data.status === "trial" && data.plan_until && Date.parse(data.plan_until) - Date.now() < 3 * 86_400_000;
  if (!note && !soon) return null;
  return (
    <div className="no-print border-b border-amber-300 bg-amber-50 px-4 py-1.5 text-center text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
      {note ?? `Your free trial ends on ${day(data.plan_until)}. Choose a plan on the LedgerFox website to keep every feature.`}{" "}
      <Link className="font-medium underline" to={`/app/${id}/settings?tab=billing`}>Plan & billing</Link>
    </div>
  );
}
