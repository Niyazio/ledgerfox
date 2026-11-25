import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { Copy } from "lucide-react";
import { useCompany } from "../lib/company";
import { useApi } from "../lib/hooks";
import { api, errorMessage } from "../lib/api";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Modal, PageHeader, Select, Spinner, TableWrap, Tabs, useToast } from "../components/ui";
import { fmtDate, today } from "../lib/format";
import { docPath } from "../lib/links";
import { LandedCost } from "./Advanced";

type Tab = "rfq" | "grn" | "match" | "landed";
const qty = (m: number) => (m / 1000).toLocaleString("en-IN", { maximumFractionDigits: 3 });
const ISSUE: Record<string, { label: string; color: "red" | "amber" | "gray" }> = {
  billed_more_than_received: { label: "Billed more than received", color: "red" },
  price_above_order: { label: "Bill price above order", color: "red" },
  short_receipt: { label: "Short receipt", color: "amber" },
  rejected: { label: "Goods rejected", color: "amber" },
};
const MATCH: Record<string, { label: string; color: "green" | "red" | "amber" | "gray" }> = {
  matched: { label: "Matched", color: "green" }, mismatch: { label: "Mismatch", color: "red" }, partial: { label: "In progress", color: "amber" }, open: { label: "Nothing received", color: "gray" },
};

/** Requests for quotation, goods receipts (with quality check) and the 3-way match of order, receipt and bill. */
export default function PurchasingPage() {
  const [tab, setTab] = useState<Tab>("rfq");
  return (
    <>
      <PageHeader title="Purchasing" subtitle="Ask several suppliers for prices, compare their quotes, receive goods against purchase orders, and check bills against what was ordered and received." />
      <Tabs tabs={[{ value: "rfq", label: "Requests for quotation" }, { value: "grn", label: "Goods receipts (GRN)" }, { value: "match", label: "3-way match" }, { value: "landed", label: "Landed cost" }]} value={tab} onChange={setTab} />
      <div className="mt-4">{tab === "rfq" ? <Rfqs /> : tab === "grn" ? <Grns /> : tab === "match" ? <Matching /> : <LandedCost />}</div>
    </>
  );
}

// ── RFQs ──

function Rfqs() {
  const { path, can, settings } = useCompany();
  const list = useApi<{ rfqs: any[] }>(path("/purchasing/rfqs"));
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const df = settings?.company.date_format;
  if (open) return <RfqView id={open} onBack={() => { setOpen(null); list.reload(); }} />;
  return (
    <Card padded={false} title="Requests for quotation" actions={can("purchase.create") && <Button onClick={() => setCreating(true)}>New RFQ</Button>}>
      {list.loading && !list.data ? <Spinner /> : !list.data?.rfqs.length ? <EmptyState title="No requests for quotation yet" body="Send one request to several suppliers. Each quotes on their supplier portal link (or you type in their quote), you compare prices side by side, and the chosen quote becomes a purchase order." /> : (
        <TableWrap><table className="table text-sm">
          <thead><tr><th>Number</th><th>Title</th><th>Date</th><th>Reply by</th><th className="num">Quotes</th><th>Status</th></tr></thead>
          <tbody>{list.data.rfqs.map((r) => (
            <tr key={r.id} className="cursor-pointer hover:bg-[var(--surface-2)]" onClick={() => setOpen(r.id)}>
              <td className="font-medium text-brand-700 dark:text-brand-300">{r.number}</td><td>{r.title}</td><td>{fmtDate(r.issue_date, df)}</td><td>{r.respond_by ? fmtDate(r.respond_by, df) : "—"}</td>
              <td className="num">{r.quotes} of {r.suppliers}</td>
              <td><Badge color={r.status === "awarded" ? "green" : r.status === "sent" ? "blue" : r.status === "cancelled" ? "gray" : "amber"}>{r.status === "awarded" ? `Awarded · ${r.awarded_to}` : r.status}</Badge></td>
            </tr>))}</tbody>
        </table></TableWrap>
      )}
      {creating && <NewRfq onClose={(id) => { setCreating(false); if (id) { list.reload(); setOpen(id); } }} />}
    </Card>
  );
}

