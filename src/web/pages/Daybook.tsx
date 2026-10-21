import { useState } from "react";
import { Link } from "react-router";
import { Download } from "lucide-react";
import { useCompany } from "../lib/company";
import { useApi } from "../lib/hooks";
import { Alert, Button, Card, EmptyState, Field, Input, PageHeader, Select, Spinner, StatusBadge, TableWrap } from "../components/ui";
import { HistoryButton } from "../components/History";
import { DOC_LABELS, fmtDate, fmtDateTime, today, toInput } from "../lib/format";
import { downloadCsv } from "../lib/csv";

type Who = { by: string; at: string } | null;
interface Entry {
  entity_type: "document" | "payment" | "journal" | "expense"; id: string; type: string; number: string | null; date: string; party: string | null;
  amount: number; currency: string; status: string; branch_name: string | null;
  created_by_name: string | null; created_at: string; posted_by_name: string | null; posted_at: string | null;
  approved_by_name: string | null; approved_at: string | null; modified: Who; cancelled: Who;
}

const TYPE_LABEL: Record<string, string> = { receipt: "Receipt", payment: "Payment", journal: "Journal", expense: "Expense" };
const typeLabel = (t: string) => TYPE_LABEL[t] ?? DOC_LABELS[t]?.one ?? t;

function Stamp({ name, at }: { name: string | null | undefined; at: string | null | undefined }) {
  if (!name) return <span className="muted">—</span>;
  return <span title={at ? fmtDateTime(at) : undefined}>{name}<span className="block text-[11px] muted">{at ? fmtDateTime(at) : ""}</span></span>;
}

export default function Daybook() {
  const { path, money, id, branchQuery, settings } = useCompany();
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [type, setType] = useState("");
  const { data, error, loading } = useApi<{ entries: Entry[] }>(path(`/daybook?from=${from}&to=${to}&type=${type}${branchQuery}`));
  const link = (e: Entry) =>
    e.entity_type === "document" ? `/app/${id}/${["quote", "sales_order", "invoice", "credit_note"].includes(e.type) ? "sales" : "purchases"}/${e.type}/${e.id}`
    : e.entity_type === "payment" ? `/app/${id}/payments/view/${e.id}`
    : e.entity_type === "journal" ? `/app/${id}/journals/${e.id}` : `/app/${id}/expenses`;
  const csv = () => data && downloadCsv(`daybook-${from}-to-${to}.csv`,
    ["Date", "Type", "Number", "Party / memo", "Branch", "Amount", "Currency", "Status", "Created by", "Created at", "Modified by", "Modified at", "Approved by", "Posted by", "Posted at", "Cancelled by", "Cancelled at"],
    data.entries.map((e) => [e.date, typeLabel(e.type), e.number ?? "Draft", e.party ?? "", e.branch_name ?? "", toInput(e.amount, e.currency), e.currency, e.status,
      e.created_by_name ?? "", e.created_at, e.modified?.by ?? "", e.modified?.at ?? "", e.approved_by_name ?? "", e.posted_by_name ?? "", e.posted_at ?? "", e.cancelled?.by ?? "", e.cancelled?.at ?? ""]));
  const totals = (data?.entries ?? []).filter((e) => e.status !== "void" && e.status !== "draft" && e.currency === settings?.company.base_currency)
    .reduce((m, e) => ({ ...m, [e.type]: (m[e.type] ?? 0) + e.amount }), {} as Record<string, number>);
  return (
    <>
      <PageHeader title="Daybook" subtitle="Every transaction of the day with who created, modified, approved, posted and cancelled it."
        actions={data && <Button variant="secondary" onClick={csv}><Download className="h-4 w-4" />CSV</Button>} />
      <Card className="mb-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="From">{(fid) => <Input id={fid} type="date" value={from} onChange={(e) => { setFrom(e.target.value); if (e.target.value > to) setTo(e.target.value); }} />}</Field>
          <Field label="To">{(fid) => <Input id={fid} type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />}</Field>
          <Field label="Type">{(fid) => (
            <Select id={fid} value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">All</option>
              {["invoice", "credit_note", "quote", "sales_order", "receipt", "bill", "debit_note", "purchase_order", "payment", "journal", "expense"].map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}
            </Select>)}</Field>
          <Button variant="secondary" onClick={() => { setFrom(today()); setTo(today()); }}>Today</Button>
        </div>
        {Object.keys(totals).length > 0 && (
          <p className="mt-3 flex flex-wrap gap-4 text-sm">{Object.entries(totals).map(([t, v]) => <span key={t}><span className="muted">{typeLabel(t)}:</span> <b>{money(v)}</b></span>)}</p>
        )}
      </Card>
      {error && <Alert className="mb-3">{error}</Alert>}
      <Card padded={false}>
        {loading && !data ? <Spinner /> : !data?.entries.length ? <EmptyState title="Nothing recorded for these dates" /> : (
          <TableWrap><table className="table text-sm">
            <thead><tr><th>Date</th><th>Type</th><th>Number</th><th>Party / memo</th><th>Branch</th><th className="num">Amount</th><th>Status</th><th>Created</th><th>Modified</th><th>Approved</th><th>Posted</th><th>Cancelled</th><th /></tr></thead>
            <tbody>{data.entries.map((e) => (
              <tr key={`${e.entity_type}-${e.id}`}>
                <td className="whitespace-nowrap">{fmtDate(e.date, settings?.company.date_format)}</td>
                <td>{typeLabel(e.type)}</td>
                <td><Link className="font-medium text-brand-700 hover:underline dark:text-brand-300" to={link(e)}>{e.number ?? "Draft"}</Link></td>
                <td className="max-w-[14rem] truncate">{e.party}</td>
                <td>{e.branch_name ?? <span className="muted">—</span>}</td>
                <td className="num">{money(e.amount, e.currency)}</td>
                <td><StatusBadge status={e.status} /></td>
                <td><Stamp name={e.created_by_name} at={e.created_at} /></td>
                <td><Stamp name={e.modified?.by} at={e.modified?.at} /></td>
                <td><Stamp name={e.approved_by_name} at={e.approved_at} /></td>
                <td><Stamp name={e.posted_by_name} at={e.posted_at} /></td>
                <td><Stamp name={e.cancelled?.by} at={e.cancelled?.at} /></td>
                <td><HistoryButton type={e.entity_type} id={e.id} /></td>
              </tr>
            ))}</tbody>
          </table></TableWrap>
        )}
      </Card>
    </>
  );
}
