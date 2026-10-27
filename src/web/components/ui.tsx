import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { AlertCircle, CheckCircle2, FileSpreadsheet, Info, Loader2, X } from "lucide-react";
import { Link } from "react-router";
import { withFormat } from "../lib/csv";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
export { cx };

type Variant = "primary" | "secondary" | "ghost" | "danger";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-brand-700 text-white hover:bg-brand-800 shadow-sm disabled:bg-brand-700/60",
  secondary: "border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-2)] text-[var(--text)]",
  ghost: "hover:bg-[var(--surface-2)] text-[var(--text)]",
  danger: "bg-red-600 text-white hover:bg-red-700 disabled:bg-red-600/60",
};

export function Button({ variant = "primary", size = "md", loading, className, children, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md"; loading?: boolean }) {
  return (
    <button
      {...p}
      disabled={p.disabled || loading}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:cursor-not-allowed",
        size === "sm" ? "px-2.5 py-1.5 text-xs" : "px-3.5 py-2 text-sm",
        VARIANTS[variant], className,
      )}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

export function LinkButton({ to, variant = "primary", size = "md", className, children }: { to: string; variant?: Variant; size?: "sm" | "md"; className?: string; children: ReactNode }) {
  return (
    <Link to={to} className={cx("inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors", size === "sm" ? "px-2.5 py-1.5 text-xs" : "px-3.5 py-2 text-sm", VARIANTS[variant], className)}>
      {children}
    </Link>
  );
}

export function Field({ label, hint, error, children, className, required }: { label: string; hint?: ReactNode; error?: string | null; children: (id: string) => ReactNode; className?: string; required?: boolean }) {
  const id = useId();
  return (
    <div className={cx("space-y-1.5", className)}>
      <label htmlFor={id} className="block text-sm font-medium">
        {label}{required && <span className="text-red-600" aria-hidden> *</span>}
      </label>
      {children(id)}
      {hint && !error && <p className="text-xs muted">{hint}</p>}
      {error && <p className="text-xs text-red-600" role="alert">{error}</p>}
    </div>
  );
}

export function Input(p: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...p} className={cx("input", p.className)} />;
}

export function MoneyInput(p: InputHTMLAttributes<HTMLInputElement>) {
  return <input inputMode="decimal" autoComplete="off" {...p} className={cx("input num", p.className)} pattern={p.pattern ?? "-?[0-9,]*\\.?[0-9]*"} />;
}

export function Select({ children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...p} className={cx("input pr-8", p.className)}>{children}</select>;
}

export function Textarea(p: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea rows={3} {...p} className={cx("input", p.className)} />;
}

export function Card({ title, actions, children, className, padded = true }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={cx("card", className)}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
          {title && <h2 className="text-sm font-semibold">{title}</h2>}
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={padded ? "p-4" : ""}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: { to: string; label: string } }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3 no-print">
      <div className="min-w-0">
        {back && <Link to={back.to} className="text-xs muted hover:underline">← {back.label}</Link>}
        <h1 className="truncate text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

const BADGE: Record<string, string> = {
  green: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300",
  amber: "bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300",
  red: "bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/10 dark:text-red-300",
  blue: "bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-500/10 dark:text-sky-300",
  gray: "bg-slate-100 text-slate-700 ring-slate-500/20 dark:bg-slate-500/10 dark:text-slate-300",
  violet: "bg-violet-50 text-violet-700 ring-violet-600/20 dark:bg-violet-500/10 dark:text-violet-300",
};

export function Badge({ color = "gray", children }: { color?: keyof typeof BADGE; children: ReactNode }) {
  return <span className={cx("inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset", BADGE[color])}>{children}</span>;
}

export function StatusBadge({ status, due, outstanding }: { status: string; due?: string | null; outstanding?: number }) {
  const today = new Date().toISOString().slice(0, 10);
  if (status === "posted" && outstanding !== undefined) {
    if (outstanding <= 0) return <Badge color="green">Paid</Badge>;
    if (due && due < today) return <Badge color="red">Overdue</Badge>;
    return <Badge color="amber">Outstanding</Badge>;
  }
  const map: Record<string, [keyof typeof BADGE, string]> = {
    draft: ["gray", "Draft"], posted: ["green", "Posted"], open: ["blue", "Open"], accepted: ["green", "Accepted"],
    declined: ["red", "Declined"], converted: ["violet", "Converted"], closed: ["gray", "Closed"], void: ["red", "Void"],
    submitted: ["amber", "Awaiting approval"], approved: ["blue", "Approved"], rejected: ["red", "Rejected"],
    matched: ["green", "Matched"], unmatched: ["amber", "Unmatched"], ignored: ["gray", "Ignored"], active: ["green", "Active"], disposed: ["gray", "Disposed"],
    locked: ["red", "Locked"],
  };
  const [c, l] = map[status] ?? ["gray", status];
  return <Badge color={c}>{l}</Badge>;
}

export function Alert({ kind = "error", children, className }: { kind?: "error" | "info" | "success" | "warning"; children: ReactNode; className?: string }) {
  const styles = {
    error: "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200",
    info: "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200",
    success: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200",
    warning: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
  }[kind];
  const Icon = kind === "error" ? AlertCircle : kind === "success" ? CheckCircle2 : Info;
  return (
    <div role={kind === "error" ? "alert" : "status"} className={cx("flex gap-2 rounded-lg border px-3 py-2.5 text-sm", styles, className)}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-sm muted" role="status">
      <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> {label}
    </div>
  );
}

