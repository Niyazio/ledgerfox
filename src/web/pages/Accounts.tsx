import { useMemo, useState } from "react";
import { Link } from "react-router";
import { Plus, Download } from "lucide-react";
import { useCompany, type Account } from "../lib/company";
import { api, errorMessage } from "../lib/api";
import { Alert, Badge, Button, Card, Field, Input, Modal, PageHeader, Select, TableWrap, Textarea, useToast } from "../components/ui";
import { SUBTYPES, isDebitNormal, type AccountType } from "@shared/coa";
import { downloadCsv } from "../lib/csv";
import { toInput } from "../lib/format";

function AccountForm({ initial, onClose }: { initial?: Account; onClose: (changed: boolean) => void }) {
  const { path, accounts, reloadAccounts } = useCompany();
  const toast = useToast();
  const [v, setV] = useState({
    code: initial?.code ?? "", name: initial?.name ?? "", type: (initial?.type ?? "expense") as AccountType, subtype: initial?.subtype ?? "operating_expense",
    parent_id: initial?.parent_id ?? "", is_group: Boolean(initial?.is_group), is_active: initial ? Boolean(initial.is_active) : true, description: initial?.description ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const parents = accounts.filter((a) => a.is_group && a.type === v.type && a.id !== initial?.id);
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const body = { ...v, parent_id: v.parent_id || null, description: v.description || null };
      if (initial) await api.patch(path(`/accounts/${initial.id}`), body);
      else await api.post(path("/accounts"), body);
      await reloadAccounts();
      toast("success", initial ? "Account updated" : "Account created");
      onClose(true);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={() => onClose(false)} title={initial ? `Edit ${initial.code} · ${initial.name}` : "New account"}
      footer={<><Button variant="secondary" onClick={() => onClose(false)}>Cancel</Button><Button loading={busy} onClick={save}>Save</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        {error && <Alert className="sm:col-span-2">{error}</Alert>}
        {initial?.system_key && <Alert kind="info" className="sm:col-span-2">System account ({initial.system_key}) — used automatically by postings. It can be renamed but not deleted.</Alert>}
        <Field label="Code" required>{(id) => <Input id={id} value={v.code} onChange={(e) => setV({ ...v, code: e.target.value })} />}</Field>
        <Field label="Name" required>{(id) => <Input id={id} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />}</Field>
        <Field label="Type">{(id) => (
          <Select id={id} value={v.type} onChange={(e) => { const t = e.target.value as AccountType; setV({ ...v, type: t, subtype: SUBTYPES[t][0].value, parent_id: "" }); }}>
            {Object.keys(SUBTYPES).map((t) => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}
          </Select>
        )}</Field>
        <Field label="Detail type" hint="Drives report placement (e.g. cash-flow section)">{(id) => (
          <Select id={id} value={v.subtype} onChange={(e) => setV({ ...v, subtype: e.target.value })}>{SUBTYPES[v.type].map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</Select>
        )}</Field>
        <Field label="Parent group">{(id) => (
          <Select id={id} value={v.parent_id} onChange={(e) => setV({ ...v, parent_id: e.target.value })}>
            <option value="">— none —</option>{parents.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
          </Select>
        )}</Field>
        <div className="flex flex-col justify-end gap-2 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" checked={v.is_group} onChange={(e) => setV({ ...v, is_group: e.target.checked })} /> Group (heading, not postable)</label>
          {initial && <label className="flex items-center gap-2"><input type="checkbox" checked={v.is_active} onChange={(e) => setV({ ...v, is_active: e.target.checked })} /> Active</label>}
        </div>
        <Field label="Description" className="sm:col-span-2">{(id) => <Textarea id={id} rows={2} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} />}</Field>
      </div>
    </Modal>
  );
}

export default function Accounts() {
  const { accounts, money, can, id, settings } = useCompany();
  const [edit, setEdit] = useState<Account | "new" | null>(null);
  const [q, setQ] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const toast = useToast();
  const { path, reloadAccounts } = useCompany();
  const tree = useMemo(() => {
    const byParent = new Map<string | null, Account[]>();
    for (const a of accounts) {
      const k = a.parent_id;
      byParent.set(k, [...(byParent.get(k) ?? []), a]);
    }
    const out: { a: Account; depth: number }[] = [];
    const walk = (pid: string | null, depth: number) => {
      for (const a of (byParent.get(pid) ?? []).sort((x, y) => x.code.localeCompare(y.code))) { out.push({ a, depth }); walk(a.id, depth + 1); }
    };
    walk(null, 0);
    return out;
  }, [accounts]);
  const filtered = tree.filter(({ a }) => (showInactive || a.is_active) && (!q || `${a.code} ${a.name}`.toLowerCase().includes(q.toLowerCase())));
  const balance = (a: Account) => (isDebitNormal(a.type as AccountType) ? 1 : -1) * (a.debit_total - a.credit_total);
  const cur = settings?.company.base_currency ?? "INR";
  return (
    <>
      <PageHeader title="Chart of accounts" subtitle="Group accounts organise the chart; only ledger accounts accept postings."
        actions={<>
          <Button variant="secondary" onClick={() => downloadCsv("chart-of-accounts.csv", ["Code", "Name", "Type", "Detail type", "Group", "Active", "Balance"], tree.map(({ a }) => [a.code, a.name, a.type, a.subtype, a.is_group ? "yes" : "no", a.is_active ? "yes" : "no", a.is_group ? "" : toInput(balance(a), cur)]))}><Download className="h-4 w-4" />CSV</Button>
          {can("accounts.write") && <Button onClick={() => setEdit("new")}><Plus className="h-4 w-4" />New account</Button>}
        </>} />
      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-3 border-b border-[var(--border)] p-3">
          <Input placeholder="Search code or name…" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" aria-label="Search accounts" />
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive</label>
        </div>
        <TableWrap>
          <table className="table">
            <thead><tr><th>Code</th><th>Name</th><th>Type</th><th className="num">Balance</th><th className="no-print" /></tr></thead>
            <tbody>
              {filtered.map(({ a, depth }) => (
                <tr key={a.id} className={a.is_active ? "" : "opacity-60"}>
                  <td className="font-mono text-xs">{a.code}</td>
                  <td style={{ paddingLeft: `${0.75 + depth * 1.1}rem` }}>
                    {a.is_group ? <span className="font-semibold">{a.name}</span> : <Link className="hover:underline" to={`/app/${id}/reports/general-ledger?account_id=${a.id}`}>{a.name}</Link>}
                    {a.system_key && <span className="ml-2"><Badge color="blue">system</Badge></span>}
                    {!a.is_active && <span className="ml-2"><Badge>inactive</Badge></span>}
                  </td>
                  <td className="text-xs muted">{a.type} · {a.subtype.replace(/_/g, " ")}</td>
                  <td className="num">{a.is_group ? "" : money(balance(a))}</td>
                  <td className="no-print text-right">
                    {can("accounts.write") && <Button size="sm" variant="ghost" onClick={() => setEdit(a)}>Edit</Button>}
                    {can("accounts.write") && !a.system_key && !a.debit_total && !a.credit_total && (
                      <Button size="sm" variant="ghost" onClick={async () => {
                        try { await api.del(path(`/accounts/${a.id}`)); await reloadAccounts(); toast("success", "Account deleted"); } catch (e) { toast("error", errorMessage(e)); }
                      }}>Delete</Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </Card>
      {edit && <AccountForm initial={edit === "new" ? undefined : edit} onClose={() => setEdit(null)} />}
    </>
  );
}
