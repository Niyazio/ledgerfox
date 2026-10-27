import { useState } from "react";
import { ArrowUpCircle, X } from "lucide-react";
import { useSession } from "../lib/session";
import { applyUpdate, useAppUpdate, type UpdateInfo } from "../lib/updates";
import { Alert, Button, Modal } from "./ui";

const EDITION = { cloud: "website", desktop: "desktop app", android: "Android app" } as const;

function actionLabel(info: UpdateInfo) {
  switch (info.action) {
    case "reload": return "Reload to update";
    case "restart": return "Restart to update";
    case "download": return "Download update";
    case "open-download-page": return "Download update";
    default: return null;
  }
}

function statusText(info: UpdateInfo) {
  if (info.status === "checking") return "Checking for updates…";
  if (info.status === "downloading") return `Downloading LedgerFox ${info.latest ?? ""}${info.progress != null ? ` (${info.progress}%)` : ""}… You can keep working.`;
  if (info.status === "ready") return `LedgerFox ${info.latest} is downloaded and installs when the app restarts. Your data file is not changed.`;
  if (info.available && info.edition === "cloud") return "A new version of LedgerFox has been published. Reload to start using it (unsaved form entries on this page are lost).";
  if (info.available && info.edition === "android") return `LedgerFox ${info.latest} is available. Download and open the new APK to install it over this one; your phone copy is kept.`;
  if (info.available) return `LedgerFox ${info.latest} is available.`;
  if (info.status === "up-to-date") return "You have the latest version.";
  return "";
}

/** Header button (with a dot when an update is waiting), a notice bar, and the update dialog. */
export function UpdateCenter() {
  const { me } = useSession();
  const { info, error, check } = useAppUpdate(me?.edition);
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const label = actionLabel(info);
  const key = `${info.latest}-${info.status}`;
  const showBar = info.available && dismissed !== key && (info.status !== "downloading");
  const apply = async () => { setBusy(true); try { await applyUpdate(info); } finally { setBusy(false); } };
  const canApply = label && (info.edition !== "desktop" || info.can_install);
  return (
    <>
      <button onClick={() => setOpen(true)} className="relative rounded-lg p-2 hover:bg-[var(--surface-2)]" aria-label={info.available ? "Update available" : "Check for updates"} title={info.available ? `Update available (${info.latest})` : `LedgerFox ${info.current} · check for updates`}>
        <ArrowUpCircle className="h-4 w-4" />
        {info.available && <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-red-500" />}
      </button>
      {showBar && (
        <div role="status" className="no-print fixed inset-x-0 top-16 z-40 mx-auto flex w-[min(40rem,calc(100%-2rem))] items-center gap-3 rounded-xl border border-brand-200 bg-[var(--surface)] p-3 text-sm shadow-lg dark:border-brand-800">
          <ArrowUpCircle className="h-5 w-5 shrink-0 text-brand-600" />
          <p className="flex-1">{info.edition === "cloud" ? "A new version of LedgerFox is ready." : `LedgerFox ${info.latest} is ${info.status === "ready" ? "ready to install" : "available"}.`}{" "}
            <button className="text-brand-700 underline dark:text-brand-300" onClick={() => setOpen(true)}>What's new</button></p>
          {canApply && <Button size="sm" loading={busy} onClick={() => void apply()}>{label}</Button>}
          <button className="rounded p-1 hover:bg-[var(--surface-2)]" aria-label="Later" onClick={() => setDismissed(key)}><X className="h-4 w-4" /></button>
        </div>
      )}
      {open && (
        <Modal open onClose={() => setOpen(false)} title="Updates"
          footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Close</Button>
            <Button variant="secondary" loading={info.status === "checking"} onClick={() => void check()}>Check now</Button>
            {canApply && <Button loading={busy} onClick={() => void apply()}>{label}</Button>}</>}>
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt className="muted">This {EDITION[info.edition]}</dt><dd className="font-medium">LedgerFox {info.current}</dd>
            {info.latest && <><dt className="muted">Latest</dt><dd className="font-medium">{info.latest}</dd></>}
            {info.checked_at && <><dt className="muted">Last checked</dt><dd>{new Date(info.checked_at).toLocaleString()}</dd></>}
          </dl>
          {error ? <Alert className="mt-3">{error}</Alert> : statusText(info) && <Alert kind={info.available ? "info" : "success"} className="mt-3">{statusText(info)}</Alert>}
          {info.status === "downloading" && info.progress != null && <div className="mt-2 h-2 overflow-hidden rounded bg-[var(--surface-2)]"><div className="h-full bg-brand-600" style={{ width: `${info.progress}%` }} /></div>}
          {info.edition === "desktop" && info.available && !info.can_install && <p className="mt-3 text-sm muted">Updates are installed by the owner or an administrator on the computer that runs LedgerFox.</p>}
          {info.notes && <div className="mt-4"><p className="mb-1 text-sm font-semibold">What's new</p><pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--surface-2)] p-3 text-xs">{info.notes}</pre></div>}
          {info.edition === "cloud" && <p className="mt-3 text-xs muted">The website updates itself; this only refreshes the page you have open.</p>}
        </Modal>
      )}
    </>
  );
}
