import { useState } from "react";
import { Link } from "react-router";
import { Plus, Printer, Trash2 } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { useAction, useApi } from "../lib/hooks";
import { useCompany } from "../lib/company";
import { downloadCsv } from "../lib/csv";
import { fmtDate, today, toInput } from "../lib/format";
import { AccountSelect, isCashOrBank } from "../components/pickers";
import { Alert, Badge, Button, Card, ConfirmButton, EmptyState, Field, Input, Modal, MoneyInput, PageHeader, Select, Spinner, Stat, TableWrap, Tabs, useToast } from "../components/ui";

type Tab = "runs" | "employees" | "timesheets" | "report";

const prevMonth = () => {
  const d = new Date();
  d.setUTCDate(1);
  return d.toISOString().slice(0, 7);
};

function EmployeeForm({ initial, onClose }: { initial?: any; onClose: (saved: boolean) => void }) {
  const { path, settings } = useCompany();
  const cur = settings!.company.base_currency;
  const india = settings!.company.country === "IN";
  const m = (v: number | undefined) => (v ? toInput(v, cur) : "");
  const [v, setV] = useState({
    code: initial?.code ?? "", name: initial?.name ?? "", designation: initial?.designation ?? "", email: initial?.email ?? "", phone: initial?.phone ?? "",
    date_of_joining: initial?.date_of_joining ?? "", date_of_leaving: initial?.date_of_leaving ?? "", pan: initial?.pan ?? "", uan: initial?.uan ?? "", esi_number: initial?.esi_number ?? "",
    bank_name: initial?.bank_name ?? "", bank_account: initial?.bank_account ?? "", ifsc: initial?.ifsc ?? "",
    pay_type: initial?.pay_type ?? "monthly", monthly_basic: m(initial?.monthly_basic), hra: m(initial?.hra), other_allowances: m(initial?.other_allowances),
    hourly_rate: m(initial?.hourly_rate), overtime_rate: m(initial?.overtime_rate), pf_enabled: Boolean(initial?.pf_enabled ?? india), esi_enabled: Boolean(initial?.esi_enabled),
    pt_monthly: m(initial?.pt_monthly), tds_monthly: m(initial?.tds_monthly), is_active: initial ? Boolean(initial.is_active) : true,
  });
  const set = (k: string, val: unknown) => setV((p) => ({ ...p, [k]: val }));
  const { busy, error, run } = useAction();
  const save = async () => {
    const body = { ...v, date_of_joining: v.date_of_joining || null, date_of_leaving: v.date_of_leaving || null };
    if (await run(() => (initial ? api.put(path(`/payroll/employees/${initial.id}`), body) : api.post(path("/payroll/employees"), body)))) onClose(true);
  };
  const text = (k: keyof typeof v, label: string, type = "text") => <Field label={label}>{(id) => <Input id={id} type={type} value={v[k] as string} onChange={(e) => set(k, e.target.value)} />}</Field>;
  const amt = (k: keyof typeof v, label: string, hint?: string) => <Field label={label} hint={hint}>{(id) => <MoneyInput id={id} value={v[k] as string} onChange={(e) => set(k, e.target.value)} />}</Field>;
  return (
    <Modal open wide onClose={() => onClose(false)} title={initial ? `Edit ${initial.name}` : "New employee"}
      footer={<><Button variant="secondary" onClick={() => onClose(false)}>Cancel</Button><Button loading={busy} onClick={save}>Save</Button></>}>
      {error && <Alert className="mb-3">{error}</Alert>}
      <div className="grid gap-3 sm:grid-cols-3">
        {text("code", "Employee code")}{text("name", "Full name")}{text("designation", "Designation")}
        {text("date_of_joining", "Date of joining", "date")}{text("date_of_leaving", "Date of leaving", "date")}
        <Field label="Pay type">{(id) => <Select id={id} value={v.pay_type} onChange={(e) => set("pay_type", e.target.value)}><option value="monthly">Monthly salary</option><option value="hourly">Hourly (from timesheets)</option></Select>}</Field>
        {v.pay_type === "monthly" ? <>{amt("monthly_basic", "Basic (per month)")}{amt("hra", "HRA (per month)")}{amt("other_allowances", "Other allowances (per month)")}</> : amt("hourly_rate", "Rate per hour")}
        {amt("overtime_rate", "Overtime rate per hour", "Paid on overtime hours in timesheets")}
        {india && <>
          <label className="flex items-center gap-2 text-sm sm:mt-6"><input type="checkbox" checked={v.pf_enabled} onChange={(e) => set("pf_enabled", e.target.checked)} />Provident fund (12% of basic, ₹15,000 ceiling)</label>
          <label className="flex items-center gap-2 text-sm sm:mt-6"><input type="checkbox" checked={v.esi_enabled} onChange={(e) => set("esi_enabled", e.target.checked)} />ESI (when gross ≤ ₹21,000)</label>
          {amt("pt_monthly", "Professional tax (per month)", "As per your state's slab")}
        </>}
        {amt("tds_monthly", india ? "TDS (per month)" : "Income tax withheld (per month)", "From the employee's tax computation")}
        {india && <>{text("pan", "PAN")}{text("uan", "UAN")}{text("esi_number", "ESI number")}</>}
        {text("bank_name", "Bank")}{text("bank_account", "Account number")}{text("ifsc", india ? "IFSC" : "Bank code")}
        {text("email", "Email", "email")}{text("phone", "Phone")}
        {initial && <label className="flex items-center gap-2 text-sm sm:mt-6"><input type="checkbox" checked={v.is_active} onChange={(e) => set("is_active", e.target.checked)} />Active</label>}
      </div>
    </Modal>
  );
}

