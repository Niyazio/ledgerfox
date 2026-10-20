import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { Plus, Trash2, Printer, Download } from "lucide-react";
import { useCompany } from "../lib/company";
import { useApi, useAction } from "../lib/hooks";
import { api, errorMessage } from "../lib/api";
import { isQueued, postOrQueue } from "../lib/offline";
import { Alert, Badge, Button, Card, ConfirmButton, EmptyState, Field, Input, LinkButton, Modal, MoneyInput, PageHeader, Pagination, Select, Spinner, StatusBadge, TableWrap, Textarea, useToast } from "../components/ui";
import { AccountSelect, ContactSelect, DimensionSelect, TaxSelect } from "../components/pickers";
import { DOC_LABELS, SALES_DOCS, fmtDate, qty as fmtQty, today, toInput, pct } from "../lib/format";
import { computeDocument, resolveTaxMode, INDIA_STATES, type TaxMode } from "@shared/tax";
import { parseDecimal, parseQty, parsePercentToBp, roundToWhole } from "@shared/money";
import { CURRENCIES } from "@shared/currencies";
import { downloadCsv } from "../lib/csv";
import { ContactForm } from "./Contacts";

const area = (t: string) => (SALES_DOCS.includes(t) ? "sales" : "purchases");

export function DocumentList() {
  const { docType = "invoice" } = useParams();
  const { path, money, id, settings, can } = useCompany();
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "";
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  const label = DOC_LABELS[docType];
  const { data, loading, error } = useApi<{ documents: any[]; total: number }>(path(`/documents?type=${docType}&limit=50&offset=${offset}&status=${status}&q=${encodeURIComponent(q)}`));
  const settles = docType === "invoice" || docType === "bill";
  const df = settings?.company.date_format;
  return (
    <>
      <PageHeader title={label.many} actions={<>
        {data && <Button variant="secondary" onClick={() => downloadCsv(`${label.many.toLowerCase()}.csv`, ["Date", "Number", "Contact", "Status", "Currency", "Total", "Balance", "Due"], data.documents.map((d) => [d.issue_date, d.number ?? "Draft", d.contact_name, d.status, d.currency, toInput(d.total, d.currency), d.status === "posted" ? toInput(d.total - d.amount_settled, d.currency) : "", d.due_date]))}><Download className="h-4 w-4" />CSV</Button>}
        {can("txn.write") && <LinkButton to={`/app/${id}/${area(docType)}/${docType}/new`}><Plus className="h-4 w-4" />New {label.one.toLowerCase()}</LinkButton>}
      </>} />
      <Card padded={false}>
        <div className="flex flex-wrap gap-3 border-b border-[var(--border)] p-3">
          <Input placeholder="Search number, reference, contact…" value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} className="max-w-xs" aria-label="Search" />
          <Select className="max-w-[12rem]" value={status} onChange={(e) => { setParams(e.target.value ? { status: e.target.value } : {}); setOffset(0); }} aria-label="Status filter">
            <option value="">All</option><option value="draft">Draft</option>
            {settles ? <><option value="outstanding">Outstanding</option><option value="overdue">Overdue</option><option value="posted">Posted</option></> : <><option value="posted">Posted</option><option value="open">Open</option><option value="converted">Converted</option></>}
            <option value="void">Void</option>
          </Select>
        </div>
        {error && <Alert className="m-3">{error}</Alert>}
        {loading && !data ? <Spinner /> : data && !data.documents.length ? (
          <EmptyState title={`No ${label.many.toLowerCase()}`} action={can("txn.write") && <LinkButton to={`/app/${id}/${area(docType)}/${docType}/new`}>Create {label.one.toLowerCase()}</LinkButton>} />
        ) : data && (
          <TableWrap>
            <table className="table">
              <thead><tr><th>Date</th><th>Number</th><th>{SALES_DOCS.includes(docType) ? "Customer" : "Supplier"}</th><th>Status</th>{settles && <th>Due</th>}<th className="num">Total</th>{settles && <th className="num">Balance</th>}</tr></thead>
              <tbody>
                {data.documents.map((d) => (
                  <tr key={d.id}>
                    <td className="whitespace-nowrap">{fmtDate(d.issue_date, df)}</td>
                    <td><Link className="font-medium text-brand-700 hover:underline dark:text-brand-300" to={`/app/${id}/${area(docType)}/${docType}/${d.id}`}>{d.number ?? "Draft"}</Link>{d.reference && <span className="block text-xs muted">{d.reference}</span>}</td>
                    <td>{d.contact_name}</td>
                    <td><StatusBadge status={d.status} due={d.due_date} outstanding={settles ? d.total - d.amount_settled : undefined} /></td>
                    {settles && <td className="whitespace-nowrap">{fmtDate(d.due_date, df)}</td>}
                    <td className="num">{money(d.total, d.currency)}</td>
                    {settles && <td className="num">{d.status === "posted" ? money(d.total - d.amount_settled, d.currency) : ""}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
        {data && <Pagination total={data.total} limit={50} offset={offset} onChange={setOffset} />}
      </Card>
    </>
  );
}

interface Line { key: number; item_id: string; description: string; hsn_sac: string; quantity: string; unit_price: string; discount_percent: string; account_id: string; tax_code_id: string; department_id: string; project_id: string; cost_centre_id: string }
let lk = 0;
const blankLine = (): Line => ({ key: ++lk, item_id: "", description: "", hsn_sac: "", quantity: "1", unit_price: "", discount_percent: "", account_id: "", tax_code_id: "", department_id: "", project_id: "", cost_centre_id: "" });

function tryParse<T>(fn: () => T, fallback: T) { try { return fn(); } catch { return fallback; } }

export function DocumentForm() {
  const { docType = "invoice", docId } = useParams();
  const [params] = useSearchParams();
  const { path, id, settings } = useCompany();
  const nav = useNavigate();
  const toast = useToast();
  const label = DOC_LABELS[docType];
  const sales = SALES_DOCS.includes(docType);
  const kind = sales ? "customer" : "supplier";
  const base = settings?.company.base_currency ?? "INR";
  const [contact, setContact] = useState<any>(null);
  const [contactId, setContactId] = useState(params.get("contact") ?? "");
  const [h, setH] = useState({ issue_date: today(), due_date: "", currency: "", fx_rate: "", place_of_supply: "", reference: "", notes: "", terms: settings?.company.invoice_terms ?? "", warehouse_id: "", branch_id: "", related_doc_id: "" });
  const [lines, setLines] = useState<Line[]>([blankLine()]);
  const [addingContact, setAddingContact] = useState(false);
  const [contactsKey, setContactsKey] = useState(0);
  const { busy, error, run } = useAction();
  const items = useApi<{ items: any[] }>(path("/items?active=1&limit=500"));
  const existing = useApi<any>(docId ? path(`/documents/${docId}`) : null);
  const contactRes = useApi<any>(contactId ? path(`/contacts/${contactId}`) : null);
  useEffect(() => { if (contactRes.data) setContact(contactRes.data.contact); }, [contactRes.data]);
  useEffect(() => {
    const d = existing.data;
    if (!d) return;
    const doc = d.document;
    const exp = CURRENCIES[doc.currency]?.exponent ?? 2;
    setContactId(doc.contact_id);
    setH({ issue_date: doc.issue_date, due_date: doc.due_date ?? "", currency: doc.currency, fx_rate: doc.currency !== base ? String(doc.fx_rate_scaled / 1e9) : "", place_of_supply: doc.place_of_supply ?? "", reference: doc.reference ?? "", notes: doc.notes ?? "", terms: doc.terms ?? "", warehouse_id: doc.warehouse_id ?? "", branch_id: doc.branch_id ?? "", related_doc_id: doc.related_doc_id ?? "" });
    setLines(d.lines.map((l: any) => ({ ...blankLine(), item_id: l.item_id ?? "", description: l.description, hsn_sac: l.hsn_sac ?? "", quantity: fmtQty(l.qty_milli), unit_price: toInput(l.unit_price, doc.currency).replace(new RegExp(`\\.0{${exp}}$`), ""), discount_percent: l.discount_bp ? String(l.discount_bp / 100) : "", account_id: l.account_id ?? "", tax_code_id: l.tax_code_id ?? "", department_id: l.department_id ?? "", project_id: l.project_id ?? "", cost_centre_id: l.cost_centre_id ?? "" })));
  }, [existing.data, base]);

  const currency = h.currency || contact?.currency || base;
  const exp = CURRENCIES[currency]?.exponent ?? 2;
  const mode: TaxMode = useMemo(() => {
    const scheme = settings?.tax_scheme === "in_gst" ? "in_gst" : "simple";
    const pos = h.place_of_supply || (sales ? contact?.state_code : settings?.company.state_code) || settings?.company.state_code;
    return sales ? resolveTaxMode(scheme, settings?.company.state_code, pos) : resolveTaxMode(scheme, contact?.state_code ?? settings?.company.state_code, settings?.company.state_code);
  }, [settings, contact, h.place_of_supply, sales]);
  const preview = useMemo(() => {
    const taxMap = new Map((settings?.tax_codes ?? []).map((t) => [t.id, t as any]));
    const parsed = lines.map((l) => ({
      qty_milli: tryParse(() => parseQty(l.quantity || "0"), 0), unit_price: tryParse(() => parseDecimal(l.unit_price || "0", exp), 0),
      discount_bp: tryParse(() => parsePercentToBp(l.discount_percent || "0"), 0), tax: l.tax_code_id ? taxMap.get(l.tax_code_id) : null,
    }));
    const t = computeDocument(parsed, mode);
    const roundOff = settings?.company.round_off_invoices && (docType === "invoice" || docType === "credit_note") ? roundToWhole(t.total_before_round, exp) - t.total_before_round : 0;
    return { ...t, round_off: roundOff, total: t.total_before_round + roundOff };
  }, [lines, settings, mode, exp, docType]);

  const setLine = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const pickItem = (key: number, itemId: string) => {
    const it = items.data?.items.find((x) => x.id === itemId);
    if (!it) return setLine(key, { item_id: "" });
    setLine(key, { item_id: it.id, description: it.name, hsn_sac: it.hsn_sac ?? "", unit_price: toInput(sales ? it.sale_price : it.purchase_price, base), tax_code_id: it.tax_code_id ?? "" });
  };
  const save = async (issue: boolean) => {
    const body = {
      doc_type: docType, contact_id: contactId, issue_date: h.issue_date, due_date: h.due_date || null, currency: currency, fx_rate: currency !== base ? h.fx_rate || null : null,
      place_of_supply: h.place_of_supply || null, reference: h.reference || null, notes: h.notes || null, terms: h.terms || null,
      warehouse_id: h.warehouse_id || null, branch_id: h.branch_id || null, related_doc_id: h.related_doc_id || null,
      lines: lines.filter((l) => l.description.trim()).map((l) => ({ item_id: l.item_id || null, description: l.description, hsn_sac: l.hsn_sac || null, quantity: l.quantity, unit_price: l.unit_price || "0", discount_percent: l.discount_percent || null, account_id: l.account_id || null, tax_code_id: l.tax_code_id || null, department_id: l.department_id || null, project_id: l.project_id || null, cost_centre_id: l.cost_centre_id || null })),
    };
    const r = await run(async () => {
      const saved = docId ? await api.put(path(`/documents/${docId}`), body) : await postOrQueue(path("/documents"), body, { label: `${label.one}${h.reference ? ` ${h.reference}` : ""} (${h.issue_date})`, then: issue ? "/issue" : undefined });
      if (isQueued(saved)) return saved;
      for (const w of saved.warnings ?? []) toast("info", w);
      if (issue) await api.post(path(`/documents/${saved.id}/issue`));
      return saved;
    });
    if (r && isQueued(r)) { toast("info", "Saved on this device — it will be sent when you're back online"); nav(`/app/${id}/${area(docType)}/${docType}`, { replace: true }); return; }
    if (r) { toast("success", issue ? `${label.one} issued` : "Draft saved"); nav(`/app/${id}/${area(docType)}/${docType}/${r.id}`, { replace: true }); }
  };
  const india = settings?.tax_scheme === "in_gst";
  const showHsn = india;
  const money = (n: number) => toInput(n, currency);
  if (docId && existing.loading) return <Spinner />;
  return (
    <>
      <PageHeader title={docId ? `Edit ${label.one.toLowerCase()} (draft)` : `New ${label.one.toLowerCase()}`} back={{ to: `/app/${id}/${area(docType)}/${docType}`, label: label.many }} />
      {error && <Alert className="mb-4">{error}</Alert>}
      <Card>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={sales ? "Customer" : "Supplier"} required className="lg:col-span-2">{(fid) => (
            <div className="flex gap-2">
              <div className="flex-1"><ContactSelect key={contactsKey} id={fid} kind={kind} value={contactId} onChange={(cid) => setContactId(cid)} /></div>
              <Button variant="secondary" onClick={() => setAddingContact(true)} aria-label={`Add ${kind}`}><Plus className="h-4 w-4" /></Button>
            </div>
          )}</Field>
          <Field label="Date" required>{(fid) => <Input id={fid} type="date" value={h.issue_date} onChange={(e) => setH({ ...h, issue_date: e.target.value })} />}</Field>
          {(docType === "invoice" || docType === "bill") && <Field label="Due date" hint={contact ? `Default: ${contact.payment_terms_days} days` : undefined}>{(fid) => <Input id={fid} type="date" value={h.due_date} onChange={(e) => setH({ ...h, due_date: e.target.value })} />}</Field>}
          <Field label={docType === "bill" ? "Supplier invoice no." : "Reference / PO no."}>{(fid) => <Input id={fid} value={h.reference} onChange={(e) => setH({ ...h, reference: e.target.value })} />}</Field>
          {india && sales && <Field label="Place of supply" hint={mode === "inter" ? "Inter-state → IGST" : "Intra-state → CGST + SGST"}>{(fid) => (
            <Select id={fid} value={h.place_of_supply} onChange={(e) => setH({ ...h, place_of_supply: e.target.value })}>
              <option value="">From customer ({contact?.state_code ?? "—"})</option>
              {Object.entries(INDIA_STATES).map(([k, n]) => <option key={k} value={k}>{k} · {n}</option>)}
            </Select>
          )}</Field>}
          {currency !== base && <Field label={`Exchange rate (${currency} → ${base})`} hint="Leave blank to use the latest saved rate.">{(fid) => <Input id={fid} inputMode="decimal" value={h.fx_rate} onChange={(e) => setH({ ...h, fx_rate: e.target.value })} />}</Field>}
          {(settings?.warehouses.length ?? 0) > 1 && ["invoice", "bill", "credit_note", "debit_note"].includes(docType) && <Field label="Warehouse">{(fid) => (
            <Select id={fid} value={h.warehouse_id} onChange={(e) => setH({ ...h, warehouse_id: e.target.value })}><option value="">Default</option>{settings!.warehouses.map((w: any) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select>
          )}</Field>}
          {(settings?.branches.length ?? 0) > 1 && <Field label="Branch">{(fid) => <DimensionSelect id={fid} kind="branches" value={h.branch_id} onChange={(v) => setH({ ...h, branch_id: v })} />}</Field>}
        </div>
        {currency !== base && <p className="mt-3 text-sm muted">Document currency: <strong>{currency}</strong></p>}

        <TableWrap>
          <table className="table mt-5 min-w-[900px]">
            <thead><tr>
              <th className="w-[26%]">Item / description</th>{showHsn && <th className="w-24">HSN/SAC</th>}<th className="num w-20">Qty</th><th className="num w-28">Rate</th><th className="num w-20">Disc %</th><th className="w-40">Tax</th><th className="num w-28">Amount</th><th />
            </tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={l.key}>
                  <td className="space-y-2">
                    <Select value={l.item_id} onChange={(e) => pickItem(l.key, e.target.value)} aria-label="Item">
                      <option value="">— free text —</option>
                      {items.data?.items.map((it) => <option key={it.id} value={it.id}>{it.name}{it.sku ? ` (${it.sku})` : ""}</option>)}
                    </Select>
                    <Input value={l.description} placeholder="Description" onChange={(e) => setLine(l.key, { description: e.target.value })} aria-label="Description" />
                    {!l.item_id && <AccountSelect value={l.account_id} onChange={(v) => setLine(l.key, { account_id: v })} placeholder={sales ? "Income account (default: Sales)" : "Expense account (default: Purchases)"} filter={(a) => (sales ? a.type === "income" : ["expense", "asset"].includes(a.type))} />}
                    <div className="grid grid-cols-3 gap-2">
                      <DimensionSelect kind="departments" value={l.department_id} onChange={(v) => setLine(l.key, { department_id: v })} />
                      <DimensionSelect kind="projects" value={l.project_id} onChange={(v) => setLine(l.key, { project_id: v })} />
                      <DimensionSelect kind="cost_centres" value={l.cost_centre_id} onChange={(v) => setLine(l.key, { cost_centre_id: v })} />
                    </div>
                  </td>
                  {showHsn && <td><Input value={l.hsn_sac} maxLength={8} onChange={(e) => setLine(l.key, { hsn_sac: e.target.value })} aria-label="HSN/SAC" /></td>}
                  <td><Input inputMode="decimal" className="num" value={l.quantity} onChange={(e) => setLine(l.key, { quantity: e.target.value })} aria-label="Quantity" /></td>
                  <td><MoneyInput value={l.unit_price} onChange={(e) => setLine(l.key, { unit_price: e.target.value })} aria-label="Rate" /></td>
                  <td><Input inputMode="decimal" className="num" value={l.discount_percent} onChange={(e) => setLine(l.key, { discount_percent: e.target.value })} aria-label="Discount percent" /></td>
                  <td><TaxSelect value={l.tax_code_id} onChange={(v) => setLine(l.key, { tax_code_id: v })} /></td>
                  <td className="num pt-4">{money(preview.lines[i]?.line_total ?? 0)}</td>
                  <td><button className="rounded p-2 hover:bg-[var(--surface-2)] disabled:opacity-30" disabled={lines.length <= 1} onClick={() => setLines(lines.filter((x) => x.key !== l.key))} aria-label="Remove line"><Trash2 className="h-4 w-4" /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
        <Button variant="ghost" size="sm" className="mt-2" onClick={() => setLines([...lines, blankLine()])}><Plus className="h-4 w-4" />Add line</Button>

        <div className="mt-5 grid gap-6 lg:grid-cols-2">
          <div className="space-y-4">
            <Field label="Notes (shown on document)">{(fid) => <Textarea id={fid} value={h.notes} onChange={(e) => setH({ ...h, notes: e.target.value })} />}</Field>
            {sales && <Field label="Terms & conditions">{(fid) => <Textarea id={fid} value={h.terms} onChange={(e) => setH({ ...h, terms: e.target.value })} />}</Field>}
          </div>
          <div className="rounded-lg bg-[var(--surface-2)] p-4 text-sm">
            <dl className="space-y-1.5">
              <div className="flex justify-between"><dt>Subtotal</dt><dd className="num">{money(preview.subtotal)}</dd></div>
              {preview.discount_total > 0 && <div className="flex justify-between"><dt>Discount</dt><dd className="num">−{money(preview.discount_total)}</dd></div>}
              <div className="flex justify-between"><dt>Taxable value</dt><dd className="num">{money(preview.taxable_total)}</dd></div>
              {preview.cgst > 0 && <div className="flex justify-between"><dt>CGST</dt><dd className="num">{money(preview.cgst)}</dd></div>}
              {preview.sgst > 0 && <div className="flex justify-between"><dt>SGST</dt><dd className="num">{money(preview.sgst)}</dd></div>}
              {preview.igst > 0 && <div className="flex justify-between"><dt>IGST</dt><dd className="num">{money(preview.igst)}</dd></div>}
              {preview.other_tax > 0 && <div className="flex justify-between"><dt>Tax</dt><dd className="num">{money(preview.other_tax)}</dd></div>}
              {preview.round_off !== 0 && <div className="flex justify-between"><dt>Round off</dt><dd className="num">{money(preview.round_off)}</dd></div>}
              <div className="flex justify-between border-t border-[var(--border)] pt-2 text-base font-semibold"><dt>Total ({currency})</dt><dd className="num">{money(preview.total)}</dd></div>
            </dl>
            <p className="mt-2 text-xs muted">Preview. The server recalculates and stores the final figures.</p>
          </div>
        </div>
        <div className="mt-6 flex flex-wrap gap-2">
          <Button variant="secondary" loading={busy} disabled={!contactId} onClick={() => save(false)}>Save draft</Button>
          <Button loading={busy} disabled={!contactId} onClick={() => save(true)}>{["invoice", "credit_note", "bill", "debit_note"].includes(docType) ? "Save & post" : "Save & issue"}</Button>
        </div>
      </Card>
      {addingContact && <ContactForm kind={kind} onClose={(nid) => { setAddingContact(false); if (nid) { setContactId(nid); setContactsKey((k) => k + 1); } }} />}
    </>
  );
}

function ApplyCreditModal({ note, onClose }: { note: any; onClose: () => void }) {
  const { path, money } = useCompany();
  const target = note.doc_type === "credit_note" ? "invoice" : "bill";
  const { data } = useApi<{ documents: any[] }>(path(`/documents?type=${target}&status=outstanding&contact_id=${note.contact_id}&limit=100`));
  const [docId, setDocId] = useState("");
  const [amount, setAmount] = useState(toInput(note.total - note.amount_settled, note.currency));
  const { busy, error, run } = useAction();
  return (
    <Modal open onClose={onClose} title="Apply to document" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!docId} onClick={async () => { if (await run(() => api.post(path(`/documents/${note.id}/apply`), { document_id: docId, amount }))) onClose(); }}>Apply</Button></>}>
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field label={`Open ${target}`}>{(fid) => (
          <Select id={fid} value={docId} onChange={(e) => setDocId(e.target.value)}>
            <option value="">Select…</option>
            {data?.documents.filter((d) => d.currency === note.currency).map((d) => <option key={d.id} value={d.id}>{d.number} · balance {money(d.total - d.amount_settled, d.currency)}</option>)}
          </Select>
        )}</Field>
        <Field label="Amount">{(fid) => <MoneyInput id={fid} value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
      </div>
    </Modal>
  );
}

export function DocumentView() {
  const { docType = "invoice", docId } = useParams();
  const { path, money, id, settings, can } = useCompany();
  const nav = useNavigate();
  const toast = useToast();
  const { data, error, loading, reload } = useApi<any>(path(`/documents/${docId}`));
  const [applying, setApplying] = useState(false);
  if (loading && !data) return <Spinner />;
  if (error) return <Alert>{error}</Alert>;
  const d = data.document;
  const lines = data.lines as any[];
  const co = settings!.company;
  const label = DOC_LABELS[d.doc_type];
  const df = co.date_format;
  const cur = d.currency;
  const outstanding = d.total - d.amount_settled;
  const settles = d.doc_type === "invoice" || d.doc_type === "bill";
  const isNote = d.doc_type === "credit_note" || d.doc_type === "debit_note";
  const sales = SALES_DOCS.includes(d.doc_type);
  const india = co.country === "IN";
  const act = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast("success", ok); reload(); } catch (e) { toast("error", errorMessage(e)); } };
  const taxTotals = { cgst: lines.reduce((t, l) => t + l.cgst, 0), sgst: lines.reduce((t, l) => t + l.sgst, 0), igst: lines.reduce((t, l) => t + l.igst, 0), other: lines.reduce((t, l) => t + l.other_tax, 0) };
  const docTitle = d.doc_type === "invoice" && india ? (lines.some((l) => l.cgst || l.sgst || l.igst) ? "Tax Invoice" : "Bill of Supply") : label.one;
  return (
    <>
      <PageHeader title={`${label.one} ${d.number ?? "(draft)"}`} subtitle={d.contact_name} back={{ to: `/app/${id}/${area(docType)}/${docType}`, label: label.many }}
        actions={<>
          <LinkButton variant="secondary" to={`/print/${id}/document/${d.id}`}><Printer className="h-4 w-4" />Print preview</LinkButton>
          <LinkButton variant="secondary" to={`/print/${id}/document/${d.id}?format=thermal80`}><Printer className="h-4 w-4" />Thermal bill</LinkButton>
          {d.status === "draft" && can("txn.write") && <LinkButton variant="secondary" to={`/app/${id}/${area(docType)}/${docType}/${d.id}/edit`}>Edit</LinkButton>}
          {d.status === "draft" && can(["invoice", "credit_note", "bill", "debit_note"].includes(d.doc_type) ? "txn.post" : "txn.write") && <Button onClick={() => act(() => api.post(path(`/documents/${d.id}/issue`)), "Issued")}>{["invoice", "credit_note", "bill", "debit_note"].includes(d.doc_type) ? "Post" : "Issue"}</Button>}
          {d.status === "draft" && can("txn.write") && <ConfirmButton label="Delete" title="Delete draft?" body="Drafts can be deleted; issued documents must be voided." confirmLabel="Delete" onConfirm={async () => { await api.del(path(`/documents/${d.id}`)); nav(`/app/${id}/${area(docType)}/${docType}`); }} />}
          {d.status === "posted" && settles && outstanding > 0 && can("txn.post") && <LinkButton to={`/app/${id}/payments/${sales ? "in" : "out"}/new?contact=${d.contact_id}&doc=${d.id}`}>Record {sales ? "receipt" : "payment"}</LinkButton>}
          {d.status === "posted" && isNote && outstanding > 0 && can("txn.post") && <Button variant="secondary" onClick={() => setApplying(true)}>Apply to {sales ? "invoice" : "bill"}</Button>}
          {["open", "accepted"].includes(d.status) && d.doc_type === "quote" && can("txn.write") && <>
            <Button variant="secondary" onClick={() => act(async () => { const r = await api.post(path(`/documents/${d.id}/convert`), { to: "sales_order" }); nav(`/app/${id}/sales/sales_order/${r.id}`); }, "Sales order draft created")}>→ Sales order</Button>
            <Button onClick={() => act(async () => { const r = await api.post(path(`/documents/${d.id}/convert`), { to: "invoice" }); nav(`/app/${id}/sales/invoice/${r.id}`); }, "Invoice draft created")}>→ Invoice</Button>
          </>}
          {["open", "accepted"].includes(d.status) && d.doc_type === "sales_order" && can("txn.write") && <Button onClick={() => act(async () => { const r = await api.post(path(`/documents/${d.id}/convert`), { to: "invoice" }); nav(`/app/${id}/sales/invoice/${r.id}`); }, "Invoice draft created")}>→ Invoice</Button>}
          {["open", "accepted"].includes(d.status) && d.doc_type === "purchase_order" && can("txn.write") && <Button onClick={() => act(async () => { const r = await api.post(path(`/documents/${d.id}/convert`), { to: "bill" }); nav(`/app/${id}/purchases/bill/${r.id}`); }, "Bill draft created")}>→ Bill</Button>}
          {d.status === "posted" && settles && can("txn.write") && <Button variant="secondary" onClick={() => act(async () => { const r = await api.post(path(`/documents/${d.id}/convert`), { to: sales ? "credit_note" : "debit_note" }); nav(`/app/${id}/${area(docType)}/${sales ? "credit_note" : "debit_note"}/${r.id}/edit`); }, `${sales ? "Credit" : "Debit"} note draft created`)}>{sales ? "Credit note" : "Debit note"}</Button>}
          {d.status !== "draft" && d.status !== "void" && can("txn.reverse") && (!settles || d.amount_settled === 0) && (
            <ConfirmButton label="Void" title={`Void ${label.one.toLowerCase()}?`} withReason confirmLabel="Void"
              body={isNote || settles ? "A reversing journal is posted (and any stock movement reversed). The document remains on record marked void." : "The document will be marked void."}
              onConfirm={(reason) => act(() => api.post(path(`/documents/${d.id}/void`), { reason: reason ?? null }), "Voided")} />
          )}
        </>} />
      <div className="mb-4 flex flex-wrap items-center gap-2 no-print">
        <StatusBadge status={d.status} due={d.due_date} outstanding={settles ? outstanding : undefined} />
        {d.journal_number && <Link to={`/app/${id}/journals/${d.journal_entry_id}`} className="text-sm text-brand-700 hover:underline dark:text-brand-300">Journal {d.journal_number}</Link>}
        {d.related_number && <span className="text-sm muted">From {DOC_LABELS[d.related_type]?.one} {d.related_number}</span>}
        {data.related.map((r: any) => <Link key={r.id} className="text-sm text-brand-700 hover:underline dark:text-brand-300" to={`/app/${id}/${area(r.doc_type)}/${r.doc_type}/${r.id}`}>{DOC_LABELS[r.doc_type].one} {r.number ?? "(draft)"}</Link>)}
      </div>

      <article className="card print-area mx-auto max-w-4xl p-6 sm:p-10">
        <header className="flex flex-wrap justify-between gap-6 border-b border-[var(--border)] pb-6">
          <div>
            <p className="text-xl font-semibold">{co.legal_name || co.name}</p>
            <p className="mt-1 whitespace-pre-line text-sm muted">{[co.address, [co.city, co.postal_code].filter(Boolean).join(" "), co.state_code && india ? `${INDIA_STATES[co.state_code] ?? ""} (${co.state_code})` : null].filter(Boolean).join("\n")}</p>
            {co.tax_id && <p className="mt-1 text-sm">{india ? "GSTIN" : "Tax ID"}: <span className="font-mono">{co.tax_id}</span></p>}
            {(co.phone || co.email) && <p className="text-sm muted">{[co.phone, co.email].filter(Boolean).join(" · ")}</p>}
          </div>
          <div className="text-right">
            <p className="text-2xl font-semibold uppercase tracking-wide text-brand-700 dark:text-brand-300">{docTitle}</p>
            <p className="mt-1 text-sm"><span className="muted">No.</span> <strong>{d.number ?? "DRAFT"}</strong></p>
            <p className="text-sm"><span className="muted">Date</span> {fmtDate(d.issue_date, df)}</p>
            {d.due_date && <p className="text-sm"><span className="muted">Due</span> {fmtDate(d.due_date, df)}</p>}
            {d.reference && <p className="text-sm"><span className="muted">Ref</span> {d.reference}</p>}
            {d.related_number && <p className="text-sm"><span className="muted">Against</span> {d.related_number}</p>}
          </div>
        </header>
        <section className="grid gap-6 py-6 sm:grid-cols-2">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide muted">{sales ? "Bill to" : "Supplier"}</p>
            <p className="mt-1 font-medium">{d.contact_name}</p>
            <p className="whitespace-pre-line text-sm muted">{d.contact_address}</p>
            {d.contact_tax_id && <p className="text-sm">{india ? "GSTIN" : "Tax ID"}: <span className="font-mono">{d.contact_tax_id}</span></p>}
          </div>
          {india && sales && d.place_of_supply && <div className="sm:text-right"><p className="text-xs font-semibold uppercase tracking-wide muted">Place of supply</p><p className="mt-1 text-sm">{INDIA_STATES[d.place_of_supply] ?? ""} ({d.place_of_supply})</p></div>}
        </section>
        <TableWrap>
          <table className="table">
            <thead><tr><th>#</th><th>Description</th>{india && <th>HSN/SAC</th>}<th className="num">Qty</th><th className="num">Rate</th>{lines.some((l) => l.discount_bp) && <th className="num">Disc.</th>}<th className="num">Taxable</th><th className="num">Tax</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id}>
                  <td className="muted">{l.line_no}</td>
                  <td>{l.description}</td>
                  {india && <td className="font-mono text-xs">{l.hsn_sac}</td>}
                  <td className="num">{fmtQty(l.qty_milli)} {l.unit ?? ""}</td>
                  <td className="num">{money(l.unit_price, cur)}</td>
                  {lines.some((x) => x.discount_bp) && <td className="num">{l.discount_bp ? pct(l.discount_bp) : ""}</td>}
                  <td className="num">{money(l.taxable, cur)}</td>
                  <td className="num">{l.tax_code_name ? <span className="block text-xs muted">{l.tax_code_name}</span> : null}{money(l.cgst + l.sgst + l.igst + l.other_tax, cur)}</td>
                  <td className="num">{money(l.line_total, cur)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
        <section className="mt-6 flex flex-wrap justify-between gap-6">
          <div className="max-w-md space-y-3 text-sm">
            {d.notes && <div><p className="text-xs font-semibold uppercase tracking-wide muted">Notes</p><p className="whitespace-pre-line">{d.notes}</p></div>}
            {d.terms && <div><p className="text-xs font-semibold uppercase tracking-wide muted">Terms</p><p className="whitespace-pre-line">{d.terms}</p></div>}
            {cur !== co.base_currency && <p className="muted">Exchange rate: 1 {cur} = {(d.fx_rate_scaled / 1e9).toString()} {co.base_currency}. Base total {money(d.total_base)}.</p>}
          </div>
          <dl className="w-full max-w-xs space-y-1.5 text-sm">
            <div className="flex justify-between"><dt>Taxable value</dt><dd className="num">{money(d.subtotal - d.discount_total, cur)}</dd></div>
            {taxTotals.cgst > 0 && <div className="flex justify-between"><dt>CGST</dt><dd className="num">{money(taxTotals.cgst, cur)}</dd></div>}
            {taxTotals.sgst > 0 && <div className="flex justify-between"><dt>SGST</dt><dd className="num">{money(taxTotals.sgst, cur)}</dd></div>}
            {taxTotals.igst > 0 && <div className="flex justify-between"><dt>IGST</dt><dd className="num">{money(taxTotals.igst, cur)}</dd></div>}
            {taxTotals.other > 0 && <div className="flex justify-between"><dt>Tax</dt><dd className="num">{money(taxTotals.other, cur)}</dd></div>}
            {d.round_off !== 0 && <div className="flex justify-between"><dt>Round off</dt><dd className="num">{money(d.round_off, cur)}</dd></div>}
            <div className="flex justify-between border-t border-[var(--border)] pt-2 text-base font-semibold"><dt>Total</dt><dd className="num">{money(d.total, cur)}</dd></div>
            {d.status === "posted" && (settles || isNote) && <>
              <div className="flex justify-between muted"><dt>{isNote ? "Applied" : "Paid / credited"}</dt><dd className="num">{money(d.amount_settled, cur)}</dd></div>
              <div className="flex justify-between font-semibold"><dt>{isNote ? "Unapplied" : "Balance due"}</dt><dd className="num">{money(outstanding, cur)}</dd></div>
            </>}
          </dl>
        </section>
        {d.status === "draft" && <p className="mt-8 text-center text-sm font-semibold uppercase tracking-widest text-amber-600">Draft — not a valid {label.one.toLowerCase()}</p>}
        {d.status === "void" && <p className="mt-8 text-center text-sm font-semibold uppercase tracking-widest text-red-600">Void</p>}
        <p className="mt-10 text-center text-xs muted">This is a computer-generated document.</p>
      </article>

      {data.allocations.length > 0 && (
        <Card title="Payments & credits applied" className="mx-auto mt-4 max-w-4xl no-print" padded={false}>
          <TableWrap><table className="table">
            <thead><tr><th>Date</th><th>Source</th><th className="num">Amount</th></tr></thead>
            <tbody>{data.allocations.map((a: any) => (
              <tr key={a.id}>
                <td>{fmtDate(a.allocation_date, df)}</td>
                <td>{a.payment_id ? <Link className="text-brand-700 hover:underline dark:text-brand-300" to={`/app/${id}/payments/view/${a.payment_id}`}>Payment {a.payment_number}</Link> : <>Note {a.note_number}</>}
                  {a.note_id === d.id && a.target_number && <span className="muted"> → {a.target_number}</span>}
                  {a.amount < 0 && <span className="ml-2"><Badge color="red">reversed</Badge></span>}</td>
                <td className="num">{money(a.amount, cur)}</td>
              </tr>
            ))}</tbody>
          </table></TableWrap>
        </Card>
      )}
      {applying && <ApplyCreditModal note={d} onClose={() => { setApplying(false); reload(); }} />}
    </>
  );
}
