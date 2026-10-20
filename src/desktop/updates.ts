/**
 * Automatic updates from GitHub Releases.
 * - Windows and Linux (AppImage): electron-updater downloads new versions in the background and installs on restart.
 * - macOS: unsigned apps cannot replace themselves (Apple requires a paid Developer ID), so the user is told about the
 *   new version and taken to the download.
 */
import { app, dialog, net, shell } from "electron";
import { autoUpdater } from "electron-updater";

const REPO = "Niyazio/ledgerfox";
const DOWNLOAD_PAGE = "https://ledgerfox.niyazio.com/download";

function newer(latest: string, current: string): boolean {
  const a = latest.replace(/^v/, "").split(".").map(Number);
  const b = current.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}

async function notifyIfNewer(manual: boolean) {
  try {
    const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: "application/vnd.github+json" } });
    const rel = (await res.json()) as { tag_name?: string };
    if (rel.tag_name && newer(rel.tag_name, app.getVersion())) {
      const r = await dialog.showMessageBox({ type: "info", buttons: ["Download", "Later"], message: `LedgerFox ${rel.tag_name} is available`, detail: `You have ${app.getVersion()}. Your data file is kept when you install the new version.` });
      if (r.response === 0) void shell.openExternal(DOWNLOAD_PAGE);
    } else if (manual) {
      void dialog.showMessageBox({ type: "info", message: "LedgerFox is up to date", detail: `Version ${app.getVersion()}` });
    }
  } catch {
    if (manual) void dialog.showMessageBox({ type: "warning", message: "Could not check for updates", detail: "Check the internet connection and try again." });
  }
}

let started = false;
export function setupAutoUpdate() {
  if (!app.isPackaged || started) return;
  started = true;
  if (process.platform === "darwin") {
    void notifyIfNewer(false);
    setInterval(() => void notifyIfNewer(false), 6 * 3600_000);
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("update-downloaded", async (info) => {
    const r = await dialog.showMessageBox({ type: "info", buttons: ["Restart now", "Later"], message: `LedgerFox ${info.version} is ready to install`, detail: "It installs when you restart LedgerFox. Your data file is not changed by updates." });
    if (r.response === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.on("error", () => { /* offline or no release yet: try again later */ });
  void autoUpdater.checkForUpdates().catch(() => undefined);
  setInterval(() => void autoUpdater.checkForUpdates().catch(() => undefined), 6 * 3600_000);
}

export async function checkForUpdatesNow() {
  if (!app.isPackaged || process.platform === "darwin") return notifyIfNewer(true);
  try {
    const r = await autoUpdater.checkForUpdates();
    if (!r?.isUpdateAvailable) void dialog.showMessageBox({ type: "info", message: "LedgerFox is up to date", detail: `Version ${app.getVersion()}` });
    else void dialog.showMessageBox({ type: "info", message: `Downloading LedgerFox ${r.updateInfo.version}…`, detail: "You will be asked to restart when it is ready." });
  } catch {
    void dialog.showMessageBox({ type: "warning", message: "Could not check for updates", detail: "Check the internet connection and try again." });
  }
}