function NewRfq({ onClose }: { onClose: (id?: string) => void }) {
  const { path } = useCompany();
  const suppliers = useApi<{ contacts: any[] }>(path("/contacts?kind=supplier&active=1&limit=500"));
  const items = useApi<{ items: any[] }>(path("/items?limit=1000"));
  const [v, setV] = useState({ title: "", respond_by: "", notes: "" });
  const [lines, setLines] = useState([{ item_id: "", description: "", quantity: "1", unit: "" }]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setLine = (i: number, patch: Partial<(typeof lines)[number]>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ id: string }>(path("/purchasing/rfqs"), { ...v, respond_by: v.respond_by || null, notes: v.notes || null, supplier_ids: chosen,
        lines: lines.filter((l) => l.description.trim()).map((l) => ({ ...l, item_id: l.item_id || null, unit: l.unit || null })) });
      onClose(r.id);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open wide title="New request for quotation" onClose={() => onClose()}
      footer={<><Button variant="secondary" onClick={() => onClose()}>Close</Button><Button loading={busy} disabled={!v.title || !chosen.length || !lines.some((l) => l.description.trim())} onClick={() => void save()}>Save draft</Button></>}>
      {error && <Alert className="mb-3">{error}</Alert>}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Title" className="sm:col-span-2" required>{(fid) => <Input id={fid} placeholder="e.g. Office laptops for March" value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} />}</Field>
        <Field label="Reply by">{(fid) => <Input id={fid} type="date" value={v.respond_by} onChange={(e) => setV({ ...v, respond_by: e.target.value })} />}</Field>
      </div>
      <h3 className="mt-4 text-sm font-semibold">What you need</h3>
      <datalist id="rfq-items">{items.data?.items.map((i) => <option key={i.id} value={i.name} />)}</datalist>
      <div className="mt-2 grid gap-2">{lines.map((l, i) => (
        <div key={i} className="grid grid-cols-[1fr_6rem_6rem_auto] gap-2">
          <Input aria-label="Item" list="rfq-items" placeholder="Item or description" value={l.description} onChange={(e) => { const it = items.data?.items.find((x) => x.name === e.target.value); setLine(i, { description: e.target.value, item_id: it?.id ?? "", unit: l.unit || (it?.unit ?? "") }); }} />
          <Input aria-label="Quantity" inputMode="decimal" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} />
          <Input aria-label="Unit" placeholder="unit" value={l.unit} onChange={(e) => setLine(i, { unit: e.target.value })} />
          <Button variant="ghost" size="sm" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remove</Button>
        </div>))}
      </div>
      <Button className="mt-2" size="sm" variant="secondary" onClick={() => setLines([...lines, { item_id: "", description: "", quantity: "1", unit: "" }])}>Add line</Button>
      <h3 className="mt-4 text-sm font-semibold">Suppliers to ask</h3>
      <div className="mt-2 grid max-h-48 gap-1 overflow-y-auto sm:grid-cols-2">{suppliers.data?.contacts.map((s) => (
        <label key={s.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={chosen.includes(s.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, s.id] : chosen.filter((x) => x !== s.id))} />{s.name}</label>))}
      </div>
      <Field label="Notes for suppliers" className="mt-3">{(fid) => <Input id={fid} placeholder="Delivery address, brand, payment terms…" value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} />}</Field>
    </Modal>
  );
}

