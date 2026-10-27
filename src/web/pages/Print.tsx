import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useParams, useSearchParams } from "react-router";
import QRCode from "qrcode";
import { bilingual, type Lang } from "@shared/i18n";
import { ArrowLeft, Printer, Share2 } from "lucide-react";
import { api } from "../lib/api";
import { useApi } from "../lib/hooks";
import { useCompany, CompanyProvider } from "../lib/company";
import { useSession } from "../lib/session";
import { DOC_LABELS, SALES_DOCS, fmtDate, qty as fmtQty, pct } from "../lib/format";
import { Alert, Spinner } from "../components/ui";
import { INDIA_STATES } from "@shared/tax";
import { amountInWords } from "@shared/words";
import { currencyExponent } from "@shared/currencies";
import { printPage } from "../lib/download";

/** Paper formats. Thermal formats suit 80 mm and 58 mm receipt printers (POS, restaurant, retail counters). */
export const FORMATS = {
  modern: { label: "A4 — modern", page: "A4", width: "210mm" },
  classic: { label: "A4 — classic", page: "A4", width: "210mm" },
  a5: { label: "A5 — half page", page: "A5", width: "148mm" },
  thermal80: { label: "Thermal 80 mm", page: "80mm auto", width: "80mm" },
  thermal58: { label: "Thermal 58 mm", page: "58mm auto", width: "58mm" },
} as const;
export type Format = keyof typeof FORMATS;
type Kind = "document" | "payment" | "payslip";

/** Logo and the business's own payment QR image, loaded once per preview. */
const BrandingCtx = createContext<{ logo: string | null; payment_qr: string | null }>({ logo: null, payment_qr: null });

function useQr(text: string | null, size = 220) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (!text) { setSrc(null); return; }
    QRCode.toDataURL(text, { margin: 1, width: size, errorCorrectionLevel: "M" }).then((u) => { if (live) setSrc(u); }).catch(() => setSrc(null));
    return () => { live = false; };
  }, [text, size]);
  return src;
}

function useVerifyLink(kind: Kind, id: string, enabled: boolean, summary: string) {
  const { path } = useCompany();
  const { me } = useSession();
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    api.post<{ token: string }>(path("/verify"), { entity_type: kind, entity_id: id }).then((r) => setToken(r.token)).catch(() => setToken(null));
  }, [kind, id, enabled, path]);
  if (!token) return null;
  // The desktop edition is not reachable from the internet, so its QR carries the details plus a reference instead of a link.
  if (me?.edition === "desktop") return `${summary}\nVerification ref: ${token}`;
  return `${location.origin}/verify/${token}`;
}

function Sheet({ format, children }: { format: Format; children: ReactNode }) {
  const f = FORMATS[format];
  const thermal = format.startsWith("thermal");
  return (
    <>
      <style>{`@page { size: ${f.page}; margin: ${thermal ? "2mm" : "12mm"}; } @media print { body { background: #fff; } }`}</style>
      <div className={`print-sheet mx-auto bg-white text-slate-900 shadow-lg print:shadow-none ${thermal ? "p-2 font-mono text-[11px] leading-snug" : "p-8 text-[13px]"}`}
        style={{ width: f.width, maxWidth: "100%", minHeight: thermal ? undefined : format === "a5" ? "210mm" : "297mm" }}>
        {children}
      </div>
    </>
  );
}

function Qr({ src, label, size = 96 }: { src: string | null; label: string; size?: number }) {
  if (!src) return null;
  return (
    <figure className="flex flex-col items-center gap-1 text-center">
      <img src={src} alt={label} width={size} height={size} />
      <figcaption className="text-[10px] text-slate-500">{label}</figcaption>
    </figure>
  );
}

