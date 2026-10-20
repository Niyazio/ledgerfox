import { Link, useParams } from "react-router";
import { BadgeCheck, ShieldX } from "lucide-react";
import { useApi } from "../lib/hooks";
import { ProductCredit, Wordmark } from "../components/Layout";
import { Spinner } from "../components/ui";
import { fmtDate, money } from "../lib/format";

interface Result {
  valid: boolean; kind: string; number: string; date: string; status: string; currency: string; amount: number; settled?: number; gross?: number; party: string;
  issuer: { name: string; tax_id: string | null; country: string };
}

/** Public page opened by scanning the QR code printed on an invoice, receipt or payslip. */
export default function Verify() {
  const { token } = useParams();
  const { data, error, loading } = useApi<Result>(`/api/verify/${encodeURIComponent(token ?? "")}`);
  return (
    <div className="flex min-h-full items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <Link to="/" className="mb-6 flex justify-center text-lg"><Wordmark iconClass="h-8 w-8" /></Link>
        <div className="card p-6 shadow-sm">
          {loading && <Spinner />}
          {error && (
            <div className="text-center">
              <ShieldX className="mx-auto h-12 w-12 text-red-600" />
              <h1 className="mt-3 text-xl font-semibold">Not verified</h1>
              <p className="mt-1 text-sm muted">This code does not match any record. The document may be altered or not issued through LedgerFox.</p>
            </div>
          )}
          {data && (
            <>
              <div className="text-center">
                {data.valid ? <BadgeCheck className="mx-auto h-12 w-12 text-emerald-600" /> : <ShieldX className="mx-auto h-12 w-12 text-amber-600" />}
                <h1 className="mt-3 text-xl font-semibold">{data.valid ? `Genuine ${data.kind.toLowerCase()}` : `${data.kind} is ${data.status}`}</h1>
                <p className="mt-1 text-sm muted">Issued by <b>{data.issuer.name}</b>{data.issuer.tax_id ? ` · ${data.issuer.tax_id}` : ""}</p>
              </div>
              <dl className="mt-6 space-y-2 text-sm">
                <div className="flex justify-between"><dt className="muted">Number</dt><dd className="font-medium">{data.number}</dd></div>
                <div className="flex justify-between"><dt className="muted">Date</dt><dd>{data.date.length === 7 ? data.date : fmtDate(data.date)}</dd></div>
                <div className="flex justify-between"><dt className="muted">{data.kind === "Payslip" ? "Employee" : "Party"}</dt><dd>{data.party}</dd></div>
                <div className="flex justify-between"><dt className="muted">{data.kind === "Payslip" ? "Net pay" : "Amount"}</dt><dd className="num font-semibold">{money(data.amount, data.currency)}</dd></div>
                {data.settled !== undefined && data.kind === "Invoice" && <div className="flex justify-between"><dt className="muted">Paid so far</dt><dd className="num">{money(data.settled, data.currency)}</dd></div>}
                <div className="flex justify-between"><dt className="muted">Status</dt><dd className="capitalize">{data.status}</dd></div>
              </dl>
              <p className="mt-6 text-xs muted">Compare these details with the paper or PDF you have. Any difference means the copy was changed.</p>
            </>
          )}
        </div>
        <ProductCredit className="mt-4 text-center" />
      </div>
    </div>
  );
}
