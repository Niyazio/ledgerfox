import { Suspense, useEffect, useState, type ReactNode } from "react";
import { NavLink, Outlet, useNavigate, useParams, Link } from "react-router";
import {
  LayoutDashboard, BookOpen, FileText, ShoppingCart, Receipt, Landmark, Package, Building2, BarChart3, Settings, Users,
  Menu, X, Moon, Sun, LogOut, ChevronDown, Wallet, Lightbulb,
} from "lucide-react";
import { useSession } from "../lib/session";
import { CompanyProvider, useCompany } from "../lib/company";
import { cx, Spinner } from "./ui";

export function Logo({ className = "h-7 w-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect width="32" height="32" rx="8" fill="#0f766e" />
      <path d="M9 23 L16 8 L23 23" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11.5 18 H20.5" stroke="#5eead4" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}

export function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try { localStorage.setItem("arthika-theme", next ? "dark" : "light"); } catch { /* storage unavailable */ }
  };
  return { dark, toggle };
}

interface NavItem { to: string; label: string; icon: ReactNode; perm?: string }
interface NavGroup { label: string; items: NavItem[] }

const NAV: NavGroup[] = [
  { label: "", items: [{ to: "dashboard", label: "Dashboard", icon: <LayoutDashboard className="h-4 w-4" /> }] },
  { label: "Sales", items: [
    { to: "customers", label: "Customers", icon: <Users className="h-4 w-4" /> },
    { to: "sales/quote", label: "Quotations", icon: <FileText className="h-4 w-4" /> },
    { to: "sales/sales_order", label: "Sales orders", icon: <FileText className="h-4 w-4" /> },
    { to: "sales/invoice", label: "Invoices", icon: <FileText className="h-4 w-4" /> },
    { to: "sales/credit_note", label: "Credit notes", icon: <FileText className="h-4 w-4" /> },
    { to: "payments/in", label: "Receipts", icon: <Wallet className="h-4 w-4" /> },
  ] },
  { label: "Purchases", items: [
    { to: "suppliers", label: "Suppliers", icon: <Users className="h-4 w-4" /> },
    { to: "purchases/purchase_order", label: "Purchase orders", icon: <ShoppingCart className="h-4 w-4" /> },
    { to: "purchases/bill", label: "Bills", icon: <ShoppingCart className="h-4 w-4" /> },
    { to: "purchases/debit_note", label: "Debit notes", icon: <ShoppingCart className="h-4 w-4" /> },
    { to: "payments/out", label: "Payments", icon: <Wallet className="h-4 w-4" /> },
    { to: "expenses", label: "Expenses", icon: <Receipt className="h-4 w-4" /> },
  ] },
  { label: "Accounting", items: [
    { to: "banking", label: "Banking", icon: <Landmark className="h-4 w-4" /> },
    { to: "journals", label: "Journals", icon: <BookOpen className="h-4 w-4" /> },
    { to: "accounts", label: "Chart of accounts", icon: <BookOpen className="h-4 w-4" /> },
    { to: "inventory", label: "Inventory", icon: <Package className="h-4 w-4" /> },
    { to: "assets", label: "Fixed assets", icon: <Building2 className="h-4 w-4" /> },
  ] },
  { label: "Insight", items: [
    { to: "reports", label: "Reports", icon: <BarChart3 className="h-4 w-4" /> },
    { to: "insights", label: "Insights", icon: <Lightbulb className="h-4 w-4" /> },
    { to: "settings", label: "Settings", icon: <Settings className="h-4 w-4" /> },
  ] },
];

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { companyId } = useParams();
  return (
    <nav aria-label="Main" className="flex h-full flex-col gap-4 overflow-y-auto px-3 py-4">
      {NAV.map((g, i) => (
        <div key={i}>
          {g.label && <p className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider muted">{g.label}</p>}
          <ul className="space-y-0.5">
            {g.items.map((it) => (
              <li key={it.to}>
                <NavLink to={`/app/${companyId}/${it.to}`} onClick={onNavigate}
                  className={({ isActive }) => cx("flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm", isActive ? "bg-brand-50 font-medium text-brand-800 dark:bg-brand-900/30 dark:text-brand-200" : "hover:bg-[var(--surface-2)]")}>
                  {it.icon}{it.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
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
          <Link to="/app/new-company" onClick={() => setOpen(false)} className="block rounded-md px-3 py-2 text-sm text-brand-700 hover:bg-[var(--surface-2)] dark:text-brand-300">+ Add company</Link>
        </div>
      )}
    </div>
  );
}

function Shell() {
  const { me, logout } = useSession();
  const { settings } = useCompany();
  const { dark, toggle } = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const nav = useNavigate();
  useEffect(() => {
    if (settings) document.title = `${settings.company.name} · ${me?.brand ?? "Arthika"}`;
  }, [settings, me?.brand]);
  return (
    <div className="flex h-full">
      <aside className="hidden w-60 shrink-0 border-r border-[var(--border)] bg-[var(--surface)] lg:flex lg:flex-col">
        <Link to="/app" className="flex items-center gap-2 px-5 py-4 text-base font-semibold"><Logo />{me?.brand ?? "Arthika"}</Link>
        <Sidebar />
      </aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-slate-950/50" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-72 flex-col bg-[var(--surface)] shadow-xl">
            <div className="flex items-center justify-between px-4 py-3"><span className="flex items-center gap-2 font-semibold"><Logo />{me?.brand ?? "Arthika"}</span>
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
          </div>
          <div className="flex items-center gap-1">
            <button onClick={toggle} className="rounded-lg p-2 hover:bg-[var(--surface-2)]" aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}>
              {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
            <span className="hidden max-w-[12rem] truncate px-2 text-sm muted sm:inline">{me?.user?.name}</span>
            <button onClick={async () => { await logout(); nav("/login"); }} className="rounded-lg p-2 hover:bg-[var(--surface-2)]" aria-label="Sign out" title="Sign out"><LogOut className="h-4 w-4" /></button>
          </div>
        </header>
        <main className="min-w-0 flex-1 overflow-y-auto px-3 py-5 sm:px-6">
          <div className="mx-auto max-w-7xl"><Suspense fallback={<Spinner />}><Outlet /></Suspense></div>
        </main>
      </div>
    </div>
  );
}

export function CompanyLayout() {
  const { companyId } = useParams();
  return <CompanyProvider key={companyId} id={companyId!}><Shell /></CompanyProvider>;
}