function RfqView({ id, onBack }: { id: string; onBack: () => void }) {
  const { path, money, can, id: cid, settings } = useCompany();
  const nav = useNavigate();
  const toast = useToast();
  const x = useApi<any>(path(`/purchasing/rfqs/${id}`));
  const [links, setLinks] = useState<{ name: string; url: string }[] | null>(null);
  const [entering, setEntering] = useState<string | null>(null);
  if (!x.data) return <Spinner />;
  const { rfq, lines, suppliers, quotes, totals, best, lowest } = x.data;
  const price = (s: string, l: string) => quotes.find((q: any) => q.contact_id === s && q.line_id === l)?.unit_price;
  const df = settings?.company.date_format;
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>← All RFQs</Button>
        <h2 className="text-lg font-semibold">{rfq.number} · {rfq.title}</h2>
        <Badge color={rfq.status === "awarded" ? "green" : rfq.status === "sent" ? "blue" : "gray"}>{rfq.status}</Badge>
        <span className="flex-1" />
        {can("purchase.create") && (rfq.status === "draft" || rfq.status === "sent") && <Button onClick={async () => {
          try { const r = await api.post<{ links: any[] }>(path(`/purchasing/rfqs/${id}/send`)); setLinks(r.links); x.reload(); }
          catch (e) { toast("error", errorMessage(e)); }
        }}>{rfq.status === "draft" ? "Send to suppliers" : "Supplier links"}</Button>}
        {can("purchase.create") && (rfq.status === "draft" || rfq.status === "sent") && <Button variant="ghost" onClick={async () => { if (!confirm("Cancel this RFQ?")) return; await api.post(path(`/purchasing/rfqs/${id}/cancel`)); x.reload(); }}>Cancel RFQ</Button>}
        {rfq.po_id && <Link className="text-sm text-brand-700 underline dark:text-brand-300" to={docPath(cid, "purchase_order", rfq.po_id)}>Open the purchase order</Link>}
      </div>
      <p className="mb-3 text-sm muted">Issued {fmtDate(rfq.issue_date, df)}{rfq.respond_by ? ` · reply by ${fmtDate(rfq.respond_by, df)}` : ""}{rfq.notes ? ` · ${rfq.notes}` : ""}</p>
      <Card padded={false} title="Quote comparison (price per unit)">
        <TableWrap><table className="table text-sm">
          <thead><tr><th>Item</th><th className="num">Qty</th>{suppliers.map((s: any) => <th key={s.contact_id} className="num">{s.name}<span className="block text-[10px] font-normal normal-case">{s.status === "quoted" ? (s.delivery_days != null ? `${s.delivery_days} days delivery` : "quoted") : s.status}</span></th>)}</tr></thead>
          <tbody>
            {lines.map((l: any) => <tr key={l.id}><td>{l.description}</td><td className="num">{qty(l.qty_milli)} {l.unit ?? ""}</td>
              {suppliers.map((s: any) => { const p = price(s.contact_id, l.id); return <td key={s.contact_id} className={`num ${p != null && p === lowest[l.id] ? "font-semibold text-emerald-700 dark:text-emerald-400" : ""}`}>{p != null ? money(p, s.currency ?? undefined) : "—"}</td>; })}</tr>)}
            <tr className="font-semibold"><td>Total</td><td />{suppliers.map((s: any) => { const t = totals.find((y: any) => y.contact_id === s.contact_id); return <td key={s.contact_id} className="num">{s.status === "quoted" ? <>{money(t.total, s.currency ?? undefined)}{best === s.contact_id && <span className="ml-1"><Badge color="green">lowest</Badge></span>}{!t.complete && <span className="block text-[10px] font-normal muted">not all lines</span>}</> : "—"}</td>; })}</tr>
            {(rfq.status === "sent" && can("purchase.create")) && <tr><td colSpan={2} />{suppliers.map((s: any) => <td key={s.contact_id} className="num whitespace-nowrap">
              <Button size="sm" variant="ghost" onClick={() => setEntering(s.contact_id)}>{s.status === "quoted" ? "Edit quote" : "Enter quote"}</Button>
              {s.status === "quoted" && <Button size="sm" onClick={async () => {
                if (!confirm(`Award to ${s.name} and make a purchase order at their prices?`)) return;
                try { const r = await api.post<{ po_id: string }>(path(`/purchasing/rfqs/${id}/award`), { contact_id: s.contact_id }); toast("success", "Draft purchase order made: check and issue it"); nav(docPath(cid, "purchase_order", r.po_id)); }
                catch (e) { toast("error", errorMessage(e)); }
              }}>Award</Button>}</td>)}</tr>}
          </tbody>
        </table></TableWrap>
      </Card>
      {suppliers.some((s: any) => s.notes) && <Card className="mt-3" title="Supplier notes">{suppliers.filter((s: any) => s.notes).map((s: any) => <p key={s.contact_id} className="text-sm"><b>{s.name}:</b> {s.notes}</p>)}</Card>}
      {links && <Modal open title="Send these links" onClose={() => setLinks(null)}>
        <p className="text-sm muted">Each supplier sees this RFQ on their private portal link and quotes there. Send each link by WhatsApp or email.</p>
        <div className="mt-3 grid gap-2">{links.map((l) => <div key={l.url} className="flex items-center gap-2"><span className="w-40 truncate text-sm font-medium">{l.name}</span><Input readOnly value={l.url} className="font-mono text-xs" onFocus={(e) => e.target.select()} aria-label={`Link for ${l.name}`} />
          <Button variant="secondary" aria-label="Copy" onClick={() => { void navigator.clipboard?.writeText(l.url); toast("success", "Copied"); }}><Copy className="h-4 w-4" /></Button>
          <a className="rounded-lg border border-[var(--border)] px-2 py-1.5 text-xs" target="_blank" rel="noreferrer" href={`https://wa.me/?text=${encodeURIComponent(`Please quote for ${rfq.title} (${rfq.number}) here: ${l.url}`)}`}>WhatsApp</a></div>)}</div>
      </Modal>}
      {entering && <EnterQuote rfqId={id} lines={lines} supplier={suppliers.find((s: any) => s.contact_id === entering)} prices={quotes.filter((q: any) => q.contact_id === entering)} onClose={(ok) => { setEntering(null); if (ok) x.reload(); }} />}
    </>
  );
}

