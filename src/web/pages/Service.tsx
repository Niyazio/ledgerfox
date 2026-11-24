import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { Plus } from "lucide-react";
import { useCompany } from "../lib/company";
import { useApi } from "../lib/hooks";
import { api, errorMessage } from "../lib/api";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Modal, PageHeader, Select, Spinner, Stat, TableWrap, Tabs, Textarea, useToast } from "../components/ui";
import { ContactSelect } from "../components/pickers";
import { fmtDate, today } from "../lib/format";
import { contactPath, docPath } from "../lib/links";

type Tab = "tickets" | "contracts";
const PRIORITY: Record<string, "red" | "amber" | "blue" | "gray"> = { urgent: "red", high: "amber", normal: "blue", low: "gray" };
const STATUS: Record<string, { label: string; color: "amber" | "blue" | "gray" | "green" }> = {
  open: { label: "Open", color: "amber" }, in_progress: { label: "In progress", color: "blue" }, waiting: { label: "Waiting for customer", color: "gray" },
  resolved: { label: "Resolved", color: "green" }, closed: { label: "Closed", color: "gray" },
};
const STATE: Record<string, { label: string; color: "green" | "amber" | "red" | "gray" | "blue" }> = {
  active: { label: "Active", color: "green" }, expiring: { label: "Expires soon", color: "amber" }, expired: { label: "Expired", color: "red" },
  upcoming: { label: "Starts later", color: "blue" }, renewed: { label: "Renewed", color: "gray" }, cancelled: { label: "Cancelled", color: "gray" },
};

/** Support tickets and AMC / service contracts. */
export default function ServicePage() {
  const [tab, setTab] = useState<Tab>("tickets");
  return (
    <>
      <PageHeader title="Service desk & AMC" subtitle="Support tickets with due dates and time spent, AMC / service contracts with period billing and renewals. Customers can raise tickets from their portal link." />
      <Tabs tabs={[{ value: "tickets", label: "Tickets" }, { value: "contracts", label: "AMC / service contracts" }]} value={tab} onChange={setTab} />
      <div className="mt-4">{tab === "tickets" ? <Tickets /> : <Contracts />}</div>
    </>
  );
}

function Tickets() {
  const { path, can, settings, id: cid } = useCompany();
  const [status, setStatus] = useState("active");
  const [mine, setMine] = useState(false);
  const list = useApi<{ tickets: any[]; counts: Record<string, number>; overdue: number; today: string }>(path(`/service/tickets?status=${status}${mine ? "&mine=1" : ""}`));
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const df = settings?.company.date_format;
  const c = list.data?.counts ?? {};
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Open" value={String((c.open ?? 0) + (c.in_progress ?? 0) + (c.waiting ?? 0))} sub={`${c.waiting ?? 0} waiting for the customer`} />
        <Stat label="Past due date" value={String(list.data?.overdue ?? 0)} tone={(list.data?.overdue ?? 0) > 0 ? "bad" : "neutral"} sub="Urgent: same day · High: 1 day · Normal: 3 · Low: 7" />
        <Stat label="Resolved" value={String((c.resolved ?? 0) + (c.closed ?? 0))} tone="good" />
        <div className="card flex flex-col justify-center gap-2 p-4">
          {(can("sales.create") || can("customers.write")) && <Button onClick={() => setAdding(true)}><Plus className="h-4 w-4" />New ticket</Button>}
          <div className="flex gap-2"><Select aria-label="Show" value={status} onChange={(e) => setStatus(e.target.value)}><option value="active">Open tickets</option><option value="resolved">Resolved</option><option value="closed">Closed</option><option value="all">All</option></Select>
            <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />Mine</label></div>
        </div>
      </div>
      <Card className="mt-4" padded={false}>
        {list.loading && !list.data ? <Spinner /> : !list.data?.tickets.length ? <EmptyState title="No tickets" body="Log every complaint or service request as a ticket, so nothing is forgotten and each one is billed or covered by an AMC." /> : (
          <TableWrap><table className="table text-sm">
            <thead><tr><th>Ticket</th><th>Customer</th><th>Subject</th><th>Priority</th><th>Due</th><th>Assigned</th><th>Status</th></tr></thead>
            <tbody>{list.data.tickets.map((t) => <tr key={t.id} className="cursor-pointer hover:bg-[var(--surface-2)]" onClick={() => setOpen(t.id)}>
              <td className="font-medium">{t.number}{t.source === "portal" && <span className="ml-1"><Badge color="blue">portal</Badge></span>}</td>
              <td><Link className="text-brand-700 hover:underline dark:text-brand-300" to={contactPath(cid, t.contact_id)} onClick={(e) => e.stopPropagation()}>{t.customer}</Link>{t.contract_number && <span className="block text-xs muted">Under {t.contract_number}</span>}</td>
              <td>{t.subject}</td><td><Badge color={PRIORITY[t.priority]}>{t.priority}</Badge></td>
              <td className="whitespace-nowrap">{t.due_date ? fmtDate(t.due_date, df) : "—"}{["open", "in_progress", "waiting"].includes(t.status) && t.due_date && t.due_date < list.data!.today && <span className="ml-1"><Badge color="red">late</Badge></span>}</td>
              <td>{t.assignee ?? "—"}</td><td><Badge color={STATUS[t.status].color}>{STATUS[t.status].label}</Badge></td></tr>)}</tbody>
          </table></TableWrap>
        )}
      </Card>
      {adding && <NewTicket onClose={(id) => { setAdding(false); list.reload(); if (id) setOpen(id); }} />}
      {open && <TicketView id={open} onClose={() => { setOpen(null); list.reload(); }} />}
    </>
  );
}

