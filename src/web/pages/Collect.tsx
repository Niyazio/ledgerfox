import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { BadgeCheck, CheckCircle2, CreditCard, ExternalLink, MessageCircle, Mail, RefreshCw, Copy, FileText } from "lucide-react";
import { useCompany } from "../lib/company";
import { useApi } from "../lib/hooks";
import { api, errorMessage } from "../lib/api";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Modal, Spinner, TableWrap, useToast } from "../components/ui";
import { AccountSelect } from "../components/pickers";
import { ProductCredit, Wordmark } from "../components/Layout";
import { DOC_LABELS, fmtDate, money } from "../lib/format";

declare global { interface Window { Razorpay?: new (opts: Record<string, unknown>) => { open: () => void; on: (e: string, cb: (r: unknown) => void) => void } } }

// ── Settings → Payments & reminders ──

export function CollectionTab() {
  const { path, can, accounts } = useCompany();
  const { data, error, reload } = useApi<any>(path("/collection"));
  const toast = useToast();
  const [v, setV] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (data) setV({ ...data, razorpay_key_id: data.razorpay_key_id ?? "", razorpay_secret: "", razorpay_webhook_secret: "" }); }, [data]);
  if (error) return <Alert>{error}</Alert>;
  if (!v) return <Spinner />;
  const disabled = !can("company.manage");
  const set = (k: string, val: unknown) => setV((p: any) => ({ ...p, [k]: val }));
  const bankIds = new Set(accounts.filter((a) => a.subtype === "bank" || a.subtype === "cash").map((a) => a.id));
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await api.put(path("/collection"), {
        online_enabled: v.online_enabled, razorpay_key_id: v.razorpay_key_id.trim() || null, razorpay_secret: v.razorpay_secret.trim() || null,
        razorpay_webhook_secret: v.razorpay_webhook_secret.trim() || null, deposit_account_id: v.deposit_account_id || null,
        reminders_enabled: v.reminders_enabled, remind_before_days: Number(v.remind_before_days), remind_on_due: v.remind_on_due,
        remind_every_days: Number(v.remind_every_days), remind_max_after: Number(v.remind_max_after),
      });
      toast("success", "Saved"); reload();
    } catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-4">
      {err && <Alert>{err}</Alert>}
      <Card title={<span className="flex items-center gap-2"><CreditCard className="h-5 w-5" />Customers pay invoices online</span>}>
        <p className="text-sm muted">Customers pay from the invoice link you send (or their customer portal) by UPI, card, net banking or wallet. The money goes straight to <b>your own Razorpay account</b>, and LedgerFox records the receipt against the invoice automatically.</p>
        {!data.secrets_ready && <Alert kind="warning" className="mt-3">Online payments are not available on this LedgerFox server yet (DATA_KEY is not set). Please contact LedgerFox.</Alert>}
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm">
          <li>Sign up or log in at razorpay.com (free; Razorpay charges a small fee per payment).</li>
          <li>Razorpay → Account &amp; Settings → <b>API Keys</b>: generate a key and copy the Key ID and Key Secret here.</li>
          <li>Razorpay → Account &amp; Settings → <b>Webhooks</b> → Add: URL <code className="break-all rounded bg-[var(--surface-2)] px-1">{data.webhook_url}</code>, events <b>payment.captured</b> and <b>order.paid</b>, and a secret you make up — enter the same secret here.</li>
        </ol>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="Razorpay Key ID">{(id) => <Input id={id} disabled={disabled} value={v.razorpay_key_id} placeholder="rzp_live_…" className="font-mono" onChange={(e) => set("razorpay_key_id", e.target.value)} />}</Field>
          <Field label="Key Secret" hint={data.has_secret ? "Saved (hidden). Type a new one only to change it." : "Stored encrypted; never shown again."}>{(id) => <Input id={id} disabled={disabled} type="password" autoComplete="off" value={v.razorpay_secret} placeholder={data.has_secret ? "••••••••" : ""} onChange={(e) => set("razorpay_secret", e.target.value)} />}</Field>
          <Field label="Webhook secret" hint={data.has_webhook_secret ? "Saved (hidden)." : "Records payments even if the customer closes the page early."}>{(id) => <Input id={id} disabled={disabled} type="password" autoComplete="off" value={v.razorpay_webhook_secret} placeholder={data.has_webhook_secret ? "••••••••" : ""} onChange={(e) => set("razorpay_webhook_secret", e.target.value)} />}</Field>
          <Field label="Online payments arrive in" hint="The bank account Razorpay settles to.">{(id) => <AccountSelect id={id} disabled={disabled} value={v.deposit_account_id} filter={(a) => bankIds.has(a.id)} onChange={(x) => set("deposit_account_id", x)} />}</Field>
        </div>
        <label className="mt-4 flex items-center gap-2 text-sm"><input type="checkbox" disabled={disabled} checked={v.online_enabled} onChange={(e) => set("online_enabled", e.target.checked)} /> Show <b>Pay online</b> on invoices and in the customer portal</label>
        {data.ready && <p className="mt-2 flex items-center gap-1 text-sm text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="h-4 w-4" />Online payments are on.</p>}
      </Card>
      <Card title={<span className="flex items-center gap-2"><Mail className="h-5 w-5" />Automatic payment reminders</span>}>
        <p className="text-sm muted">Emails customers about unpaid invoices with the link to view and pay. Sent once a day; each reminder goes out once. Customers need an email address.</p>
        {!data.email_ready && <Alert kind="warning" className="mt-3">Email is not set up on this LedgerFox server yet, so reminders cannot be sent. Please contact LedgerFox.</Alert>}
        <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" disabled={disabled} checked={v.reminders_enabled} onChange={(e) => set("reminders_enabled", e.target.checked)} /> Send reminders automatically</label>
        <div className="mt-3 grid gap-4 sm:grid-cols-4">
          <Field label="Days before due" hint="0 = none">{(id) => <Input id={id} type="number" min={0} max={30} disabled={disabled} value={v.remind_before_days} onChange={(e) => set("remind_before_days", e.target.value)} />}</Field>
          <Field label="On the due date">{(id) => <label className="flex h-10 items-center gap-2 text-sm"><input id={id} type="checkbox" disabled={disabled} checked={v.remind_on_due} onChange={(e) => set("remind_on_due", e.target.checked)} /> Yes</label>}</Field>
          <Field label="When overdue, every (days)">{(id) => <Input id={id} type="number" min={1} max={60} disabled={disabled} value={v.remind_every_days} onChange={(e) => set("remind_every_days", e.target.value)} />}</Field>
          <Field label="Overdue reminders, at most">{(id) => <Input id={id} type="number" min={0} max={12} disabled={disabled} value={v.remind_max_after} onChange={(e) => set("remind_max_after", e.target.value)} />}</Field>
        </div>
      </Card>
      {!disabled && <Button loading={busy} onClick={save}>Save</Button>}
    </div>
  );
}

