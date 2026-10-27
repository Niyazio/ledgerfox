import { useState } from "react";
import { Link, Navigate } from "react-router";
import { useSession } from "../lib/session";
import { useApi } from "../lib/hooks";
import { Alert, Badge, Card, DownloadButtons, EmptyState, Input, Spinner, TableWrap } from "../components/ui";
import { Wordmark } from "../components/Layout";
import { ROLE_LABELS, type Role } from "@shared/permissions";
import { downloadCsv } from "../lib/csv";

interface ClientRow {
  company_id: string; name: string; gstin: string | null; currency: string; org_name: string; role: Role; figures: boolean;
  stats: { sales_month: number; receivables: number; payables: number; overdue: number; drafts: number; approvals: number; unmatched: number; last_entry: string | null } | null;
}

const fmt = (minor: number, cur: string) => new Intl.NumberFormat("en-IN", { style: "currency", currency: cur, maximumFractionDigits: 0 }).format(minor / 100);

/** Practice view: every company this login can open, with what needs attention. For accountants with many clients. */
export default function Clients() {
  const { me, loading } = useSession();
  const data = useApi<{ clients: ClientRow[]; month: string }>(me?.user ? "/api/clients" : null);
  const [q, setQ] = useState("");
  if (loading) return <Spinner />;
  if (!me?.user) return <Navigate to="/login?next=/app/clients" replace />;
  const rows = (data.data?.clients ?? []).filter((r) => !q || `${r.name} ${r.org_name} ${r.gstin ?? ""}`.toLowerCase().includes(q.toLowerCase()));
  const attention = (r: ClientRow) => (r.stats ? r.stats.overdue + r.stats.drafts + r.stats.approvals + r.stats.unmatched : 0);
  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between"><Wordmark brand={me.brand} /><Link to="/app" className="text-sm text-brand-700 hover:underline dark:text-brand-300">Choose a company</Link></div>
      <h1 className="text-2xl font-semibold">Clients</h1>
      <p className="mb-4 mt-1 text-sm muted">Every company you have been invited to. Figures appear where your role can see reports for the whole company. Ask a client to invite you (Users → Invite, role Accountant or Auditor) to add them here.</p>
      {data.error && <Alert className="mb-4">{data.error}</Alert>}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Input className="max-w-xs" placeholder="Search name, organisation or GSTIN" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search clients" />
        <DownloadButtons size="sm" disabled={!rows.length} onDownload={() => downloadCsv(`clients-${data.data?.month}.csv`,
          ["Company", "Organisation", "GSTIN", "Role", "Sales this month", "Receivables", "Payables", "Overdue invoices", "Drafts", "Expenses to approve", "Unmatched bank lines", "Last entry"],
          rows.map((r) => [r.name, r.org_name, r.gstin ?? "", ROLE_LABELS[r.role] ?? r.role, ...(r.stats ? [r.stats.sales_month / 100, r.stats.receivables / 100, r.stats.payables / 100, r.stats.overdue, r.stats.drafts, r.stats.approvals, r.stats.unmatched, r.stats.last_entry ?? ""] : ["", "", "", "", "", "", "", ""])]))} />
      </div>
      <Card padded={false}>
        {data.loading && !data.data ? <Spinner /> : !rows.length ? <EmptyState title="No client companies" body="When a business invites you, it appears here." /> : (
          <TableWrap><table className="table">
            <thead><tr><th>Company</th><th>Your role</th><th className="num">Sales this month</th><th className="num">Receivables</th><th className="num">Payables</th><th>Needs attention</th><th>Last entry</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.company_id}>
                <td><Link className="font-medium text-brand-700 hover:underline dark:text-brand-300" to={`/app/${r.company_id}/dashboard`}>{r.name}</Link>
                  <span className="block text-xs muted">{r.org_name}{r.gstin ? ` · ${r.gstin}` : ""}</span></td>
                <td>{ROLE_LABELS[r.role] ?? r.role}</td>
                {r.stats ? <>
                  <td className="num">{fmt(r.stats.sales_month, r.currency)}</td>
                  <td className="num">{fmt(r.stats.receivables, r.currency)}</td>
                  <td className="num">{fmt(r.stats.payables, r.currency)}</td>
                  <td className="space-x-1">{attention(r) === 0 ? <Badge color="green">up to date</Badge> : <>
                    {r.stats.overdue > 0 && <Badge color="red">{r.stats.overdue} overdue</Badge>}
                    {r.stats.drafts > 0 && <Badge color="amber">{r.stats.drafts} drafts</Badge>}
                    {r.stats.approvals > 0 && <Badge color="amber">{r.stats.approvals} to approve</Badge>}
                    {r.stats.unmatched > 0 && <Badge color="blue">{r.stats.unmatched} bank lines</Badge>}
                  </>}</td>
                  <td className="text-sm">{r.stats.last_entry ?? "—"}</td>
                </> : <td colSpan={5} className="text-sm muted">Figures hidden: your access is limited to some branches or excludes reports.</td>}
              </tr>
            ))}</tbody>
          </table></TableWrap>
        )}
      </Card>
    </div>
  );
}
