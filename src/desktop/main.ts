/**
 * LedgerFox desktop app (Windows, macOS, Linux). It works online: the window shows the LedgerFox website, signed in
 * with the same account, and the data is the same everyone in the business sees, on the LedgerFox cloud. Without
 * internet, recently opened screens still show from this computer's cache, and new invoices, payments and entries
 * wait on this computer and are sent when the connection returns (each once only). Every company is also copied
 * automatically to a folder on this computer (see localcopy.ts).
 * Data files from older versions (one SQLite file, e.g. C:\LedgerFox\MyBusiness.ledgerfox) open view-only, to look
 * things up and export them; the same server as the cloud version runs on this computer for that.
 */
import { app, BrowserWindow, Menu, dialog, shell, net, systemPreferences, type MenuItemConstructorOptions } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { basename, dirname, join } from "node:path";
import QRCode from "qrcode";
import { startServer, type RunningServer } from "../server/http";
import { ensureCloudflared, startTunnel, type Tunnel } from "./tunnel";
import { checkForUpdatesNow, desktopUpdater, setupAutoUpdate } from "./updates";
import { saveLocalCopy } from "./localcopy";

const DEFAULT_PORT = 4780;
const FILE_EXT = "ledgerfox";

interface Config { mode?: "online" | "local"; dataFile?: string; lan?: boolean; port?: number; lastBackup?: number; toldOnlineOnly?: boolean;
  /** Automatic local copy of the cloud data (default Documents\LedgerFox Data). */
  localFolder?: string; lastLocalCopy?: string; localCopyError?: string | null; toldLocalCopy?: boolean }

/** The LedgerFox website the online mode shows (LEDGERFOX_ONLINE_URL may point to a test copy; https only). */
const ONLINE_URL = /^https:\/\/[^/]+$/.test(process.env.LEDGERFOX_ONLINE_URL ?? "") ? process.env.LEDGERFOX_ONLINE_URL! : "https://ledgerfox.niyazio.com";
const online = () => config.mode === "online";

const resources = app.isPackaged ? process.resourcesPath : join(__dirname, "..");
const webDir = join(resources, app.isPackaged ? "web" : "dist");
const migrationsDir = join(resources, "migrations");
const configPath = () => join(app.getPath("userData"), "config.json");

let config: Config = {};
let server: RunningServer | null = null;
let tunnel: Tunnel | null = null;
let win: BrowserWindow | null = null;
let accessWin: BrowserWindow | null = null;
let pendingOpen: string | null = process.argv.find((a) => a.toLowerCase().endsWith(`.${FILE_EXT}`)) ?? null;

function loadConfig() {
  try { config = JSON.parse(readFileSync(configPath(), "utf8")); } catch { config = {}; }
}
function saveConfig() {
  mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(config, null, 2));
}

const localUrl = () => `http://127.0.0.1:${server?.port ?? DEFAULT_PORT}`;
/** Pages the app window may show; everything else opens in the normal browser. */
const appOrigin = () => (online() ? ONLINE_URL : localUrl());
const inApp = (url: string) => url === appOrigin() || url.startsWith(`${appOrigin()}/`);
/** Links that open in the computer's own apps: the browser, email, WhatsApp, phone and UPI apps. */
const external = (url: string) => /^(https?:|mailto:|tel:|whatsapp:|upi:)/i.test(url);

function lanUrls(): string[] {
  if (!server || !config.lan) return [];
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) out.push(`http://${a.address}:${server.port}`);
  }
  return out;
}

