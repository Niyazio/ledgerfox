/**
 * Runs LedgerFox on a PC: the same Hono app as the cloud Worker, backed by a local SQLite file, plus the built web UI.
 * Used by the desktop app (src/desktop) and the headless `ledgerfox-server` command.
 */
import { serve, type ServerType } from "@hono/node-server";
import type { IncomingMessage } from "node:http";
import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { dirname, extname, join, normalize, sep } from "node:path";
import { mkdirSync } from "node:fs";
import app from "../worker/index";
import type { Env } from "../worker/env";
import { SqliteD1, asD1 } from "./sqlite-d1";
import { migrate } from "./migrate";
import { ensureDefaultAdmin } from "../worker/routes/auth";
import { CloudBackup } from "./cloud-backup";

export interface ServerOptions {
  dataFile: string;
  webDir: string;
  migrationsDir: string;
  /** 127.0.0.1 = this computer only; 0.0.0.0 = also other devices on the network. */
  host: string;
  port: number;
  env?: Partial<Env>;
}

export interface RunningServer {
  port: number;
  db: SqliteD1;
  /** Public hostnames (e.g. an internet link) whose browser Origin is accepted. */
  publicHosts: Set<string>;
  /** One-time code (valid 10 minutes) that lets a phone download a view-only copy of the data file. */
  createPairToken: () => string;
  /** Encrypted automatic backup of this data file to LedgerFox Cloud. */
  backup: CloudBackup;
  close: () => Promise<void>;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
};

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

