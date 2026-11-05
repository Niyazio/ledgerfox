import { useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { useCompany } from "../lib/company";
import { useApi } from "../lib/hooks";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, LinkButton, PageHeader, Spinner, Stat, TableWrap, Tabs } from "../components/ui";
import { DOC_LABELS, fmtDate, pct, qty } from "../lib/format";
import { contactPath, docPath, sourcePath } from "../lib/links";

type Tab = "overview" | "stock" | "batches" | "production" | "sales" | "deliveries" | "purchases" | "payments";

interface PaidVia { kind: "cash" | "bank" | "other" | "note"; account: string; amount: number }
interface DocRow {
  document_id: string; doc_type: string; number: string | null; issue_date: string; due_date: string | null; contact_id: string; contact: string; branch: string | null;
  qty_milli: number; unit_price: number; currency: string; taxable_base: number; cost?: number; total: number; amount_settled: number; batch_no: string | null; paid_via: PaidVia[];
}
interface PaySummary { documents: number; total: number; settled: number; outstanding: number; cash: number; bank: number; other: number; note: number }

const A = ({ to, children }: { to: string | null; children: ReactNode }) => (to ? <Link className="text-brand-700 hover:underline dark:text-brand-300" to={to}>{children}</Link> : <>{children}</>);

/** /inventory/:itemId — everything about one product, each figure linked to where it comes from. */
export function ProductView() {
  const { path, money, id, settings, can } = useCompany();
  const { itemId } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "overview";
  const [from, setFrom] = useState(params.get("from") ?? "");
  const [to, setTo] = useState(params.get("to") ?? "");
  const query = [params.get("from") && `from=${params.get("from")}`, params.get("to") && `to=${params.get("to")}`].filter(Boolean).join("&");
  const { data, error, loading } = useApi<any>(path(`/items/${itemId}/insights${query ? `?${query}` : ""}`));
  const df = settings?.company.date_format;
  if (error) return <Alert>{error}</Alert>;
  if (loading && !data) return <Spinner />;
  const it = data.item, s = data.sales, p = data.purchases, cost: boolean = data.can.cost;
  const unit = it.unit ?? "";
  const q = (m: number) => `${qty(m)} ${unit}`.trim();
  const setTab = (t: Tab) => setParams((sp) => { if (t === "overview") sp.delete("tab"); else sp.set("tab", t); return sp; });
  const docLabel = (r: { doc_type: string; number: string | null }) => `${DOC_LABELS[r.doc_type]?.one ?? r.doc_type} ${r.number ?? ""}`.trim();
  const status = (r: DocRow) => {
    const due = r.total - r.amount_settled;
    if (due <= 0) return <Badge color="green">Paid</Badge>;
    if (r.amount_settled > 0) return <Badge color="amber">Part paid</Badge>;
    return <Badge color={r.due_date && r.due_date < new Date().toISOString().slice(0, 10) ? "red" : "gray"}>Unpaid</Badge>;
  };
  const via = (list: PaidVia[], currency: string) => list.length ? (
    <span className="text-xs">{list.map((v, i) => <span key={i} className="mr-2 whitespace-nowrap"><Badge color={v.kind === "cash" ? "green" : v.kind === "bank" ? "blue" : "gray"}>{v.kind === "note" ? "note" : v.kind}</Badge> {money(v.amount, currency)}<span className="muted"> {v.account}</span></span>)}</span>
  ) : <span className="text-xs muted">—</span>;
  const hasBatches = data.batches.length > 0 || it.track_batches;
  const hasProduction = data.production.made.length > 0 || data.production.used_in.length > 0;
  const tabs: { value: Tab; label: string }[] = [
    { value: "overview", label: "Overview" },
    ...(it.track_inventory ? [{ value: "stock" as Tab, label: "Stock by branch" }] : []),
    ...(hasBatches ? [{ value: "batches" as Tab, label: "Batches & expiry" }] : []),
    ...(hasProduction ? [{ value: "production" as Tab, label: "Production" }] : []),
    ...(s ? [{ value: "sales" as Tab, label: "Sales" }] : []),
    ...(s?.deliveries.length ? [{ value: "deliveries" as Tab, label: "Deliveries" }] : []),
    ...(p ? [{ value: "purchases" as Tab, label: "Purchases" }] : []),
    ...(s || p ? [{ value: "payments" as Tab, label: "Payments" }] : []),
  ];
  const payCard = (title: string, sum: PaySummary, people: string) => (
    <Card title={title}>
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
        <div><dt className="muted">{sum.documents} {people}</dt><dd className="text-lg font-semibold">{money(sum.total)}</dd></div>
        <div><dt className="muted">Paid</dt><dd className="text-lg font-semibold text-emerald-700 dark:text-emerald-400">{money(sum.settled)}</dd></div>
        <div><dt className="muted">Outstanding</dt><dd className={`text-lg font-semibold ${sum.outstanding > 0 ? "text-amber-700 dark:text-amber-300" : ""}`}>{money(sum.outstanding)}</dd></div>
        <div><dt className="muted">By cash</dt><dd>{money(sum.cash)}</dd></div>
        <div><dt className="muted">By bank</dt><dd>{money(sum.bank)}</dd></div>
        {(sum.note !== 0 || sum.other !== 0) && <div><dt className="muted">Notes / other</dt><dd>{money(sum.note + sum.other)}</dd></div>}
      </dl>
      <p className="mt-3 text-xs muted">Payments are made per {people === "invoices" ? "invoice" : "bill"}, so these are the totals of every {people === "invoices" ? "invoice" : "bill"} this product is on.</p>
    </Card>
  );
  const docTable = (rows: DocRow[], who: string, withCost: boolean) => rows.length ? (
    <TableWrap><table className="table">
      <thead><tr><th>Date</th><th>Document</th><th>{who}</th><th>Branch</th><th className="num">Qty</th><th className="num">Rate</th><th className="num">Amount</th>{withCost && <><th className="num">Cost</th><th className="num">Profit</th></>}<th>Payment</th></tr></thead>
      <tbody>{rows.map((r, i) => {
        const sign = r.doc_type === "credit_note" || r.doc_type === "debit_note" ? -1 : 1;
        return (
          <tr key={`${r.document_id}-${i}`}>
            <td className="whitespace-nowrap">{fmtDate(r.issue_date, df)}</td>
            <td className="whitespace-nowrap"><A to={docPath(id, r.doc_type, r.document_id)}>{docLabel(r)}</A>{r.batch_no && <span className="block font-mono text-xs muted">{r.batch_no}</span>}</td>
            <td><A to={contactPath(id, r.contact_id)}>{r.contact}</A></td>
            <td>{r.branch ?? "—"}</td>
            <td className="num">{sign < 0 ? "−" : ""}{q(r.qty_milli)}</td>
            <td className="num">{money(r.unit_price, r.currency)}</td>
            <td className="num">{money(sign * r.taxable_base)}</td>
            {withCost && <><td className="num">{r.cost ? money(sign * Math.abs(r.cost)) : "—"}</td><td className="num">{r.cost ? money(sign * (r.taxable_base - Math.abs(r.cost))) : "—"}</td></>}
            <td>{sign > 0 ? <>{status(r)} {via(r.paid_via, r.currency)}</> : <span className="text-xs muted">return</span>}</td>
          </tr>
        );
      })}</tbody>
    </table></TableWrap>
  ) : <EmptyState title="Nothing in this period" />;

  return (
    <>
      <PageHeader title={it.name} subtitle={[it.code && `Code ${it.code}`, it.sku && `SKU ${it.sku}`, it.barcode && `Barcode ${it.barcode}`, it.hsn_sac && `HSN/SAC ${it.hsn_sac}`].filter(Boolean).join(" · ")}
        back={{ to: `/app/${id}/inventory`, label: "Products & inventory" }}
        actions={<>
          {can("labels.print") && <LinkButton variant="secondary" to={`/app/${id}/labels?item=${it.id}`}>Labels</LinkButton>}
          {can("sales.create") && <LinkButton variant="secondary" to={`/app/${id}/sales/invoice/new?item=${it.id}`}>Sell</LinkButton>}
          {can("purchase.create") && <LinkButton to={`/app/${id}/purchases/bill/new?item=${it.id}`}>Buy</LinkButton>}
        </>} />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="From">{(fid) => <Input id={fid} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label="To">{(fid) => <Input id={fid} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
        <Button variant="secondary" onClick={() => setParams((sp) => { if (from) sp.set("from", from); else sp.delete("from"); if (to) sp.set("to", to); else sp.delete("to"); return sp; })}>Apply</Button>
        {(params.get("from") || params.get("to")) && <Button variant="ghost" onClick={() => { setFrom(""); setTo(""); setParams((sp) => { sp.delete("from"); sp.delete("to"); return sp; }); }}>All dates</Button>}
        <span className="pb-2 text-xs muted">Dates filter sales, purchases and deliveries. Stock is always today's.</span>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      <div className="mt-4 space-y-4">
        {tab === "overview" && <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Sale price" value={money(it.sale_price)} sub={cost && it.purchase_price != null ? `Purchase price ${money(it.purchase_price)}` : undefined} />
            {it.track_inventory ? <Stat label="In stock" value={q(data.stock.qty_milli)} sub={cost ? `Value ${money(data.stock.value)} · average cost ${money(data.stock.avg_cost)}` : undefined} tone={it.reorder_level_milli > 0 && data.stock.qty_milli <= it.reorder_level_milli ? "bad" : "neutral"} /> : <Stat label="Type" value={it.kind === "service" ? "Service" : "Not tracked in stock"} />}
            {s && <Stat label="Sold" value={q(s.summary.qty_milli)} sub={`${money(s.summary.revenue)} · ${s.summary.invoices} invoice${s.summary.invoices === 1 ? "" : "s"} · ${s.summary.customers} customer${s.summary.customers === 1 ? "" : "s"}`} />}
            {s && cost && <Stat label="Profit" value={money(s.summary.profit)} tone={s.summary.profit < 0 ? "bad" : "good"} sub={s.summary.margin_bp != null ? `Margin ${pct(s.summary.margin_bp)} · cost ${money(s.summary.cost)}` : undefined} />}
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {s && <Card title="Best customers" padded={false}>{s.top_customers.length ? <TableWrap><table className="table">
              <thead><tr><th>Customer</th><th className="num">Qty</th><th className="num">Sales</th><th>Last bought</th></tr></thead>
              <tbody>{s.top_customers.map((c: any) => <tr key={c.id}><td><A to={contactPath(id, c.id)}>{c.name}</A></td><td className="num">{q(c.qty_milli)}</td><td className="num">{money(c.revenue)}</td><td>{fmtDate(c.last_bought, df)}</td></tr>)}</tbody>
            </table></TableWrap> : <EmptyState title="Not sold yet" />}</Card>}
            {p && <Card title="Suppliers" padded={false}>{p.suppliers.length ? <TableWrap><table className="table">
              <thead><tr><th>Supplier</th><th className="num">Qty</th><th className="num">Spent</th><th className="num">Rate (low – high)</th><th>Last bought</th></tr></thead>
              <tbody>{p.suppliers.map((c: any) => <tr key={c.id}><td><A to={contactPath(id, c.id)}>{c.name}</A></td><td className="num">{q(c.qty_milli)}</td><td className="num">{money(c.spent)}</td><td className="num">{money(c.lowest_price)} – {money(c.highest_price)}</td><td>{fmtDate(c.last_bought, df)}</td></tr>)}</tbody>
            </table></TableWrap> : <EmptyState title="Not bought yet" />}</Card>}
          </div>
          {s && s.monthly.length > 0 && <Card title="Last 12 months" padded={false}><TableWrap><table className="table">
            <thead><tr><th>Month</th><th className="num">Qty sold</th><th className="num">Sales</th>{cost && <><th className="num">Cost</th><th className="num">Profit</th></>}</tr></thead>
            <tbody>{s.monthly.map((m: any) => <tr key={m.month}><td>{m.month}</td><td className="num">{q(m.qty_milli)}</td><td className="num">{money(m.revenue)}</td>{cost && <><td className="num">{money(m.cost)}</td><td className="num">{money(m.revenue - m.cost)}</td></>}</tr>)}</tbody>
          </table></TableWrap></Card>}
          {s?.by_branch.length > 1 && <Card title="Sales by branch" padded={false}><TableWrap><table className="table">
            <thead><tr><th>Branch</th><th className="num">Qty sold</th><th className="num">Sales</th></tr></thead>
            <tbody>{s.by_branch.map((b: any, i: number) => <tr key={i}><td>{b.branch ?? "No branch"}</td><td className="num">{q(b.qty_milli)}</td><td className="num">{money(b.revenue)}</td></tr>)}</tbody>
          </table></TableWrap></Card>}
        </>}

        {tab === "stock" && <Card padded={false}>{data.warehouses.length ? <TableWrap><table className="table">
          <thead><tr><th>Branch</th><th>Warehouse</th><th className="num">In stock</th>{cost && <th className="num">Value</th>}<th className="num">Bought</th><th className="num">Made</th><th className="num">Sold</th><th className="num">Transfers in/out</th></tr></thead>
          <tbody>{data.warehouses.map((w: any) => <tr key={w.warehouse_id}><td>{w.branch ?? "—"}</td><td>{w.warehouse}</td><td className="num font-medium">{q(w.qty_milli)}</td>{cost && <td className="num">{money(w.value)}</td>}<td className="num">{q(w.bought_milli)}</td><td className="num">{q(w.produced_milli)}</td><td className="num">{q(w.sold_milli)}</td><td className="num">{q(w.transferred_milli)}</td></tr>)}</tbody>
          <tfoot><tr className="font-semibold"><td colSpan={2}>Total</td><td className="num">{q(data.stock.qty_milli)}</td>{cost && <td className="num">{money(data.stock.value)}</td>}<td colSpan={4} /></tr></tfoot>
        </table></TableWrap> : <EmptyState title="No stock yet" body="Stock arrives through bills, production or an opening-stock adjustment." />}</Card>}

        {tab === "batches" && <Card padded={false}>{data.batches.length ? <TableWrap><table className="table">
          <thead><tr><th>Batch</th><th>Warehouse</th><th>Received / made</th><th>From</th><th>Expiry</th><th className="num">Left</th></tr></thead>
          <tbody>{data.batches.map((b: any, i: number) => {
            const days = b.expiry_date ? Math.round((Date.parse(b.expiry_date) - Date.now()) / 86_400_000) : null;
            return <tr key={i} className={b.qty_milli <= 0 ? "opacity-60" : ""}><td className="font-mono">{b.batch_no}</td><td>{b.warehouse}</td><td>{fmtDate(b.received_on, df)}</td>
              <td>{b.source_type ? <A to={sourcePath(id, b.source_type, b.source_id)}>{b.source_label ?? b.source_type}</A> : "—"}</td>
              <td>{b.expiry_date ? <>{fmtDate(b.expiry_date, df)} {days! < 0 ? <Badge color="red">expired</Badge> : days! <= 60 ? <Badge color="amber">{days} days</Badge> : null}</> : "—"}</td>
              <td className="num">{q(b.qty_milli)}</td></tr>;
          })}</tbody>
        </table></TableWrap> : <EmptyState title="No batches yet" />}</Card>}

        {tab === "production" && <>
          <Card title="Made" padded={false}>{data.production.made.length ? <TableWrap><table className="table">
            <thead><tr><th>Date</th><th>Entry</th><th>Warehouse</th><th>Batch / expiry</th><th className="num">Qty</th>{cost && <><th className="num">Materials</th><th className="num">Extra costs</th><th className="num">Total</th><th className="num">Per unit</th></>}</tr></thead>
            <tbody>{data.production.made.map((m: any) => <tr key={m.id} className={m.status === "void" ? "line-through opacity-60" : ""}><td>{fmtDate(m.production_date, df)}</td><td><A to={`/app/${id}/production`}>{m.number}</A></td><td>{m.warehouse}</td>
              <td className="text-xs">{m.batch_no ?? "—"}{m.expiry_date ? ` · ${fmtDate(m.expiry_date, df)}` : ""}</td><td className="num">{q(m.qty_milli)}</td>
              {cost && <><td className="num">{money(m.material_cost)}</td><td className="num">{money(m.extra_cost)}</td><td className="num">{money(m.total_cost)}</td><td className="num">{money(Math.round((m.total_cost * 1000) / m.qty_milli))}</td></>}</tr>)}</tbody>
          </table></TableWrap> : <EmptyState title="Not made here" />}</Card>
          {data.production.used_in.length > 0 && <Card title="Used as a material in" padded={false}><TableWrap><table className="table">
            <thead><tr><th>Date</th><th>Entry</th><th>Product made</th><th className="num">Qty used</th>{cost && <th className="num">Cost</th>}</tr></thead>
            <tbody>{data.production.used_in.map((m: any, i: number) => <tr key={i} className={m.status === "void" ? "line-through opacity-60" : ""}><td>{fmtDate(m.production_date, df)}</td><td><A to={`/app/${id}/production`}>{m.number}</A></td>
              <td><A to={`/app/${id}/inventory/${m.product_id}`}>{m.product}</A></td><td className="num">{q(m.qty_milli)}</td>{cost && <td className="num">{money(m.value)}</td>}</tr>)}</tbody>
          </table></TableWrap></Card>}
        </>}

        {tab === "sales" && s && <Card padded={false}>{docTable(s.rows, "Customer", cost)}</Card>}

        {tab === "deliveries" && s && <Card padded={false}><TableWrap><table className="table">
          <thead><tr><th>Date</th><th>Delivery challan</th><th>Customer</th><th>Status</th><th className="num">Qty</th></tr></thead>
          <tbody>{s.deliveries.map((d: any, i: number) => <tr key={i}><td>{fmtDate(d.issue_date, df)}</td><td><A to={docPath(id, "sales_order", d.document_id, "delivery_challan")}>{d.number ?? "(draft)"}</A></td><td><A to={contactPath(id, d.contact_id)}>{d.contact}</A></td><td><Badge>{d.status}</Badge></td><td className="num">{q(d.qty_milli)}</td></tr>)}</tbody>
        </table></TableWrap></Card>}

        {tab === "purchases" && p && <Card padded={false}>{docTable(p.rows, "Supplier", false)}</Card>}

        {tab === "payments" && <div className="grid gap-4 lg:grid-cols-2">
          {s && payCard("Received from customers", s.payments, "invoices")}
          {p && payCard("Paid to suppliers", p.payments, "bills")}
        </div>}
      </div>
    </>
  );
}