function CompanyBlock({ thermal, center }: { thermal?: boolean; center?: boolean }) {
  const { settings } = useCompany();
  const { logo } = useContext(BrandingCtx);
  const co = settings!.company;
  const india = co.country === "IN";
  return (
    <div className={`${center ? "text-center" : ""} ${logo && !center ? "flex items-start gap-4" : ""}`}>
      {logo && <img src={logo} alt="" className={thermal ? "mx-auto mb-1 max-h-12 max-w-[60%] object-contain grayscale" : center ? "mx-auto mb-2 max-h-16 max-w-[40%] object-contain" : "max-h-20 max-w-[140px] object-contain"} />}
      <div>
      <p className={thermal ? "text-[13px] font-bold" : "text-xl font-bold tracking-tight"}>{co.legal_name || co.name}</p>
      <p className="whitespace-pre-line text-slate-600">{[co.address, [co.city, co.postal_code].filter(Boolean).join(" "), co.state_code && india ? `${INDIA_STATES[co.state_code] ?? ""} (${co.state_code})` : null].filter(Boolean).join(thermal ? ", " : "\n")}</p>
      {co.tax_id && <p>{india ? "GSTIN" : "Tax ID"}: <b className="font-mono">{co.tax_id}</b></p>}
      {(co.phone || co.email) && <p className="text-slate-600">{[co.phone, co.email].filter(Boolean).join(" · ")}</p>}
      </div>
    </div>
  );
}

