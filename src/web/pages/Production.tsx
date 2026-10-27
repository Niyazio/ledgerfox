import { useEffect, useState } from "react";
import { Factory, Plus, Trash2 } from "lucide-react";
import { useSearchParams } from "react-router";
import { useCompany } from "../lib/company";
import { useApi, useAction } from "../lib/hooks";
import { api } from "../lib/api";
import { Alert, Badge, Button, Card, ConfirmButton, EmptyState, Field, Input, Modal, MoneyInput, PageHeader, Select, Spinner, TableWrap, Tabs, Textarea, useToast } from "../components/ui";
import { AccountSelect } from "../components/pickers";
import { fmtDate, qty, today } from "../lib/format";
import { parseDecimal } from "@shared/money";
import { currencyExponent } from "@shared/currencies";

type Line = { item_id: string; quantity: string };

function BomForm({ initial, items, onClose }: { initial?: { bom: any; lines: any[] }; items: any[]; onClose: (changed: boolean) => void }) {
  const { path } = useCompany();
  const toast = useToast();
  const stock = items.filter((i) => i.track_inventory && i.is_active);
  const [v, setV] = useState({
    item_id: initial?.bom.item_id ?? "", name: initial?.bom.name ?? "", output_quantity: initial ? qty(initial.bom.output_qty_milli) : "1", notes: initial?.bom.notes ?? "",
    is_active: initial ? Boolean(initial.bom.is_active) : true,
  });
  const [lines, setLines] = useState<Line[]>(initial?.lines.map((l) => ({ item_id: l.item_id, quantity: qty(l.qty_milli) })) ?? [{ item_id: "", quantity: "" }]);
  const { busy, error, run } = useAction();
  return (
    <Modal open wide onClose={() => onClose(false)} title={initial ? `Edit ${initial.bom.name}` : "New bill of materials"}
      footer={<><Button variant="secondary" onClick={() => onClose(false)}>Cancel</Button><Button loading={busy} onClick={async () => {
        const body = { ...v, lines: lines.filter((l) => l.item_id && l.quantity) };
        if (await run(() => (initial ? api.put(path(`/production/boms/${initial.bom.id}`), body) : api.post(path("/production/boms"), body)))) { toast("success", "Saved"); onClose(true); }
      }}>Save</Button></>}>
      <div className="grid gap-4 sm:grid-cols-3">
        {error && <Alert className="sm:col-span-3">{error}</Alert>}
        <Field label="Finished product" required>{(id) => <Select id={id} value={v.item_id} onChange={(e) => { const it = stock.find((x) => x.id === e.target.value); setV({ ...v, item_id: e.target.value, name: v.name || it?.name || "" }); }}><option value="">Select…</option>{stock.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</Select>}</Field>
        <Field label="Name" required>{(id) => <Input id={id} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />}</Field>
        <Field label="Makes (quantity)" hint={stock.find((i) => i.id === v.item_id)?.unit}>{(id) => <Input id={id} inputMode="decimal" value={v.output_quantity} onChange={(e) => setV({ ...v, output_quantity: e.target.value })} />}</Field>
      </div>
      <TableWrap><table className="table mt-4">
        <thead><tr><th>Component (raw material / packing)</th><th className="num w-36">Quantity</th><th className="w-20">Unit</th><th /></tr></thead>
        <tbody>{lines.map((l, i) => (
          <tr key={i}>
            <td><Select value={l.item_id} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, item_id: e.target.value } : x)))} aria-label="Component"><option value="">Select…</option>{stock.filter((s) => s.id !== v.item_id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></td>
            <td><Input className="num" inputMode="decimal" value={l.quantity} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} aria-label="Component quantity" /></td>
            <td className="muted">{stock.find((s) => s.id === l.item_id)?.unit}</td>
            <td><button className="rounded p-2 hover:bg-[var(--surface-2)] disabled:opacity-30" disabled={lines.length <= 1} onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label="Remove component"><Trash2 className="h-4 w-4" /></button></td>
          </tr>
        ))}</tbody>
      </table></TableWrap>
      <Button className="mt-2" size="sm" variant="ghost" onClick={() => setLines([...lines, { item_id: "", quantity: "" }])}><Plus className="h-4 w-4" />Add component</Button>
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <Field label="Notes" className="sm:col-span-2">{(id) => <Textarea id={id} rows={2} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} />}</Field>
        {initial && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={v.is_active} onChange={(e) => setV({ ...v, is_active: e.target.checked })} /> In use</label>}
      </div>
      <p className="mt-3 text-xs muted">Labour, power and other overheads are not components: add them as extra cost when recording production.</p>
    </Modal>
  );
}

