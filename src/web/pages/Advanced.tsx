import { useState } from "react";
import { Link } from "react-router";
import { Copy, Plus, Trash2 } from "lucide-react";
import { useCompany } from "../lib/company";
import { useApi } from "../lib/hooks";
import { api, errorMessage } from "../lib/api";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Modal, PageHeader, Select, Spinner, TableWrap, useToast } from "../components/ui";
import { AccountSelect } from "../components/pickers";
import { DOC_LABELS, fmtDate, today, toInput } from "../lib/format";
import { docPath } from "../lib/links";

const DOC_TYPES = ["purchase_order", "bill", "debit_note", "invoice", "credit_note", "quote", "sales_order"];
const label = (t: string) => DOC_LABELS[t]?.one ?? t;

// ── Landed cost (a tab of Purchasing) ──

export function LandedCost() {
  const { path, money, can, settings, id: cid } = useCompany();
  const toast = useToast();
  const list = useApi<{ landed_costs: any[] }>(path("/landed-costs"));
  const bills = useApi<{ documents: any[] }>(path("/documents?type=bill&status=posted&limit=200"));
  const [billId, setBillId] = useState("");
  const stock = useApi<{ bill: any; lines: any[] }>(billId ? path(`/landed-costs/bill/${billId}`) : null);
  const [charges, setCharges] = useState([{ description: "Freight", amount: "" }]);
  const [method, setMethod] = useState("value");
  const [account, setAccount] = useState("");
  const [date, setDate] = useState(today());
  const [error, setError] = useState<string | null>(null);
  const df = settings?.company.date_format;
  const total = charges.reduce((s, c) => s + (Number(c.amount) || 0), 0);
  const weights = stock.data?.lines.map((l) => (method === "value" ? l.value : l.qty_milli)) ?? [];
  const sum = weights.reduce((s, w) => s + w, 0);
  return (
    <>
      <Card title="Add freight, customs and other charges to the cost of purchased stock">
        <p className="mb-3 text-sm muted">Choose the supplier's bill for the goods, enter the extra charges, and the account they were booked to (e.g. Freight, or the transporter's payable). The charges move from that account into stock, so the items' cost and margins are right.</p>
        {error && <Alert className="mb-3">{error}</Alert>}
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Goods bill" className="sm:col-span-2">{(fid) => <Select id={fid} value={billId} onChange={(e) => setBillId(e.target.value)}><option value="">Choose…</option>{bills.data?.documents.map((d) => <option key={d.id} value={d.id}>{d.number} · {d.contact_name} · {money(d.total, d.currency)}</option>)}</Select>}</Field>
          <Field label="Spread by">{(fid) => <Select id={fid} value={method} onChange={(e) => setMethod(e.target.value)}><option value="value">Value</option><option value="quantity">Quantity</option></Select>}</Field>
          <Field label="Date">{(fid) => <Input id={fid} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
        </div>
        <div className="mt-3 grid gap-2">{charges.map((c, i) => <div key={i} className="grid grid-cols-[1fr_10rem_auto] gap-2">
          <Input aria-label="Charge" value={c.description} onChange={(e) => setCharges(charges.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
          <Input aria-label="Amount" inputMode="decimal" placeholder="Amount" value={c.amount} onChange={(e) => setCharges(charges.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
          <Button variant="ghost" size="sm" aria-label="Remove" disabled={charges.length === 1} onClick={() => setCharges(charges.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button></div>)}</div>
        <Button className="mt-2" size="sm" variant="secondary" onClick={() => setCharges([...charges, { description: "Customs duty", amount: "" }])}><Plus className="h-4 w-4" />Add charge</Button>
        <Field label="Booked to (credit)" className="mt-3 max-w-md">{(fid) => <AccountSelect id={fid} value={account} onChange={setAccount} filter={(a) => a.type === "expense" || (a.type === "liability" && a.subtype !== "tax_output") || a.subtype === "cash" || a.subtype === "bank"} />}</Field>
        {stock.data && <TableWrap><table className="table mt-3 text-sm">
          <thead><tr><th>Item</th><th className="num">Quantity</th><th className="num">Value on the bill</th><th className="num">Gets</th></tr></thead>
          <tbody>{stock.data.lines.map((l, i) => <tr key={l.item_id + l.warehouse_id}><td>{l.name}</td><td className="num">{l.qty_milli / 1000}</td><td className="num">{money(l.value)}</td><td className="num">{sum ? money(Math.round((total * 100 * weights[i]) / sum)) : "—"}</td></tr>)}</tbody>
        </table></TableWrap>}
        {can("purchase.post") && <Button className="mt-3" disabled={!billId || !account || !total} onClick={async () => {
          setError(null);
          try { await api.post(path("/landed-costs"), { bill_id: billId, credit_account_id: account, method, cost_date: date, charges: charges.filter((c) => c.amount) }); toast("success", "Landed cost added to stock"); setBillId(""); setCharges([{ description: "Freight", amount: "" }]); list.reload(); }
          catch (e) { setError(errorMessage(e)); }
        }}>Add to stock cost</Button>}
      </Card>
      <Card className="mt-4" padded={false} title="Landed costs added">
        {!list.data?.landed_costs.length ? <EmptyState title="None yet" /> : <TableWrap><table className="table text-sm">
          <thead><tr><th>Date</th><th>Bill</th><th>Supplier</th><th>Charges</th><th>From account</th><th className="num">Total</th></tr></thead>
          <tbody>{list.data.landed_costs.map((x) => <tr key={x.id}><td>{fmtDate(x.cost_date, df)}</td><td><Link className="text-brand-700 hover:underline dark:text-brand-300" to={docPath(cid, "bill", x.bill_id)}>{x.bill_number}</Link></td><td>{x.supplier}</td>
            <td>{x.details.charges.map((c: any) => c.description).join(", ")}</td><td>{x.credit_account}</td><td className="num">{money(x.total)}</td></tr>)}</tbody>
        </table></TableWrap>}
      </Card>
    </>
  );
}

// ── Approvals ──

export function ApprovalsPage() {
  const { path, money, can, id: cid, settings } = useCompany();
  const toast = useToast();
  const pending = useApi<{ pending: any[] }>(path("/approvals"));
  const df = settings?.company.date_format;
  return (
    <>
      <PageHeader title="Approvals" subtitle="Documents that wait for approval before they can be issued, and the rules that decide who approves what." />
      <Card padded={false} title="Waiting for approval">
        {pending.loading && !pending.data ? <Spinner /> : !pending.data?.pending.length ? <EmptyState title="Nothing is waiting" body="Drafts that need approval under your rules appear here." /> : (
          <TableWrap><table className="table text-sm">
            <thead><tr><th>Document</th><th>Party</th><th>Date</th><th className="num">Amount</th><th>Progress</th><th>Waiting for</th><th /></tr></thead>
            <tbody>{pending.data.pending.map((d) => <tr key={d.id}>
              <td><Link className="text-brand-700 hover:underline dark:text-brand-300" to={docPath(cid, d.doc_type, d.id)}>{label(d.doc_type)} {d.number ?? "(draft)"}</Link></td>
              <td>{d.party}</td><td>{fmtDate(d.issue_date, df)}</td><td className="num">{money(d.total, d.currency)}</td>
              <td>{d.done} of {d.steps} steps</td><td><Badge color={d.mine ? "amber" : "gray"}>{d.next_role} (step {d.next_step})</Badge></td>
              <td className="text-right">{d.mine && <Button size="sm" onClick={async () => { try { await api.post(path(`/approvals/${d.id}/approve`), {}); toast("success", "Approved"); pending.reload(); } catch (e) { toast("error", errorMessage(e)); } }}>Approve</Button>}</td></tr>)}</tbody>
          </table></TableWrap>
        )}
      </Card>
      {can("company.manage") && <Rules />}
    </>
  );
}

function Rules() {
  const { path, settings } = useCompany();
  const toast = useToast();
  const data = useApi<{ rules: any[]; roles: string[] }>(path("/approval-rules"));
  const base = settings?.company.base_currency ?? "INR";
  const [rules, setRules] = useState<{ doc_type: string; min_amount: string; approver_role: string; step: number }[] | null>(null);
  const shown = rules ?? data.data?.rules.map((r) => ({ doc_type: r.doc_type, min_amount: toInput(r.min_amount, base), approver_role: r.approver_role, step: r.step })) ?? [];
  const set = (i: number, p: Partial<(typeof shown)[number]>) => setRules(shown.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <Card className="mt-4" title="Approval rules" actions={<Button size="sm" variant="secondary" onClick={() => setRules([...shown, { doc_type: "purchase_order", min_amount: "50000", approver_role: "admin", step: 1 }])}><Plus className="h-4 w-4" />Add rule</Button>}>
      <p className="mb-3 text-sm muted">A document of this type at or above the amount needs approval by the role, one step after another (step 1 first). The approver cannot be the person who made it, and each step needs a different person. The owner can issue without approval.</p>
      {!shown.length ? <p className="text-sm muted">No rules: documents are issued without approval (apart from the purchase approval limit in Settings).</p> :
        <div className="grid gap-2">{shown.map((r, i) => <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_10rem_10rem_7.5rem_auto]">
          <Select aria-label="Document" value={r.doc_type} onChange={(e) => set(i, { doc_type: e.target.value })}>{DOC_TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</Select>
          <Input aria-label="From amount" inputMode="decimal" value={r.min_amount} onChange={(e) => set(i, { min_amount: e.target.value })} />
          <Select aria-label="Approved by" value={r.approver_role} onChange={(e) => set(i, { approver_role: e.target.value })}>{(data.data?.roles ?? []).map((x) => <option key={x}>{x}</option>)}</Select>
          <Select aria-label="Step" value={r.step} onChange={(e) => set(i, { step: Number(e.target.value) })}>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>Step {n}</option>)}</Select>
          <Button variant="ghost" size="sm" aria-label="Remove rule" onClick={() => setRules(shown.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button></div>)}</div>}
      {rules && <Button className="mt-3" onClick={async () => { try { await api.put(path("/approval-rules"), { rules }); toast("success", "Rules saved"); setRules(null); data.reload(); } catch (e) { toast("error", errorMessage(e)); } }}>Save rules</Button>}
    </Card>
  );
}

// ── Currency revaluation ──

export function FxPage() {
  const { path, money, can, settings, id: cid } = useCompany();
  const toast = useToast();
  const monthEnd = (() => { const d = new Date(); d.setUTCDate(0); return d.toISOString().slice(0, 10); })();
  const [asOf, setAsOf] = useState(monthEnd);
  const r = useApi<{ rows: any[]; missing_rates: string[]; total: number; history: any[] }>(path(`/fx-revaluation?as_of=${asOf}`));
  const df = settings?.company.date_format;
  return (
    <>
      <PageHeader title="Currency revaluation" subtitle="At month end, open invoices and bills in other currencies are valued at the latest exchange rate; the unrealised gain or loss is posted and reversed the next day." />
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Revalue as at">{(fid) => <Input id={fid} type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />}</Field>
          {can("journal.post") && <Button disabled={!r.data?.rows.length || !!r.data?.missing_rates.length} onClick={async () => {
            if (!confirm(`Post the revaluation at ${asOf} (and its reversal the next day)?`)) return;
            try { await api.post(path("/fx-revaluation"), { as_of: asOf }); toast("success", "Revaluation posted"); r.reload(); } catch (e) { toast("error", errorMessage(e)); }
          }}>Post revaluation</Button>}
        </div>
        {r.data?.missing_rates.length ? <Alert kind="warning" className="mt-3">Enter the exchange rate for {r.data.missing_rates.join(", ")} on or before this date in Settings → Currencies.</Alert> : null}
      </Card>
      <Card className="mt-4" padded={false} title={`Open foreign-currency documents · net ${r.data ? money(r.data.total) : "—"} ${r.data && r.data.total >= 0 ? "gain" : "loss"}`}>
        {r.loading && !r.data ? <Spinner /> : !r.data?.rows.length ? <EmptyState title="Nothing to revalue" body="No open invoices or bills in other currencies, or the rate has not changed." /> : (
          <TableWrap><table className="table text-sm">
            <thead><tr><th>Document</th><th>Party</th><th className="num">Open amount</th><th className="num">Booked rate</th><th className="num">Rate now</th><th className="num">Gain / loss</th></tr></thead>
            <tbody>{r.data.rows.map((x) => <tr key={x.document_id}><td><Link className="text-brand-700 hover:underline dark:text-brand-300" to={docPath(cid, x.doc_type, x.document_id)}>{x.number}</Link></td><td>{x.party}</td>
              <td className="num">{money(x.outstanding_fc, x.currency)}</td><td className="num">{(x.booked_rate / 1e9).toFixed(4)}</td><td className="num">{(x.new_rate / 1e9).toFixed(4)}</td>
              <td className={`num font-medium ${x.difference >= 0 ? "text-emerald-700" : "text-red-600"}`}>{money(x.difference)}</td></tr>)}</tbody>
          </table></TableWrap>
        )}
      </Card>
      {r.data?.history.length ? <Card className="mt-4" title="Posted revaluations">{r.data.history.map((h) => <p key={h.id} className="text-sm">{fmtDate(h.as_of, df)} · {money(h.total)}</p>)}</Card> : null}
    </>
  );
}

// ── API keys ──

export function ApiKeysPage() {
  const { path, settings } = useCompany();
  const toast = useToast();
  const keys = useApi<{ keys: any[] }>(path("/api-keys"));
  const [v, setV] = useState({ name: "", access: "read" });
  const [made, setMade] = useState<{ key: string; company_id: string } | null>(null);
  const df = settings?.company.date_format;
  const base = typeof location !== "undefined" ? location.origin : "";
  return (
    <>
      <PageHeader title="API keys" subtitle="Connect your website, online shop or other software to this company: read invoices, customers and products, or create them." />
      <Card title="New key">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Name">{(fid) => <Input id={fid} placeholder="e.g. Website orders" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />}</Field>
          <Field label="Access">{(fid) => <Select id={fid} value={v.access} onChange={(e) => setV({ ...v, access: e.target.value })}><option value="read">Read only</option><option value="write">Read and write</option></Select>}</Field>
          <Button disabled={!v.name} onClick={async () => { try { setMade(await api.post(path("/api-keys"), v)); setV({ name: "", access: "read" }); keys.reload(); } catch (e) { toast("error", errorMessage(e)); } }}>Make key</Button>
        </div>
      </Card>
      <Card className="mt-4" padded={false} title="Keys">
        {!keys.data?.keys.length ? <EmptyState title="No keys" /> : <TableWrap><table className="table text-sm">
          <thead><tr><th>Name</th><th>Key</th><th>Access</th><th>Made</th><th>Last used</th><th /></tr></thead>
          <tbody>{keys.data.keys.map((k) => <tr key={k.id} className={k.revoked_at ? "opacity-60" : ""}><td>{k.name}</td><td className="font-mono text-xs">{k.prefix}…</td><td>{k.access}</td><td>{fmtDate(k.created_at.slice(0, 10), df)} · {k.created_by}</td><td>{k.last_used_at ? fmtDate(k.last_used_at.slice(0, 10), df) : "never"}</td>
            <td className="text-right">{k.revoked_at ? <Badge>revoked</Badge> : <Button size="sm" variant="ghost" onClick={async () => { if (!confirm(`Revoke “${k.name}”? Anything using it stops working.`)) return; await api.post(path(`/api-keys/${k.id}/revoke`)); keys.reload(); }}>Revoke</Button>}</td></tr>)}</tbody>
        </table></TableWrap>}
      </Card>
      <Card className="mt-4" title="How to use">
        <p className="text-sm">Send the key in the <code>Authorization</code> header. The key works only for this company; a read-only key can only look.</p>
        <pre className="mt-2 overflow-x-auto rounded-lg bg-[var(--surface-2)] p-3 text-xs">{`curl ${base}/api/c/${settings?.company.id}/documents?type=invoice \\
  -H "Authorization: Bearer lfk_…"

curl -X POST ${base}/api/c/${settings?.company.id}/contacts \\
  -H "Authorization: Bearer lfk_…" -H "Content-Type: application/json" \\
  -d '{"kind":"customer","name":"Online buyer","email":"buyer@example.com"}'`}</pre>
        <p className="mt-2 text-sm muted">Main endpoints: <code>/contacts</code>, <code>/items</code>, <code>/documents</code> (invoices, quotations, orders, bills; <code>POST /documents/:id/issue</code> to issue), <code>/payments</code>, <code>/reports/…</code>. Up to 600 requests a minute. To be told when something happens (an invoice issued, a payment received), add a webhook in Settings → Automations.</p>
      </Card>
      {made && <Modal open title="Copy your key now" onClose={() => setMade(null)}>
        <Alert kind="warning">This is the only time the key is shown. Keep it secret, like a password.</Alert>
        <div className="mt-3 flex gap-2"><Input readOnly value={made.key} className="font-mono text-xs" onFocus={(e) => e.target.select()} aria-label="API key" />
          <Button variant="secondary" aria-label="Copy key" onClick={() => { void navigator.clipboard?.writeText(made.key); toast("success", "Copied"); }}><Copy className="h-4 w-4" /></Button></div>
      </Modal>}
    </>
  );
}
