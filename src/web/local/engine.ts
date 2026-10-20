/**
 * Offline copy engine for the Android app: runs the same LedgerFox API (src/worker) inside the phone's WebView against
 * a read-only copy of the desktop data file, so every screen works without a network.
 */
import initSqlJs from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import { SqlJsD1 } from "./sqljs-d1";

let fetcher: ((req: Request) => Promise<Response>) | null = null;
let session = "";

const VIEW_ONLY = new Set(["/api/auth/login", "/api/auth/logout"]);

export async function startEngine(bytes: Uint8Array) {
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  const db = new SqlJsD1(new SQL.Database(bytes));
  const { default: app } = await import("../../worker/index");
  const env = { DB: db as unknown as D1Database, BRAND_NAME: "LedgerFox", APP_ENV: "offline", PBKDF2_ITERATIONS: "100000", ALLOW_REGISTRATION: "false" };
  try { session = sessionStorage.getItem("ledgerfox-offline-session") ?? ""; } catch { /* unavailable */ }
  fetcher = async (req: Request) => {
    const url = new URL(req.url);
    if (req.method !== "GET" && req.method !== "HEAD" && !VIEW_ONLY.has(url.pathname)) {
      return Response.json({ error: { code: "READ_ONLY", message: "This is a view-only copy saved on your phone. Make changes on the office computer." } }, { status: 403 });
    }
    const headers = new Headers(req.headers);
    if (session) headers.set("x-ledgerfox-session", session);
    headers.set("cf-connecting-ip", "127.0.0.1");
    const init: RequestInit = { method: req.method, headers };
    if (req.method !== "GET" && req.method !== "HEAD") init.body = await req.arrayBuffer();
    const res = await app.fetch(new Request(new URL(url.pathname + url.search, "http://offline.local"), init), env);
    const next = res.headers.get("x-ledgerfox-session");
    if (next !== null) {
      session = next;
      try { sessionStorage.setItem("ledgerfox-offline-session", session); } catch { /* unavailable */ }
    }
    return res;
  };
}

export function offlineFetch(path: string, init: RequestInit): Promise<Response> {
  if (!fetcher) return Promise.reject(new Error("Offline copy not loaded"));
  return fetcher(new Request(new URL(path, "http://offline.local"), init));
}