// ── Invoice, bill, quotation, notes ─────────────────────────────────────────────────────────────────────────────
function DocumentPrint({ id, format, showQr, showUpi }: { id: string; format: Format; showQr: boolean; showUpi: boolean }) {
  const { path, money, settings } = useCompany();
  const { data, error } = useApi<any>(path(`/documents/${id}`));
  const d = data?.document;
  const co = settings!.company;
  const india = co.country === "IN";
  const cur = d?.currency ?? co.base_currency;
  const lines: any[] = data?.lines ?? [];
  const sales = d ? SALES_DOCS.includes(d.doc_type) : true;
  const outstanding = d ? d.total - d.amount_settled : 0;
  const summary = d ? `${co.legal_name || co.name}${co.tax_id ? ` (${co.tax_id})` : ""}\n${DOC_LABELS[d.variant ?? d.doc_type]?.one} ${d.number ?? "DRAFT"} dated ${d.issue_date}\nTotal ${money(d.total, cur)}` : "";
  const verify = useQr(useVerifyLink("document", id, showQr && Boolean(d && d.status !== "draft"), summary));
  const upiText = d && sales && d.doc_type === "invoice" && co.upi_id && cur === "INR" && outstanding > 0
    ? `upi://pay?pa=${encodeURIComponent(co.upi_id)}&pn=${encodeURIComponent(co.legal_name || co.name)}&am=${(outstanding / 100).toFixed(2)}&cu=INR&tn=${encodeURIComponent(`Invoice ${d.number ?? ""}`)}`
    : null;
  const generatedUpi = useQr(showUpi ? upiText : null);
  const { payment_qr } = useContext(BrandingCtx);
  // The business's own QR image (fixed, no amount) takes precedence; otherwise a UPI QR with the balance due.
  const upi = showUpi && d && sales && d.doc_type === "invoice" && outstanding > 0 && payment_qr ? payment_qr : generatedUpi;
  const payLabel = payment_qr && upi === payment_qr ? `Scan to pay${co.upi_id ? ` · ${co.upi_id}` : ""}` : null;
  // GST e-invoice: the IRP's signed QR must be printed on the invoice (not for cancelled IRNs).
  const gst = data?.gst_refs as { irn: string | null; ack_no: string | null; ack_date: string | null; signed_qr: string | null; irn_cancelled: number; ewb_no: string | null; ewb_date: string | null } | null | undefined;
  const irnQr = useQr(gst?.irn && !gst.irn_cancelled ? gst.signed_qr : null, 300);
  if (error) return <Alert>{error}</Alert>;
  if (!d) return <Spinner />;
  const df = co.date_format;
  const taxes = { cgst: sum(lines, "cgst"), sgst: sum(lines, "sgst"), igst: sum(lines, "igst"), other: sum(lines, "other_tax") };
  const title = d.doc_type === "invoice" && india ? (taxes.cgst || taxes.sgst || taxes.igst ? "Tax Invoice" : "Bill of Supply") : DOC_LABELS[d.variant ?? d.doc_type].one;
  const words = amountInWords(d.total, cur, currencyExponent(cur));
  const thermal = format.startsWith("thermal");
  const watermark = d.status === "draft" ? "DRAFT" : d.status === "void" ? "VOID" : null;
  const L = (en: string) => bilingual(en, co.print_language as Lang | undefined);

  if (thermal) {
    return (
      <Sheet format={format}>
        <CompanyBlock thermal center />
        <Rule />
        <p className="text-center font-bold uppercase">{L(title)}</p>
        <p className="flex justify-between"><span>No: {d.number ?? "DRAFT"}</span><span>{fmtDate(d.issue_date, df)}</span></p>
        <p>{sales ? "To" : "From"}: {d.contact_name}</p>
        {d.contact_tax_id && <p>GSTIN: {d.contact_tax_id}</p>}
        <Rule />
        {lines.map((l) => (
          <div key={l.id} className="mb-1">
            <p className="font-semibold">{l.description}</p>
            {l.batch_no && <p>Batch {l.batch_no}{l.expiry_date ? ` Exp ${l.expiry_date.slice(5, 7)}/${l.expiry_date.slice(0, 4)}` : ""}</p>}
            <p className="flex justify-between"><span>{fmtQty(l.qty_milli)} × {money(l.unit_price, cur)}</span><span>{money(l.line_total, cur)}</span></p>
          </div>
        ))}
        <Rule />
        <Row k={L("Taxable")} v={money(d.subtotal - d.discount_total, cur)} />
        {taxes.cgst > 0 && <Row k="CGST" v={money(taxes.cgst, cur)} />}
        {taxes.sgst > 0 && <Row k="SGST" v={money(taxes.sgst, cur)} />}
        {taxes.igst > 0 && <Row k="IGST" v={money(taxes.igst, cur)} />}
        {taxes.other > 0 && <Row k="Tax" v={money(taxes.other, cur)} />}
        {d.round_off !== 0 && <Row k={L("Round off")} v={money(d.round_off, cur)} />}
        <p className="mt-1 flex justify-between border-y border-dashed border-slate-500 py-1 text-[13px] font-bold"><span>{L("Total").toUpperCase()}</span><span>{money(d.total, cur)}</span></p>
        <p className="mt-1 text-[10px]">{words}</p>
        {gst?.irn && !gst.irn_cancelled && <div className="mt-2 text-center text-[9px]"><p className="break-all">IRN {gst.irn}</p>{gst.ack_no && <p>Ack {gst.ack_no} · {gst.ack_date}</p>}{irnQr && <img src={irnQr} alt="e-invoice QR" className="mx-auto mt-1 h-32 w-32" />}</div>}
        {gst?.ewb_no && <p className="mt-1 text-center text-[10px]">E-way bill {gst.ewb_no}</p>}
        <div className="mt-2 flex justify-center gap-3"><Qr src={upi} label={payLabel ?? L("Scan to pay (UPI)")} size={110} /><Qr src={verify} label={L("Scan to verify")} size={90} /></div>
        {watermark && <p className="mt-2 text-center font-bold">*** {watermark} ***</p>}
        <p className="mt-2 text-center">{L("Thank you! Visit again.")}</p>
      </Sheet>
    );
  }

  const classic = format === "classic";
  return (
    <Sheet format={format}>
      <div className="relative">
        {watermark && <p className="pointer-events-none absolute inset-x-0 top-1/3 -rotate-12 text-center text-7xl font-black tracking-widest text-red-500/15">{watermark}</p>}
        {classic ? (
          <header className="border-2 border-slate-800 p-3 text-center">
            <CompanyBlock center />
            <p className="mt-2 border-t border-slate-800 pt-1 text-base font-bold uppercase tracking-widest">{L(title)}</p>
          </header>
        ) : (
          <header className="flex items-start justify-between gap-6 border-b-4 border-brand-700 pb-5">
            <CompanyBlock />
            <div className="text-right">
              <p className="inline-block rounded-md bg-brand-700 px-3 py-1 text-sm font-semibold uppercase tracking-wider text-white">{L(title)}</p>
              <dl className="mt-3 space-y-0.5">
                <Meta k={L("Number")} v={<b>{d.number ?? "DRAFT"}</b>} />
                <Meta k={L("Date")} v={fmtDate(d.issue_date, df)} />
                {d.due_date && <Meta k={L("Due date")} v={fmtDate(d.due_date, df)} />}
                {d.reference && <Meta k={L("Reference")} v={d.reference} />}
              </dl>
            </div>
          </header>
        )}
        {(gst?.irn || gst?.ewb_no) && (
          <section className={`flex items-start justify-between gap-4 text-[11px] ${classic ? "border-x-2 border-b-2 border-slate-800 p-3" : "border-b border-slate-200 py-3"}`}>
            <dl className="space-y-0.5">
              {gst.irn && <div><dt className="inline text-slate-500">IRN: </dt><dd className="inline break-all font-mono">{gst.irn}{gst.irn_cancelled ? " (cancelled)" : ""}</dd></div>}
              {gst.ack_no && <div><dt className="inline text-slate-500">Ack No: </dt><dd className="inline font-mono">{gst.ack_no}</dd><dt className="ml-3 inline text-slate-500">Ack Date: </dt><dd className="inline">{gst.ack_date}</dd></div>}
              {gst.ewb_no && <div><dt className="inline text-slate-500">E-way bill: </dt><dd className="inline font-mono">{gst.ewb_no}</dd>{gst.ewb_date && <><dt className="ml-3 inline text-slate-500">Date: </dt><dd className="inline">{gst.ewb_date}</dd></>}</div>}
            </dl>
            {irnQr && <figure className="shrink-0 text-center"><img src={irnQr} alt="e-invoice QR" className="h-28 w-28" /><figcaption className="text-[9px] text-slate-500">e-Invoice QR</figcaption></figure>}
          </section>
        )}
        <section className={`grid grid-cols-2 gap-6 ${classic ? "border-x-2 border-b-2 border-slate-800 p-3" : "py-5"}`}>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{sales ? L("Bill to") : L("Supplier")}</p>
            <p className="mt-1 text-base font-semibold">{d.contact_name}</p>
            <p className="whitespace-pre-line text-slate-600">{d.contact_address}</p>
            {d.contact_tax_id && <p>{india ? "GSTIN" : "Tax ID"}: <span className="font-mono">{d.contact_tax_id}</span></p>}
            {d.contact_phone && <p className="text-slate-600">{d.contact_phone}</p>}
          </div>
          <div className="text-right">
            {classic && <dl className="space-y-0.5"><Meta k={L("Number")} v={<b>{d.number ?? "DRAFT"}</b>} /><Meta k={L("Date")} v={fmtDate(d.issue_date, df)} />{d.due_date && <Meta k={L("Due date")} v={fmtDate(d.due_date, df)} />}</dl>}
            {india && sales && d.place_of_supply && <p className="mt-1"><span className="text-slate-500">{L("Place of supply")}: </span>{INDIA_STATES[d.place_of_supply] ?? ""} ({d.place_of_supply})</p>}
            {d.contact_shipping_address && <><p className="mt-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">{L("Ship to")}</p><p className="whitespace-pre-line text-slate-600">{d.contact_shipping_address}</p></>}
          </div>
        </section>
        <table className={`w-full border-collapse ${classic ? "border-2 border-slate-800" : ""}`}>
          <thead>
            <tr className={classic ? "border-b-2 border-slate-800" : "bg-brand-700 text-white"}>
              {["#", L("Description"), ...(india ? ["HSN/SAC"] : []), L("Qty"), L("Rate"), ...(lines.some((l) => l.discount_bp) ? [L("Disc.")] : []), L("Taxable"), L("Tax"), L("Amount")].map((h, i) => (
                <th key={h} className={`px-2 py-2 text-[11px] font-semibold uppercase ${i > (india ? 2 : 1) ? "text-right" : "text-left"} ${classic ? "border border-slate-800" : ""}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.id} className={classic ? "" : i % 2 ? "bg-slate-50" : ""}>
                <Td c={classic}>{l.line_no}</Td>
                <Td c={classic}><span className="font-medium">{l.description}</span>{l.batch_no && <span className="block text-[11px] text-slate-500">Batch {l.batch_no}{l.expiry_date ? ` · Exp ${l.expiry_date.slice(5, 7)}/${l.expiry_date.slice(0, 4)}` : ""}</span>}</Td>
                {india && <Td c={classic}><span className="font-mono text-[11px]">{l.hsn_sac}</span></Td>}
                <Td c={classic} r>{fmtQty(l.qty_milli)} {l.unit ?? ""}</Td>
                <Td c={classic} r>{money(l.unit_price, cur)}</Td>
                {lines.some((x) => x.discount_bp) && <Td c={classic} r>{l.discount_bp ? pct(l.discount_bp) : ""}</Td>}
                <Td c={classic} r>{money(l.taxable, cur)}</Td>
                <Td c={classic} r>{l.tax_code_name && <span className="block text-[10px] text-slate-500">{l.tax_code_name}</span>}{money(l.cgst + l.sgst + l.igst + l.other_tax, cur)}</Td>
                <Td c={classic} r><b>{money(l.line_total, cur)}</b></Td>
              </tr>
            ))}
          </tbody>
        </table>
        <section className="mt-5 flex justify-between gap-6">
          <div className="max-w-sm space-y-3">
            <div><p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{L("Amount in words")}</p><p className="font-medium">{words}</p></div>
            {d.notes && <div><p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Notes</p><p className="whitespace-pre-line">{d.notes}</p></div>}
            {d.terms && <div><p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Terms &amp; conditions</p><p className="whitespace-pre-line text-slate-600">{d.terms}</p></div>}
            <div className="flex gap-4 pt-1"><Qr src={upi} label={payLabel ? `${payLabel} · ${money(outstanding, cur)} due` : `Scan to pay ${money(outstanding, cur)} by UPI`} size={104} /><Qr src={verify} label="Scan to verify this document" size={92} /></div>
          </div>
          <div className="w-72">
            <dl className={`space-y-1 ${classic ? "border-2 border-slate-800 p-3" : "rounded-lg bg-slate-50 p-4"}`}>
              <Row k={L("Taxable value")} v={money(d.subtotal - d.discount_total, cur)} />
              {taxes.cgst > 0 && <Row k="CGST" v={money(taxes.cgst, cur)} />}
              {taxes.sgst > 0 && <Row k="SGST" v={money(taxes.sgst, cur)} />}
              {taxes.igst > 0 && <Row k="IGST" v={money(taxes.igst, cur)} />}
              {taxes.other > 0 && <Row k="Tax" v={money(taxes.other, cur)} />}
              {d.round_off !== 0 && <Row k={L("Round off")} v={money(d.round_off, cur)} />}
              <p className={`flex justify-between border-t pt-2 text-base font-bold ${classic ? "border-slate-800" : "border-brand-700 text-brand-800"}`}><span>{L("Total")}</span><span>{money(d.total, cur)}</span></p>
              {d.status === "posted" && d.amount_settled > 0 && <><Row k={L("Paid")} v={money(d.amount_settled, cur)} /><Row k={L("Balance due")} v={<b>{money(outstanding, cur)}</b>} /></>}
            </dl>
            <div className="mt-12 text-center"><div className="mx-auto w-48 border-t border-slate-400" /><p className="mt-1 text-[11px] text-slate-500">{L("Authorised signatory for")} {co.legal_name || co.name}</p></div>
          </div>
        </section>
        <p className="mt-8 text-center text-[10px] text-slate-400">This is a computer-generated document. {cur !== co.base_currency ? `1 ${cur} = ${d.fx_rate_scaled / 1e9} ${co.base_currency}.` : ""}</p>
      </div>
    </Sheet>
  );
}

// ── Payment receipt / voucher ──────────────────────────────────────────────────────────────────────────────────
function PaymentPrint({ id, format, showQr }: { id: string; format: Format; showQr: boolean }) {
  const { path, money, settings } = useCompany();
  const { data, error } = useApi<any>(path(`/payments/${id}`));
  const p = data?.payment;
  const co = settings!.company;
  const summary = p ? `${co.legal_name || co.name}\n${p.direction === "in" ? "Receipt" : "Payment"} ${p.number} dated ${p.payment_date}\nAmount ${money(p.amount, p.currency)}` : "";
  const verify = useQr(useVerifyLink("payment", id, showQr && Boolean(p), summary));
  if (error) return <Alert>{error}</Alert>;
  if (!p) return <Spinner />;
  const title = p.direction === "in" ? "Payment Receipt" : "Payment Voucher";
  const words = amountInWords(p.amount, p.currency, currencyExponent(p.currency));
  const thermal = format.startsWith("thermal");
  const allocs: any[] = data.allocations ?? [];
  const body = (
    <>
      <p className={thermal ? "" : "text-base"}>{p.direction === "in" ? "Received with thanks from" : "Paid to"} <b>{p.contact_name}</b> the sum of <b>{money(p.amount, p.currency)}</b></p>
      <p className="mt-1 italic">({words})</p>
      <dl className="mt-3 space-y-0.5">
        <Row k="Mode" v={`${String(p.method ?? "").replace(/_/g, " ")}${p.reference ? ` · ${p.reference}` : ""}`} />
        <Row k={p.direction === "in" ? "Deposited to" : "Paid from"} v={p.account_name} />
        {allocs.filter((a) => !a.reverses_id && a.amount > 0).map((a) => <Row key={a.id} k={`Against ${DOC_LABELS[a.doc_type]?.one ?? ""} ${a.number}`} v={money(a.amount, p.currency)} />)}
        {p.status === "void" && <Row k="Status" v={<b className="text-red-600">VOID</b>} />}
      </dl>
    </>
  );
  if (thermal) {
    return (
      <Sheet format={format}>
        <CompanyBlock thermal center />
        <Rule />
        <p className="text-center font-bold uppercase">{title}</p>
        <p className="flex justify-between"><span>No: {p.number}</span><span>{fmtDate(p.payment_date, co.date_format)}</span></p>
        <Rule />
        {body}
        <div className="mt-2 flex justify-center"><Qr src={verify} label="Scan to verify" size={90} /></div>
      </Sheet>
    );
  }
  return (
    <Sheet format={format === "modern" || format === "classic" ? "a5" : format}>
      <header className="flex items-start justify-between gap-4 border-b-4 border-brand-700 pb-4">
        <CompanyBlock />
        <div className="text-right">
          <p className="inline-block rounded-md bg-brand-700 px-3 py-1 text-sm font-semibold uppercase tracking-wider text-white">{title}</p>
          <dl className="mt-3"><Meta k="No." v={<b>{p.number}</b>} /><Meta k="Date" v={fmtDate(p.payment_date, co.date_format)} /></dl>
        </div>
      </header>
      <section className="py-5">{body}</section>
      <footer className="mt-6 flex items-end justify-between">
        <Qr src={verify} label="Scan to verify" size={92} />
        <div className="text-center"><div className="w-48 border-t border-slate-400" /><p className="mt-1 text-[11px] text-slate-500">Authorised signatory</p></div>
      </footer>
    </Sheet>
  );
}

// ── Payslip ────────────────────────────────────────────────────────────────────────────────────────────────────
function PayslipPrint({ id, format, showQr }: { id: string; format: Format; showQr: boolean }) {
  const { path, money, settings } = useCompany();
  const { data, error } = useApi<any>(path(`/payroll/payslips/${id}`));
  const s = data?.payslip;
  const co = settings!.company;
  const summary = s ? `${co.legal_name || co.name}\nPayslip ${s.code} ${s.period}\nNet pay ${money(s.net)}` : "";
  const verify = useQr(useVerifyLink("payslip", id, showQr && Boolean(s && s.run_status !== "draft"), summary));
  if (error) return <Alert>{error}</Alert>;
  if (!s) return <Spinner />;
  const month = new Date(`${s.period}-01T00:00:00Z`).toLocaleString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
  const earnings: [string, number][] = [["Basic", s.basic], ["House rent allowance", s.hra], ["Other allowances", s.allowances], ["Overtime", s.overtime]];
  const deductions: [string, number][] = [["Provident fund", s.pf_employee], ["ESI", s.esi_employee], ["Professional tax", s.pt], ["TDS (income tax)", s.tds], ["Other deductions", s.other_deductions]];
  const thermal = format.startsWith("thermal");
  if (thermal) {
    return (
      <Sheet format={format}>
        <CompanyBlock thermal center />
        <Rule />
        <p className="text-center font-bold uppercase">Payslip · {month}</p>
        <p>{s.name} ({s.code})</p>
        <Rule />
        {earnings.filter(([, v]) => v).map(([k, v]) => <Row key={k} k={k} v={money(v)} />)}
        <Row k="Gross" v={<b>{money(s.gross)}</b>} />
        <Rule />
        {deductions.filter(([, v]) => v).map(([k, v]) => <Row key={k} k={k} v={money(v)} />)}
        <p className="mt-1 flex justify-between border-y border-dashed border-slate-500 py-1 font-bold"><span>NET PAY</span><span>{money(s.net)}</span></p>
        <div className="mt-2 flex justify-center"><Qr src={verify} label="Scan to verify" size={90} /></div>
      </Sheet>
    );
  }
  return (
    <Sheet format={format}>
      {s.run_status === "draft" && <p className="mb-2 text-center text-xs font-bold uppercase tracking-widest text-amber-600">Draft — payroll not yet posted</p>}
      <header className="flex items-start justify-between gap-6 border-b-4 border-brand-700 pb-5">
        <CompanyBlock />
        <div className="text-right">
          <p className="inline-block rounded-md bg-brand-700 px-3 py-1 text-sm font-semibold uppercase tracking-wider text-white">Payslip</p>
          <p className="mt-2 text-base font-semibold">{month}</p>
          <p className="text-slate-500">Paid on {fmtDate(s.pay_date, co.date_format)}</p>
        </div>
      </header>
      <section className="grid grid-cols-2 gap-x-8 gap-y-1 py-5">
        <Meta k="Employee" v={<b>{s.name}</b>} /><Meta k="Employee code" v={s.code} />
        <Meta k="Designation" v={s.designation ?? "—"} /><Meta k="Date of joining" v={s.date_of_joining ? fmtDate(s.date_of_joining, co.date_format) : "—"} />
        <Meta k="Paid days" v={`${s.paid_days_milli / 1000} of ${s.working_days}`} />{s.pay_type === "hourly" && <Meta k="Hours worked" v={`${(s.worked_minutes / 60).toFixed(2)} h`} />}
        {s.pan && <Meta k="PAN" v={s.pan} />}{s.uan && <Meta k="UAN" v={s.uan} />}{s.esi_number && <Meta k="ESI no." v={s.esi_number} />}
        {s.bank_account && <Meta k="Bank" v={`${s.bank_name ?? ""} ····${String(s.bank_account).slice(-4)}`} />}
      </section>
      <div className="grid grid-cols-2 gap-4">
        <Ledger title="Earnings" rows={earnings} total={["Gross earnings", s.gross]} money={money} />
        <Ledger title="Deductions" rows={deductions} total={["Total deductions", s.total_deductions]} money={money} />
      </div>
      <div className="mt-5 flex items-center justify-between rounded-lg bg-brand-50 p-4">
        <div><p className="text-[11px] font-semibold uppercase tracking-wider text-brand-800">Net pay</p><p className="text-2xl font-bold text-brand-800">{money(s.net)}</p><p className="italic text-slate-600">{amountInWords(s.net, co.base_currency, currencyExponent(co.base_currency))}</p></div>
        <Qr src={verify} label="Scan to verify" size={92} />
      </div>
      {(s.pf_employer > 0 || s.esi_employer > 0) && <p className="mt-3 text-[11px] text-slate-500">Employer contributions (not deducted from pay): PF {money(s.pf_employer)} · ESI {money(s.esi_employer)}</p>}
      <p className="mt-8 text-center text-[10px] text-slate-400">This is a computer-generated payslip and does not require a signature.</p>
    </Sheet>
  );
}

function Ledger({ title, rows, total, money }: { title: string; rows: [string, number][]; total: [string, number]; money: (n: number) => string }) {
  return (
    <table className="w-full border-collapse overflow-hidden rounded-lg border border-slate-200">
      <thead><tr className="bg-slate-100"><th className="px-3 py-2 text-left text-[11px] font-semibold uppercase">{title}</th><th className="px-3 py-2 text-right text-[11px] font-semibold uppercase">Amount</th></tr></thead>
      <tbody>
        {rows.map(([k, v]) => <tr key={k} className="border-t border-slate-100"><td className="px-3 py-1.5">{k}</td><td className="px-3 py-1.5 text-right tabular-nums">{money(v)}</td></tr>)}
        <tr className="border-t-2 border-slate-300 font-semibold"><td className="px-3 py-2">{total[0]}</td><td className="px-3 py-2 text-right tabular-nums">{money(total[1])}</td></tr>
      </tbody>
    </table>
  );
}

const sum = (rows: any[], k: string) => rows.reduce((t, r) => t + (r[k] ?? 0), 0);
const Rule = () => <div className="my-1.5 border-t border-dashed border-slate-500" />;
const Row = ({ k, v }: { k: ReactNode; v: ReactNode }) => <div className="flex justify-between gap-3"><dt className="text-slate-600">{k}</dt><dd className="text-right tabular-nums">{v}</dd></div>;
const Meta = ({ k, v }: { k: string; v: ReactNode }) => <div className="flex justify-between gap-3"><dt className="text-slate-500">{k}</dt><dd>{v}</dd></div>;
const Td = ({ children, r, c }: { children: ReactNode; r?: boolean; c?: boolean }) => <td className={`px-2 py-1.5 align-top ${r ? "text-right tabular-nums" : ""} ${c ? "border border-slate-800" : "border-b border-slate-100"}`}>{children}</td>;

function PrintInner() {
  const { kind, id } = useParams() as { kind: Kind; id: string };
  const [params, setParams] = useSearchParams();
  const { settings, path } = useCompany();
  const branding = useApi<{ logo: string | null; payment_qr: string | null }>(path("/settings/branding"));
  const def = (settings?.company.print_template as Format | undefined) ?? "modern";
  const asked = params.get("format");
  const format: Format = asked && asked in FORMATS ? (asked as Format) : kind === "payment" ? "a5" : def in FORMATS ? def : "modern";
  // Company defaults (Settings → Company → printing); either can be switched for this print.
  const [showQr, setShowQr] = useState(settings?.company.print_qr_verify !== 0);
  const [showUpi, setShowUpi] = useState(settings?.company.print_qr_upi !== 0);
  const set = (f: Format) => setParams((p) => { p.set("format", f); return p; }, { replace: true });
  const shareText = useMemo(() => `${document.title}\n${location.href}`, []);
  useEffect(() => { if (params.get("auto") === "1") setTimeout(printPage, 600); }, [params]);
  if (!settings) return <Spinner />;
  return (
    <div className="min-h-full bg-slate-200 pb-10 print:bg-white print:p-0 dark:bg-slate-800">
      <div className="no-print sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2">
        <button className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm hover:bg-[var(--surface-2)]" onClick={() => history.back()}><ArrowLeft className="h-4 w-4" />Back</button>
        <span className="mx-1 h-5 w-px bg-[var(--border)]" />
        <label className="text-sm muted" htmlFor="fmt">Layout</label>
        <select id="fmt" className="input max-w-[12rem] py-1" value={format} onChange={(e) => set(e.target.value as Format)}>
          {Object.entries(FORMATS).map(([k, f]) => <option key={k} value={k}>{f.label}</option>)}
        </select>
        <label className="ml-2 flex items-center gap-1.5 text-sm"><input type="checkbox" checked={showQr} onChange={(e) => setShowQr(e.target.checked)} />Verification QR</label>
        {kind === "document" && <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={showUpi} onChange={(e) => setShowUpi(e.target.checked)} />UPI payment QR</label>}
        <span className="flex-1" />
        <a className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm hover:bg-[var(--surface-2)]" href={`https://wa.me/?text=${encodeURIComponent(shareText)}`} target="_blank" rel="noreferrer"><Share2 className="h-4 w-4" />WhatsApp</a>
        <button className="flex items-center gap-1.5 rounded-lg bg-brand-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-800" onClick={printPage}><Printer className="h-4 w-4" />Print / Save PDF</button>
      </div>
      <p className="no-print px-4 py-2 text-center text-xs muted">Preview. Choose “Save as PDF” in the print dialog for a PDF. Thermal layouts fit 80 mm / 58 mm receipt printers (set the printer’s paper to the roll width).</p>
      <BrandingCtx.Provider value={branding.data ?? { logo: null, payment_qr: null }}>
      <div className="px-2 print:px-0">
        {kind === "document" && <DocumentPrint id={id} format={format} showQr={showQr} showUpi={showUpi} />}
        {kind === "payment" && <PaymentPrint id={id} format={format} showQr={showQr} />}
        {kind === "payslip" && <PayslipPrint id={id} format={format} showQr={showQr} />}
      </div>
      </BrandingCtx.Provider>
    </div>
  );
}

/** Full-window print preview: /print/:companyId/:kind/:id?format=modern|classic|a5|thermal80|thermal58 */
export default function PrintPage() {
  const { companyId } = useParams();
  return <CompanyProvider key={companyId} id={companyId!}><PrintInner /></CompanyProvider>;
}
