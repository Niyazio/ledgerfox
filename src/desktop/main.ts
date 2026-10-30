/**
 * LedgerFox desktop app (Windows, macOS, Linux). Two ways to work:
 * - Online (recommended): the window shows the LedgerFox website, signed in with the same account. The data is the
 *   same everyone in the business sees, on the LedgerFox cloud. Without internet, recently opened screens still show
 *   from this computer's cache, and new invoices, payments and entries wait on this computer and are sent when the
 *   connection returns (each once only).
 * - On this computer only: company data lives in one SQLite file the user chooses (e.g. C:\LedgerFox\MyBusiness.ledgerfox).
 *   The app runs the same server as the cloud version on this computer and shows it in a window. Optionally, phones
 *   and other computers can use it over the same Wi-Fi, or anywhere through a temporary free internet link.
 */
import { app, BrowserWindow, Menu, dialog, shell, net, type MenuItemConstructorOptions } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { basename, dirname, join } from "node:path";
import QRCode from "qrcode";
import { startServer, type RunningServer } from "../server/http";
import { ensureCloudflared, startTunnel, type Tunnel } from "./tunnel";
import { checkForUpdatesNow, desktopUpdater, setupAutoUpdate } from "./updates";

const DEFAULT_PORT = 4780;
const FILE_EXT = "ledgerfox";

interface Config { mode?: "online" | "local"; dataFile?: string; lan?: boolean; port?: number; lastBackup?: number }

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
    server = await startServer({ dataFile, webDir, migrationsDir, host, port: config.port ?? DEFAULT_PORT, updater: desktopUpdater });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
    server = await startServer({ dataFile, webDir, migrationsDir, host, port: 0, updater: desktopUpdater });
  }
  config.dataFile = dataFile;
  config.mode = "local";
  saveConfig();
  autoBackup();
  app.addRecentDocument(dataFile);
  if (win) {
    win.setTitle(`LedgerFox — ${basename(dataFile)}`);
    await win.loadURL(localUrl());
  }
  buildMenu();
}

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
  <p>LedgerFox will try again by itself. To work without internet only, use File → Use a data file on this computer.</p></div>`;
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

async function chooseNewFile(): Promise<string | null> {
  const r = await dialog.showSaveDialog({
    title: "Create a LedgerFox data file",
    defaultPath: join(app.getPath("documents"), "LedgerFox", `My Business.${FILE_EXT}`),
    buttonLabel: "Create",
    filters: [{ name: "LedgerFox data", extensions: [FILE_EXT] }],
  });
  if (r.canceled || !r.filePath) return null;
  if (existsSync(r.filePath)) {
    const c = await dialog.showMessageBox({ type: "warning", buttons: ["Open it", "Cancel"], message: "That file already exists.", detail: "LedgerFox will open the existing file. It will not overwrite it." });
    if (c.response !== 0) return null;
  }
  return r.filePath;
}

async function chooseExistingFile(): Promise<string | null> {
  const r = await dialog.showOpenDialog({ title: "Open a LedgerFox data file", properties: ["openFile"], filters: [{ name: "LedgerFox data", extensions: [FILE_EXT] }] });
  return r.canceled ? null : r.filePaths[0] ?? null;
}

const ONLINE_DETAIL = "Sign in with the same email and password as the LedgerFox website. Everyone in your business sees the same, up-to-date data, kept safely on the LedgerFox cloud. Without internet you can keep working: new entries wait on this computer and are sent when the internet is back.";

async function firstRun(): Promise<"online" | string | null> {
  const r = await dialog.showMessageBox({
    type: "question",
    title: "Welcome to LedgerFox",
    message: "How do you want to use LedgerFox?",
    detail: `Online (recommended): ${ONLINE_DETAIL}\n\nOn this computer only: your data is saved in one file on this computer, in a folder you choose. Other people can't see it unless you turn on phone access. You still need a LedgerFox account for the plan.`,
    buttons: ["Online with my LedgerFox account (recommended)", "Create a data file on this computer…", "Open an existing data file…", "Quit"],
    cancelId: 3,
  });
  if (r.response === 0) return "online";
  if (r.response === 1) return chooseNewFile();
  if (r.response === 2) return chooseExistingFile();
  return null;
}

/** Once, for people who used a data file before online mode existed. Their file stays as it is. */
async function offerOnline(): Promise<boolean> {
  const r = await dialog.showMessageBox({
    type: "question",
    title: "LedgerFox can now work online",
    message: "Use LedgerFox online with your website account?",
    detail: `${ONLINE_DETAIL}\n\nYour data file on this computer is not changed or deleted. You can open it again any time from File → Use a data file on this computer. To move its records to the cloud, export them (Settings → Export) and import them on the website.`,
    buttons: ["Switch to online", "Keep using the file on this computer"],
    cancelId: 1,
  });
  return r.response === 0;
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
        { label: "Work online (LedgerFox account)", type: "radio", checked: online(), click: () => { if (!online()) void goOnline(); } },
        {
          label: "Use a data file on this computer", type: "radio", checked: !online(), click: async () => {
            if (!online()) return;
            const f = config.dataFile && existsSync(config.dataFile) ? config.dataFile : await chooseExistingFile() ?? await chooseNewFile();
            if (f) await boot(f); else buildMenu();
          },
        },
        { type: "separator" },
        { label: "New data file…", accelerator: "CmdOrCtrl+Shift+N", click: async () => { const f = await chooseNewFile(); if (f) await boot(f); } },
        { label: "Open data file…", accelerator: "CmdOrCtrl+O", click: async () => { const f = await chooseExistingFile(); if (f) await boot(f); } },
        { type: "separator" },
        {
          label: "Back up now…", accelerator: "CmdOrCtrl+B", enabled: Boolean(server), click: async () => {
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
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => { if (!inApp(url)) { e.preventDefault(); if (/^https?:/.test(url)) void shell.openExternal(url); } });
  // Online mode, no internet, and the website not yet cached on this computer.
  win.webContents.on("did-fail-load", (_e, code, _desc, url, isMainFrame) => {
    if (isMainFrame && online() && code !== -3 && url.startsWith(ONLINE_URL)) void showOfflinePage();
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
    let file: string | null = pendingOpen;
    if (!file && config.mode === "online") file = "online";
    if (!file && config.dataFile && existsSync(config.dataFile)) file = config.mode === undefined && (await offerOnline()) ? "online" : config.dataFile;
    if (!file) file = await firstRun();
    if (!file) { app.quit(); return; }
    try {
      if (file === "online") await goOnline(); else await boot(file);
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