function EnterQuote({ rfqId, lines, supplier, prices, onClose }: { rfqId: string; lines: any[]; supplier: any; prices: any[]; onClose: (ok: boolean) => void }) {
  const { path } = useCompany();
  const [p, setP] = useState<Record<string, string>>(Object.fromEntries(prices.map((x) => [x.line_id, String(x.unit_price / 100)])));
  const [days, setDays] = useState(supplier.delivery_days != null ? String(supplier.delivery_days) : "");
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal open title={`Quote from ${supplier.name}`} onClose={() => onClose(false)}
      footer={<><Button variant="secondary" onClick={() => onClose(false)}>Close</Button><Button onClick={async () => {
        try { await api.post(path(`/purchasing/rfqs/${rfqId}/quotes/${supplier.contact_id}`), { prices: Object.entries(p).filter(([, v]) => v !== "").map(([line_id, unit_price]) => ({ line_id, unit_price })), delivery_days: days ? Number(days) : null }); onClose(true); }
        catch (e) { setError(errorMessage(e)); }
      }}>Save quote</Button></>}>
      {error && <Alert className="mb-3">{error}</Alert>}
      <p className="mb-2 text-sm muted">For a quote that came by email, phone or on paper.</p>
      <div className="grid gap-2">{lines.map((l) => <Field key={l.id} label={`${l.description} (${qty(l.qty_milli)} ${l.unit ?? ""}) — price per unit`}>{(fid) => <Input id={fid} inputMode="decimal" value={p[l.id] ?? ""} onChange={(e) => setP({ ...p, [l.id]: e.target.value })} />}</Field>)}
        <Field label="Delivery (days)">{(fid) => <Input id={fid} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />}</Field></div>
    </Modal>
  );
}

// ── Goods receipts ──

