import { useEffect, useState } from "react";
import { Plus, QrCode } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router";
import QRCode from "qrcode";
import { code128Svg, productQrPayload } from "@shared/barcode";
import { saveFile } from "../lib/download";
import { useCompany } from "../lib/company";
import { useApi, useAction } from "../lib/hooks";
import { api, errorMessage } from "../lib/api";
import { Alert, Badge, Button, Card, ConfirmButton, EmptyState, Field, Input, LinkButton, Modal, MoneyInput, PageHeader, Select, Spinner, TableWrap, Tabs, Textarea, useToast, DownloadButtons } from "../components/ui";
import { ScanInput } from "../components/Scanner";
import { downloadCsv } from "../lib/csv";
import { AccountSelect, TaxSelect } from "../components/pickers";
import { fmtDate, qty, today, toInput } from "../lib/format";

/** The product's QR (a link that opens billing on any phone) and barcode, as printed on its labels. */
function ProductCodes({ item }: { item: { id: string; name: string; code: string | null; barcode: string | null } }) {
  const { id: companyId } = useCompany();
  const nav = useNavigate();
  const [qr, setQr] = useState("");
  const code = item.code ?? "";
  useEffect(() => { if (code) QRCode.toDataURL(productQrPayload(code, location.origin), { margin: 1, width: 360, errorCorrectionLevel: "M" }).then(setQr); }, [code]);
  if (!code) return null;
  const bar = item.barcode || code;
  const download = async () => saveFile(await (await fetch(qr)).blob(), `QR-${code}.png`);
  return (
    <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-3 sm:col-span-2">
      {qr && <img src={qr} alt={`QR code for ${code}`} className="h-28 w-28 rounded-lg bg-white p-1" />}
      <div className="min-w-0 flex-1 space-y-2">
        <div className="max-w-[16rem] rounded bg-white p-1" dangerouslySetInnerHTML={{ __html: code128Svg(bar) }} />
        <p className="font-mono text-sm">{bar}</p>
        <p className="text-xs muted">Scan in POS, or with any phone camera while signed in: billing opens with this product added.</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" onClick={() => nav(`/app/${companyId}/labels?item=${item.id}`)}><QrCode className="h-4 w-4" />Print labels</Button>
          <Button type="button" size="sm" variant="secondary" disabled={!qr} onClick={() => void download()}>Download QR</Button>
        </div>
      </div>
    </div>
  );
}

