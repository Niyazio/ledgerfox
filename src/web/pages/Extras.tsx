import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { Clock, FileUp, RefreshCw, Search } from "lucide-react";
import { useCompany } from "../lib/company";
import { useApi } from "../lib/hooks";
import { api, errorMessage } from "../lib/api";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Modal, PageHeader, Select, Spinner, Stat, TableWrap, useToast } from "../components/ui";
import { AccountSelect, ContactSelect } from "../components/pickers";
import { DOC_LABELS, fmtDate, today, toInput } from "../lib/format";
import { contactPath, docPath, productPath } from "../lib/links";
import { downloadCsv } from "../lib/csv";

const hrs = (minutes: number) => `${(minutes / 60).toFixed(2).replace(/\.00$/, "")} h`;

// ── Projects & time ──

export function ProjectsPage() {
  const { path, money, id, can, settings } = useCompany();
  const nav = useNavigate();
  const toast = useToast();
  const list = useApi<{ projects: any[] }>(path("/projects"));
  const [sel, setSel] = useState<string | null>(null);
  const p = list.data?.projects.find((x) => x.id === sel) ?? list.data?.projects[0];
  const time = useApi<{ entries: any[] }>(p ? path(`/projects/${p.id}/time`) : null);
  const [t, setT] = useState({ work_date: today(), hours: "", description: "", billable: true });
  const [bill, setBill] = useState<{ contact_id: string; hourly_rate: string } | null>(null);
  const base = settings?.company.base_currency ?? "INR";
  if (list.loading && !list.data) return <Spinner />;
  return (
    <>
      <PageHeader title="Projects & time" subtitle="Log the hours worked on each project and bill the unbilled hours on an invoice." />
      {!list.data?.projects.length ? <EmptyState title="No projects yet" body="Add projects in Settings → Branches & dimensions → Projects." /> : <>
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <Field label="Project">{(fid) => <Select id={fid} value={p?.id} onChange={(e) => { setSel(e.target.value); setBill(null); }}>{list.data!.projects.map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name}{x.is_active ? "" : " (inactive)"}</option>)}</Select>}</Field>
        </div>
        {p && <>
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="Customer" value={p.customer ?? "—"} sub={p.hourly_rate != null ? `${money(p.hourly_rate)} per hour` : "No hourly rate"} />
            <Stat label="Unbilled time" value={hrs(p.unbilled_minutes)} sub={money(p.unbilled_amount)} />
            <Stat label="All time logged" value={hrs(p.total_minutes)} />
            <div className="card flex flex-col justify-center gap-2 p-4">
              {can("sales.create") && <Button disabled={!p.unbilled_minutes} onClick={async () => {
                try { const r = await api.post<{ id: string; entries: number }>(path(`/projects/${p.id}/invoice`), {}); toast("success", `Draft invoice made from ${r.entries} time entries`); nav(docPath(id, "invoice", r.id)); }
                catch (e) { toast("error", errorMessage(e)); }
              }}>Invoice unbilled time</Button>}
              {can("sales.create") && <Button variant="secondary" onClick={() => setBill({ contact_id: p.contact_id ?? "", hourly_rate: p.hourly_rate != null ? toInput(p.hourly_rate, base) : "" })}>Customer & rate</Button>}
            </div>
          </div>
          <Card title={<span className="flex items-center gap-2"><Clock className="h-5 w-5" />Log time</span>} className="mt-4">
            <div className="grid gap-3 sm:grid-cols-6">
              <Field label="Date">{(fid) => <Input id={fid} type="date" value={t.work_date} onChange={(e) => setT({ ...t, work_date: e.target.value })} />}</Field>
              <Field label="Hours">{(fid) => <Input id={fid} inputMode="decimal" placeholder="1.5" value={t.hours} onChange={(e) => setT({ ...t, hours: e.target.value })} />}</Field>
              <Field label="What was done" className="sm:col-span-3">{(fid) => <Input id={fid} value={t.description} onChange={(e) => setT({ ...t, description: e.target.value })} />}</Field>
              <label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" checked={t.billable} onChange={(e) => setT({ ...t, billable: e.target.checked })} /> Billable</label>
            </div>
            <Button className="mt-3" disabled={!t.hours || !t.description.trim()} onClick={async () => {
              try { await api.post(path(`/projects/${p.id}/time`), t); setT({ ...t, hours: "", description: "" }); time.reload(); list.reload(); toast("success", "Time logged"); }
              catch (e) { toast("error", errorMessage(e)); }
            }}>Add</Button>
          </Card>
          <Card title="Time entries" padded={false} className="mt-4">{time.data?.entries.length ? <TableWrap><table className="table">
            <thead><tr><th>Date</th><th>Work</th><th>By</th><th className="num">Hours</th><th>Status</th><th /></tr></thead>
            <tbody>{time.data.entries.map((e) => <tr key={e.id}><td>{fmtDate(e.work_date)}</td><td>{e.description}</td><td>{e.user_name ?? "—"}</td><td className="num">{hrs(e.minutes)}</td>
              <td>{!e.billable ? <Badge>not billable</Badge> : e.billed ? <Link className="text-brand-700 hover:underline dark:text-brand-300" to={docPath(id, "invoice", e.invoice_id)}>billed {e.invoice_number ?? "(draft)"}</Link> : <Badge color="amber">unbilled</Badge>}</td>
              <td className="text-right">{!e.billed && <Button size="sm" variant="ghost" onClick={async () => { try { await api.del(path(`/projects/time/${e.id}`)); time.reload(); list.reload(); } catch (err) { toast("error", errorMessage(err)); } }}>Remove</Button>}</td></tr>)}</tbody>
          </table></TableWrap> : <EmptyState title="No time logged yet" />}</Card>
          {bill && <Modal open title={`Billing for ${p.name}`} onClose={() => setBill(null)} footer={<><Button variant="secondary" onClick={() => setBill(null)}>Cancel</Button><Button onClick={async () => {
            try { await api.patch(path(`/projects/${p.id}/billing`), { contact_id: bill.contact_id || null, hourly_rate: bill.hourly_rate || null }); setBill(null); list.reload(); toast("success", "Saved"); }
            catch (e) { toast("error", errorMessage(e)); }
          }}>Save</Button></>}>
            <div className="grid gap-3">
              <Field label="Customer">{(fid) => <ContactSelect id={fid} kind="customer" value={bill.contact_id} onChange={(v) => setBill({ ...bill, contact_id: v })} />}</Field>
              <Field label={`Hourly rate (${base})`}>{(fid) => <Input id={fid} inputMode="decimal" value={bill.hourly_rate} onChange={(e) => setBill({ ...bill, hourly_rate: e.target.value })} />}</Field>
            </div>
          </Modal>}
        </>}
      </>}
    </>
  );
}

