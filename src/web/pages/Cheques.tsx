import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ArrowLeft, Printer } from "lucide-react";
import { useCompany, CompanyProvider } from "../lib/company";
import { useApi } from "../lib/hooks";
import { api, errorMessage } from "../lib/api";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Modal, PageHeader, Select, Spinner, Stat, TableWrap, Tabs, useToast } from "../components/ui";
import { AccountSelect, ContactSelect } from "../components/pickers";
import { fmtDate, today, toInput } from "../lib/format";
import { contactPath, docPath } from "../lib/links";
import { amountInWords } from "@shared/words";
import { currencyExponent } from "@shared/currencies";

type Tab = "cheques" | "interest";
const STATUS: Record<string, { label: string; color: "gray" | "blue" | "green" | "red" | "amber" }> = {
  pending: { label: "Not cleared", color: "amber" }, deposited: { label: "Deposited", color: "blue" },
  cleared: { label: "Cleared", color: "green" }, bounced: { label: "Bounced", color: "red" }, cancelled: { label: "Cancelled", color: "gray" },
};

/** Cheques & post-dated cheques, and interest on overdue invoices. */
export default function ChequesPage() {
  const [tab, setTab] = useState<Tab>("cheques");
  return (
    <>
      <PageHeader title="Cheques & interest" subtitle="Cheques received and issued (including post-dated cheques), cheque printing, and interest on overdue invoices." />
      <Tabs tabs={[{ value: "cheques", label: "Cheque register (PDC)" }, { value: "interest", label: "Interest on overdue" }]} value={tab} onChange={setTab} />
      <div className="mt-4">{tab === "cheques" ? <ChequeRegister /> : <InterestTab />}</div>
    </>
  );
}

