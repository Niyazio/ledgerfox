import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { Plus } from "lucide-react";
import { useCompany } from "../lib/company";
import { useApi } from "../lib/hooks";
import { api, errorMessage } from "../lib/api";
import { isQueued, postOrQueue } from "../lib/offline";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, LinkButton, Modal, PageHeader, Pagination, Select, Spinner, StatusBadge, Stat, TableWrap, Tabs, Textarea, useToast, DownloadButtons } from "../components/ui";
import { CURRENCY_OPTIONS, CountrySelect, RegionSelect } from "../components/pickers";
import { regionsFor, regionLabel, regionName, regionProblem } from "@shared/regions";
import { countryPack } from "@shared/countries";
import { DOC_LABELS, fmtDate, pct, qty, toInput } from "../lib/format";
import { downloadCsv } from "../lib/csv";
import { docPath, paymentPath, productPath } from "../lib/links";

export function ContactForm({ kind, initial, onClose }: { kind: "customer" | "supplier"; initial?: any; onClose: (id?: string) => void }) {
  const { path, settings, can } = useCompany();
  const toast = useToast();
  const [v, setV] = useState({
    kind: initial?.kind ?? kind, name: initial?.name ?? "", email: initial?.email ?? "", phone: initial?.phone ?? "", tax_id: initial?.tax_id ?? "", pan: initial?.pan ?? "",
    state_code: regionProblem(initial?.country ?? settings?.company.country, initial?.state_code) && !(settings?.company.country === "IN" && regionProblem("IN", initial?.state_code) === null) ? "" : initial?.state_code ?? "", country: initial?.country ?? settings?.company.country ?? "IN", billing_address: initial?.billing_address ?? "",
    shipping_address: initial?.shipping_address ?? "", currency: initial?.currency ?? "", payment_terms_days: initial?.payment_terms_days ?? 30,
    credit_limit: initial?.credit_limit ? toInput(initial.credit_limit, initial.currency ?? settings?.company.base_currency ?? "INR") : "", notes: initial?.notes ?? "", is_active: initial ? Boolean(initial.is_active) : true,
    price_list_id: initial?.price_list_id ?? "",
  });
  const priceLists = useApi<{ price_lists: { id: string; name: string; is_active: number }[] }>(can("inventory.view") ? path("/price-lists") : null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, val: unknown) => setV((p) => ({ ...p, [k]: val }));
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const body = { ...v, payment_terms_days: Number(v.payment_terms_days), currency: v.currency || null, state_code: v.state_code || null, tax_id: v.tax_id || null, credit_limit: v.credit_limit || null, price_list_id: priceLists.data ? v.price_list_id || null : undefined };
      const r = initial ? await api.put(path(`/contacts/${initial.id}`), body) : await postOrQueue(path("/contacts"), body, { label: `${v.kind === "supplier" ? "Supplier" : "Customer"}: ${v.name}` });
      if (isQueued(r)) { toast("info", "Saved on this device — it will be sent when you're back online"); onClose(); return; }
      toast("success", initial ? "Saved" : `${v.kind === "supplier" ? "Supplier" : "Customer"} added`);
      onClose(initial?.id ?? r.id);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  const india = v.country === "IN";
  /** A new country brings its own regions and its currency (when that differs from the books' currency); both stay editable. */
  const pickCountry = (country: string) => setV((p) => {
    const base = settings?.company.base_currency;
    const cur = countryPack(country).currency;
    const leavingIndia = (p.country === "IN") !== (country === "IN");
    return { ...p, country, state_code: settings?.company.country === "IN" && country !== "IN" ? "96" : "", ...(leavingIndia ? { tax_id: "", pan: "" } : {}), currency: cur === base || !CURRENCY_OPTIONS.includes(cur) ? "" : cur };
  });
  return (
    <Modal open wide onClose={() => onClose()} title={initial ? `Edit ${initial.name}` : `New ${kind}`}
      footer={<><Button variant="secondary" onClick={() => onClose()}>Cancel</Button><Button loading={busy} onClick={save}>Save</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        {error && <Alert className="sm:col-span-2">{error}</Alert>}
        <Field label="Name" required>{(id) => <Input id={id} value={v.name} onChange={(e) => set("name", e.target.value)} />}</Field>
        <Field label="Type">{(id) => <Select id={id} value={v.kind} onChange={(e) => set("kind", e.target.value)}><option value="customer">Customer</option><option value="supplier">Supplier</option><option value="both">Customer & supplier</option></Select>}</Field>
        <Field label="Email">{(id) => <Input id={id} type="email" value={v.email} onChange={(e) => set("email", e.target.value)} />}</Field>
        <Field label="Phone">{(id) => <Input id={id} value={v.phone} onChange={(e) => set("phone", e.target.value)} />}</Field>
        <Field label="Country">{(id) => <CountrySelect id={id} value={v.country} onChange={pickCountry} />}</Field>
        <Field label="Currency" hint="Leave as default to invoice in your base currency.">{(id) => (
          <Select id={id} value={v.currency} onChange={(e) => set("currency", e.target.value)}><option value="">Default ({settings?.company.base_currency})</option>{CURRENCY_OPTIONS.map((c) => <option key={c}>{c}</option>)}</Select>
        )}</Field>
        {india && <>
          <Field label="GSTIN" hint="Validated with its check digit; fills the state automatically.">{(id) => <Input id={id} value={v.tax_id} maxLength={15} className="font-mono uppercase" onChange={(e) => { set("tax_id", e.target.value); if (e.target.value.length >= 2 && /^\d\d/.test(e.target.value)) set("state_code", e.target.value.slice(0, 2)); }} />}</Field>
          <Field label="State / place of supply">{(id) => (
            <RegionSelect id={id} country="IN" value={v.state_code} onChange={(code) => set("state_code", code)} />
          )}</Field>
          <Field label="PAN">{(id) => <Input id={id} value={v.pan} maxLength={10} className="font-mono uppercase" onChange={(e) => set("pan", e.target.value.toUpperCase())} />}</Field>
        </>}
        {!india && regionsFor(v.country) && <Field label={regionLabel(v.country)}>{(id) => <RegionSelect id={id} country={v.country} value={v.state_code} onChange={(code) => set("state_code", code)} />}</Field>}
        {!india && <Field label={countryPack(v.country).regLabel ?? "Tax ID"} hint="Optional">{(id) => <Input id={id} value={v.tax_id} className="font-mono uppercase" onChange={(e) => set("tax_id", e.target.value)} />}</Field>}
        <Field label="Payment terms (days)">{(id) => <Input id={id} type="number" min={0} max={365} value={v.payment_terms_days} onChange={(e) => set("payment_terms_days", e.target.value)} />}</Field>
        <Field label="Credit limit">{(id) => <Input id={id} inputMode="decimal" value={v.credit_limit} onChange={(e) => set("credit_limit", e.target.value)} />}</Field>
        {v.kind !== "supplier" && Boolean(priceLists.data?.price_lists.length) && <Field label="Price list" hint="Sets this customer's rates on invoices and at the counter">{(id) => <Select id={id} value={v.price_list_id} onChange={(e) => set("price_list_id", e.target.value)}><option value="">Normal selling prices</option>{priceLists.data!.price_lists.filter((l) => l.is_active || l.id === v.price_list_id).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>}</Field>}
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
  // ?new=1 (the Alt+C / Alt+V shortcuts) opens the new-contact form straight away.
  const [params, setParams] = useSearchParams();
  const [adding, setAdding] = useState(params.get("new") === "1");
  useEffect(() => { if (params.get("new") === "1") { setAdding(true); setParams((p) => { p.delete("new"); return p; }, { replace: true }); } }, [params, setParams]);
  const { data, loading, error, reload } = useApi<{ contacts: any[]; total: number }>(path(`/contacts?kind=${kind}&limit=50&offset=${offset}&q=${encodeURIComponent(q)}`));
  const title = kind === "customer" ? "Customers" : "Suppliers";
  const bal = kind === "customer" ? "receivable" : "payable";
  return (
    <>
      <PageHeader title={title} actions={<>
        {data && <DownloadButtons onDownload={() => downloadCsv(`${title.toLowerCase()}.csv`, ["Name", "Email", "Phone", "Tax ID", "State", "Currency", "Outstanding (doc currency sum)"], data.contacts.map((c) => [c.name, c.email, c.phone, c.tax_id, c.state_code, c.currency, toInput(c[bal], c.currency ?? "INR")]))} />}
        {can(kind === "customer" ? "customers.write" : "suppliers.write") && <Button onClick={() => setAdding(true)}><Plus className="h-4 w-4" />New {kind}</Button>}
      </>} />
      <Card padded={false}>
        <div className="border-b border-[var(--border)] p-3"><Input placeholder="Search name, email, GSTIN…" value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} className="max-w-xs" aria-label={`Search ${title}`} /></div>
        {error && <Alert className="m-3">{error}</Alert>}
        {loading && !data ? <Spinner /> : data && !data.contacts.length ? (
          <EmptyState title={`No ${title.toLowerCase()} yet`} action={can(kind === "customer" ? "customers.write" : "suppliers.write") && <Button onClick={() => setAdding(true)}>Add {kind}</Button>} />
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

type ContactTab = "summary" | "documents" | "products" | "payments";

export function ContactView() {
  const { path, money, id, settings, can } = useCompany();
  const { contactId } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as ContactTab) || "summary";
  const { data, error, loading, reload } = useApi<any>(path(`/contacts/${contactId}`));
  const range = [params.get("from") && `from=${params.get("from")}`, params.get("to") && `to=${params.get("to")}`].filter(Boolean).join("&");
  const ins = useApi<any>(path(`/contacts/${contactId}/insights${range ? `?${range}` : ""}`));
  const [from, setFrom] = useState(params.get("from") ?? "");
  const [to, setTo] = useState(params.get("to") ?? "");
  const [editing, setEditing] = useState(false);
  if (loading && !data) return <Spinner />;
  if (error) return <Alert>{error}</Alert>;
  const c = data.contact;
  const isCustomer = c.kind !== "supplier";
  const df = settings?.company.date_format;
  const docLink = (d: any) => docPath(id, d.doc_type, d.id, d.variant);
  const setTab = (t: ContactTab) => setParams((sp) => { if (t === "summary") sp.delete("tab"); else sp.set("tab", t); return sp; });
  const I = ins.data;
  const side = (title: string, x: any, verb: string, paidWord: string) => x && (
    <Card title={title}>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={verb} value={money(x.summary.amount)} sub={`${x.summary.documents} ${title.startsWith("Sales") ? "invoice" : "bill"}${x.summary.documents === 1 ? "" : "s"} · ${money(x.summary.total)} with tax`} />
        <Stat label={paidWord} value={money(x.summary.settled)} sub={`Cash ${money(x.summary.cash)} · bank ${money(x.summary.bank)}${x.summary.note ? ` · notes ${money(x.summary.note)}` : ""}`} tone="good" />
        <Stat label="Outstanding" value={money(x.summary.outstanding)} tone={x.summary.outstanding > 0 ? "bad" : "neutral"} sub={x.summary.overdue > 0 ? `${money(x.summary.overdue)} overdue` : "Nothing overdue"} />
        {x.summary.profit !== undefined ? <Stat label="Profit on their invoices" value={money(x.summary.profit)} tone={x.summary.profit < 0 ? "bad" : "good"} sub={x.summary.margin_bp != null ? `Margin ${pct(x.summary.margin_bp)} · stock cost ${money(x.summary.cost)}` : undefined} /> : <div />}
      </div>
    </Card>
  );
  const productTable = (x: any, who: string) => x && (
    <Card title={who} padded={false}>{x.products.length ? <TableWrap><table className="table">
      <thead><tr><th>Product</th><th className="num">Qty</th><th className="num">Amount</th>{x.summary.profit !== undefined && <><th className="num">Cost</th><th className="num">Profit</th></>}<th className="num">Documents</th><th>Last</th></tr></thead>
      <tbody>{x.products.map((p: any, i: number) => <tr key={i}>
        <td>{p.item_id && can("inventory.view") ? <Link className="text-brand-700 hover:underline dark:text-brand-300" to={productPath(id, p.item_id)}>{p.name}</Link> : p.name}</td>
        <td className="num">{qty(p.qty_milli)} {p.unit ?? ""}</td><td className="num">{money(p.amount)}</td>
        {x.summary.profit !== undefined && <><td className="num">{p.cost ? money(p.cost) : "—"}</td><td className="num">{p.cost ? money(p.amount - p.cost) : "—"}</td></>}
        <td className="num">{p.documents}</td><td>{fmtDate(p.last_date, df)}</td></tr>)}</tbody>
    </table></TableWrap> : <EmptyState title="Nothing in this period" />}</Card>
  );
  return (
    <>
      <PageHeader title={c.name} subtitle={[c.email, c.phone, c.tax_id].filter(Boolean).join(" · ")} back={{ to: `/app/${id}/${isCustomer ? "customers" : "suppliers"}`, label: isCustomer ? "Customers" : "Suppliers" }}
        actions={<>
          <LinkButton variant="secondary" to={`/app/${id}/reports/statement/${c.id}`}>Statement</LinkButton>
          {can(isCustomer ? "customers.write" : "suppliers.write") && <Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button>}
          {isCustomer && can("sales.create") && <LinkButton to={`/app/${id}/sales/invoice/new?contact=${c.id}`}>New invoice</LinkButton>}
          {c.kind !== "customer" && can("purchase.create") && <LinkButton to={`/app/${id}/purchases/bill/new?contact=${c.id}`}>New bill</LinkButton>}
        </>} />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="From">{(fid) => <Input id={fid} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label="To">{(fid) => <Input id={fid} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
        <Button variant="secondary" onClick={() => setParams((sp) => { if (from) sp.set("from", from); else sp.delete("from"); if (to) sp.set("to", to); else sp.delete("to"); return sp; })}>Apply</Button>
        {(params.get("from") || params.get("to")) && <Button variant="ghost" onClick={() => { setFrom(""); setTo(""); setParams((sp) => { sp.delete("from"); sp.delete("to"); return sp; }); }}>All dates</Button>}
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ value: "summary", label: "Summary" }, { value: "documents", label: "Documents" }, { value: "products", label: "Products" }, { value: "payments", label: "Payments" }]} />
      <div className="mt-4 space-y-4">
        {ins.error && <Alert>{ins.error}</Alert>}
        {tab === "summary" && <>
          {!I ? <Spinner /> : <>{side("Sales to them", I.sales, "Sold (before tax)", "Received")}{side("Purchases from them", I.purchases, "Bought (before tax)", "Paid")}</>}
          <Card title="Details">
            <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div><dt className="muted">Billing address</dt><dd className="whitespace-pre-line">{c.billing_address || "—"}</dd></div>
              <div><dt className="muted">{regionLabel(c.country)}</dt><dd>{c.state_code ? (c.country === "IN" ? `${c.state_code} · ${regionName(c.country, c.state_code)}` : regionName(c.country, c.state_code)) : "—"}</dd></div>
              <div><dt className="muted">Currency</dt><dd>{c.currency ?? settings?.company.base_currency}</dd></div>
              <div><dt className="muted">Payment terms</dt><dd>{c.payment_terms_days} days{c.credit_limit ? ` · credit limit ${money(c.credit_limit, c.currency ?? undefined)}` : ""}</dd></div>
              {c.notes && <div className="sm:col-span-2"><dt className="muted">Notes</dt><dd className="whitespace-pre-line">{c.notes}</dd></div>}
            </dl>
          </Card>
        </>}
        {tab === "documents" && <Card padded={false}>
          {data.documents.length ? (
            <TableWrap><table className="table">
              <thead><tr><th>Date</th><th>Document</th><th>Status</th><th className="num">Total</th><th className="num">Balance</th></tr></thead>
              <tbody>{data.documents.map((d: any) => (
                <tr key={d.id}>
                  <td>{fmtDate(d.issue_date, df)}</td>
                  <td><Link className="text-brand-700 hover:underline dark:text-brand-300" to={docLink(d)}>{DOC_LABELS[d.variant ?? d.doc_type]?.one ?? DOC_LABELS[d.doc_type].one} {d.number ?? "(draft)"}</Link></td>
                  <td><StatusBadge status={d.status} due={d.due_date} outstanding={["invoice", "bill"].includes(d.doc_type) ? d.total - d.amount_settled : undefined} /></td>
                  <td className="num">{money(d.total, d.currency)}</td>
                  <td className="num">{d.status === "posted" ? money(d.total - d.amount_settled, d.currency) : ""}</td>
                </tr>
              ))}</tbody>
            </table></TableWrap>
          ) : <EmptyState title="No documents yet" />}
        </Card>}
        {tab === "products" && (!I ? <Spinner /> : <>{productTable(I.sales, "Products they bought")}{productTable(I.purchases, "Products they supplied")}</>)}
        {tab === "payments" && (!I ? <Spinner /> : <Card padded={false}>{I.payments.length ? <TableWrap><table className="table">
          <thead><tr><th>Date</th><th>Payment</th><th>Paid by</th><th>Account</th><th>Reference</th><th className="num">Amount</th></tr></thead>
          <tbody>{I.payments.map((p: any) => <tr key={p.id} className={p.status === "void" ? "line-through opacity-60" : ""}>
            <td>{fmtDate(p.payment_date, df)}</td>
            <td><Link className="text-brand-700 hover:underline dark:text-brand-300" to={paymentPath(id, p.id)}>{p.direction === "in" ? "Receipt" : "Payment"} {p.number ?? ""}</Link></td>
            <td><Badge color={p.subtype === "cash" ? "green" : p.subtype === "bank" ? "blue" : "gray"}>{p.subtype === "cash" ? "cash" : p.subtype === "bank" ? "bank" : "other"}</Badge>{p.method ? <span className="ml-1 text-xs muted">{p.method}</span> : null}</td>
            <td>{p.account}</td><td className="text-xs">{p.reference ?? ""}</td>
            <td className="num">{p.direction === "out" ? "−" : ""}{money(p.amount, p.currency)}</td></tr>)}</tbody>
        </table></TableWrap> : <EmptyState title="No payments in this period" />}</Card>)}
      </div>
      {editing && <ContactForm kind={isCustomer ? "customer" : "supplier"} initial={c} onClose={(nid) => { setEditing(false); if (nid) { reload(); ins.reload(); } }} />}
    </>
  );
}
