import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ArrowLeftRight, CheckCircle2, AlertTriangle } from "lucide-react";
import { useCompany } from "../lib/company";
import { useApi } from "../lib/hooks";
import { api, errorMessage } from "../lib/api";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Modal, PageHeader, Select, Spinner, TableWrap, useToast } from "../components/ui";
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

// ── Reports → Tax check (fix GST / VAT problems) ──

function ItemFix({ row, mode, onDone }: { row: any; mode: "item_hsn" | "item_tax"; onDone: () => void }) {
  const { path, settings } = useCompany();
  const toast = useToast();
  const [v, setV] = useState(mode === "item_hsn" ? row.hsn_sac ?? "" : "");
  const codes = (settings?.tax_codes ?? []).filter((t: any) => t.is_active);
  return (
    <span className="flex items-center gap-2">
      {mode === "item_hsn"
        ? <Input value={v} inputMode="numeric" className="w-28 font-mono" placeholder="HSN / SAC" aria-label={`HSN for ${row.name}`} onChange={(e) => setV(e.target.value.replace(/\D/g, "").slice(0, 8))} />
        : <Select className="w-44" value={v} aria-label={`Tax for ${row.name}`} onChange={(e) => setV(e.target.value)}><option value="">Choose tax…</option>{codes.map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>}
      <Button size="sm" disabled={!v} onClick={async () => {
        try { await api.patch(path(`/tax-check/item/${row.item_id}`), mode === "item_hsn" ? { hsn_sac: v } : { tax_code_id: v }); toast("success", "Fixed"); onDone(); }
        catch (e) { toast("error", errorMessage(e)); }
      }}>Fix</Button>
    </span>
  );
}

export function TaxCheckReport() {
  const { path, id, can } = useCompany();
  const toast = useToast();
  const { data, error, loading, reload } = useApi<{ issues: any[]; registered: boolean }>(path("/tax-check"));
  const HIDE = ["contact_id", "item_id", "document_id", "doc_type"];
  const open = (data?.issues ?? []).filter((i) => i.count > 0);
  return (
    <>
      <PageHeader title="Tax check" subtitle="Mistakes that would make your GST / VAT return or invoices wrong, with the fix for each." back={{ to: `/app/${id}/reports`, label: "Reports" }} />
      {error && <Alert>{error}</Alert>}
      {loading && !data ? <Spinner /> : data && <div className="space-y-3">
        {!data.registered && <Alert kind="info">Your company has no tax registration number in Settings → Company, so tax-rate checks on products are skipped.</Alert>}
        {open.length === 0
          ? <Card><p className="flex items-center gap-2 font-medium text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="h-5 w-5" />Everything looks right. Nothing to fix.</p></Card>
          : <p className="text-sm">{open.reduce((t, i) => t + i.count, 0)} things to fix in {open.length} {open.length === 1 ? "group" : "groups"}.</p>}
        {open.map((iss) => (
          <Card key={iss.key} title={<span className="flex items-center gap-2"><AlertTriangle className="h-5 w-5 text-amber-500" />{iss.title}<Badge color="amber">{iss.count}</Badge></span>}>
            <p className="text-sm muted">{iss.why}</p>
            <TableWrap><table className="table mt-2">
              <thead><tr>{Object.keys(iss.rows[0]).filter((k) => !HIDE.includes(k)).map((k) => <th key={k}>{k.replace(/_/g, " ").replace(/^./, (x: string) => x.toUpperCase())}</th>)}<th>Fix</th></tr></thead>
              <tbody>{iss.rows.map((r: any, i: number) => <tr key={i}>
                {Object.keys(iss.rows[0]).filter((k) => !HIDE.includes(k)).map((k) => <td key={k}>{k === "date" ? fmtDate(r[k]) : r[k] ?? "—"}</td>)}
                <td>{iss.fix === "edit_contact" && <Link className="text-brand-700 hover:underline dark:text-brand-300" to={contactPath(id, r.contact_id)}>Open and edit</Link>}
                  {iss.fix === "state_from_gstin" && (can("customers.write") || can("suppliers.write")) && <Button size="sm" onClick={async () => {
                    try { await api.post(path("/tax-check/state-from-gstin"), { contact_id: r.contact_id }); toast("success", "State set from the GSTIN"); reload(); } catch (e) { toast("error", errorMessage(e)); }
                  }}>Set state from GSTIN</Button>}
                  {(iss.fix === "item_hsn" || iss.fix === "item_tax") && can("items.write") && <ItemFix row={r} mode={iss.fix} onDone={reload} />}
                  {iss.fix === "open_document" && <Link className="text-brand-700 hover:underline dark:text-brand-300" to={docPath(id, r.doc_type, r.document_id)}>Open</Link>}
                </td></tr>)}</tbody>
            </table></TableWrap>
          </Card>
        ))}
      </div>}
    </>
  );
}
