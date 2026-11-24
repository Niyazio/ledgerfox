import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ArrowLeftRight, CheckCircle2, AlertTriangle } from "lucide-react";
import { useCompany } from "../lib/company";
import { useApi } from "../lib/hooks";
import { api, errorMessage } from "../lib/api";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Modal, PageHeader, Spinner, TableWrap, useToast } from "../components/ui";
import { AccountSelect } from "../components/pickers";
import { DateRangeFilter } from "../components/DateRange";
import { fmtDate, fyStart, today } from "../lib/format";
import { MODULES, parseModulesOff, type ModuleKey } from "@shared/modules";
import { contactPath, docPath } from "../lib/links";
import { useSearchParams } from "react-router";

// ── Settings → Features ──

export function FeaturesTab() {
  const { settings, path, can, reload } = useCompany();
  const toast = useToast();
  const [off, setOff] = useState<ModuleKey[]>([]);
  const [busy, setBusy] = useState(false);
  const stored = (settings?.company as { modules_off?: string | null } | undefined)?.modules_off;
  useEffect(() => { setOff(parseModulesOff(stored)); }, [stored]);
  const disabled = !can("company.manage");
  return (
    <Card title="Features">
      <p className="text-sm muted">Switch off what your business does not use, and the menus and screens stay simple. Nothing is deleted: switch a feature back on and everything is there again. Invoices, bills, receipts, payments, expenses, journals and reports are always on.</p>
      <ul className="mt-4 divide-y divide-[var(--border)]">
        {MODULES.map((m) => (
          <li key={m.key} className="flex items-start gap-3 py-3">
            <input id={`mod-${m.key}`} type="checkbox" className="mt-1" disabled={disabled} checked={!off.includes(m.key)} onChange={(e) => setOff((p) => (e.target.checked ? p.filter((k) => k !== m.key) : [...p, m.key]))} />
            <label htmlFor={`mod-${m.key}`} className="flex-1 cursor-pointer"><span className="font-medium">{m.label}</span><span className="block text-sm muted">{m.description}</span></label>
            <Badge color={off.includes(m.key) ? "gray" : "green"}>{off.includes(m.key) ? "Off" : "On"}</Badge>
          </li>
        ))}
      </ul>
      {!disabled && <Button className="mt-4" loading={busy} onClick={async () => {
        setBusy(true);
        try { await api.put(path("/settings/modules"), { off }); await reload(); toast("success", "Saved — the menus now show only what you use"); }
        catch (e) { toast("error", errorMessage(e)); } finally { setBusy(false); }
      }}>Save</Button>}
    </Card>
  );
}

// ── Banking: contra entries (cash ↔ bank) ──

export function ContraCard() {
  const { path, money, accounts, can, id } = useCompany();
  const toast = useToast();
  const { data, reload } = useApi<{ contras: any[] }>(path("/banking/contra"));
  const [v, setV] = useState<{ entry_date: string; from_account_id: string; to_account_id: string; amount: string; reference: string; memo: string } | null>(null);
  const cashBank = new Set(accounts.filter((a) => a.subtype === "cash" || a.subtype === "bank").map((a) => a.id));
  const write = can("bank.reconcile") || can("journal.post");
  return (
    <Card title={<span className="flex items-center gap-2"><ArrowLeftRight className="h-5 w-5" />Contra entries</span>}
      actions={write && <Button size="sm" onClick={() => setV({ entry_date: today(), from_account_id: "", to_account_id: "", amount: "", reference: "", memo: "" })}>New contra</Button>}>
      <p className="text-sm muted">Money moved between your own accounts: cash deposited in the bank, cash withdrawn, or a transfer between two banks.</p>
      {!data ? <Spinner /> : data.contras.length ? <TableWrap><table className="table mt-2">
        <thead><tr><th>Date</th><th>No.</th><th>From</th><th>To</th><th>Reference</th><th className="num">Amount</th><th /></tr></thead>
        <tbody>{data.contras.map((c) => <tr key={c.id} className={c.reversed_by_id ? "line-through opacity-60" : ""}>
          <td>{fmtDate(c.entry_date)}</td><td><Link className="text-brand-700 hover:underline dark:text-brand-300" to={`/app/${id}/journals/${c.id}`}>{c.entry_number}</Link></td>
          <td>{c.from_account}</td><td>{c.to_account}</td><td className="text-xs">{c.reference ?? ""}</td><td className="num">{money(c.total)}</td>
          <td className="text-right">{write && !c.reversed_by_id && <Button size="sm" variant="ghost" onClick={async () => {
            const reason = prompt("Why is this contra cancelled? (kept in the audit trail)");
            if (reason === null) return;
            try { await api.post(path(`/banking/contra/${c.id}/cancel`), { reason }); reload(); toast("success", "Cancelled with a reversal entry"); } catch (e) { toast("error", errorMessage(e)); }
          }}>Cancel</Button>}</td></tr>)}</tbody>
      </table></TableWrap> : <EmptyState title="No contra entries yet" />}
      {v && <Modal open title="New contra entry" onClose={() => setV(null)} footer={<><Button variant="secondary" onClick={() => setV(null)}>Cancel</Button><Button onClick={async () => {
        try { await api.post(path("/banking/contra"), v); setV(null); reload(); toast("success", "Contra entry posted"); } catch (e) { toast("error", errorMessage(e)); }
      }}>Post</Button></>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Date">{(id) => <Input id={id} type="date" value={v.entry_date} onChange={(e) => setV({ ...v, entry_date: e.target.value })} />}</Field>
          <Field label="Amount">{(id) => <Input id={id} inputMode="decimal" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} />}</Field>
          <Field label="From (money leaves)">{(id) => <AccountSelect id={id} value={v.from_account_id} filter={(a) => cashBank.has(a.id)} onChange={(x) => setV({ ...v, from_account_id: x })} />}</Field>
          <Field label="To (money arrives)">{(id) => <AccountSelect id={id} value={v.to_account_id} filter={(a) => cashBank.has(a.id)} onChange={(x) => setV({ ...v, to_account_id: x })} />}</Field>
          <Field label="Reference" hint="Deposit slip, cheque or UTR no.">{(id) => <Input id={id} value={v.reference} onChange={(e) => setV({ ...v, reference: e.target.value })} />}</Field>
          <Field label="Note">{(id) => <Input id={id} value={v.memo} onChange={(e) => setV({ ...v, memo: e.target.value })} />}</Field>
        </div>
      </Modal>}
    </Card>
  );
}