function useMembers() {
  const { settings } = useCompany();
  return useApi<{ members: any[] }>(settings ? `/api/orgs/${settings.company.org_id}` : null);
}

function NewTicket({ onClose }: { onClose: (id?: string) => void }) {
  const { path } = useCompany();
  const members = useMembers();
  const [v, setV] = useState({ contact_id: "", subject: "", description: "", category: "", asset: "", priority: "normal", assigned_user_id: "" });
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal open wide title="New ticket" onClose={() => onClose()} footer={<><Button variant="secondary" onClick={() => onClose()}>Close</Button><Button disabled={!v.contact_id || !v.subject} onClick={async () => {
      try { const r = await api.post<{ id: string }>(path("/service/tickets"), { ...v, assigned_user_id: v.assigned_user_id || null, category: v.category || null, asset: v.asset || null, description: v.description || null }); onClose(r.id); }
      catch (e) { setError(errorMessage(e)); }
    }}>Save</Button></>}>
      {error && <Alert className="mb-3">{error}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Customer" required>{(fid) => <ContactSelect id={fid} kind="customer" value={v.contact_id} onChange={(x) => setV({ ...v, contact_id: x })} />}</Field>
        <Field label="Priority">{(fid) => <Select id={fid} value={v.priority} onChange={(e) => setV({ ...v, priority: e.target.value })}><option value="urgent">Urgent (same day)</option><option value="high">High (1 day)</option><option value="normal">Normal (3 days)</option><option value="low">Low (7 days)</option></Select>}</Field>
        <Field label="Subject" required className="sm:col-span-2">{(fid) => <Input id={fid} value={v.subject} onChange={(e) => setV({ ...v, subject: e.target.value })} />}</Field>
        <Field label="Details" className="sm:col-span-2">{(fid) => <Textarea id={fid} rows={3} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} />}</Field>
        <Field label="Machine / product / serial no.">{(fid) => <Input id={fid} value={v.asset} onChange={(e) => setV({ ...v, asset: e.target.value })} />}</Field>
        <Field label="Category">{(fid) => <Input id={fid} placeholder="Hardware, software, website…" value={v.category} onChange={(e) => setV({ ...v, category: e.target.value })} />}</Field>
        <Field label="Assign to">{(fid) => <Select id={fid} value={v.assigned_user_id} onChange={(e) => setV({ ...v, assigned_user_id: e.target.value })}><option value="">—</option>{members.data?.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select>}</Field>
      </div>
    </Modal>
  );
}