function ProduceForm({ boms, items, onClose }: { boms: any[]; items: any[]; onClose: (changed: boolean) => void }) {
  const { path, settings, money } = useCompany();
  const toast = useToast();
  const base = settings?.company.base_currency ?? "INR";
  const whs = (settings?.warehouses ?? []).filter((w: any) => w.is_active);
  const active = boms.filter((b) => b.is_active);
  const [v, setV] = useState({ bom_id: active[0]?.id ?? "", quantity: "", date: today(), warehouse_id: whs[0]?.id ?? "", extra_cost: "", extra_account_id: "", batch_no: "", expiry_date: "", memo: "" });
  const [comps, setComps] = useState<{ item_id: string; name: string; unit: string; quantity: string; on_hand_milli: number; estimated_cost: number; required_milli: number }[]>([]);
  const { busy, error, run } = useAction();
  const bom = active.find((b) => b.id === v.bom_id);
  const product = items.find((i) => i.id === bom?.item_id);
  const planUrl = v.bom_id && v.quantity && Number(v.quantity) > 0 ? path(`/production/boms/${v.bom_id}/plan?qty=${encodeURIComponent(v.quantity)}&warehouse_id=${v.warehouse_id}`) : null;
  const plan = useApi<{ components: any[]; estimated_material_cost: number }>(planUrl);
  useEffect(() => {
    if (plan.data) setComps(plan.data.components.map((c) => ({ item_id: c.item_id, name: c.name, unit: c.unit, quantity: qty(c.required_milli), on_hand_milli: c.on_hand_milli, estimated_cost: c.estimated_cost, required_milli: c.required_milli })));
  }, [plan.data]);
  const extra = (() => { try { return v.extra_cost ? parseDecimal(v.extra_cost, currencyExponent(base)) : 0; } catch { return 0; } })();
  // Average cost per unit from the plan, applied to the quantity actually entered.
  const costOf = (c: (typeof comps)[number]) => (c.required_milli ? Math.round((c.estimated_cost * (Number(c.quantity) || 0) * 1000) / c.required_milli) : 0);
  const estimate = comps.reduce((t, c) => t + costOf(c), 0) + extra;
  const short = comps.filter((c) => Math.round(Number(c.quantity) * 1000) > c.on_hand_milli);
  return (
    <Modal open wide onClose={() => onClose(false)} title="Record production"
      footer={<><Button variant="secondary" onClick={() => onClose(false)}>Cancel</Button><Button loading={busy} disabled={!v.bom_id || !v.quantity} onClick={async () => {
        const r = await run(() => api.post(path("/production/orders"), {
          ...v, extra_cost: v.extra_cost || null, extra_account_id: v.extra_account_id || null, batch_no: v.batch_no || null, expiry_date: v.expiry_date || null, memo: v.memo || null,
          components: comps.map((c) => ({ item_id: c.item_id, quantity: c.quantity })),
        }));
        if (r) { toast("success", `${r.number}: ${money(r.total_cost)} (${money(r.unit_cost)} each)`); onClose(true); }
      }}><Factory className="h-4 w-4" />Post production</Button></>}>
      <div className="grid gap-4 sm:grid-cols-4">
        {error && <Alert className="sm:col-span-4">{error}</Alert>}
        <Field label="Bill of materials" className="sm:col-span-2">{(id) => <Select id={id} value={v.bom_id} onChange={(e) => setV({ ...v, bom_id: e.target.value })}>{active.map((b) => <option key={b.id} value={b.id}>{b.name} → {b.item_name}</option>)}</Select>}</Field>
        <Field label={`Quantity made${product ? ` (${product.unit})` : ""}`}>{(id) => <Input id={id} inputMode="decimal" value={v.quantity} onChange={(e) => setV({ ...v, quantity: e.target.value })} />}</Field>
        <Field label="Date">{(id) => <Input id={id} type="date" value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} />}</Field>
        <Field label="Warehouse">{(id) => <Select id={id} value={v.warehouse_id} onChange={(e) => setV({ ...v, warehouse_id: e.target.value })}>{whs.map((w: any) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select>}</Field>
        {product?.track_batches ? <>
          <Field label="Batch no." hint="Required">{(id) => <Input id={id} className="uppercase" value={v.batch_no} onChange={(e) => setV({ ...v, batch_no: e.target.value })} />}</Field>
          <Field label="Expiry">{(id) => <Input id={id} type="date" value={v.expiry_date} onChange={(e) => setV({ ...v, expiry_date: e.target.value })} />}</Field>
        </> : null}
      </div>
      {comps.length > 0 && <>
        <TableWrap><table className="table mt-4">
          <thead><tr><th>Component</th><th className="num w-36">Used</th><th className="num">On hand</th><th className="num">Est. cost</th></tr></thead>
          <tbody>{comps.map((c, i) => (
            <tr key={c.item_id}>
              <td>{c.name}</td>
              <td><Input className="num" inputMode="decimal" value={c.quantity} onChange={(e) => setComps(comps.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} aria-label={`${c.name} used`} /></td>
              <td className={`num ${short.includes(c) ? "text-red-600" : "muted"}`}>{qty(c.on_hand_milli)} {c.unit}</td>
              <td className="num">{money(costOf(c))}</td>
            </tr>
          ))}</tbody>
        </table></TableWrap>
        <p className="mt-1 text-xs muted">Change “Used” to what was actually consumed (wastage). Costs are moving averages; the final figure is worked out when you post.</p>
        {short.length > 0 && <Alert kind="warning" className="mt-2">Not enough {short.map((c) => c.name).join(", ")} in this warehouse.</Alert>}
      </>}
      <div className="mt-4 grid gap-4 sm:grid-cols-4">
        <Field label="Labour / overhead">{(id) => <MoneyInput id={id} value={v.extra_cost} onChange={(e) => setV({ ...v, extra_cost: e.target.value })} />}</Field>
        <Field label="Charged from" hint="Cash, wages payable, or an expense account" className="sm:col-span-2">{(id) => <AccountSelect id={id} value={v.extra_account_id} onChange={(a) => setV({ ...v, extra_account_id: a })} />}</Field>
        <Field label="Memo">{(id) => <Input id={id} value={v.memo} onChange={(e) => setV({ ...v, memo: e.target.value })} />}</Field>
      </div>
      {plan.data && <p className="mt-3 text-sm">Estimated cost: <b>{money(estimate)}</b>{Number(v.quantity) > 0 && <span className="muted"> · {money(Math.round(estimate / Number(v.quantity)))} each</span>}</p>}
    </Modal>
  );
}

type Tab = "orders" | "boms";

/** Manufacturing: bills of materials and production entries. */
export default function Production() {
  const { path, money, settings, can } = useCompany();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "orders";
  const boms = useApi<{ boms: any[] }>(path("/production/boms"));
  const orders = useApi<{ orders: any[] }>(tab === "orders" ? path("/production/orders?limit=200") : null);
  const items = useApi<{ items: any[] }>(path("/items?limit=500"));
  const [bomEdit, setBomEdit] = useState<"new" | { bom: any; lines: any[] } | null>(null);
  const [producing, setProducing] = useState(false);
  const df = settings?.company.date_format;
  return (
    <>
      <PageHeader title="Manufacturing" subtitle="Bills of materials and production. Components leave stock at average cost; the product arrives at that cost plus labour/overhead."
        actions={<>
          {can("items.write") && <Button variant="secondary" onClick={() => setBomEdit("new")}><Plus className="h-4 w-4" />Bill of materials</Button>}
          {can("inventory.adjust") && <Button disabled={!boms.data?.boms.some((b) => b.is_active)} onClick={() => setProducing(true)}><Factory className="h-4 w-4" />Record production</Button>}
        </>} />
      <Tabs value={tab} onChange={(t: Tab) => setParams(t === "orders" ? {} : { tab: t })} tabs={[{ value: "orders", label: "Production" }, { value: "boms", label: "Bills of materials" }]} />
      {tab === "orders" && (
        <Card padded={false}>{orders.loading && !orders.data ? <Spinner /> : orders.data?.orders.length ? (
          <TableWrap><table className="table">
            <thead><tr><th>Number</th><th>Date</th><th>Product</th><th className="num">Made</th><th className="num">Materials</th><th className="num">Labour / overhead</th><th className="num">Cost each</th><th>Warehouse</th><th /></tr></thead>
            <tbody>{orders.data.orders.map((o) => (
              <tr key={o.id} className={o.status === "void" ? "opacity-60" : ""}>
                <td className="font-mono text-xs">{o.number} {o.status === "void" && <Badge color="red">void</Badge>}</td>
                <td>{fmtDate(o.production_date, df)}</td>
                <td>{o.item_name}{o.batch_no && <span className="block font-mono text-xs muted">{o.batch_no}</span>}</td>
                <td className="num">{qty(o.qty_milli)} {o.unit}</td>
                <td className="num">{money(o.material_cost)}</td><td className="num">{money(o.extra_cost)}</td>
                <td className="num">{money(Math.round((o.total_cost * 1000) / o.qty_milli))}</td>
                <td>{o.warehouse_name}</td>
                <td className="text-right">{o.status === "posted" && can("inventory.adjust") && <ConfirmButton label="Void" title={`Void ${o.number}?`} body="The product is taken back out of stock and the components returned. Only possible while the product is still in stock." confirmLabel="Void" withReason
                  onConfirm={async (reason) => { try { await api.post(path(`/production/orders/${o.id}/void`), { reason: reason ?? null }); toast("success", "Voided"); orders.reload(); } catch (e) { toast("error", (e as Error).message); } }} />}</td>
              </tr>
            ))}</tbody>
          </table></TableWrap>
        ) : <EmptyState title="No production yet" body={boms.data?.boms.length ? "Use “Record production” when a batch is made." : "Start with a bill of materials: what one batch of your product uses."} />}</Card>
      )}
      {tab === "boms" && (
        <Card padded={false}>{boms.data?.boms.length ? (
          <TableWrap><table className="table">
            <thead><tr><th>Name</th><th>Product</th><th className="num">Makes</th><th className="num">Components</th><th /></tr></thead>
            <tbody>{boms.data.boms.map((b) => (
              <tr key={b.id} className={b.is_active ? "" : "opacity-60"}>
                <td className="font-medium">{b.name} {!b.is_active && <Badge>off</Badge>}</td><td>{b.item_name}</td>
                <td className="num">{qty(b.output_qty_milli)} {b.unit}</td><td className="num">{b.components}</td>
                <td className="text-right">{can("items.write") && <Button size="sm" variant="ghost" onClick={async () => setBomEdit(await api.get(path(`/production/boms/${b.id}`)))}>Edit</Button>}</td>
              </tr>
            ))}</tbody>
          </table></TableWrap>
        ) : <EmptyState title="No bills of materials" body="A bill of materials lists the raw materials and packing one batch of a product uses." action={can("items.write") && <Button onClick={() => setBomEdit("new")}>Add one</Button>} />}</Card>
      )}
      {bomEdit && items.data && <BomForm initial={bomEdit === "new" ? undefined : bomEdit} items={items.data.items} onClose={(c) => { setBomEdit(null); if (c) boms.reload(); }} />}
      {producing && boms.data && items.data && <ProduceForm boms={boms.data.boms} items={items.data.items} onClose={(c) => { setProducing(false); if (c) { orders.reload(); boms.reload(); } }} />}
    </>
  );
}
