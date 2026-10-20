import { useState } from "react";
import { Link } from "react-router";
import { Upload, Link2, Sparkles } from "lucide-react";
import { useCompany } from "../lib/company";
import { useApi, useAction } from "../lib/hooks";
import { api, errorMessage } from "../lib/api";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Modal, MoneyInput, PageHeader, Select, Spinner, StatusBadge, TableWrap, Tabs, useToast } from "../components/ui";
import { AccountSelect } from "../components/pickers";
import { fmtDate, fmtDateTime, today } from "../lib/format";
import { parseCsv } from "@shared/csv";

function ImportWizard({ accountId, onClose }: { accountId: string; onClose: (changed: boolean) => void }) {
  const { path, money } = useCompany();
  const toast = useToast();
  const [csv, setCsv] = useState("");
  const [filename, setFilename] = useState("");
  const [hasHeader, setHasHeader] = useState(true);
  const [dateFormat, setDateFormat] = useState("DD/MM/YYYY");
  const [mode, setMode] = useState<"split" | "single">("split");
  const [cols, setCols] = useState<Record<string, string>>({ date: "0", description: "1", reference: "", debit: "", credit: "", amount: "", balance: "" });
  const [preview, setPreview] = useState<any>(null);
  const { busy, error, run } = useAction();
  const rows = csv ? parseCsv(csv).slice(0, 6) : [];
  const header = rows[0] ?? [];
  const colOptions = header.map((h, i) => <option key={i} value={i}>{hasHeader ? h || `Column ${i + 1}` : `Column ${i + 1} (${h})`}</option>);
  const body = (previewOnly: boolean) => ({
    account_id: accountId, csv, filename, has_header: hasHeader, date_format: dateFormat, preview: previewOnly,
    columns: {
      date: Number(cols.date), description: Number(cols.description), reference: cols.reference ? Number(cols.reference) : null,
      ...(mode === "single" ? { amount: Number(cols.amount) } : { debit: Number(cols.debit), credit: Number(cols.credit) }),
      balance: cols.balance ? Number(cols.balance) : null,
    },
  });
  const sel = (k: string, label: string, optional = false) => (
    <Field label={label}>{(id) => <Select id={id} value={cols[k]} onChange={(e) => setCols({ ...cols, [k]: e.target.value })}>{optional && <option value="">— none —</option>}{colOptions}</Select>}</Field>
  );
  return (
    <Modal open wide onClose={() => onClose(false)} title="Import bank statement (CSV)"
      footer={<>
        <Button variant="secondary" onClick={() => onClose(false)}>Cancel</Button>
        <Button variant="secondary" loading={busy} disabled={!csv} onClick={async () => { const r = await run(() => api.post(path("/banking/import"), body(true))); if (r) setPreview(r); }}>Preview</Button>
        <Button loading={busy} disabled={!preview || preview.errors?.length} onClick={async () => { const r = await run(() => api.post(path("/banking/import"), body(false))); if (r) { toast("success", `Imported ${r.imported} line(s); ${r.duplicates} duplicate(s) skipped`); onClose(true); } }}>Import</Button>
      </>}>
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Alert kind="info">Export a CSV statement from your bank's net-banking. Files stay in your browser until you import; only parsed rows are stored. Maximum 2,000 rows per import.</Alert>
        <input type="file" accept=".csv,text/csv" onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; if (f.size > 1_900_000) { toast("error", "File too large (max ~1.9 MB)"); return; } setFilename(f.name); setCsv(await f.text()); setPreview(null); }} />
        {csv && <>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} /> First row is a header</label>
            <Field label="Date format">{(id) => <Select id={id} value={dateFormat} onChange={(e) => setDateFormat(e.target.value)}><option>DD/MM/YYYY</option><option>MM/DD/YYYY</option><option>YYYY-MM-DD</option><option>DD-MMM-YYYY</option></Select>}</Field>
            <Field label="Amount columns">{(id) => <Select id={id} value={mode} onChange={(e) => setMode(e.target.value as "split" | "single")}><option value="split">Separate withdrawal & deposit</option><option value="single">Single signed amount</option></Select>}</Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {sel("date", "Date")}{sel("description", "Narration / description")}{sel("reference", "Reference", true)}
            {mode === "split" ? <>{sel("debit", "Withdrawal (money out)")}{sel("credit", "Deposit (money in)")}</> : sel("amount", "Amount (+in / −out)")}
            {sel("balance", "Balance", true)}
          </div>
          <TableWrap><table className="table text-xs"><tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody></table></TableWrap>
        </>}
        {preview && (
          <div>
            <p className="text-sm font-medium">{preview.total} transaction(s) read{preview.errors.length ? `, ${preview.errors.length} error(s)` : ""}</p>
            {preview.errors.length > 0 && <Alert className="mt-2">{preview.errors.slice(0, 5).map((e: any) => `Row ${e.row}: ${e.error}`).join(" · ")}</Alert>}
            <TableWrap><table className="table mt-2 text-sm"><thead><tr><th>Date</th><th>Description</th><th className="num">Amount</th></tr></thead>
              <tbody>{preview.rows.slice(0, 10).map((r: any, i: number) => <tr key={i}><td>{r.txn_date}</td><td>{r.description}</td><td className={`num ${r.amount < 0 ? "text-red-600" : "text-emerald-600"}`}>{money(r.amount)}</td></tr>)}</tbody></table></TableWrap>
          </div>
        )}
      </div>
    </Modal>
  );
}

