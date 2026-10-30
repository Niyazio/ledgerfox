import { useState, type FormEvent } from "react";
import { Navigate, useNavigate, Link } from "react-router";
import { api } from "../lib/api";
import { useAction } from "../lib/hooks";
import { useSession } from "../lib/session";
import { Alert, Button, Card, Field, Input, Select, Spinner, useToast } from "../components/ui";
import { Wordmark } from "../components/Layout";
import { INDIA_STATES } from "@shared/tax";
import { CURRENCY_OPTIONS } from "../components/pickers";
import { BUSINESS_TYPES } from "@shared/industries";
import { createDemoCompany } from "../lib/demo";
import { BrandingFields, type BrandingValue } from "../components/Branding";
import { errorMessage } from "../lib/api";

const COUNTRIES: [string, string, string, number][] = [
  ["IN", "India", "INR", 4], ["AE", "United Arab Emirates", "AED", 1], ["SA", "Saudi Arabia", "SAR", 1], ["US", "United States", "USD", 1],
  ["GB", "United Kingdom", "GBP", 4], ["SG", "Singapore", "SGD", 1], ["AU", "Australia", "AUD", 7], ["CA", "Canada", "CAD", 1],
  ["NP", "Nepal", "NPR", 7], ["LK", "Sri Lanka", "LKR", 4], ["BD", "Bangladesh", "BDT", 7], ["MY", "Malaysia", "MYR", 1],
  ["KE", "Kenya", "KES", 7], ["ZA", "South Africa", "ZAR", 3], ["DE", "Germany", "EUR", 1], ["QA", "Qatar", "QAR", 1],
];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function CompanyForm({ onSubmit, busy, withOrg }: { onSubmit: (v: any, branding: BrandingValue) => void; busy: boolean; withOrg?: boolean }) {
  const [branding, setBranding] = useState<BrandingValue>({});
  const [v, setV] = useState({ practice: false, org: "", upi_id: "", business_type: "general", name: "", legal_name: "", country: "IN", base_currency: "INR", fiscal_year_start_month: 4, state_code: "", tax_id: "", address: "", city: "", postal_code: "", phone: "", email: "" });
  const set = (k: string, val: unknown) => setV((p) => ({ ...p, [k]: val }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const company = { name: v.name, legal_name: v.legal_name || null, country: v.country, base_currency: v.base_currency, fiscal_year_start_month: Number(v.fiscal_year_start_month),
      state_code: v.state_code || null, tax_id: v.tax_id.trim().toUpperCase() || null, address: v.address || null, city: v.city || null, postal_code: v.postal_code || null, phone: v.phone || null, email: v.email || null, business_type: v.business_type, upi_id: v.upi_id.trim() || null, ...(v.practice ? { is_practice: true } : {}) };
    onSubmit(withOrg ? { name: v.org || v.name, company } : company, branding);
  };
  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
      <label className={`sm:col-span-2 flex cursor-pointer gap-3 rounded-xl border p-3 text-sm ${v.practice ? "border-orange-400 bg-orange-50 dark:border-orange-700 dark:bg-orange-950/30" : "border-[var(--border)]"}`}>
        <input type="checkbox" className="mt-1" checked={v.practice} onChange={(e) => set("practice", e.target.checked)} />
        <span><b>Practice company (education mode)</b> — for students, trainees and beginners. Free forever with every feature. Like Tally's educational mode, entries can be dated only the 1st, 2nd and last day of a month, printouts say "Practice", and it cannot be used for real business documents.</span>
      </label>
      {withOrg && <Field label="Organisation name" hint="Groups your companies and team. You can add more companies later." className="sm:col-span-2">{(id) => <Input id={id} value={v.org} placeholder="e.g. Sharma Group" onChange={(e) => set("org", e.target.value)} />}</Field>}
      <fieldset className="sm:col-span-2">
        <legend className="mb-2 text-sm font-medium">What kind of business is it?</legend>
        <div className="grid gap-2 sm:grid-cols-3" role="radiogroup">
          {BUSINESS_TYPES.map((b) => (
            <label key={b.key} className={`card flex cursor-pointer flex-col gap-0.5 p-3 text-sm ${v.business_type === b.key ? "border-brand-600 ring-2 ring-brand-600/20" : "hover:bg-[var(--surface-2)]"}`}>
              <input type="radio" name="business_type" value={b.key} checked={v.business_type === b.key} onChange={() => set("business_type", b.key)} className="sr-only" />
              <span className="font-medium">{b.label}</span>
              <span className="text-xs muted">{b.description}</span>
            </label>
          ))}
        </div>
        <p className="mt-2 text-xs muted">Adds matching income and expense accounts, units and a few starter items. You can edit or remove them later.</p>
      </fieldset>
      <Field label="Company name" required>{(id) => <Input id={id} required value={v.name} onChange={(e) => set("name", e.target.value)} />}</Field>
      <Field label="Legal name">{(id) => <Input id={id} value={v.legal_name} onChange={(e) => set("legal_name", e.target.value)} />}</Field>
      <Field label="Country" required hint="Determines the default tax setup and chart of accounts.">{(id) => (
        <Select id={id} value={v.country} onChange={(e) => { const c = COUNTRIES.find((x) => x[0] === e.target.value)!; setV((p) => ({ ...p, country: c[0], base_currency: c[2], fiscal_year_start_month: c[3], state_code: "", tax_id: "" })); }}>
          {COUNTRIES.map((c) => <option key={c[0]} value={c[0]}>{c[1]}</option>)}
        </Select>
      )}</Field>
      <Field label="Base currency" required hint="Cannot be changed later.">{(id) => (
        <Select id={id} value={v.base_currency} onChange={(e) => set("base_currency", e.target.value)}>{CURRENCY_OPTIONS.map((c) => <option key={c}>{c}</option>)}</Select>
      )}</Field>
      <Field label="Financial year starts in" required>{(id) => (
        <Select id={id} value={v.fiscal_year_start_month} onChange={(e) => set("fiscal_year_start_month", e.target.value)}>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</Select>
      )}</Field>
      {v.country === "IN" ? (
        <>
          <Field label="State (place of business)" hint="Decides CGST+SGST vs IGST on invoices.">{(id) => (
            <Select id={id} value={v.state_code} onChange={(e) => set("state_code", e.target.value)}>
              <option value="">Select state…</option>
              {Object.entries(INDIA_STATES).filter(([k]) => Number(k) < 90).map(([k, n]) => <option key={k} value={k}>{k} · {n}</option>)}
            </Select>
          )}</Field>
          <Field label="GSTIN" hint="Optional. Validated including the check digit.">{(id) => <Input id={id} value={v.tax_id} maxLength={15} className="font-mono uppercase" onChange={(e) => { set("tax_id", e.target.value); if (e.target.value.length >= 2 && !v.state_code) set("state_code", e.target.value.slice(0, 2)); }} />}</Field>
        </>
      ) : (
        <Field label="Tax registration number">{(id) => <Input id={id} value={v.tax_id} onChange={(e) => set("tax_id", e.target.value)} />}</Field>
      )}
      <Field label="Address" className="sm:col-span-2">{(id) => <Input id={id} value={v.address} onChange={(e) => set("address", e.target.value)} />}</Field>
      <Field label="City">{(id) => <Input id={id} value={v.city} onChange={(e) => set("city", e.target.value)} />}</Field>
      <Field label="Postal code">{(id) => <Input id={id} value={v.postal_code} onChange={(e) => set("postal_code", e.target.value)} />}</Field>
      <Field label="Phone">{(id) => <Input id={id} value={v.phone} onChange={(e) => set("phone", e.target.value)} />}</Field>
      <Field label="Email">{(id) => <Input id={id} type="email" value={v.email} onChange={(e) => set("email", e.target.value)} />}</Field>
      {v.country === "IN" && <Field label="UPI ID" hint="For the “Scan to pay” QR on invoices, e.g. business@okhdfcbank.">{(id) => <Input id={id} value={v.upi_id} placeholder="business@bank" autoCapitalize="none" onChange={(e) => set("upi_id", e.target.value)} />}</Field>}
      <div className="sm:col-span-2"><BrandingFields value={branding} onChange={setBranding} /></div>
      <div className="sm:col-span-2"><Button type="submit" loading={busy}>Create company</Button></div>
    </form>
  );
}

