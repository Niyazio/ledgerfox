import { Suspense, useEffect, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation, useNavigate, useParams, Link } from "react-router";
import {
  LayoutDashboard, BookOpen, FileText, ShoppingCart, Receipt, Landmark, Package, Building2, BarChart3, Settings, Users,
  Menu, X, Moon, Sun, LogOut, ChevronDown, Wallet, Lightbulb, Briefcase, CloudOff, RefreshCw, AlertTriangle, Trash2,
  CalendarDays, ArrowLeftRight, QrCode, ShieldCheck, UserCog, GitBranch, CalendarRange, TrendingUp, Scale, FileUp, Truck, Repeat, ShoppingBag, Factory,
} from "lucide-react";
import { useSession } from "../lib/session";
import { CompanyProvider, useCompany } from "../lib/company";
import { Button, cx, Modal, Spinner } from "./ui";
import { ROLE_LABELS, type Permission, type Role } from "@shared/permissions";
import { useRecurringAutoRun } from "../pages/Recurring";
import { setLang, useLang } from "../lib/lang";
import { UpdateCenter } from "./Updates";
import { Shortcuts } from "./Shortcuts";
import { HINTS } from "../lib/shortcuts";
import { Assistant } from "./Assistant";
import { LANGS, type Lang } from "@shared/i18n";
import { PlanBanner } from "../pages/Billing";
import { flushOutbox, removeOutboxEntry, retryOutboxEntry, useOnline, useOutbox, warmOfflineCache } from "../lib/offline";

/** LedgerFox mark: geometric fox head on a blue tile (matches public/favicon.svg). */
export function Logo({ className = "h-7 w-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect width="32" height="32" rx="8" fill="#1d4ed8" />
      <path d="M6.5 5.5 13 11.5h6l6.5-6v10.5L16 27 6.5 16z" fill="#fff" />
      <path d="M8.6 8.9 11.4 11.5 8.6 13.9z M23.4 8.9 20.6 11.5 23.4 13.9z" fill="#93c5fd" />
      <path d="M6.5 16 16 27l-4.6-9.6z M25.5 16 16 27l4.6-9.6z" fill="#dbeafe" />
      <circle cx="12.4" cy="15.6" r="1.25" fill="#172554" />
      <circle cx="19.6" cy="15.6" r="1.25" fill="#172554" />
      <path d="M14.6 20.6h2.8L16 22.4z" fill="#172554" />
    </svg>
  );
}

export const SUPPORT_EMAIL = "info@niyazio.com";

/** "A product of Niyazio" credit with the support contact. */
export function ProductCredit({ className = "" }: { className?: string }) {
  return (
    <p className={`text-xs muted ${className}`}>
      A product of <a href="https://niyazio.com" target="_blank" rel="noreferrer" className="font-medium hover:underline">Niyazio</a> · Support:{" "}
      <a href={`mailto:${SUPPORT_EMAIL}?subject=LedgerFox%20support`} className="hover:underline">{SUPPORT_EMAIL}</a>
    </p>
  );
}

/** Mark plus brand name. */
export function Wordmark({ brand = "LedgerFox", iconClass }: { brand?: string; iconClass?: string }) {
  return (
    <span className="flex items-center gap-2 font-semibold tracking-tight">
      <Logo className={iconClass} />
      {brand}
    </span>
  );
}

export function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try { localStorage.setItem("ledgerfox-theme", next ? "dark" : "light"); } catch { /* storage unavailable */ }
  };
  return { dark, toggle };
}

interface NavItem { to: string; label: string; icon: ReactNode; perm?: Permission | Permission[] }
interface NavGroup { label: string; items: NavItem[] }

