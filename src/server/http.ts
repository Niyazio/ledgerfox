/**
 * Runs LedgerFox on a PC: the same Hono app as the cloud Worker, backed by a local SQLite file, plus the built web UI.
 * Used by the desktop app (src/desktop) and the headless `ledgerfox-server` command.
 */
import { serve, type ServerType } from "@hono/node-server";
import type { IncomingMessage } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, normalize, sep } from "node:path";
import { mkdirSync } from "node:fs";
import app from "../worker/index";
import type { Env } from "../worker/env";
import { SqliteD1, asD1 } from "./sqlite-d1";
import { migrate } from "./migrate";

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
    // Only the first person can sign up; everyone else joins by invitation from inside the app.
    ALLOW_REGISTRATION: "first",
    ...opts.env,
  };
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

  const fetch = async (req: Request, bindings: { incoming: IncomingMessage }): Promise<Response> => {
    const url = new URL(req.url);
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
    close: () => new Promise<void>((resolve) => server.close(() => { db.close(); resolve(); })),
  };
}