function ItemForm({ initial, onClose }: { initial?: any; onClose: (changed: boolean) => void }) {
  const { path, settings, can } = useCompany();
  // Without cost access the purchase price is neither shown nor sent; the server keeps the stored value.
  const costEditable = !initial || can("items.cost");
  const base = settings?.company.base_currency ?? "INR";
  const toast = useToast();
  const [v, setV] = useState({
    kind: initial?.kind ?? "goods", name: initial?.name ?? "", sku: initial?.sku ?? "", unit: initial?.unit ?? "nos", hsn_sac: initial?.hsn_sac ?? "", description: initial?.description ?? "",
    sale_price: initial ? toInput(initial.sale_price, base) : "", purchase_price: initial ? toInput(initial.purchase_price, base) : "", tax_code_id: initial?.tax_code_id ?? "",
    income_account_id: initial?.income_account_id ?? "", expense_account_id: initial?.expense_account_id ?? "", track_inventory: initial ? Boolean(initial.track_inventory) : false, track_batches: initial ? Boolean(initial.track_batches) : false,
    reorder_level: initial ? qty(initial.reorder_level_milli) : "0", is_active: initial ? Boolean(initial.is_active) : true,
    code: initial?.code ?? "", barcode: initial?.barcode ?? "",
  });
  const { busy, error, run } = useAction();
  const set = (k: string, val: unknown) => setV((p) => ({ ...p, [k]: val }));
  return (
    <Modal open wide onClose={() => onClose(false)} title={initial ? `Edit ${initial.name}` : "New product or service"}
      footer={<><Button variant="secondary" onClick={() => onClose(false)}>Cancel</Button><Button loading={busy} onClick={async () => {
        const body = { ...v, sku: v.sku || null, hsn_sac: v.hsn_sac || null, tax_code_id: v.tax_code_id || null, income_account_id: v.income_account_id || null, expense_account_id: v.expense_account_id || null, sale_price: v.sale_price || "0", purchase_price: costEditable ? v.purchase_price || "0" : undefined, code: v.code || null, barcode: v.barcode || null };
        if (await run(() => (initial ? api.put(path(`/items/${initial.id}`), body) : api.post(path("/items"), body)))) { toast("success", "Saved"); onClose(true); }
      }}>Save</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        {error && <Alert className="sm:col-span-2">{error}</Alert>}
        <Field label="Type">{(id) => <Select id={id} value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value, track_inventory: e.target.value === "goods" && v.track_inventory })}><option value="goods">Goods</option><option value="service">Service</option></Select>}</Field>
        <Field label="Name" required>{(id) => <Input id={id} value={v.name} onChange={(e) => set("name", e.target.value)} />}</Field>
        <Field label="SKU">{(id) => <Input id={id} value={v.sku} onChange={(e) => set("sku", e.target.value)} />}</Field>
        <Field label="Product code (QR)" hint={initial ? undefined : "Leave blank to number automatically (P000001…)"}>{(id) => <Input id={id} className="font-mono uppercase" value={v.code} maxLength={32} onChange={(e) => set("code", e.target.value)} />}</Field>
        <Field label="Barcode (EAN/UPC on the pack)" hint="Scan it here with a USB scanner, or type it">{(id) => <Input id={id} className="font-mono" value={v.barcode} maxLength={48} onChange={(e) => set("barcode", e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }} />}</Field>
        <Field label="Unit">{(id) => <Select id={id} value={v.unit} onChange={(e) => set("unit", e.target.value)}>{(settings?.units ?? []).map((u: any) => <option key={u.id} value={u.code}>{u.code} · {u.name}</option>)}</Select>}</Field>
        <Field label={v.kind === "goods" ? "HSN code" : "SAC code"}>{(id) => <Input id={id} value={v.hsn_sac} maxLength={8} onChange={(e) => set("hsn_sac", e.target.value)} />}</Field>
        <Field label="Default tax">{(id) => <TaxSelect id={id} value={v.tax_code_id} onChange={(t) => set("tax_code_id", t)} />}</Field>
        <Field label="Selling price">{(id) => <MoneyInput id={id} value={v.sale_price} onChange={(e) => set("sale_price", e.target.value)} />}</Field>
        {costEditable && <Field label="Purchase price">{(id) => <MoneyInput id={id} value={v.purchase_price} onChange={(e) => set("purchase_price", e.target.value)} />}</Field>}
        <Field label="Income account" hint="Default: Sales / Service income">{(id) => <AccountSelect id={id} value={v.income_account_id} onChange={(a) => set("income_account_id", a)} filter={(a) => a.type === "income"} placeholder="Default" />}</Field>
        {!v.track_inventory && <Field label="Expense account" hint="Default: Purchases">{(id) => <AccountSelect id={id} value={v.expense_account_id} onChange={(a) => set("expense_account_id", a)} filter={(a) => a.type === "expense" || a.type === "asset"} placeholder="Default" />}</Field>}
        {v.kind === "goods" && <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={v.track_inventory} disabled={Boolean(initial)} onChange={(e) => set("track_inventory", e.target.checked)} /> Track stock (perpetual inventory, moving average cost){initial && <span className="muted"> — fixed after creation</span>}</label>}
        {v.track_inventory && <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={v.track_batches} onChange={(e) => set("track_batches", e.target.checked)} /> Track batch numbers &amp; expiry dates (medicines, food){initial && <span className="muted"> — can only change while stock is zero</span>}</label>}
        {v.track_inventory && <Field label="Reorder level">{(id) => <Input id={id} inputMode="decimal" value={v.reorder_level} onChange={(e) => set("reorder_level", e.target.value)} />}</Field>}
        <Field label="Description" className="sm:col-span-2">{(id) => <Textarea id={id} rows={2} value={v.description} onChange={(e) => set("description", e.target.value)} />}</Field>
        {initial && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={v.is_active} onChange={(e) => set("is_active", e.target.checked)} /> Active</label>}
        {initial?.code && <ProductCodes item={initial} />}
      </div>
    </Modal>
  );
}