function Employees() {
  const { path, money, can } = useCompany();
  const list = useApi<{ employees: any[] }>(path("/payroll/employees"));
  const [edit, setEdit] = useState<any | null | undefined>(undefined);
  return (
    <Card padded={false} title="Employees" actions={can("payroll.manage") && <Button size="sm" onClick={() => setEdit(null)}><Plus className="h-4 w-4" />New employee</Button>}>
      {list.loading ? <Spinner /> : list.data?.employees.length ? (
        <TableWrap><table className="table">
          <thead><tr><th>Code</th><th>Name</th><th>Designation</th><th>Pay</th><th className="num">Monthly gross / rate</th><th /></tr></thead>
          <tbody>{list.data.employees.map((e) => (
            <tr key={e.id}>
              <td className="font-mono text-xs">{e.code}</td><td>{e.name} {!e.is_active && <Badge>inactive</Badge>}</td><td className="muted">{e.designation}</td>
              <td>{e.pay_type === "hourly" ? "Hourly" : "Monthly"}{e.pf_enabled ? <span className="ml-1"><Badge color="blue">PF</Badge></span> : null}{e.esi_enabled ? <span className="ml-1"><Badge color="blue">ESI</Badge></span> : null}</td>
              <td className="num">{e.pay_type === "hourly" ? `${money(e.hourly_rate)}/h` : money(e.monthly_basic + e.hra + e.other_allowances)}</td>
              <td className="text-right">{can("payroll.manage") && <Button size="sm" variant="ghost" onClick={() => setEdit(e)}>Edit</Button>}</td>
            </tr>
          ))}</tbody>
        </table></TableWrap>
      ) : <EmptyState title="No employees yet" body="Add employees with their salary structure, then run payroll each month." />}
      {edit !== undefined && <EmployeeForm initial={edit ?? undefined} onClose={(saved) => { setEdit(undefined); if (saved) list.reload(); }} />}
    </Card>
  );
}