const NAV: NavGroup[] = [
  { label: "", items: [
    { to: "dashboard", label: "Dashboard", icon: <LayoutDashboard className="h-4 w-4" />, perm: "reports.read" },
    { to: "daybook", label: "Daybook", icon: <CalendarDays className="h-4 w-4" />, perm: "daybook.read" },
  ] },
  { label: "Sales & billing", items: [
    { to: "pos", label: "POS / counter billing", icon: <ShoppingBag className="h-4 w-4" />, perm: "sales.post" },
    { to: "customers", label: "Customers", icon: <Users className="h-4 w-4" />, perm: "sales.view" },
    { to: "sales/quote", label: "Quotations", icon: <FileText className="h-4 w-4" />, perm: "sales.view" },
    { to: "sales/proforma", label: "Proforma invoices", icon: <FileText className="h-4 w-4" />, perm: "sales.view" },
    { to: "sales/sales_order", label: "Sales orders", icon: <FileText className="h-4 w-4" />, perm: "sales.view" },
    { to: "sales/delivery_challan", label: "Delivery challans", icon: <Truck className="h-4 w-4" />, perm: "sales.view" },
    { to: "sales/invoice", label: "Invoices / bills", icon: <FileText className="h-4 w-4" />, perm: "sales.view" },
    { to: "recurring", label: "Recurring invoices", icon: <Repeat className="h-4 w-4" />, perm: "sales.create" },
    { to: "sales/credit_note", label: "Sales returns", icon: <FileText className="h-4 w-4" />, perm: "sales.view" },
    { to: "payments/in", label: "Receipts", icon: <Wallet className="h-4 w-4" />, perm: "sales.view" },
  ] },
  { label: "Purchases", items: [
    { to: "suppliers", label: "Suppliers", icon: <Users className="h-4 w-4" />, perm: "purchase.view" },
    { to: "purchases/purchase_order", label: "Purchase orders", icon: <ShoppingCart className="h-4 w-4" />, perm: "purchase.view" },
    { to: "purchases/bill", label: "Supplier bills", icon: <ShoppingCart className="h-4 w-4" />, perm: "purchase.view" },
    { to: "purchases/debit_note", label: "Purchase returns", icon: <ShoppingCart className="h-4 w-4" />, perm: "purchase.view" },
    { to: "payments/out", label: "Supplier payments", icon: <Wallet className="h-4 w-4" />, perm: "purchase.view" },
  ] },
  { label: "Inventory", items: [
    { to: "inventory", label: "Products & stock", icon: <Package className="h-4 w-4" />, perm: "inventory.view" },
    { to: "inventory?tab=transfers", label: "Stock transfers", icon: <ArrowLeftRight className="h-4 w-4" />, perm: "inventory.transfer" },
    { to: "labels", label: "Product labels / QR", icon: <QrCode className="h-4 w-4" />, perm: "labels.print" },
    { to: "production", label: "Manufacturing", icon: <Factory className="h-4 w-4" />, perm: "inventory.view" },
  ] },
  { label: "Accounting", items: [
    { to: "expenses", label: "Expenses", icon: <Receipt className="h-4 w-4" />, perm: ["expense.create", "expense.approve"] },
    { to: "banking", label: "Banking", icon: <Landmark className="h-4 w-4" />, perm: "bank.reconcile" },
    { to: "journals", label: "Journals & ledgers", icon: <BookOpen className="h-4 w-4" />, perm: "journal.view" },
    { to: "accounts", label: "Chart of accounts", icon: <BookOpen className="h-4 w-4" />, perm: "journal.view" },
    { to: "assets", label: "Fixed assets", icon: <Building2 className="h-4 w-4" />, perm: "assets.manage" },
  ] },
  { label: "People", items: [
    { to: "payroll", label: "Payroll & timesheets", icon: <Briefcase className="h-4 w-4" />, perm: "payroll.read" },
  ] },
  { label: "Reports & control", items: [
    { to: "reports/cash-book", label: "Cash / bank book", icon: <BookOpen className="h-4 w-4" />, perm: "reports.read" },
    { to: "reports/daily", label: "Daily report", icon: <CalendarRange className="h-4 w-4" />, perm: "reports.read" },
    { to: "reports/profit-loss", label: "Profit & loss", icon: <TrendingUp className="h-4 w-4" />, perm: "reports.read" },
    { to: "reports/balance-sheet", label: "Balance sheet", icon: <Scale className="h-4 w-4" />, perm: "reports.read" },
    { to: "reports/gst-returns", label: "GST returns", icon: <Landmark className="h-4 w-4" />, perm: "reports.export" },
    { to: "reports", label: "All reports", icon: <BarChart3 className="h-4 w-4" />, perm: "reports.read" },
    { to: "insights", label: "Insights", icon: <Lightbulb className="h-4 w-4" />, perm: "reports.read" },
    { to: "settings?tab=audit", label: "Audit log", icon: <ShieldCheck className="h-4 w-4" />, perm: "audit.read" },
  ] },
  { label: "Administration", items: [
    { to: "settings?tab=members", label: "Users & permissions", icon: <UserCog className="h-4 w-4" />, perm: "org.manage" },
    { to: "settings?tab=dimensions", label: "Branches", icon: <GitBranch className="h-4 w-4" />, perm: "branches.manage" },
    { to: "import", label: "Import from Excel", icon: <FileUp className="h-4 w-4" />, perm: ["items.write", "customers.write", "suppliers.write"] },
    { to: "settings", label: "Settings", icon: <Settings className="h-4 w-4" /> },
  ] },
];