export function EmptyState({ icon, title, body, action }: { icon?: ReactNode; title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon && <div className="mb-3 rounded-full bg-brand-50 p-3 text-brand-700 dark:bg-brand-900/30 dark:text-brand-300">{icon}</div>}
      <p className="font-medium">{title}</p>
      {body && <p className="mt-1 max-w-md text-sm muted">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  // Callers pass a new onClose on every render; keep the latest in a ref so focus is set only when the dialog opens,
  // not after every keystroke (which used to move the cursor to the close button).
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close.current(); };
    document.addEventListener("keydown", onKey);
    const t = setTimeout(() => {
      if (ref.current?.contains(document.activeElement)) return; // a field already has focus (e.g. autoFocus)
      (body.current?.querySelector<HTMLElement>("input:not([disabled]), select:not([disabled]), textarea:not([disabled])")
        ?? ref.current?.querySelector<HTMLElement>("button"))?.focus();
    }, 0);
    return () => { clearTimeout(t); document.removeEventListener("keydown", onKey); prev?.focus(); };
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 p-0 sm:items-center sm:p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} className={cx("card flex max-h-[92vh] w-full flex-col shadow-xl", wide ? "sm:max-w-3xl" : "sm:max-w-lg")}>
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <h2 className="font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded p-1 hover:bg-[var(--surface-2)]" aria-label="Close"><X className="h-4 w-4" /></button>
        </div>
        <div ref={body} className="overflow-y-auto p-4">{children}</div>
        {footer && <div data-modal-footer className="flex justify-end gap-2 border-t border-[var(--border)] px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmButton({ onConfirm, title, body, label, variant = "danger", confirmLabel = "Confirm", size, withReason }: { onConfirm: (reason?: string) => Promise<unknown> | void; title: string; body: ReactNode; label: ReactNode; variant?: Variant; confirmLabel?: string; size?: "sm" | "md"; withReason?: boolean }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <>
      <Button variant={variant === "danger" ? "secondary" : variant} size={size} onClick={() => setOpen(true)}>{label}</Button>
      <Modal open={open} onClose={() => setOpen(false)} title={title}
        footer={<>
          <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant={variant} loading={busy} onClick={async () => { setBusy(true); try { await onConfirm(reason || undefined); setOpen(false); } finally { setBusy(false); } }}>{confirmLabel}</Button>
        </>}>
        <div className="space-y-3 text-sm">
          <div>{body}</div>
          {withReason && <Field label="Reason (recorded in the audit log)">{(id) => <Input id={id} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />}</Field>}
        </div>
      </Modal>
    </>
  );
}

// ── Toasts ──
type Toast = { id: number; kind: "success" | "error" | "info"; text: string };
const ToastCtx = createContext<(kind: Toast["kind"], text: string) => void>(() => undefined);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast["kind"], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 no-print" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={cx("pointer-events-auto rounded-lg px-4 py-3 text-sm shadow-lg ring-1", t.kind === "error" ? "bg-red-600 text-white ring-red-700" : t.kind === "success" ? "bg-slate-900 text-white ring-slate-800 dark:bg-white dark:text-slate-900" : "bg-sky-600 text-white ring-sky-700")}>{t.text}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { value: T; label: ReactNode }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="mb-4 flex gap-1 overflow-x-auto border-b border-[var(--border)] no-print" role="tablist">
      {tabs.map((t) => (
        <button key={t.value} role="tab" aria-selected={value === t.value} onClick={() => onChange(t.value)}
          className={cx("whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium", value === t.value ? "border-brand-600 text-brand-700 dark:text-brand-300" : "border-transparent muted hover:text-[var(--text)]")}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Pagination({ total, limit, offset, onChange }: { total: number; limit: number; offset: number; onChange: (offset: number) => void }) {
  if (total <= limit) return null;
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.ceil(total / limit);
  return (
    <div className="flex items-center justify-between border-t border-[var(--border)] px-4 py-3 text-sm no-print">
      <span className="muted">{offset + 1}–{Math.min(offset + limit, total)} of {total}</span>
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => onChange(Math.max(0, offset - limit))}>Previous</Button>
        <Button variant="secondary" size="sm" disabled={page >= pages} onClick={() => onChange(offset + limit)}>Next</Button>
      </div>
    </div>
  );
}

export function TableWrap({ children }: { children: ReactNode }) {
  return <div className="max-w-full overflow-x-auto">{children}</div>;
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "good" | "bad" | "neutral" }) {
  return (
    <div className="card p-4">
      <p className="text-xs font-medium uppercase tracking-wide muted">{label}</p>
      <p className={cx("mt-1 text-xl font-semibold num !text-left", tone === "bad" && "text-red-600", tone === "good" && "text-emerald-600 dark:text-emerald-400")}>{value}</p>
      {sub && <p className="mt-1 text-xs muted">{sub}</p>}
    </div>
  );
}

/** "Excel" and "CSV" buttons for one table download; `onDownload` calls downloadCsv, which follows the button pressed. */
export function DownloadButtons({ onDownload, disabled, size = "md", className }: { onDownload: () => unknown; disabled?: boolean; size?: "sm" | "md"; className?: string }) {
  const [busy, setBusy] = useState<"xlsx" | "csv" | null>(null);
  const go = async (f: "xlsx" | "csv") => { setBusy(f); try { await withFormat(f, onDownload); } finally { setBusy(null); } };
  return (
    <span className={cx("inline-flex gap-1", className)}>
      <Button variant="secondary" size={size} disabled={disabled || busy !== null} loading={busy === "xlsx"} onClick={() => void go("xlsx")} title="Download as an Excel workbook (.xlsx)"><FileSpreadsheet className="h-4 w-4" />Excel</Button>
      <Button variant="secondary" size={size} disabled={disabled || busy !== null} loading={busy === "csv"} onClick={() => void go("csv")} title="Download as CSV (for Tally and other tools)">CSV</Button>
    </span>
  );
}
