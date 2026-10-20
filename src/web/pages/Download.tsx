import { Link } from "react-router";
import { Apple, Monitor, Laptop, Download as DownloadIcon, ShieldAlert } from "lucide-react";
import { useApi } from "../lib/hooks";
import { AdSense } from "../components/Ads";
import { Wordmark } from "../components/Layout";

interface Downloads {
  available: boolean;
  releases_page: string | null;
  files: { windows: string; mac_arm64: string; mac_x64: string; linux: string } | null;
}

function detect(): "windows" | "mac" | "other" {
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return "windows";
  if (/Macintosh|Mac OS X/i.test(ua) && !/iPhone|iPad/i.test(ua)) return "mac";
  return "other";
}

function Option({ icon, title, sub, href, primary }: { icon: React.ReactNode; title: string; sub: string; href?: string; primary?: boolean }) {
  const cls = primary ? "border-brand-600 ring-2 ring-brand-600/20" : "border-[var(--border)]";
  const body = (
    <>
      <span className="rounded-lg bg-brand-50 p-2.5 text-brand-700 dark:bg-brand-900/30 dark:text-brand-300">{icon}</span>
      <span className="min-w-0 flex-1"><span className="block font-semibold">{title}</span><span className="block text-sm muted">{sub}</span></span>
      <DownloadIcon className="h-5 w-5 shrink-0 muted" />
    </>
  );
  return href
    ? <a href={href} className={`card flex items-center gap-4 p-4 hover:bg-[var(--surface-2)] ${cls}`}>{body}</a>
    : <div className={`card flex items-center gap-4 p-4 opacity-60 ${cls}`} aria-disabled>{body}</div>;
}

export default function Download() {
  const { data, loading } = useApi<Downloads>("/api/downloads");
  const os = detect();
  const f = data?.files ?? undefined;
  return (
    <div className="min-h-full">
      <AdSense />
      <header className="mx-auto flex max-w-4xl items-center justify-between px-4 py-5 sm:px-6">
        <Link to="/" className="text-lg"><Wordmark iconClass="h-8 w-8" /></Link>
        <a href="/login" className="rounded-lg px-3 py-2 text-sm font-medium hover:bg-[var(--surface-2)]">Use it online instead</a>
      </header>
      <main className="mx-auto max-w-4xl px-4 pb-16 pt-6 sm:px-6">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Download LedgerFox for your computer</h1>
        <p className="mt-3 text-lg muted">Free. Your accounts are saved in a file on your computer, in a folder you choose. Works without internet; phones on the same Wi-Fi can use it too.</p>
        {!loading && !data?.available && (
          <p className="mt-6 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            The installers are being prepared and will appear here soon. You can use LedgerFox online in the meantime.
          </p>
        )}
        <div className="mt-8 grid gap-3">
          <Option primary={os === "windows"} icon={<Monitor className="h-6 w-6" />} title="Windows 10 / 11" sub="64-bit installer (.exe)" href={f?.windows} />
          <Option primary={os === "mac"} icon={<Apple className="h-6 w-6" />} title="Mac with Apple chip (M1, M2, M3, M4…)" sub="Disk image (.dmg) — most Macs from 2021 onwards" href={f?.mac_arm64} />
          <Option icon={<Laptop className="h-6 w-6" />} title="Mac with Intel chip" sub="Disk image (.dmg) — older Macs" href={f?.mac_x64} />
        </div>
        {data?.releases_page && <p className="mt-3 text-sm muted">Linux and previous versions: <a className="underline" href={data.releases_page}>all downloads</a>.</p>}
        <section className="card mt-10 p-5">
          <h2 className="flex items-center gap-2 font-semibold"><ShieldAlert className="h-5 w-5 text-amber-500" />First time you open it</h2>
          <p className="mt-2 text-sm muted">LedgerFox is free and not code-signed (signing certificates are paid), so your computer warns you once.</p>
          <ul className="mt-3 space-y-2 text-sm">
            <li><b>Windows:</b> if you see "Windows protected your PC", click <b>More info → Run anyway</b>.</li>
            <li><b>Mac:</b> open the .dmg and drag LedgerFox to Applications. If macOS says it cannot be opened, go to <b>System Settings → Privacy &amp; Security</b> and click <b>Open Anyway</b>.</li>
            <li>On first launch, choose where to save your data (for example <code>C:\LedgerFox</code>). Back it up by copying that file; LedgerFox also keeps daily copies.</li>
          </ul>
        </section>
      </main>
    </div>
  );
}
