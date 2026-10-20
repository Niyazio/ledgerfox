import { Link, Navigate } from "react-router";
import { BookOpen, ShieldCheck, FileText, Landmark, Package, BarChart3, Globe2, Lock } from "lucide-react";
import { Logo, useTheme } from "../components/Layout";
import { useSession } from "../lib/session";
import { Moon, Sun } from "lucide-react";

const FEATURES = [
  { icon: <BookOpen className="h-5 w-5" />, title: "Real double-entry ledger", body: "Every transaction posts a balanced journal. Posted entries are locked by the database itself; corrections are made with reversals, never silent edits." },
  { icon: <FileText className="h-5 w-5" />, title: "Sales & purchases", body: "Quotations, orders, GST invoices, credit notes, bills, debit notes, partial payments, advances and printable documents." },
  { icon: <Landmark className="h-5 w-5" />, title: "Banking", body: "Import CSV bank statements, detect duplicates, get match suggestions and complete reconciliations with history." },
  { icon: <Package className="h-5 w-5" />, title: "Inventory & fixed assets", body: "Warehouses, transfers, adjustments, moving-average costing that reconciles to the ledger, and SLM/WDV depreciation." },
  { icon: <BarChart3 className="h-5 w-5" />, title: "Reports that reconcile", body: "Trial balance, profit & loss, balance sheet, cash flow, ledgers, ageing, statements, GST summary and budgets — all from posted entries." },
  { icon: <Globe2 className="h-5 w-5" />, title: "Multi-company, multi-currency", body: "Several businesses per login, company switching, roles, foreign-currency invoices with realised exchange differences." },
];

export default function Landing() {
  const { me } = useSession();
  const { dark, toggle } = useTheme();
  if (me?.user) return <Navigate to="/app" replace />;
  const brand = me?.brand ?? "Arthika";
  return (
    <div className="min-h-full">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-5 sm:px-6">
        <span className="flex items-center gap-2 text-lg font-semibold"><Logo className="h-8 w-8" />{brand}</span>
        <nav className="flex items-center gap-2">
          <button onClick={toggle} className="rounded-lg p-2 hover:bg-[var(--surface-2)]" aria-label="Toggle theme">{dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}</button>
          <Link to="/login" className="rounded-lg px-3 py-2 text-sm font-medium hover:bg-[var(--surface-2)]">Sign in</Link>
          <Link to="/register" className="rounded-lg bg-brand-700 px-3.5 py-2 text-sm font-medium text-white hover:bg-brand-800">Create account</Link>
        </nav>
      </header>
      <main>
        <section className="mx-auto max-w-6xl px-4 pb-16 pt-10 sm:px-6 sm:pt-16">
          <div className="max-w-3xl">
            <p className="mb-3 inline-flex items-center gap-2 rounded-full bg-brand-50 px-3 py-1 text-xs font-medium text-brand-800 dark:bg-brand-900/30 dark:text-brand-200">
              <Lock className="h-3.5 w-3.5" /> Open source · no subscription · your data, exportable any time
            </p>
            <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">Accounting software that keeps the books honest.</h1>
            <p className="mt-5 text-lg muted">
              {brand} is a cloud accounting system for small and growing businesses: invoicing, purchases, expenses, banking, inventory,
              fixed assets and financial statements on a proper double-entry ledger. India GST support is built in; other countries use configurable tax codes.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link to="/register" className="rounded-lg bg-brand-700 px-5 py-2.5 font-medium text-white hover:bg-brand-800">Get started</Link>
              <Link to="/login" className="rounded-lg border border-[var(--border)] px-5 py-2.5 font-medium hover:bg-[var(--surface-2)]">Sign in</Link>
            </div>
          </div>
        </section>
        <section className="border-y border-[var(--border)] bg-[var(--surface)]">
          <div className="mx-auto grid max-w-6xl gap-6 px-4 py-14 sm:grid-cols-2 sm:px-6 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <div key={f.title}>
                <div className="mb-3 inline-flex rounded-lg bg-brand-50 p-2 text-brand-700 dark:bg-brand-900/30 dark:text-brand-300">{f.icon}</div>
                <h2 className="font-semibold">{f.title}</h2>
                <p className="mt-1 text-sm muted">{f.body}</p>
              </div>
            ))}
          </div>
        </section>
        <section className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <div className="grid gap-8 lg:grid-cols-2">
            <div>
              <h2 className="flex items-center gap-2 text-xl font-semibold"><ShieldCheck className="h-5 w-5 text-brand-700" /> What it is — and isn’t</h2>
              <ul className="mt-4 space-y-2 text-sm muted">
                <li>• Runs on free-tier cloud infrastructure. Free tiers have daily usage limits and no uptime guarantee.</li>
                <li>• GST invoices, CGST/SGST/IGST and a GST summary are supported. GST return filing, e-invoicing (IRN) and e-way bills are <strong>not</strong> implemented.</li>
                <li>• Rule-based suggestions (categories, duplicate bills, unusual amounts, bank matches) — no paid AI service, and nothing is posted without a person.</li>
                <li>• Not certified by any tax authority or standards body. Review reports with your accountant.</li>
              </ul>
            </div>
            <div className="card p-6">
              <h3 className="font-semibold">Built-in safeguards</h3>
              <ul className="mt-3 space-y-2 text-sm muted">
                <li>✓ Debits must equal credits — enforced in the database</li>
                <li>✓ Posted entries are immutable; reversals are linked and audited</li>
                <li>✓ Period locking stops back-dated changes</li>
                <li>✓ Strict separation between companies and role-based permissions</li>
                <li>✓ Append-only audit log of financial actions</li>
                <li>✓ Full JSON data export for owners and administrators</li>
              </ul>
            </div>
          </div>
        </section>
      </main>
      <footer className="border-t border-[var(--border)] py-8 text-center text-xs muted">{brand} · Open-source accounting · Amounts are stored as exact integers, never floating point.</footer>
    </div>
  );
}
