import { Fragment, useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { Download, Printer, CheckCircle2, AlertTriangle } from "lucide-react";
import { useCompany } from "../lib/company";
import { useApi } from "../lib/hooks";
import { Alert, Button, Card, EmptyState, Field, Input, PageHeader, Select, Spinner, TableWrap } from "../components/ui";
import { AccountSelect, DimensionSelect } from "../components/pickers";
import { downloadCsv } from "../lib/csv";
import { DOC_LABELS, fmtDate, fyStart, qty, today, toInput } from "../lib/format";
import { api } from "../lib/api";
import { CURRENCIES } from "@shared/currencies";
import { allocateProportionally, parseDecimal, toDecimalString } from "@shared/money";

const REPORTS = [
  { key: "profit-loss", title: "Profit & loss", group: "Financial statements", desc: "Income, cost of sales, expenses and net profit with comparison to the previous period." },
  { key: "balance-sheet", title: "Balance sheet", group: "Financial statements", desc: "Assets, liabilities and equity at a date, with computed retained earnings." },
  { key: "cash-flow", title: "Cash flow statement", group: "Financial statements", desc: "Indirect method; reconciles to the change in cash & bank balances." },
  { key: "trial-balance", title: "Trial balance", group: "Financial statements", desc: "Opening, movement and closing balance for every account." },
  { key: "general-ledger", title: "General ledger", group: "Ledgers", desc: "Every posting to an account with running balance." },
  { key: "aging-receivable", title: "Aged receivables", group: "Customers & suppliers", desc: "Outstanding invoices by days overdue, reconciled to the AR account." },
  { key: "aging-payable", title: "Aged payables", group: "Customers & suppliers", desc: "Outstanding bills by days overdue, reconciled to the AP account." },
  { key: "sales-by-customer", title: "Sales by customer", group: "Customers & suppliers", desc: "Invoiced amounts less credit notes, in base currency." },
  { key: "purchases-by-supplier", title: "Purchases by supplier", group: "Customers & suppliers", desc: "Billed amounts less debit notes, in base currency." },
  { key: "expenses", title: "Expense report", group: "Operations", desc: "Expenses by category from the ledger, plus claim status." },
  { key: "inventory-valuation", title: "Inventory valuation", group: "Operations", desc: "Stock quantity and value per item, reconciled to the ledger." },
  { key: "gst-summary", title: "Tax / GST summary", group: "Tax", desc: "Output and input tax by rate, and net payable from the ledger." },
  { key: "budgets", title: "Budget vs actual", group: "Planning", desc: "Compare budgets with posted results." },
];

export function ReportIndex() {
  const { id } = useCompany();
  const groups = [...new Set(REPORTS.map((r) => r.group))];
  return (
    <>
      <PageHeader title="Reports" subtitle="All figures are calculated from posted ledger entries at the time you open the report." />
      <div className="space-y-6">
        {groups.map((g) => (
          <section key={g}>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide muted">{g}</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {REPORTS.filter((r) => r.group === g).map((r) => (
                <Link key={r.key} to={`/app/${id}/reports/${r.key}`} className="card p-4 transition-colors hover:border-brand-500">
                  <p className="font-medium">{r.title}</p><p className="mt-1 text-sm muted">{r.desc}</p>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}

function useRange(kind: "range" | "asof" = "range") {
  const { settings } = useCompany();
  const [params, setParams] = useSearchParams();
  const from = params.get("from") ?? fyStart(settings?.company.fiscal_year_start_month ?? 4);
  const to = params.get("to") ?? today();
  const asOf = params.get("as_of") ?? today();
  const set = (k: string, v: string) => { const n = new URLSearchParams(params); n.set(k, v); setParams(n, { replace: true }); };
  const controls = kind === "range" ? (
    <>
      <Field label="From">{(id) => <Input id={id} type="date" value={from} onChange={(e) => set("from", e.target.value)} />}</Field>
      <Field label="To">{(id) => <Input id={id} type="date" value={to} onChange={(e) => set("to", e.target.value)} />}</Field>
    </>
  ) : <Field label="As of">{(id) => <Input id={id} type="date" value={asOf} onChange={(e) => set("as_of", e.target.value)} />}</Field>;
  return { from, to, asOf, controls, params, set };
}

function Shell({ title, controls, onCsv, children, subtitle }: { title: string; controls?: ReactNode; onCsv?: () => void; children: ReactNode; subtitle?: ReactNode }) {
  const { settings, id } = useCompany();
  return (
    <>
      <PageHeader title={title} back={{ to: `/app/${id}/reports`, label: "Reports" }}
        actions={<>
          {onCsv && <Button variant="secondary" onClick={onCsv}><Download className="h-4 w-4" />CSV</Button>}
          <Button variant="secondary" onClick={() => window.print()}><Printer className="h-4 w-4" />Print / PDF</Button>
        </>} />
      {controls && <div className="mb-4 flex flex-wrap items-end gap-3 no-print">{controls}</div>}
      <Card className="print-area">
        <div className="mb-4 hidden print:block">
          <p className="text-lg font-semibold">{settings?.company.legal_name || settings?.company.name}</p>
          <p className="font-medium">{title}</p>
          {subtitle && <p className="text-sm">{subtitle}</p>}
        </div>
        {subtitle && <p className="mb-3 text-sm muted no-print">{subtitle}</p>}
        {children}
      </Card>
    </>
  );
}

function Check({ ok, okText, badText }: { ok: boolean; okText: string; badText: string }) {
  return ok
    ? <p className="mt-4 flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="h-4 w-4" />{okText}</p>
    : <p className="mt-4 flex items-center gap-2 text-sm text-red-600"><AlertTriangle className="h-4 w-4" />{badText}</p>;
}

function Loading({ r }: { r: { loading: boolean; error: string | null; data: unknown } }) {
  if (r.error) return <Alert>{r.error}</Alert>;
  if (r.loading && !r.data) return <Spinner />;
  return null;
}

export function TrialBalance() {
  const { path, money, settings } = useCompany();
  const { from, to, controls } = useRange();
  const r = useApi<any>(path(`/reports/trial-balance?from=${from}&to=${to}`));
  const cur = settings?.company.base_currency ?? "INR";
  const d = r.data;
  return (
    <Shell title="Trial balance" controls={controls} subtitle={`${fmtDate(from)} to ${fmtDate(to)}`}
      onCsv={d ? () => downloadCsv(`trial-balance-${from}-${to}.csv`, ["Code", "Account", "Opening", "Debit", "Credit", "Closing debit", "Closing credit"], d.rows.map((x: any) => [x.code, x.name, toInput(x.opening, cur), toInput(x.debit, cur), toInput(x.credit, cur), toInput(x.closing_debit, cur), toInput(x.closing_credit, cur)])) : undefined}>
      <Loading r={r} />
      {d && (d.rows.length ? <>
        <TableWrap><table className="table">
          <thead><tr><th>Code</th><th>Account</th><th className="num">Opening</th><th className="num">Debit</th><th className="num">Credit</th><th className="num">Closing Dr</th><th className="num">Closing Cr</th></tr></thead>
          <tbody>{d.rows.map((x: any) => <tr key={x.id}><td className="font-mono text-xs">{x.code}</td><td>{x.name}</td><td className="num">{money(x.opening)}</td><td className="num">{money(x.debit)}</td><td className="num">{money(x.credit)}</td><td className="num">{x.closing_debit ? money(x.closing_debit) : ""}</td><td className="num">{x.closing_credit ? money(x.closing_credit) : ""}</td></tr>)}</tbody>
          <tfoot><tr><td colSpan={3}>Total</td><td className="num">{money(d.totals.debit)}</td><td className="num">{money(d.totals.credit)}</td><td className="num">{money(d.totals.closing_debit)}</td><td className="num">{money(d.totals.closing_credit)}</td></tr></tfoot>
        </table></TableWrap>
        <Check ok={d.balanced} okText="Debits equal credits." badText="Trial balance does not balance — please report this." />
      </> : <EmptyState title="No posted entries in this period" />)}
    </Shell>
  );
}

export function ProfitLoss() {
  const { path, money, settings } = useCompany();
  const { from, to, controls, params, set } = useRange();
  const dims = ["department_id", "project_id", "cost_centre_id", "branch_id"].map((k) => params.get(k) ? `&${k}=${params.get(k)}` : "").join("");
  const r = useApi<any>(path(`/reports/profit-loss?from=${from}&to=${to}${dims}`));
  const cur = settings?.company.base_currency ?? "INR";
  const d = r.data;
  const Row = ({ label, value, strong }: { label: string; value: number; strong?: boolean }) => <tr className={strong ? "font-semibold" : ""}><td>{label}</td><td className="num">{money(value)}</td></tr>;
  return (
    <Shell title="Profit & loss" subtitle={`${fmtDate(from)} to ${fmtDate(to)}`}
      controls={<>{controls}
        <DimensionSelect kind="departments" value={params.get("department_id")} onChange={(v) => set("department_id", v)} />
        <DimensionSelect kind="projects" value={params.get("project_id")} onChange={(v) => set("project_id", v)} />
        <DimensionSelect kind="cost_centres" value={params.get("cost_centre_id")} onChange={(v) => set("cost_centre_id", v)} />
      </>}
      onCsv={d ? () => downloadCsv(`profit-loss-${from}-${to}.csv`, ["Section", "Code", "Account", "Amount"], [...d.sections.flatMap((s: any) => s.lines.map((l: any) => [s.label, l.code, l.name, toInput(l.amount, cur)])), ["", "", "Net profit", toInput(d.net_profit, cur)]]) : undefined}>
      <Loading r={r} />
      {d && <>
        {d.explanation?.length > 0 && (
          <div className="mb-5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-4 text-sm no-print">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide muted">Summary (generated from the figures below — no AI)</p>
            {d.explanation.map((s: string, i: number) => <p key={i}>{s}</p>)}
          </div>
        )}
        <TableWrap><table className="table max-w-3xl">
          <tbody>
            {d.sections.map((s: any) => (
              <Fragment key={s.key}>
                <tr><td colSpan={2} className="bg-[var(--surface-2)] font-semibold">{s.label}</td></tr>
                {s.lines.map((l: any) => <tr key={l.id}><td className="pl-6"><span className="font-mono text-xs muted">{l.code}</span> {l.name}</td><td className="num">{money(l.amount)}</td></tr>)}
                <tr className="font-medium"><td>Total {s.label.toLowerCase()}</td><td className="num">{money(s.total)}</td></tr>
                {s.key === "cogs" && <Row label="Gross profit" value={d.gross_profit} strong />}
                {s.key === "operating_expense" && <Row label="Operating profit" value={d.operating_profit} strong />}
              </Fragment>
            ))}
          </tbody>
          <tfoot><tr><td>Net {d.net_profit >= 0 ? "profit" : "loss"}</td><td className={`num ${d.net_profit < 0 ? "text-red-600" : ""}`}>{money(d.net_profit)}</td></tr>
            <tr><td className="muted !font-normal">Previous period ({fmtDate(d.previous.from)} – {fmtDate(d.previous.to)})</td><td className="num muted !font-normal">{money(d.previous.net_profit)}</td></tr></tfoot>
        </table></TableWrap>
      </>}
    </Shell>
  );
}

export function BalanceSheet() {
  const { path, money, settings } = useCompany();
  const { asOf, controls } = useRange("asof");
  const r = useApi<any>(path(`/reports/balance-sheet?as_of=${asOf}`));
  const d = r.data;
  const cur = settings?.company.base_currency ?? "INR";
  const Section = ({ title, s }: { title: string; s: any }) => (
    <>
      <tr><td colSpan={2} className="bg-[var(--surface-2)] font-semibold">{title}</td></tr>
      {s.lines.map((l: any) => <tr key={l.id}><td className="pl-6"><span className="font-mono text-xs muted">{l.code}</span> {l.name}</td><td className="num">{money(l.amount)}</td></tr>)}
      <tr className="font-semibold"><td>Total {title.toLowerCase()}</td><td className="num">{money(s.total)}</td></tr>
    </>
  );
  return (
    <Shell title="Balance sheet" controls={controls} subtitle={`As of ${fmtDate(asOf)}`}
      onCsv={d ? () => downloadCsv(`balance-sheet-${asOf}.csv`, ["Section", "Code", "Account", "Amount"], [...["assets", "liabilities", "equity"].flatMap((k) => d[k].lines.map((l: any) => [k, l.code, l.name, toInput(l.amount, cur)]))]) : undefined}>
      <Loading r={r} />
      {d && <>
        <TableWrap><table className="table max-w-3xl"><tbody>
          <Section title="Assets" s={d.assets} />
          <Section title="Liabilities" s={d.liabilities} />
          <Section title="Equity" s={d.equity} />
        </tbody><tfoot><tr><td>Total liabilities & equity</td><td className="num">{money(d.total_liabilities_and_equity)}</td></tr></tfoot></table></TableWrap>
        <div className="mt-3 grid max-w-3xl gap-2 text-sm sm:grid-cols-2">
          <p className="muted">Current assets: {money(d.current_assets)} · Current liabilities: {money(d.current_liabilities)}{d.current_liabilities > 0 && ` · Current ratio ${(d.current_assets / d.current_liabilities).toFixed(2)}`}</p>
        </div>
        <Check ok={d.balanced} okText="Assets = Liabilities + Equity." badText={`Out of balance by ${money(d.difference)} — please report this.`} />
      </>}
    </Shell>
  );
}

export function CashFlow() {
  const { path, money, settings } = useCompany();
  const { from, to, controls } = useRange();
  const r = useApi<any>(path(`/reports/cash-flow?from=${from}&to=${to}`));
  const d = r.data;
  const cur = settings?.company.base_currency ?? "INR";
  return (
    <Shell title="Cash flow statement" controls={controls} subtitle={`${fmtDate(from)} to ${fmtDate(to)} · indirect method`}
      onCsv={d ? () => downloadCsv(`cash-flow-${from}-${to}.csv`, ["Section", "Item", "Amount"], [["Operating", "Net profit", toInput(d.net_profit, cur)], ...d.operating.adjustments.map((l: any) => ["Operating", l.name, toInput(l.amount, cur)]), ...d.investing.lines.map((l: any) => ["Investing", l.name, toInput(l.amount, cur)]), ...d.financing.lines.map((l: any) => ["Financing", l.name, toInput(l.amount, cur)]), ["", "Net change in cash", toInput(d.net_change, cur)]]) : undefined}>
      <Loading r={r} />
      {d && <>
        <TableWrap><table className="table max-w-3xl"><tbody>
          <tr><td colSpan={2} className="bg-[var(--surface-2)] font-semibold">Operating activities</td></tr>
          <tr><td className="pl-6">Net profit</td><td className="num">{money(d.net_profit)}</td></tr>
          {d.operating.adjustments.map((l: any, i: number) => <tr key={i}><td className="pl-6">{l.name}</td><td className="num">{money(l.amount)}</td></tr>)}
          <tr className="font-semibold"><td>Net cash from operating activities</td><td className="num">{money(d.operating.total)}</td></tr>
          <tr><td colSpan={2} className="bg-[var(--surface-2)] font-semibold">Investing activities</td></tr>
          {d.investing.lines.map((l: any, i: number) => <tr key={i}><td className="pl-6">{l.name}</td><td className="num">{money(l.amount)}</td></tr>)}
          <tr className="font-semibold"><td>Net cash from investing activities</td><td className="num">{money(d.investing.total)}</td></tr>
          <tr><td colSpan={2} className="bg-[var(--surface-2)] font-semibold">Financing activities</td></tr>
          {d.financing.lines.map((l: any, i: number) => <tr key={i}><td className="pl-6">{l.name}</td><td className="num">{money(l.amount)}</td></tr>)}
          <tr className="font-semibold"><td>Net cash from financing activities</td><td className="num">{money(d.financing.total)}</td></tr>
        </tbody><tfoot>
          <tr><td>Net change in cash</td><td className="num">{money(d.net_change)}</td></tr>
          <tr><td className="!font-normal">Opening cash & bank</td><td className="num !font-normal">{money(d.opening_cash)}</td></tr>
          <tr><td>Closing cash & bank</td><td className="num">{money(d.closing_cash)}</td></tr>
        </tfoot></table></TableWrap>
        <Check ok={d.reconciles} okText="Reconciles to the movement in cash and bank accounts." badText="Does not reconcile to cash movement — please report this." />
      </>}
    </Shell>
  );
}

export function GeneralLedger() {
  const { path, money, id, settings } = useCompany();
  const { from, to, controls, params, set } = useRange();
  const accountId = params.get("account_id") ?? "";
  const r = useApi<any>(accountId ? path(`/reports/general-ledger?account_id=${accountId}&from=${from}&to=${to}`) : null);
  const d = r.data;
  const cur = settings?.company.base_currency ?? "INR";
  return (
    <Shell title={d ? `Ledger: ${d.account.code} ${d.account.name}` : "General ledger"} subtitle={`${fmtDate(from)} to ${fmtDate(to)}`}
      controls={<><div className="min-w-[16rem]"><Field label="Account">{(fid) => <AccountSelect id={fid} value={accountId} onChange={(v) => set("account_id", v)} />}</Field></div>{controls}</>}
      onCsv={d ? () => downloadCsv(`ledger-${d.account.code}-${from}-${to}.csv`, ["Date", "Entry", "Memo", "Contact", "Debit", "Credit", "Balance"], [["", "", "Opening balance", "", "", "", toInput(d.opening, cur)], ...d.lines.map((l: any) => [l.entry_date, l.entry_number, l.description ?? l.memo, l.contact_name, toInput(l.debit, cur), toInput(l.credit, cur), toInput(l.balance, cur)])]) : undefined}>
      {!accountId ? <EmptyState title="Choose an account" /> : <>
        <Loading r={r} />
        {d && <TableWrap><table className="table">
          <thead><tr><th>Date</th><th>Entry</th><th>Description</th><th className="num">Debit</th><th className="num">Credit</th><th className="num">Balance</th></tr></thead>
          <tbody>
            <tr className="font-medium"><td colSpan={5}>Opening balance</td><td className="num">{money(d.opening)}</td></tr>
            {d.lines.map((l: any, i: number) => (
              <tr key={i}><td className="whitespace-nowrap">{fmtDate(l.entry_date, settings?.company.date_format)}</td>
                <td><Link className="text-brand-700 hover:underline dark:text-brand-300" to={`/app/${id}/journals/${l.entry_id}`}>{l.entry_number}</Link></td>
                <td>{l.description ?? l.memo}{l.contact_name && <span className="block text-xs muted">{l.contact_name}</span>}</td>
                <td className="num">{l.debit ? money(l.debit) : ""}</td><td className="num">{l.credit ? money(l.credit) : ""}</td><td className="num">{money(l.balance)}</td></tr>
            ))}
          </tbody>
          <tfoot><tr><td colSpan={3}>Closing balance</td><td className="num">{money(d.total_debit)}</td><td className="num">{money(d.total_credit)}</td><td className="num">{money(d.closing)}</td></tr></tfoot>
        </table></TableWrap>}
        {d?.truncated && <Alert kind="warning" className="mt-3">Showing the first 5,000 lines. Narrow the date range.</Alert>}
      </>}
    </Shell>
  );
}

export function Aging({ kind }: { kind: "receivable" | "payable" }) {
  const { path, money, id, settings } = useCompany();
  const { asOf, controls } = useRange("asof");
  const r = useApi<any>(path(`/reports/aging/${kind}?as_of=${asOf}`));
  const d = r.data;
  const cur = settings?.company.base_currency ?? "INR";
  const B = ["current", "1_30", "31_60", "61_90", "over_90"];
  const L: Record<string, string> = { current: "Current", "1_30": "1–30", "31_60": "31–60", "61_90": "61–90", over_90: "90+" };
  return (
    <Shell title={kind === "receivable" ? "Aged receivables" : "Aged payables"} controls={controls} subtitle={`As of ${fmtDate(asOf)} · days past due · base currency`}
      onCsv={d ? () => downloadCsv(`aged-${kind}-${asOf}.csv`, ["Contact", ...B.map((b) => L[b]), "Total"], d.summary.map((s: any) => [s.contact_name, ...B.map((b) => toInput(s[b], cur)), toInput(s.total, cur)])) : undefined}>
      <Loading r={r} />
      {d && (d.summary.length ? <>
        <TableWrap><table className="table">
          <thead><tr><th>{kind === "receivable" ? "Customer" : "Supplier"}</th>{B.map((b) => <th key={b} className="num">{L[b]}</th>)}<th className="num">Total</th></tr></thead>
          <tbody>{d.summary.map((s: any) => <tr key={s.contact_id}><td><Link className="hover:underline" to={`/app/${id}/reports/statement/${s.contact_id}`}>{s.contact_name}</Link></td>{B.map((b) => <td key={b} className="num">{s[b] ? money(s[b]) : ""}</td>)}<td className="num font-medium">{money(s.total)}</td></tr>)}</tbody>
          <tfoot><tr><td>Total</td>{B.map((b) => <td key={b} className="num">{money(d.totals[b])}</td>)}<td className="num">{money(d.totals.total)}</td></tr></tfoot>
        </table></TableWrap>
        <h3 className="mt-6 text-sm font-semibold">Open documents</h3>
        <TableWrap><table className="table mt-2 text-sm">
          <thead><tr><th>Contact</th><th>Number</th><th>Date</th><th>Due</th><th className="num">Days overdue</th><th className="num">Outstanding</th></tr></thead>
          <tbody>{d.documents.map((x: any) => <tr key={x.id}><td>{x.contact_name}</td><td><Link className="text-brand-700 hover:underline dark:text-brand-300" to={`/app/${id}/${kind === "receivable" ? "sales/invoice" : "purchases/bill"}/${x.id}`}>{x.number}</Link></td><td>{fmtDate(x.issue_date)}</td><td>{fmtDate(x.due_date)}</td><td className="num">{x.days_overdue}</td><td className="num">{money(x.outstanding, x.currency)}</td></tr>)}</tbody>
        </table></TableWrap>
      </> : <EmptyState title="Nothing outstanding" />)}
      {d && <Check ok={d.unreconciled_difference === 0} okText={`Matches the ${kind === "receivable" ? "Accounts Receivable" : "Accounts Payable"} ledger balance (${money(d.ledger_balance)}).`}
        badText={`Differs from the control account (${money(d.ledger_balance)}) by ${money(d.unreconciled_difference)} — usually unapplied advances or manual journals to the control account.`} />}
    </Shell>
  );
}

export function Statement() {
  const { contactId } = useParams();
  const { path, money, settings, id } = useCompany();
  const { from, to, controls } = useRange();
  const r = useApi<any>(path(`/reports/statement/${contactId}?from=${from}&to=${to}`));
  const d = r.data;
  const cur = settings?.company.base_currency ?? "INR";
  const co = settings?.company;
  return (
    <Shell title={d ? `Statement — ${d.contact.name}` : "Statement"} controls={controls} subtitle={`${fmtDate(from)} to ${fmtDate(to)} · ${cur}`}
      onCsv={d ? () => downloadCsv(`statement-${d.contact.name}-${from}-${to}.csv`, ["Date", "Reference", "Description", "Debit", "Credit", "Balance"], [["", "", "Opening balance", "", "", toInput(d.opening, cur)], ...d.lines.map((l: any) => [l.entry_date, l.reference, l.memo, toInput(l.debit, cur), toInput(l.credit, cur), toInput(l.balance, cur)])]) : undefined}>
      <Loading r={r} />
      {d && <>
        <div className="mb-4 grid gap-4 text-sm sm:grid-cols-2">
          <div><p className="font-semibold">{co?.legal_name || co?.name}</p><p className="whitespace-pre-line muted">{co?.address}</p></div>
          <div className="sm:text-right"><p className="font-semibold">{d.contact.name}</p><p className="whitespace-pre-line muted">{d.contact.billing_address}</p></div>
        </div>
        <TableWrap><table className="table">
          <thead><tr><th>Date</th><th>Reference</th><th>Description</th><th className="num">Debit</th><th className="num">Credit</th><th className="num">Balance</th></tr></thead>
          <tbody>
            <tr className="font-medium"><td colSpan={5}>Opening balance</td><td className="num">{money(d.opening)}</td></tr>
            {d.lines.map((l: any, i: number) => (
              <tr key={i}><td>{fmtDate(l.entry_date, co?.date_format)}</td>
                <td>{l.source_id && DOC_LABELS[l.source_type] ? <Link className="text-brand-700 hover:underline dark:text-brand-300" to={`/app/${id}/${["invoice", "credit_note"].includes(l.source_type) ? "sales" : "purchases"}/${l.source_type}/${l.source_id}`}>{l.reference}</Link> : l.reference}</td>
                <td>{l.memo}</td><td className="num">{l.debit ? money(l.debit) : ""}</td><td className="num">{l.credit ? money(l.credit) : ""}</td><td className="num">{money(l.balance)}</td></tr>
            ))}
          </tbody>
          <tfoot><tr><td colSpan={5}>Closing balance</td><td className="num">{money(d.closing)}</td></tr></tfoot>
        </table></TableWrap>
        <p className="mt-3 text-xs muted">{d.note}</p>
      </>}
    </Shell>
  );
}

export function SimpleTotals({ kind }: { kind: "sales-by-customer" | "purchases-by-supplier" }) {
  const { path, money, settings } = useCompany();
  const { from, to, controls } = useRange();
  const r = useApi<any>(path(`/reports/${kind}?from=${from}&to=${to}`));
  const cur = settings?.company.base_currency ?? "INR";
  const sales = kind === "sales-by-customer";
  return (
    <Shell title={sales ? "Sales by customer" : "Purchases by supplier"} controls={controls} subtitle={`${fmtDate(from)} to ${fmtDate(to)} · including tax, net of notes, base currency`}
      onCsv={r.data ? () => downloadCsv(`${kind}-${from}-${to}.csv`, ["Contact", sales ? "Invoices" : "Bills", "Total"], r.data.rows.map((x: any) => [x.name, x.invoices ?? x.bills, toInput(x.gross_base, cur)])) : undefined}>
      <Loading r={r} />
      {r.data && (r.data.rows.length ? <TableWrap><table className="table">
        <thead><tr><th>{sales ? "Customer" : "Supplier"}</th><th className="num">{sales ? "Invoices" : "Bills"}</th><th className="num">Total</th></tr></thead>
        <tbody>{r.data.rows.map((x: any) => <tr key={x.id}><td>{x.name}</td><td className="num">{x.invoices ?? x.bills}</td><td className="num">{money(x.gross_base)}</td></tr>)}</tbody>
        <tfoot><tr><td colSpan={2}>Total</td><td className="num">{money(r.data.rows.reduce((t: number, x: any) => t + x.gross_base, 0))}</td></tr></tfoot>
      </table></TableWrap> : <EmptyState title="No posted documents in this period" />)}
    </Shell>
  );
}

export function ExpenseReport() {
  const { path, money, settings } = useCompany();
  const { from, to, controls } = useRange();
  const r = useApi<any>(path(`/reports/expenses?from=${from}&to=${to}`));
  const cur = settings?.company.base_currency ?? "INR";
  const d = r.data;
  return (
    <Shell title="Expense report" controls={controls} subtitle={`${fmtDate(from)} to ${fmtDate(to)}`}
      onCsv={d ? () => downloadCsv(`expenses-${from}-${to}.csv`, ["Code", "Category", "Amount"], d.by_category.map((x: any) => [x.code, x.name, toInput(x.amount, cur)])) : undefined}>
      <Loading r={r} />
      {d && <>
        <TableWrap><table className="table max-w-3xl">
          <thead><tr><th>Category</th><th className="num">Entries</th><th className="num">Amount</th><th className="num">Share</th></tr></thead>
          <tbody>{d.by_category.map((x: any) => { const total = d.by_category.reduce((t: number, y: any) => t + y.amount, 0); return <tr key={x.id}><td><span className="font-mono text-xs muted">{x.code}</span> {x.name}</td><td className="num">{x.entries}</td><td className="num">{money(x.amount)}</td><td className="num">{total ? ((x.amount * 100) / total).toFixed(1) : 0}%</td></tr>; })}</tbody>
          <tfoot><tr><td colSpan={2}>Total</td><td className="num">{money(d.by_category.reduce((t: number, y: any) => t + y.amount, 0))}</td><td /></tr></tfoot>
        </table></TableWrap>
        {d.claims.length > 0 && <p className="mt-4 text-sm muted">Expense claims in period: {d.claims.map((c: any) => `${c.status} ${c.n}`).join(" · ")}</p>}
      </>}
    </Shell>
  );
}

export function InventoryValuation() {
  const { path, money, settings } = useCompany();
  const { asOf, controls } = useRange("asof");
  const r = useApi<any>(path(`/reports/inventory-valuation?as_of=${asOf}`));
  const d = r.data;
  const cur = settings?.company.base_currency ?? "INR";
  return (
    <Shell title="Inventory valuation" controls={controls} subtitle={d ? `As of ${fmtDate(asOf)} · ${d.method}` : undefined}
      onCsv={d ? () => downloadCsv(`inventory-${asOf}.csv`, ["Item", "SKU", "Quantity", "Unit", "Average cost", "Value"], d.items.map((x: any) => [x.name, x.sku, qty(x.qty_milli), x.unit, toInput(x.avg_cost, cur), toInput(x.value, cur)])) : undefined}>
      <Loading r={r} />
      {d && (d.items.length ? <>
        <TableWrap><table className="table">
          <thead><tr><th>Item</th><th>SKU</th><th className="num">Quantity</th><th className="num">Avg cost</th><th className="num">Value</th></tr></thead>
          <tbody>{d.items.map((x: any) => <tr key={x.item_id}><td>{x.name}{x.below_reorder && <span className="ml-2 text-xs text-amber-600">reorder</span>}</td><td className="font-mono text-xs">{x.sku}</td><td className="num">{qty(x.qty_milli)} {x.unit}</td><td className="num">{money(x.avg_cost)}</td><td className="num">{money(x.value)}</td></tr>)}</tbody>
          <tfoot><tr><td colSpan={4}>Total stock value</td><td className="num">{money(d.stock_value)}</td></tr></tfoot>
        </table></TableWrap>
        <Check ok={d.reconciles} okText={`Matches the Inventory ledger balance (${money(d.ledger_value)}).`} badText={`Inventory ledger (${money(d.ledger_value)}) differs from stock value by ${money(d.difference)} — check manual journals to the Inventory account.`} />
      </> : <EmptyState title="No stock-tracked items" />)}
    </Shell>
  );
}

export function GstSummary() {
  const { path, money, settings } = useCompany();
  const { from, to, controls } = useRange();
  const r = useApi<any>(path(`/reports/gst-summary?from=${from}&to=${to}`));
  const d = r.data;
  const cur = settings?.company.base_currency ?? "INR";
  const india = settings?.company.country === "IN";
  const Table = ({ rows, title }: { rows: any[]; title: string }) => (
    <>
      <h3 className="mt-5 text-sm font-semibold">{title}</h3>
      {rows.length ? <TableWrap><table className="table mt-2">
        <thead><tr><th>Document</th><th>Tax code</th><th className="num">Taxable</th>{india ? <><th className="num">CGST</th><th className="num">SGST</th><th className="num">IGST</th></> : <th className="num">Tax</th>}</tr></thead>
        <tbody>{rows.map((x, i) => <tr key={i}><td>{DOC_LABELS[x.doc_type].many}</td><td>{x.tax_name ?? "No tax"}</td><td className="num">{money(x.sign * x.taxable)}</td>{india ? <><td className="num">{money(x.sign * x.cgst)}</td><td className="num">{money(x.sign * x.sgst)}</td><td className="num">{money(x.sign * x.igst)}</td></> : <td className="num">{money(x.sign * x.other_tax)}</td>}</tr>)}</tbody>
      </table></TableWrap> : <p className="mt-2 text-sm muted">None.</p>}
    </>
  );
  return (
    <Shell title={india ? "GST summary" : "Tax summary"} controls={controls} subtitle={`${fmtDate(from)} to ${fmtDate(to)}`}
      onCsv={d ? () => downloadCsv(`tax-summary-${from}-${to}.csv`, ["Account", "Debit", "Credit"], d.ledger.map((l: any) => [`${l.code} ${l.name}`, toInput(l.debit, cur), toInput(l.credit, cur)])) : undefined}>
      <Loading r={r} />
      {d && <>
        <Alert kind="warning">{d.disclaimer}</Alert>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="card p-4"><p className="text-xs muted">Output tax</p><p className="text-lg font-semibold">{money(d.output_tax)}</p></div>
          <div className="card p-4"><p className="text-xs muted">Input tax credit</p><p className="text-lg font-semibold">{money(d.input_tax)}</p></div>
          <div className="card p-4"><p className="text-xs muted">Net payable (ledger)</p><p className="text-lg font-semibold">{money(d.net_payable)}</p></div>
        </div>
        <Table title="Outward supplies (base-currency documents)" rows={d.outward} />
        <Table title="Inward supplies (base-currency documents)" rows={d.inward} />
        {d.foreign_currency_documents > 0 && <p className="mt-3 text-sm muted">{d.foreign_currency_documents} foreign-currency document(s) are excluded from the rate tables above but included in the ledger totals.</p>}
      </>}
    </Shell>
  );
}

export function Budgets() {
  const { path, money, accounts, settings, can } = useCompany();
  const list = useApi<{ budgets: any[] }>(path("/reports/budgets"));
  const fys = useApi<{ fiscal_years: any[] }>(path("/settings/fiscal-years"));
  const [sel, setSel] = useState("");
  const r = useApi<any>(sel ? path(`/reports/budgets/${sel}`) : null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", fiscal_year_id: "", amounts: {} as Record<string, string> });
  const [err, setErr] = useState<string | null>(null);
  const plAccounts = accounts.filter((a) => !a.is_group && a.is_active && (a.type === "income" || a.type === "expense"));
  const cur = settings?.company.base_currency ?? "INR";
  return (
    <Shell title="Budget vs actual" controls={<>
      <Select value={sel} onChange={(e) => setSel(e.target.value)} className="max-w-xs" aria-label="Budget"><option value="">Select budget…</option>{list.data?.budgets.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.fiscal_year_name})</option>)}</Select>
      {can("masters.write") && <Button variant="secondary" onClick={() => setCreating(!creating)}>{creating ? "Cancel" : "New budget"}</Button>}
    </>} onCsv={r.data ? () => downloadCsv("budget-vs-actual.csv", ["Account", "Budget", "Actual", "Variance"], r.data.rows.map((x: any) => [`${x.code} ${x.name}`, toInput(x.amount, cur), toInput(x.actual, cur), toInput(x.variance, cur)])) : undefined}>
      {creating && (
        <div className="mb-6 space-y-3 rounded-lg bg-[var(--surface-2)] p-4">
          {err && <Alert>{err}</Alert>}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name">{(id) => <Input id={id} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
            <Field label="Fiscal year">{(id) => <Select id={id} value={form.fiscal_year_id} onChange={(e) => setForm({ ...form, fiscal_year_id: e.target.value })}><option value="">Select…</option>{fys.data?.fiscal_years.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</Select>}</Field>
          </div>
          <p className="text-sm muted">Annual amount per account (spread evenly across the 12 months; last month absorbs rounding).</p>
          <div className="max-h-72 overflow-y-auto">{plAccounts.map((a) => (
            <div key={a.id} className="flex items-center gap-3 py-1 text-sm"><span className="flex-1">{a.code} · {a.name}</span><Input className="w-40 num" inputMode="decimal" value={form.amounts[a.id] ?? ""} onChange={(e) => setForm({ ...form, amounts: { ...form.amounts, [a.id]: e.target.value } })} aria-label={`${a.name} budget`} /></div>
          ))}</div>
          <Button onClick={async () => {
            const fy = fys.data?.fiscal_years.find((f) => f.id === form.fiscal_year_id);
            if (!fy) return setErr("Choose a fiscal year");
            const months: string[] = [];
            const d = new Date(`${fy.start_date}T00:00:00Z`);
            while (d.toISOString().slice(0, 10) <= fy.end_date) { months.push(d.toISOString().slice(0, 7)); d.setUTCMonth(d.getUTCMonth() + 1); }
            const exp = CURRENCIES[cur]?.exponent ?? 2;
            const lines: any[] = [];
            try {
              for (const [account_id, v] of Object.entries(form.amounts)) {
                if (!v) continue;
                const parts = allocateProportionally(parseDecimal(v, exp), months.map(() => 1));
                months.forEach((m, i) => lines.push({ account_id, period_month: m, amount: toDecimalString(parts[i], exp) }));
              }
              const res = await api.post(path("/reports/budgets"), { name: form.name, fiscal_year_id: form.fiscal_year_id, lines });
              setCreating(false); list.reload(); setSel(res.id);
            } catch (e) { setErr((e as Error).message); }
          }}>Save budget</Button>
        </div>
      )}
      {!sel ? <EmptyState title="Select or create a budget" /> : <>
        <Loading r={r} />
        {r.data && <TableWrap><table className="table">
          <thead><tr><th>Account</th><th className="num">Budget</th><th className="num">Actual</th><th className="num">Variance</th></tr></thead>
          <tbody>{r.data.rows.map((x: any) => <tr key={x.account_id}><td><span className="font-mono text-xs muted">{x.code}</span> {x.name}</td><td className="num">{money(x.amount)}</td><td className="num">{money(x.actual)}</td><td className={`num ${x.favourable ? "text-emerald-600" : "text-red-600"}`}>{money(x.variance)}</td></tr>)}</tbody>
        </table></TableWrap>}
        <p className="mt-3 text-xs muted">Positive variance is favourable (income above budget, or expenses below budget).</p>
      </>}
    </Shell>
  );
}

export function ReportRouter() {
  const { reportKey } = useParams();
  switch (reportKey) {
    case "trial-balance": return <TrialBalance />;
    case "profit-loss": return <ProfitLoss />;
    case "balance-sheet": return <BalanceSheet />;
    case "cash-flow": return <CashFlow />;
    case "general-ledger": return <GeneralLedger />;
    case "aging-receivable": return <Aging kind="receivable" />;
    case "aging-payable": return <Aging kind="payable" />;
    case "sales-by-customer": return <SimpleTotals kind="sales-by-customer" />;
    case "purchases-by-supplier": return <SimpleTotals kind="purchases-by-supplier" />;
    case "expenses": return <ExpenseReport />;
    case "inventory-valuation": return <InventoryValuation />;
    case "gst-summary": return <GstSummary />;
    case "budgets": return <Budgets />;
    default: return <EmptyState title="Unknown report" />;
  }
}

export function Insights() {
  const { path, money, id, settings } = useCompany();
  const r = useApi<any>(path("/reports/insights"));
  const d = r.data;
  return (
    <>
      <PageHeader title="Insights" subtitle={d?.label ?? "Rule-based suggestions"} />
      <Loading r={r} />
      {d && <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Cash projection">
          <p className="mb-3 text-sm">Current cash & bank: <strong>{money(d.forecast.opening_cash)}</strong></p>
          <TableWrap><table className="table text-sm">
            <thead><tr><th>Period</th><th className="num">Expected in</th><th className="num">Expected out</th><th className="num">Projected balance</th></tr></thead>
            <tbody>{d.forecast.buckets.map((b: any) => <tr key={b.label}><td>{b.label}</td><td className="num">{money(b.inflow)}</td><td className="num">{money(b.outflow)}</td><td className={`num ${b.projected_balance < 0 ? "text-red-600" : ""}`}>{money(b.projected_balance)}</td></tr>)}</tbody>
          </table></TableWrap>
          <p className="mt-2 text-xs muted">{d.forecast.note}</p>
        </Card>
        <Card title="Unusual transactions">
          {d.unusual.length ? <ul className="divide-y divide-[var(--border)] text-sm">{d.unusual.map((u: any) => (
            <li key={`${u.entry_id}-${u.account_name}`} className="py-2"><Link className="font-medium text-brand-700 hover:underline dark:text-brand-300" to={`/app/${id}/journals/${u.entry_id}`}>{u.entry_number}</Link> · {fmtDate(u.entry_date, settings?.company.date_format)} · {u.account_name}
              <p className="text-xs muted">{money(u.amount)} vs typical {money(u.typical)} — {u.reason}</p></li>
          ))}</ul> : <p className="text-sm muted">Nothing unusual found. (Needs at least 8 postings to an account in the last 12 months.)</p>}
        </Card>
      </div>}
    </>
  );
}
