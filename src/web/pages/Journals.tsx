import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { Plus, Trash2, Printer } from "lucide-react";
import { useCompany } from "../lib/company";
import { useApi, useAction } from "../lib/hooks";
import { api } from "../lib/api";
import { Alert, Badge, Button, Card, ConfirmButton, EmptyState, Field, Input, LinkButton, MoneyInput, PageHeader, Pagination, Select, Spinner, StatusBadge, TableWrap, useToast } from "../components/ui";
import { AccountSelect, DimensionSelect, CURRENCY_OPTIONS } from "../components/pickers";
import { fmtDate, fmtDateTime, today, toInput } from "../lib/format";
import { parseDecimal, toDecimalString } from "@shared/money";
import { CURRENCIES } from "@shared/currencies";

export function JournalList() {
  const { path, money, id, settings, can } = useCompany();
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "";
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  const { data, loading, error } = useApi<{ entries: any[]; total: number }>(path(`/journals?limit=50&offset=${offset}&status=${status}&q=${encodeURIComponent(q)}`));
  return (
    <>
      <PageHeader title="Journals" subtitle="Every posting in the ledger, including those created by invoices, bills, payments and expenses."
        actions={can("txn.write") && <>
          <LinkButton variant="secondary" to={`/app/${id}/journals/opening`}>Opening balances</LinkButton>
          <LinkButton to={`/app/${id}/journals/new`}><Plus className="h-4 w-4" />New journal</LinkButton>
        </>} />
      <Card padded={false}>
        <div className="flex flex-wrap gap-3 border-b border-[var(--border)] p-3">
          <Input placeholder="Search number, memo, reference…" value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} className="max-w-xs" aria-label="Search journals" />
          <Select value={status} onChange={(e) => { setParams(e.target.value ? { status: e.target.value } : {}); setOffset(0); }} className="max-w-[10rem]" aria-label="Status">
            <option value="">All statuses</option><option value="draft">Drafts</option><option value="posted">Posted</option>
          </Select>
        </div>
        {error && <Alert className="m-3">{error}</Alert>}
        {loading && !data ? <Spinner /> : data && data.entries.length === 0 ? (
          <EmptyState title="No journal entries" body="Manual journals are for adjustments, accruals and corrections. Most entries are created automatically from documents." />
        ) : data && (
          <TableWrap>
            <table className="table">
              <thead><tr><th>Date</th><th>Number</th><th>Description</th><th>Type</th><th>Status</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {data.entries.map((e) => (
                  <tr key={e.id}>
                    <td className="whitespace-nowrap">{fmtDate(e.entry_date, settings?.company.date_format)}</td>
                    <td><Link className="font-medium text-brand-700 hover:underline dark:text-brand-300" to={`/app/${id}/journals/${e.id}`}>{e.entry_number ?? "Draft"}</Link></td>
                    <td className="max-w-md truncate">{e.memo}{e.reference && <span className="muted"> · {e.reference}</span>}</td>
                    <td><Badge color={e.kind === "reversal" ? "violet" : e.kind === "manual" ? "gray" : "blue"}>{e.kind}</Badge>{e.reversed_by_id && <span className="ml-1"><Badge color="red">reversed</Badge></span>}</td>
                    <td><StatusBadge status={e.status} /></td>
                    <td className="num">{money(e.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
        {data && <Pagination total={data.total} limit={50} offset={offset} onChange={setOffset} />}
      </Card>
    </>
  );
}

interface Line { key: number; account_id: string; debit: string; credit: string; description: string; currency: string; fx_rate: string; department_id: string; project_id: string; cost_centre_id: string; }
let k = 0;
const blank = (): Line => ({ key: ++k, account_id: "", debit: "", credit: "", description: "", currency: "", fx_rate: "", department_id: "", project_id: "", cost_centre_id: "" });

function safeMinor(v: string, exp: number) {
  try { return v.trim() ? parseDecimal(v, exp) : 0; } catch { return NaN; }
}

export function JournalForm() {
  const { path, id, settings } = useCompany();
  const { journalId } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const base = settings?.company.base_currency ?? "INR";
  const exp = CURRENCIES[base]?.exponent ?? 2;
  const [date, setDate] = useState(today());
  const [memo, setMemo] = useState("");
  const [reference, setReference] = useState("");
  const [kind, setKind] = useState("manual");
  const [lines, setLines] = useState<Line[]>([blank(), blank()]);
  const [showFx, setShowFx] = useState(false);
  const [showDims, setShowDims] = useState(false);
  const { busy, error, run } = useAction();
  const [idemKey] = useState(() => `ui-${crypto.randomUUID()}`); // one key per form: double submits cannot post twice
  const existing = useApi<any>(journalId ? path(`/journals/${journalId}`) : null);
  useEffect(() => {
    const d = existing.data;
    if (!d) return;
    setDate(d.entry.entry_date); setMemo(d.entry.memo ?? ""); setReference(d.entry.reference ?? ""); setKind(d.entry.kind);
    setLines(d.lines.map((l: any) => {
      const cur = l.currency ?? "";
      const e2 = CURRENCIES[cur || base]?.exponent ?? 2;
      const amt = cur ? l.amount_fc : null;
      return { ...blank(), account_id: l.account_id, description: l.description ?? "", currency: cur,
        fx_rate: cur ? toDecimalString(l.fx_rate_scaled, 9).replace(/\.?0+$/, "") : "",
        debit: l.debit ? toDecimalString(cur ? amt : l.debit, e2) : "", credit: l.credit ? toDecimalString(cur ? amt : l.credit, e2) : "",
        department_id: l.department_id ?? "", project_id: l.project_id ?? "", cost_centre_id: l.cost_centre_id ?? "" };
    }));
    if (d.lines.some((l: any) => l.currency)) setShowFx(true);
  }, [existing.data, base]);
  const totals = useMemo(() => {
    let dr = 0, cr = 0;
    for (const l of lines) {
      if (l.currency && l.currency !== base) continue; // converted server-side
      dr += safeMinor(l.debit, exp); cr += safeMinor(l.credit, exp);
    }
    return { dr, cr };
  }, [lines, base, exp]);
  const fxLines = lines.some((l) => l.currency && l.currency !== base);
  const update = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const submit = async (post: boolean) => {
    const body = {
      entry_date: date, memo: memo || null, reference: reference || null, kind,
      lines: lines.filter((l) => l.account_id && (l.debit || l.credit)).map((l) => ({
        account_id: l.account_id, debit: l.debit || null, credit: l.credit || null, description: l.description || null,
        currency: l.currency || null, fx_rate: l.fx_rate || null, department_id: l.department_id || null, project_id: l.project_id || null, cost_centre_id: l.cost_centre_id || null,
      })),
    };
    const r = await run(async () => {
      if (journalId) {
        await api.put(path(`/journals/${journalId}`), body);
        if (post) await api.post(path(`/journals/${journalId}/post`));
        return { id: journalId };
      }
      return api.post<{ id: string }>(path("/journals"), { ...body, post, idempotency_key: post ? idemKey : null });
    });
    if (r) { toast("success", post ? "Journal posted" : "Draft saved"); nav(`/app/${id}/journals/${r.id}`); }
  };
  if (journalId && existing.loading) return <Spinner />;
  const diff = totals.dr - totals.cr;
  return (
    <>
      <PageHeader title={journalId ? "Edit draft journal" : "New journal entry"} back={{ to: `/app/${id}/journals`, label: "Journals" }} />
      <Card>
        {error && <Alert className="mb-4">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-4">
          <Field label="Date" required>{(fid) => <Input id={fid} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
          <Field label="Type">{(fid) => <Select id={fid} value={kind} onChange={(e) => setKind(e.target.value)}><option value="manual">Manual</option><option value="adjustment">Adjustment</option></Select>}</Field>
          <Field label="Reference">{(fid) => <Input id={fid} value={reference} onChange={(e) => setReference(e.target.value)} />}</Field>
          <Field label="Memo">{(fid) => <Input id={fid} value={memo} onChange={(e) => setMemo(e.target.value)} />}</Field>
        </div>
        <div className="mt-3 flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" checked={showFx} onChange={(e) => setShowFx(e.target.checked)} /> Foreign currency lines</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={showDims} onChange={(e) => setShowDims(e.target.checked)} /> Departments / projects / cost centres</label>
        </div>
        <TableWrap>
          <table className="table mt-4 min-w-[720px]">
            <thead><tr><th className="w-[30%]">Account</th><th>Description</th>{showFx && <><th>Currency</th><th>Rate</th></>}<th className="num w-32">Debit</th><th className="num w-32">Credit</th><th /></tr></thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.key}>
                  <td>
                    <AccountSelect value={l.account_id} onChange={(v) => update(l.key, { account_id: v })} />
                    {showDims && <div className="mt-2 grid gap-2">
                      <DimensionSelect kind="departments" value={l.department_id} onChange={(v) => update(l.key, { department_id: v })} />
                      <DimensionSelect kind="projects" value={l.project_id} onChange={(v) => update(l.key, { project_id: v })} />
                      <DimensionSelect kind="cost_centres" value={l.cost_centre_id} onChange={(v) => update(l.key, { cost_centre_id: v })} />
                    </div>}
                  </td>
                  <td><Input value={l.description} onChange={(e) => update(l.key, { description: e.target.value })} aria-label="Line description" /></td>
                  {showFx && <>
                    <td><Select value={l.currency} onChange={(e) => update(l.key, { currency: e.target.value })} aria-label="Currency"><option value="">{base}</option>{CURRENCY_OPTIONS.filter((c) => c !== base).map((c) => <option key={c}>{c}</option>)}</Select></td>
                    <td><Input value={l.fx_rate} disabled={!l.currency} placeholder="rate" onChange={(e) => update(l.key, { fx_rate: e.target.value })} aria-label="Exchange rate" className="w-24" /></td>
                  </>}
                  <td><MoneyInput value={l.debit} onChange={(e) => update(l.key, { debit: e.target.value, credit: e.target.value ? "" : l.credit })} aria-label="Debit" /></td>
                  <td><MoneyInput value={l.credit} onChange={(e) => update(l.key, { credit: e.target.value, debit: e.target.value ? "" : l.debit })} aria-label="Credit" /></td>
                  <td><button className="rounded p-2 hover:bg-[var(--surface-2)] disabled:opacity-30" disabled={lines.length <= 2} onClick={() => setLines(lines.filter((x) => x.key !== l.key))} aria-label="Remove line"><Trash2 className="h-4 w-4" /></button></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={showFx ? 4 : 2}><Button variant="ghost" size="sm" onClick={() => setLines([...lines, blank()])}><Plus className="h-4 w-4" />Add line</Button></td>
                <td className="num">{Number.isNaN(totals.dr) ? "—" : toInput(totals.dr, base)}</td>
                <td className="num">{Number.isNaN(totals.cr) ? "—" : toInput(totals.cr, base)}</td><td />
              </tr>
            </tfoot>
          </table>
        </TableWrap>
        <div className="mt-3 text-sm">
          {fxLines ? <span className="muted">Foreign-currency lines are converted at the given rate on the server; balance is checked after conversion.</span>
            : Number.isNaN(diff) ? <span className="text-red-600">Check amounts — use digits with at most {exp} decimals.</span>
            : diff === 0 && totals.dr > 0 ? <span className="text-emerald-600">Balanced</span>
            : <span className="text-amber-600">Out of balance by {toInput(Math.abs(diff), base)}</span>}
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button variant="secondary" loading={busy} onClick={() => submit(false)}>Save draft</Button>
          <Button loading={busy} onClick={() => submit(true)} disabled={!fxLines && (diff !== 0 || totals.dr === 0)}>Post journal</Button>
        </div>
      </Card>
    </>
  );
}

export function JournalView() {
  const { path, money, id, settings, can } = useCompany();
  const { journalId } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { data, error, loading, reload } = useApi<any>(path(`/journals/${journalId}`));
  const [revDate, setRevDate] = useState(today());
  if (loading && !data) return <Spinner />;
  if (error) return <Alert>{error}</Alert>;
  const e = data.entry;
  const lines = data.lines as any[];
  const df = settings?.company.date_format;
  const sourceLink = e.source_type && e.source_id ? (["invoice", "credit_note", "bill", "debit_note"].includes(e.source_type)
    ? `/app/${id}/${["invoice", "credit_note"].includes(e.source_type) ? "sales" : "purchases"}/${e.source_type}/${e.source_id}`
    : ["receipt", "payment"].includes(e.source_type) ? `/app/${id}/payments/view/${e.source_id}` : e.source_type === "expense" ? `/app/${id}/expenses?open=${e.source_id}` : null) : null;
  return (
    <>
      <PageHeader title={e.entry_number ?? "Draft journal"} subtitle={e.memo} back={{ to: `/app/${id}/journals`, label: "Journals" }}
        actions={<>
          <Button variant="secondary" onClick={() => window.print()}><Printer className="h-4 w-4" />Print</Button>
          {e.status === "draft" && can("txn.write") && <LinkButton variant="secondary" to={`/app/${id}/journals/${e.id}/edit`}>Edit</LinkButton>}
          {e.status === "draft" && can("txn.post") && <Button onClick={async () => { try { await api.post(path(`/journals/${e.id}/post`)); toast("success", "Posted"); reload(); } catch (err) { toast("error", (err as Error).message); } }}>Post</Button>}
          {e.status === "draft" && can("txn.write") && <ConfirmButton label="Delete" title="Delete draft?" body="The draft will be removed. This only works for drafts." confirmLabel="Delete" onConfirm={async () => { await api.del(path(`/journals/${e.id}`)); nav(`/app/${id}/journals`); }} />}
          {e.status === "posted" && !e.reversed_by_id && e.kind !== "reversal" && !e.source_type && can("txn.reverse") && (
            <ConfirmButton label="Reverse" title="Reverse this entry?" variant="primary" confirmLabel="Post reversal" withReason
              body={<div className="space-y-3"><p>An equal and opposite entry will be posted and linked. The original stays in the ledger for audit.</p>
                <Field label="Reversal date">{(fid) => <Input id={fid} type="date" value={revDate} onChange={(ev) => setRevDate(ev.target.value)} />}</Field></div>}
              onConfirm={async (reason) => {
                try { const r = await api.post(path(`/journals/${e.id}/reverse`), { date: revDate, memo: reason ?? null }); toast("success", "Reversal posted"); nav(`/app/${id}/journals/${r.id}`); }
                catch (err) { toast("error", (err as Error).message); }
              }} />
          )}
        </>} />
      <Card className="print-area">
        <div className="grid gap-3 text-sm sm:grid-cols-4">
          <div><p className="muted">Date</p><p className="font-medium">{fmtDate(e.entry_date, df)}</p></div>
          <div><p className="muted">Status</p><StatusBadge status={e.status} /> <Badge color="blue">{e.kind}</Badge></div>
          <div><p className="muted">Created</p><p>{e.created_by_name} · {fmtDateTime(e.created_at)}</p></div>
          <div><p className="muted">Posted</p><p>{e.posted_at ? `${e.posted_by_name} · ${fmtDateTime(e.posted_at)}` : "—"}</p></div>
          {e.reference && <div><p className="muted">Reference</p><p>{e.reference}</p></div>}
          {e.reversal_of_id && <div><p className="muted">Reverses</p><Link className="text-brand-700 hover:underline dark:text-brand-300" to={`/app/${id}/journals/${e.reversal_of_id}`}>Original entry</Link></div>}
          {e.reversed_by_id && <div><p className="muted">Reversed by</p><Link className="text-brand-700 hover:underline dark:text-brand-300" to={`/app/${id}/journals/${e.reversed_by_id}`}>Reversal entry</Link></div>}
          {sourceLink && <div><p className="muted">Source</p><Link className="text-brand-700 hover:underline dark:text-brand-300" to={sourceLink}>{e.source_type.replace(/_/g, " ")}</Link></div>}
        </div>
        <TableWrap>
          <table className="table mt-5">
            <thead><tr><th>Account</th><th>Description</th><th>Contact / dimension</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id}>
                  <td><span className="font-mono text-xs muted">{l.account_code}</span> {l.account_name}</td>
                  <td>{l.description}{l.currency && <span className="block text-xs muted">{money(l.amount_fc, l.currency)} @ {toDecimalString(l.fx_rate_scaled, 9).replace(/\.?0+$/, "")}</span>}</td>
                  <td className="text-xs muted">{[l.contact_name, l.department_name, l.project_name, l.cost_centre_name].filter(Boolean).join(" · ")}</td>
                  <td className="num">{l.debit ? money(l.debit) : ""}</td>
                  <td className="num">{l.credit ? money(l.credit) : ""}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><td colSpan={3}>Total</td><td className="num">{money(lines.reduce((t, l) => t + l.debit, 0))}</td><td className="num">{money(lines.reduce((t, l) => t + l.credit, 0))}</td></tr></tfoot>
          </table>
        </TableWrap>
        {e.source_type && e.status === "posted" && !e.reversed_by_id && <p className="mt-4 text-xs muted no-print">This entry is managed by its source document. To correct it, void or credit the document.</p>}
      </Card>
    </>
  );
}

export function OpeningBalances() {
  const { path, id, accounts, settings } = useCompany();
  const nav = useNavigate();
  const toast = useToast();
  const base = settings?.company.base_currency ?? "INR";
  const exp = CURRENCIES[base]?.exponent ?? 2;
  const [date, setDate] = useState(() => `${today().slice(0, 4)}-${String(settings?.company.fiscal_year_start_month ?? 4).padStart(2, "0")}-01`);
  const [vals, setVals] = useState<Record<string, { debit: string; credit: string }>>({});
  const { busy, error, run } = useAction();
  const postable = accounts.filter((a) => !a.is_group && a.is_active && ["asset", "liability", "equity"].includes(a.type) && a.system_key !== "OPENING_EQUITY");
  const sums = useMemo(() => Object.values(vals).reduce((t, v) => ({ dr: t.dr + safeMinor(v.debit, exp), cr: t.cr + safeMinor(v.credit, exp) }), { dr: 0, cr: 0 }), [vals, exp]);
  return (
    <>
      <PageHeader title="Opening balances" subtitle="Enter balances as at the day before you start using the system. Any difference goes to Opening Balance Equity." back={{ to: `/app/${id}/journals`, label: "Journals" }} />
      <Alert kind="info" className="mb-4">For customer and supplier balances, enter outstanding invoices and bills individually instead so ageing and statements work. Stock is entered from Inventory → Adjust (opening).</Alert>
      <Card>
        {error && <Alert className="mb-4">{error}</Alert>}
        <Field label="Opening date" className="max-w-xs">{(fid) => <Input id={fid} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
        <TableWrap>
          <table className="table mt-4">
            <thead><tr><th>Account</th><th className="num w-40">Debit</th><th className="num w-40">Credit</th></tr></thead>
            <tbody>
              {postable.map((a) => (
                <tr key={a.id}>
                  <td><span className="font-mono text-xs muted">{a.code}</span> {a.name}</td>
                  <td><MoneyInput aria-label={`${a.name} debit`} value={vals[a.id]?.debit ?? ""} onChange={(e) => setVals({ ...vals, [a.id]: { debit: e.target.value, credit: "" } })} /></td>
                  <td><MoneyInput aria-label={`${a.name} credit`} value={vals[a.id]?.credit ?? ""} onChange={(e) => setVals({ ...vals, [a.id]: { credit: e.target.value, debit: "" } })} /></td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><td>Totals (difference {Number.isNaN(sums.dr - sums.cr) ? "—" : toInput(Math.abs(sums.dr - sums.cr), base)} → Opening Balance Equity)</td><td className="num">{toInput(sums.dr, base)}</td><td className="num">{toInput(sums.cr, base)}</td></tr></tfoot>
          </table>
        </TableWrap>
        <Button className="mt-4" loading={busy} onClick={async () => {
          const lines = Object.entries(vals).filter(([, v]) => v.debit || v.credit).map(([account_id, v]) => ({ account_id, debit: v.debit || null, credit: v.credit || null }));
          const r = await run(() => api.post<{ id: string }>(path("/journals/opening-balances"), { date, lines }));
          if (r) { toast("success", "Opening balances posted"); nav(`/app/${id}/journals/${r.id}`); }
        }}>Post opening balances</Button>
      </Card>
    </>
  );
}