// ── The customer's portal link (customer page) ──

export function PortalLinkButton({ contactId, name, phone, email }: { contactId: string; name: string; phone?: string | null; email?: string | null }) {
  const { path, can, settings } = useCompany();
  const toast = useToast();
  const [link, setLink] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const get = async (renew = false) => {
    try { setLink((await api.post<{ url: string }>(path(`/collection/portal/${contactId}`), { renew })).url); setOpen(true); if (renew) toast("success", "New link made. The old link no longer works."); }
    catch (e) { toast("error", errorMessage(e)); }
  };
  const seller = settings?.company.legal_name || settings?.company.name;
  const msg = link ? `Dear ${name}, you can see all your invoices from ${seller}, download them and pay online here: ${link}` : "";
  const digits = (phone ?? "").replace(/\D/g, "");
  return (
    <>
      <Button variant="secondary" onClick={() => void get()}><ExternalLink className="h-4 w-4" />Customer portal</Button>
      {open && link && <Modal open title="Customer portal" onClose={() => setOpen(false)}>
        <p className="text-sm muted">Send this private link to {name}. They see their invoices, quotations and receipts, download them, accept quotations and pay online. Anyone with the link can see these, so share it only with the customer.</p>
        <div className="mt-3 flex gap-2"><Input readOnly value={link} className="font-mono text-xs" onFocus={(e) => e.target.select()} aria-label="Portal link" />
          <Button variant="secondary" onClick={() => { void navigator.clipboard?.writeText(link); toast("success", "Link copied"); }} aria-label="Copy link"><Copy className="h-4 w-4" /></Button></div>
        <div className="mt-3 flex flex-wrap gap-2">
          <a className="btn-secondary inline-flex items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-sm" target="_blank" rel="noreferrer" href={`https://wa.me/${digits.length === 10 ? `91${digits}` : digits}?text=${encodeURIComponent(msg)}`}><MessageCircle className="h-4 w-4" />WhatsApp</a>
          <a className="inline-flex items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-sm" href={`mailto:${email ?? ""}?subject=${encodeURIComponent(`Your invoices from ${seller}`)}&body=${encodeURIComponent(msg)}`}><Mail className="h-4 w-4" />Email</a>
          <a className="inline-flex items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-sm" href={link} target="_blank" rel="noreferrer"><ExternalLink className="h-4 w-4" />Open</a>
          {can("customers.write") && <Button variant="ghost" onClick={() => { if (confirm("Make a new link? The current link stops working.")) void get(true); }}><RefreshCw className="h-4 w-4" />New link</Button>}
        </div>
      </Modal>}
    </>
  );
}

