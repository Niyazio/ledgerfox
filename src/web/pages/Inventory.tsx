import { useState } from "react";
import { Plus } from "lucide-react";
import { useCompany } from "../lib/company";
import { useApi, useAction } from "../lib/hooks";
import { api, errorMessage } from "../lib/api";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Modal, MoneyInput, PageHeader, Select, Spinner, TableWrap, Tabs, Textarea, useToast } from "../components/ui";
import { AccountSelect, TaxSelect } from "../components/pickers";
import { fmtDate, qty, today, toInput } from "../lib/format";

function ItemForm({ initial, onClose }: { initial?: any; onClose: (changed: boolean) => void }) {
  const { path, settings } = useCompany();
  const base = settings?.company.base_currency ?? "INR";
  const toast = useToast();
  const [v, setV] = useState({
    kind: initial?.kind ?? "goods", name: initial?.name ?? "", sku: initial?.sku ?? "", unit: initial?.unit ?? "nos", hsn_sac: initial?.hsn_sac ?? "", description: initial?.description ?? "",
    sale_price: initial ? toInput(initial.sale_price, base) : "", purchase_price: initial ? toInput(initial.purchase_price, base) : "", tax_code_id: initial?.tax_code_id ?? "",
    income_account_id: initial?.income_account_id ?? "", expense_account_id: initial?.expense_account_id ?? "", track_inventory: initial ? Boolean(initial.track_inventory) : false,
    reorder_level: initial ? qty(initial.reorder_level_milli) : "0", is_active: initial ? Boolean(initial.is_active) : true,
  });
  const { busy, error, run } = useAction();
  const set = (k: string, val: unknown) => setV((p) => ({ ...p, [k]: val }));
  return (
    <Modal open wide onClose={() => onClose(false)} title={initial ? `Edit ${initial.name}` : "New product or service"}
      footer={<><Button variant="secondary" onClick={() => onClose(false)}>Cancel</Button><Button loading={busy} onClick={async () => {
        const body = { ...v, sku: v.sku || null, hsn_sac: v.hsn_sac || null, tax_code_id: v.tax_code_id || null, income_account_id: v.income_account_id || null, expense_account_id: v.expense_account_id || null, sale_price: v.sale_price || "0", purchase_price: v.purchase_price || "0" };
        if (await run(() => (initial ? api.put(path(`/items/${initial.id}`), body) : api.post(path("/items"), body)))) { toast("success", "Saved"); onClose(true); }
      }}>Save</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        {error && <Alert className="sm:col-span-2">{error}</Alert>}
        <Field label="Type">{(id) => <Select id={id} value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value, track_inventory: e.target.value === "goods" && v.track_inventory })}><option value="goods">Goods</option><option value="service">Service</option></Select>}</Field>
        <Field label="Name" required>{(id) => <Input id={id} value={v.name} onChange={(e) => set("name", e.target.value)} />}</Field>
        <Field label="SKU">{(id) => <Input id={id} value={v.sku} onChange={(e) => set("sku", e.target.value)} />}</Field>
        <Field label="Unit">{(id) => <Select id={id} value={v.unit} onChange={(e) => set("unit", e.target.value)}>{(settings?.units ?? []).map((u: any) => <option key={u.id} value={u.code}>{u.code} · {u.name}</option>)}</Select>}</Field>
        <Field label={v.kind === "goods" ? "HSN code" : "SAC code"}>{(id) => <Input id={id} value={v.hsn_sac} maxLength={8} onChange={(e) => set("hsn_sac", e.target.value)} />}</Field>
        <Field label="Default tax">{(id) => <TaxSelect id={id} value={v.tax_code_id} onChange={(t) => set("tax_code_id", t)} />}</Field>
        <Field label="Selling price">{(id) => <MoneyInput id={id} value={v.sale_price} onChange={(e) => set("sale_price", e.target.value)} />}</Field>
        <Field label="Purchase price">{(id) => <MoneyInput id={id} value={v.purchase_price} onChange={(e) => set("purchase_price", e.target.value)} />}</Field>
        <Field label="Income account" hint="Default: Sales / Service income">{(id) => <AccountSelect id={id} value={v.income_account_id} onChange={(a) => set("income_account_id", a)} filter={(a) => a.type === "income"} placeholder="Default" />}</Field>
        {!v.track_inventory && <Field label="Expense account" hint="Default: Purchases">{(id) => <AccountSelect id={id} value={v.expense_account_id} onChange={(a) => set("expense_account_id", a)} filter={(a) => a.type === "expense" || a.type === "asset"} placeholder="Default" />}</Field>}
        {v.kind === "goods" && <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={v.track_inventory} disabled={Boolean(initial)} onChange={(e) => set("track_inventory", e.target.checked)} /> Track stock (perpetual inventory, moving average cost){initial && <span className="muted"> — fixed after creation</span>}</label>}
        {v.track_inventory && <Field label="Reorder level">{(id) => <Input id={id} inputMode="decimal" value={v.reorder_level} onChange={(e) => set("reorder_level", e.target.value)} />}</Field>}
        <Field label="Description" className="sm:col-span-2">{(id) => <Textarea id={id} rows={2} value={v.description} onChange={(e) => set("description", e.target.value)} />}</Field>
        {initial && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={v.is_active} onChange={(e) => set("is_active", e.target.checked)} /> Active</label>}
      </div>
    </Modal>
  );
}