function ChequeRegister() {
  const { path, money, can, id, settings } = useCompany();
  const toast = useToast();
  const [filter, setFilter] = useState("");
  const list = useApi<{ cheques: any[]; summary: { to_receive: number; to_pay: number; due_now: number } }>(path(`/cheques${filter ? `?status=${filter}` : ""}`));
  const [adding, setAdding] = useState<"in" | "out" | null>(null);
  const [acting, setActing] = useState<{ q: any; action: "clear" | "deposit" | "bounce" | "cancel" } | null>(null);
  const df = settings?.company.date_format;
  const t = today();
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Cheques to receive" value={money(list.data?.summary.to_receive ?? 0)} sub="Received, not yet cleared" />
        <Stat label="Cheques to pay" value={money(list.data?.summary.to_pay ?? 0)} sub="Issued, not yet cleared" />
        <Stat label="Due today or earlier" value={String(list.data?.summary.due_now ?? 0)} tone={(list.data?.summary.due_now ?? 0) > 0 ? "bad" : "neutral"} sub="Present or follow up" />
        <div className="card flex flex-col justify-center gap-2 p-4">
          {can("sales.post") && <Button onClick={() => setAdding("in")}>Cheque received</Button>}
          {can("purchase.post") && <Button variant="secondary" onClick={() => setAdding("out")}>Issue a cheque</Button>}
        </div>
      </div>
      <Card className="mt-4" padded={false} title="Cheque register" actions={
        <Select aria-label="Status" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">All</option>{Object.entries(STATUS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
        </Select>}>
        {list.loading && !list.data ? <Spinner /> : !list.data?.cheques.length ? <EmptyState title="No cheques yet" body="Record a cheque received from a customer (also a post-dated one), or issue and print a cheque to a supplier." /> : (
          <TableWrap><table className="table text-sm">
            <thead><tr><th>Cheque date</th><th>No.</th><th>Received from / paid to</th><th>Bank</th><th className="num">Amount</th><th>Status</th><th /></tr></thead>
            <tbody>{list.data.cheques.map((q) => {
              const open = q.status === "pending" || q.status === "deposited";
              return (
                <tr key={q.id}>
                  <td className="whitespace-nowrap">{fmtDate(q.cheque_date, df)}{open && q.cheque_date > t && <span className="ml-1"><Badge color="blue">post-dated</Badge></span>}{open && q.cheque_date <= t && <span className="ml-1"><Badge color="amber">due</Badge></span>}</td>
                  <td className="font-mono">{q.cheque_no}</td>
                  <td><span className="muted">{q.direction === "in" ? "From " : "To "}</span><Link className="text-brand-700 hover:underline dark:text-brand-300" to={contactPath(id, q.contact_id)}>{q.party}</Link></td>
                  <td>{q.bank_name ?? q.account ?? "—"}</td>
                  <td className="num">{money(q.amount, q.currency)}</td>
                  <td><Badge color={STATUS[q.status].color}>{STATUS[q.status].label}</Badge>
                    {q.payment_number && <span className="block text-xs"><Link className="text-brand-700 hover:underline dark:text-brand-300" to={`/app/${id}/payments/view/${q.payment_id}`}>{q.payment_number}</Link></span>}
                    {q.bounce_reason && <span className="block text-xs muted">{q.bounce_reason}</span>}</td>
                  <td className="whitespace-nowrap text-right">
                    {q.direction === "out" && q.status !== "cancelled" && <Link className="mr-1 inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs hover:bg-[var(--surface-2)]" to={`/print-cheque/${id}/${q.id}`}><Printer className="h-3.5 w-3.5" />Print</Link>}
                    {q.direction === "in" && q.status === "pending" && <Button size="sm" variant="ghost" onClick={() => setActing({ q, action: "deposit" })}>Deposit</Button>}
                    {open && <Button size="sm" variant="ghost" onClick={() => setActing({ q, action: "clear" })}>Cleared</Button>}
                    {(open || q.status === "cleared") && <Button size="sm" variant="ghost" onClick={() => setActing({ q, action: "bounce" })}>Bounced</Button>}
                    {open && <Button size="sm" variant="ghost" onClick={() => setActing({ q, action: "cancel" })}>Cancel</Button>}
                  </td>
                </tr>
              );
            })}</tbody>
          </table></TableWrap>
        )}
      </Card>
      <p className="mt-2 text-xs muted">A cheque does not touch your accounts until it clears. “Cleared” records the receipt or payment (applied to the invoices or bills chosen); “Bounced” reverses it, so the invoice is unpaid again. Record any bank charges as an expense.</p>
      {adding && <NewCheque direction={adding} onClose={(saved) => { setAdding(null); if (saved) { list.reload(); toast("success", "Cheque recorded"); } }} />}
      {acting && <ChequeAction {...acting} onClose={(done) => { setActing(null); if (done) list.reload(); }} />}
    </>
  );
}

