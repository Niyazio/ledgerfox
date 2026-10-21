import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { Plus } from "lucide-react";
import { useCompany } from "../lib/company";
import { useApi, useAction } from "../lib/hooks";
import { api } from "../lib/api";
import { isQueued, postOrQueue, randomKey } from "../lib/offline";
import { Alert, Button, Card, ConfirmButton, EmptyState, Field, Input, LinkButton, Modal, MoneyInput, PageHeader, Pagination, Select, Spinner, StatusBadge, TableWrap, useToast } from "../components/ui";
import { AccountSelect, ContactSelect, isCashOrBank } from "../components/pickers";
import { fmtDate, today, toInput } from "../lib/format";
import { parseDecimal } from "@shared/money";
import { CURRENCIES } from "@shared/currencies";

export function PaymentList() {
  const { direction = "in" } = useParams();
  const { path, money, id, settings, can } = useCompany();
  const [offset, setOffset] = useState(0);
  const { data, loading, error } = useApi<{ payments: any[]; total: number }>(path(`/payments?direction=${direction}&limit=50&offset=${offset}`));
  const title = direction === "in" ? "Receipts" : "Payments";
  return (
    <>
      <PageHeader title={title} subtitle={direction === "in" ? "Money received from customers" : "Money paid to suppliers"}
        actions={can(direction === "in" ? "sales.post" : "purchase.post") && <LinkButton to={`/app/${id}/payments/${direction}/new`}><Plus className="h-4 w-4" />Record {direction === "in" ? "receipt" : "payment"}</LinkButton>} />
      <Card padded={false}>
        {error && <Alert className="m-3">{error}</Alert>}
        {loading && !data ? <Spinner /> : data && !data.payments.length ? <EmptyState title={`No ${title.toLowerCase()} yet`} /> : data && (
          <TableWrap><table className="table">
            <thead><tr><th>Date</th><th>Number</th><th>{direction === "in" ? "Customer" : "Supplier"}</th><th>Account</th><th>Status</th><th className="num">Amount</th><th className="num">Unapplied</th></tr></thead>
            <tbody>{data.payments.map((p) => (
              <tr key={p.id}>
                <td>{fmtDate(p.payment_date, settings?.company.date_format)}</td>
                <td><Link className="font-medium text-brand-700 hover:underline dark:text-brand-300" to={`/app/${id}/payments/view/${p.id}`}>{p.number}</Link>{p.reference && <span className="block text-xs muted">{p.reference}</span>}</td>
                <td>{p.contact_name}</td><td className="text-sm muted">{p.account_name}</td>
                <td><StatusBadge status={p.status} /></td>
                <td className="num">{money(p.amount, p.currency)}</td>
                <td className="num">{p.status === "posted" && p.amount - p.allocated > 0 ? money(p.amount - p.allocated, p.currency) : ""}</td>
              </tr>
            ))}</tbody>
          </table></TableWrap>
        )}
        {data && <Pagination total={data.total} limit={50} offset={offset} onChange={setOffset} />}
      </Card>
    </>
  );
}

