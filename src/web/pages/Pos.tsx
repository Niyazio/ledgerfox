import { useEffect, useMemo, useRef, useState } from "react";
import { Minus, Pause, Play, Plus, Printer, Trash2, X } from "lucide-react";
import { useCompany } from "../lib/company";
import { useApi } from "../lib/hooks";
import { api, errorMessage } from "../lib/api";
import { Alert, Button, Card, Input, Select } from "../components/ui";
import { ScanInput } from "../components/Scanner";
import { computeDocument, resolveTaxMode, schemeForCountry, type TaxCodeLike } from "@shared/tax";
import { parseDecimal, roundToWhole } from "@shared/money";
import { currencyExponent } from "@shared/currencies";
import { toInput } from "../lib/format";

interface Item { id: string; name: string; code: string | null; sale_price: number; tax_code_id: string | null; unit: string; stock_qty_milli?: number; track_inventory: number }
interface CartLine { item: Item; qty: number }
interface Held { id: string; at: string; lines: CartLine[]; customer: string }

const heldKey = (cid: string) => `ledgerfox-pos-held-${cid}`;
const loadHeld = (cid: string): Held[] => { try { return JSON.parse(localStorage.getItem(heldKey(cid)) ?? "[]"); } catch { return []; } };
const saveHeld = (cid: string, h: Held[]) => { try { localStorage.setItem(heldKey(cid), JSON.stringify(h)); } catch { /* storage unavailable */ } };