function MatchModal({ line, accountId, onClose }: { line: any; accountId: string; onClose: (changed: boolean) => void }) {
  const { path, money, settings } = useCompany();
  const { data, loading } = useApi<{ suggestions: any[] }>(path(`/banking/lines/${line.id}/suggestions`));
  const [counter, setCounter] = useState("");
  const [memo, setMemo] = useState(line.description);
  const { busy, error, run } = useAction();
  void accountId;
  return (
    <Modal open wide onClose={() => onClose(false)} title={`${line.amount > 0 ? "Deposit" : "Withdrawal"} of ${money(Math.abs(line.amount))} on ${fmtDate(line.txn_date, settings?.company.date_format)}`}>
      <div className="space-y-5">
        {error && <Alert>{error}</Alert>}
        <p className="text-sm">{line.description}{line.reference && <span className="muted"> · {line.reference}</span>}</p>
        <div>
          <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold"><Sparkles className="h-4 w-4 text-brand-600" />Suggested matches (rule-based)</h3>
          {loading ? <Spinner /> : data?.suggestions.length ? (
            <ul className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
              {data.suggestions.map((s) => (
                <li key={s.line_id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                  <div><p className="font-medium">{s.entry_number} · {s.memo ?? ""}</p><p className="text-xs muted">{fmtDate(s.entry_date, settings?.company.date_format)} · {s.contact_name ?? ""} · {s.reason}</p></div>
                  <Button size="sm" loading={busy} onClick={async () => { if (await run(() => api.post(path(`/banking/lines/${line.id}/match`), { journal_line_id: s.line_id }))) onClose(true); }}><Link2 className="h-4 w-4" />Match</Button>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm muted">No booked transaction with the same amount within ±10 days. Record a receipt/payment first, or post it directly below.</p>}
        </div>
        <div className="rounded-lg bg-[var(--surface-2)] p-3">
          <h3 className="mb-2 text-sm font-semibold">Or record it now</h3>
          <p className="mb-3 text-xs muted">Good for bank charges, interest and transfers. Customer receipts and supplier payments should be recorded from Receipts/Payments so invoices are settled.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Post against account">{(id) => <AccountSelect id={id} value={counter} onChange={setCounter} />}</Field>
            <Field label="Memo">{(id) => <Input id={id} value={memo} onChange={(e) => setMemo(e.target.value)} />}</Field>
          </div>
          <Button className="mt-3" size="sm" loading={busy} disabled={!counter} onClick={async () => { if (await run(() => api.post(path(`/banking/lines/${line.id}/create-entry`), { account_id: counter, memo }))) onClose(true); }}>Post & match</Button>
        </div>
      </div>
    </Modal>
  );
}

export default function Banking() {
  const { path, money, settings, can } = useCompany();
  const toast = useToast();
  const accounts = useApi<{ accounts: any[] }>(path("/banking/accounts"));
  const [accountId, setAccountId] = useState("");
  const acct = accountId || accounts.data?.accounts[0]?.id || "";
  const [tab, setTab] = useState<"lines" | "reconcile">("lines");
  const [status, setStatus] = useState("unmatched");
  const lines = useApi<{ lines: any[] }>(acct ? path(`/banking/lines?account_id=${acct}${status ? `&status=${status}` : ""}`) : null);
  const [importing, setImporting] = useState(false);
  const [matching, setMatching] = useState<any>(null);
  const [recDate, setRecDate] = useState(today());
  const [stmtBal, setStmtBal] = useState("");
  const rec = useApi<any>(acct && tab === "reconcile" ? path(`/banking/reconcile?account_id=${acct}&date=${recDate}`) : null);
  const { busy, error, run } = useAction();
  const df = settings?.company.date_format;
  const refresh = () => { accounts.reload(); lines.reload(); rec.reload(); };
  if (accounts.loading && !accounts.data) return <Spinner />;
  const current = accounts.data?.accounts.find((a) => a.id === acct);
  return (
    <>
      <PageHeader title="Banking" subtitle="Import statements, match them to your books and reconcile."
        actions={can("bank.reconcile") && acct && <Button onClick={() => setImporting(true)}><Upload className="h-4 w-4" />Import statement</Button>} />
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {accounts.data?.accounts.map((a) => (
          <button key={a.id} onClick={() => setAccountId(a.id)} className={`card p-4 text-left ${a.id === acct ? "ring-2 ring-brand-500" : ""}`}>
            <p className="text-sm font-medium">{a.name}</p>
            <p className="mt-1 text-lg font-semibold num !text-left">{money(a.book_balance)}</p>
            <p className="text-xs muted">{a.unmatched} unmatched · {a.last_reconciled ? `reconciled to ${fmtDate(a.last_reconciled, df)}` : "never reconciled"}</p>
          </button>
        ))}
      </div>
      {!acct ? <EmptyState title="No bank or cash accounts" body="Add a bank account in the chart of accounts (detail type: Bank)." /> : (
        <>
          <Tabs value={tab} onChange={setTab} tabs={[{ value: "lines", label: "Statement lines" }, { value: "reconcile", label: "Reconcile" }]} />
          {tab === "lines" ? (
            <Card padded={false}>
              <div className="border-b border-[var(--border)] p-3">
                <Select className="max-w-[12rem]" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status"><option value="unmatched">Unmatched</option><option value="matched">Matched</option><option value="ignored">Ignored</option><option value="">All</option></Select>
              </div>
              {lines.data && !lines.data.lines.length ? <EmptyState title={status === "unmatched" ? "Nothing to match" : "No statement lines"} body="Import a CSV statement to begin." /> : (
                <TableWrap><table className="table">
                  <thead><tr><th>Date</th><th>Description</th><th>Status</th><th className="num">Amount</th><th /></tr></thead>
                  <tbody>{lines.data?.lines.map((l) => (
                    <tr key={l.id}>
                      <td className="whitespace-nowrap">{fmtDate(l.txn_date, df)}</td>
                      <td>{l.description}{l.reference && <span className="block text-xs muted">{l.reference}</span>}{l.entry_number && <Link className="block text-xs text-brand-700 hover:underline dark:text-brand-300" to={`../journals/${l.entry_id}`} relative="path">↔ {l.entry_number}</Link>}</td>
                      <td><StatusBadge status={l.status} />{l.reconciliation_id && <span className="ml-1"><Badge color="violet">reconciled</Badge></span>}</td>
                      <td className={`num ${l.amount < 0 ? "text-red-600" : "text-emerald-700 dark:text-emerald-400"}`}>{money(l.amount)}</td>
                      <td className="whitespace-nowrap text-right">
                        {can("bank.reconcile") && !l.reconciliation_id && (l.status === "unmatched" ? <>
                          <Button size="sm" onClick={() => setMatching(l)}>Match</Button>
                          <Button size="sm" variant="ghost" onClick={async () => { try { await api.post(path(`/banking/lines/${l.id}/ignore`)); refresh(); } catch (e) { toast("error", errorMessage(e)); } }}>Ignore</Button>
                        </> : <Button size="sm" variant="ghost" onClick={async () => { try { await api.post(path(`/banking/lines/${l.id}/${l.status === "ignored" ? "restore" : "unmatch"}`)); refresh(); } catch (e) { toast("error", errorMessage(e)); } }}>{l.status === "ignored" ? "Restore" : "Unmatch"}</Button>)}
                      </td>
                    </tr>
                  ))}</tbody>
                </table></TableWrap>
              )}
            </Card>
          ) : (
            <div className="grid gap-4 lg:grid-cols-3">
              <Card title="Reconcile" className="lg:col-span-1">
                {error && <Alert className="mb-3">{error}</Alert>}
                <div className="space-y-3">
                  <Field label="Statement date">{(id) => <Input id={id} type="date" value={recDate} onChange={(e) => setRecDate(e.target.value)} />}</Field>
                  <Field label="Closing balance per bank statement">{(id) => <MoneyInput id={id} value={stmtBal} onChange={(e) => setStmtBal(e.target.value)} />}</Field>
                  {rec.data && <dl className="space-y-1 text-sm">
                    <div className="flex justify-between"><dt>Book balance</dt><dd className="num">{money(rec.data.book_balance)}</dd></div>
                    <div className="flex justify-between"><dt>Less: uncleared items</dt><dd className="num">{money(rec.data.uncleared_total)}</dd></div>
                    <div className="flex justify-between font-semibold"><dt>Cleared balance</dt><dd className="num">{money(rec.data.cleared_balance)}</dd></div>
                    <div className="flex justify-between"><dt>Unmatched statement lines</dt><dd>{rec.data.unmatched_statement.length}</dd></div>
                  </dl>}
                  <Button disabled={!stmtBal || !can("bank.reconcile")} loading={busy} onClick={async () => { if (await run(() => api.post(path("/banking/reconcile"), { account_id: acct, statement_date: recDate, statement_balance: stmtBal }))) { toast("success", "Reconciliation completed"); refresh(); } }}>Complete reconciliation</Button>
                  <p className="text-xs muted">Book entries dated before your first imported statement line ({rec.data?.start_date ? fmtDate(rec.data.start_date, df) : "—"}) are treated as already cleared.</p>
                </div>
              </Card>
              <Card title="Uncleared book entries" padded={false} className="lg:col-span-2">
                {rec.data?.uncleared.length ? <TableWrap><table className="table"><thead><tr><th>Date</th><th>Entry</th><th className="num">Amount</th></tr></thead>
                  <tbody>{rec.data.uncleared.map((u: any) => <tr key={u.line_id}><td>{fmtDate(u.entry_date, df)}</td><td>{u.entry_number} · {u.memo}</td><td className="num">{money(u.amount)}</td></tr>)}</tbody></table></TableWrap>
                  : <p className="p-4 text-sm muted">None.</p>}
              </Card>
              <Card title="Reconciliation history" padded={false} className="lg:col-span-3">
                {rec.data?.history.length ? <TableWrap><table className="table"><thead><tr><th>Statement date</th><th className="num">Statement balance</th><th className="num">Book balance</th><th>Completed</th></tr></thead>
                  <tbody>{rec.data.history.map((h: any) => <tr key={h.id}><td>{fmtDate(h.statement_date, df)}</td><td className="num">{money(h.statement_balance)}</td><td className="num">{money(h.book_balance)}</td><td className="text-sm">{h.completed_by_name} · {fmtDateTime(h.completed_at)}</td></tr>)}</tbody></table></TableWrap>
                  : <p className="p-4 text-sm muted">No completed reconciliations for {current?.name}.</p>}
              </Card>
            </div>
          )}
        </>
      )}
      {importing && <ImportWizard accountId={acct} onClose={(c) => { setImporting(false); if (c) refresh(); }} />}
      {matching && <MatchModal line={matching} accountId={acct} onClose={(c) => { setMatching(null); if (c) refresh(); }} />}
    </>
  );
}
