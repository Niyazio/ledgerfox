import { useCallback, useEffect, useRef, useState } from "react";
import { isNativeApp } from "./api";

/**
 * Is a newer LedgerFox available, and how is it applied?
 * - Website: the server already runs the new version after a deploy; an open tab compares /version.json with its own
 *   build and offers "Reload".
 * - Desktop: the app's updater (via the local server) downloads in the background; "Restart to update".
 * - Android app: the newest GitHub release is compared with this app's version; "Download" opens the new APK.
 */
export type UpdateAction = "reload" | "restart" | "download" | "open-download-page" | null;
export interface UpdateInfo {
  edition: "cloud" | "desktop" | "android";
  current: string;
  latest: string | null;
  available: boolean;
  status: "idle" | "checking" | "up-to-date" | "available" | "downloading" | "ready" | "error";
  progress: number | null;
  notes: string | null;
  action: UpdateAction;
  can_install: boolean;
  url: string | null;
  checked_at: string | null;
}

const REPO = "Niyazio/ledgerfox";

export function isNewer(latest: string, current: string): boolean {
  const a = latest.replace(/^v/, "").split(/[.-]/).map((n) => Number(n) || 0);
  const b = current.replace(/^v/, "").split(/[.-]/).map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}

const base = (edition: UpdateInfo["edition"]): UpdateInfo => ({
  edition, current: __APP_VERSION__, latest: null, available: false, status: "idle", progress: null, notes: null, action: null, can_install: false, url: null, checked_at: null,
});

async function checkCloud(): Promise<UpdateInfo> {
  const info = base("cloud");
  const r = (await (await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" })).json()) as { build: string; version: string };
  const changed = r.build !== __BUILD_ID__;
  return { ...info, latest: r.version, available: changed, status: changed ? "available" : "up-to-date", action: changed ? "reload" : null, can_install: true, checked_at: new Date().toISOString() };
}

async function checkDesktop(force: boolean): Promise<UpdateInfo> {
  const info = base("desktop");
  const r = await fetch(force ? "/api/desktop/update/check" : "/api/desktop/update", force
    ? { method: "POST", headers: { "x-requested-with": "ledgerfox", "content-type": "application/json" }, body: "{}", credentials: "same-origin" }
    : { credentials: "same-origin", cache: "no-store" });
  const j: any = await r.json();
  if (!r.ok) throw new Error(j?.error?.message ?? "Could not check for updates");
  if (!j.available) return { ...info, status: "up-to-date" };
  const status = j.status as UpdateInfo["status"];
  const available = status === "available" || status === "downloading" || status === "ready";
  return {
    ...info, current: j.current, latest: j.latest, available, status, progress: j.progress, notes: j.notes, can_install: Boolean(j.can_install), checked_at: j.checked_at,
    action: status === "ready" ? "restart" : status === "available" && j.manual_download ? "open-download-page" : null, url: j.manual_download,
  };
}

async function checkAndroid(): Promise<UpdateInfo> {
  const info = base("android");
  const rel = (await (await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: "application/vnd.github+json" } })).json()) as
    { tag_name?: string; body?: string; html_url?: string; assets?: { name: string; browser_download_url: string }[] };
  const latest = rel.tag_name?.replace(/^v/, "") ?? null;
  const available = Boolean(latest && isNewer(latest, __APP_VERSION__));
  const apk = rel.assets?.find((a) => a.name.toLowerCase().endsWith(".apk"))?.browser_download_url ?? rel.html_url ?? null;
  return { ...info, latest, available, status: available ? "available" : "up-to-date", notes: rel.body?.slice(0, 4000) ?? null, action: available ? "download" : null, can_install: true, url: apk, checked_at: new Date().toISOString() };
}

export function editionNow(serverEdition?: string): UpdateInfo["edition"] {
  if (isNativeApp()) return "android";
  return serverEdition === "desktop" ? "desktop" : "cloud";
}

/** Checks on open, every 30 minutes and when the tab comes back into view. */
export function useAppUpdate(serverEdition?: string) {
  const edition = editionNow(serverEdition);
  const [info, setInfo] = useState<UpdateInfo>(() => base(edition));
  const [error, setError] = useState<string | null>(null);
  const downloading = useRef(false);
  useEffect(() => { downloading.current = info.edition === "desktop" && info.status === "downloading"; }, [info]);
  const run = useCallback(async (force = false) => {
    if (!import.meta.env.PROD && edition === "cloud") { setInfo({ ...base(edition), status: "up-to-date" }); return; }
    setError(null);
    if (force) setInfo((i) => ({ ...i, status: "checking" }));
    try {
      setInfo(edition === "desktop" ? await checkDesktop(force) : edition === "android" ? await checkAndroid() : await checkCloud());
    } catch (e) {
      setError(navigator.onLine ? (e as Error).message || "Could not check for updates" : "You are offline");
      setInfo((i) => ({ ...i, status: "error" }));
    }
  }, [edition]);
  useEffect(() => {
    void run();
    const t = setInterval(() => void run(), 30 * 60_000);
    // While a desktop update downloads, follow its progress more often.
    const fast = setInterval(() => { if (downloading.current) void run(); }, 10_000);
    const vis = () => { if (document.visibilityState === "visible") void run(); };
    document.addEventListener("visibilitychange", vis);
    return () => { clearInterval(t); clearInterval(fast); document.removeEventListener("visibilitychange", vis); };
  }, [run]);
  return { info, error, check: () => run(true) };
}

/** Apply the update the way this edition allows. */
export async function applyUpdate(info: UpdateInfo) {
  if (info.action === "reload") {
    // A new service worker waits until all tabs close; ask it to take over, then reload.
    const reg = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
    if (reg) {
      await reg.update().catch(() => undefined);
      const waiting = reg.waiting ?? reg.installing;
      if (waiting) {
        await new Promise<void>((resolve) => {
          const done = () => resolve();
          navigator.serviceWorker.addEventListener("controllerchange", done, { once: true });
          waiting.postMessage("skip-waiting");
          setTimeout(done, 4000);
        });
      }
    }
    location.reload();
  } else if (info.action === "restart") {
    await fetch("/api/desktop/update/install", { method: "POST", headers: { "x-requested-with": "ledgerfox", "content-type": "application/json" }, body: "{}", credentials: "same-origin" });
  } else if ((info.action === "download" || info.action === "open-download-page") && info.url) {
    // Android app: download inside the app and open Android's installer (one tap on "Install"), no browser needed.
    const caps = (globalThis as { Capacitor?: { Plugins?: Record<string, any> } }).Capacitor?.Plugins;
    if (info.edition === "android" && caps?.ApkUpdater && info.url.endsWith(".apk")) {
      const sub = await caps.ApkUpdater.addListener?.("progress", (p: { percent: number }) => onApkProgress?.(p.percent));
      try { await caps.ApkUpdater.install({ url: info.url }); } finally { await sub?.remove?.(); onApkProgress?.(null); }
      return;
    }
    if (caps?.Browser) await caps.Browser.open({ url: info.url });
    else window.open(info.url, "_blank", "noopener");
  }
}

/** Download progress of an in-app Android update (0–100, -1 when the size is unknown, null when finished). */
let onApkProgress: ((percent: number | null) => void) | null = null;
export const watchApkProgress = (fn: ((percent: number | null) => void) | null) => { onApkProgress = fn; };
