import { Link } from "react-router";
import { Apple, Monitor, Laptop, Smartphone, Download as DownloadIcon, ShieldAlert } from "lucide-react";
import { useApi } from "../lib/hooks";
import { AdSense } from "../components/Ads";
import { ProductCredit, Wordmark } from "../components/Layout";

interface Downloads {
  available: boolean;
  releases_page: string | null;
  files: { windows: string; mac_arm64: string; mac_x64: string; linux: string; android: string } | null;
}

function detect(): "windows" | "mac" | "android" | "other" {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return "android";
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
        <p className="mt-3 text-lg muted">Free to download. Sign in with your LedgerFox account: the same data as the website and your team, a 30-day free trial of every feature, and one plan for the website, computers and phones. No internet? Keep billing; your entries are sent automatically when the internet is back. File → Save a backup keeps a copy on your computer.</p>
        {!loading && !data?.available && (
          <p className="mt-6 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            The installers are being prepared and will appear here soon. You can use LedgerFox online in the meantime.
          </p>
        )}
        <div className="mt-8 grid gap-3">
          <Option primary={os === "windows"} icon={<Monitor className="h-6 w-6" />} title="Windows 10 / 11" sub="64-bit installer (.exe)" href={f?.windows} />
          <Option primary={os === "mac"} icon={<Apple className="h-6 w-6" />} title="Mac with Apple chip (M1, M2, M3, M4…)" sub="Disk image (.dmg) — most Macs from 2021 onwards" href={f?.mac_arm64} />
          <Option icon={<Laptop className="h-6 w-6" />} title="Mac with Intel chip" sub="Disk image (.dmg) — older Macs" href={f?.mac_x64} />
          <Option primary={os === "android"} icon={<Smartphone className="h-6 w-6" />} title="Android phone / tablet" sub="App (.apk) — opens LedgerFox Cloud or your office computer by QR code" href={f?.android} />
        </div>
        {data?.releases_page && <p className="mt-3 text-sm muted">Linux and previous versions: <a className="underline" href={data.releases_page}>all downloads</a>.</p>}
        <section className="card mt-10 p-5">
          <h2 className="flex items-center gap-2 font-semibold"><ShieldAlert className="h-5 w-5 text-amber-500" />First time you open it</h2>
          <p className="mt-2 text-sm muted">The installer is not code-signed yet (signing certificates are paid), so your computer warns you once.</p>
          <ul className="mt-3 space-y-2 text-sm">
            <li><b>Windows:</b> if you see "Windows protected your PC", click <b>More info → Run anyway</b>.</li>
            <li><b>Mac:</b> open the .dmg and drag LedgerFox to Applications. If macOS says it cannot be opened, go to <b>System Settings → Privacy &amp; Security</b> and click <b>Open Anyway</b>.</li>
            <li><b>Android:</b> open the downloaded .apk and allow "Install unknown apps" for your browser when asked (the app is not on Google Play).</li>
            <li><b>iPhone / iPad:</b> open ledgerfox.niyazio.com in Safari and use Share → Add to Home Screen.</li>
            <li>On first launch, sign in with your LedgerFox email and password (or create an account). Data files from older versions open from <b>File → Open an old data file (view only)</b>.</li>
            <li>Only download LedgerFox from this page or our GitHub releases. The file name is <code>LedgerFox-Setup-x64.exe</code>, published by Niyazio.</li>
          </ul>
        </section>
        <ProductCredit className="mt-8 text-center" />
      </main>
    </div>
  );
}