// ── Advances on a quotation / proforma / sales order ──

export function AdvancesCard({ docId, currency, contactId }: { docId: string; currency: string; contactId: string }) {
  const { path, money, id, can, accounts } = useCompany();
  const toast = useToast();
  const { data, reload } = useApi<{ advances: any[] }>(path(`/documents/${docId}/advances`));
  const [v, setV] = useState<{ amount: string; payment_date: string; account_id: string; reference: string } | null>(null);
  const cashBank = new Set(accounts.filter((a) => a.subtype === "cash" || a.subtype === "bank").map((a) => a.id));
  return (
    <Card title="Advance payments" className="no-print mt-4" actions={can("sales.post") && <Button size="sm" variant="secondary" onClick={() => setV({ amount: "", payment_date: today(), account_id: "", reference: "" })}>Record advance</Button>}>
      <p className="text-sm muted">Money taken before the work or delivery. It is applied to the invoice made from this document when that invoice is issued.</p>
      {data?.advances.length ? <ul className="mt-2 space-y-1 text-sm">{data.advances.map((a) => <li key={a.id} className="flex flex-wrap justify-between gap-2">
        <Link className="text-brand-700 hover:underline dark:text-brand-300" to={`/app/${id}/payments/view/${a.id}`}>Receipt {a.number} · {fmtDate(a.payment_date)}</Link>
        <span>{money(a.amount, a.currency)} {a.applied >= a.amount ? <Badge color="green">applied</Badge> : a.applied > 0 ? <Badge color="amber">{money(a.applied, a.currency)} applied</Badge> : <Badge>waiting for the invoice</Badge>}</span></li>)}</ul> : null}
      {v && <Modal open title="Record an advance" onClose={() => setV(null)} footer={<><Button variant="secondary" onClick={() => setV(null)}>Cancel</Button><Button onClick={async () => {
        try { await api.post(path(`/documents/${docId}/advance`), v); setV(null); reload(); toast("success", "Advance recorded"); } catch (e) { toast("error", errorMessage(e)); }
      }}>Save</Button></>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={`Amount (${currency})`}>{(fid) => <Input id={fid} inputMode="decimal" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} />}</Field>
          <Field label="Date">{(fid) => <Input id={fid} type="date" value={v.payment_date} onChange={(e) => setV({ ...v, payment_date: e.target.value })} />}</Field>
          <Field label="Received in">{(fid) => <AccountSelect id={fid} value={v.account_id} filter={(a) => cashBank.has(a.id)} onChange={(x) => setV({ ...v, account_id: x })} />}</Field>
          <Field label="Reference">{(fid) => <Input id={fid} value={v.reference} placeholder="UPI ref, cheque no." onChange={(e) => setV({ ...v, reference: e.target.value })} />}</Field>
        </div>
        <p className="mt-2 text-xs muted"><Link className="underline" to={contactPath(id, contactId)}>Customer page</Link> shows all their advances.</p>
      </Modal>}
    </Card>
  );
}