const isLoopback = (a: string) => a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  mkdirSync(dirname(opts.dataFile), { recursive: true });
  const db = new SqliteD1(opts.dataFile);
  migrate(db, opts.migrationsDir);
  const env: Env = {
    DB: asD1(db),
    BRAND_NAME: "LedgerFox",
    APP_ENV: "desktop",
    // 100k is the most the cloud runtime accepts, so a file moved to the cloud later keeps working logins.
    PBKDF2_ITERATIONS: "100000",
    // Sign-in starts as admin / admin (changed at first sign-in); more users are added from Settings → Users.
    ALLOW_REGISTRATION: "false",
    PASSWORD_MIN_LENGTH: "6",
    ...opts.env,
  };
  await ensureDefaultAdmin(env);
  const publicHosts = new Set<string>();
  const webRoot = normalize(opts.webDir + sep);

  async function serveStatic(pathname: string): Promise<Response> {
    let rel = decodeURIComponent(pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = normalize(join(webRoot, rel));
    if (file.startsWith(webRoot)) {
      try {
        if ((await stat(file)).isFile()) {
          const headers: Record<string, string> = { ...SECURITY_HEADERS, "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" };
          headers["Cache-Control"] = rel.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
          return new Response(await readFile(file), { headers });
        }
      } catch { /* not found → SPA fallback */ }
    }
    if (rel.startsWith("/assets/") || extname(rel)) return new Response("Not found", { status: 404, headers: SECURITY_HEADERS });
    return new Response(await readFile(join(webRoot, "index.html")), { headers: { ...SECURITY_HEADERS, "Content-Type": TYPES[".html"], "Cache-Control": "no-cache" } });
  }

  const pairTokens = new Map<string, number>();
  const createPairToken = () => {
    const t = randomBytes(18).toString("base64url");
    pairTokens.set(t, Date.now() + 10 * 60_000);
    return t;
  };

  /** Consistent copy of the data file without login sessions, recovery codes and other secrets. */
  async function phoneCopy(): Promise<{ bytes: Buffer; companies: string[] }> {
    const tmp = join(tmpdir(), `ledgerfox-phone-${randomBytes(6).toString("hex")}.db`);
    db.raw.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    try {
      const copy = new DatabaseSync(tmp);
      for (const t of ["sessions", "recovery_codes", "password_resets", "rate_limits", "idempotency_keys", "invitations", "cloud_backup_chunks", "cloud_backups", "api_tokens"]) {
        try { copy.exec(`DELETE FROM ${t}`); } catch { /* table absent in older files */ }
      }
      copy.exec("VACUUM");
      const companies = (copy.prepare("SELECT name FROM companies ORDER BY name").all() as { name: string }[]).map((r) => r.name);
      copy.close();
      return { bytes: await readFile(tmp), companies };
    } finally {
      await rm(tmp, { force: true });
    }
  }

  const backup = new CloudBackup(opts.dataFile, db);
  backup.schedule();

  /** Owner/admin signed in on this computer (never via the network or the internet link). */
  async function localAdmin(req: Request, remote: string): Promise<boolean> {
    if (!isLoopback(remote) || req.headers.has("cf-connecting-ip")) return false;
    const me = await app.fetch(new Request("http://127.0.0.1/api/auth/me", { headers: { cookie: req.headers.get("cookie") ?? "", "cf-connecting-ip": "127.0.0.1" } }), env);
    const j = (await me.json()) as { user: { must_change_password?: boolean } | null; organisations?: { role: string }[] };
    return Boolean(j.user && !j.user.must_change_password && j.organisations?.some((o) => o.role === "owner" || o.role === "admin"));
  }

  async function backupRoute(req: Request, action: string): Promise<Response> {
    const json = (data: unknown, status = 200) => Response.json(data, { status, headers: SECURITY_HEADERS });
    const fail = (e: unknown) => json({ error: { code: "BACKUP_FAILED", message: (e as Error).message } }, 400);
    const input = req.method === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, string | boolean>) : {};
    if (req.method === "POST" && req.headers.get("x-requested-with") !== "ledgerfox") return json({ error: { code: "CSRF", message: "Missing request header" } }, 403);
    try {
      switch (`${req.method} ${action}`) {
        case "GET status": return json(backup.status());
        case "POST connect": await backup.connect(String(input.login ?? ""), String(input.password ?? ""), String(input.passphrase ?? ""), input.cloud_url ? String(input.cloud_url) : undefined); return json(backup.status());
        case "POST run": return json(await backup.backupNow());
        case "GET list": return json({ backups: await backup.list() });
        case "POST restore": return json({ path: await backup.restore(String(input.id ?? ""), String(input.passphrase ?? "")) });
        case "POST enable": backup.setEnabled(Boolean(input.enabled)); return json(backup.status());
        case "POST disconnect": backup.disconnect(); return json(backup.status());
        default: return json({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);
      }
    } catch (e) { return fail(e); }
  }

  const fetch = async (req: Request, bindings: { incoming: IncomingMessage }): Promise<Response> => {
    const url = new URL(req.url);
    const desktopBackup = /^\/api\/desktop\/backup\/([a-z]+)$/.exec(url.pathname);
    if (desktopBackup) {
      if (!(await localAdmin(req, bindings.incoming.socket.remoteAddress ?? ""))) {
        return Response.json({ error: { code: "FORBIDDEN", message: "Cloud backup is managed by the owner or an administrator on this computer" } }, { status: 403 });
      }
      return backupRoute(req, desktopBackup[1]);
    }
    const pair = /^\/api\/pair\/([A-Za-z0-9_-]{20,40})$/.exec(url.pathname);
    if (pair) {
      const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "X-LedgerFox-Companies" };
      const exp = pairTokens.get(pair[1]);
      pairTokens.delete(pair[1]);
      for (const [t, e] of pairTokens) if (e < Date.now()) pairTokens.delete(t);
      if (req.method !== "GET" || !exp || exp < Date.now()) return new Response("Not found", { status: 404, headers: cors });
      const { bytes, companies } = await phoneCopy();
      return new Response(new Uint8Array(bytes), { headers: { ...cors, "Content-Type": "application/vnd.sqlite3", "Cache-Control": "no-store",
        "X-LedgerFox-Companies": companies.map((n) => encodeURIComponent(n)).join("|") } });
    }
    if (!url.pathname.startsWith("/api/")) {
      if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
      return serveStatic(url.pathname);
    }
    const remote = bindings.incoming.socket.remoteAddress ?? "";
    const headers = new Headers(req.headers);
    // Requests relayed by the local internet-link process (cloudflared) arrive from loopback with Cloudflare headers.
    const viaTunnel = isLoopback(remote) && headers.has("cf-connecting-ip");
    if (!viaTunnel) {
      headers.set("cf-connecting-ip", remote.replace(/^::ffff:/, "") || "unknown");
      headers.delete("x-forwarded-for");
    }
    let origin = `http://${headers.get("host") ?? url.host}`;
    if (viaTunnel) {
      const browserOrigin = headers.get("origin");
      const host = browserOrigin ? new URL(browserOrigin).host : headers.get("x-forwarded-host") ?? headers.get("host") ?? url.host;
      if (publicHosts.has(host)) origin = `https://${host}`;
    }
    const target = new URL(url.pathname + url.search, origin);
    const init: RequestInit & { duplex?: string } = { method: req.method, headers };
    if (req.method !== "GET" && req.method !== "HEAD") { init.body = await req.arrayBuffer(); }
    return app.fetch(new Request(target, init), env);
  };

  const server: ServerType = await new Promise((resolve, reject) => {
    const s = serve({ fetch: fetch as never, hostname: opts.host, port: opts.port }, () => resolve(s));
    s.once("error", reject);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : opts.port;
  return {
    port,
    db,
    publicHosts,
    createPairToken,
    backup,
    close: () => new Promise<void>((resolve) => server.close(() => { backup.stop(); db.close(); resolve(); })),
  };
}
