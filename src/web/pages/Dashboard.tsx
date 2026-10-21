import { Link } from "react-router";
import { FileText, ShoppingCart, Receipt, BookOpen, AlertTriangle } from "lucide-react";
import { useCompany } from "../lib/company";
import { useApi } from "../lib/hooks";
import { Alert, Card, EmptyState, LinkButton, PageHeader, Spinner, Stat } from "../components/ui";
import { fmtDate, qty } from "../lib/format";

function IncomeExpenseChart({ months, fmt }: { months: { month: string; income: number; expense: number }[]; fmt: (n: number) => string }) {
  const max = Math.max(1, ...months.flatMap((m) => [m.income, m.expense]));
  const H = 160;
  const label = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleString(undefined, { month: "short", timeZone: "UTC" });
  const hasData = months.some((m) => m.income || m.expense);
  if (!hasData) return <EmptyState title="No income or expenses posted yet" body="The chart fills in as invoices, bills and expenses are posted." />;
  return (
    <figure>
      <div className="flex h-[180px] items-end gap-3 sm:gap-6" role="img" aria-label="Income and expenses for the last six months">
        {months.map((m) => (
          <div key={m.month} className="flex flex-1 flex-col items-center gap-1">
            <div className="flex h-[160px] w-full items-end justify-center gap-1">
              <div title={`Income ${fmt(m.income)}`} className="w-1/2 max-w-6 rounded-t bg-brand-600" style={{ height: `${Math.max(0, (m.income / max) * H)}px` }} />
              <div title={`Expenses ${fmt(m.expense)}`} className="w-1/2 max-w-6 rounded-t bg-slate-400 dark:bg-slate-500" style={{ height: `${Math.max(0, (m.expense / max) * H)}px` }} />
            </div>
            <span className="text-xs muted">{label(m.month)}</span>
          </div>
        ))}
      </div>
      <figcaption className="mt-3 flex gap-4 text-xs muted">
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-brand-600" /> Income</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-slate-400 dark:bg-slate-500" /> Expenses</span>
      </figcaption>
    </figure>
  );
}

/** Start page for staff without access to the financial dashboard (e.g. billing or store staff). */
function StaffHome() {
  const { id, can, settings } = useCompany();
  const actions: [boolean, string, string][] = [
    [can("sales.create"), "New invoice / bill", `/app/${id}/sales/invoice/new`],
    [can("sales.post"), "Record a receipt", `/app/${id}/payments/in/new`],
    [can("purchase.create"), "New supplier bill", `/app/${id}/purchases/bill/new`],
    [can("purchase.create"), "New purchase order", `/app/${id}/purchases/purchase_order/new`],
    [can("inventory.view"), "Products & stock", `/app/${id}/inventory`],
    [can("inventory.transfer"), "Transfer stock", `/app/${id}/inventory?tab=transfers`],
    [can("labels.print"), "Print product labels", `/app/${id}/labels`],
    [can("expense.create"), "Record an expense", `/app/${id}/expenses`],
    [can("daybook.read"), "Daybook", `/app/${id}/daybook`],
  ];
  return (
    <>
      <PageHeader title={`Welcome to ${settings?.company.name ?? ""}`} subtitle="Your role shows the work you can do here." />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {actions.filter(([ok]) => ok).map(([, label, to]) => <LinkButton key={to} variant="secondary" to={to}>{label}</LinkButton>)}
      </div>
    </>
  );
}

export default function Dashboard() {
  const { can, settings } = useCompany();
  if (settings && !can("reports.read")) return <StaffHome />;
  return <FinancialDashboard />;
}

