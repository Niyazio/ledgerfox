import { useState } from "react";
import { Link } from "react-router";
import { X } from "lucide-react";
import { useCompany } from "../lib/company";
import { useApi } from "../lib/hooks";
import { api } from "../lib/api";

interface Promo { id: string; title: string; body: string; cta: string; link_url: string | null; to: string | null; sponsor: string | null }

const HIDE_KEY = "ledgerfox.promo.hidden";
const hiddenToday = () => { try { return localStorage.getItem(HIDE_KEY) === new Date().toISOString().slice(0, 10); } catch { return false; } };

/**
 * One small, dismissible card for organisations on the Free plan of the hosted edition. It is plain first-party text
 * and a link: no ad network script, image or tracker runs inside the app, so nothing outside LedgerFox can read the
 * books on screen. The server decides who sees it (never trial, paid, desktop or self-hosted users).
 */
export function PromoCard() {
  const { settings, id } = useCompany();
  const orgId = settings?.company.org_id;
  const [hidden, setHidden] = useState(hiddenToday);
  const { data } = useApi<{ promo: Promo | null }>(orgId && !hidden ? `/api/billing/org/${orgId}/promo` : null);
  const p = data?.promo;
  if (!p || hidden) return null;
  const click = () => { if (!p.id.startsWith("house-")) void api.post(`/api/billing/org/${orgId}/promo/${p.id}/click`).catch(() => {}); };
  const hide = () => { try { localStorage.setItem(HIDE_KEY, new Date().toISOString().slice(0, 10)); } catch { /* private mode */ } setHidden(true); };
  const cls = "shrink-0 rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm font-medium hover:bg-[var(--surface-2)]";
  return (
    <aside className="no-print relative mt-6 flex flex-wrap items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3" aria-label={p.sponsor ? "Sponsored message" : "Message from LedgerFox"}>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] uppercase tracking-wider muted">{p.sponsor ? `Sponsored · ${p.sponsor}` : "From LedgerFox"}</p>
        <p className="text-sm font-medium">{p.title}</p>
        <p className="text-sm muted">{p.body}</p>
      </div>
      {p.to ? <Link className={cls} to={`/app/${id}/${p.to}`}>{p.cta}</Link>
        : p.link_url?.startsWith("/") ? <a className={cls} href={p.link_url}>{p.cta}</a>
        : p.link_url?.startsWith("https://") ? <a className={cls} href={p.link_url} target="_blank" rel="noopener noreferrer sponsored" onClick={click}>{p.cta}</a> : null}
      <button className="absolute right-1.5 top-1.5 rounded p-1 muted hover:bg-[var(--surface-2)]" aria-label="Hide for today" title="Hide for today" onClick={hide}><X className="h-3.5 w-3.5" /></button>
    </aside>
  );
}
