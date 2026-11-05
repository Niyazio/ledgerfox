import { useState } from "react";
import { CheckCircle2, Download, MonitorSmartphone, ShieldCheck } from "lucide-react";
import { installSteps, useInstall } from "../lib/install";
import { Button, Modal } from "./ui";

function Steps({ steps }: { steps: string[] }) {
  return <ol className="list-decimal space-y-1.5 pl-5 text-sm">{steps.map((s) => <li key={s}>{s}</li>)}</ol>;
}

/** Big card for the download page: install from the browser, the recommended way. */
export function InstallAppCard() {
  const { state, install } = useInstall();
  if (state === "unsupported" && /Electron/i.test(navigator.userAgent)) return null;
  return (
    <section className="card border-brand-600 p-5 ring-2 ring-brand-600/20">
      <div className="flex flex-wrap items-start gap-4">
        <span className="rounded-xl bg-brand-50 p-3 text-brand-700 dark:bg-brand-900/30 dark:text-brand-300"><MonitorSmartphone className="h-7 w-7" /></span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-brand-700 dark:text-brand-300">Recommended</p>
          <h2 className="text-xl font-semibold">Install the app from your browser</h2>
          <p className="mt-1 text-sm muted">Works on Android, iPhone, Windows, Mac and Linux. Nothing to download, so there are no security warnings, and it always has the latest version.</p>
          <ul className="mt-3 grid gap-1 text-sm sm:grid-cols-2">
            {["Its own icon and window", "No download warnings", "Updates by itself", "Same account and data everywhere"].map((t) => (
              <li key={t} className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 shrink-0 text-emerald-600" />{t}</li>
            ))}
          </ul>
          <div className="mt-4">
            {state === "installed" && <p className="flex items-center gap-2 font-medium text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="h-5 w-5" />Installed on this device — open LedgerFox from your home screen or apps.</p>}
            {state === "available" && <Button onClick={() => void install()}><Download className="h-4 w-4" />Install LedgerFox</Button>}
            {(state === "ios" || state === "safari-mac" || state === "menu" || state === "unsupported") && (
              <div className="rounded-lg bg-[var(--surface-2)] p-3"><p className="mb-2 text-sm font-medium">{state === "unsupported" ? "Use another browser" : "How to install"}</p><Steps steps={installSteps(state)} /></div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

/** Small button for headers: hidden once installed, and inside the desktop or phone app. */
export function InstallAppButton({ className = "", oneClickOnly = false }: { className?: string; oneClickOnly?: boolean }) {
  const { state, install } = useInstall();
  const [help, setHelp] = useState(false);
  if (state === "installed" || state === "unsupported" || (oneClickOnly && state !== "available")) return null;
  return (
    <>
      <Button size="sm" variant="secondary" className={className} onClick={() => (state === "available" ? void install() : setHelp(true))}>
        <Download className="h-4 w-4" />Install app
      </Button>
      {help && <Modal open title="Install LedgerFox" onClose={() => setHelp(false)}>
        <p className="mb-3 text-sm muted">LedgerFox gets its own icon and window, with no download and no security warnings.</p>
        <Steps steps={installSteps(state)} />
      </Modal>}
    </>
  );
}