function StockModal({ kind, items, onClose }: { kind: "adjust" | "transfer"; items: any[]; onClose: (changed: boolean) => void }) {
  const { path, settings } = useCompany();
  const toast = useToast();
  const whs = (settings?.warehouses ?? []).filter((w: any) => w.is_active);
  const [v, setV] = useState({ item_id: "", warehouse_id: whs[0]?.id ?? "", to_warehouse_id: whs[1]?.id ?? "", date: today(), quantity: "", unit_cost: "", reason: "adjustment", memo: "", batch_no: "", expiry_date: "" });
  const { busy, error, run } = useAction();
  const tracked = items.filter((i) => i.track_inventory);
  const batched = Boolean(tracked.find((i) => i.id === v.item_id)?.track_batches);
  const adding = kind === "adjust" && parseFloat(v.quantity) > 0;
  const batchFields = batched ? { batch_no: v.batch_no || null, expiry_date: adding ? v.expiry_date || null : undefined } : {};
  return (
    <Modal open onClose={() => onClose(false)} title={kind === "adjust" ? "Stock adjustment" : "Transfer between warehouses"}
      footer={<><Button variant="secondary" onClick={() => onClose(false)}>Cancel</Button><Button loading={busy} onClick={async () => {
        const r = await run(() => kind === "adjust"
          ? api.post(path("/items/adjustments"), { item_id: v.item_id, warehouse_id: v.warehouse_id, date: v.date, quantity: v.quantity, unit_cost: v.unit_cost || null, reason: v.reason, memo: v.memo || null, ...batchFields })
          : api.post(path("/items/transfers"), { item_id: v.item_id, from_warehouse_id: v.warehouse_id, to_warehouse_id: v.to_warehouse_id, date: v.date, quantity: v.quantity, memo: v.memo || null, ...batchFields }));
        if (r) { toast("success", "Recorded"); onClose(true); }
      }}>Save</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        {error && <Alert className="sm:col-span-2">{error}</Alert>}
        <Field label="Item" className="sm:col-span-2">{(id) => <Select id={id} value={v.item_id} onChange={(e) => setV({ ...v, item_id: e.target.value })}><option value="">Select…</option>{tracked.map((i) => <option key={i.id} value={i.id}>{i.name} (on hand {qty(i.stock_qty_milli)} {i.unit})</option>)}</Select>}</Field>
        <Field label={kind === "adjust" ? "Warehouse" : "From"}>{(id) => <Select id={id} value={v.warehouse_id} onChange={(e) => setV({ ...v, warehouse_id: e.target.value })}>{whs.map((w: any) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select>}</Field>
        {kind === "transfer" && <Field label="To">{(id) => <Select id={id} value={v.to_warehouse_id} onChange={(e) => setV({ ...v, to_warehouse_id: e.target.value })}>{whs.map((w: any) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select>}</Field>}
        <Field label="Date">{(id) => <Input id={id} type="date" value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} />}</Field>
        <Field label={kind === "adjust" ? "Quantity change (+/−)" : "Quantity"}>{(id) => <Input id={id} inputMode="decimal" value={v.quantity} onChange={(e) => setV({ ...v, quantity: e.target.value })} />}</Field>
        {kind === "adjust" && <>
          <Field label="Reason">{(id) => <Select id={id} value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })}><option value="adjustment">Adjustment (count difference, damage)</option><option value="opening">Opening stock</option></Select>}</Field>
          <Field label="Unit cost (increases only)" hint="Leave blank to use the current average cost.">{(id) => <MoneyInput id={id} value={v.unit_cost} onChange={(e) => setV({ ...v, unit_cost: e.target.value })} />}</Field>
        </>}
        {batched && <Field label="Batch no." hint={adding ? "Required when adding stock" : "Blank = earliest expiry first"}>{(id) => <Input id={id} className="uppercase" value={v.batch_no} onChange={(e) => setV({ ...v, batch_no: e.target.value })} />}</Field>}
        {batched && adding && <Field label="Expiry date">{(id) => <Input id={id} type="date" value={v.expiry_date} onChange={(e) => setV({ ...v, expiry_date: e.target.value })} />}</Field>}
        <Field label="Memo" className="sm:col-span-2">{(id) => <Input id={id} value={v.memo} onChange={(e) => setV({ ...v, memo: e.target.value })} />}</Field>
      </div>
    </Modal>
  );
}

type InvTab = "items" | "stock" | "batches" | "prices" | "movements" | "transfers" | "warehouses";

/** Price lists: a % on selling prices, plus own prices per product with optional quantity breaks. */
function PriceListsTab({ items }: { items: any[] }) {
  const { path, money, can, settings } = useCompany();
  const toast = useToast();
  const base = settings?.company.base_currency ?? "INR";
  const lists = useApi<{ price_lists: any[] }>(path("/price-lists"));
  const [sel, setSel] = useState<string | null>(null);
  const [head, setHead] = useState({ name: "", adjust_percent: "" });
  const detail = useApi<{ price_list: any; prices: any[] }>(sel ? path(`/price-lists/${sel}/prices`) : null);
  const [rows, setRows] = useState<{ item_id: string; min_qty: string; price: string }[]>([]);
  const [edit, setEdit] = useState({ name: "", adjust_percent: "", is_active: true });
  useEffect(() => {
    if (!detail.data) return;
    const l = detail.data.price_list;
    setEdit({ name: l.name, adjust_percent: String(l.adjust_bp / 100), is_active: Boolean(l.is_active) });
    setRows(detail.data.prices.map((p) => ({ item_id: p.item_id, min_qty: p.min_qty_milli ? qty(p.min_qty_milli) : "", price: toInput(p.price, base) })));
  }, [detail.data, base]);
  const writable = can("items.write");
  const goods = items.filter((i) => i.is_active);
  const call = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast("success", ok); lists.reload(); detail.reload(); return true; } catch (e) { toast("error", errorMessage(e)); return false; } };
  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
      <Card padded={false}>
        <ul className="divide-y divide-[var(--border)]">
          {(lists.data?.price_lists ?? []).map((l) => (
            <li key={l.id}><button className={`w-full px-4 py-3 text-left text-sm hover:bg-[var(--surface-2)] ${sel === l.id ? "bg-[var(--surface-2)]" : ""}`} onClick={() => setSel(l.id)}>
              <span className="font-medium">{l.name}</span> {!l.is_active && <Badge>off</Badge>}
              <span className="block text-xs muted">{l.adjust_bp ? `${l.adjust_bp > 0 ? "+" : ""}${l.adjust_bp / 100}% on selling price · ` : ""}{l.prices} own price{l.prices === 1 ? "" : "s"} · {l.customers} customer{l.customers === 1 ? "" : "s"}</span>
            </button></li>
          ))}
          {!lists.data?.price_lists.length && <li className="p-4 text-sm muted">No price lists yet. Make one for wholesale or dealer rates, then choose it on the customer.</li>}
        </ul>
        {writable && <div className="space-y-2 border-t border-[var(--border)] p-3">
          <Input placeholder="New list, e.g. Wholesale" value={head.name} onChange={(e) => setHead({ ...head, name: e.target.value })} aria-label="New price list name" />
          <Input placeholder="% on selling price, e.g. -10" value={head.adjust_percent} onChange={(e) => setHead({ ...head, adjust_percent: e.target.value })} aria-label="Percentage on selling price" />
          <Button size="sm" disabled={!head.name.trim()} onClick={async () => { if (await call(async () => { const r = await api.post(path("/price-lists"), head); setSel(r.id); }, "Price list added")) setHead({ name: "", adjust_percent: "" }); }}><Plus className="h-4 w-4" />Add list</Button>
        </div>}
      </Card>
      {sel && detail.data ? (
        <Card>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Name">{(id) => <Input id={id} value={edit.name} disabled={!writable} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />}</Field>
            <Field label="% on selling price" hint="For products without their own price. −10 = 10% off">{(id) => <Input id={id} className="w-28" value={edit.adjust_percent} disabled={!writable} onChange={(e) => setEdit({ ...edit, adjust_percent: e.target.value })} />}</Field>
            <label className="mb-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={edit.is_active} disabled={!writable} onChange={(e) => setEdit({ ...edit, is_active: e.target.checked })} /> In use</label>
            {writable && <ConfirmButton label="Delete" title="Delete this price list?" body="Lists given to customers cannot be deleted; switch them off instead." confirmLabel="Delete" onConfirm={async () => { if (await call(() => api.del(path(`/price-lists/${sel}`)), "Deleted")) setSel(null); }} />}
          </div>
          <TableWrap><table className="table mt-4">
            <thead><tr><th>Product</th><th className="num">Selling price</th><th className="num w-32">From quantity</th><th className="num w-36">List price</th><th /></tr></thead>
            <tbody>{rows.map((r, i) => {
              const it = items.find((x) => x.id === r.item_id);
              const upd = (patch: Partial<typeof r>) => setRows(rows.map((x, j) => (j === i ? { ...x, ...patch } : x)));
              return (
                <tr key={i}>
                  <td><Select value={r.item_id} disabled={!writable} onChange={(e) => upd({ item_id: e.target.value })} aria-label="Product"><option value="">Select…</option>{goods.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</Select></td>
                  <td className="num muted">{it ? money(it.sale_price) : ""}</td>
                  <td><Input className="num" inputMode="decimal" placeholder="any" value={r.min_qty} disabled={!writable} onChange={(e) => upd({ min_qty: e.target.value })} aria-label="From quantity" /></td>
                  <td><MoneyInput value={r.price} disabled={!writable} onChange={(e) => upd({ price: e.target.value })} aria-label="List price" /></td>
                  <td>{writable && <Button size="sm" variant="ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Remove row">×</Button>}</td>
                </tr>
              );
            })}</tbody>
          </table></TableWrap>
          {writable && <div className="mt-3 flex flex-wrap justify-between gap-2">
            <Button size="sm" variant="ghost" onClick={() => setRows([...rows, { item_id: "", min_qty: "", price: "" }])}><Plus className="h-4 w-4" />Add price</Button>
            <Button onClick={() => call(async () => {
              await api.put(path(`/price-lists/${sel}`), edit);
              await api.put(path(`/price-lists/${sel}/prices`), { rows: rows.filter((r) => r.item_id && r.price !== "") });
            }, "Price list saved")}>Save</Button>
          </div>}
          <p className="mt-3 text-xs muted">A product can have several rows: e.g. from quantity blank → ₹90, from 10 → ₹85. The highest break not above the quantity applies.</p>
        </Card>
      ) : <Card><p className="text-sm muted">Choose a price list.</p></Card>}
    </div>
  );
}