function Grns() {
  const { path, can, settings, id: cid } = useCompany();
  const list = useApi<{ grns: any[] }>(path("/purchasing/grns"));
  const [receiving, setReceiving] = useState(false);
  const df = settings?.company.date_format;
  return (
    <Card padded={false} title="Goods receipts" actions={can("purchase.create") && <Button onClick={() => setReceiving(true)}>Receive goods</Button>}>
      {list.loading && !list.data ? <Spinner /> : !list.data?.grns.length ? <EmptyState title="No goods received yet" body="When goods arrive, record what came against the purchase order, and how much was accepted or rejected after checking it." /> : (
        <TableWrap><table className="table text-sm">
          <thead><tr><th>GRN</th><th>Date</th><th>Supplier</th><th>Purchase order</th><th>Supplier's ref.</th><th>Quality</th><th>Status</th></tr></thead>
          <tbody>{list.data.grns.map((g) => <tr key={g.id}><td className="font-medium">{g.number}</td><td>{fmtDate(g.receipt_date, df)}</td><td>{g.supplier}</td>
            <td><Link className="text-brand-700 hover:underline dark:text-brand-300" to={docPath(cid, "purchase_order", g.po_id)}>{g.po_number}</Link></td><td>{g.supplier_ref ?? ""}</td>
            <td>{g.rejected > 0 ? <Badge color="amber">{qty(g.rejected)} rejected</Badge> : <Badge color="green">All accepted</Badge>}</td>
            <td>{g.status === "void" ? <Badge>cancelled</Badge> : <Badge color="green">received</Badge>}</td></tr>)}</tbody>
        </table></TableWrap>
      )}
      <p className="px-4 pb-3 text-xs muted">A goods receipt is for checking deliveries and bills; stock and your accounts move when you enter the supplier's bill (convert the purchase order to a bill).</p>
      {receiving && <Receive onClose={(ok) => { setReceiving(false); if (ok) list.reload(); }} />}
    </Card>
  );
}