/** Logo and payment QR after the company exists. A failure here never undoes the sign-up: it is reported and can be redone in Settings. */
async function saveBranding(companyId: string, b: BrandingValue): Promise<string | null> {
  if (!b.logo && !b.payment_qr) return null;
  try { await api.put(`/api/c/${companyId}/settings/branding`, { logo: b.logo ?? null, payment_qr: b.payment_qr ?? null }); return null; }
  catch (e) { return `Your company is ready, but the logo / payment QR could not be saved (${errorMessage(e)}). Add it in Settings → Company.`; }
}

/** One click: a sample company of the chosen type with invoices, bills, receipts, expenses and a posted payroll. */
export function DemoLoader({ orgId }: { orgId: string | null }) {
  const { refresh } = useSession();
  const nav = useNavigate();
  const [type, setType] = useState("retail");
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <Card title="Explore with a demo company">
      <p className="text-sm muted">Creates a sample company with customers, invoices, bills, receipts, expenses and payroll so you can try every screen. Delete it any time from Settings.</p>
      {error && <Alert className="mt-3">{error}</Alert>}
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <Field label="Type of business">{(id) => <Select id={id} value={type} onChange={(e) => setType(e.target.value)}>{BUSINESS_TYPES.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}</Select>}</Field>
        <Button variant="secondary" loading={Boolean(step)} onClick={async () => {
          setError(null);
          try { const id = await createDemoCompany(orgId, type, setStep); await refresh(); nav(`/app/${id}/dashboard`); }
          catch (e) { setError(errorMessage(e)); } finally { setStep(null); }
        }}>Load demo company</Button>
        {step && <span className="text-sm muted">{step}…</span>}
      </div>
    </Card>
  );
}

