import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Plus, Paperclip, Sparkles, Repeat } from "lucide-react";
import { useCompany } from "../lib/company";
import { useApi, useAction, useDebounced } from "../lib/hooks";
import { api, errorMessage } from "../lib/api";
import { isQueued, postOrQueue } from "../lib/offline";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Modal, MoneyInput, PageHeader, Pagination, Select, Spinner, StatusBadge, TableWrap, Tabs, useToast } from "../components/ui";
import { AccountSelect, ContactSelect, DimensionSelect, TaxSelect } from "../components/pickers";
import { fmtDate, today, toInput } from "../lib/format";

function Attachments({ entityId, canEdit }: { entityId: string; canEdit: boolean }) {
  const { path } = useCompany();
  const toast = useToast();
  const { data, reload } = useApi<{ attachments: any[] }>(path(`/attachments?entity_type=expense&entity_id=${entityId}`));
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-2">
      <ul className="space-y-1 text-sm">
        {data?.attachments.map((a) => (
          <li key={a.id} className="flex items-center justify-between gap-2">
            <a className="text-brand-700 hover:underline dark:text-brand-300" href={path(`/attachments/${a.id}`)} target="_blank" rel="noreferrer"><Paperclip className="mr-1 inline h-3.5 w-3.5" />{a.filename}</a>
            <span className="text-xs muted">{Math.ceil(a.size_bytes / 1024)} KB</span>
          </li>
        ))}
        {data && !data.attachments.length && <li className="muted">No receipts attached.</li>}
      </ul>
      {canEdit && (
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-brand-700 dark:text-brand-300">
          <input type="file" className="sr-only" accept="application/pdf,image/png,image/jpeg,image/webp" disabled={busy} onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            if (f.size > 1024 * 1024) return toast("error", "Receipts must be 1 MB or smaller (free storage limits). Compress or photograph at lower resolution.");
            setBusy(true);
            try { await api.upload(path(`/attachments?entity_type=expense&entity_id=${entityId}&filename=${encodeURIComponent(f.name)}`), f); reload(); toast("success", "Receipt attached"); }
            catch (err) { toast("error", errorMessage(err)); } finally { setBusy(false); }
          }} />
          <Paperclip className="h-4 w-4" />{busy ? "Uploading…" : "Attach receipt (PDF/JPG/PNG/WebP, max 1 MB)"}
        </label>
      )}
    </div>
  );
}

