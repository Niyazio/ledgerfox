/**
 * LedgerFox desktop app (Windows, macOS, Linux).
 * Company data lives in one SQLite file the user chooses (e.g. C:\LedgerFox\Data\MyBusiness.ledgerfox). The app runs
 * the same server as the cloud version on this computer and shows it in a window. Optionally, phones and other
 * computers can use it over the same Wi-Fi, or anywhere through a temporary free internet link.
 */
import { app, BrowserWindow, Menu, dialog, shell, net, type MenuItemConstructorOptions } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { basename, dirname, join } from "node:path";
import QRCode from "qrcode";
import { startServer, type RunningServer } from "../server/http";
import { ensureCloudflared, startTunnel, type Tunnel } from "./tunnel";

const DEFAULT_PORT = 4780;
const FILE_EXT = "ledgerfox";

interface Config { dataFile?: string; lan?: boolean; port?: number; lastBackup?: number }

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
    server = await startServer({ dataFile, webDir, migrationsDir, host, port: config.port ?? DEFAULT_PORT });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
    server = await startServer({ dataFile, webDir, migrationsDir, host, port: 0 });
  }
  config.dataFile = dataFile;
  saveConfig();
  autoBackup();
  app.addRecentDocument(dataFile);
  if (win) {
    win.setTitle(`LedgerFox — ${basename(dataFile)}`);
    await win.loadURL(localUrl());
  }
  buildMenu();
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

async function firstRun(): Promise<string | null> {
  const r = await dialog.showMessageBox({
    type: "question",
    title: "Welcome to LedgerFox",
    message: "Where should LedgerFox keep your accounts?",
    detail: "Your data is saved in one file on this computer, in a folder you choose (for example C:\\LedgerFox). Back it up by copying that file. Nothing is sent to the internet unless you turn on the internet link.",
    buttons: ["Create a new data file…", "Open an existing file…", "Quit"],
    cancelId: 2,
  });
  if (r.response === 0) return chooseNewFile();
  if (r.response === 1) return chooseExistingFile();
  return null;
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

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: "appMenu" as const }] : []),
    {
      label: "File",
      submenu: [
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
        { label: "Show data file in folder", enabled: Boolean(config.dataFile), click: () => config.dataFile && shell.showItemInFolder(config.dataFile) },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "Access",
      submenu: [
        { label: "Phones on the same Wi-Fi", type: "checkbox", checked: Boolean(config.lan), click: (item) => void setLan(item.checked) },
        tunnel
          ? { label: "Stop internet link", click: async () => { await stopTunnel(); buildMenu(); } }
          : { label: "Start internet link (temporary)…", enabled: Boolean(server), click: () => void startInternetLink() },
        { type: "separator" },
        { label: "Show phone access details", click: () => void showAccess() },
      ],
    },
    { role: "viewMenu" },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "About LedgerFox", click: () => void dialog.showMessageBox({ type: "info", message: `LedgerFox ${app.getVersion()}`, detail: "Free, open-source double-entry accounting (MIT licence). Your data stays in the file you chose unless you turn on phone or internet access." }) },
        { label: `Data file: ${config.dataFile ?? "none"}`, enabled: false },
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
    if (url.startsWith(localUrl())) return { action: "allow" };
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith(localUrl())) { e.preventDefault(); if (/^https?:/.test(url)) void shell.openExternal(url); } });
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
    let file = pendingOpen ?? (config.dataFile && existsSync(config.dataFile) ? config.dataFile : null);
    if (!file) file = await firstRun();
    if (!file) { app.quit(); return; }
    try {
      await boot(file);
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
