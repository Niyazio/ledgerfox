import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { Phone, Plus } from "lucide-react";
import { useCompany } from "../lib/company";
import { useApi } from "../lib/hooks";
import { api, errorMessage } from "../lib/api";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Modal, PageHeader, Select, Spinner, Stat, TableWrap, Tabs, Textarea, useToast } from "../components/ui";
import { fmtDate, today, toInput } from "../lib/format";
import { contactPath, docPath } from "../lib/links";

type Tab = "pipeline" | "followups" | "report";
const STAGES = [
  { key: "new", label: "New", color: "gray" }, { key: "contacted", label: "Contacted", color: "blue" }, { key: "qualified", label: "Qualified", color: "blue" },
  { key: "proposal", label: "Proposal sent", color: "amber" }, { key: "won", label: "Won", color: "green" }, { key: "lost", label: "Lost", color: "red" },
] as const;
const SOURCES = ["Website", "Referral", "Walk-in", "Phone call", "WhatsApp", "Instagram", "Facebook", "Google", "Exhibition", "Other"];
const KINDS = [{ k: "call", l: "Call" }, { k: "meeting", l: "Meeting" }, { k: "whatsapp", l: "WhatsApp" }, { k: "email", l: "Email" }, { k: "note", l: "Note" }, { k: "task", l: "Task" }];

/** Leads, the sales pipeline and follow-ups. */
export default function CrmPage() {
  const [tab, setTab] = useState<Tab>("pipeline");
  return (
    <>
      <PageHeader title="Leads & CRM" subtitle="Track enquiries from first call to won or lost: follow-ups, calls and meetings, and a quotation in one click." />
      <Tabs tabs={[{ value: "pipeline", label: "Pipeline" }, { value: "followups", label: "Follow-ups" }, { value: "report", label: "Sources & win rate" }]} value={tab} onChange={setTab} />
      <div className="mt-4">{tab === "pipeline" ? <Pipeline /> : tab === "followups" ? <FollowUps /> : <Report />}</div>
    </>
  );
}

function Pipeline() {
  const { path, money, can } = useCompany();
  const [q, setQ] = useState("");
  const list = useApi<{ leads: any[]; pipeline: { stage: string; count: number; value: number }[]; win_rate: number | null }>(path(`/crm/leads${q ? `?q=${encodeURIComponent(q)}` : ""}`));
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const t = today();
  const openValue = list.data?.pipeline.filter((p) => !["won", "lost"].includes(p.stage)).reduce((s, p) => s + p.value, 0) ?? 0;
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Open pipeline" value={money(openValue)} sub={`${list.data?.leads.filter((l) => !["won", "lost"].includes(l.stage)).length ?? 0} open leads`} />
        <Stat label="Won" value={money(list.data?.pipeline.find((p) => p.stage === "won")?.value ?? 0)} sub={`${list.data?.pipeline.find((p) => p.stage === "won")?.count ?? 0} leads`} tone="good" />
        <Stat label="Win rate" value={list.data?.win_rate == null ? "—" : `${Math.round(list.data.win_rate * 100)}%`} sub="Of leads closed" />
        <div className="card flex flex-col justify-center gap-2 p-4">
          {can("sales.create") || can("customers.write") ? <Button onClick={() => setAdding(true)}><Plus className="h-4 w-4" />New lead</Button> : null}
          <Input aria-label="Search leads" placeholder="Search name, phone…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {list.loading && !list.data ? <Spinner /> : !list.data?.leads.length ? <EmptyState title="No leads yet" body="Add every enquiry as a lead: who, what they want and how much it is worth. Plan the next call, and convert it to a customer and a quotation when it is ready." /> : (
        <div className="mt-4 flex gap-3 overflow-x-auto pb-2">
          {STAGES.map((s) => {
            const p = list.data!.pipeline.find((x) => x.stage === s.key)!;
            return (
              <div key={s.key} className="w-56 shrink-0 rounded-xl bg-[var(--surface-2)] p-2">
                <div className="mb-2 flex items-center justify-between px-1 text-xs font-semibold uppercase tracking-wide"><span>{s.label} · {p.count}</span><span className="muted">{money(p.value)}</span></div>
                <div className="grid gap-2">{list.data!.leads.filter((l) => l.stage === s.key).map((l) => (
                  <button key={l.id} className="card p-3 text-left hover:ring-2 hover:ring-brand-500" onClick={() => setOpen(l.id)}>
                    <p className="break-words text-sm font-medium">{l.title}</p>
                    <p className="text-xs muted">{[l.organisation, l.person].filter(Boolean).join(" · ")}</p>
                    <p className="mt-1 text-sm">{money(l.value, l.currency)}</p>
                    {l.next_follow_up && <span className="mt-1 inline-block"><Badge color={l.next_follow_up < t ? "red" : l.next_follow_up === t ? "amber" : "gray"}>Follow up {fmtDate(l.next_follow_up)}</Badge></span>}
                  </button>))}</div>
              </div>
            );
          })}
        </div>
      )}
      {adding && <LeadForm onClose={(id) => { setAdding(false); if (id) { list.reload(); setOpen(id); } }} />}
      {open && <LeadView id={open} onClose={() => { setOpen(null); list.reload(); }} />}
    </>
  );
}