function NewCheque({ direction, onClose }: { direction: "in" | "out"; onClose: (saved: boolean) => void }) {
  const { path, settings, money } = useCompany();
  const [v, setV] = useState({ contact_id: "", cheque_no: "", bank_name: "", cheque_date: today(), amount: "", account_id: "", payee_name: "", notes: "" });
  const [apply, setApply] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const docType = direction === "in" ? "invoice" : "bill";
  const open = useApi<{ documents: any[] }>(v.contact_id ? path(`/documents?type=${docType}&status=outstanding&contact_id=${v.contact_id}&limit=200`) : null);
  const base = settings?.company.base_currency ?? "INR";
  const chosen = (open.data?.documents ?? []).filter((d) => apply[d.id]);
  const save = async () => {
    setBusy(true); setError(null);
    try {
      await api.post(path("/cheques"), {
        ...v, direction, account_id: v.account_id || null, bank_name: v.bank_name || null, payee_name: v.payee_name || null, notes: v.notes || null,
        allocations: chosen.map((d) => ({ document_id: d.id, amount: toInput(d.total - d.amount_settled, d.currency) })),
      });
      onClose(true);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open wide title={direction === "in" ? "Cheque received" : "Issue a cheque"} onClose={() => onClose(false)}
      footer={<><Button variant="secondary" onClick={() => onClose(false)}>Close</Button><Button loading={busy} disabled={!v.contact_id || !v.cheque_no || !v.amount} onClick={() => void save()}>Save</Button></>}>
      {error && <Alert className="mb-3">{error}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={direction === "in" ? "Customer" : "Supplier"} required>{(fid) => <ContactSelect id={fid} kind={direction === "in" ? "customer" : "supplier"} value={v.contact_id} onChange={(cid, ct) => setV({ ...v, contact_id: cid, payee_name: v.payee_name || (ct?.legal_name ?? ct?.name ?? "") })} />}</Field>
        <Field label="Cheque number" required>{(fid) => <Input id={fid} inputMode="numeric" value={v.cheque_no} onChange={(e) => setV({ ...v, cheque_no: e.target.value })} />}</Field>
        <Field label="Cheque date" hint="A later date makes it a post-dated cheque (PDC)">{(fid) => <Input id={fid} type="date" value={v.cheque_date} onChange={(e) => setV({ ...v, cheque_date: e.target.value })} />}</Field>
        <Field label="Amount" required>{(fid) => <Input id={fid} inputMode="decimal" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} />}</Field>
        {direction === "in"
          ? <Field label="Customer's bank">{(fid) => <Input id={fid} placeholder="e.g. HDFC Bank, MG Road" value={v.bank_name} onChange={(e) => setV({ ...v, bank_name: e.target.value })} />}</Field>
          : <Field label="Payee name on the cheque">{(fid) => <Input id={fid} value={v.payee_name} onChange={(e) => setV({ ...v, payee_name: e.target.value })} />}</Field>}
        <Field label={direction === "in" ? "Deposit into (can be chosen later)" : "Drawn on (our bank account)"} required={direction === "out"}>{(fid) => <AccountSelect id={fid} value={v.account_id} onChange={(a) => setV({ ...v, account_id: a })} filter={(a) => a.subtype === "bank"} />}</Field>
        <Field label="Notes" className="sm:col-span-2">{(fid) => <Input id={fid} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} />}</Field>
      </div>
      {v.contact_id && <div className="mt-4">
        <h3 className="text-sm font-semibold">Apply to open {docType}s when it clears (optional)</h3>
        {open.data?.documents.length ? <TableWrap><table className="table text-sm"><tbody>{open.data.documents.map((d) => (
          <tr key={d.id}><td><input type="checkbox" aria-label={`Apply to ${d.number}`} checked={!!apply[d.id]} onChange={(e) => setApply({ ...apply, [d.id]: e.target.checked })} /></td>
            <td>{d.number}</td><td>{fmtDate(d.due_date ?? d.issue_date, settings?.company.date_format)}</td><td className="num">{money(d.total - d.amount_settled, d.currency ?? base)}</td></tr>))}</tbody></table></TableWrap>
          : <p className="text-sm muted">No open {docType}s: the cheque will be an advance when it clears.</p>}
      </div>}
    </Modal>
  );
}