function TicketView({ id, onClose }: { id: string; onClose: () => void }) {
  const { path, can, settings, id: cid } = useCompany();
  const nav = useNavigate();
  const toast = useToast();
  const members = useMembers();
  const x = useApi<{ ticket: any; notes: any[] }>(path(`/service/tickets/${id}`));
  const [note, setNote] = useState({ note: "", minutes: "", public: false });
  const [resolution, setResolution] = useState("");
  const [bill, setBill] = useState<{ rate: string; parts: string; price: string } | null>(null);
  if (!x.data) return <Modal open title="Ticket" onClose={onClose}><Spinner /></Modal>;
  const t = x.data.ticket;
  const df = settings?.company.date_format;
  const minutes = x.data.notes.reduce((s, n) => s + n.minutes, 0);
  const patch = async (p: Record<string, unknown>) => { try { await api.patch(path(`/service/tickets/${id}`), p); x.reload(); } catch (e) { toast("error", errorMessage(e)); } };
  const closed = t.status === "resolved" || t.status === "closed";
  return (
    <Modal open wide title={`${t.number} · ${t.subject}`} onClose={onClose}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Link className="font-medium text-brand-700 underline dark:text-brand-300" to={contactPath(cid, t.contact_id)}>{t.customer}</Link>
        {t.phone && <a className="underline" href={`tel:${t.phone}`}>{t.phone}</a>}
        <Badge color={PRIORITY[t.priority]}>{t.priority}</Badge><Badge color={STATUS[t.status].color}>{STATUS[t.status].label}</Badge>
        {t.due_date && <span className="muted">Due {fmtDate(t.due_date, df)}</span>}
        {t.contract_number ? <Badge color="green">Under {t.contract_number} (to {fmtDate(t.contract_end, df)})</Badge> : <Badge>No AMC: billable</Badge>}
      </div>
      {t.asset && <p className="mt-2 text-sm"><b>Product / serial:</b> {t.asset}</p>}
      {t.description && <p className="mt-2 whitespace-pre-wrap rounded-lg bg-[var(--surface-2)] p-2 text-sm">{t.description}</p>}
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <Field label="Status">{(fid) => <Select id={fid} value={t.status} onChange={(e) => { if (e.target.value === "resolved" || e.target.value === "closed") { if (!resolution) { toast("info", "Write how it was resolved, then choose Resolved"); return; } void patch({ status: e.target.value, resolution }); } else void patch({ status: e.target.value }); }}>
          {Object.entries(STATUS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}</Select>}</Field>
        <Field label="Priority">{(fid) => <Select id={fid} value={t.priority} onChange={(e) => void patch({ priority: e.target.value })}>{Object.keys(PRIORITY).map((p) => <option key={p}>{p}</option>)}</Select>}</Field>
        <Field label="Assigned to">{(fid) => <Select id={fid} value={t.assigned_user_id ?? ""} onChange={(e) => void patch({ assigned_user_id: e.target.value || null })}><option value="">—</option>{members.data?.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select>}</Field>
      </div>
      {!closed && <Field label="Resolution (needed to resolve)" className="mt-2">{(fid) => <Input id={fid} value={resolution} onChange={(e) => setResolution(e.target.value)} placeholder="What fixed it" />}</Field>}
      {t.resolution && <Alert kind="success" className="mt-2">Resolved: {t.resolution}</Alert>}
      <Card className="mt-3" title={`Work notes · ${(minutes / 60).toFixed(2)} h logged`}>
        <ul className="grid gap-2">{x.data.notes.map((n) => <li key={n.id} className="text-sm">{n.public ? <Badge color="blue">sent to customer</Badge> : null} {n.note}<span className="block text-xs muted">{n.user ?? "Customer"} · {fmtDate(n.created_at.slice(0, 10), df)}{n.minutes ? ` · ${n.minutes} min` : ""}</span></li>)}</ul>
        <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_7rem_auto_auto] sm:items-center">
          <Input aria-label="Note" placeholder="What was done / reply to the customer" value={note.note} onChange={(e) => setNote({ ...note, note: e.target.value })} />
          <Input aria-label="Minutes" inputMode="numeric" placeholder="minutes" value={note.minutes} onChange={(e) => setNote({ ...note, minutes: e.target.value })} />
          <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={note.public} onChange={(e) => setNote({ ...note, public: e.target.checked })} />Show to customer</label>
          <Button disabled={!note.note} onClick={async () => { await api.post(path(`/service/tickets/${id}/notes`), { note: note.note, minutes: Number(note.minutes || 0), public: note.public }); setNote({ note: "", minutes: "", public: false }); x.reload(); }}>Add</Button>
        </div>
      </Card>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {t.invoice_id ? <Link className="text-sm text-brand-700 underline dark:text-brand-300" to={docPath(cid, "invoice", t.invoice_id)}>Billed: {t.invoice_number ?? "draft invoice"}</Link>
          : can("sales.create") && <Button variant="secondary" onClick={() => setBill({ rate: "", parts: "", price: "" })}>Bill this ticket</Button>}
      </div>
      {bill && <div className="mt-2 grid gap-2 rounded-xl border border-[var(--border)] p-3 sm:grid-cols-4 sm:items-end">
        <Field label={`Hourly rate (${(minutes / 60).toFixed(2)} h)`}>{(fid) => <Input id={fid} inputMode="decimal" value={bill.rate} onChange={(e) => setBill({ ...bill, rate: e.target.value })} />}</Field>
        <Field label="Parts / other charge">{(fid) => <Input id={fid} value={bill.parts} placeholder="e.g. Printer roller" onChange={(e) => setBill({ ...bill, parts: e.target.value })} />}</Field>
        <Field label="Amount">{(fid) => <Input id={fid} inputMode="decimal" value={bill.price} onChange={(e) => setBill({ ...bill, price: e.target.value })} />}</Field>
        <Button onClick={async () => {
          try {
            const r = await api.post<{ id: string }>(path(`/service/tickets/${id}/invoice`), { hourly_rate: bill.rate || null, lines: bill.parts && bill.price ? [{ description: bill.parts, quantity: "1", unit_price: bill.price }] : [] });
            toast("success", "Draft invoice made"); nav(docPath(cid, "invoice", r.id));
          } catch (e) { toast("error", errorMessage(e)); }
        }}>Make draft invoice</Button>
        {t.contract_number && <p className="text-xs muted sm:col-span-4">This customer has contract {t.contract_number}: bill only what the contract does not cover.</p>}
      </div>}
    </Modal>
  );
}

function Contracts() {
  const { path, money, can, settings, id: cid } = useCompany();
  const nav = useNavigate();
  const toast = useToast();
  const list = useApi<{ contracts: any[] }>(path("/service/contracts"));
  const [adding, setAdding] = useState(false);
  const df = settings?.company.date_format;
  const active = list.data?.contracts.filter((k) => ["active", "expiring", "upcoming"].includes(k.state)) ?? [];
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Active contracts" value={String(active.length)} />
        <Stat label="Expiring in 30 days" value={String(list.data?.contracts.filter((k) => k.state === "expiring").length ?? 0)} tone="bad" sub="Renew them" />
        <Stat label="Periods to bill" value={String(list.data?.contracts.filter((k) => k.to_bill).length ?? 0)} />
        <div className="card flex items-center p-4">{(can("sales.create") || can("customers.write")) && <Button className="w-full" onClick={() => setAdding(true)}><Plus className="h-4 w-4" />New contract</Button>}</div>
      </div>
      <Card className="mt-4" padded={false}>
        {list.loading && !list.data ? <Spinner /> : !list.data?.contracts.length ? <EmptyState title="No AMC or service contracts" body="Annual maintenance, support or retainer contracts: billed monthly, quarterly, yearly or once, with a reminder before they expire." /> : (
          <TableWrap><table className="table text-sm">
            <thead><tr><th>Contract</th><th>Customer</th><th>Period</th><th>Billing</th><th className="num">Amount</th><th className="num">Tickets</th><th>Status</th><th /></tr></thead>
            <tbody>{list.data.contracts.map((k) => <tr key={k.id}>
              <td className="font-medium">{k.number}<span className="block text-xs font-normal">{k.title}</span></td>
              <td><Link className="text-brand-700 hover:underline dark:text-brand-300" to={contactPath(cid, k.contact_id)}>{k.customer}</Link></td>
              <td className="whitespace-nowrap">{fmtDate(k.start_date, df)} – {fmtDate(k.end_date, df)}{k.billed_to && <span className="block text-xs muted">Billed to {fmtDate(k.billed_to, df)}</span>}</td>
              <td>{k.billing}</td><td className="num">{money(k.amount, k.currency)}</td><td className="num">{k.tickets}</td>
              <td><Badge color={STATE[k.state].color}>{STATE[k.state].label}</Badge></td>
              <td className="whitespace-nowrap text-right">
                {k.to_bill && can("sales.create") && <Button size="sm" onClick={async () => { try { const r = await api.post<{ id: string }>(path(`/service/contracts/${k.id}/invoice`)); toast("success", "Draft invoice for the next period"); nav(docPath(cid, "invoice", r.id)); } catch (e) { toast("error", errorMessage(e)); } }}>Bill next period</Button>}
                {["active", "expiring", "expired"].includes(k.state) && <Button size="sm" variant="ghost" onClick={async () => { if (!confirm(`Renew ${k.number} for another term?`)) return; try { await api.post(path(`/service/contracts/${k.id}/renew`), {}); list.reload(); toast("success", "Renewed"); } catch (e) { toast("error", errorMessage(e)); } }}>Renew</Button>}
              </td></tr>)}</tbody>
          </table></TableWrap>
        )}
      </Card>
      {adding && <NewContract onClose={(ok) => { setAdding(false); if (ok) list.reload(); }} />}
    </>
  );
}