/** /app — pick a company, or create the first organisation + company. */
export function AppHome() {
  const { me, loading, refresh } = useSession();
  const nav = useNavigate();
  const { busy, error, run } = useAction();
  const toast = useToast();
  if (loading) return <Spinner />;
  if (!me?.user) return <Navigate to="/login?next=/app" replace />;
  if (me.companies.length === 1 && !me.companies[0].is_demo) return <Navigate to={`/app/${me.companies[0].id}/dashboard`} replace />;
  if (me.companies.length > 1 || me.companies[0]?.is_demo) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-10">
        <div className="mb-6 text-lg"><Wordmark brand={me.brand} /></div>
        <h1 className="mb-4 text-2xl font-semibold">Choose a company</h1>
        <div className="grid gap-3 sm:grid-cols-2">
          {me.companies.map((c) => (
            <Link key={c.id} to={`/app/${c.id}/dashboard`} className="card p-4 hover:border-brand-500">
              <p className="font-medium">{c.name}{c.is_demo ? <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-800">demo</span> : null}</p><p className="text-xs muted">{c.country} · {c.base_currency}</p>
            </Link>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap gap-4 text-sm">
          <Link to="/app/clients" className="text-brand-700 hover:underline dark:text-brand-300">All clients at a glance →</Link>
          <Link to="/app/new-company" className="text-brand-700 hover:underline dark:text-brand-300">+ Add another company</Link>
        </div>
        <div className="mt-6"><DemoLoader orgId={me.organisations[0]?.org_id ?? null} /></div>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <div className="mb-6 text-lg"><Wordmark brand={me.brand} /></div>
      <h1 className="text-2xl font-semibold">Set up your first company</h1>
      <p className="mb-6 mt-1 text-sm muted">We'll create a chart of accounts, tax codes, numbering and the current financial year. Everything can be adjusted later.</p>
      {error && <Alert className="mb-4">{error}</Alert>}
      <div className="mb-6"><DemoLoader orgId={null} /></div>
      <Card><CompanyForm withOrg busy={busy} onSubmit={async (v, branding) => {
        const r = await run(async () => { const c = await api.post<{ company_id: string }>("/api/orgs", v); return { ...c, brandingError: await saveBranding(c.company_id, branding) }; });
        if (r) { if (r.brandingError) toast("error", r.brandingError); await refresh(); nav(`/app/${r.company_id}/dashboard`); }
      }} /></Card>
    </div>
  );
}

export function NewCompany() {
  const { me, refresh } = useSession();
  const nav = useNavigate();
  const { busy, error, run } = useAction();
  const toast = useToast();
  const [org, setOrg] = useState(me?.organisations[0]?.org_id ?? "");
  if (!me?.user) return <Navigate to="/login" replace />;
  if (!me.organisations.length) return <Navigate to="/app" replace />;
  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <Link to="/app" className="text-sm muted hover:underline">← Back</Link>
      <h1 className="mb-6 mt-2 text-2xl font-semibold">Add a company</h1>
      {error && <Alert className="mb-4">{error}</Alert>}
      {me.organisations.length > 1 && (
        <Field label="Organisation" className="mb-4">{(id) => <Select id={id} value={org} onChange={(e) => setOrg(e.target.value)}>{me.organisations.map((o) => <option key={o.org_id} value={o.org_id}>{o.org_name}</option>)}</Select>}</Field>
      )}
      <div className="mb-6"><DemoLoader orgId={org} /></div>
      <Card><CompanyForm busy={busy} onSubmit={async (v, branding) => {
        const r = await run(async () => { const c = await api.post<{ company_id: string }>(`/api/orgs/${org}/companies`, v); return { ...c, brandingError: await saveBranding(c.company_id, branding) }; });
        if (r) { if (r.brandingError) toast("error", r.brandingError); await refresh(); nav(`/app/${r.company_id}/dashboard`); }
      }} /></Card>
    </div>
  );
}
