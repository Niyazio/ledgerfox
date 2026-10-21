import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import QRCode from "qrcode";
import { BadgeCheck, Printer, ShieldX, Smartphone } from "lucide-react";
import { upiLink } from "@shared/share";
import { useApi } from "../lib/hooks";
import { ProductCredit, Wordmark } from "../components/Layout";
import { Spinner } from "../components/ui";
import { fmtDate, money } from "../lib/format";

interface Result {
  valid: boolean; kind: string; number: string; date: string; status: string; currency: string; amount: number; settled?: number; gross?: number; party: string;
  issuer: { name: string; tax_id: string | null; country: string; address?: string | null; phone?: string | null; email?: string | null };
  // Present for sales documents shared with the customer.
  lines?: { description: string; hsn_sac: string | null; qty_milli: number; unit: string | null; unit_price: number; discount_bp: number; taxable: number; cgst: number; sgst: number; igst: number; other_tax: number; line_total: number }[];
  due_date?: string | null; balance?: number; subtotal?: number; tax_total?: number; round_off?: number; notes?: string | null; terms?: string | null;
  party_address?: string | null; party_tax_id?: string | null;
  pay?: { upi_id: string; payee: string; amount: number } | null;
}

/** Full document view for customers who received a shared link: items, totals, balance and UPI payment. */
function SharedDocument({ data }: { data: Result }) {
  const [qr, setQr] = useState<string | null>(null);
  const pay = data.pay ? upiLink(data.pay.upi_id, data.pay.payee, data.pay.amount, `${data.kind} ${data.number}`) : null;
  useEffect(() => { if (pay) QRCode.toDataURL(pay, { margin: 1, width: 220 }).then(setQr).catch(() => setQr(null)); }, [pay]);
  const m = (n: number | undefined) => money(n ?? 0, data.currency);
  const tax = (data.lines ?? []).reduce((t, l) => ({ cgst: t.cgst + l.cgst, sgst: t.sgst + l.sgst, igst: t.igst + l.igst, other: t.other + l.other_tax }), { cgst: 0, sgst: 0, igst: 0, other: 0 });
  return (
    <div className="print-area">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div><p className="text-lg font-semibold">{data.issuer.name}</p>
          {data.issuer.address && <p className="text-sm muted">{data.issuer.address}</p>}
          <p className="text-sm muted">{[data.issuer.tax_id && `GSTIN ${data.issuer.tax_id}`, data.issuer.phone, data.issuer.email].filter(Boolean).join(" · ")}</p></div>
        <div className="text-right"><p className="text-xl font-semibold">{data.kind}</p><p className="text-sm">{data.number}</p><p className="text-sm muted">{fmtDate(data.date)}{data.due_date ? ` · due ${fmtDate(data.due_date)}` : ""}</p></div>
      </div>
      <div className="mt-4 text-sm"><p className="muted">Bill to</p><p className="font-medium">{data.party}</p>{data.party_address && <p className="muted whitespace-pre-line">{data.party_address}</p>}{data.party_tax_id && <p className="muted">GSTIN {data.party_tax_id}</p>}</div>
      <div className="mt-4 overflow-x-auto"><table className="table text-sm">
        <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Rate</th><th className="num hidden sm:table-cell">Taxable</th><th className="num">Amount</th></tr></thead>
        <tbody>{(data.lines ?? []).map((l, i) => (
          <tr key={i}><td>{l.description}{l.hsn_sac ? <span className="block text-xs muted">HSN/SAC {l.hsn_sac}</span> : null}</td>
            <td className="num">{l.qty_milli / 1000}{l.unit ? ` ${l.unit}` : ""}</td><td className="num">{m(l.unit_price)}{l.discount_bp ? <span className="block text-xs muted">−{l.discount_bp / 100}%</span> : null}</td>
            <td className="num hidden sm:table-cell">{m(l.taxable)}</td><td className="num">{m(l.line_total)}</td></tr>
        ))}</tbody>
      </table></div>
      <dl className="ml-auto mt-3 max-w-xs space-y-1 text-sm">
        <div className="flex justify-between"><dt className="muted">Subtotal</dt><dd>{m(data.subtotal)}</dd></div>
        {tax.cgst > 0 && <div className="flex justify-between"><dt className="muted">CGST</dt><dd>{m(tax.cgst)}</dd></div>}
        {tax.sgst > 0 && <div className="flex justify-between"><dt className="muted">SGST</dt><dd>{m(tax.sgst)}</dd></div>}
        {tax.igst > 0 && <div className="flex justify-between"><dt className="muted">IGST</dt><dd>{m(tax.igst)}</dd></div>}
        {tax.other > 0 && <div className="flex justify-between"><dt className="muted">Tax</dt><dd>{m(tax.other)}</dd></div>}
        {!!data.round_off && <div className="flex justify-between"><dt className="muted">Round off</dt><dd>{m(data.round_off)}</dd></div>}
        <div className="flex justify-between border-t border-[var(--border)] pt-1 font-semibold"><dt>Total</dt><dd>{m(data.amount)}</dd></div>
        {data.kind === "Invoice" && <><div className="flex justify-between"><dt className="muted">Paid</dt><dd>{m(data.settled)}</dd></div>
          <div className="flex justify-between font-semibold"><dt>Balance due</dt><dd>{m(data.balance)}</dd></div></>}
      </dl>
      {pay && (
        <div className="no-print mt-5 rounded-lg border border-[var(--border)] p-4 text-center">
          <p className="font-medium">Pay {m(data.pay!.amount)} by UPI</p>
          <a href={pay} className="mt-3 inline-flex items-center gap-2 rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white sm:hidden"><Smartphone className="h-4 w-4" />Pay with a UPI app</a>
          {qr && <img src={qr} alt="UPI payment QR code" className="mx-auto mt-3 hidden h-44 w-44 sm:block" />}
          <p className="mt-2 text-xs muted">UPI ID {data.pay!.upi_id}. Payment goes directly to {data.pay!.payee}; it shows in their books once they record it.</p>
        </div>
      )}
      {data.terms && <p className="mt-4 whitespace-pre-line text-xs muted">{data.terms}</p>}
      <button onClick={() => window.print()} className="no-print mt-4 inline-flex items-center gap-2 text-sm text-brand-700 hover:underline dark:text-brand-300"><Printer className="h-4 w-4" />Print or save as PDF</button>
    </div>
  );
}

/** Public page opened by scanning the QR code printed on an invoice, receipt or payslip. */
export default function Verify() {
  const { token } = useParams();
  const { data, error, loading } = useApi<Result>(`/api/verify/${encodeURIComponent(token ?? "")}`);
  return (
    <div className="flex min-h-full items-center justify-center px-4 py-10">
      <div className={`w-full ${data?.lines ? "max-w-3xl" : "max-w-md"}`}>
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
          {data?.lines && <SharedDocument data={data} />}
          {data && !data.lines && (
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
