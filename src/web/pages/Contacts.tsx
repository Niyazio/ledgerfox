import { useState } from "react";
import { Link, useParams } from "react-router";
import { Plus, Download } from "lucide-react";
import { useCompany } from "../lib/company";
import { useApi } from "../lib/hooks";
import { api, errorMessage } from "../lib/api";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, LinkButton, Modal, PageHeader, Pagination, Select, Spinner, StatusBadge, TableWrap, Textarea, useToast } from "../components/ui";
import { CURRENCY_OPTIONS } from "../components/pickers";
import { INDIA_STATES } from "@shared/tax";
import { DOC_LABELS, fmtDate, toInput } from "../lib/format";
import { downloadCsv } from "../lib/csv";

export function ContactForm({ kind, initial, onClose }: { kind: "customer" | "supplier"; initial?: any; onClose: (id?: string) => void }) {
  const { path, settings } = useCompany();
  const toast = useToast();
  const [v, setV] = useState({
    kind: initial?.kind ?? kind, name: initial?.name ?? "", email: initial?.email ?? "", phone: initial?.phone ?? "", tax_id: initial?.tax_id ?? "", pan: initial?.pan ?? "",
    state_code: initial?.state_code ?? "", country: initial?.country ?? settings?.company.country ?? "IN", billing_address: initial?.billing_address ?? "",
    shipping_address: initial?.shipping_address ?? "", currency: initial?.currency ?? "", payment_terms_days: initial?.payment_terms_days ?? 30,
    credit_limit: initial?.credit_limit ? toInput(initial.credit_limit, initial.currency ?? settings?.company.base_currency ?? "INR") : "", notes: initial?.notes ?? "", is_active: initial ? Boolean(initial.is_active) : true,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, val: unknown) => setV((p) => ({ ...p, [k]: val }));
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const body = { ...v, payment_terms_days: Number(v.payment_terms_days), currency: v.currency || null, state_code: v.state_code || null, tax_id: v.tax_id || null, credit_limit: v.credit_limit || null };
      const r = initial ? await api.put(path(`/contacts/${initial.id}`), body) : await api.post(path("/contacts"), body);
      toast("success", initial ? "Saved" : `${v.kind === "supplier" ? "Supplier" : "Customer"} added`);
      onClose(initial?.id ?? r.id);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  const india = v.country === "IN";
  return (
    <Modal open wide onClose={() => onClose()} title={initial ? `Edit ${initial.name}` : `New ${kind}`}
      footer={<><Button variant="secondary" onClick={() => onClose()}>Cancel</Button><Button loading={busy} onClick={save}>Save</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        {error && <Alert className="sm:col-span-2">{error}</Alert>}
        <Field label="Name" required>{(id) => <Input id={id} value={v.name} onChange={(e) => set("name", e.target.value)} />}</Field>
        <Field label="Type">{(id) => <Select id={id} value={v.kind} onChange={(e) => set("kind", e.target.value)}><option value="customer">Customer</option><option value="supplier">Supplier</option><option value="both">Customer & supplier</option></Select>}</Field>
        <Field label="Email">{(id) => <Input id={id} type="email" value={v.email} onChange={(e) => set("email", e.target.value)} />}</Field>
        <Field label="Phone">{(id) => <Input id={id} value={v.phone} onChange={(e) => set("phone", e.target.value)} />}</Field>
        <Field label="Country">{(id) => <Input id={id} value={v.country} maxLength={2} className="uppercase" onChange={(e) => set("country", e.target.value.toUpperCase())} />}</Field>
        <Field label="Currency" hint="Leave as default to invoice in your base currency.">{(id) => (
          <Select id={id} value={v.currency} onChange={(e) => set("currency", e.target.value)}><option value="">Default ({settings?.company.base_currency})</option>{CURRENCY_OPTIONS.map((c) => <option key={c}>{c}</option>)}</Select>
        )}</Field>
        {india && <>
          <Field label="GSTIN" hint="Validated with its check digit; fills the state automatically.">{(id) => <Input id={id} value={v.tax_id} maxLength={15} className="font-mono uppercase" onChange={(e) => { set("tax_id", e.target.value); if (e.target.value.length >= 2 && /^\d\d/.test(e.target.value)) set("state_code", e.target.value.slice(0, 2)); }} />}</Field>
          <Field label="State / place of supply">{(id) => (
            <Select id={id} value={v.state_code} onChange={(e) => set("state_code", e.target.value)}><option value="">Select…</option>{Object.entries(INDIA_STATES).map(([k, n]) => <option key={k} value={k}>{k} · {n}</option>)}</Select>
          )}</Field>
          <Field label="PAN">{(id) => <Input id={id} value={v.pan} maxLength={10} className="font-mono uppercase" onChange={(e) => set("pan", e.target.value.toUpperCase())} />}</Field>
        </>}
        {!india && <Field label="Tax ID">{(id) => <Input id={id} value={v.tax_id} onChange={(e) => set("tax_id", e.target.value)} />}</Field>}
        <Field label="Payment terms (days)">{(id) => <Input id={id} type="number" min={0} max={365} value={v.payment_terms_days} onChange={(e) => set("payment_terms_days", e.target.value)} />}</Field>
        <Field label="Credit limit">{(id) => <Input id={id} inputMode="decimal" value={v.credit_limit} onChange={(e) => set("credit_limit", e.target.value)} />}</Field>
        <Field label="Billing address" className="sm:col-span-2">{(id) => <Textarea id={id} rows={2} value={v.billing_address} onChange={(e) => set("billing_address", e.target.value)} />}</Field>
        <Field label="Shipping address" className="sm:col-span-2">{(id) => <Textarea id={id} rows={2} value={v.shipping_address} onChange={(e) => set("shipping_address", e.target.value)} />}</Field>
        <Field label="Notes" className="sm:col-span-2">{(id) => <Textarea id={id} rows={2} value={v.notes} onChange={(e) => set("notes", e.target.value)} />}</Field>
        {initial && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={v.is_active} onChange={(e) => set("is_active", e.target.checked)} /> Active</label>}
      </div>
    </Modal>
  );
}

export function ContactList({ kind }: { kind: "customer" | "supplier" }) {
  const { path, money, id, can } = useCompany();
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  const [adding, setAdding] = useState(false);
  const { data, loading, error, reload } = useApi<{ contacts: any[]; total: number }>(path(`/contacts?kind=${kind}&limit=50&offset=${offset}&q=${encodeURIComponent(q)}`));
  const title = kind === "customer" ? "Customers" : "Suppliers";
  const bal = kind === "customer" ? "receivable" : "payable";
  return (
    <>
      <PageHeader title={title} actions={<>
        {data && <Button variant="secondary" onClick={() => downloadCsv(`${title.toLowerCase()}.csv`, ["Name", "Email", "Phone", "Tax ID", "State", "Currency", "Outstanding (doc currency sum)"], data.contacts.map((c) => [c.name, c.email, c.phone, c.tax_id, c.state_code, c.currency, toInput(c[bal], c.currency ?? "INR")]))}><Download className="h-4 w-4" />CSV</Button>}
        {can("masters.write") && <Button onClick={() => setAdding(true)}><Plus className="h-4 w-4" />New {kind}</Button>}
      </>} />
      <Card padded={false}>
        <div className="border-b border-[var(--border)] p-3"><Input placeholder="Search name, email, GSTIN…" value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} className="max-w-xs" aria-label={`Search ${title}`} /></div>
        {error && <Alert className="m-3">{error}</Alert>}
        {loading && !data ? <Spinner /> : data && !data.contacts.length ? (
          <EmptyState title={`No ${title.toLowerCase()} yet`} action={can("masters.write") && <Button onClick={() => setAdding(true)}>Add {kind}</Button>} />
        ) : data && (
          <TableWrap>
            <table className="table">
              <thead><tr><th>Name</th><th>Contact</th><th>Tax ID</th><th className="num">Outstanding</th></tr></thead>
              <tbody>
                {data.contacts.map((c) => (
                  <tr key={c.id} className={c.is_active ? "" : "opacity-60"}>
                    <td><Link className="font-medium text-brand-700 hover:underline dark:text-brand-300" to={`/app/${id}/contacts/${c.id}`}>{c.name}</Link>{c.kind === "both" && <span className="ml-2"><Badge>both</Badge></span>}</td>
                    <td className="text-sm muted">{[c.email, c.phone].filter(Boolean).join(" · ")}</td>
                    <td className="font-mono text-xs">{c.tax_id}</td>
                    <td className="num">{c[bal] ? money(c[bal], c.currency ?? undefined) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
        {data && <Pagination total={data.total} limit={50} offset={offset} onChange={setOffset} />}
      </Card>
      {adding && <ContactForm kind={kind} onClose={(nid) => { setAdding(false); if (nid) reload(); }} />}
    </>
  );
}

export function ContactView() {
  const { path, money, id, settings, can } = useCompany();
  const { contactId } = useParams();
  const { data, error, loading, reload } = useApi<any>(path(`/contacts/${contactId}`));
  const [editing, setEditing] = useState(false);
  if (loading && !data) return <Spinner />;
  if (error) return <Alert>{error}</Alert>;
  const c = data.contact;
  const isCustomer = c.kind !== "supplier";
  const df = settings?.company.date_format;
  const docLink = (d: any) => `/app/${id}/${["quote", "sales_order", "invoice", "credit_note"].includes(d.doc_type) ? "sales" : "purchases"}/${d.doc_type}/${d.id}`;
  return (
    <>
      <PageHeader title={c.name} subtitle={[c.email, c.phone, c.tax_id].filter(Boolean).join(" · ")} back={{ to: `/app/${id}/${isCustomer ? "customers" : "suppliers"}`, label: isCustomer ? "Customers" : "Suppliers" }}
        actions={<>
          <LinkButton variant="secondary" to={`/app/${id}/reports/statement/${c.id}`}>Statement</LinkButton>
          {can("masters.write") && <Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button>}
          {isCustomer && can("txn.write") && <LinkButton to={`/app/${id}/sales/invoice/new?contact=${c.id}`}>New invoice</LinkButton>}
          {c.kind !== "customer" && can("txn.write") && <LinkButton to={`/app/${id}/purchases/bill/new?contact=${c.id}`}>New bill</LinkButton>}
        </>} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Details">
          <dl className="space-y-2 text-sm">
            <div><dt className="muted">Billing address</dt><dd className="whitespace-pre-line">{c.billing_address || "—"}</dd></div>
            <div><dt className="muted">State</dt><dd>{c.state_code ? `${c.state_code} · ${INDIA_STATES[c.state_code] ?? ""}` : "—"}</dd></div>
            <div><dt className="muted">Currency</dt><dd>{c.currency ?? settings?.company.base_currency}</dd></div>
            <div><dt className="muted">Payment terms</dt><dd>{c.payment_terms_days} days</dd></div>
            {c.notes && <div><dt className="muted">Notes</dt><dd className="whitespace-pre-line">{c.notes}</dd></div>}
          </dl>
        </Card>
        <Card title="Documents" padded={false} className="lg:col-span-2">
          {data.documents.length ? (
            <TableWrap><table className="table">
              <thead><tr><th>Date</th><th>Document</th><th>Status</th><th className="num">Total</th><th className="num">Balance</th></tr></thead>
              <tbody>{data.documents.map((d: any) => (
                <tr key={d.id}>
                  <td>{fmtDate(d.issue_date, df)}</td>
                  <td><Link className="text-brand-700 hover:underline dark:text-brand-300" to={docLink(d)}>{DOC_LABELS[d.doc_type].one} {d.number ?? "(draft)"}</Link></td>
                  <td><StatusBadge status={d.status} due={d.due_date} outstanding={["invoice", "bill"].includes(d.doc_type) ? d.total - d.amount_settled : undefined} /></td>
                  <td className="num">{money(d.total, d.currency)}</td>
                  <td className="num">{d.status === "posted" ? money(d.total - d.amount_settled, d.currency) : ""}</td>
                </tr>
              ))}</tbody>
            </table></TableWrap>
          ) : <EmptyState title="No documents yet" />}
        </Card>
      </div>
      {editing && <ContactForm kind={isCustomer ? "customer" : "supplier"} initial={c} onClose={(nid) => { setEditing(false); if (nid) reload(); }} />}
    </>
  );
}