// ── Serial numbers ──

export function SerialsTab({ itemId }: { itemId: string }) {
  const { path, id } = useCompany();
  const { data } = useApi<{ serials: any[] }>(path(`/items/${itemId}/serials`));
  if (!data) return <Spinner />;
  return <Card padded={false}>{data.serials.length ? <TableWrap><table className="table">
    <thead><tr><th>Serial</th><th>Status</th><th>Came in</th><th>Went out</th><th>Customer</th></tr></thead>
    <tbody>{data.serials.map((s) => <tr key={s.serial}><td className="font-mono">{s.serial}</td><td>{s.status === "in_stock" ? <Badge color="green">in stock</Badge> : <Badge>sold / out</Badge>}</td>
      <td>{s.in_doc_id ? <Link className="hover:underline" to={docPath(id, s.in_type, s.in_doc_id)}>{DOC_LABELS[s.in_type]?.one} {s.in_number} · {fmtDate(s.in_date)}</Link> : "—"}</td>
      <td>{s.out_doc_id ? <Link className="hover:underline" to={docPath(id, s.out_type, s.out_doc_id)}>{DOC_LABELS[s.out_type]?.one} {s.out_number} · {fmtDate(s.out_date)}</Link> : "—"}</td>
      <td>{s.customer_id ? <Link className="hover:underline" to={contactPath(id, s.customer_id)}>{s.customer}</Link> : "—"}</td></tr>)}</tbody>
  </table></TableWrap> : <EmptyState title="No serial numbers yet" body="They are recorded from bills (coming in) and invoices (going out)." />}</Card>;
}

/** Find any serial / IMEI: which product, in stock or sold, to whom (warranty, service, returns). */
export function SerialFinder() {
  const { path, id } = useCompany();
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<any[] | null>(null);
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label="Find a serial / IMEI">{(fid) => <Input id={fid} value={q} className="font-mono uppercase" onChange={(e) => setQ(e.target.value)} onKeyDown={async (e) => { if (e.key === "Enter") setRows((await api.get<{ serials: any[] }>(path(`/items/serials/find?q=${encodeURIComponent(q)}`))).serials); }} />}</Field>
      <Button variant="secondary" onClick={async () => setRows((await api.get<{ serials: any[] }>(path(`/items/serials/find?q=${encodeURIComponent(q)}`))).serials)}><Search className="h-4 w-4" />Find</Button>
      {rows && <div className="w-full text-sm">{rows.length ? rows.map((s) => <p key={`${s.item_id}${s.serial}`}><span className="font-mono">{s.serial}</span> · <Link className="text-brand-700 hover:underline dark:text-brand-300" to={productPath(id, s.item_id)}>{s.item_name}</Link> · {s.status === "in_stock" ? "in stock" : `sold${s.customer ? ` to ${s.customer}` : ""}${s.out_number ? ` (${s.out_number}, ${fmtDate(s.out_date)})` : ""}`}</p>) : <span className="muted">Not found.</span>}</div>}
    </div>
  );
}

// ── Exchange rates ──

export function FetchRatesButton({ onDone }: { onDone: () => void }) {
  const { path, can } = useCompany();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!can("accounts.write")) return null;
  return <Button variant="secondary" loading={busy} onClick={async () => {
    setBusy(true);
    try { const r = await api.post<{ saved: number; currencies: string[] }>(path("/settings/exchange-rates/fetch")); toast("success", r.saved ? `Today's rates saved: ${r.currencies.join(", ")}` : "Nothing new: today's rates are already there (or no other currencies are used)"); onDone(); }
    catch (e) { toast("error", errorMessage(e)); } finally { setBusy(false); }
  }}><RefreshCw className="h-4 w-4" />Get today's rates</Button>;
}