function LeadForm({ lead, onClose }: { lead?: any; onClose: (id?: string) => void }) {
  const { path, settings } = useCompany();
  const base = settings?.company.base_currency ?? "INR";
  const [v, setV] = useState({ title: lead?.title ?? "", person: lead?.person ?? "", organisation: lead?.organisation ?? "", phone: lead?.phone ?? "", email: lead?.email ?? "",
    source: lead?.source ?? "", value: lead ? toInput(lead.value, base) : "", expected_close: lead?.expected_close ?? "", notes: lead?.notes ?? "" });
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try {
      const payload = { ...v, expected_close: v.expected_close || null, value: v.value || "0" };
      if (lead) { await api.patch(path(`/crm/leads/${lead.id}`), payload); onClose(lead.id); }
      else onClose((await api.post<{ id: string }>(path("/crm/leads"), payload)).id);
    } catch (e) { setError(errorMessage(e)); }
  };
  const f = (k: keyof typeof v, label: string, props: Record<string, unknown> = {}) => <Field label={label}>{(fid) => <Input id={fid} value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} {...props} />}</Field>;
  return (
    <Modal open wide title={lead ? "Edit lead" : "New lead"} onClose={() => onClose()} footer={<><Button variant="secondary" onClick={() => onClose()}>Close</Button><Button disabled={!v.title} onClick={() => void save()}>Save</Button></>}>
      {error && <Alert className="mb-3">{error}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">{f("title", "What do they want?", { placeholder: "e.g. Website for a dental clinic" })}</div>
        {f("person", "Person")}{f("organisation", "Company / organisation")}{f("phone", "Phone", { inputMode: "tel" })}{f("email", "Email", { type: "email" })}
        <Field label="Source">{(fid) => <Select id={fid} value={v.source} onChange={(e) => setV({ ...v, source: e.target.value })}><option value="">—</option>{SOURCES.map((s) => <option key={s}>{s}</option>)}</Select>}</Field>
        {f("value", "Expected value", { inputMode: "decimal" })}
        {f("expected_close", "Expected to close by", { type: "date" })}
        <Field label="Notes" className="sm:col-span-2">{(fid) => <Textarea id={fid} rows={3} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} />}</Field>
      </div>
    </Modal>
  );
}