export function PaymentForm() {
  const { direction = "in" } = useParams();
  const [params] = useSearchParams();
  const { path, id, settings, accounts } = useCompany();
  const nav = useNavigate();
  const toast = useToast();
  const base = settings?.company.base_currency ?? "INR";
  const [contactId, setContactId] = useState(params.get("contact") ?? "");
  const [contact, setContact] = useState<any>(null);
  const [v, setV] = useState({ payment_date: today(), account_id: accounts.find((a) => a.system_key === "BANK")?.id ?? "", amount: "", method: "bank_transfer", reference: "", notes: "", fx_rate: "" });
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const [idem] = useState(() => `ui-${randomKey()}`);
  const { busy, error, run } = useAction();
  const docType = direction === "in" ? "invoice" : "bill";
  const contactRes = useApi<any>(contactId ? path(`/contacts/${contactId}`) : null);
  useEffect(() => { setContact(contactRes.data?.contact ?? null); }, [contactRes.data]);
  const openDocs = useApi<{ documents: any[] }>(contactId ? path(`/documents?type=${docType}&status=outstanding&contact_id=${contactId}&limit=200`) : null);
  const currency = contact?.currency ?? base;
  const exp = CURRENCIES[currency]?.exponent ?? 2;
  useEffect(() => {
    const pre = params.get("doc");
    const d = openDocs.data?.documents.find((x) => x.id === pre);
    if (d) { setAlloc({ [d.id]: toInput(d.total - d.amount_settled, d.currency) }); setV((p) => ({ ...p, amount: toInput(d.total - d.amount_settled, d.currency) })); }
  }, [openDocs.data, params]);
  useEffect(() => { if (!v.account_id) { const b = accounts.find((a) => a.system_key === "BANK"); if (b) setV((p) => ({ ...p, account_id: b.id })); } }, [accounts, v.account_id]);
  const allocated = useMemo(() => Object.values(alloc).reduce((t, x) => { try { return t + (x ? parseDecimal(x, exp) : 0); } catch { return NaN; } }, 0), [alloc, exp]);
  const amountMinor = (() => { try { return v.amount ? parseDecimal(v.amount, exp) : 0; } catch { return NaN; } })();
  const autoAllocate = () => {
    let left = amountMinor;
    const next: Record<string, string> = {};
    for (const d of [...(openDocs.data?.documents ?? [])].sort((a, b) => (a.due_date ?? a.issue_date).localeCompare(b.due_date ?? b.issue_date))) {
      if (left <= 0 || d.currency !== currency) break;
      const take = Math.min(left, d.total - d.amount_settled);
      next[d.id] = toInput(take, currency);
      left -= take;
    }
    setAlloc(next);
  };
  const submit = async () => {
    const r = await run(() => postOrQueue<{ id: string }>(path("/payments"), {
      direction, contact_id: contactId, payment_date: v.payment_date, account_id: v.account_id, currency, fx_rate: currency !== base ? v.fx_rate || null : null,
      amount: v.amount, method: v.method, reference: v.reference || null, notes: v.notes || null, idempotency_key: idem,
      allocations: Object.entries(alloc).filter(([, a]) => a && a !== "0").map(([document_id, amount]) => ({ document_id, amount })),
    }, { label: `${direction === "in" ? "Receipt" : "Payment"} ${v.amount} ${currency} (${v.payment_date})` }));
    if (r && isQueued(r)) { toast("info", "Saved on this device — it will be sent when you're back online"); nav(`/app/${id}/payments/${direction}`); return; }
    if (r) { toast("success", "Recorded"); nav(`/app/${id}/payments/view/${r.id}`); }
  };
  return (
    <>
      <PageHeader title={direction === "in" ? "Record receipt" : "Record payment"} back={{ to: `/app/${id}/payments/${direction}`, label: direction === "in" ? "Receipts" : "Payments" }} />
      <Card>
        {error && <Alert className="mb-4">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label={direction === "in" ? "Customer" : "Supplier"} required>{(fid) => <ContactSelect id={fid} kind={direction === "in" ? "customer" : "supplier"} value={contactId} onChange={(cid) => { setContactId(cid); setAlloc({}); }} />}</Field>
          <Field label="Date" required>{(fid) => <Input id={fid} type="date" value={v.payment_date} onChange={(e) => setV({ ...v, payment_date: e.target.value })} />}</Field>
          <Field label={direction === "in" ? "Deposit to" : "Pay from"} required>{(fid) => <AccountSelect id={fid} value={v.account_id} onChange={(a) => setV({ ...v, account_id: a })} filter={isCashOrBank} />}</Field>
          <Field label={`Amount (${currency})`} required>{(fid) => <MoneyInput id={fid} value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} />}</Field>
          <Field label="Method">{(fid) => (
            <Select id={fid} value={v.method} onChange={(e) => setV({ ...v, method: e.target.value })}>
              <option value="bank_transfer">Bank transfer / NEFT / RTGS</option><option value="upi">UPI</option><option value="cash">Cash</option><option value="cheque">Cheque</option><option value="card">Card</option><option value="other">Other</option>
            </Select>
          )}</Field>
          <Field label="Reference (UTR / cheque no.)">{(fid) => <Input id={fid} value={v.reference} onChange={(e) => setV({ ...v, reference: e.target.value })} />}</Field>
          {currency !== base && <Field label={`Rate on payment date (${currency} → ${base})`} hint="Differences from invoice rates post to Exchange Gain / Loss.">{(fid) => <Input id={fid} inputMode="decimal" value={v.fx_rate} onChange={(e) => setV({ ...v, fx_rate: e.target.value })} />}</Field>}
        </div>
        {contactId && (
          <div className="mt-6">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold">Apply to open {docType}s</h3>
              <Button size="sm" variant="secondary" disabled={!amountMinor} onClick={autoAllocate}>Auto-apply oldest first</Button>
            </div>
            {openDocs.data?.documents.length ? (
              <TableWrap><table className="table">
                <thead><tr><th>Number</th><th>Date</th><th>Due</th><th className="num">Balance</th><th className="num w-40">Apply</th></tr></thead>
                <tbody>{openDocs.data.documents.map((d) => (
                  <tr key={d.id} className={d.currency !== currency ? "opacity-50" : ""}>
                    <td>{d.number}</td><td>{fmtDate(d.issue_date, settings?.company.date_format)}</td><td>{fmtDate(d.due_date, settings?.company.date_format)}</td>
                    <td className="num">{toInput(d.total - d.amount_settled, d.currency)} {d.currency}</td>
                    <td><MoneyInput aria-label={`Apply to ${d.number}`} disabled={d.currency !== currency} value={alloc[d.id] ?? ""} onChange={(e) => setAlloc({ ...alloc, [d.id]: e.target.value })} /></td>
                  </tr>
                ))}</tbody>
              </table></TableWrap>
            ) : <p className="text-sm muted">No open {docType}s. The full amount will be recorded as an advance and can be applied later.</p>}
            <p className="mt-2 text-sm">
              Applied {Number.isNaN(allocated) ? "—" : toInput(allocated, currency)} of {Number.isNaN(amountMinor) ? "—" : toInput(amountMinor, currency)}
              {amountMinor - allocated > 0 && <span className="muted"> · {toInput(amountMinor - allocated, currency)} will remain as an advance</span>}
              {allocated > amountMinor && <span className="text-red-600"> · applied amount exceeds the payment</span>}
            </p>
          </div>
        )}
        <Button className="mt-6" loading={busy} disabled={!contactId || !v.account_id || !amountMinor || allocated > amountMinor} onClick={submit}>Save & post</Button>
      </Card>
    </>
  );
}

