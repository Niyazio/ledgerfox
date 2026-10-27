import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Repeat } from "lucide-react";
import { useCompany } from "../lib/company";
import { useApi, useAction } from "../lib/hooks";
import { api, errorMessage } from "../lib/api";
import { Alert, Badge, Button, Card, ConfirmButton, EmptyState, Field, Input, Modal, PageHeader, Select, Spinner, TableWrap, useToast } from "../components/ui";
import { fmtDate, today } from "../lib/format";

/** "Repeat" on an issued invoice: create a schedule that copies it every week/month/quarter/year. */
export function RepeatButton({ invoiceId, number, issueDate }: { invoiceId: string; number: string; issueDate: string }) {
  const { path, can } = useCompany();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const next = (() => { const d = new Date(`${issueDate}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString().slice(0, 10); })();
  const [v, setV] = useState({ name: `Repeat of ${number}`, frequency: "monthly", next_date: next, end_date: "", auto_issue: false });
  const { busy, error, run } = useAction();
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}><Repeat className="h-4 w-4" />Repeat</Button>
      <Modal open={open} onClose={() => setOpen(false)} title={`Repeat ${number}`}
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button loading={busy} onClick={async () => { if (await run(() => api.post(path("/recurring"), { template_document_id: invoiceId, ...v, end_date: v.end_date || null }))) { setOpen(false); toast("success", "Schedule saved"); } }}>Save schedule</Button></>}>
        {error && <Alert className="mb-3">{error}</Alert>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" className="sm:col-span-2">{(fid) => <Input id={fid} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />}</Field>
          <Field label="Every">{(fid) => <Select id={fid} value={v.frequency} onChange={(e) => setV({ ...v, frequency: e.target.value })}><option value="weekly">Week</option><option value="monthly">Month</option><option value="quarterly">Quarter</option><option value="yearly">Year</option></Select>}</Field>
          <Field label="Next invoice date">{(fid) => <Input id={fid} type="date" value={v.next_date} onChange={(e) => setV({ ...v, next_date: e.target.value })} />}</Field>
          <Field label="End date (optional)">{(fid) => <Input id={fid} type="date" value={v.end_date} onChange={(e) => setV({ ...v, end_date: e.target.value })} />}</Field>
          {can("sales.post") && <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={v.auto_issue} onChange={(e) => setV({ ...v, auto_issue: e.target.checked })} />Issue automatically (otherwise each one is created as a draft for you to check)</label>}
        </div>
        <p className="mt-3 text-xs muted">The same customer, items, prices and taxes are copied. Invoices are created when anyone opens LedgerFox on or after the date (or with “Create due invoices now”).</p>
      </Modal>
    </>
  );
}

/** Runs due schedules once a day per browser when someone who can bill opens the app. */
export function useRecurringAutoRun() {
  const { path, can, id } = useCompany();
  const toast = useToast();
  useEffect(() => {
    if (!can("sales.create")) return;
    const key = `ledgerfox-recurring-${id}`;
    try { if (localStorage.getItem(key) === today()) return; localStorage.setItem(key, today()); } catch { /* storage unavailable */ }
    api.post<{ created: unknown[] }>(path("/recurring/run?auto=1")).then((r) => { if (r.created.length) toast("info", `${r.created.length} recurring invoice(s) created`); }).catch(() => undefined);
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
}

export default function Recurring() {
  const { path, money, id, settings } = useCompany();
  const toast = useToast();
  const { data, loading, error, reload } = useApi<{ schedules: any[]; due: number }>(path("/recurring"));
  const df = settings?.company.date_format;
  const runNow = async () => {
    try {
      const r = await api.post<{ created: any[]; errors: any[] }>(path("/recurring/run"));
      toast(r.errors.length ? "error" : "success", `${r.created.length} invoice(s) created${r.errors.length ? `; ${r.errors[0].message}` : ""}`);
      reload();
    } catch (e) { toast("error", errorMessage(e)); }
  };
  const toggle = async (s: any) => { try { await api.patch(path(`/recurring/${s.id}`), { is_active: !s.is_active }); reload(); } catch (e) { toast("error", errorMessage(e)); } };
  return (
    <>
      <PageHeader title="Recurring invoices" subtitle="Rent, maintenance contracts, subscriptions and fees billed on a schedule. Create one with “Repeat” on any issued invoice."
        actions={<Button disabled={!data?.due} onClick={() => void runNow()}>Create due invoices now{data?.due ? ` (${data.due})` : ""}</Button>} />
      {error && <Alert>{error}</Alert>}
      <Card padded={false}>
        {loading && !data ? <Spinner /> : !data?.schedules.length ? <EmptyState title="No recurring invoices" body="Open an issued invoice and choose Repeat." /> : (
          <TableWrap><table className="table text-sm">
            <thead><tr><th>Name</th><th>Customer</th><th>Every</th><th>Next</th><th>Ends</th><th className="num">Amount</th><th>Mode</th><th>Last created</th><th /></tr></thead>
            <tbody>{data.schedules.map((s) => (
              <tr key={s.id} className={s.is_active ? "" : "opacity-60"}>
                <td>{s.name}<span className="block text-xs muted">from <Link className="underline" to={`/app/${id}/sales/invoice/${s.template_document_id}`}>{s.template_number}</Link></span></td>
                <td>{s.contact_name}</td><td className="capitalize">{s.frequency.replace("ly", "").replace("quarter", "quarter")}</td>
                <td>{fmtDate(s.next_date, df)}{s.is_active && s.next_date <= today() ? <span className="ml-1"><Badge color="amber">due</Badge></span> : null}</td>
                <td>{s.end_date ? fmtDate(s.end_date, df) : "—"}</td><td className="num">{money(s.total, s.currency)}</td>
                <td>{s.auto_issue ? "Issue" : "Draft"}</td><td>{s.last_document_id ? <Link className="underline" to={`/app/${id}/sales/invoice/${s.last_document_id}`}>{s.last_number ?? "Draft"}</Link> : "—"}</td>
                <td className="whitespace-nowrap text-right"><Button size="sm" variant="ghost" onClick={() => void toggle(s)}>{s.is_active ? "Pause" : "Resume"}</Button>
                  <ConfirmButton size="sm" label="Delete" title="Delete schedule?" body="Invoices already created are kept." confirmLabel="Delete" onConfirm={async () => { await api.del(path(`/recurring/${s.id}`)); reload(); }} /></td>
              </tr>
            ))}</tbody>
          </table></TableWrap>
        )}
      </Card>
    </>
  );
}
