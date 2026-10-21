import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type RunningServer } from "../src/server/http";

let dir: string;
let srv: RunningServer;
let base: string;
const json = { "x-requested-with": "ledgerfox", "content-type": "application/json" };
const owner = { password: "correct horse battery" };
let cookie = "";
let orgId = "";
let firstPassword = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lf-desktop-"));
  const web = join(dir, "web");
  mkdirSync(join(web, "assets"), { recursive: true });
  writeFileSync(join(web, "index.html"), "<!doctype html><title>LedgerFox</title>");
  writeFileSync(join(web, "assets", "app.js"), "console.log(1)");
  writeFileSync(join(dir, "secret.txt"), "do not serve");
  srv = await startServer({ dataFile: join(dir, "data", "Test.ledgerfox"), webDir: web, migrationsDir: join(import.meta.dirname, "..", "migrations"), host: "127.0.0.1", port: 0, env: { PBKDF2_ITERATIONS: "1000" } });
  base = `http://127.0.0.1:${srv.port}`;
});

afterAll(async () => {
  await srv?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("desktop server", () => {
  it("creates the data file, applies migrations and reports the desktop edition", async () => {
    const names = (srv.db.raw.prepare("SELECT name FROM d1_migrations ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    expect(names.slice(0, 4)).toEqual(["0001_core.sql", "0002_business.sql", "0003_idempotency.sql", "0004_business_types_payroll.sql"]);
    const me = await (await fetch(`${base}/api/auth/me`)).json();
    expect(me).toMatchObject({ user: null, edition: "desktop", registration: "closed", default_login: true });
    firstPassword = (me as { first_run: { username: string; password: string } }).first_run.password;
    expect(firstPassword).toMatch(/^[A-Za-z2-9]{5}-[A-Za-z2-9]{5}-[A-Za-z2-9]{5}$/);
    expect(firstPassword).not.toBe("admin");
    // Requests from another device never see it.
    const remoteMe = await (await fetch(`${base}/api/auth/me`, { headers: { "cf-connecting-ip": "203.0.113.9" } })).json();
    expect((remoteMe as { first_run: unknown }).first_run).toBeNull();
  });

  it("serves the UI with SPA fallback, security headers, and nothing outside the web folder", async () => {
    const page = await fetch(`${base}/app/anything`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<title>LedgerFox</title>");
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect((await fetch(`${base}/assets/app.js`)).headers.get("cache-control")).toContain("immutable");
    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
    expect(await (await fetch(`${base}/..%2Fsecret.txt`)).text()).not.toContain("do not serve");
    expect(await (await fetch(`${base}/%2e%2e/secret.txt`)).text()).not.toContain("do not serve");
  });

  it("starts with a random one-time admin password that works only on this computer and must be changed first", async () => {
    expect((await fetch(`${base}/api/auth/register`, { method: "POST", headers: json, body: JSON.stringify({ name: "X", email: "x@example.com", password: "whatever123" }) })).status).toBe(403);
    // Over the internet link (or network) the default password is refused.
    const remote = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { ...json, "cf-connecting-ip": "203.0.113.9" }, body: JSON.stringify({ login: "admin", password: firstPassword }) });
    expect(remote.status).toBe(403);
    expect((await fetch(`${base}/api/auth/login`, { method: "POST", headers: json, body: JSON.stringify({ login: "admin", password: "admin" }) })).status).toBe(401);
    const local = await fetch(`${base}/api/auth/login`, { method: "POST", headers: json, body: JSON.stringify({ login: "admin", password: firstPassword }) });
    expect(local.status).toBe(200);
    expect(((await local.json()) as { must_change_password: boolean }).must_change_password).toBe(true);
    cookie = local.headers.get("set-cookie")!.split(";")[0];
    const blocked = await fetch(`${base}/api/orgs`, { method: "POST", headers: { ...json, cookie }, body: "{}" });
    expect(blocked.status).toBe(403);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe("PASSWORD_CHANGE_REQUIRED");
    const same = await fetch(`${base}/api/auth/change-password`, { method: "POST", headers: { ...json, cookie }, body: JSON.stringify({ current_password: firstPassword, new_password: firstPassword }) });
    expect(same.status).toBe(400);
    const changed = await fetch(`${base}/api/auth/change-password`, { method: "POST", headers: { ...json, cookie }, body: JSON.stringify({ current_password: firstPassword, new_password: owner.password }) });
    expect(changed.status).toBe(200);
    expect(((await (await fetch(`${base}/api/auth/me`)).json()) as { default_login: boolean }).default_login).toBe(false);
    const org = await fetch(`${base}/api/orgs`, { method: "POST", headers: { ...json, cookie }, body: JSON.stringify({ name: "Shop", company: { name: "Shop", country: "IN", base_currency: "INR", fiscal_year_start_month: 4, state_code: "29" } }) });
    expect(org.status).toBe(201);
    orgId = ((await org.json()) as { org_id: string }).org_id;
  });

  it("owner adds users Tally-style; the server generates a different one-time password for each", async () => {
    const r = await fetch(`${base}/api/orgs/${orgId}/users`, { method: "POST", headers: { ...json, cookie }, body: JSON.stringify({ name: "Cashier", username: "cashier1", role: "billing" }) });
    expect(r.status).toBe(201);
    const temp = ((await r.json()) as { temporary_password: string }).temporary_password;
    const dup = await fetch(`${base}/api/orgs/${orgId}/users`, { method: "POST", headers: { ...json, cookie }, body: JSON.stringify({ name: "Again", username: "CASHIER1", role: "viewer" }) });
    expect(dup.status).toBe(409);
    const other = await fetch(`${base}/api/orgs/${orgId}/users`, { method: "POST", headers: { ...json, cookie }, body: JSON.stringify({ name: "Store", username: "store1", role: "inventory" }) });
    expect(((await other.json()) as { temporary_password: string }).temporary_password).not.toBe(temp);
    const stored = srv.db.raw.prepare("SELECT password_hash FROM users WHERE username = 'cashier1'").get() as { password_hash: string };
    expect(stored.password_hash).not.toContain(temp);
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: json, body: JSON.stringify({ login: "Cashier1", password: temp }) });
    expect(login.status).toBe(200);
    expect(((await login.json()) as { must_change_password: boolean }).must_change_password).toBe(true);
  });

  it("internet link: accepts its public https origin with a Secure cookie, rejects unknown origins", async () => {
    const login = (origin: string) => fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { ...json, origin, "cf-connecting-ip": "203.0.113.9", "x-forwarded-proto": "https", host: "abc-def.trycloudflare.com" },
      body: JSON.stringify({ login: "admin", password: owner.password }),
    });
    expect((await login("https://abc-def.trycloudflare.com")).status).toBe(403);
    srv.publicHosts.add("abc-def.trycloudflare.com");
    const ok = await login("https://abc-def.trycloudflare.com");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toMatch(/^__Host-ledgerfox_sid=.*Secure/);
    expect((await login("https://evil.example")).status).toBe(403);
    const ips = (srv.db.raw.prepare("SELECT DISTINCT ip FROM sessions").all() as { ip: string }[]).map((r) => r.ip);
    expect(ips).toContain("203.0.113.9");
  });

  it("phone copy: one-time code returns the data file without sessions or secrets", async () => {
    const t = srv.createPairToken();
    const res = await fetch(`${base}/api/pair/${t}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 15))).toBe("SQLite format 3");
    const { DatabaseSync } = await import("node:sqlite");
    const { writeFileSync } = await import("node:fs");
    const f = join(dir, "phone.db");
    writeFileSync(f, bytes);
    const copy = new DatabaseSync(f);
    expect((copy.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n).toBe(0);
    expect((copy.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n).toBeGreaterThan(0);
    copy.close();
    expect((await fetch(`${base}/api/pair/${t}`)).status).toBe(404);
    expect((await fetch(`${base}/api/pair/aaaaaaaaaaaaaaaaaaaaaaaa`)).status).toBe(404);
  });

  it("cloud backup controls are for an owner/admin on this computer only", async () => {
    expect((await fetch(`${base}/api/desktop/backup/status`)).status).toBe(403);
    expect((await fetch(`${base}/api/desktop/backup/status`, { headers: { cookie, "cf-connecting-ip": "203.0.113.9" } })).status).toBe(403);
    const ok = await fetch(`${base}/api/desktop/backup/status`, { headers: { cookie } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ connected: false });
    expect((await fetch(`${base}/api/desktop/backup/run`, { method: "POST", headers: { cookie } })).status).toBe(403);
  });

  it("data survives a restart (it is in the file, not in memory)", async () => {
    const file = join(dir, "data", "Test.ledgerfox");
    await srv.close();
    srv = await startServer({ dataFile: file, webDir: join(dir, "web"), migrationsDir: join(import.meta.dirname, "..", "migrations"), host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${srv.port}`;
    const n = srv.db.raw.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
    expect(n.n).toBe(3);
  });
});

describe("download links", () => {
  it("are hidden until a GitHub repo is configured, then point at the latest release assets", async () => {
    const { default: app } = await import("../src/worker/index");
    const none = await (await app.request("http://x/api/downloads", {}, { DB: srv.db as never })).json() as { available: boolean };
    expect(none.available).toBe(false);
    const set = await (await app.request("http://x/api/downloads", {}, { DB: srv.db as never, GITHUB_REPO: "acme/ledgerfox" })).json() as { files: Record<string, string> };
    expect(set.files.windows).toBe("https://github.com/acme/ledgerfox/releases/latest/download/LedgerFox-Setup-x64.exe");
    expect(set.files.mac_arm64).toBe("https://github.com/acme/ledgerfox/releases/latest/download/LedgerFox-mac-arm64.dmg");
    const bad = await (await app.request("http://x/api/downloads", {}, { DB: srv.db as never, GITHUB_REPO: "evil.com/x/y" })).json() as { available: boolean };
    expect(bad.available).toBe(false);
  });
});