// ── Public: /pay/:token — pay one invoice online ──

export function PayInvoice() {
  const { token } = useParams();
  const { data, error } = useApi<any>(`/api/verify/${token}`);
  const [state, setState] = useState<"loading" | "ready" | "paying" | "done" | "error">("loading");
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (window.Razorpay) { setState("ready"); return; }
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.onload = () => setState("ready");
    s.onerror = () => { setState("error"); setMessage("Could not load the payment window. Check your internet connection."); };
    document.body.appendChild(s);
  }, []);
  const pay = async () => {
    setState("paying");
    try {
      const o = await api.post<any>(`/api/pay/${token}/order`);
      const rz = new window.Razorpay!({
        key: o.key_id, order_id: o.order_id, amount: o.amount, currency: o.currency, name: o.name, description: o.description, prefill: o.prefill, theme: { color: "#1d4ed8" },
        handler: async (r: Record<string, string>) => {
          try { await api.post(`/api/pay/${token}/confirm`, r); setState("done"); } catch (e) { setState("error"); setMessage(errorMessage(e)); }
        },
        modal: { ondismiss: () => setState("ready") },
      });
      rz.on("payment.failed", () => { setState("error"); setMessage("The payment did not go through. No money was taken, or it will be refunded automatically."); });
      rz.open();
    } catch (e) { setState("error"); setMessage(errorMessage(e)); }
  };
  return (
    <div className="mx-auto max-w-lg px-4 py-10">
      <div className="mb-6 text-lg"><Wordmark iconClass="h-7 w-7" /></div>
      {error ? <Alert>{error}</Alert> : !data ? <Spinner /> : (
        <Card>
          <p className="text-sm muted">{data.issuer?.name}</p>
          <h1 className="text-xl font-semibold">{data.kind} {data.number}</h1>
          <p className="mt-1 text-sm muted">For {data.party} · {fmtDate(data.date)}{data.due_date ? ` · due ${fmtDate(data.due_date)}` : ""}</p>
          <p className="mt-4 text-3xl font-semibold">{money(data.balance ?? 0, data.currency)}</p>
          <p className="text-sm muted">to pay</p>
          {state === "done" ? (
            <p className="mt-5 flex items-center gap-2 font-medium text-emerald-700 dark:text-emerald-400"><BadgeCheck className="h-5 w-5" />Payment received — thank you! It is recorded against this invoice in {data.issuer?.name}'s books.</p>
          ) : !data.online_pay ? (
            <Alert kind="info" className="mt-5">{(data.balance ?? 0) <= 0 ? "This invoice is already paid. Thank you!" : "Online payment is not available for this invoice. Please use the payment details on the invoice."}</Alert>
          ) : <>
            {state === "error" && <Alert className="mt-4">{message}</Alert>}
            <Button className="mt-5 w-full" loading={state === "paying" || state === "loading"} onClick={pay}><CreditCard className="h-4 w-4" />Pay {money(data.balance ?? 0, data.currency)}</Button>
            <p className="mt-2 text-xs muted">UPI, cards, net banking and wallets, processed securely by Razorpay. The payment goes directly to {data.issuer?.name}.</p>
          </>}
          <a className="mt-4 inline-block text-sm text-brand-700 hover:underline dark:text-brand-300" href={`/verify/${token}`}>View the invoice</a>
        </Card>
      )}
      <ProductCredit className="mt-6 text-center" />
    </div>
  );
}

// ── Public: /portal/:token — the customer's portal ──