async function boot(dataFile: string) {
  await stopTunnel();
  if (server) { await server.close(); server = null; }
  mkdirSync(dirname(dataFile), { recursive: true });
  const host = config.lan ? "0.0.0.0" : "127.0.0.1";
  try {
    server = await startServer({ dataFile, webDir, migrationsDir, host, port: config.port ?? DEFAULT_PORT, updater: desktopUpdater, env: OLD_FILE_ENV });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
    server = await startServer({ dataFile, webDir, migrationsDir, host, port: 0, updater: desktopUpdater, env: OLD_FILE_ENV });
  }
  config.dataFile = dataFile;
  config.mode = "local";
  saveConfig();
  autoBackup();
  app.addRecentDocument(dataFile);
  if (win) {
    win.setTitle(`LedgerFox — ${basename(dataFile)} (view only)`);
    await win.loadURL(localUrl());
  }
  buildMenu();
}

/** Old data files are only looked at and exported: no new entries, no plan check. */
const OLD_FILE_ENV = { DESKTOP_READONLY: "true", DESKTOP_LICENSING: "off" };

let retryTimer: NodeJS.Timeout | null = null;

/** Online mode: show the LedgerFox website. The data file (if any) is closed but left untouched on disk. */
async function goOnline() {
  await stopTunnel();
  if (server) { await server.close(); server = null; }
  config.mode = "online";
  saveConfig();
  buildMenu();
  if (win) { win.setTitle("LedgerFox — online"); await loadOnline(); }
}

async function loadOnline() {
  if (!win) return;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  // The website's service worker answers from this computer's cache when there is no internet.
  try { await win.loadURL(`${ONLINE_URL}/app`); } catch { /* did-fail-load shows the offline page */ }
}