const BATCH_COLOR = { expired: "red", expiring: "amber", ok: "green" } as const;

/** Stock by batch with expiry status, filterable, downloadable. */
function BatchesTab() {
  const { path, settings } = useCompany();
  const [days, setDays] = useState("30");
  const [only, setOnly] = useState("");
  const r = useApi<{ batches: any[]; counts: { expired: number; expiring: number } }>(path(`/items/batches/report?days=${Number(days) || 30}`));
  const rows = (r.data?.batches ?? []).filter((b) => !only || b.status === only);
  const df = settings?.company.date_format;
  const csv = () => downloadCsv(`batches-expiry-${today()}.csv`, ["Item", "Code", "Warehouse", "Batch", "Expiry", "Quantity", "Unit", "Status"],
    rows.map((b) => [b.name, b.code ?? "", b.warehouse_name, b.batch_no, b.expiry_date ?? "", qty(b.qty_milli), b.unit, b.status]));
  return (
    <Card padded={false}>
      <div className="flex flex-wrap items-end gap-3 border-b border-[var(--border)] p-3">
        <Field label="Expiring within (days)">{(id) => <Input id={id} inputMode="numeric" className="w-28" value={days} onChange={(e) => setDays(e.target.value)} />}</Field>
        <Field label="Show">{(id) => <Select id={id} value={only} onChange={(e) => setOnly(e.target.value)}><option value="">All batches</option><option value="expired">Expired</option><option value="expiring">Expiring soon</option><option value="ok">Fine</option></Select>}</Field>
        {r.data && <p className="text-sm"><Badge color="red">{r.data.counts.expired} expired</Badge> <Badge color="amber">{r.data.counts.expiring} expiring</Badge></p>}
        <DownloadButtons size="sm" className="ml-auto" disabled={!rows.length} onDownload={csv} />
      </div>
      {r.loading && !r.data ? <Spinner /> : !rows.length ? <EmptyState title="No batches" body="Tick “Track batch numbers & expiry” on an item, then enter the batch on purchase bills." /> : (
        <TableWrap><table className="table"><thead><tr><th>Item</th><th>Warehouse</th><th>Batch</th><th>Expiry</th><th className="num">Quantity</th><th>Status</th></tr></thead>
          <tbody>{rows.map((b, i) => <tr key={i}><td>{b.name} <span className="font-mono text-xs muted">{b.code}</span></td><td>{b.warehouse_name}</td><td className="font-mono">{b.batch_no}</td><td>{b.expiry_date ? fmtDate(b.expiry_date, df) : "—"}</td><td className="num">{qty(b.qty_milli)} {b.unit}</td><td><Badge color={BATCH_COLOR[b.status as keyof typeof BATCH_COLOR]}>{b.status}</Badge></td></tr>)}</tbody></table></TableWrap>
      )}
    </Card>
  );
}

