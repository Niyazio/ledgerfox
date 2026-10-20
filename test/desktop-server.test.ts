import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type RunningServer } from "../src/server/http";

let dir: string;
let srv: RunningServer;
let base: string;
const json = { "x-requested-with": "ledgerfox", "content-type": "application/json" };
const owner = { name: "Owner", email: "owner@example.com", password: "correct horse battery" };

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
    expect(names).toEqual(["0001_core.sql", "0002_business.sql", "0003_idempotency.sql"]);
    const me = await (await fetch(`${base}/api/auth/me`)).json();
    expect(me).toMatchObject({ user: null, edition: "desktop", registration: "open" });
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

  it("only the first person can register; others need an invitation", async () => {
    expect((await fetch(`${base}/api/auth/register`, { method: "POST", headers: json, body: JSON.stringify(owner) })).status).toBe(201);
    const second = await fetch(`${base}/api/auth/register`, { method: "POST", headers: json, body: JSON.stringify({ ...owner, email: "second@example.com" }) });
    expect(second.status).toBe(403);
    expect(((await (await fetch(`${base}/api/auth/me`)).json()) as { registration: string }).registration).toBe("closed");
  });

  it("internet link: accepts its public https origin with a Secure cookie, rejects unknown origins", async () => {
    const login = (origin: string) => fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { ...json, origin, "cf-connecting-ip": "203.0.113.9", "x-forwarded-proto": "https", host: "abc-def.trycloudflare.com" },
      body: JSON.stringify({ email: owner.email, password: owner.password }),
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

  it("data survives a restart (it is in the file, not in memory)", async () => {
    const file = join(dir, "data", "Test.ledgerfox");
    await srv.close();
    srv = await startServer({ dataFile: file, webDir: join(dir, "web"), migrationsDir: join(import.meta.dirname, "..", "migrations"), host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${srv.port}`;
    const n = srv.db.raw.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
    expect(n.n).toBe(1);
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
