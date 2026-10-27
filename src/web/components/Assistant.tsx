import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { MessageCircle, Send, X } from "lucide-react";
import { useCompany } from "../lib/company";
import { api, errorMessage } from "../lib/api";
import { Button } from "./ui";

interface Reply { text: string; table?: { columns: string[]; rows: (string | number)[][] }; links?: { label: string; to: string }[]; suggestions?: string[] }
interface Msg { from: "me" | "bot"; text: string; reply?: Reply }

const START: Msg = { from: "bot", text: "", reply: { text: "Hello! Ask me about your sales, dues, customers, stock, GST or how to do something.", suggestions: ["Sales this month", "Who owes me money?", "Overdue invoices", "Top customers", "Cash and bank balance", "How do I create an invoice?"] } };
const key = (id: string) => `ledgerfox-assistant-${id}`;

/** Floating "Ask LedgerFox" chat. Answers come from this company's books on the server (no AI service). */
export function Assistant() {
  const { id, path } = useCompany();
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>(() => { try { return JSON.parse(sessionStorage.getItem(key(id)) ?? "null") ?? [START]; } catch { return [START]; } });
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { try { sessionStorage.setItem(key(id), JSON.stringify(msgs.slice(-40))); } catch { /* storage unavailable */ } }, [msgs, id]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [msgs, open]);
  useEffect(() => { if (open) input.current?.focus(); }, [open]);

  const ask = async (q: string) => {
    const message = q.trim();
    if (!message || busy) return;
    setText("");
    setMsgs((m) => [...m, { from: "me", text: message }]);
    setBusy(true);
    try {
      const reply = await api.post<Reply>(path("/assistant"), { message });
      setMsgs((m) => [...m, { from: "bot", text: reply.text, reply }]);
    } catch (e) {
      setMsgs((m) => [...m, { from: "bot", text: errorMessage(e) }]);
    } finally { setBusy(false); }
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="no-print fixed bottom-5 right-5 z-30 flex items-center gap-2 rounded-full bg-brand-700 px-4 py-3 text-sm font-medium text-white shadow-lg hover:bg-brand-800" aria-label="Ask LedgerFox">
        <MessageCircle className="h-5 w-5" /><span className="hidden sm:inline">Ask</span>
      </button>
    );
  }
  return (
    <section aria-label="Ask LedgerFox" className="no-print fixed inset-x-2 bottom-2 z-40 flex max-h-[80vh] flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl sm:inset-x-auto sm:right-5 sm:w-[26rem]">
      <header className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2.5">
        <p className="font-semibold">Ask LedgerFox</p>
        <div className="flex items-center gap-1">
          <button className="rounded px-2 py-1 text-xs muted hover:bg-[var(--surface-2)]" onClick={() => setMsgs([START])}>Clear</button>
          <button className="rounded p-1 hover:bg-[var(--surface-2)]" onClick={() => setOpen(false)} aria-label="Close"><X className="h-4 w-4" /></button>
        </div>
      </header>
      <div className="flex-1 space-y-3 overflow-y-auto p-3 text-sm" aria-live="polite">
        {msgs.map((m, i) => m.from === "me" ? (
          <p key={i} className="ml-auto max-w-[85%] w-fit rounded-2xl rounded-br-sm bg-brand-700 px-3 py-2 text-white">{m.text}</p>
        ) : (
          <div key={i} className="max-w-[95%] space-y-2 rounded-2xl rounded-bl-sm bg-[var(--surface-2)] px-3 py-2">
            <p className="whitespace-pre-line">{m.reply?.text ?? m.text}</p>
            {m.reply?.table && (
              <div className="overflow-x-auto"><table className="w-full text-xs">
                {m.reply.table.columns.some(Boolean) && <thead><tr>{m.reply.table.columns.map((c, j) => <th key={j} className={`py-1 pr-2 text-left font-semibold ${j > 0 ? "text-right" : ""}`}>{c}</th>)}</tr></thead>}
                <tbody>{m.reply.table.rows.map((r, j) => <tr key={j} className="border-t border-[var(--border)]">{r.map((c, k) => <td key={k} className={`py-1 pr-2 align-top ${k > 0 ? "text-right tabular-nums" : ""}`}>{c}</td>)}</tr>)}</tbody>
              </table></div>
            )}
            {m.reply?.links?.length ? <div className="flex flex-wrap gap-2">{m.reply.links.map((l) => <Link key={l.to} to={`/app/${id}/${l.to}`} onClick={() => { if (window.innerWidth < 640) setOpen(false); }} className="text-xs font-medium text-brand-700 underline dark:text-brand-300">{l.label} →</Link>)}</div> : null}
            {m.reply?.suggestions?.length && i === msgs.length - 1 ? <div className="flex flex-wrap gap-1.5 pt-1">{m.reply.suggestions.map((s) => <button key={s} onClick={() => void ask(s)} className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-xs hover:border-brand-500">{s}</button>)}</div> : null}
          </div>
        ))}
        {busy && <p className="muted">…</p>}
        <div ref={end} />
      </div>
      <form className="flex gap-2 border-t border-[var(--border)] p-2" onSubmit={(e) => { e.preventDefault(); void ask(text); }}>
        <input ref={input} className="input flex-1" placeholder="e.g. sales last month" value={text} maxLength={500} onChange={(e) => setText(e.target.value)} aria-label="Your question" />
        <Button type="submit" disabled={!text.trim() || busy} aria-label="Send"><Send className="h-4 w-4" /></Button>
      </form>
      <p className="px-3 pb-2 text-[10px] muted">Answers come from your own books, with your access rights. No AI service is used and nothing leaves LedgerFox.</p>
    </section>
  );
}
