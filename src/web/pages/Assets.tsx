import { useState } from "react";
import { Plus } from "lucide-react";
import { useCompany } from "../lib/company";
import { useApi, useAction } from "../lib/hooks";
import { api } from "../lib/api";
import { Alert, Button, Card, EmptyState, Field, Input, Modal, MoneyInput, PageHeader, Select, Spinner, StatusBadge, TableWrap, useToast } from "../components/ui";
import { AccountSelect } from "../components/pickers";
import { fmtDate, today } from "../lib/format";

function AssetForm({ onClose }: { onClose: (c: boolean) => void }) {
  const { path, accounts } = useCompany();
  const toast = useToast();
  const [v, setV] = useState({ code: "", name: "", category: "", acquisition_date: today(), depreciation_start_date: "", cost: "", salvage_value: "0", method: "slm", useful_life_months: "60", wdv_rate_percent: "15", asset_account_id: accounts.find((a) => a.system_key === "FIXED_ASSET")?.id ?? "", paid_from_account_id: "" });
  const { busy, error, run } = useAction();
  return (
    <Modal open wide onClose={() => onClose(false)} title="Add fixed asset" footer={<><Button variant="secondary" onClick={() => onClose(false)}>Cancel</Button><Button loading={busy} onClick={async () => {
      const r = await run(() => api.post(path("/assets"), { ...v, category: v.category || null, depreciation_start_date: v.depreciation_start_date || null, useful_life_months: v.method === "slm" ? Number(v.useful_life_months) : null, wdv_rate_percent: v.method === "wdv" ? v.wdv_rate_percent : null, paid_from_account_id: v.paid_from_account_id || null }));
      if (r) { toast("success", "Asset added"); onClose(true); }
    }}>Save</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        {error && <Alert className="sm:col-span-2">{error}</Alert>}
        <Field label="Asset code" required>{(id) => <Input id={id} value={v.code} onChange={(e) => setV({ ...v, code: e.target.value })} />}</Field>
        <Field label="Name" required>{(id) => <Input id={id} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />}</Field>
        <Field label="Category">{(id) => <Input id={id} value={v.category} onChange={(e) => setV({ ...v, category: e.target.value })} />}</Field>
        <Field label="Asset account" required>{(id) => <AccountSelect id={id} value={v.asset_account_id} onChange={(a) => setV({ ...v, asset_account_id: a })} filter={(a) => a.subtype === "fixed_asset"} />}</Field>
        <Field label="Acquisition date" required>{(id) => <Input id={id} type="date" value={v.acquisition_date} onChange={(e) => setV({ ...v, acquisition_date: e.target.value })} />}</Field>
        <Field label="Depreciation starts" hint="Default: acquisition date (charged from that month)">{(id) => <Input id={id} type="date" value={v.depreciation_start_date} onChange={(e) => setV({ ...v, depreciation_start_date: e.target.value })} />}</Field>
        <Field label="Cost" required>{(id) => <MoneyInput id={id} value={v.cost} onChange={(e) => setV({ ...v, cost: e.target.value })} />}</Field>
        <Field label="Salvage value">{(id) => <MoneyInput id={id} value={v.salvage_value} onChange={(e) => setV({ ...v, salvage_value: e.target.value })} />}</Field>
        <Field label="Method">{(id) => <Select id={id} value={v.method} onChange={(e) => setV({ ...v, method: e.target.value })}><option value="slm">Straight line (SLM)</option><option value="wdv">Written down value (WDV)</option></Select>}</Field>
        {v.method === "slm" ? <Field label="Useful life (months)">{(id) => <Input id={id} type="number" min={1} value={v.useful_life_months} onChange={(e) => setV({ ...v, useful_life_months: e.target.value })} />}</Field>
          : <Field label="WDV rate (% per year)" hint="Charged monthly as rate ÷ 12 on the opening WDV.">{(id) => <Input id={id} inputMode="decimal" value={v.wdv_rate_percent} onChange={(e) => setV({ ...v, wdv_rate_percent: e.target.value })} />}</Field>}
        <Field label="Record purchase now — paid from" hint="Leave empty if you already posted the purchase via a bill to the asset account." className="sm:col-span-2">{(id) => <AccountSelect id={id} value={v.paid_from_account_id} onChange={(a) => setV({ ...v, paid_from_account_id: a })} filter={(a) => ["cash", "bank", "payable", "current_liability", "long_term_liability"].includes(a.subtype)} placeholder="Don't post acquisition" />}</Field>
      </div>
    </Modal>
  );
}

function AssetDetail({ assetId, onClose }: { assetId: string; onClose: (c: boolean) => void }) {
  const { path, money, settings, can } = useCompany();
  const toast = useToast();
  const { data } = useApi<any>(path(`/assets/${assetId}`));
  const [dispose, setDispose] = useState({ date: today(), proceeds: "0", deposit_account_id: "" });
  const { busy, error, run } = useAction();
  const df = settings?.company.date_format;
  return (
    <Modal open wide onClose={() => onClose(false)} title={data ? `${data.asset.code} · ${data.asset.name}` : "Asset"}>
      {!data ? <Spinner /> : (
        <div className="space-y-4">
          {error && <Alert>{error}</Alert>}
          <div className="grid gap-3 text-sm sm:grid-cols-4">
            <div><p className="muted">Cost</p><p className="font-medium">{money(data.asset.cost)}</p></div>
            <div><p className="muted">Accumulated depreciation</p><p className="font-medium">{money(data.accumulated_depreciation)}</p></div>
            <div><p className="muted">Book value</p><p className="font-medium">{money(data.asset.cost - data.accumulated_depreciation)}</p></div>
            <div><p className="muted">Method</p><p>{data.asset.method === "slm" ? `SLM · ${data.asset.useful_life_months} months` : `WDV · ${data.asset.wdv_rate_bp / 100}% p.a.`}</p></div>
          </div>
          <h3 className="text-sm font-semibold">Schedule</h3>
          <TableWrap><div className="max-h-72 overflow-y-auto"><table className="table text-sm">
            <thead><tr><th>Month</th><th className="num">Depreciation</th><th className="num">Accumulated</th><th className="num">Book value</th><th>Posted</th></tr></thead>
            <tbody>{data.schedule.map((s: any) => { const posted = data.entries.find((e: any) => e.period_month === s.month); return (
              <tr key={s.month}><td>{s.month}</td><td className="num">{money(s.amount)}</td><td className="num">{money(s.accumulated)}</td><td className="num">{money(s.book_value)}</td><td className="text-xs">{posted ? posted.entry_number : ""}</td></tr>
            ); })}</tbody>
          </table></div></TableWrap>
          {data.asset.status === "active" && can("txn.post") && (
            <div className="rounded-lg bg-[var(--surface-2)] p-3">
              <h3 className="mb-2 text-sm font-semibold">Dispose / sell</h3>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Date">{(id) => <Input id={id} type="date" value={dispose.date} onChange={(e) => setDispose({ ...dispose, date: e.target.value })} />}</Field>
                <Field label="Proceeds">{(id) => <MoneyInput id={id} value={dispose.proceeds} onChange={(e) => setDispose({ ...dispose, proceeds: e.target.value })} />}</Field>
                <Field label="Received into">{(id) => <AccountSelect id={id} value={dispose.deposit_account_id} onChange={(a) => setDispose({ ...dispose, deposit_account_id: a })} filter={(a) => ["cash", "bank", "receivable", "current_asset"].includes(a.subtype)} />}</Field>
              </div>
              <Button className="mt-3" variant="danger" size="sm" loading={busy} onClick={async () => { const r = await run(() => api.post(path(`/assets/${assetId}/dispose`), { ...dispose, deposit_account_id: dispose.deposit_account_id || null })); if (r) { toast("success", `Disposed — ${r.gain >= 0 ? "gain" : "loss"} ${money(Math.abs(r.gain))}`); onClose(true); } }}>Post disposal</Button>
            </div>
          )}
          {data.asset.status === "disposed" && <Alert kind="info">Disposed on {fmtDate(data.asset.disposal_date, df)} for {money(data.asset.disposal_proceeds)}.</Alert>}
        </div>
      )}
    </Modal>
  );
}

export default function Assets() {
  const { path, money, settings, can } = useCompany();
  const toast = useToast();
  const { data, loading, reload } = useApi<{ assets: any[] }>(path("/assets"));
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [through, setThrough] = useState(today().slice(0, 7));
  const { busy, run, error } = useAction();
  const df = settings?.company.date_format;
  return (
    <>
      <PageHeader title="Fixed assets" actions={can("masters.write") && <Button onClick={() => setAdding(true)}><Plus className="h-4 w-4" />Add asset</Button>} />
      <Card className="mb-4" title="Run depreciation">
        {error && <Alert className="mb-3">{error}</Alert>}
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Through month">{(id) => <Input id={id} type="month" value={through} onChange={(e) => setThrough(e.target.value)} />}</Field>
          <Button loading={busy} disabled={!can("txn.post")} onClick={async () => { const r = await run(() => api.post(path("/assets/depreciation/run"), { through })); if (r) { toast("success", r.journals ? `Posted ${r.journals} depreciation journal(s): ${r.months.join(", ")}` : "Nothing pending"); reload(); } }}>Post depreciation</Button>
        </div>
        <p className="mt-2 text-xs muted">Posts one journal per month for months not yet depreciated. Safe to run repeatedly — each asset/month is charged once.</p>
      </Card>
      <Card padded={false}>
        {loading && !data ? <Spinner /> : !data?.assets.length ? <EmptyState title="No fixed assets" /> : (
          <TableWrap><table className="table">
            <thead><tr><th>Code</th><th>Name</th><th>Acquired</th><th>Status</th><th className="num">Cost</th><th className="num">Acc. depreciation</th><th className="num">Book value</th><th>Last run</th></tr></thead>
            <tbody>{data.assets.map((a) => (
              <tr key={a.id}>
                <td className="font-mono text-xs">{a.code}</td>
                <td><button className="font-medium text-brand-700 hover:underline dark:text-brand-300" onClick={() => setOpen(a.id)}>{a.name}</button></td>
                <td>{fmtDate(a.acquisition_date, df)}</td><td><StatusBadge status={a.status} /></td>
                <td className="num">{money(a.cost)}</td><td className="num">{money(a.accumulated_depreciation)}</td><td className="num">{money(a.status === "active" ? a.cost - a.accumulated_depreciation : 0)}</td>
                <td className="text-sm">{a.last_depreciated ?? "—"}</td>
              </tr>
            ))}</tbody>
          </table></TableWrap>
        )}
      </Card>
      {adding && <AssetForm onClose={(c) => { setAdding(false); if (c) reload(); }} />}
      {open && <AssetDetail assetId={open} onClose={(c) => { setOpen(null); if (c) reload(); }} />}
    </>
  );
}