/** Counter billing: scan or tap products, take cash/UPI/card (or split), print the thermal bill. F2 search · F9 pay · Esc clear. */
export default function Pos() {
  const { path, money, settings, id, branch } = useCompany();
  const [q, setQ] = useState("");
  const items = useApi<{ items: Item[] }>(path(`/items?active=1&limit=60${q ? `&q=${encodeURIComponent(q)}` : ""}`));
  const customers = useApi<{ contacts: { id: string; name: string }[] }>(path("/contacts?kind=customer&active=1&limit=500"));
  const [cart, setCart] = useState<CartLine[]>([]);
  const [customer, setCustomer] = useState("");
  const [mode, setMode] = useState<"cash" | "upi" | "card" | "split">("cash");
  const [tendered, setTendered] = useState("");
  const [split, setSplit] = useState({ cash: "", upi: "", card: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [held, setHeld] = useState<Held[]>(() => loadHeld(id));
  const [last, setLast] = useState<{ id: string; number: string; change: number } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const cur = settings?.company.base_currency ?? "INR";
  const exp = currencyExponent(cur);

  const add = (item: Item, n = 1) => {
    setError(null); setLast(null);
    setCart((c) => (c.some((l) => l.item.id === item.id) ? c.map((l) => (l.item.id === item.id ? { ...l, qty: l.qty + n } : l)) : [...c, { item, qty: n }]));
  };
  const setQty = (itemId: string, qty: number) => setCart((c) => (qty <= 0 ? c.filter((l) => l.item.id !== itemId) : c.map((l) => (l.item.id === itemId ? { ...l, qty } : l))));

  // Same calculation as the server (intra-state for a counter sale), so the total shown is what gets billed.
  const totals = useMemo(() => {
    const taxMap = new Map((settings?.tax_codes ?? []).map((t) => [t.id, t as TaxCodeLike]));
    const taxMode = resolveTaxMode(schemeForCountry(settings?.company.country ?? "IN"), settings?.company.state_code, settings?.company.state_code);
    const t = computeDocument(cart.map((l) => ({ qty_milli: Math.round(l.qty * 1000), unit_price: l.item.sale_price, discount_bp: 0, tax: l.item.tax_code_id ? taxMap.get(l.item.tax_code_id) ?? null : null })), taxMode);
    const round = settings?.company.round_off_invoices ? roundToWhole(t.total_before_round, exp) - t.total_before_round : 0;
    return { ...t, total: t.total_before_round + round, round };
  }, [cart, settings, exp]);

  const parse = (v: string) => { try { return v ? parseDecimal(v, exp) : 0; } catch { return NaN; } };
  const cashGiven = parse(tendered);
  const payments = mode === "split"
    ? (["cash", "upi", "card"] as const).map((m) => ({ mode: m, amount: split[m] })).filter((p) => p.amount)
    : [{ mode, amount: toInput(mode === "cash" && cashGiven > 0 && cashGiven < totals.total ? cashGiven : totals.total, cur) }];
  const paid = payments.reduce((t, p) => t + (parse(p.amount) || 0), 0);
  const change = mode === "cash" && cashGiven > totals.total ? cashGiven - totals.total : 0;

  const reset = () => { setCart([]); setTendered(""); setSplit({ cash: "", upi: "", card: "" }); setCustomer(""); setError(null); };
  const pay = async () => {
    if (!cart.length || busy) return;
    if (mode === "split" && paid !== totals.total && !customer) return setError("Split amounts must add up to the bill for a walk-in customer");
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ invoice_id: string; number: string }>(path("/pos/sale"), {
        contact_id: customer || null, branch_id: branch || null,
        lines: cart.map((l) => ({ item_id: l.item.id, quantity: String(l.qty) })), payments,
      }, { "idempotency-key": crypto.randomUUID() });
      setLast({ id: r.invoice_id, number: r.number, change });
      window.open(`/print/${id}/document/${r.invoice_id}?format=thermal80&auto=1`, "_blank", "noopener,width=420,height=700");
      reset();
      items.reload();
      setTimeout(() => searchRef.current?.focus(), 50);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  const hold = () => {
    if (!cart.length) return;
    const h = [...held, { id: crypto.randomUUID(), at: new Date().toLocaleTimeString(), lines: cart, customer }];
    setHeld(h); saveHeld(id, h); reset();
  };
  const resume = (h: Held) => { setCart(h.lines); setCustomer(h.customer); const rest = held.filter((x) => x.id !== h.id); setHeld(rest); saveHeld(id, rest); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F2") { e.preventDefault(); searchRef.current?.focus(); }
      else if (e.key === "F9") { e.preventDefault(); void pay(); }
      else if (e.key === "Escape" && !document.querySelector("[role=dialog]")) reset();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_26rem]">
      <div className="space-y-3">
        <Card>
          <div className="grid gap-3 sm:grid-cols-2">
            <ScanInput label="Scan barcode / QR" autoFocus onItem={(it) => add(it as Item)} onError={setError} />
            <div><label className="mb-1.5 block text-sm font-medium" htmlFor="pos-search">Search (F2)</label>
              <input id="pos-search" className="input" ref={searchRef} value={q} placeholder="Name, code or SKU" onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && items.data?.items[0]) { add(items.data.items[0]); setQ(""); } }} /></div>
          </div>
        </Card>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
          {(items.data?.items ?? []).map((it) => (
            <button key={it.id} onClick={() => add(it)} className="card flex h-24 flex-col justify-between p-3 text-left hover:border-brand-500 active:scale-[0.98]">
              <span className="line-clamp-2 text-sm font-medium">{it.name}</span>
              <span className="flex items-end justify-between text-xs"><span className="font-semibold">{money(it.sale_price)}</span>
                {it.track_inventory ? <span className={(it.stock_qty_milli ?? 0) <= 0 ? "text-red-600" : "muted"}>{(it.stock_qty_milli ?? 0) / 1000} {it.unit}</span> : null}</span>
            </button>
          ))}
        </div>
        {held.length > 0 && (
          <Card title="Held bills">
            <div className="flex flex-wrap gap-2">{held.map((h) => <Button key={h.id} size="sm" variant="secondary" onClick={() => resume(h)}><Play className="h-3.5 w-3.5" />{h.at} · {h.lines.length} items</Button>)}</div>
          </Card>
        )}
      </div>

      <Card className="lg:sticky lg:top-0 lg:self-start">
        <div className="mb-3 flex items-center justify-between"><h2 className="font-semibold">Bill</h2>
          <div className="flex gap-1"><Button size="sm" variant="ghost" onClick={hold} disabled={!cart.length}><Pause className="h-4 w-4" />Hold</Button>
            <Button size="sm" variant="ghost" onClick={reset} disabled={!cart.length}><X className="h-4 w-4" />Clear</Button></div></div>
        <Select value={customer} onChange={(e) => setCustomer(e.target.value)} aria-label="Customer" className="mb-3">
          <option value="">Walk-in customer</option>
          {(customers.data?.contacts ?? []).filter((c) => c.name !== "Walk-in customer").map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <ul className="max-h-[40vh] divide-y divide-[var(--border)] overflow-y-auto">
          {!cart.length && <li className="py-6 text-center text-sm muted">Scan or tap products</li>}
          {cart.map((l) => (
            <li key={l.item.id} className="flex items-center gap-2 py-2 text-sm">
              <div className="min-w-0 flex-1"><p className="truncate font-medium">{l.item.name}</p><p className="text-xs muted">{money(l.item.sale_price)} each</p></div>
              <button aria-label="Less" className="rounded border border-[var(--border)] p-1" onClick={() => setQty(l.item.id, l.qty - 1)}><Minus className="h-3.5 w-3.5" /></button>
              <input aria-label="Quantity" className="input w-14 px-1 text-center" inputMode="decimal" value={l.qty} onChange={(e) => setQty(l.item.id, Number(e.target.value) || 0)} />
              <button aria-label="More" className="rounded border border-[var(--border)] p-1" onClick={() => setQty(l.item.id, l.qty + 1)}><Plus className="h-3.5 w-3.5" /></button>
              <span className="w-20 text-right tabular-nums">{money(Math.round(l.item.sale_price * l.qty))}</span>
              <button aria-label="Remove" className="p-1 muted hover:text-red-600" onClick={() => setQty(l.item.id, 0)}><Trash2 className="h-4 w-4" /></button>
            </li>
          ))}
        </ul>
        <dl className="mt-3 space-y-1 border-t border-[var(--border)] pt-3 text-sm">
          <div className="flex justify-between"><dt className="muted">Items</dt><dd>{money(totals.taxable_total)}</dd></div>
          {totals.cgst + totals.sgst + totals.igst + totals.other_tax > 0 && <div className="flex justify-between"><dt className="muted">GST</dt><dd>{money(totals.cgst + totals.sgst + totals.igst + totals.other_tax)}</dd></div>}
          {totals.round !== 0 && <div className="flex justify-between"><dt className="muted">Round off</dt><dd>{money(totals.round)}</dd></div>}
          <div className="flex justify-between text-2xl font-bold"><dt>Total</dt><dd>{money(totals.total)}</dd></div>
        </dl>
        <div className="mt-3 grid grid-cols-4 gap-1">
          {(["cash", "upi", "card", "split"] as const).map((m) => <Button key={m} size="sm" variant={mode === m ? "primary" : "secondary"} onClick={() => setMode(m)}>{m === "upi" ? "UPI" : m[0].toUpperCase() + m.slice(1)}</Button>)}
        </div>
        {mode === "cash" && <div className="mt-3 flex items-center gap-2 text-sm"><label htmlFor="tendered" className="muted">Cash given</label>
          <Input id="tendered" inputMode="decimal" className="w-32" value={tendered} placeholder={toInput(totals.total, cur)} onChange={(e) => setTendered(e.target.value)} />
          {change > 0 && <span className="font-semibold">Change {money(change)}</span>}</div>}
        {mode === "split" && <div className="mt-3 grid grid-cols-3 gap-2">{(["cash", "upi", "card"] as const).map((m) => (
          <label key={m} className="text-xs muted">{m.toUpperCase()}<Input inputMode="decimal" value={split[m]} onChange={(e) => setSplit({ ...split, [m]: e.target.value })} /></label>))}
          <p className="col-span-3 text-xs muted">Paid {money(paid)} of {money(totals.total)}{paid < totals.total ? ` · ${money(totals.total - paid)} on credit (choose the customer)` : ""}</p></div>}
        {error && <Alert className="mt-3">{error}</Alert>}
        <Button className="mt-3 w-full py-3 text-base" loading={busy} disabled={!cart.length} onClick={() => void pay()}><Printer className="h-5 w-5" />Pay & print (F9)</Button>
        {last && <p className="mt-2 text-center text-sm text-emerald-700 dark:text-emerald-400">Saved {last.number}{last.change ? ` · give change ${money(last.change)}` : ""}</p>}
      </Card>
    </div>
  );
}
