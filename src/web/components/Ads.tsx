import { useEffect } from "react";
import { useSession } from "../lib/session";

/** Google AdSense publisher ID (Auto ads). */
export const ADSENSE_CLIENT = "ca-pub-8434138764307652";

/**
 * Loads AdSense on public marketing pages of the cloud website only. Never on sign-in, app, verification or desktop
 * pages: third-party ad scripts must not run where financial data or passwords are on screen, and AdSense policies do
 * not allow ads inside installed software. Links from these pages into the app use full page loads (see AppLink) so
 * the ad script is dropped before any account data is shown.
 */
export function AdSense() {
  const { me } = useSession();
  const enabled = me?.edition === "cloud" && !/^(localhost|127\.|192\.168\.|10\.)/.test(location.hostname);
  useEffect(() => {
    if (!enabled || document.querySelector("script[data-ledgerfox-ads]")) return;
    const s = document.createElement("script");
    s.async = true;
    s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_CLIENT}`;
    s.crossOrigin = "anonymous";
    s.dataset.ledgerfoxAds = "1";
    document.head.appendChild(s);
  }, [enabled]);
  return null;
}

/** A link that performs a full page load when ads may be present, so no ad code survives into the app. */
export function AppLink({ to, className, children }: { to: string; className?: string; children: React.ReactNode }) {
  return <a href={to} className={className}>{children}</a>;
}