// ── Reports → Audit checks ──

export function AuditChecksReport() {
  const { path, money, id, settings } = useCompany();
  const [params, setParams] = useSearchParams();
  const from = params.get("from") ?? fyStart(settings?.company.fiscal_year_start_month ?? 4);
  const to = params.get("to") ?? today();
  const { data, error, loading } = useApi<{ checks: any[] }>(path(`/reports/audit-checks?from=${from}&to=${to}`));
  const cell = (k: string, v: any, row: any) => {
    if (v === null || v === undefined) return "—";
    if (["amount", "balance", "debit", "credit", "ledger", "details", "difference"].includes(k)) return money(v);
    if (k === "date" || k === "entered_on") return fmtDate(v);
    if (k === "number" && row.document_id) return <Link className="text-brand-700 hover:underline dark:text-brand-300" to={docPath(id, row.doc_type, row.document_id)}>{v}</Link>;
    if (k === "number" && row.entry_id) return <Link className="text-brand-700 hover:underline dark:text-brand-300" to={`/app/${id}/journals/${row.entry_id}`}>{v}</Link>;
    if (k === "party" && row.contact_id) return <Link className="hover:underline" to={contactPath(id, row.contact_id)}>{v}</Link>;
    return String(v);
  };
  const HIDE = ["document_id", "entry_id", "contact_id", "account_id", "source_id", "doc_type", "source_type"];
  const LABEL: Record<string, string> = { days_late: "Days late", entered_on: "Entered on", bills: "Bills", payments: "Payments", receipts: "Receipts", missing: "Missing number", series: "Series" };
  return (
    <>
      <PageHeader title="Audit checks" subtitle="What auditors look at first, checked for you. Fix or explain each warning before the audit." back={{ to: `/app/${id}/reports`, label: "Reports" }} />
      <div className="mb-4"><DateRangeFilter from={from} to={to} allowAll={false} onChange={(f, t) => { const n = new URLSearchParams(params); n.set("from", f || from); n.set("to", t || to); setParams(n, { replace: true }); }} /></div>
      {error && <Alert>{error}</Alert>}
      {loading && !data ? <Spinner /> : data && <div className="space-y-3">
        <p className="text-sm">{data.checks.filter((c) => c.ok).length} of {data.checks.length} checks passed.</p>
        {data.checks.map((c) => (
          <Card key={c.key} title={<span className="flex items-center gap-2">{c.ok ? <CheckCircle2 className="h-5 w-5 text-emerald-600" /> : <AlertTriangle className="h-5 w-5 text-amber-500" />}{c.title}{!c.ok && c.count > 0 && <Badge color="amber">{c.count}</Badge>}</span>}>
            <p className="text-sm muted">{c.why}</p>
            {c.rows.length > 0 && <TableWrap><table className="table mt-2">
              <thead><tr>{Object.keys(c.rows[0]).filter((k) => !HIDE.includes(k)).map((k) => <th key={k} className={["amount", "balance", "debit", "credit", "ledger", "details", "difference"].includes(k) ? "num" : ""}>{LABEL[k] ?? k.replace(/_/g, " ").replace(/^./, (x) => x.toUpperCase())}</th>)}</tr></thead>
              <tbody>{c.rows.map((r: any, i: number) => <tr key={i}>{Object.keys(c.rows[0]).filter((k) => !HIDE.includes(k)).map((k) => <td key={k} className={["amount", "balance", "debit", "credit", "ledger", "details", "difference"].includes(k) ? "num" : ""}>{cell(k, r[k], r)}</td>)}</tr>)}</tbody>
            </table></TableWrap>}
          </Card>
        ))}
      </div>}
    </>
  );
}
