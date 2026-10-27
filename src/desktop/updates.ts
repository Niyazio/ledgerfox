/**
 * Automatic updates from GitHub Releases.
 * - Windows and Linux (AppImage): electron-updater downloads new versions in the background and installs on restart.
 * - macOS: unsigned apps cannot replace themselves (Apple requires a paid Developer ID), so the user is told about the
 *   new version and taken to the download.
 * The state is also served to the app's own screens (Update button and notice) through the local server.
 */
import { app, dialog, net, shell } from "electron";
import { autoUpdater } from "electron-updater";
import type { DesktopUpdater, UpdateState } from "../server/http";

const REPO = "Niyazio/ledgerfox";
const DOWNLOAD_PAGE = "https://ledgerfox.niyazio.com/download";

function newer(latest: string, current: string): boolean {
  const a = latest.replace(/^v/, "").split(".").map(Number);
  const b = current.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}

const plain = (notes: unknown): string | null => {
  const text = Array.isArray(notes) ? notes.map((n) => (n as { note?: string }).note ?? "").join("\n") : typeof notes === "string" ? notes : "";
  return text.replace(/<[^>]+>/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 4000) || null;
};

const state: UpdateState = { current: app.getVersion(), latest: null, status: "idle", progress: null, notes: null, manual_download: process.platform === "darwin" ? DOWNLOAD_PAGE : null, checked_at: null };
const set = (patch: Partial<UpdateState>) => Object.assign(state, patch);

async function checkGithub(manual: boolean) {
  set({ status: "checking" });
  try {
    const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: "application/vnd.github+json" } });
    const rel = (await res.json()) as { tag_name?: string; body?: string };
    set({ checked_at: new Date().toISOString() });
    if (rel.tag_name && newer(rel.tag_name, app.getVersion())) {
      set({ status: "available", latest: rel.tag_name.replace(/^v/, ""), notes: plain(rel.body) });
      if (manual) {
        const r = await dialog.showMessageBox({ type: "info", buttons: ["Download", "Later"], message: `LedgerFox ${rel.tag_name} is available`, detail: `You have ${app.getVersion()}. Your data file is kept when you install the new version.` });
        if (r.response === 0) void shell.openExternal(DOWNLOAD_PAGE);
      }
    } else {
      set({ status: "up-to-date" });
      if (manual) void dialog.showMessageBox({ type: "info", message: "LedgerFox is up to date", detail: `Version ${app.getVersion()}` });
    }
  } catch {
    set({ status: "error" });
    if (manual) void dialog.showMessageBox({ type: "warning", message: "Could not check for updates", detail: "Check the internet connection and try again." });
  }
}

let started = false;
export function setupAutoUpdate() {
  if (!app.isPackaged || started) return;
  started = true;
  if (process.platform === "darwin") {
    void checkGithub(false);
    setInterval(() => void checkGithub(false), 6 * 3600_000);
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("checking-for-update", () => set({ status: "checking" }));
  autoUpdater.on("update-not-available", () => set({ status: "up-to-date", checked_at: new Date().toISOString() }));
  autoUpdater.on("update-available", (info) => set({ status: "downloading", latest: info.version, notes: plain(info.releaseNotes), progress: 0, checked_at: new Date().toISOString() }));
  autoUpdater.on("download-progress", (p) => set({ status: "downloading", progress: Math.round(p.percent) }));
  autoUpdater.on("update-downloaded", async (info) => {
    set({ status: "ready", latest: info.version, progress: 100, notes: plain(info.releaseNotes) ?? state.notes });
    const r = await dialog.showMessageBox({ type: "info", buttons: ["Restart now", "Later"], message: `LedgerFox ${info.version} is ready to install`, detail: "It installs when you restart LedgerFox. Your data file is not changed by updates." });
    if (r.response === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.on("error", () => { set({ status: state.status === "ready" ? "ready" : "error" }); /* offline or no release yet: try again later */ });
  void autoUpdater.checkForUpdates().catch(() => undefined);
  setInterval(() => void autoUpdater.checkForUpdates().catch(() => undefined), 6 * 3600_000);
}

export async function checkForUpdatesNow() {
  if (!app.isPackaged || process.platform === "darwin") return checkGithub(true);
  try {
    const r = await autoUpdater.checkForUpdates();
    if (!r?.isUpdateAvailable) void dialog.showMessageBox({ type: "info", message: "LedgerFox is up to date", detail: `Version ${app.getVersion()}` });
    else void dialog.showMessageBox({ type: "info", message: `Downloading LedgerFox ${r.updateInfo.version}…`, detail: "You will be asked to restart when it is ready." });
  } catch {
    void dialog.showMessageBox({ type: "warning", message: "Could not check for updates", detail: "Check the internet connection and try again." });
  }
}

/** For the in-app Update button: same updater, no pop-up dialogs (the app shows the result). */
export const desktopUpdater: DesktopUpdater = {
  status: () => ({ ...state, current: app.getVersion() }),
  async check() {
    if (!app.isPackaged) { set({ status: "up-to-date", checked_at: new Date().toISOString() }); return this.status(); }
    if (process.platform === "darwin") { await checkGithub(false); return this.status(); }
    try { await autoUpdater.checkForUpdates(); } catch { set({ status: "error" }); }
    return this.status();
  },
  install() {
    if (state.status === "ready") setTimeout(() => autoUpdater.quitAndInstall(), 300);
    else if (state.manual_download) void shell.openExternal(state.manual_download);
  },
};