export function CustomerPortal() {
  const { token } = useParams();
  const { data, error, reload } = useApi<any>(`/api/portal/${token}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  if (error) return <div className="mx-auto max-w-xl p-8"><Alert>{error}</Alert><p className="mt-3 text-sm muted">This link may have been replaced. Ask the business for a new one.</p></div>;
  if (!data) return <Spinner />;
  const m = (n: number, cur?: string) => money(n, cur ?? data.summary.currency ?? "INR");
  const today = new Date().toISOString().slice(0, 10);
  const quote = async (id: string, action: "accept" | "decline") => {
    setBusy(id);
    try { await api.post(`/api/portal/${token}/quotes/${id}/${action}`); setMsg(action === "accept" ? `Quotation accepted. ${data.business.name} sees it in their books.` : "Quotation declined."); reload(); }
    catch (e) { setMsg(errorMessage(e)); } finally { setBusy(null); }
  };
  const label = (d: any) => DOC_LABELS[d.variant ?? d.doc_type]?.one ?? d.doc_type;
  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-2"><Wordmark iconClass="h-7 w-7" /><span className="text-sm muted">Customer portal</span></div>
      <h1 className="text-2xl font-semibold">{data.business.name}</h1>
      <p className="text-sm muted">{[data.business.address, data.business.phone, data.business.email].filter(Boolean).join(" · ")}</p>
      <p className="mt-4">Hello <b>{data.customer.name}</b>, here are your documents and payments.</p>
      {msg && <Alert kind="info" className="mt-3">{msg}</Alert>}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="card p-4"><p className="text-xs uppercase tracking-wide muted">You owe</p><p className="text-2xl font-semibold">{data.summary.mixed ? "See below" : m(data.summary.outstanding)}</p></div>
        <div className="card p-4"><p className="text-xs uppercase tracking-wide muted">Overdue</p><p className={`text-2xl font-semibold ${data.summary.overdue > 0 ? "text-red-600" : ""}`}>{data.summary.mixed ? "—" : m(data.summary.overdue)}</p></div>
      </div>
      <Card title="Invoices" padded={false} className="mt-5">{data.invoices.length ? <TableWrap><table className="table">
        <thead><tr><th>Date</th><th>Document</th><th>Due</th><th className="num">Amount</th><th className="num">Balance</th><th /></tr></thead>
        <tbody>{data.invoices.map((d: any) => {
          const bal = d.doc_type === "invoice" ? d.total - d.amount_settled : 0;
          return <tr key={d.id}><td>{fmtDate(d.issue_date)}</td>
            <td><a className="text-brand-700 hover:underline dark:text-brand-300" href={d.link}><FileText className="mr-1 inline h-4 w-4" />{label(d)} {d.number}</a></td>
            <td>{d.due_date ? <>{fmtDate(d.due_date)} {bal > 0 && d.due_date < today && <Badge color="red">overdue</Badge>}</> : "—"}</td>
            <td className="num">{d.doc_type === "credit_note" ? "−" : ""}{m(d.total, d.currency)}</td>
            <td className="num">{bal > 0 ? m(bal, d.currency) : d.doc_type === "invoice" ? <Badge color="green">Paid</Badge> : ""}</td>
            <td className="text-right">{bal > 0 && data.online_pay && <a className="inline-flex items-center gap-1 rounded-lg bg-brand-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-800" href={d.link.replace("/verify/", "/pay/")}><CreditCard className="h-3.5 w-3.5" />Pay</a>}</td></tr>;
        })}</tbody>
      </table></TableWrap> : <EmptyState title="No invoices yet" />}</Card>
      {data.quotes.length > 0 && <Card title="Quotations and orders" padded={false} className="mt-5"><TableWrap><table className="table">
        <thead><tr><th>Date</th><th>Document</th><th>Status</th><th className="num">Amount</th><th /></tr></thead>
        <tbody>{data.quotes.map((d: any) => <tr key={d.id}><td>{fmtDate(d.issue_date)}</td><td><a className="text-brand-700 hover:underline dark:text-brand-300" href={d.link}>{label(d)} {d.number}</a></td>
          <td><Badge color={d.status === "accepted" ? "green" : d.status === "declined" ? "red" : "gray"}>{d.status}</Badge></td><td className="num">{m(d.total, d.currency)}</td>
          <td className="whitespace-nowrap text-right">{d.doc_type === "quote" && d.status === "open" && <>
            <Button size="sm" loading={busy === d.id} onClick={() => void quote(d.id, "accept")}>Accept</Button>{" "}
            <Button size="sm" variant="ghost" disabled={busy === d.id} onClick={() => { if (confirm("Decline this quotation?")) void quote(d.id, "decline"); }}>Decline</Button></>}</td></tr>)}</tbody>
      </table></TableWrap></Card>}
      {data.receipts.length > 0 && <Card title="Payments received" padded={false} className="mt-5"><TableWrap><table className="table">
        <thead><tr><th>Date</th><th>Receipt</th><th>Method</th><th className="num">Amount</th></tr></thead>
        <tbody>{data.receipts.map((r: any, i: number) => <tr key={i}><td>{fmtDate(r.payment_date)}</td><td>{r.number}</td><td>{r.method ?? ""}{r.reference ? <span className="block text-xs muted">{r.reference}</span> : null}</td><td className="num">{m(r.amount, r.currency)}</td></tr>)}</tbody>
      </table></TableWrap></Card>}
      <p className="mt-6 text-xs muted">This page is private to you. Questions about your account? Contact {data.business.name}{data.business.phone ? ` on ${data.business.phone}` : ""}.</p>
      <ProductCredit className="mt-4 text-center" />
      <Link to="/" className="sr-only">LedgerFox</Link>
    </div>
  );
}
