import { useState } from "react";
import { Mail, Sliders, Trash2, Webhook, Zap } from "lucide-react";
import { useCompany } from "../lib/company";
import { useApi } from "../lib/hooks";
import { api, errorMessage } from "../lib/api";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Select, Spinner, TableWrap, useToast } from "../components/ui";
import { fmtDateTime } from "../lib/format";

const ENTITY_LABELS: Record<string, string> = { sales: "Sales documents (invoices, quotes…)", purchase: "Purchase documents (bills, orders…)", contact: "Customers & suppliers", item: "Products & services" };
const TYPE_LABELS: Record<string, string> = { text: "Text", number: "Number", date: "Date", select: "List of choices", checkbox: "Yes / no" };
const REPORT_LABELS: Record<string, string> = { "daily-summary": "Daily summary (sales, money in & out, profit)", "profit-loss": "Profit & loss", receivables: "Money to collect (receivables)", payables: "Bills to pay (payables)", stock: "Stock value and items to reorder" };
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Settings → Customise: custom fields, reports by email, automation rules. */
export function CustomiseTab() {
  return <div className="space-y-4"><FieldsCard /><ReportsCard /><AutomationsCard /></div>;
}

function FieldsCard() {
  const { path, can } = useCompany();
  const { data, reload } = useApi<{ fields: any[] }>(path("/custom-fields"));
  const toast = useToast();
  const [v, setV] = useState({ entity: "sales", label: "", field_type: "text", options: "", show_on_print: true });
  const add = async () => {
    try {
      await api.post(path("/custom-fields"), { entity: v.entity, label: v.label, field_type: v.field_type, show_on_print: v.show_on_print, ...(v.field_type === "select" ? { options: v.options.split(",").map((o) => o.trim()).filter(Boolean) } : {}) });
      setV({ ...v, label: "", options: "" }); reload(); toast("success", "Field added");
    } catch (e) { toast("error", errorMessage(e)); }
  };
  const toggle = async (f: any, k: "is_active" | "show_on_print") => { try { await api.patch(path(`/custom-fields/${f.id}`), { [k]: !f[k] }); reload(); } catch (e) { toast("error", errorMessage(e)); } };
  return (
    <Card title={<span className="flex items-center gap-2"><Sliders className="h-5 w-5" />Custom fields</span>}>
      <p className="mb-3 text-sm muted">Add your own fields, e.g. vehicle number, delivery mode or salesperson on invoices; warranty or size on products; customer category. They appear in the forms and, if you choose, on printed bills.</p>
      {!data ? <Spinner /> : data.fields.length ? <TableWrap><table className="table">
        <thead><tr><th>Field</th><th>On</th><th>Type</th><th>On printouts</th><th /></tr></thead>
        <tbody>{data.fields.map((f) => <tr key={f.id} className={f.is_active ? "" : "opacity-60"}><td className="font-medium">{f.label}</td><td>{ENTITY_LABELS[f.entity]}</td>
          <td>{TYPE_LABELS[f.field_type]}{f.options ? <span className="block text-xs muted">{JSON.parse(f.options).join(", ")}</span> : null}</td>
          <td>{f.entity === "sales" || f.entity === "purchase" ? (f.show_on_print ? "Yes" : "No") : "—"}</td>
          <td className="whitespace-nowrap text-right">{can("company.manage") && <>{(f.entity === "sales" || f.entity === "purchase") && <Button size="sm" variant="ghost" onClick={() => void toggle(f, "show_on_print")}>{f.show_on_print ? "Hide on print" : "Show on print"}</Button>}
            <Button size="sm" variant="ghost" onClick={() => void toggle(f, "is_active")}>{f.is_active ? "Turn off" : "Turn on"}</Button></>}</td></tr>)}</tbody>
      </table></TableWrap> : <EmptyState title="No custom fields yet" />}
      {can("company.manage") && <div className="mt-4 grid gap-3 sm:grid-cols-5">
        <Field label="On">{(id) => <Select id={id} value={v.entity} onChange={(e) => setV({ ...v, entity: e.target.value })}>{Object.entries(ENTITY_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>
        <Field label="Field name">{(id) => <Input id={id} value={v.label} placeholder="e.g. Vehicle no." onChange={(e) => setV({ ...v, label: e.target.value })} />}</Field>
        <Field label="Type">{(id) => <Select id={id} value={v.field_type} onChange={(e) => setV({ ...v, field_type: e.target.value })}>{Object.entries(TYPE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>
        {v.field_type === "select" ? <Field label="Choices" hint="Separate with commas">{(id) => <Input id={id} value={v.options} placeholder="Pickup, Courier" onChange={(e) => setV({ ...v, options: e.target.value })} />}</Field> : <div />}
        <div className="flex items-end"><Button disabled={!v.label.trim()} onClick={() => void add()}>Add field</Button></div>
      </div>}
    </Card>
  );
}

function ReportsCard() {
  const { path, can } = useCompany();
  const { data, error, reload } = useApi<{ schedules: any[]; email_ready: boolean }>(can("reports.read") ? path("/report-schedules") : null);
  const toast = useToast();
  const [v, setV] = useState({ report: "daily-summary", frequency: "daily", weekday: "1", recipients: "", send_now: true });
  if (!can("reports.read")) return null;
  const add = async () => {
    try { await api.post(path("/report-schedules"), { ...v, weekday: Number(v.weekday) }); setV({ ...v, recipients: "" }); reload(); toast("success", v.send_now ? "Scheduled — the first one is on its way" : "Scheduled"); }
    catch (e) { toast("error", errorMessage(e)); }
  };
  return (
    <Card title={<span className="flex items-center gap-2"><Mail className="h-5 w-5" />Reports by email</span>}>
      <p className="mb-3 text-sm muted">Get the key figures in your inbox every day, week or month, with a link to the full report. Sent early in the morning.</p>
      {error && <Alert>{error}</Alert>}
      {data && !data.email_ready && <Alert kind="warning" className="mb-3">Email is not set up on this LedgerFox server yet. Please contact LedgerFox.</Alert>}
      {data?.schedules.length ? <TableWrap><table className="table">
        <thead><tr><th>Report</th><th>When</th><th>To</th><th>Last sent</th><th /></tr></thead>
        <tbody>{data.schedules.map((s) => <tr key={s.id}><td>{REPORT_LABELS[s.report]}</td><td>{s.frequency === "weekly" ? `Every ${DAYS[s.weekday]}` : s.frequency === "monthly" ? "1st of each month" : "Every day"}</td><td className="text-xs">{s.recipients}</td><td>{s.last_sent_on ?? "—"}</td>
          <td className="text-right">{can("company.manage") && <Button size="sm" variant="ghost" aria-label="Delete" onClick={async () => { await api.del(path(`/report-schedules/${s.id}`)); reload(); }}><Trash2 className="h-4 w-4" /></Button>}</td></tr>)}</tbody>
      </table></TableWrap> : data ? <EmptyState title="No reports scheduled" /> : <Spinner />}
      {can("company.manage") && <div className="mt-4 grid gap-3 sm:grid-cols-5">
        <Field label="Report" className="sm:col-span-2">{(id) => <Select id={id} value={v.report} onChange={(e) => setV({ ...v, report: e.target.value })}>{Object.entries(REPORT_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>
        <Field label="How often">{(id) => <Select id={id} value={v.frequency} onChange={(e) => setV({ ...v, frequency: e.target.value })}><option value="daily">Every day</option><option value="weekly">Every week</option><option value="monthly">Every month</option></Select>}</Field>
        {v.frequency === "weekly" ? <Field label="On">{(id) => <Select id={id} value={v.weekday} onChange={(e) => setV({ ...v, weekday: e.target.value })}>{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</Select>}</Field> : <div />}
        <Field label="Send to" hint="Up to 5, separated by commas">{(id) => <Input id={id} value={v.recipients} placeholder="you@example.com" onChange={(e) => setV({ ...v, recipients: e.target.value })} />}</Field>
        <label className="flex items-center gap-2 text-sm sm:col-span-3"><input type="checkbox" checked={v.send_now} onChange={(e) => setV({ ...v, send_now: e.target.checked })} /> Also send one now</label>
        <div className="sm:col-span-2 sm:text-right"><Button disabled={!v.recipients.trim()} onClick={() => void add()}>Schedule</Button></div>
      </div>}
    </Card>
  );
}

function AutomationsCard() {
  const { path, can, settings } = useCompany();
  const { data, error, reload } = useApi<any>(can("company.manage") ? path("/automations") : null);
  const toast = useToast();
  const [v, setV] = useState({ name: "", event: "invoice.issued", min_amount: "", action: "email", target: "" });
  const [secret, setSecret] = useState<string | null>(null);
  if (!can("company.manage")) return null;
  const add = async () => {
    try {
      const r = await api.post<{ signing_secret: string | null }>(path("/automations"), { ...v, min_amount: v.min_amount || null });
      setSecret(r.signing_secret); setV({ ...v, name: "", target: "", min_amount: "" }); reload(); toast("success", "Rule added");
    } catch (e) { toast("error", errorMessage(e)); }
  };
  return (
    <Card title={<span className="flex items-center gap-2"><Zap className="h-5 w-5" />Automations</span>}>
      <p className="mb-3 text-sm muted">“When this happens, do that.” Send an email (e.g. tell the owner about every big invoice) or call a webhook to connect another system (a CRM, a Google Sheet through a connector, your own app).</p>
      {error && <Alert>{error}</Alert>}
      {secret && <Alert kind="info" className="mb-3">Webhook signing secret (shown once — copy it now): <code className="break-all">{secret}</code>. Each call carries the header <code>X-LedgerFox-Signature: sha256=…</code>, an HMAC-SHA256 of the body with this secret.</Alert>}
      {!data ? <Spinner /> : data.rules.length ? <TableWrap><table className="table">
        <thead><tr><th>Rule</th><th>When</th><th>Then</th><th /></tr></thead>
        <tbody>{data.rules.map((r: any) => {
          const last = data.runs.find((x: any) => x.rule_id === r.id);
          return <tr key={r.id} className={r.is_active ? "" : "opacity-60"}><td className="font-medium">{r.name}{last && <span className="block text-xs muted">{last.ok ? "Last run OK" : `Last run failed: ${last.detail}`} · {fmtDateTime(last.created_at)}</span>}</td>
            <td>{data.events[r.event]}{r.min_amount != null && <span className="block text-xs muted">from {settings?.company.base_currency} {(r.min_amount / 100).toLocaleString()}</span>}</td>
            <td>{r.action === "email" ? <><Mail className="mr-1 inline h-4 w-4" />{r.target}</> : <><Webhook className="mr-1 inline h-4 w-4" /><span className="break-all text-xs">{r.target}</span> {r.signed ? <Badge color="green">signed</Badge> : null}</>}</td>
            <td className="whitespace-nowrap text-right">
              <Button size="sm" variant="ghost" onClick={async () => { const t = await api.post<any>(path(`/automations/${r.id}/test`)); toast(t.result?.ok ? "success" : "error", t.result?.ok ? "Test sent" : `Test failed: ${t.result?.detail ?? ""}`); reload(); }}>Test</Button>
              <Button size="sm" variant="ghost" onClick={async () => { await api.patch(path(`/automations/${r.id}`), { is_active: !r.is_active }); reload(); }}>{r.is_active ? "Turn off" : "Turn on"}</Button>
              <Button size="sm" variant="ghost" aria-label="Delete" onClick={async () => { if (confirm("Delete this rule?")) { await api.del(path(`/automations/${r.id}`)); reload(); } }}><Trash2 className="h-4 w-4" /></Button></td></tr>;
        })}</tbody>
      </table></TableWrap> : <EmptyState title="No automations yet" />}
      {data && <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <Field label="Name">{(id) => <Input id={id} value={v.name} placeholder="e.g. Tell me about big invoices" onChange={(e) => setV({ ...v, name: e.target.value })} />}</Field>
        <Field label="When">{(id) => <Select id={id} value={v.event} onChange={(e) => setV({ ...v, event: e.target.value })}>{Object.entries(data.events).map(([k, l]) => <option key={k} value={k}>{l as string}</option>)}</Select>}</Field>
        <Field label="Only from amount" hint="Optional, in your currency">{(id) => <Input id={id} inputMode="decimal" value={v.min_amount} onChange={(e) => setV({ ...v, min_amount: e.target.value })} />}</Field>
        <Field label="Then">{(id) => <Select id={id} value={v.action} onChange={(e) => setV({ ...v, action: e.target.value })}><option value="email">Send an email</option><option value="webhook">Call a webhook (for developers)</option></Select>}</Field>
        <Field label={v.action === "email" ? "Email to" : "Webhook https:// address"} className="sm:col-span-2">{(id) => <Input id={id} value={v.target} placeholder={v.action === "email" ? "owner@example.com" : "https://…"} onChange={(e) => setV({ ...v, target: e.target.value })} />}</Field>
        <div className="sm:col-span-3"><Button disabled={!v.name.trim() || !v.target.trim()} onClick={() => void add()}>Add rule</Button>
          {!data.email_ready && v.action === "email" && <span className="ml-3 text-xs text-amber-700 dark:text-amber-300">Email is not set up on this server yet: email rules will not send.</span>}</div>
      </div>}
    </Card>
  );
}