function ChequeAction({ q, action, onClose }: { q: any; action: "clear" | "deposit" | "bounce" | "cancel"; onClose: (done: boolean) => void }) {
  const { path } = useCompany();
  const toast = useToast();
  const [date, setDate] = useState(action === "clear" && q.cheque_date > today() ? q.cheque_date : today());
  const [account, setAccount] = useState(q.account_id ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const titles = { clear: "Cheque cleared", deposit: "Deposit cheque", bounce: "Cheque bounced", cancel: "Cancel cheque" };
  const go = async () => {
    setBusy(true);
    try {
      await api.post(path(`/cheques/${q.id}/${action}`), { date, account_id: account || null, reason: reason || null });
      toast("success", action === "clear" ? "Cleared: the payment is recorded" : action === "bounce" ? "Marked bounced" + (q.payment_id ? ": the payment is reversed" : "") : "Saved");
      onClose(true);
    } catch (e) { toast("error", errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open title={`${titles[action]} · ${q.cheque_no}`} onClose={() => onClose(false)}
      footer={<><Button variant="secondary" onClick={() => onClose(false)}>Close</Button><Button variant={action === "bounce" || action === "cancel" ? "danger" : "primary"} loading={busy} onClick={() => void go()}>{titles[action]}</Button></>}>
      <div className="grid gap-3">
        {action !== "cancel" && <Field label="Date">{(fid) => <Input id={fid} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>}
        {(action === "clear" || action === "deposit") && <Field label="Bank account">{(fid) => <AccountSelect id={fid} value={account} onChange={setAccount} filter={(a) => a.subtype === "bank"} />}</Field>}
        {(action === "bounce" || action === "cancel") && <Field label="Reason">{(fid) => <Input id={fid} placeholder={action === "bounce" ? "Insufficient funds, signature mismatch…" : ""} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>}
        {action === "bounce" && q.payment_id && <Alert kind="warning">The receipt or payment made when this cheque cleared is reversed, and the invoice or bill becomes unpaid again.</Alert>}
      </div>
    </Modal>
  );
}

function InterestTab() {
  const { path, money, can, id, settings, reload } = useCompany();
  const nav = useNavigate();
  const toast = useToast();
  const co = settings?.company as { overdue_interest_bp?: number; overdue_interest_grace_days?: number } | undefined;
  const [asOf, setAsOf] = useState(today());
  const [rate, setRate] = useState(String((co?.overdue_interest_bp ?? 1800) / 100));
  const [grace, setGrace] = useState(String(co?.overdue_interest_grace_days ?? 0));
  const data = useApi<{ rows: any[]; customers: any[] }>(path(`/interest?as_of=${asOf}&rate=${encodeURIComponent(rate || "0")}`));
  const df = settings?.company.date_format;
  return (
    <>
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Interest up to">{(fid) => <Input id={fid} type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />}</Field>
          <Field label="Rate (% a year)">{(fid) => <Input id={fid} className="w-28" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />}</Field>
          <Field label="Days of grace after due date">{(fid) => <Input id={fid} className="w-28" inputMode="numeric" value={grace} onChange={(e) => setGrace(e.target.value)} />}</Field>
          {can("company.manage") && <Button variant="secondary" onClick={async () => {
            try { await api.put(path("/interest/settings"), { rate_percent: Number(rate), grace_days: Number(grace) }); await reload(); data.reload(); toast("success", "Saved as the company's interest terms"); }
            catch (e) { toast("error", errorMessage(e)); }
          }}>Save as default</Button>}
        </div>
        <p className="mt-2 text-xs muted">Simple interest on what is still unpaid on each invoice, from its due date (plus the days of grace) or from the date interest was last billed. Mention your interest terms on invoices (Settings → Company → invoice terms). Interest on late payment is usually taxable like the supply: add the tax code on the draft if it applies.</p>
      </Card>
      <Card className="mt-4" padded={false} title="Interest due by customer">
        {data.loading && !data.data ? <Spinner /> : !data.data?.customers.length ? <EmptyState title="No interest due" body="No invoice is overdue beyond the grace days." /> : (
          <TableWrap><table className="table text-sm">
            <thead><tr><th>Customer</th><th className="num">Overdue invoices</th><th className="num">Unpaid</th><th className="num">Interest</th><th /></tr></thead>
            <tbody>{data.data.customers.map((g) => (
              <tr key={g.contact_id + g.currency}>
                <td><Link className="text-brand-700 hover:underline dark:text-brand-300" to={contactPath(id, g.contact_id)}>{g.party}</Link></td>
                <td className="num">{g.invoices}</td><td className="num">{money(g.outstanding, g.currency)}</td><td className="num font-semibold">{money(g.interest, g.currency)}</td>
                <td className="text-right">{can("sales.create") && <Button size="sm" onClick={async () => {
                  try { const r = await api.post<{ id: string }>(path("/interest/invoice"), { contact_id: g.contact_id, as_of: asOf, rate_percent: Number(rate) }); toast("success", "Draft interest invoice made: check and issue it"); nav(docPath(id, "invoice", r.id)); }
                  catch (e) { toast("error", errorMessage(e)); }
                }}>Make interest invoice</Button>}</td>
              </tr>))}</tbody>
          </table></TableWrap>
        )}
      </Card>
      {data.data?.rows.length ? <Card className="mt-4" padded={false} title="Details">
        <TableWrap><table className="table text-sm">
          <thead><tr><th>Invoice</th><th>Customer</th><th>Due</th><th>Interest from</th><th className="num">Days</th><th className="num">Unpaid</th><th className="num">Interest</th></tr></thead>
          <tbody>{data.data.rows.map((r) => <tr key={r.document_id}><td><Link className="text-brand-700 hover:underline dark:text-brand-300" to={docPath(id, "invoice", r.document_id)}>{r.number}</Link></td><td>{r.party}</td>
            <td>{fmtDate(r.due_date, df)}</td><td>{fmtDate(r.from, df)}</td><td className="num">{r.days}</td><td className="num">{money(r.outstanding, r.currency)}</td><td className="num">{money(r.interest, r.currency)}</td></tr>)}</tbody>
        </table></TableWrap>
      </Card> : null}
    </>
  );
}

// ── Cheque printing ──

interface Layout { width: number; height: number; date: { x: number; y: number; spacing: number }; payee: { x: number; y: number }; words: { x: number; y: number; width: number; line2_y: number }; figures: { x: number; y: number }; ac_payee: boolean }
/** A standard Indian CTS-2010 cheque leaf (203 × 92 mm). Adjust once for your bank's cheque book. */
export const DEFAULT_LAYOUT: Layout = { width: 203, height: 92, date: { x: 158, y: 9, spacing: 5.1 }, payee: { x: 22, y: 23 }, words: { x: 32, y: 32, width: 125, line2_y: 40 }, figures: { x: 160, y: 41 }, ac_payee: true };

function ChequePrintInner() {
  const { id: cid, settings, path, can, reload } = useCompany();
  const { id } = useParams();
  const toast = useToast();
  const q = useApi<{ cheque: any }>(path(`/cheques/${id}`));
  const saved = (() => { try { return (settings?.company as unknown as { cheque_layout?: string | null } | undefined)?.cheque_layout ? JSON.parse((settings!.company as unknown as { cheque_layout: string }).cheque_layout) as Layout : null; } catch { return null; } })();
  const [l, setL] = useState<Layout>(saved ?? DEFAULT_LAYOUT);
  const [edit, setEdit] = useState(false);
  if (!q.data || !settings) return <Spinner />;
  const ch = q.data.cheque;
  const exp = currencyExponent(ch.currency);
  const words = amountInWords(ch.amount, ch.currency, exp).replace(/\.$/, "");
  const [w1, w2] = (() => { const parts = (/\bonly$/i.test(words) ? words : `${words} Only`).split(" "); let a = ""; let i = 0; for (; i < parts.length && (a + parts[i]).length < 52; i++) a += `${parts[i]} `; return [a.trim(), parts.slice(i).join(" ")]; })();
  const digits = ch.cheque_date.split("-").reverse().join("").split(""); // DDMMYYYY
  const figure = `${(ch.amount / 10 ** exp).toLocaleString("en-IN", { minimumFractionDigits: exp })}/-`;
  const num = (k: string, v: number, set: (n: number) => void) => <label className="flex items-center gap-1 text-xs">{k}<input className="input w-16 py-0.5" type="number" step="0.5" value={v} onChange={(e) => set(Number(e.target.value))} /></label>;
  const mm = (n: number) => `${n}mm`;
  return (
    <div className="min-h-full bg-slate-200 pb-10 print:bg-white dark:bg-slate-800">
      <div className="no-print sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2">
        <Link className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm hover:bg-[var(--surface-2)]" to={`/app/${cid}/cheques`}><ArrowLeft className="h-4 w-4" />Back</Link>
        <span className="text-sm muted">Cheque {ch.cheque_no} · {ch.party}</span>
        <span className="flex-1" />
        <Button variant="secondary" size="sm" onClick={() => setEdit(!edit)}>{edit ? "Hide positions" : "Adjust positions"}</Button>
        <button className="flex items-center gap-1.5 rounded-lg bg-brand-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-800" onClick={() => { void api.post(path(`/cheques/${id}/printed`)).catch(() => undefined); window.print(); }}><Printer className="h-4 w-4" />Print cheque</button>
      </div>
      <p className="no-print px-4 py-2 text-center text-xs muted">Put the cheque leaf in the printer's manual feed, top edge first, and print at 100% (no “fit to page”). Test on plain paper first and adjust the positions once for your bank.</p>
      {edit && <div className="no-print mx-auto mb-3 grid max-w-3xl gap-2 rounded-xl bg-[var(--surface)] p-3 sm:grid-cols-3">
        <div className="flex flex-wrap gap-2">{num("Date x", l.date.x, (n) => setL({ ...l, date: { ...l.date, x: n } }))}{num("y", l.date.y, (n) => setL({ ...l, date: { ...l.date, y: n } }))}{num("box gap", l.date.spacing, (n) => setL({ ...l, date: { ...l.date, spacing: n } }))}</div>
        <div className="flex flex-wrap gap-2">{num("Payee x", l.payee.x, (n) => setL({ ...l, payee: { ...l.payee, x: n } }))}{num("y", l.payee.y, (n) => setL({ ...l, payee: { ...l.payee, y: n } }))}</div>
        <div className="flex flex-wrap gap-2">{num("Words x", l.words.x, (n) => setL({ ...l, words: { ...l.words, x: n } }))}{num("y", l.words.y, (n) => setL({ ...l, words: { ...l.words, y: n } }))}{num("line 2 y", l.words.line2_y, (n) => setL({ ...l, words: { ...l.words, line2_y: n } }))}</div>
        <div className="flex flex-wrap gap-2">{num("Amount x", l.figures.x, (n) => setL({ ...l, figures: { ...l.figures, x: n } }))}{num("y", l.figures.y, (n) => setL({ ...l, figures: { ...l.figures, y: n } }))}</div>
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={l.ac_payee} onChange={(e) => setL({ ...l, ac_payee: e.target.checked })} />Print “A/c Payee” crossing</label>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => setL(DEFAULT_LAYOUT)}>Standard</Button>
          {can("company.manage") && <Button size="sm" onClick={async () => { try { await api.put(path("/cheques/layout"), l); await reload(); toast("success", "Positions saved for this company"); } catch (e) { toast("error", errorMessage(e)); } }}>Save positions</Button>}
        </div>
      </div>}
      <style>{`@media print { @page { size: ${l.width}mm ${l.height}mm; margin: 0; } }`}</style>
      <div className="print-sheet relative mx-auto bg-white text-black shadow print:shadow-none" style={{ width: mm(l.width), height: mm(l.height), fontFamily: "Arial, sans-serif" }}>
        {edit && <div className="no-print absolute inset-0 border border-dashed border-slate-400" />}
        {l.ac_payee && <div className="absolute" style={{ left: mm(6), top: mm(6), transform: "rotate(-30deg)", borderTop: "1px solid #000", borderBottom: "1px solid #000", fontSize: "9pt", padding: "0 4mm" }}>A/c Payee</div>}
        <div className="absolute flex" style={{ left: mm(l.date.x), top: mm(l.date.y), fontSize: "12pt", letterSpacing: 0 }}>
          {digits.map((d: string, i: number) => <span key={i} style={{ width: mm(l.date.spacing), textAlign: "center" }}>{d}</span>)}
        </div>
        <div className="absolute" style={{ left: mm(l.payee.x), top: mm(l.payee.y), fontSize: "11pt" }}>{ch.payee_name || ch.party}</div>
        <div className="absolute" style={{ left: mm(l.words.x), top: mm(l.words.y), width: mm(l.words.width), fontSize: "10.5pt" }}>{w1}</div>
        <div className="absolute" style={{ left: mm(l.words.x - 18), top: mm(l.words.line2_y), width: mm(l.words.width), fontSize: "10.5pt" }}>{w2}</div>
        <div className="absolute font-semibold" style={{ left: mm(l.figures.x), top: mm(l.figures.y), fontSize: "12pt" }}>**{figure}</div>
      </div>
    </div>
  );
}

export function ChequePrintPage() {
  const { companyId } = useParams();
  return <CompanyProvider key={companyId} id={companyId!}><ChequePrintInner /></CompanyProvider>;
}