function LangPicker() {
  const { lang, t } = useLang();
  return (
    <select aria-label={t("Language")} title={t("Language")} value={lang} onChange={(e) => setLang(e.target.value as Lang)}
      className="rounded-lg border-0 bg-transparent py-1 pl-1 pr-6 text-sm hover:bg-[var(--surface-2)]">
      {LANGS.map((l) => <option key={l.value} value={l.value}>{l.value === "en" ? "EN" : l.value === "hi" ? "हि" : "த"}</option>)}
    </select>
  );
}

/** Every sidebar screen, for the Go-to search (Alt+G / Ctrl+K). */
const GOTO_ITEMS = NAV.flatMap((g) => g.items.map((i) => ({ to: i.to, label: i.label, group: g.label || undefined, perm: i.perm })));

/** Modules the member may use; the server enforces the same permissions on every request. */
function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { companyId } = useParams();
  const { can, settings } = useCompany();
  const { t } = useLang();
  const location = useLocation();
  const allowed = (it: NavItem) => !it.perm || !settings || (Array.isArray(it.perm) ? it.perm.some(can) : can(it.perm));
  const groups = NAV.map((g) => ({ ...g, items: g.items.filter(allowed) })).filter((g) => g.items.length);
  const here = `${location.pathname.replace(`/app/${companyId}/`, "")}${location.search}`;
  return (
    <nav aria-label="Main" className="flex h-full flex-col gap-4 overflow-y-auto px-3 py-4">
      {groups.map((g, i) => (
        <div key={i}>
          {g.label && <p className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider muted">{t(g.label)}</p>}
          <ul className="space-y-0.5">
            {g.items.map((it) => (
              <li key={it.to}>
                <NavLink to={`/app/${companyId}/${it.to}`} end={it.to === "reports"} onClick={onNavigate}
                  className={({ isActive }) => cx("flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm", (it.to.includes("?") ? here === it.to : isActive && !NAV.some((g2) => g2.items.some((x) => x.to.includes("?") && here === x.to))) ? "bg-brand-50 font-medium text-brand-800 dark:bg-brand-900/30 dark:text-brand-200" : "hover:bg-[var(--surface-2)]")}>
                  {it.icon}<span className="flex-1">{t(it.label)}</span>{HINTS[it.to] && <kbd className="hidden rounded border border-[var(--border)] px-1 font-mono text-[10px] muted lg:inline">{HINTS[it.to]}</kbd>}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <ProductCredit className="px-3 pb-4 pt-2" />
    </nav>
  );
}

/** Branch in use, financial year, and the signed-in user's role, shown in the header. */
function WorkContext() {
  const { settings, branches, branch, setBranch } = useCompany();
  const { me } = useSession();
  if (!settings) return null;
  const startMonth = settings.company.fiscal_year_start_month;
  const now = new Date();
  const fyStart = now.getMonth() + 1 >= startMonth ? now.getFullYear() : now.getFullYear() - 1;
  const fy = startMonth === 1 ? `FY ${fyStart}` : `FY ${fyStart}-${String(fyStart + 1).slice(2)}`;
  const all = settings.branch_scope?.all ?? true;
  return (
    <div className="hidden items-center gap-2 text-xs md:flex">
      {branches.length > 0 && (
        <select value={branch} onChange={(e) => setBranch(e.target.value)} aria-label="Branch" className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs">
          {all && <option value="">All branches</option>}
          {branches.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.code}){b.is_active ? "" : " · inactive"}</option>)}
        </select>
      )}
      <span className="rounded bg-[var(--surface-2)] px-2 py-1">{fy}</span>
      <span className="rounded bg-[var(--surface-2)] px-2 py-1" title={me?.user?.name}>{ROLE_LABELS[settings.role as Role] ?? settings.role}</span>
    </div>
  );
}

function CompanySwitcher() {
  const { me } = useSession();
  const { settings } = useCompany();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const companies = me?.companies ?? [];
  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)} className="flex max-w-[16rem] items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium hover:bg-[var(--surface-2)]" aria-haspopup="listbox" aria-expanded={open}>
        <span className="truncate">{settings?.company.name ?? "…"}</span>
        <ChevronDown className="h-4 w-4 shrink-0 muted" />
      </button>
      {open && (
        <div className="card absolute left-0 z-40 mt-1 w-72 p-1 shadow-lg" role="listbox" onMouseLeave={() => setOpen(false)}>
          {companies.map((c) => (
            <button key={c.id} role="option" aria-selected={c.id === settings?.company.id} onClick={() => { setOpen(false); nav(`/app/${c.id}/dashboard`); }}
              className={cx("flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm hover:bg-[var(--surface-2)]", c.id === settings?.company.id && "font-semibold")}>
              <span className="truncate">{c.name}</span><span className="text-xs muted">{c.base_currency}</span>
            </button>
          ))}
          <div className="my-1 border-t border-[var(--border)]" />
          {(me?.companies.length ?? 0) > 1 && <Link to="/app/clients" onClick={() => setOpen(false)} className="block rounded-md px-3 py-2 text-sm text-brand-700 hover:bg-[var(--surface-2)] dark:text-brand-300">All clients at a glance</Link>}
          <Link to="/app/new-company" onClick={() => setOpen(false)} className="block rounded-md px-3 py-2 text-sm text-brand-700 hover:bg-[var(--surface-2)] dark:text-brand-300">+ Add company</Link>
        </div>
      )}
    </div>
  );
}

