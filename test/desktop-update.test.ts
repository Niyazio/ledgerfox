import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type RunningServer, type UpdateState } from "../src/server/http";
import { isNewer } from "../src/web/lib/updates";

let dir: string, srv: RunningServer, base: string, cookie = "";
const json = { "x-requested-with": "ledgerfox", "content-type": "application/json" };
const state: UpdateState = { current: "0.3.0", latest: null, status: "idle", progress: null, notes: null, manual_download: null, checked_at: null };
let installs = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lf-upd-"));
  const web = join(dir, "web");
  mkdirSync(web, { recursive: true });
  writeFileSync(join(web, "index.html"), "<!doctype html><title>LedgerFox</title>");
  srv = await startServer({
    dataFile: join(dir, "d.ledgerfox"), webDir: web, migrationsDir: join(import.meta.dirname, "..", "migrations"), host: "127.0.0.1", port: 0, env: { PBKDF2_ITERATIONS: "1000" },
    updater: {
      status: () => ({ ...state }),
      check: async () => Object.assign(state, { status: "ready", latest: "0.4.0", progress: 100, notes: "Excel downloads", checked_at: "2026-10-27T10:00:00Z" }),
      install: () => { installs++; },
    },
  });
  base = `http://127.0.0.1:${srv.port}`;
  const me = (await (await fetch(`${base}/api/auth/me`)).json()) as { first_run: { password: string } };
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: json, body: JSON.stringify({ login: "admin", password: me.first_run.password }) });
  cookie = login.headers.get("set-cookie")!.split(";")[0];
  await fetch(`${base}/api/auth/change-password`, { method: "POST", headers: { ...json, cookie }, body: JSON.stringify({ current_password: me.first_run.password, new_password: "correct horse battery" }) });
  await fetch(`${base}/api/orgs`, { method: "POST", headers: { ...json, cookie }, body: JSON.stringify({ name: "Shop", company: { name: "Shop", country: "IN", base_currency: "INR", fiscal_year_start_month: 4, state_code: "29" } }) });
});

afterAll(async () => { await srv?.close(); rmSync(dir, { recursive: true, force: true }); });

describe("in-app updates (desktop)", () => {
  it("shows the version to anyone, but only the owner at this computer can check and install", async () => {
    const anon = await (await fetch(`${base}/api/desktop/update`)).json();
    expect(anon).toMatchObject({ available: true, can_install: false, current: "0.3.0", status: "idle" });
    expect((await fetch(`${base}/api/desktop/update/check`, { method: "POST", headers: json })).status).toBe(403);
    // From another device on the network: refused even with the owner's session.
    expect((await fetch(`${base}/api/desktop/update/check`, { method: "POST", headers: { ...json, cookie, "cf-connecting-ip": "203.0.113.9" } })).status).toBe(403);
    expect((await fetch(`${base}/api/desktop/update/check`, { method: "POST", headers: { cookie } })).status).toBe(403); // no CSRF header
    const checked = await (await fetch(`${base}/api/desktop/update/check`, { method: "POST", headers: { ...json, cookie } })).json();
    expect(checked).toMatchObject({ can_install: true, status: "ready", latest: "0.4.0", notes: "Excel downloads" });
    expect((await (await fetch(`${base}/api/desktop/update`, { headers: { cookie } })).json())).toMatchObject({ can_install: true, status: "ready" });
    expect((await fetch(`${base}/api/desktop/update/install`, { method: "POST", headers: { ...json, cookie } })).status).toBe(200);
    expect(installs).toBe(1);
  });

  it("compares versions numerically", () => {
    expect(isNewer("v0.10.0", "0.9.9")).toBe(true);
    expect(isNewer("0.3.0", "0.3.0")).toBe(false);
    expect(isNewer("0.3.1", "0.4.0")).toBe(false);
    expect(isNewer("1.0.0", "0.99.1")).toBe(true);
  });
});