// ── GSTR-2B matching ──

const STATUS: Record<string, [string, "green" | "amber" | "red" | "blue"]> = {
  matched: ["Matched", "green"], mismatch: ["Amounts differ", "amber"], missing_in_books: ["Not in your books", "red"], missing_in_2b: ["Supplier has not filed", "blue"],
};

export function Gstr2bMatch() {
  const { path, money, id } = useCompany();
  const [r, setR] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const load = async (f: File) => {
    setBusy(true); setErr(null);
    try { setR(await api.post(path("/reports/gstr2b-match"), { file: JSON.parse(await f.text()) })); }
    catch (e) { setErr(e instanceof SyntaxError ? "This file is not JSON. Download GSTR-2B as JSON from the GST portal." : errorMessage(e)); } finally { setBusy(false); }
  };
  const rows = (r?.rows ?? []).filter((x: any) => !filter || x.status === filter);
  return (
    <Card title={<span className="flex items-center gap-2"><FileUp className="h-5 w-5" />GSTR-2B matching</span>}>
      <p className="text-sm muted">Compare the GSTR-2B statement (supplier invoices the government has on record for you) with the bills in your books, to claim all your input tax credit and spot suppliers who have not filed. On the GST portal: Returns → GSTR-2B → choose the month → Download → JSON.</p>
      <label className="mt-3 inline-flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-sm hover:bg-[var(--surface-2)]">
        <FileUp className="h-4 w-4" />{busy ? "Reading…" : "Choose GSTR-2B JSON file"}
        <input type="file" accept=".json,application/json" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) void load(f); e.target.value = ""; }} />
      </label>
      {err && <Alert className="mt-3">{err}</Alert>}
      {r && <>
        <div className="mt-4 grid gap-3 sm:grid-cols-4">
          <Stat label="Matched" value={r.counts.matched} sub={`Tax ${money(r.tax.matched)}`} tone="good" />
          <Stat label="Amounts differ" value={r.counts.mismatch} />
          <Stat label="Not in your books" value={r.counts.missing_in_books} sub={`Tax ${money(r.tax.missing_in_books)} unclaimed`} tone={r.counts.missing_in_books ? "bad" : "neutral"} />
          <Stat label="Supplier has not filed" value={r.counts.missing_in_2b} sub={`Tax ${money(r.tax.missing_in_2b)} at risk`} />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Show"><option value="">All ({r.rows.length})</option>{Object.entries(STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</Select>
          <Button variant="secondary" size="sm" onClick={() => downloadCsv(`gstr2b-match-${r.period ?? ""}.csv`, ["Status", "Supplier", "GSTIN", "Invoice no.", "Date", "2B taxable", "2B tax", "Books taxable", "Books tax"],
            r.rows.map((x: any) => [STATUS[x.status][0], x.supplier, x.gstin ?? "", x.number, x.date, x.twob ? (x.twob.taxable / 100).toFixed(2) : "", x.twob ? (x.twob.tax / 100).toFixed(2) : "", x.books ? (x.books.taxable / 100).toFixed(2) : "", x.books ? (x.books.tax / 100).toFixed(2) : ""]))}>Download CSV</Button>
        </div>
        <TableWrap><table className="table mt-3">
          <thead><tr><th>Status</th><th>Supplier</th><th>Invoice</th><th>Date</th><th className="num">2B tax</th><th className="num">Books tax</th><th>Bill</th></tr></thead>
          <tbody>{rows.map((x: any, i: number) => <tr key={i}><td><Badge color={STATUS[x.status][1]}>{STATUS[x.status][0]}</Badge></td><td>{x.supplier}<span className="block font-mono text-xs muted">{x.gstin}</span></td><td>{x.number}</td><td>{fmtDate(x.date)}</td>
            <td className="num">{x.twob ? money(x.twob.tax) : "—"}</td><td className="num">{x.books ? money(x.books.tax) : "—"}</td>
            <td>{x.books ? <Link className="text-brand-700 hover:underline dark:text-brand-300" to={docPath(id, "bill", x.books.id)}>{x.books.number}</Link> : <Link className="text-xs text-brand-700 hover:underline dark:text-brand-300" to={`/app/${id}/purchases/bill/new`}>Enter bill</Link>}</td></tr>)}</tbody>
        </table></TableWrap>
      </>}
    </Card>
  );
}