/** Connection state plus records saved on this device that have not reached the server yet. */
function OfflineStatus({ companyId }: { companyId: string }) {
  const online = useOnline();
  const entries = useOutbox(companyId);
  const [open, setOpen] = useState(false);
  const failed = entries.filter((e) => e.status === "failed").length;
  if (online && !entries.length) return null;
  return (
    <>
      <button onClick={() => setOpen(true)} className={cx("flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium",
        failed ? "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300" : online ? "bg-brand-50 text-brand-800 dark:bg-brand-900/30 dark:text-brand-200" : "bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200")}>
        {failed ? <AlertTriangle className="h-3.5 w-3.5" /> : online ? <RefreshCw className="h-3.5 w-3.5" /> : <CloudOff className="h-3.5 w-3.5" />}
        {!online ? "Offline" : failed ? `${failed} failed to sync` : "Syncing"}{entries.length ? ` · ${entries.length} on device` : ""}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Saved on this device"
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Close</Button><Button disabled={!online || !entries.length} onClick={() => void flushOutbox()}><RefreshCw className="h-4 w-4" />Sync now</Button></>}>
        <p className="mb-3 text-sm muted">
          {online ? "You're online." : "You're offline. Pages you opened before are shown from this device and may be out of date."} New
          records made without a connection wait here and are sent automatically when you reconnect. Each is sent at most once.
        </p>
        {entries.length ? (
          <ul className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
            {entries.map((e) => (
              <li key={e.id} className="flex items-start justify-between gap-3 px-3 py-2.5 text-sm">
                <div className="min-w-0">
                  <p className="font-medium">{e.label}</p>
                  <p className="text-xs muted">{new Date(e.createdAt).toLocaleString()} · {e.status === "failed" ? "Rejected by the server" : "Waiting to send"}</p>
                  {e.error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{e.error}</p>}
                </div>
                {e.status === "failed" && (
                  <span className="flex shrink-0 gap-1">
                    <button className="rounded p-1 hover:bg-[var(--surface-2)]" aria-label="Retry" title="Retry" onClick={() => void retryOutboxEntry(e)}><RefreshCw className="h-4 w-4" /></button>
                    <button className="rounded p-1 hover:bg-[var(--surface-2)]" aria-label="Discard" title="Discard" onClick={() => { if (confirm(`Discard "${e.label}"? It will not be sent.`)) void removeOutboxEntry(e.id); }}><Trash2 className="h-4 w-4" /></button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : <p className="text-sm muted">Nothing waiting.</p>}
      </Modal>
    </>
  );
}

function RecurringRunner() { useRecurringAutoRun(); return null; }

function Shell() {
  const { me, logout } = useSession();
  const { settings, id: companyId } = useCompany();
  const { pathname } = useLocation();
  const { dark, toggle } = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const nav = useNavigate();
  const pending = useOutbox();
  const online = useOnline();
  useEffect(() => { if (online) warmOfflineCache(companyId); }, [companyId, online]);
  const signOut = async () => {
    if (pending.length && !confirm(`${pending.length} record(s) made offline have not been sent yet. Signing out deletes them from this device. Sign out anyway?`)) return;
    await logout();
    nav("/login");
  };
  useEffect(() => {
    if (settings) document.title = `${settings.company.name} · ${me?.brand ?? "LedgerFox"}`;
  }, [settings, me?.brand]);
  return (
    <div className="flex h-full">
      <aside className="hidden w-60 shrink-0 border-r border-[var(--border)] bg-[var(--surface)] lg:flex lg:flex-col">
        <Link to="/app" className="px-5 py-4 text-base"><Wordmark brand={me?.brand} /></Link>
        <Sidebar />
      </aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-slate-950/50" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-72 flex-col bg-[var(--surface)] shadow-xl">
            <div className="flex items-center justify-between px-4 py-3"><Wordmark brand={me?.brand} />
              <button onClick={() => setMobileOpen(false)} aria-label="Close menu" className="rounded p-1 hover:bg-[var(--surface-2)]"><X className="h-5 w-5" /></button></div>
            <Sidebar onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="app-header flex h-14 shrink-0 items-center justify-between gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3 sm:px-5">
          <div className="flex min-w-0 items-center gap-1">
            <button className="rounded p-2 hover:bg-[var(--surface-2)] lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open menu"><Menu className="h-5 w-5" /></button>
            <CompanySwitcher />
            <WorkContext />
          </div>
          <div className="flex items-center gap-1">
            <OfflineStatus companyId={companyId} />
            <Shortcuts items={GOTO_ITEMS} />
            <UpdateCenter />
            <LangPicker />
            <button onClick={toggle} className="rounded-lg p-2 hover:bg-[var(--surface-2)]" aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}>
              {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
            <span className="hidden max-w-[12rem] truncate px-2 text-sm muted sm:inline">{me?.user?.name}</span>
            <button onClick={signOut} className="rounded-lg p-2 hover:bg-[var(--surface-2)]" aria-label="Sign out" title="Sign out"><LogOut className="h-4 w-4" /></button>
          </div>
        </header>
        {me?.edition === "offline" && <div className="no-print border-b border-amber-300 bg-amber-50 px-4 py-1.5 text-center text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">View-only copy saved on this phone — no internet needed. Changes are made on the office computer.</div>}
        {settings && me?.edition !== "offline" && <RecurringRunner />}
        {settings && me?.edition === "cloud" && <PlanBanner />}
        <main className="min-w-0 flex-1 overflow-y-auto px-3 py-5 sm:px-6">
          <div className="mx-auto max-w-7xl"><Suspense fallback={<Spinner />}><Outlet /></Suspense></div>
        </main>
        {settings && me?.edition !== "offline" && !/\/pos$/.test(pathname) && <Assistant />}
      </div>
    </div>
  );
}

export function CompanyLayout() {
  const { companyId } = useParams();
  return <CompanyProvider key={companyId} id={companyId!}><Shell /></CompanyProvider>;
}