function FinancialDashboard() {
  const { path, money, settings, id, branchQuery } = useCompany();
  const { data, error, loading } = useApi<any>(path(`/reports/dashboard?${branchQuery.slice(1)}`));
  if (loading && !data) return <Spinner />;
  if (error) return <Alert>{error}</Alert>;
  if (!data) return null;
  const cashTotal = data.cash.reduce((t: number, a: any) => t + a.balance, 0);
  const thisMonth = data.months[data.months.length - 1];
  const base = `/app/${id}`;
  const noActivity = !data.recent.length;
  return (
    <>
      <PageHeader title="Dashboard" subtitle={settings ? `${settings.company.name} · ${settings.company.base_currency}` : undefined}
        actions={<>
          <LinkButton to={`${base}/sales/invoice/new`}><FileText className="h-4 w-4" />New invoice</LinkButton>
          <LinkButton to={`${base}/purchases/bill/new`} variant="secondary"><ShoppingCart className="h-4 w-4" />New bill</LinkButton>
          <LinkButton to={`${base}/expenses`} variant="secondary"><Receipt className="h-4 w-4" />Expense</LinkButton>
        </>} />
      {noActivity && (
        <Alert kind="info" className="mb-5">
          Welcome! Start by <Link className="underline" to={`${base}/journals/opening`}>entering opening balances</Link>, adding <Link className="underline" to={`${base}/customers`}>customers</Link>, or raising your first <Link className="underline" to={`${base}/sales/invoice/new`}>invoice</Link>.
        </Alert>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Cash & bank" value={money(cashTotal)} sub={`${data.cash.length} account(s)`} tone={cashTotal < 0 ? "bad" : undefined} />
        <Stat label="Receivables" value={money(data.receivables.ar)} sub={data.receivables.overdue_inv ? `${money(data.receivables.overdue_ar)} overdue (${data.receivables.overdue_inv})` : "Nothing overdue"} tone={data.receivables.overdue_inv ? "bad" : undefined} />
        <Stat label="Payables" value={money(data.receivables.ap)} sub={data.receivables.overdue_bills ? `${money(data.receivables.overdue_ap)} overdue (${data.receivables.overdue_bills})` : "Nothing overdue"} />
        <Stat label="This month profit" value={money(thisMonth.income - thisMonth.expense)} sub={`Income ${money(thisMonth.income)}`} tone={thisMonth.income - thisMonth.expense < 0 ? "bad" : "good"} />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title="Income vs expenses (6 months)" className="lg:col-span-2"><IncomeExpenseChart months={data.months} fmt={(n) => money(n)} /></Card>
        <Card title="Cash & bank accounts" padded={false}>
          {data.cash.length ? (
            <ul className="divide-y divide-[var(--border)]">
              {data.cash.map((a: any) => (
                <li key={a.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
                  <Link to={`${base}/reports/general-ledger?account_id=${a.id}`} className="hover:underline">{a.name}</Link>
                  <span className={`num ${a.balance < 0 ? "text-red-600" : ""}`}>{money(a.balance)}</span>
                </li>
              ))}
            </ul>
          ) : <EmptyState title="No bank accounts" />}
        </Card>
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title="Needs attention">
          <ul className="space-y-2 text-sm">
            <li className="flex justify-between"><Link className="hover:underline" to={`${base}/journals?status=draft`}>Draft journals</Link><span className="num">{data.pending.drafts}</span></li>
            <li className="flex justify-between"><Link className="hover:underline" to={`${base}/expenses?status=submitted`}>Expenses awaiting approval</Link><span className="num">{data.pending.expenses}</span></li>
            <li className="flex justify-between"><Link className="hover:underline" to={`${base}/banking`}>Unmatched bank lines</Link><span className="num">{data.pending.unmatched}</span></li>
            <li className="flex justify-between"><Link className="hover:underline" to={`${base}/sales/invoice?status=overdue`}>Overdue invoices</Link><span className="num">{data.receivables.overdue_inv}</span></li>
          </ul>
        </Card>
        <Card title="Low stock" padded={false}>
          {data.reorder.length ? (
            <ul className="divide-y divide-[var(--border)]">
              {data.reorder.map((r: any) => (
                <li key={r.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
                  <span className="flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-amber-500" />{r.name}</span>
                  <span className="num muted">{qty(r.qty_milli)} / {qty(r.reorder_level_milli)} {r.unit}</span>
                </li>
              ))}
            </ul>
          ) : <p className="p-4 text-sm muted">No items at or below their reorder level.</p>}
        </Card>
        <Card title="Recent entries" padded={false}>
          {data.recent.length ? (
            <ul className="divide-y divide-[var(--border)]">
              {data.recent.map((e: any) => (
                <li key={e.id} className="px-4 py-2 text-sm">
                  <Link to={`${base}/journals/${e.id}`} className="flex justify-between gap-2 hover:underline">
                    <span className="truncate">{e.entry_number} · {e.memo ?? e.kind}</span>
                    <span className="num">{money(e.total)}</span>
                  </Link>
                  <span className="text-xs muted">{fmtDate(e.entry_date, settings?.company.date_format)}</span>
                </li>
              ))}
            </ul>
          ) : <EmptyState icon={<BookOpen className="h-5 w-5" />} title="No posted entries yet" />}
        </Card>
      </div>
    </>
  );
}