export default function Inventory() {
  const { path, money, settings, can, reload: reloadSettings, branchQuery } = useCompany();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as InvTab) || "items";
  const setTab = (t: InvTab) => setParams(t === "items" ? {} : { tab: t });
  const transfers = useApi<{ transfers: any[] }>(tab === "transfers" ? path("/items/transfers/list") : null);
  const [found, setFound] = useState<any>(null);
  const [q, setQ] = useState("");
  const items = useApi<{ items: any[] }>(path(`/items?limit=500&q=${encodeURIComponent(q)}`));
  const stock = useApi<{ stock: any[] }>(tab === "stock" ? path(`/items/stock?${branchQuery.slice(1)}`) : null);
  const moves = useApi<{ movements: any[] }>(tab === "movements" ? path("/items/movements?limit=200") : null);
  const [edit, setEdit] = useState<any>(params.get("new") === "1" ? "new" : null);
  useEffect(() => { if (params.get("new") === "1") { setEdit("new"); setParams((p) => { p.delete("new"); return p; }, { replace: true }); } }, [params, setParams]);
  const [stockOp, setStockOp] = useState<"adjust" | "transfer" | null>(null);
  const [wh, setWh] = useState({ name: "", code: "", branch_id: "" });
  const df = settings?.company.date_format;
  return (
    <>
      <PageHeader title="Products & inventory" subtitle="Costing method: moving weighted average per item. Stock value reconciles to the Inventory account."
        actions={<>
          {can("inventory.adjust") && <Button variant="secondary" onClick={() => setStockOp("adjust")}>Adjust stock</Button>}
          {can("inventory.transfer") && <Button variant="secondary" onClick={() => setStockOp("transfer")}>Transfer</Button>}
          {can("labels.print") && <LinkButton variant="secondary" to={`/app/${settings?.company.id}/labels`}><QrCode className="h-4 w-4" />Labels</LinkButton>}
          {can("items.write") && <Button onClick={() => setEdit("new")}><Plus className="h-4 w-4" />New item</Button>}
        </>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: "items", label: "Items" }, { value: "stock", label: "Stock by warehouse" }, { value: "batches", label: "Batches & expiry" }, { value: "prices", label: "Price lists" }, { value: "movements", label: "Movements" }, { value: "transfers", label: "Branch transfers" }, { value: "warehouses", label: "Warehouses" }]} />
      {tab === "items" && (
        <Card padded={false}>
          <div className="flex flex-wrap items-end gap-3 border-b border-[var(--border)] p-3">
            <Input placeholder="Search name, SKU, HSN, code, barcode…" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" aria-label="Search items" />
            <div className="w-full max-w-xs"><ScanInput label="Scan to find" onItem={setFound} onError={(m) => toast("error", m)} /></div>
          </div>
          {found && <Alert kind="info" className="m-3">Scanned: <b>{found.name}</b> · code {found.code}{found.barcode ? ` · barcode ${found.barcode}` : ""} · {money(found.sale_price)}
            {can("items.write") && <Button size="sm" variant="ghost" onClick={() => { setEdit(found); setFound(null); }}>Edit</Button>}</Alert>}
          {items.loading && !items.data ? <Spinner /> : !items.data?.items.length ? <EmptyState title="No products or services" action={can("items.write") && <Button onClick={() => setEdit("new")}>Add item</Button>} /> : (
            <TableWrap><table className="table">
              <thead><tr><th>Name</th><th>Code</th><th>SKU / barcode</th><th>HSN/SAC</th><th className="num">Sale price</th><th className="num">On hand</th><th className="num">Stock value</th><th /></tr></thead>
              <tbody>{items.data.items.map((i) => (
                <tr key={i.id} className={i.is_active ? "" : "opacity-60"}>
                  <td className="font-medium">{i.name} {i.kind === "service" ? <Badge color="blue">service</Badge> : i.track_inventory ? <Badge color="green">stock</Badge> : <Badge>non-stock</Badge>}
                    {i.track_batches ? <span className="ml-1"><Badge color="blue">batches</Badge></span> : null}
                    {i.track_inventory && i.reorder_level_milli > 0 && i.stock_qty_milli <= i.reorder_level_milli && <span className="ml-1"><Badge color="amber">reorder</Badge></span>}</td>
                  <td className="font-mono text-xs">{i.code}</td><td className="font-mono text-xs">{i.sku}{i.sku && i.barcode ? <br /> : null}{i.barcode}</td><td className="font-mono text-xs">{i.hsn_sac}</td>
                  <td className="num">{money(i.sale_price)}</td>
                  <td className="num">{i.track_inventory ? `${qty(i.stock_qty_milli)} ${i.unit}` : "—"}</td>
                  <td className="num">{i.track_inventory && i.stock_value !== undefined ? money(i.stock_value) : "—"}</td>
                  <td className="text-right">{can("items.write") && <Button size="sm" variant="ghost" onClick={() => setEdit(i)}>Edit</Button>}</td>
                </tr>
              ))}</tbody>
            </table></TableWrap>
          )}
        </Card>
      )}
      {tab === "stock" && (
        <Card padded={false}>{stock.data?.stock.length ? (
          <TableWrap><table className="table"><thead><tr><th>Item</th><th>Warehouse</th><th className="num">Quantity</th><th className="num">Value</th></tr></thead>
            <tbody>{stock.data.stock.map((s, idx) => <tr key={idx}><td>{s.name}</td><td>{s.warehouse_name}</td><td className="num">{qty(s.qty_milli)} {s.unit}</td><td className="num">{money(s.value)}</td></tr>)}</tbody></table></TableWrap>
        ) : <EmptyState title="No stock movements yet" body="Stock arrives through posted bills or opening-stock adjustments." />}</Card>
      )}
      {tab === "batches" && <BatchesTab />}
      {tab === "prices" && items.data && <PriceListsTab items={items.data.items} />}
      {tab === "movements" && (
        <Card padded={false}>{moves.data?.movements.length ? (
          <TableWrap><table className="table"><thead><tr><th>Date</th><th>Item</th><th>Warehouse</th><th>Type</th><th className="num">Qty</th><th className="num">Value</th></tr></thead>
            <tbody>{moves.data.movements.map((m) => <tr key={m.id}><td>{fmtDate(m.move_date, df)}</td><td>{m.item_name}{m.batch_no && <span className="block font-mono text-xs muted">{m.batch_no}</span>}</td><td>{m.warehouse_name}</td><td><Badge>{m.kind.replace("_", " ")}</Badge></td><td className={`num ${m.qty_milli < 0 ? "text-red-600" : ""}`}>{qty(m.qty_milli)}</td><td className="num">{money(m.value)}</td></tr>)}</tbody></table></TableWrap>
        ) : <EmptyState title="No movements" />}</Card>
      )}
      {tab === "transfers" && (
        <Card padded={false}>{transfers.data?.transfers.length ? (
          <TableWrap><table className="table text-sm"><thead><tr><th>Date</th><th>Item</th><th className="num">Qty</th><th>From</th><th>To</th><th>By</th><th>Memo</th></tr></thead>
            <tbody>{transfers.data.transfers.map((t) => (
              <tr key={t.id}><td>{fmtDate(t.transfer_date, df)}</td><td>{t.item_name} <span className="font-mono text-xs muted">{t.item_code}</span></td><td className="num">{qty(t.qty_milli)}</td>
                <td>{t.from_warehouse}{t.from_branch ? <span className="block text-xs muted">{t.from_branch}</span> : null}</td>
                <td>{t.to_warehouse}{t.to_branch ? <span className="block text-xs muted">{t.to_branch}</span> : null}</td>
                <td>{t.created_by_name}</td><td>{t.memo}</td></tr>
            ))}</tbody></table></TableWrap>
        ) : <EmptyState title="No transfers yet" body="Use Transfer to move stock between warehouses or branches; both branches are recorded." />}</Card>
      )}
      {tab === "warehouses" && (
        <Card>
          <ul className="mb-4 divide-y divide-[var(--border)] text-sm">{(settings?.warehouses ?? []).map((w: any) => <li key={w.id} className="flex justify-between py-2"><span>{w.code} · {w.name}{w.branch_id ? <span className="muted"> · {settings?.branches.find((b: any) => b.id === w.branch_id)?.name}</span> : null}</span>{!w.is_active && <Badge>inactive</Badge>}</li>)}</ul>
          {can("branches.manage") && <div className="flex flex-wrap items-end gap-2">
            <Field label="Code">{(id) => <Input id={id} value={wh.code} onChange={(e) => setWh({ ...wh, code: e.target.value })} className="w-28" />}</Field>
            <Field label="Name">{(id) => <Input id={id} value={wh.name} onChange={(e) => setWh({ ...wh, name: e.target.value })} />}</Field>
            {(settings?.branches.length ?? 0) > 0 && <Field label="Branch">{(id) => <Select id={id} value={wh.branch_id} onChange={(e) => setWh({ ...wh, branch_id: e.target.value })}><option value="">Company-wide</option>{settings!.branches.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>}</Field>}
            <Button onClick={async () => { try { await api.post(path("/items/warehouses"), { ...wh, branch_id: wh.branch_id || null }); setWh({ name: "", code: "", branch_id: "" }); reloadSettings(); toast("success", "Warehouse added"); } catch (e) { toast("error", errorMessage(e)); } }}>Add warehouse</Button>
          </div>}
        </Card>
      )}
      {edit && <ItemForm initial={edit === "new" ? undefined : edit} onClose={(c) => { setEdit(null); if (c) items.reload(); }} />}
      {stockOp && items.data && <StockModal kind={stockOp} items={items.data.items} onClose={(c) => { setStockOp(null); if (c) { items.reload(); stock.reload(); moves.reload(); transfers.reload(); } }} />}
    </>
  );
}