function LeadView({ id, onClose }: { id: string; onClose: () => void }) {
  const { path, money, can, id: cid, settings } = useCompany();
  const nav = useNavigate();
  const toast = useToast();
  const x = useApi<{ lead: any; activities: any[] }>(path(`/crm/leads/${id}`));
  const [act, setAct] = useState({ kind: "call", summary: "", due_date: "" });
  const [editing, setEditing] = useState(false);
  const [lost, setLost] = useState<string | null>(null);
  if (!x.data) return <Modal open title="Lead" onClose={onClose}><Spinner /></Modal>;
  const l = x.data.lead;
  const df = settings?.company.date_format;
  const stage = async (s: string, lost_reason?: string) => {
    try { await api.patch(path(`/crm/leads/${id}`), { stage: s, ...(lost_reason ? { lost_reason } : {}) }); x.reload(); setLost(null); }
    catch (e) { toast("error", errorMessage(e)); }
  };
  if (editing) return <LeadForm lead={l} onClose={() => { setEditing(false); x.reload(); }} />;
  return (
    <Modal open wide title={l.title} onClose={onClose}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm">{[l.organisation, l.person].filter(Boolean).join(" · ")}</span>
        {l.phone && <a className="inline-flex items-center gap-1 text-sm text-brand-700 underline dark:text-brand-300" href={`tel:${l.phone}`}><Phone className="h-3.5 w-3.5" />{l.phone}</a>}
        {l.phone && <a className="text-sm text-emerald-700 underline" target="_blank" rel="noreferrer" href={`https://wa.me/${l.phone.replace(/\D/g, "").replace(/^(\d{10})$/, "91$1")}`}>WhatsApp</a>}
        {l.email && <a className="text-sm underline" href={`mailto:${l.email}`}>{l.email}</a>}
        <span className="flex-1" />
        <b>{money(l.value, l.currency)}</b>{l.source && <Badge>{l.source}</Badge>}
      </div>
      <div className="mt-3 flex flex-wrap gap-1">{STAGES.map((s) => <button key={s.key} className={`rounded-full px-3 py-1 text-xs ${l.stage === s.key ? "bg-brand-700 text-white" : "bg-[var(--surface-2)] hover:bg-[var(--border)]"}`}
        onClick={() => (s.key === "lost" ? setLost("") : void stage(s.key))}>{s.label}</button>)}</div>
      {lost !== null && <div className="mt-2 flex gap-2"><Input aria-label="Why was it lost?" placeholder="Why was it lost? (price, went elsewhere, no budget…)" value={lost} onChange={(e) => setLost(e.target.value)} /><Button variant="danger" disabled={!lost} onClick={() => void stage("lost", lost)}>Mark lost</Button></div>}
      {l.lost_reason && l.stage === "lost" && <Alert kind="warning" className="mt-2">Lost: {l.lost_reason}</Alert>}
      <div className="mt-3 flex flex-wrap gap-2 text-sm">
        {l.contact_id && <Link className="text-brand-700 underline dark:text-brand-300" to={contactPath(cid, l.contact_id)}>Customer: {l.customer}</Link>}
        {l.quote_id && <Link className="text-brand-700 underline dark:text-brand-300" to={docPath(cid, "quote", l.quote_id)}>Quotation {l.quote_number ?? "(draft)"} · {l.quote_status}</Link>}
        <span className="flex-1" />
        <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>Edit</Button>
        {can("customers.write") && !l.quote_id && <Button size="sm" onClick={async () => {
          try { const r = await api.post<{ quote_id: string }>(path(`/crm/leads/${id}/convert`), { quotation: can("sales.create") }); toast("success", "Customer and draft quotation made"); nav(docPath(cid, "quote", r.quote_id)); }
          catch (e) { toast("error", errorMessage(e)); }
        }}>Make customer & quotation</Button>}
      </div>
      {l.notes && <p className="mt-3 whitespace-pre-wrap rounded-lg bg-[var(--surface-2)] p-2 text-sm">{l.notes}</p>}
      <Card className="mt-4" title="Log a call, meeting or note — or plan a follow-up">
        <div className="grid gap-2 sm:grid-cols-[8rem_1fr_10rem_auto]">
          <Select aria-label="Kind" value={act.kind} onChange={(e) => setAct({ ...act, kind: e.target.value })}>{KINDS.map((k) => <option key={k.k} value={k.k}>{k.l}</option>)}</Select>
          <Input aria-label="What happened / what to do" placeholder="What happened, or what to do next" value={act.summary} onChange={(e) => setAct({ ...act, summary: e.target.value })} />
          <Input aria-label="Follow up on" type="date" value={act.due_date} onChange={(e) => setAct({ ...act, due_date: e.target.value })} title="Give a date to make it a follow-up" />
          <Button disabled={!act.summary} onClick={async () => {
            try { await api.post(path(`/crm/leads/${id}/activities`), { ...act, due_date: act.due_date || null }); setAct({ kind: "call", summary: "", due_date: "" }); x.reload(); }
            catch (e) { toast("error", errorMessage(e)); }
          }}>{act.due_date ? "Plan" : "Log"}</Button>
        </div>
      </Card>
      <ul className="mt-3 grid gap-2">{x.data.activities.map((a) => (
        <li key={a.id} className="flex items-start gap-2 text-sm">
          <Badge color={a.done_at ? "gray" : a.due_date && a.due_date < today() ? "red" : "amber"}>{KINDS.find((k) => k.k === a.kind)?.l ?? a.kind}</Badge>
          <span className="flex-1">{a.summary}<span className="block text-xs muted">{a.done_at ? `${a.user ?? ""} · ${fmtDate(a.done_at.slice(0, 10), df)}` : `Due ${fmtDate(a.due_date, df)}`}</span></span>
          {!a.done_at && <Button size="sm" variant="ghost" onClick={async () => { await api.post(path(`/crm/activities/${a.id}/done`), {}); x.reload(); }}>Done</Button>}
        </li>))}</ul>
    </Modal>
  );
}