function ApplyAdvance({ payment, onClose }: { payment: any; onClose: () => void }) {
  const { path, money } = useCompany();
  const { data } = useApi<{ documents: any[] }>(path(`/documents?type=${payment.direction === "in" ? "invoice" : "bill"}&status=outstanding&contact_id=${payment.contact_id}&limit=100`));
  const [docId, setDocId] = useState("");
  const [amount, setAmount] = useState(toInput(payment.amount - payment.allocated, payment.currency));
  const { busy, error, run } = useAction();
  return (
    <Modal open onClose={onClose} title="Apply advance" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!docId} onClick={async () => { if (await run(() => api.post(path(`/payments/${payment.id}/apply`), { document_id: docId, amount }))) onClose(); }}>Apply</Button></>}>
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field label="Document">{(fid) => <Select id={fid} value={docId} onChange={(e) => setDocId(e.target.value)}><option value="">Select…</option>{data?.documents.filter((d) => d.currency === payment.currency).map((d) => <option key={d.id} value={d.id}>{d.number} · {money(d.total - d.amount_settled, d.currency)}</option>)}</Select>}</Field>
        <Field label="Amount">{(fid) => <MoneyInput id={fid} value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
      </div>
    </Modal>
  );
}

export function PaymentView() {
  const { paymentId } = useParams();
  const { path, money, id, settings, can } = useCompany();
  const toast = useToast();
  const { data, loading, error, reload } = useApi<any>(path(`/payments/${paymentId}`));
  const [applying, setApplying] = useState(false);
  if (loading && !data) return <Spinner />;
  if (error) return <Alert>{error}</Alert>;
  const p = data.payment;
  const allocated = data.allocations.reduce((t: number, a: any) => t + a.amount, 0);
  const df = settings?.company.date_format;
  return (
    <>
      <PageHeader title={`${p.direction === "in" ? "Receipt" : "Payment"} ${p.number}`} subtitle={p.contact_name} back={{ to: `/app/${id}/payments/${p.direction}`, label: p.direction === "in" ? "Receipts" : "Payments" }}
        actions={<>
          <LinkButton variant="secondary" to={`/print/${id}/payment/${p.id}`}>Print receipt</LinkButton>
          {p.status === "posted" && p.amount - allocated > 0 && can(p.direction === "in" ? "sales.post" : "purchase.post") && <Button onClick={() => setApplying(true)}>Apply advance</Button>}
          {p.status === "posted" && can(p.direction === "in" ? "sales.void" : "purchase.void") && <ConfirmButton label="Void" title="Void payment?" withReason confirmLabel="Void" body="A reversing journal is posted and the amounts applied to invoices/bills are released." onConfirm={async (reason) => { try { await api.post(path(`/payments/${p.id}/void`), { reason: reason ?? null }); toast("success", "Payment voided"); reload(); } catch (e) { toast("error", (e as Error).message); } }} />}
        </>} />
      <Card className="print-area">
        <div className="grid gap-4 text-sm sm:grid-cols-4">
          <div><p className="muted">Date</p><p className="font-medium">{fmtDate(p.payment_date, df)}</p></div>
          <div><p className="muted">Amount</p><p className="font-medium">{money(p.amount, p.currency)}</p>{p.currency !== settings?.company.base_currency && <p className="text-xs muted">{money(p.amount_base)} @ {p.fx_rate_scaled / 1e9}</p>}</div>
          <div><p className="muted">{p.direction === "in" ? "Deposited to" : "Paid from"}</p><p>{p.account_name}</p></div>
          <div><p className="muted">Status</p><StatusBadge status={p.status} /></div>
          <div><p className="muted">Method / reference</p><p>{[p.method?.replace("_", " "), p.reference].filter(Boolean).join(" · ") || "—"}</p></div>
          <div><p className="muted">Journal</p><Link className="text-brand-700 hover:underline dark:text-brand-300" to={`/app/${id}/journals/${p.journal_entry_id}`}>{p.journal_number}</Link></div>
          <div><p className="muted">Unapplied</p><p>{money(p.amount - allocated, p.currency)}</p></div>
        </div>
        <h3 className="mt-6 text-sm font-semibold">Applied to</h3>
        {data.allocations.length ? (
          <TableWrap><table className="table mt-2">
            <thead><tr><th>Document</th><th>Date</th><th className="num">Amount</th></tr></thead>
            <tbody>{data.allocations.map((a: any) => (
              <tr key={a.id}><td><Link className="text-brand-700 hover:underline dark:text-brand-300" to={`/app/${id}/${a.doc_type === "invoice" ? "sales" : "purchases"}/${a.doc_type}/${a.document_id}`}>{a.number}</Link></td><td>{fmtDate(a.allocation_date, df)}</td><td className="num">{money(a.amount, p.currency)}</td></tr>
            ))}</tbody>
          </table></TableWrap>
        ) : <p className="mt-2 text-sm muted">Not applied to any document (advance).</p>}
      </Card>
      {applying && <ApplyAdvance payment={{ ...p, allocated }} onClose={() => { setApplying(false); reload(); }} />}
    </>
  );
}