function ExpenseForm({ initial, onClose }: { initial?: any; onClose: (changed: boolean) => void }) {
  const { path, accounts, settings, can } = useCompany();
  const toast = useToast();
  const [v, setV] = useState({
    expense_date: initial?.expense_date ?? today(), contact_id: initial?.contact_id ?? "", category_account_id: initial?.category_account_id ?? "",
    paid_from_account_id: initial?.paid_from_account_id ?? accounts.find((a) => a.system_key === "BANK")?.id ?? "", description: initial?.description ?? "",
    amount: initial ? toInput(initial.amount, initial.currency) : "", tax_code_id: initial?.tax_code_id ?? "", department_id: initial?.department_id ?? "", project_id: initial?.project_id ?? "", cost_centre_id: initial?.cost_centre_id ?? "",
  });
  const [recurring, setRecurring] = useState({ on: false, name: "", frequency: "monthly", next_run_date: "" });
  const { busy, error, run } = useAction();
  const desc = useDebounced(v.description, 400);
  const sugg = useApi<{ suggestions: any[] }>(!initial && (desc.length >= 3 || v.contact_id) ? path(`/expenses/suggest-category?description=${encodeURIComponent(desc)}&contact_id=${v.contact_id}`) : null);
  const editable = !initial || ["draft", "rejected"].includes(initial.status);
  const save = async (andApprove: boolean) => {
    const body = { ...v, contact_id: v.contact_id || null, tax_code_id: v.tax_code_id || null, department_id: v.department_id || null, project_id: v.project_id || null, cost_centre_id: v.cost_centre_id || null };
    const r = await run(async () => {
      if (recurring.on && !navigator.onLine) throw new Error("Recurring templates need an internet connection. Untick “repeat” to save this expense offline.");
      const res = initial ? await api.put(path(`/expenses/${initial.id}`), body).then(() => ({ id: initial.id })) : await postOrQueue(path("/expenses"), body, { label: `Expense: ${v.description} (${v.expense_date})`, then: andApprove ? "/approve" : undefined });
      if (isQueued(res)) return res;
      if (recurring.on) {
        const { expense_date: _d, ...tpl } = body;
        await api.post(path("/expenses/templates"), { name: recurring.name || v.description, frequency: recurring.frequency, next_run_date: recurring.next_run_date || v.expense_date, expense: tpl });
      }
      if (andApprove) await api.post(path(`/expenses/${res.id}/approve`));
      return res;
    });
    if (r && isQueued(r)) { toast("info", "Saved on this device — it will be sent when you're back online"); onClose(true); return; }
    if (r) { toast("success", andApprove ? "Expense posted" : "Saved"); onClose(true); }
  };
  return (
    <Modal open wide onClose={() => onClose(false)} title={initial ? `Expense ${initial.number ?? "(draft)"}` : "New expense"}
      footer={editable ? <>
        <Button variant="secondary" onClick={() => onClose(false)}>Cancel</Button>
        <Button variant="secondary" loading={busy} onClick={() => save(false)}>Save draft</Button>
        {can("expense.approve") && <Button loading={busy} onClick={() => save(true)} title="Owners and administrators may approve their own expenses">Save & post</Button>}
      </> : <Button variant="secondary" onClick={() => onClose(false)}>Close</Button>}>
      <div className="grid gap-4 sm:grid-cols-2">
        {error && <Alert className="sm:col-span-2">{error}</Alert>}
        {initial?.rejection_reason && <Alert kind="warning" className="sm:col-span-2">Rejected: {initial.rejection_reason}</Alert>}
        <Field label="Description" required className="sm:col-span-2">{(id) => <Input id={id} disabled={!editable} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} />}</Field>
        <Field label="Date" required>{(id) => <Input id={id} type="date" disabled={!editable} value={v.expense_date} onChange={(e) => setV({ ...v, expense_date: e.target.value })} />}</Field>
        <Field label="Supplier (optional)">{(id) => <ContactSelect id={id} kind="supplier" value={v.contact_id} onChange={(cid) => setV({ ...v, contact_id: cid })} />}</Field>
        <Field label="Category" required>{(id) => <AccountSelect id={id} disabled={!editable} value={v.category_account_id} onChange={(a) => setV({ ...v, category_account_id: a })} filter={(a) => a.type === "expense" || a.subtype === "fixed_asset" || a.subtype === "current_asset"} />}</Field>
        <Field label="Paid from" required hint="Choose Accounts Payable if not yet paid.">{(id) => <AccountSelect id={id} disabled={!editable} value={v.paid_from_account_id} onChange={(a) => setV({ ...v, paid_from_account_id: a })} filter={(a) => ["cash", "bank", "payable", "current_liability"].includes(a.subtype)} />}</Field>
        {!!sugg.data?.suggestions.length && editable && (
          <div className="sm:col-span-2 rounded-lg border border-dashed border-brand-300 p-3 text-sm dark:border-brand-800">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-brand-700 dark:text-brand-300"><Sparkles className="h-3.5 w-3.5" />Suggested categories (rule-based — please review)</p>
            <div className="flex flex-wrap gap-2">
              {sugg.data.suggestions.map((s) => (
                <button key={s.account_id} type="button" onClick={() => setV({ ...v, category_account_id: s.account_id })} className="rounded-full border border-[var(--border)] px-3 py-1 hover:bg-[var(--surface-2)]" title={s.reason}>
                  {s.account_name} <span className="text-xs muted">· {s.reason}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <Field label={`Amount before tax (${settings?.company.base_currency})`} required>{(id) => <MoneyInput id={id} disabled={!editable} value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} />}</Field>
        <Field label="Input tax">{(id) => <TaxSelect id={id} value={v.tax_code_id} onChange={(t) => setV({ ...v, tax_code_id: t })} />}</Field>
        <div className="grid gap-2 sm:col-span-2 sm:grid-cols-3">
          <DimensionSelect kind="departments" value={v.department_id} onChange={(x) => setV({ ...v, department_id: x })} />
          <DimensionSelect kind="projects" value={v.project_id} onChange={(x) => setV({ ...v, project_id: x })} />
          <DimensionSelect kind="cost_centres" value={v.cost_centre_id} onChange={(x) => setV({ ...v, cost_centre_id: x })} />
        </div>
        {!initial && (
          <div className="sm:col-span-2 space-y-3 rounded-lg bg-[var(--surface-2)] p-3">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={recurring.on} onChange={(e) => setRecurring({ ...recurring, on: e.target.checked })} /><Repeat className="h-4 w-4" /> Also save as a recurring template</label>
            {recurring.on && <div className="grid gap-3 sm:grid-cols-3">
              <Input placeholder="Template name" value={recurring.name} onChange={(e) => setRecurring({ ...recurring, name: e.target.value })} aria-label="Template name" />
              <Select value={recurring.frequency} onChange={(e) => setRecurring({ ...recurring, frequency: e.target.value })} aria-label="Frequency"><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="yearly">Yearly</option></Select>
              <Input type="date" value={recurring.next_run_date} onChange={(e) => setRecurring({ ...recurring, next_run_date: e.target.value })} aria-label="Next run date" title="Next occurrence" />
            </div>}
          </div>
        )}
        {initial && <div className="sm:col-span-2"><p className="mb-1 text-sm font-medium">Receipts</p><Attachments entityId={initial.id} canEdit={can("expense.create")} /></div>}
      </div>
    </Modal>
  );
}

export default function Expenses() {
  const { path, money, settings, can } = useCompany();
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const [tab, setTab] = useState<"list" | "templates">("list");
  const status = params.get("status") ?? "";
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState<any>(null);
  const { data, loading, error, reload } = useApi<{ expenses: any[]; total: number }>(path(`/expenses?limit=50&offset=${offset}&status=${status}`));
  const templates = useApi<{ templates: any[] }>(tab === "templates" ? path("/expenses/templates") : null);
  useEffect(() => {
    const open = params.get("open");
    if (open && data) { const e = data.expenses.find((x) => x.id === open); if (e) setEditing(e); }
  }, [params, data]);
  const act = async (fn: () => Promise<unknown>, msg: string) => { try { await fn(); toast("success", msg); reload(); } catch (e) { toast("error", errorMessage(e)); } };
  return (
    <>
      <PageHeader title="Expenses" subtitle="Record spending, attach receipts and route claims for approval before they post."
        actions={can("expense.create") && <Button onClick={() => setEditing("new")}><Plus className="h-4 w-4" />New expense</Button>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: "list", label: "Expenses" }, { value: "templates", label: "Recurring templates" }]} />
      {tab === "list" ? (
        <Card padded={false}>
          <div className="border-b border-[var(--border)] p-3">
            <Select className="max-w-[14rem]" value={status} onChange={(e) => { setParams(e.target.value ? { status: e.target.value } : {}); setOffset(0); }} aria-label="Status filter">
              <option value="">All</option><option value="draft">Draft</option><option value="submitted">Awaiting approval</option><option value="rejected">Rejected</option><option value="posted">Posted</option>
            </Select>
          </div>
          {error && <Alert className="m-3">{error}</Alert>}
          {loading && !data ? <Spinner /> : data && !data.expenses.length ? <EmptyState title="No expenses" /> : data && (
            <TableWrap><table className="table">
              <thead><tr><th>Date</th><th>Description</th><th>Category</th><th>Status</th><th className="num">Total</th><th className="no-print" /></tr></thead>
              <tbody>{data.expenses.map((e) => (
                <tr key={e.id}>
                  <td className="whitespace-nowrap">{fmtDate(e.expense_date, settings?.company.date_format)}</td>
                  <td><button className="text-left font-medium text-brand-700 hover:underline dark:text-brand-300" onClick={() => setEditing(e)}>{e.description}</button>
                    <span className="block text-xs muted">{[e.number, e.contact_name, e.created_by_name].filter(Boolean).join(" · ")}{e.attachment_count ? ` · 📎 ${e.attachment_count}` : ""}{e.template_id ? " · recurring" : ""}</span></td>
                  <td className="text-sm">{e.category_name}</td>
                  <td><StatusBadge status={e.status} /></td>
                  <td className="num">{money(e.total, e.currency)}</td>
                  <td className="whitespace-nowrap text-right no-print">
                    {e.status === "draft" && can("expense.create") && <Button size="sm" variant="ghost" onClick={() => act(() => api.post(path(`/expenses/${e.id}/submit`)), "Submitted for approval")}>Submit</Button>}
                    {["draft", "submitted"].includes(e.status) && can("expense.approve") && <Button size="sm" variant="ghost" onClick={() => act(() => api.post(path(`/expenses/${e.id}/approve`)), "Approved & posted")}>Approve</Button>}
                    {e.status === "submitted" && can("expense.approve") && <Button size="sm" variant="ghost" onClick={() => { const reason = prompt("Reason for rejection"); if (reason) act(() => api.post(path(`/expenses/${e.id}/reject`), { reason }), "Rejected"); }}>Reject</Button>}
                    {e.status === "posted" && e.journal_entry_id && <Link className="text-xs text-brand-700 hover:underline dark:text-brand-300" to={`../journals/${e.journal_entry_id}`} relative="path">Journal</Link>}
                  </td>
                </tr>
              ))}</tbody>
            </table></TableWrap>
          )}
          {data && <Pagination total={data.total} limit={50} offset={offset} onChange={setOffset} />}
        </Card>
      ) : (
        <Card padded={false} title="Recurring templates" actions={can("expense.create") && <Button size="sm" onClick={() => act(async () => { const r = await api.post(path("/expenses/templates/run")); toast("info", `${r.created} draft expense(s) generated`); templates.reload(); }, "Templates processed")}>Generate due drafts</Button>}>
          <p className="px-4 pt-3 text-sm muted">Templates create <strong>draft</strong> expenses when you click “Generate due drafts”. Drafts still need approval before they post. (No background scheduler runs on the free plan.)</p>
          {templates.data?.templates.length ? (
            <TableWrap><table className="table mt-3">
              <thead><tr><th>Name</th><th>Frequency</th><th>Next run</th><th>Status</th><th /></tr></thead>
              <tbody>{templates.data.templates.map((t) => (
                <tr key={t.id}><td>{t.name}</td><td>{t.frequency}</td><td>{fmtDate(t.next_run_date, settings?.company.date_format)}</td><td>{t.is_active ? <Badge color="green">Active</Badge> : <Badge>Paused</Badge>}</td>
                  <td className="text-right">{can("expense.create") && <Button size="sm" variant="ghost" onClick={() => act(async () => { await api.patch(path(`/expenses/templates/${t.id}`), { is_active: !t.is_active }); templates.reload(); }, t.is_active ? "Paused" : "Resumed")}>{t.is_active ? "Pause" : "Resume"}</Button>}</td></tr>
              ))}</tbody>
            </table></TableWrap>
          ) : <EmptyState title="No recurring templates" body="Tick “Also save as a recurring template” when creating an expense." />}
        </Card>
      )}
      {editing && <ExpenseForm initial={editing === "new" ? undefined : editing} onClose={(changed) => { setEditing(null); if (changed) reload(); }} />}
    </>
  );
}