function StockModal({ kind, items, onClose }: { kind: "adjust" | "transfer"; items: any[]; onClose: (changed: boolean) => void }) {
  const { path, settings } = useCompany();
  const toast = useToast();
  const whs = (settings?.warehouses ?? []).filter((w: any) => w.is_active);
  const [v, setV] = useState({ item_id: "", warehouse_id: whs[0]?.id ?? "", to_warehouse_id: whs[1]?.id ?? "", date: today(), quantity: "", unit_cost: "", reason: "adjustment", memo: "" });
  const { busy, error, run } = useAction();
  const tracked = items.filter((i) => i.track_inventory);
  return (
    <Modal open onClose={() => onClose(false)} title={kind === "adjust" ? "Stock adjustment" : "Transfer between warehouses"}
      footer={<><Button variant="secondary" onClick={() => onClose(false)}>Cancel</Button><Button loading={busy} onClick={async () => {
        const r = await run(() => kind === "adjust"
          ? api.post(path("/items/adjustments"), { item_id: v.item_id, warehouse_id: v.warehouse_id, date: v.date, quantity: v.quantity, unit_cost: v.unit_cost || null, reason: v.reason, memo: v.memo || null })
          : api.post(path("/items/transfers"), { item_id: v.item_id, from_warehouse_id: v.warehouse_id, to_warehouse_id: v.to_warehouse_id, date: v.date, quantity: v.quantity, memo: v.memo || null }));
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
        <Field label="Memo" className="sm:col-span-2">{(id) => <Input id={id} value={v.memo} onChange={(e) => setV({ ...v, memo: e.target.value })} />}</Field>
      </div>
    </Modal>
  );
}

export default function Inventory() {
  const { path, money, settings, can, reload: reloadSettings } = useCompany();
  const toast = useToast();
  const [tab, setTab] = useState<"items" | "stock" | "movements" | "warehouses">("items");
  const [q, setQ] = useState("");
  const items = useApi<{ items: any[] }>(path(`/items?limit=500&q=${encodeURIComponent(q)}`));
  const stock = useApi<{ stock: any[] }>(tab === "stock" ? path("/items/stock") : null);
  const moves = useApi<{ movements: any[] }>(tab === "movements" ? path("/items/movements?limit=200") : null);
  const [edit, setEdit] = useState<any>(null);
  const [stockOp, setStockOp] = useState<"adjust" | "transfer" | null>(null);
  const [wh, setWh] = useState({ name: "", code: "" });
  const df = settings?.company.date_format;
  return (
    <>
      <PageHeader title="Products & inventory" subtitle="Costing method: moving weighted average per item. Stock value reconciles to the Inventory account."
        actions={can("items.write") && <>
          <Button variant="secondary" onClick={() => setStockOp("adjust")}>Adjust stock</Button>
          <Button variant="secondary" onClick={() => setStockOp("transfer")}>Transfer</Button>
          <Button onClick={() => setEdit("new")}><Plus className="h-4 w-4" />New item</Button>
        </>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: "items", label: "Items" }, { value: "stock", label: "Stock by warehouse" }, { value: "movements", label: "Movements" }, { value: "warehouses", label: "Warehouses" }]} />
      {tab === "items" && (
        <Card padded={false}>
          <div className="border-b border-[var(--border)] p-3"><Input placeholder="Search name, SKU, HSN…" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" aria-label="Search items" /></div>
          {items.loading && !items.data ? <Spinner /> : !items.data?.items.length ? <EmptyState title="No products or services" action={can("items.write") && <Button onClick={() => setEdit("new")}>Add item</Button>} /> : (
            <TableWrap><table className="table">
              <thead><tr><th>Name</th><th>SKU</th><th>HSN/SAC</th><th className="num">Sale price</th><th className="num">On hand</th><th className="num">Stock value</th><th /></tr></thead>
              <tbody>{items.data.items.map((i) => (
                <tr key={i.id} className={i.is_active ? "" : "opacity-60"}>
                  <td className="font-medium">{i.name} {i.kind === "service" ? <Badge color="blue">service</Badge> : i.track_inventory ? <Badge color="green">stock</Badge> : <Badge>non-stock</Badge>}
                    {i.track_inventory && i.reorder_level_milli > 0 && i.stock_qty_milli <= i.reorder_level_milli && <span className="ml-1"><Badge color="amber">reorder</Badge></span>}</td>
                  <td className="font-mono text-xs">{i.sku}</td><td className="font-mono text-xs">{i.hsn_sac}</td>
                  <td className="num">{money(i.sale_price)}</td>
                  <td className="num">{i.track_inventory ? `${qty(i.stock_qty_milli)} ${i.unit}` : "—"}</td>
                  <td className="num">{i.track_inventory ? money(i.stock_value) : "—"}</td>
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
      {tab === "movements" && (
        <Card padded={false}>{moves.data?.movements.length ? (
          <TableWrap><table className="table"><thead><tr><th>Date</th><th>Item</th><th>Warehouse</th><th>Type</th><th className="num">Qty</th><th className="num">Value</th></tr></thead>
            <tbody>{moves.data.movements.map((m) => <tr key={m.id}><td>{fmtDate(m.move_date, df)}</td><td>{m.item_name}</td><td>{m.warehouse_name}</td><td><Badge>{m.kind.replace("_", " ")}</Badge></td><td className={`num ${m.qty_milli < 0 ? "text-red-600" : ""}`}>{qty(m.qty_milli)}</td><td className="num">{money(m.value)}</td></tr>)}</tbody></table></TableWrap>
        ) : <EmptyState title="No movements" />}</Card>
      )}
      {tab === "warehouses" && (
        <Card>
          <ul className="mb-4 divide-y divide-[var(--border)] text-sm">{(settings?.warehouses ?? []).map((w: any) => <li key={w.id} className="flex justify-between py-2"><span>{w.code} · {w.name}</span>{!w.is_active && <Badge>inactive</Badge>}</li>)}</ul>
          {can("items.write") && <div className="flex flex-wrap items-end gap-2">
            <Field label="Code">{(id) => <Input id={id} value={wh.code} onChange={(e) => setWh({ ...wh, code: e.target.value })} className="w-28" />}</Field>
            <Field label="Name">{(id) => <Input id={id} value={wh.name} onChange={(e) => setWh({ ...wh, name: e.target.value })} />}</Field>
            <Button onClick={async () => { try { await api.post(path("/items/warehouses"), wh); setWh({ name: "", code: "" }); reloadSettings(); toast("success", "Warehouse added"); } catch (e) { toast("error", errorMessage(e)); } }}>Add warehouse</Button>
          </div>}
        </Card>
      )}
      {edit && <ItemForm initial={edit === "new" ? undefined : edit} onClose={(c) => { setEdit(null); if (c) items.reload(); }} />}
      {stockOp && items.data && <StockModal kind={stockOp} items={items.data.items} onClose={(c) => { setStockOp(null); if (c) { items.reload(); stock.reload(); moves.reload(); } }} />}
    </>
  );
}