/** Shown only when the website was never opened on this computer and there is no internet; retries by itself. */
async function showOfflinePage() {
  if (!win || !online()) return;
  const html = `<!doctype html><meta charset="utf-8"><title>LedgerFox</title>
  <style>body{font:15px system-ui,sans-serif;margin:0;display:grid;place-items:center;height:100vh;background:#f6f7f9;color:#0f172a}div{max-width:460px;padding:24px;text-align:center}p{color:#475569}</style>
  <div><h1 style="font-size:20px">Waiting for the internet</h1>
  <p>The first time, LedgerFox needs internet to sign in to your account. After that it also opens without internet and sends your new entries when the connection is back.</p>
  <p>LedgerFox will try again by itself.</p></div>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => undefined);
  retryTimer = setTimeout(() => void loadOnline(), 15_000);
}

/** Consistent copy of the open data file (safe while the app is running). */
function backupTo(target: string) {
  if (!server) throw new Error("No data file is open");
  if (existsSync(target)) rmSync(target);
  server.db.raw.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
}

/** Once a day, keep a dated copy next to the data file; the newest 14 are kept. */
function autoBackup() {
  if (!server || !config.dataFile) return;
  if (config.lastBackup && Date.now() - config.lastBackup < 24 * 3600_000) return;
  try {
    const dir = join(dirname(config.dataFile), "LedgerFox Backups");
    mkdirSync(dir, { recursive: true });
    const stem = basename(config.dataFile, `.${FILE_EXT}`);
    backupTo(join(dir, `${stem} ${new Date().toISOString().slice(0, 10)}.${FILE_EXT}`));
    const old = readdirSync(dir).filter((f) => f.startsWith(stem + " ") && f.endsWith(`.${FILE_EXT}`))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t).slice(14);
    for (const o of old) rmSync(join(dir, o.f));
    config.lastBackup = Date.now();
    saveConfig();
  } catch (e) {
    console.error("Automatic backup failed:", e);
  }
}

async function chooseExistingFile(): Promise<string | null> {
  const r = await dialog.showOpenDialog({ title: "Open a LedgerFox data file", properties: ["openFile"], filters: [{ name: "LedgerFox data", extensions: [FILE_EXT] }] });
  return r.canceled ? null : r.filePaths[0] ?? null;
}

/** Once, for people who used a data file before LedgerFox moved online. Their file stays as it is. */
async function tellOnlineOnly() {
  if (config.toldOnlineOnly || !config.dataFile) return;
  config.toldOnlineOnly = true;
  saveConfig();
  await dialog.showMessageBox({
    type: "info",
    title: "LedgerFox now works online",
    message: "Sign in with your LedgerFox account",
    detail: `LedgerFox now keeps your books online, so everyone in your business sees the same data and it is backed up for you. Without internet you can keep billing; your entries are sent when the internet is back.\n\nYour old data file is kept as it was:\n${config.dataFile}\nOpen it any time from File → Open an old data file (view only) to look things up or export it.`,
    buttons: ["OK"],
  });
}

const localFolder = () => config.localFolder ?? join(app.getPath("documents"), "LedgerFox Data");
let copying = false;

/** Copy every company the signed-in person can open to the local folder (online mode only; quietly skipped offline). */
async function runLocalCopy(manual = false) {
  if (copying || !win || !online() || !win.webContents.getURL().startsWith(ONLINE_URL)) {
    if (manual) await dialog.showMessageBox({ type: "info", message: "Sign in first", detail: "The local copy is made while you are signed in and online." });
    return;
  }
  copying = true;
  try {
    const n = await saveLocalCopy(win.webContents, localFolder());
    if (n) { config.lastLocalCopy = new Date().toISOString(); config.localCopyError = null; saveConfig(); buildMenu(); }
    if (n && !manual && !config.toldLocalCopy) {
      config.toldLocalCopy = true;
      saveConfig();
      const r = await dialog.showMessageBox({
        type: "info", title: "Local copy on this computer", message: "Your data is also saved on this computer",
        detail: `LedgerFox keeps your books in the LedgerFox cloud and also copies every company automatically to:\n${localFolder()}\n\nThe copy is updated every 15 minutes while you are online, with one copy per day for the last 30 days. Change the folder any time in File → Change local copy folder.`,
        buttons: ["OK", "Change folder…"], cancelId: 0,
      });
      if (r.response === 1) await chooseLocalFolder();
    }
    if (manual) await dialog.showMessageBox({ type: "info", message: n ? `Saved ${n} compan${n === 1 ? "y" : "ies"}` : "Nothing to save yet", detail: n ? localFolder() : "Sign in and connect to the internet, then try again." });
  } catch (e) {
    config.localCopyError = (e as Error).message;
    saveConfig();
    if (manual) dialog.showErrorBox("Could not save the local copy", `${localFolder()}\n\n${(e as Error).message}`);
  } finally { copying = false; }
}

async function chooseLocalFolder() {
  const r = await dialog.showOpenDialog({ title: "Folder for the automatic local copy", defaultPath: localFolder(), properties: ["openDirectory", "createDirectory"] });
  if (r.canceled || !r.filePaths[0]) return;
  config.localFolder = r.filePaths[0];
  saveConfig();
  buildMenu();
  void runLocalCopy(true);
}

async function setLan(on: boolean) {
  config.lan = on;
  saveConfig();
  if (config.dataFile) await boot(config.dataFile);
  if (on) showAccess();
}

async function stopTunnel() {
  if (tunnel) { server?.publicHosts.delete(tunnel.host); tunnel.stop(); tunnel = null; }
}

async function startInternetLink() {
  if (!server) return;
  const emails = (server.db.raw.prepare("SELECT email FROM users ORDER BY created_at").all() as { email: string }[]).map((r) => r.email);
  const choice = await dialog.showMessageBox({
    type: "warning",
    title: "Internet link",
    message: "Make LedgerFox reachable from anywhere through a temporary internet address?",
    detail: [
      "A free Cloudflare Quick Tunnel will be started. The address is random, changes every time, and stops when you close LedgerFox or this computer sleeps. Cloudflare describes Quick Tunnels as intended for testing, without uptime guarantees.",
      "Everyone still has to sign in with their LedgerFox password.",
      emails.length ? `Recommended: also require an emailed one-time code (from Cloudflare) for: ${emails.join(", ")}.` : "",
      "The first time, the cloudflared program (about 40 MB) is downloaded from Cloudflare's GitHub releases.",
    ].filter(Boolean).join("\n\n"),
    buttons: emails.length ? ["Start with email code (recommended)", "Start with password only", "Cancel"] : ["Start", "Cancel"],
    cancelId: emails.length ? 2 : 1,
  });
  if (choice.response === (emails.length ? 2 : 1)) return;
  const allowed = emails.length && choice.response === 0 ? emails : [];
  try {
    const bin = await ensureCloudflared(join(app.getPath("userData"), "bin"), async (url) => {
      const res = await net.fetch(url);
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      return res.arrayBuffer();
    });
    tunnel = await startTunnel(bin, server.port, allowed, (msg) => { tunnel = null; buildMenu(); dialog.showMessageBox({ type: "info", message: msg }); });
    server.publicHosts.add(tunnel.host);
    buildMenu();
    showAccess();
  } catch (e) {
    dialog.showErrorBox("Could not start the internet link", (e as Error).message);
  }
}

async function showAccess() {
  const links: { label: string; url: string }[] = [
    ...(tunnel ? [{ label: "Anywhere (internet link — changes each time)", url: tunnel.url }] : []),
    ...lanUrls().map((url) => ({ label: "Same Wi-Fi / office network", url })),
  ];
  const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
  const blocks = await Promise.all(links.map(async (l) => `
    <div class="card"><img src="${await QRCode.toDataURL(l.url, { margin: 1, width: 180 })}" alt=""><div><b>${esc(l.label)}</b><code>${esc(l.url)}</code></div></div>`));
  const html = `<!doctype html><meta charset="utf-8"><title>Use LedgerFox on your phone</title>
  <style>body{font:14px system-ui,sans-serif;margin:20px;color:#0f172a}h1{font-size:18px}.card{display:flex;gap:16px;align-items:center;border:1px solid #e5e7eb;border-radius:12px;padding:12px;margin:12px 0}
  code{display:block;margin-top:6px;font-size:13px;user-select:all;word-break:break-all}p{color:#475569}</style>
  <h1>Use LedgerFox on your phone</h1>
  ${blocks.join("") || "<p>Turn on <b>Access → Phones on the same Wi-Fi</b> or <b>Access → Internet link</b> first.</p>"}
  <p>Scan the code with the phone camera, then sign in with your LedgerFox email and password. This computer must stay on with LedgerFox open.</p>
  ${config.lan ? "<p>Same Wi-Fi uses plain http inside your network. If Windows asks, allow LedgerFox on <b>private</b> networks only.</p>" : ""}`;
  if (!accessWin || accessWin.isDestroyed()) {
    accessWin = new BrowserWindow({ width: 560, height: 640, title: "Use LedgerFox on your phone", parent: win ?? undefined, webPreferences: { sandbox: true, contextIsolation: true, javascript: false } });
    accessWin.setMenuBarVisibility(false);
  }
  await accessWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  accessWin.show();
}

/** QR code with a one-time link: the LedgerFox Android app scans it and saves a view-only copy of this data file. */
async function showPhoneCopy() {
  if (!server) return;
  if (!config.lan && !tunnel) {
    const r = await dialog.showMessageBox({ type: "question", buttons: ["Turn on phone access", "Cancel"], message: "The phone needs to reach this computer", detail: "Turn on Access → Phones on the same Wi-Fi first (both devices on the same network)." });
    if (r.response !== 0) return;
    await setLan(true);
  }
  const token = server.createPairToken();
  const targets = [...lanUrls(), ...(tunnel ? [tunnel.url] : [])].map((u) => `${u}/api/pair/${token}`);
  const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
  const blocks = await Promise.all(targets.map(async (t) => `<div class="card"><img src="${await QRCode.toDataURL(t, { margin: 1, width: 220 })}" alt=""><code>${esc(t)}</code></div>`));
  const html = `<!doctype html><meta charset="utf-8"><title>Copy data to phone</title>
  <style>body{font:14px system-ui,sans-serif;margin:20px;color:#0f172a}h1{font-size:18px}.card{border:1px solid #e5e7eb;border-radius:12px;padding:12px;margin:12px 0;text-align:center}
  code{display:block;margin-top:6px;font-size:12px;word-break:break-all}p{color:#475569}</style>
  <h1>Copy data to phone (view-only)</h1>
  <p>Open the <b>LedgerFox Android app</b> → <b>Scan QR code</b>. The phone saves a view-only copy of this data file and can open it without internet. Signing in on the phone uses the same usernames and passwords.</p>
  ${blocks.join("")}
  <p>The code works once and expires in 10 minutes. Login sessions and recovery codes are not copied. Anyone holding the phone can read the copy after signing in, so protect the phone with a screen lock.</p>`;
  const w = new BrowserWindow({ width: 520, height: 720, title: "Copy data to phone", parent: win ?? undefined, webPreferences: { sandbox: true, contextIsolation: true, javascript: false } });
  w.setMenuBarVisibility(false);
  await w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: "appMenu" as const }] : []),
    {
      label: "File",
      submenu: [
        { label: "Work online", enabled: !online(), click: () => void goOnline() },
        { label: "Save local copy now", accelerator: "CmdOrCtrl+B", enabled: online(), click: () => void runLocalCopy(true) },
        { label: "Open local copy folder", click: () => { mkdirSync(localFolder(), { recursive: true }); void shell.openPath(localFolder()); } },
        { label: "Change local copy folder…", click: () => void chooseLocalFolder() },
        { label: `Last local copy: ${config.lastLocalCopy ? new Date(config.lastLocalCopy).toLocaleString() : "not yet"}`, enabled: false },
        { type: "separator" },
        { label: "Open an old data file (view only)…", click: async () => { const f = await chooseExistingFile(); if (f) await boot(f); } },
        { type: "separator" },
        {
          label: "Copy the old data file…", enabled: Boolean(server) && !online(), click: async () => {
            const stem = basename(config.dataFile ?? "LedgerFox", `.${FILE_EXT}`);
            const r = await dialog.showSaveDialog({ title: "Save a backup copy", defaultPath: join(app.getPath("documents"), `${stem} backup ${new Date().toISOString().slice(0, 10)}.${FILE_EXT}`), filters: [{ name: "LedgerFox data", extensions: [FILE_EXT] }] });
            if (r.canceled || !r.filePath) return;
            try { backupTo(r.filePath); dialog.showMessageBox({ type: "info", message: "Backup saved", detail: r.filePath }); } catch (e) { dialog.showErrorBox("Backup failed", (e as Error).message); }
          },
        },
        { label: "Show data file in folder", enabled: Boolean(config.dataFile) && !online(), click: () => config.dataFile && shell.showItemInFolder(config.dataFile) },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "Access",
      submenu: [
        { label: "Phones on the same Wi-Fi", type: "checkbox", checked: Boolean(config.lan), enabled: !online(), click: (item) => void setLan(item.checked) },
        tunnel
          ? { label: "Stop internet link", click: async () => { await stopTunnel(); buildMenu(); } }
          : { label: "Start internet link (temporary)…", enabled: Boolean(server), click: () => void startInternetLink() },
        ...(online() ? [{ label: "Online: phones use the LedgerFox website or app directly", enabled: false }] : []),
        { label: "Copy data to phone (view-only)…", enabled: Boolean(server), click: () => void showPhoneCopy() },
        { type: "separator" },
        { label: "Show phone access details", click: () => void showAccess() },
      ],
    },
    { role: "viewMenu" },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "About LedgerFox", click: () => void dialog.showMessageBox({ type: "info", message: `LedgerFox ${app.getVersion()}`, detail: "A product of Niyazio (niyazio.com). Support: info@niyazio.com\n\nFree, open-source double-entry accounting (MIT licence). Your data stays in the file you chose unless you turn on phone, internet or cloud backup." }) },
        { label: "Check for updates…", click: () => void checkForUpdatesNow() },
        { label: "Support: info@niyazio.com", click: () => void shell.openExternal("mailto:info@niyazio.com?subject=LedgerFox%20support") },
        { label: "Niyazio website", click: () => void shell.openExternal("https://niyazio.com") },
        { type: "separator" },
        { label: online() ? `Online: ${ONLINE_URL}` : `Data file: ${config.dataFile ?? "none"}`, enabled: false },
        { label: `Version ${app.getVersion()}`, enabled: false },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 380, minHeight: 500, show: false, title: "LedgerFox",
    backgroundColor: "#f6f7f9",
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.once("ready-to-show", () => win?.show());
  // Links to other sites open in the normal browser; the app window only ever shows LedgerFox.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (inApp(url)) return { action: "allow" };
    // Online mode: Razorpay's payment window (UPI, bank and card checks) opens as a pop-up of the website.
    if (online() && /^https:\/\/([a-z0-9-]+\.)*razorpay\.com\//.test(url)) return { action: "allow" };
    if (external(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => { if (!inApp(url)) { e.preventDefault(); if (external(url)) void shell.openExternal(url); } });
  // Camera (barcode / QR scanning) and copy-to-clipboard for LedgerFox's own pages only; nothing else is granted.
  // macOS also asks the person once for camera access.
  const ses = win.webContents.session;
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const own = inApp(details.requestingUrl ?? wc.getURL());
    if (own && permission === "media" && !(details as { mediaTypes?: string[] }).mediaTypes?.includes("audio")) {
      if (process.platform === "darwin") void systemPreferences.askForMediaAccess("camera").then(callback, () => callback(false));
      else callback(true);
      return;
    }
    callback(own && ["clipboard-sanitized-write", "clipboard-read", "fullscreen"].includes(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => inApp(origin) && ["media", "clipboard-sanitized-write", "clipboard-read", "fullscreen"].includes(permission));
  // Online mode, no internet, and the website not yet cached on this computer.
  win.webContents.on("did-fail-load", (_e, code, _desc, url, isMainFrame) => {
    if (isMainFrame && online() && code !== -3 && url.startsWith(ONLINE_URL)) void showOfflinePage();
  });
  // Downloads (backups, Excel, PDF) ask where to save, starting in Documents.
  win.webContents.session.on("will-download", (_e, item) => {
    item.setSaveDialogOptions({ title: "Save to this computer", defaultPath: join(app.getPath("documents"), item.getFilename()) });
    // A bill or report saved as PDF: show it in its folder, ready to drag into WhatsApp or attach to an email.
    item.once("done", (_ev, state) => { if (state === "completed" && /\.pdf$/i.test(item.getSavePath())) shell.showItemInFolder(item.getSavePath()); });
  });
  win.on("closed", () => { win = null; });
}

async function openFile(file: string) {
  if (!app.isReady()) { pendingOpen = file; return; }
  await boot(file);
  win?.show();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    const f = argv.find((a) => a.toLowerCase().endsWith(`.${FILE_EXT}`));
    if (f) void openFile(f);
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.on("open-file", (e, file) => { e.preventDefault(); void openFile(file); });

  app.whenReady().then(async () => {
    loadConfig();
    buildMenu();
    await createWindow();
    // Online always, except when an old data file was opened from the file manager (view only).
    const file = pendingOpen;
    try {
      if (file) await boot(file); else { await goOnline(); await tellOnlineOnly(); }
      // Automatic local copy: shortly after start, then every 15 minutes while signed in and online.
      setTimeout(() => void runLocalCopy(), 30_000);
      setInterval(() => void runLocalCopy(), 15 * 60_000);
      setupAutoUpdate();
    } catch (e) {
      dialog.showErrorBox("Could not open the data file", `${file}\n\n${(e as Error).message}`);
      config.dataFile = undefined;
      saveConfig();
      app.quit();
    }
  });

  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => { tunnel?.stop(); void server?.close(); });
}