function Receive({ onClose }: { onClose: (ok: boolean) => void }) {
  const { path } = useCompany();
  const toast = useToast();
  const pos = useApi<{ documents: any[] }>(path("/documents?type=purchase_order&limit=200"));
  const [poId, setPoId] = useState("");
  const match = useApi<any>(poId ? path(`/purchasing/match/${poId}`) : null);
  const [rows, setRows] = useState<Record<number, { received: string; rejected: string; reason: string }>>({});
  const [ref, setRef] = useState("");
  const [date, setDate] = useState(today());
  const [error, setError] = useState<string | null>(null);
  const open = (pos.data?.documents ?? []).filter((d) => ["open", "accepted", "converted"].includes(d.status));
  return (
    <Modal open wide title="Receive goods" onClose={() => onClose(false)}
      footer={<><Button variant="secondary" onClick={() => onClose(false)}>Close</Button><Button disabled={!poId} onClick={async () => {
        try {
          const r = await api.post<{ number: string }>(path("/purchasing/grns"), { po_id: poId, receipt_date: date, supplier_ref: ref || null,
            lines: Object.entries(rows).filter(([, v]) => v.received).map(([n, v]) => ({ line_no: Number(n), received: v.received, rejected: v.rejected || "0", reject_reason: v.reason || null })) });
          toast("success", `${r.number} saved`); onClose(true);
        } catch (e) { setError(errorMessage(e)); }
      }}>Save goods receipt</Button></>}>
      {error && <Alert className="mb-3">{error}</Alert>}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Purchase order" required>{(fid) => <Select id={fid} value={poId} onChange={(e) => { setPoId(e.target.value); setRows({}); }}><option value="">Choose…</option>{open.map((d) => <option key={d.id} value={d.id}>{d.number} · {d.contact_name ?? d.party ?? ""}</option>)}</Select>}</Field>
        <Field label="Received on">{(fid) => <Input id={fid} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
        <Field label="Supplier's delivery note / invoice no.">{(fid) => <Input id={fid} value={ref} onChange={(e) => setRef(e.target.value)} />}</Field>
      </div>
      {match.data && <TableWrap><table className="table mt-3 text-sm">
        <thead><tr><th>Item</th><th className="num">Ordered</th><th className="num">Received before</th><th>Received now</th><th>Rejected</th><th>Reason for rejecting</th></tr></thead>
        <tbody>{match.data.rows.map((l: any) => { const v = rows[l.line_no] ?? { received: "", rejected: "", reason: "" }; const set = (p: Partial<typeof v>) => setRows({ ...rows, [l.line_no]: { ...v, ...p } }); return (
          <tr key={l.line_no}><td>{l.description}</td><td className="num">{qty(l.ordered)}</td><td className="num">{qty(l.received)}</td>
            <td><Input aria-label="Received now" className="w-24" inputMode="decimal" value={v.received} placeholder={String(Math.max(0, (l.ordered - l.received) / 1000))} onChange={(e) => set({ received: e.target.value })} /></td>
            <td><Input aria-label="Rejected" className="w-20" inputMode="decimal" value={v.rejected} onChange={(e) => set({ rejected: e.target.value })} /></td>
            <td><Input aria-label="Reason" value={v.reason} placeholder={v.rejected ? "Required" : ""} onChange={(e) => set({ reason: e.target.value })} /></td></tr>); })}</tbody>
      </table></TableWrap>}
    </Modal>
  );
}

// ── 3-way match ──

function Matching() {
  const { path, money, settings, id: cid } = useCompany();
  const list = useApi<{ orders: any[] }>(path("/purchasing/match"));
  const [open, setOpen] = useState<string | null>(null);
  const detail = useApi<any>(open ? path(`/purchasing/match/${open}`) : null);
  const df = settings?.company.date_format;
  return (
    <>
      <Card padded={false} title="Purchase orders: order × goods receipt × bill">
        {list.loading && !list.data ? <Spinner /> : !list.data?.orders.length ? <EmptyState title="No purchase orders yet" /> : (
          <TableWrap><table className="table text-sm">
            <thead><tr><th>Order</th><th>Date</th><th>Supplier</th><th className="num">Amount</th><th>Match</th><th>Issues</th></tr></thead>
            <tbody>{list.data.orders.map((o) => <tr key={o.id} className="cursor-pointer hover:bg-[var(--surface-2)]" onClick={() => setOpen(o.id)}>
              <td className="font-medium text-brand-700 dark:text-brand-300">{o.number}</td><td>{fmtDate(o.issue_date, df)}</td><td>{o.supplier}</td><td className="num">{money(o.total, o.currency)}</td>
              <td><Badge color={MATCH[o.status].color}>{MATCH[o.status].label}</Badge></td>
              <td className="space-x-1">{o.issues.map((i: string) => <Badge key={i} color={ISSUE[i].color}>{ISSUE[i].label}</Badge>)}</td></tr>)}</tbody>
          </table></TableWrap>
        )}
      </Card>
      {open && detail.data && <Card className="mt-4" padded={false} title={<span>{detail.data.po.number} <Link className="ml-2 text-sm font-normal text-brand-700 underline dark:text-brand-300" to={docPath(cid, "purchase_order", open)}>open order</Link></span>}>
        <TableWrap><table className="table text-sm">
          <thead><tr><th>Item</th><th className="num">Ordered</th><th className="num">Received</th><th className="num">Accepted</th><th className="num">Billed</th><th className="num">Order price</th><th className="num">Bill price</th><th>Bills</th><th>Check</th></tr></thead>
          <tbody>{detail.data.rows.map((r: any) => <tr key={r.line_no}><td>{r.description}</td><td className="num">{qty(r.ordered)}</td><td className="num">{qty(r.received)}</td><td className="num">{qty(r.accepted)}</td>
            <td className={`num ${r.billed > r.accepted ? "font-semibold text-red-600" : ""}`}>{qty(r.billed)}</td><td className="num">{money(r.order_price, detail.data.po.currency)}</td>
            <td className={`num ${r.bill_price != null && r.bill_price > r.order_price ? "font-semibold text-red-600" : ""}`}>{r.bill_price != null ? money(r.bill_price, detail.data.po.currency) : "—"}</td>
            <td>{r.bills.join(", ")}</td><td className="space-x-1">{r.issues.length ? r.issues.map((i: string) => <Badge key={i} color={ISSUE[i].color}>{ISSUE[i].label}</Badge>) : <Badge color="green">OK</Badge>}</td></tr>)}</tbody>
        </table></TableWrap>
        <p className="px-4 pb-3 text-xs muted">Pay only for what was received and accepted, at the ordered price. For a difference, ask the supplier for a credit note, or record a debit note.</p>
      </Card>}
    </>
  );
}