function NewContract({ onClose }: { onClose: (ok: boolean) => void }) {
  const { path } = useCompany();
  const year = new Date(Date.now() + 364 * 86_400_000).toISOString().slice(0, 10);
  const [v, setV] = useState({ contact_id: "", title: "Annual maintenance contract", start_date: today(), end_date: year, billing: "yearly", amount: "", visits_included: "", covers: "" });
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal open wide title="New AMC / service contract" onClose={() => onClose(false)} footer={<><Button variant="secondary" onClick={() => onClose(false)}>Close</Button><Button disabled={!v.contact_id || !v.amount} onClick={async () => {
      try { await api.post(path("/service/contracts"), { ...v, visits_included: v.visits_included ? Number(v.visits_included) : null, covers: v.covers || null }); onClose(true); }
      catch (e) { setError(errorMessage(e)); }
    }}>Save</Button></>}>
      {error && <Alert className="mb-3">{error}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Customer" required>{(fid) => <ContactSelect id={fid} kind="customer" value={v.contact_id} onChange={(x) => setV({ ...v, contact_id: x })} />}</Field>
        <Field label="Title">{(fid) => <Input id={fid} value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} />}</Field>
        <Field label="Starts">{(fid) => <Input id={fid} type="date" value={v.start_date} onChange={(e) => setV({ ...v, start_date: e.target.value })} />}</Field>
        <Field label="Ends">{(fid) => <Input id={fid} type="date" value={v.end_date} onChange={(e) => setV({ ...v, end_date: e.target.value })} />}</Field>
        <Field label="Billing">{(fid) => <Select id={fid} value={v.billing} onChange={(e) => setV({ ...v, billing: e.target.value })}><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="yearly">Yearly</option><option value="once">Once (whole contract)</option></Select>}</Field>
        <Field label={v.billing === "once" ? "Contract amount" : `Amount per ${v.billing === "monthly" ? "month" : v.billing === "quarterly" ? "quarter" : "year"}`} required>{(fid) => <Input id={fid} inputMode="decimal" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} />}</Field>
        <Field label="Visits included">{(fid) => <Input id={fid} inputMode="numeric" value={v.visits_included} onChange={(e) => setV({ ...v, visits_included: e.target.value })} />}</Field>
        <Field label="What it covers">{(fid) => <Input id={fid} placeholder="e.g. 10 computers, 2 printers, labour only" value={v.covers} onChange={(e) => setV({ ...v, covers: e.target.value })} />}</Field>
      </div>
    </Modal>
  );
}
