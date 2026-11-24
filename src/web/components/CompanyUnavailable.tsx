import { Link } from "react-router";
import { GraduationCap, Home, LayoutGrid, Mail, PauseCircle, Rocket, ShieldAlert } from "lucide-react";
import { Wordmark } from "./Layout";

const SUPPORT = "info@niyazio.com";

/** Shown instead of a company that cannot be opened: a clear reason and the next steps, never a dead end. */
export function CompanyUnavailable({ code, message, onRetry }: { code: string | null; message: string; onRetry: () => void }) {
  const kind = code === "EDUCATION_NOT_APPROVED" ? "education" : code === "EDUCATION_DEVICE_LIMIT" ? "devices" : code === "ACCOUNT_SUSPENDED" ? "paused" : "other";
  const icon = { education: <GraduationCap className="h-8 w-8" />, devices: <ShieldAlert className="h-8 w-8" />, paused: <PauseCircle className="h-8 w-8" />, other: <ShieldAlert className="h-8 w-8" /> }[kind];
  const title = {
    education: "Education access has ended",
    devices: "This practice company is on its device limit",
    paused: "This business is paused",
    other: "This company cannot be opened right now",
  }[kind];
  const body = {
    education: "Education mode for this company is not active any more. Your practice data is safe and kept. To keep working, start your own business on LedgerFox — every feature free for 30 days — or ask your institute or LedgerFox to renew education access.",
    devices: "Every allowed device is in use. The organisation's owner can free a device in Settings → Plan & billing, or take a bigger student pack.",
    paused: "Access to this business has been paused by LedgerFox. Your data is safe. Please contact us to resume.",
    other: message,
  }[kind];
  const btn = "inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium";
  return (
    <div className="flex min-h-[80vh] items-center justify-center px-4 py-10">
      <div className="card w-full max-w-xl p-6 text-center sm:p-8">
        <div className="mb-4 flex justify-center"><Wordmark iconClass="h-8 w-8" /></div>
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-50 text-brand-700 dark:bg-brand-900/30 dark:text-brand-300">{icon}</div>
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="mt-2 text-sm muted">{body}</p>
        <div className="mt-6 grid gap-2 sm:grid-cols-2">
          {kind === "education" && <Link to="/app/new-company" className={`${btn} bg-brand-700 text-white hover:bg-brand-800 sm:col-span-2`}><Rocket className="h-4 w-4" />Start my business — 30 days free</Link>}
          <Link to="/app" className={`${btn} border border-[var(--border)] hover:bg-[var(--surface-2)]`}><LayoutGrid className="h-4 w-4" />My companies</Link>
          <a href="/" className={`${btn} border border-[var(--border)] hover:bg-[var(--surface-2)]`}><Home className="h-4 w-4" />LedgerFox website</a>
          <a href={`mailto:${SUPPORT}?subject=${encodeURIComponent(title)}`} className={`${btn} border border-[var(--border)] hover:bg-[var(--surface-2)]`}><Mail className="h-4 w-4" />Contact LedgerFox</a>
          {kind === "other" && <button onClick={onRetry} className={`${btn} border border-[var(--border)] hover:bg-[var(--surface-2)]`}>Try again</button>}
        </div>
        <p className="mt-5 text-xs muted">Questions? Write to {SUPPORT}.</p>
      </div>
    </div>
  );
}