function Timesheets() {
  const { path, settings, can } = useCompany();
  const toast = useToast();
  const [month, setMonth] = useState(prevMonth());
  const emps = useApi<{ employees: any[] }>(path("/payroll/employees"));
  const list = useApi<{ timesheets: any[] }>(path(`/payroll/timesheets?from=${month}-01&to=${month}-31`));
  const [v, setV] = useState({ employee_id: "", work_date: today(), hours: "8", overtime_hours: "", project_id: "", description: "" });
  const { busy, error, run } = useAction();
  const total = (list.data?.timesheets ?? []).reduce((t, x) => t + x.minutes, 0);
  return (
    <div className="space-y-4">
      {can("payroll.manage") && (
        <Card title="Log hours">
          {error && <Alert className="mb-3">{error}</Alert>}
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Employee">{(id) => <Select id={id} value={v.employee_id} onChange={(e) => setV({ ...v, employee_id: e.target.value })}><option value="">Select…</option>{emps.data?.employees.filter((e) => e.is_active).map((e) => <option key={e.id} value={e.id}>{e.code} · {e.name}</option>)}</Select>}</Field>
            <Field label="Date">{(id) => <Input id={id} type="date" value={v.work_date} onChange={(e) => setV({ ...v, work_date: e.target.value })} />}</Field>
            <Field label="Hours">{(id) => <Input id={id} inputMode="decimal" className="w-24" value={v.hours} onChange={(e) => setV({ ...v, hours: e.target.value })} />}</Field>
            <Field label="Overtime hours">{(id) => <Input id={id} inputMode="decimal" className="w-24" value={v.overtime_hours} onChange={(e) => setV({ ...v, overtime_hours: e.target.value })} />}</Field>
            <Field label="Project">{(id) => <Select id={id} value={v.project_id} onChange={(e) => setV({ ...v, project_id: e.target.value })}><option value="">—</option>{settings?.projects.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>}</Field>
            <Field label="Work done" className="min-w-[12rem] flex-1">{(id) => <Input id={id} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} />}</Field>
            <Button loading={busy} disabled={!v.employee_id} onClick={async () => { if (await run(() => api.post(path("/payroll/timesheets"), { ...v, project_id: v.project_id || null, overtime_hours: v.overtime_hours || null }))) { toast("success", "Hours logged"); list.reload(); } }}>Add</Button>
          </div>
        </Card>
      )}
      <Card padded={false} title={`Timesheet · ${(total / 60).toFixed(2)} hours`} actions={<Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-40" aria-label="Month" />}>
        {list.data?.timesheets.length ? (
          <TableWrap><table className="table">
            <thead><tr><th>Date</th><th>Employee</th><th className="num">Hours</th><th className="num">Overtime</th><th>Project</th><th>Work done</th><th /></tr></thead>
            <tbody>{list.data.timesheets.map((t) => (
              <tr key={t.id}><td>{fmtDate(t.work_date, settings?.company.date_format)}</td><td>{t.employee_code} · {t.employee_name}</td><td className="num">{(t.minutes / 60).toFixed(2)}</td><td className="num">{t.overtime_minutes ? (t.overtime_minutes / 60).toFixed(2) : ""}</td><td>{t.project_name}</td><td className="muted">{t.description}</td>
                <td className="text-right">{can("payroll.manage") && <button aria-label="Delete" className="rounded p-1 hover:bg-[var(--surface-2)]" onClick={async () => { try { await api.del(path(`/payroll/timesheets/${t.id}`)); list.reload(); } catch (e) { toast("error", errorMessage(e)); } }}><Trash2 className="h-4 w-4" /></button>}</td></tr>
            ))}</tbody>
          </table></TableWrap>
        ) : <EmptyState title="No hours logged for this month" />}
      </Card>
    </div>
  );
}

function downloadText(name: string, text: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" })); a.download = name; a.click(); URL.revokeObjectURL(a.href);
}

/** EPF ECR and ESIC files for a posted payroll (India). */
function StatutoryFiles({ runId }: { runId: string }) {
  const { path } = useCompany();
  const f = useApi<{ period: string; ecr: { text: string; rows: any[]; problems: string[]; summary: Record<string, number> }; esi: { rows: any[]; problems: string[]; header: string[] } }>(path(`/payroll/runs/${runId}/statutory`));
  if (!f.data) return null;
  const { ecr, esi, period } = f.data;
  const problems = [...ecr.problems, ...esi.problems];
  const s = ecr.summary;
  const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;
  return (
    <Card title="Statutory files">
      {problems.length > 0 && <Alert kind="warning" className="mb-3"><ul className="ml-4 list-disc">{problems.map((p) => <li key={p}>{p}</li>)}</ul><p className="mt-1">Fix these on the employee and download again.</p></Alert>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" disabled={!ecr.rows.length} onClick={() => downloadText(`ECR-${period}.txt`, ecr.text)}>EPF ECR ({ecr.rows.length})</Button>
        <Button size="sm" variant="secondary" disabled={!esi.rows.length} onClick={() => downloadCsv(`ESIC-${period}.csv`, esi.header, esi.rows.map((r) => [r.ip_number, r.name, r.days, r.wages, r.reason, r.last_working_day]))}>ESIC contribution ({esi.rows.length})</Button>
      </div>
      {ecr.rows.length > 0 && <p className="mt-3 text-sm">EPF challan: A/c 1 {inr(s.ac1)} · A/c 2 {inr(s.ac2)} · A/c 10 {inr(s.ac10)} · A/c 21 {inr(s.ac21)} · <b>Total {inr(s.total)}</b></p>}
      {esi.rows.length > 0 && <p className="mt-1 text-sm">ESIC: employee {inr(esi.rows.reduce((t, r) => t + r.employee_share, 0))} + employer {inr(esi.rows.reduce((t, r) => t + r.employer_share, 0))}</p>}
      <p className="mt-2 text-xs muted">Upload the ECR at unifiedportal-emp.epfindia.gov.in; paste the ESIC rows into the portal's monthly contribution template. The portals check every figure; compare the first upload with your own calculation.</p>
    </Card>
  );
}

function RunView({ runId, onBack }: { runId: string; onBack: () => void }) {
  const { path, money, can, id, settings } = useCompany();
  const toast = useToast();
  const data = useApi<{ run: any; payslips: any[] }>(path(`/payroll/runs/${runId}`));
  const [pay, setPay] = useState<{ account_id: string; date: string } | null>(null);
  const [adj, setAdj] = useState<any | null>(null);
  const { busy, error, run } = useAction();
  if (!data.data) return <Spinner />;
  const r = data.data.run;
  const draft = r.status === "draft";
  return (
    <div className="space-y-4">
      <button className="text-sm muted hover:underline" onClick={onBack}>← All payrolls</button>
      {error && <Alert>{error}</Alert>}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Period" value={r.period} sub={<Badge color={r.status === "paid" ? "green" : r.status === "posted" ? "blue" : "gray"}>{r.status}</Badge>} />
        <Stat label="Gross pay" value={money(r.gross)} sub={`${data.data.payslips.length} employee(s)`} />
        <Stat label="Deductions" value={money(r.deductions)} />
        <Stat label="Net pay" value={money(r.net)} sub={`Employer cost ${money(r.employer_cost)}`} />
      </div>
      <div className="flex flex-wrap gap-2">
        {draft && can("payroll.manage") && <Button loading={busy} onClick={async () => { if (await run(() => api.post(path(`/payroll/runs/${runId}/post`)))) { toast("success", "Payroll posted to the ledger"); data.reload(); } }}>Post to ledger</Button>}
        {draft && can("payroll.manage") && <ConfirmButton label="Delete draft" title="Delete this draft payroll?" body="Payslips in this draft are removed. You can create it again." onConfirm={async () => { await api.del(path(`/payroll/runs/${runId}`)); onBack(); }} />}
        {r.status === "posted" && can("payroll.manage") && <Button onClick={() => setPay({ account_id: "", date: r.pay_date })}>Record salary payment</Button>}
        {r.journal_entry_id && <Link className="self-center text-sm text-brand-700 hover:underline dark:text-brand-300" to={`/app/${id}/journals/${r.journal_entry_id}`}>Salary journal</Link>}
        {r.payment_entry_id && <Link className="self-center text-sm text-brand-700 hover:underline dark:text-brand-300" to={`/app/${id}/journals/${r.payment_entry_id}`}>Payment journal</Link>}
      </div>
      {!draft && settings?.company.country === "IN" && <StatutoryFiles runId={runId} />}
      <Card padded={false} title="Payslips">
        <TableWrap><table className="table">
          <thead><tr><th>Employee</th><th className="num">Paid days</th><th className="num">Gross</th><th className="num">PF</th><th className="num">ESI</th><th className="num">PT</th><th className="num">TDS</th><th className="num">Other</th><th className="num">Net pay</th><th /></tr></thead>
          <tbody>{data.data.payslips.map((p) => (
            <tr key={p.id}>
              <td>{p.code} · {p.name}<span className="block text-xs muted">{p.designation}</span></td>
              <td className="num">{p.pay_type === "hourly" ? `${(p.worked_minutes / 60).toFixed(1)} h` : `${p.paid_days_milli / 1000}/${p.working_days}`}</td>
              <td className="num">{money(p.gross)}</td><td className="num">{money(p.pf_employee)}</td><td className="num">{money(p.esi_employee)}</td><td className="num">{money(p.pt)}</td><td className="num">{money(p.tds)}</td><td className="num">{money(p.other_deductions)}</td>
              <td className="num font-semibold">{money(p.net)}</td>
              <td className="whitespace-nowrap text-right">
                {draft && can("payroll.manage") && <Button size="sm" variant="ghost" onClick={() => setAdj({ ...p, paid_days: String(p.paid_days_milli / 1000), other: p.other_deductions ? toInput(p.other_deductions, "INR") : "" })}>Adjust</Button>}
                <Link className="inline-flex items-center gap-1 rounded px-2 py-1 text-sm hover:bg-[var(--surface-2)]" to={`/print/${id}/payslip/${p.id}`}><Printer className="h-4 w-4" />Payslip</Link>
              </td>
            </tr>
          ))}</tbody>
        </table></TableWrap>
      </Card>
      {adj && (
        <Modal open onClose={() => setAdj(null)} title={`Adjust ${adj.name}`} footer={<><Button variant="secondary" onClick={() => setAdj(null)}>Cancel</Button><Button loading={busy} onClick={async () => { if (await run(() => api.put(path(`/payroll/runs/${runId}/payslips/${adj.id}`), { paid_days: adj.paid_days, other_deductions: adj.other || null }))) { setAdj(null); data.reload(); } }}>Recalculate</Button></>}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={`Paid days (of ${adj.working_days})`} hint="Reduce for unpaid leave (loss of pay).">{(fid) => <Input id={fid} inputMode="decimal" value={adj.paid_days} onChange={(e) => setAdj({ ...adj, paid_days: e.target.value })} />}</Field>
            <Field label="Other deductions" hint="Advances, canteen, fines…">{(fid) => <MoneyInput id={fid} value={adj.other} onChange={(e) => setAdj({ ...adj, other: e.target.value })} />}</Field>
          </div>
        </Modal>
      )}
      {pay && (
        <Modal open onClose={() => setPay(null)} title="Record salary payment" footer={<><Button variant="secondary" onClick={() => setPay(null)}>Cancel</Button><Button loading={busy} disabled={!pay.account_id} onClick={async () => { if (await run(() => api.post(path(`/payroll/runs/${runId}/pay`), pay))) { setPay(null); toast("success", "Salaries marked paid"); data.reload(); } }}>Record {money(r.net)}</Button></>}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Paid from">{(fid) => <AccountSelect id={fid} value={pay.account_id} onChange={(a) => setPay({ ...pay, account_id: a })} filter={isCashOrBank} />}</Field>
            <Field label="Date">{(fid) => <Input id={fid} type="date" value={pay.date} onChange={(e) => setPay({ ...pay, date: e.target.value })} />}</Field>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Runs() {
  const { path, money, can } = useCompany();
  const list = useApi<{ runs: any[] }>(path("/payroll/runs"));
  const [open, setOpen] = useState<string | null>(null);
  const [v, setV] = useState({ period: prevMonth(), pay_date: today() });
  const { busy, error, run } = useAction();
  if (open) return <RunView runId={open} onBack={() => { setOpen(null); list.reload(); }} />;
  return (
    <div className="space-y-4">
      {can("payroll.manage") && (
        <Card title="Run payroll">
          {error && <Alert className="mb-3">{error}</Alert>}
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Month">{(id) => <Input id={id} type="month" value={v.period} onChange={(e) => setV({ ...v, period: e.target.value })} />}</Field>
            <Field label="Pay date">{(id) => <Input id={id} type="date" value={v.pay_date} onChange={(e) => setV({ ...v, pay_date: e.target.value })} />}</Field>
            <Button loading={busy} onClick={async () => { const r = await run(() => api.post<{ id: string }>(path("/payroll/runs"), v)); if (r) setOpen(r.id); }}>Calculate payslips</Button>
          </div>
          <p className="mt-2 text-xs muted">Creates a draft from each active employee's salary, joining/leaving dates and the month's timesheets. Review, adjust leave, then post to the ledger.</p>
        </Card>
      )}
      <Card padded={false} title="Payrolls">
        {list.data?.runs.length ? (
          <TableWrap><table className="table">
            <thead><tr><th>Month</th><th>Status</th><th className="num">Employees</th><th className="num">Gross</th><th className="num">Net pay</th><th /></tr></thead>
            <tbody>{list.data.runs.map((r) => (
              <tr key={r.id}><td>{r.period}</td><td><Badge color={r.status === "paid" ? "green" : r.status === "posted" ? "blue" : "gray"}>{r.status}</Badge></td><td className="num">{r.employees}</td>
                <td className="num">{money(r.gross)}</td><td className="num">{money(r.net)}</td><td className="text-right"><Button size="sm" variant="ghost" onClick={() => setOpen(r.id)}>Open</Button></td></tr>
            ))}</tbody>
          </table></TableWrap>
        ) : <EmptyState title="No payroll yet" body="Add employees, then calculate the first month." />}
      </Card>
    </div>
  );
}

function Report() {
  const { path, money } = useCompany();
  const [range, setRange] = useState({ from: `${new Date().getUTCFullYear()}-01`, to: prevMonth() });
  const data = useApi<{ rows: any[] }>(path(`/payroll/report?from=${range.from}&to=${range.to}`));
  const rows = data.data?.rows ?? [];
  const tot = (k: string) => rows.reduce((t, r) => t + r[k], 0);
  const cols: [string, string][] = [["basic", "Basic"], ["hra", "HRA"], ["allowances", "Allow."], ["overtime", "OT"], ["gross", "Gross"], ["pf_employee", "PF"], ["esi_employee", "ESI"], ["pt", "PT"], ["tds", "TDS"], ["other_deductions", "Other"], ["net", "Net"], ["pf_employer", "PF (er)"], ["esi_employer", "ESI (er)"]];
  return (
    <Card padded={false} title="Salary register" actions={<div className="flex flex-wrap items-center gap-2">
      <Input type="month" aria-label="From" className="w-36" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
      <Input type="month" aria-label="To" className="w-36" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
      <Button size="sm" variant="secondary" disabled={!rows.length} onClick={() => downloadCsv(`salary-register-${range.from}-${range.to}.csv`, ["Month", "Code", "Name", "Paid days", ...cols.map((c) => c[1])], rows.map((r) => [r.period, r.code, r.name, r.paid_days_milli / 1000, ...cols.map((c) => (r[c[0]] / 100).toFixed(2))]))}>CSV</Button>
      <Button size="sm" variant="secondary" onClick={() => window.print()}><Printer className="h-4 w-4" />Print</Button>
    </div>}>
      {rows.length ? (
        <TableWrap><table className="table text-xs">
          <thead><tr><th>Month</th><th>Employee</th>{cols.map(([k, l]) => <th key={k} className="num">{l}</th>)}</tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i}><td>{r.period}</td><td>{r.code} · {r.name}</td>{cols.map(([k]) => <td key={k} className="num">{money(r[k])}</td>)}</tr>)}</tbody>
          <tfoot><tr><td colSpan={2}>Total</td>{cols.map(([k]) => <td key={k} className="num">{money(tot(k))}</td>)}</tr></tfoot>
        </table></TableWrap>
      ) : <EmptyState title="No posted payroll in this range" />}
    </Card>
  );
}

/** Form 24Q (TDS on salary) deductee rows for a quarter, for the NSDL Return Preparation Utility. */
function Tds24q() {
  const { path } = useCompany();
  const toast = useToast();
  const now = new Date();
  const currentFy = now.getUTCMonth() < 3 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
  const [v, setV] = useState({ fy: String(currentFy), quarter: "1" });
  const download = async () => {
    try {
      const r = await api.get<{ rows: any[]; header: string[]; problems: string[] }>(path(`/payroll/tds-24q?fy=${v.fy}&quarter=${v.quarter}`));
      if (!r.rows.length) return toast("info", "No TDS was deducted in that quarter");
      downloadCsv(`24Q-FY${v.fy}-Q${v.quarter}.csv`, r.header, r.rows.map((x) => [x.employee_ref, x.pan, x.name, x.section, x.payment_date, x.amount_paid, x.tds, x.deduction_date]));
      if (r.problems.length) toast("error", r.problems.join("; "));
    } catch (e) { toast("error", errorMessage(e)); }
  };
  return (
    <Card title="TDS on salary — Form 24Q" className="mt-4">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Financial year">{(fid) => <Select id={fid} value={v.fy} onChange={(e) => setV({ ...v, fy: e.target.value })}>{[0, 1, 2].map((k) => { const y = currentFy - k; return <option key={y} value={y}>{y}-{String(y + 1).slice(2)}</option>; })}</Select>}</Field>
        <Field label="Quarter">{(fid) => <Select id={fid} value={v.quarter} onChange={(e) => setV({ ...v, quarter: e.target.value })}><option value="1">Q1 Apr–Jun</option><option value="2">Q2 Jul–Sep</option><option value="3">Q3 Oct–Dec</option><option value="4">Q4 Jan–Mar</option></Select>}</Field>
        <Button variant="secondary" onClick={download}>Download deductee rows</Button>
      </div>
      <p className="mt-2 text-xs muted">Copy the rows into the deductee sheet of NSDL's free Return Preparation Utility, add the challan details, then validate with the FVU. LedgerFox does not file the return.</p>
    </Card>
  );
}

export default function Payroll() {
  const [tab, setTab] = useState<Tab>("runs");
  return (
    <>
      <PageHeader title="Payroll & timesheets" subtitle="Employees, monthly salary runs, payslips with QR verification, and the salary register." />
      <div className="mb-4"><Tabs value={tab} onChange={setTab} tabs={[{ value: "runs", label: "Payroll" }, { value: "employees", label: "Employees" }, { value: "timesheets", label: "Timesheets" }, { value: "report", label: "Salary report" }]} /></div>
      {tab === "runs" && <Runs />}
      {tab === "employees" && <Employees />}
      {tab === "timesheets" && <Timesheets />}
      {tab === "report" && <><Report /><Tds24q /></>}
    </>
  );
}
