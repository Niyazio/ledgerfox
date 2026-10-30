import { Miniflare } from "miniflare";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import app from "../src/worker/index";
import type { Env } from "../src/worker/env";

/** Split a migration file into statements, keeping CREATE TRIGGER … END; blocks intact. */
export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inTrigger = false;
  for (const raw of sql.split("\n")) {
    const line = raw.replace(/--.*$/, "");
    if (!line.trim()) continue;
    if (!buf && /^\s*CREATE\s+TRIGGER/i.test(line)) inTrigger = true;
    buf += line + "\n";
    const t = buf.trim();
    if (t.endsWith(";") && (!inTrigger || /\bEND;\s*$/i.test(t))) {
      if (!/^PRAGMA/i.test(t)) out.push(t);
      buf = "";
      inTrigger = false;
    }
  }
  return out;
}

export async function makeEnv(): Promise<{ env: Env; mf: Miniflare }> {
  if (process.env.LEDGERFOX_TEST_DB === "sqlite") {
    // Desktop engine: the same suite against Node's SQLite through the D1 facade.
    const { SqliteD1, asD1 } = await import("../src/server/sqlite-d1");
    const { migrate } = await import("../src/server/migrate");
    const db = new SqliteD1(":memory:");
    migrate(db, join(import.meta.dirname, "..", "migrations"));
    return { env: { DB: asD1(db), PBKDF2_ITERATIONS: "1000", BRAND_NAME: "LedgerFox", APP_ENV: "test" }, mf: { dispose: async () => db.close() } as unknown as Miniflare };
  }
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: `test-${Math.random().toString(36).slice(2)}` },
  });
  const db = (await mf.getD1Database("DB")) as unknown as D1Database;
  const dir = join(import.meta.dirname, "..", "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    const stmts = splitSql(readFileSync(join(dir, f), "utf8"));
    await db.batch(stmts.map((s) => db.prepare(s)));
  }
  return { env: { DB: db, PBKDF2_ITERATIONS: "1000", BRAND_NAME: "LedgerFox", APP_ENV: "test" }, mf };
}

export class Client {
  cookie = "";
  ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  constructor(private env: Env, public base = "http://localhost") {}

  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { "x-requested-with": "ledgerfox", "cf-connecting-ip": this.ip, ...headers };
    if (this.cookie) h.cookie = this.cookie;
    let payload: BodyInit | undefined;
    if (body instanceof Uint8Array) payload = body as unknown as BodyInit;
    else if (body !== undefined) { h["content-type"] = "application/json"; payload = JSON.stringify(body); }
    const res = await app.request(`${this.base}${path}`, { method, headers: h, body: payload }, this.env);
    const sc = res.headers.get("set-cookie");
    if (sc) {
      const m = /^([^=]+)=([^;]*)/.exec(sc);
      if (m) this.cookie = m[2] ? `${m[1]}=${m[2]}` : "";
    }
    const text = await res.text();
    let json: any;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, json, headers: res.headers };
  }
  get(p: string) { return this.req("GET", p); }
  post(p: string, b?: unknown) { return this.req("POST", p, b ?? {}); }
  put(p: string, b?: unknown) { return this.req("PUT", p, b ?? {}); }
  patch(p: string, b?: unknown) { return this.req("PATCH", p, b ?? {}); }
  del(p: string) { return this.req("DELETE", p); }
}

export interface World {
  env: Env;
  mf: Miniflare;
  owner: Client;
  companyId: string;
  orgId: string;
  acc: Record<string, string>;      // system_key / code → id
  tax: Record<string, string>;      // tax code name → id
  c: (p: string) => string;          // company-scoped path
}

let seq = 0;
export async function register(env: Env, name = "Owner") {
  const client = new Client(env);
  const email = `user${++seq}-${Math.random().toString(36).slice(2, 7)}@example.com`;
  const r = await client.post("/api/auth/register", { name, email, password: "correct horse battery", accept_terms: true });
  if (r.status !== 201) throw new Error(`register failed ${r.status} ${JSON.stringify(r.json)}`);
  return { client, email, recovery: r.json.recovery_codes as string[] };
}

export async function world(opts: { country?: string; currency?: string; state?: string | null; roundOff?: boolean } = {}): Promise<World> {
  const { env, mf } = await makeEnv();
  const { client } = await register(env);
  const country = opts.country ?? "IN";
  const r = await client.post("/api/orgs", {
    name: "Test Org",
    company: {
      name: "Acme Traders", country, base_currency: opts.currency ?? (country === "IN" ? "INR" : "USD"),
      fiscal_year_start_month: 4, state_code: opts.state === undefined ? (country === "IN" ? "29" : null) : opts.state,
    },
  });
  if (r.status !== 201) throw new Error(`org create failed ${JSON.stringify(r.json)}`);
  const companyId = r.json.company_id;
  const c = (p: string) => `/api/c/${companyId}${p}`;
  const accs = await client.get(c("/accounts"));
  const acc: Record<string, string> = {};
  for (const a of accs.json.accounts) { if (a.system_key) acc[a.system_key] = a.id; acc[a.code] = a.id; }
  const s = await client.get(c("/settings"));
  const tax: Record<string, string> = {};
  for (const t of s.json.tax_codes) tax[t.name] = t.id;
  if (opts.roundOff) await client.patch(c("/settings"), { name: "Acme Traders", round_off_invoices: true, state_code: "29" });
  // A fiscal year covering 2026-04-01 .. 2027-03-31 is created automatically (today's FY); add the previous one for dated tests.
  await client.post(c("/settings/fiscal-years"), { name: "FY 2025-26", start_date: "2025-04-01", end_date: "2026-03-31" });
  return { env, mf, owner: client, companyId, orgId: r.json.org_id, acc, tax, c };
}

export async function contact(w: World, kind: "customer" | "supplier", extra: Record<string, unknown> = {}) {
  const r = await w.owner.post(w.c("/contacts"), { kind, name: `${kind} ${Math.random().toString(36).slice(2, 6)}`, payment_terms_days: 30, ...extra });
  if (r.status !== 201) throw new Error(JSON.stringify(r.json));
  return r.json.id as string;
}

export async function rawQuery<T = any>(w: World, sql: string, ...params: unknown[]): Promise<T[]> {
  const r = await w.env.DB.prepare(sql).bind(...params).all<T>();
  return r.results;
}
