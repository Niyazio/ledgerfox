import { useEffect, useState } from "react";
import { useSession } from "../lib/session";

/** Google AdSense publisher ID (Auto ads). */
export const ADSENSE_CLIENT = "ca-pub-8434138764307652";

/**
 * Loads AdSense on public marketing pages of the cloud website only. Never on sign-in, app, verification or desktop
 * pages: third-party ad scripts must not run where financial data or passwords are on screen, and AdSense policies do
 * not allow ads inside installed software. Links from these pages into the app use full page loads (see AppLink) so
 * the ad script is dropped before any account data is shown.
 */
const CONSENT_KEY = "lf-cookie-consent";
const readConsent = () => { try { return localStorage.getItem(CONSENT_KEY); } catch { return null; } };

export function AdSense() {
  const { me } = useSession();
  const [consent, setConsent] = useState(readConsent);
  // Never inside the desktop app (AdSense does not allow ads in installed software).
  const cloud = me?.edition === "cloud" && !/^(localhost|127\.|192\.168\.|10\.)/.test(location.hostname) && !/Electron\//.test(navigator.userAgent);
  // Advertising cookies only after the visitor agrees; the sign-in cookie is essential and needs no consent.
  const enabled = cloud && consent === "all";
  const choose = (v: "all" | "essential") => { try { localStorage.setItem(CONSENT_KEY, v); } catch { /* private window */ } setConsent(v); };
  useEffect(() => {
    if (!enabled || document.querySelector("script[data-ledgerfox-ads]")) return;
    const s = document.createElement("script");
    s.async = true;
    s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_CLIENT}`;
    s.crossOrigin = "anonymous";
    s.dataset.ledgerfoxAds = "1";
    document.head.appendChild(s);
  }, [enabled]);
  if (!cloud || consent) return null;
  return (
    <div role="dialog" aria-label="Cookies" className="fixed inset-x-3 bottom-3 z-50 mx-auto max-w-2xl rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 text-sm shadow-xl">
      <p>LedgerFox uses an essential cookie to keep you signed in. With your consent, the public pages also show ads from Google, which uses cookies. See the <a className="underline" href="/privacy">Privacy policy</a>.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button className="rounded-lg bg-brand-700 px-3 py-1.5 font-medium text-white hover:bg-brand-800" onClick={() => choose("all")}>Accept all</button>
        <button className="rounded-lg border border-[var(--border)] px-3 py-1.5 hover:bg-[var(--surface-2)]" onClick={() => choose("essential")}>Essential only</button>
      </div>
    </div>
  );
}

/** A link that performs a full page load when ads may be present, so no ad code survives into the app. */
export function AppLink({ to, className, children }: { to: string; className?: string; children: React.ReactNode }) {
  return <a href={to} className={className}>{children}</a>;
}
