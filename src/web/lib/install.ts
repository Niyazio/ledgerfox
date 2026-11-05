/**
 * "Install app" from the browser (a Progressive Web App): LedgerFox gets its own icon and window on Android, Windows,
 * Mac, Linux and iPhone, straight from the website — nothing to download, so no "unknown app" or "Windows protected
 * your PC" warnings, and it always runs the latest version.
 *
 * Chrome, Edge, Samsung Internet and other Chromium browsers offer an install prompt (`beforeinstallprompt`), which is
 * kept here so a button can show it later. Safari (iPhone, iPad, Mac) installs from its Share menu instead.
 */
import { useEffect, useState } from "react";
import { isNativeApp } from "./api";

interface PromptEvent extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> }

let deferred: PromptEvent | null = null;
let installedNow = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e as PromptEvent; notify(); });
  window.addEventListener("appinstalled", () => { deferred = null; installedNow = true; notify(); });
}

export type InstallState =
  | "installed"   // running as the installed app, or just installed
  | "available"   // the browser can install it with one click
  | "ios"         // Safari on iPhone / iPad: Share → Add to Home Screen
  | "safari-mac"  // Safari on a Mac: File → Add to Dock
  | "menu"        // a browser that installs from its own menu (address-bar icon, or the menu)
  | "unsupported" // the desktop or phone app already, or a browser that cannot install web apps (e.g. Firefox on a computer)
;

export function installState(): InstallState {
  if (typeof window === "undefined") return "unsupported";
  const ua = navigator.userAgent;
  if (isNativeApp() || /Electron/i.test(ua)) return "unsupported";
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
  if (standalone || installedNow) return "installed";
  if (deferred) return "available";
  const ios = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
  if (ios) return "ios";
  const safari = /Safari\//.test(ua) && !/Chrome|Chromium|CriOS|Edg\/|OPR\//.test(ua);
  if (safari && /Macintosh/i.test(ua)) return "safari-mac";
  if (/Firefox\//.test(ua) && !/Android/i.test(ua)) return "unsupported";
  return "menu";
}

/** Shows the browser's install prompt. Resolves true when the person installed it. */
export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  const e = deferred;
  deferred = null;
  await e.prompt();
  const { outcome } = await e.userChoice;
  if (outcome === "accepted") installedNow = true;
  notify();
  return outcome === "accepted";
}

export function useInstall() {
  const [state, setState] = useState<InstallState>(installState);
  useEffect(() => {
    const update = () => setState(installState());
    listeners.add(update);
    update();
    return () => { listeners.delete(update); };
  }, []);
  return { state, install: promptInstall };
}

/** Steps for browsers without a one-click prompt. */
export function installSteps(state: InstallState): string[] {
  const android = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
  switch (state) {
    case "ios": return ["Open this page in Safari.", "Tap the Share button (the square with an arrow).", "Tap “Add to Home Screen”, then “Add”."];
    case "safari-mac": return ["In Safari's menu bar, choose File → Add to Dock.", "Click “Add”. LedgerFox opens from the Dock like any app."];
    case "menu": return android
      ? ["Open the browser menu (⋮ at the top right).", "Tap “Install app” or “Add to Home screen”."]
      : ["Look for the install icon at the right end of the address bar (a screen with a down arrow), or open the browser menu (⋮).", "Choose “Install LedgerFox” (Chrome) or “Apps → Install this site as an app” (Edge)."];
    case "unsupported": return ["This browser cannot install web apps. Open this page in Chrome or Edge (or Safari on iPhone / Mac) and install from there."];
    default: return [];
  }
}