function FollowUps() {
  const { path, settings } = useCompany();
  const [mine, setMine] = useState(false);
  const list = useApi<{ follow_ups: any[]; today: string }>(path(`/crm/follow-ups${mine ? "?mine=1" : ""}`));
  const [open, setOpen] = useState<string | null>(null);
  const df = settings?.company.date_format;
  return (
    <Card padded={false} title="Follow-ups due this week" actions={<label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />Only mine</label>}>
      {list.loading && !list.data ? <Spinner /> : !list.data?.follow_ups.length ? <EmptyState title="Nothing to follow up" body="Plan the next call or meeting on a lead by giving it a date." /> : (
        <TableWrap><table className="table text-sm">
          <thead><tr><th>Due</th><th>Lead</th><th>To do</th><th>Phone</th><th>Who</th></tr></thead>
          <tbody>{list.data.follow_ups.map((a) => <tr key={a.id} className="cursor-pointer hover:bg-[var(--surface-2)]" onClick={() => setOpen(a.lead_id)}>
            <td className="whitespace-nowrap">{fmtDate(a.due_date, df)} {a.due_date < list.data!.today && <Badge color="red">overdue</Badge>}{a.due_date === list.data!.today && <Badge color="amber">today</Badge>}</td>
            <td className="font-medium">{a.title}<span className="block text-xs font-normal muted">{[a.organisation, a.person].filter(Boolean).join(" · ")}</span></td>
            <td>{a.summary}</td><td>{a.phone ? <a className="underline" href={`tel:${a.phone}`} onClick={(e) => e.stopPropagation()}>{a.phone}</a> : ""}</td><td>{a.user ?? ""}</td></tr>)}</tbody>
        </table></TableWrap>
      )}
      {open && <LeadView id={open} onClose={() => { setOpen(null); list.reload(); }} />}
    </Card>
  );
}

function Report() {
  const { path, money } = useCompany();
  const [from, setFrom] = useState(`${today().slice(0, 4)}-01-01`);
  const r = useApi<{ by_source: any[]; lost_reasons: any[] }>(path(`/crm/report?from=${from}`));
  return (
    <>
      <Field label="Leads created from">{(fid) => <Input id={fid} type="date" className="w-44" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
      <Card className="mt-3" padded={false} title="Where leads come from">
        {!r.data?.by_source.length ? <EmptyState title="No leads in this period" /> : <TableWrap><table className="table text-sm">
          <thead><tr><th>Source</th><th className="num">Leads</th><th className="num">Won</th><th className="num">Lost</th><th className="num">Win rate</th><th className="num">Won value</th><th className="num">Still open</th></tr></thead>
          <tbody>{r.data.by_source.map((s) => <tr key={s.source}><td>{s.source}</td><td className="num">{s.leads}</td><td className="num">{s.won}</td><td className="num">{s.lost}</td>
            <td className="num">{s.won + s.lost ? `${Math.round((s.won / (s.won + s.lost)) * 100)}%` : "—"}</td><td className="num">{money(s.won_value)}</td><td className="num">{money(s.open_value)}</td></tr>)}</tbody>
        </table></TableWrap>}
      </Card>
      {r.data?.lost_reasons.length ? <Card className="mt-3" title="Why leads are lost">{r.data.lost_reasons.map((x) => <p key={x.lost_reason ?? "-"} className="text-sm">{x.lost_reason ?? "(no reason)"} — <b>{x.n}</b></p>)}</Card> : null}
    </>
  );
}
