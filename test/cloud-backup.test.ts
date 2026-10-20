import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import app from "../src/worker/index";
import { makeEnv, register, Client } from "./helpers";
import { SqliteD1 } from "../src/server/sqlite-d1";
import { migrate } from "../src/server/migrate";
import { CloudBackup, decrypt, encrypt } from "../src/server/cloud-backup";
import type { Env } from "../src/worker/env";
import { randomBytes, scryptSync } from "node:crypto";

let env: Env;
let dir: string;
let desk: SqliteD1;
let email: string;
const CLOUD = "https://cloud.test";
const PASS = "correct horse battery";
const PHRASE = "my backup phrase";
// Route the desktop's HTTPS calls to the in-process cloud app.
const cloudFetch = async (url: string, init?: RequestInit) => app.request(url.replace(CLOUD, "https://ledgerfox.test"), init, env);

beforeAll(async () => {
  ({ env } = await makeEnv());
  ({ email } = await register(env, "Cloud Owner"));
  dir = mkdtempSync(join(tmpdir(), "lf-backup-"));
  desk = new SqliteD1(join(dir, "Shop.ledgerfox"));
  migrate(desk, join(import.meta.dirname, "..", "migrations"));
  desk.raw.exec(`INSERT INTO users (id, email, name, password_hash, password_salt, password_iters) VALUES ('u1', 'desk@example.com', 'Desk', 'h', 's', 1000)`);
});
afterAll(() => { desk.close(); rmSync(dir, { recursive: true, force: true }); });

describe("encrypted cloud backup", () => {
  it("encryption round-trips and rejects a wrong passphrase", () => {
    const salt = randomBytes(16);

    const key = scryptSync(PHRASE, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const blob = encrypt(Buffer.from("hello ledger"), key, salt);
    expect(decrypt(blob, PHRASE).toString()).toBe("hello ledger");
    expect(() => decrypt(blob, "wrong phrase")).toThrow(/Wrong passphrase/);
  });

  it("connects with a backup-only key, uploads, lists and restores the data file", async () => {
    const b = new CloudBackup(join(dir, "Shop.ledgerfox"), desk, cloudFetch);
    await expect(b.connect(email, "wrong password!", PHRASE, CLOUD)).rejects.toThrow(/Wrong LedgerFox Cloud/);
    await b.connect(email, PASS, PHRASE, CLOUD);
    expect(b.status()).toMatchObject({ connected: true, enabled: true });
    const r = await b.backupNow();
    expect(r.size).toBeGreaterThan(100);
    const list = await b.list();
    expect(list[0]).toMatchObject({ status: "complete" });
    // The server only holds ciphertext.
    const chunk = await env.DB.prepare("SELECT data FROM cloud_backup_chunks LIMIT 1").first<{ data: number[] | ArrayBuffer }>();
    expect(Buffer.from(chunk!.data as ArrayBuffer).subarray(0, 5).toString()).toBe("LFBK1");
    await expect(b.restore(list[0].id, "wrong phrase")).rejects.toThrow(/Wrong passphrase/);
    const restored = await b.restore(list[0].id, PHRASE);
    const db = new DatabaseSync(restored);
    expect((db.prepare("SELECT email FROM users").get() as { email: string }).email).toBe("desk@example.com");
    db.close();
    expect(b.status().lastBackupAt).toBeTruthy();
  });

  it("backups are private to their owner, and a revoked key stops working", async () => {
    const other = await register(env, "Someone else");
    const theirs = await other.client.get("/api/backups");
    expect(theirs.json.backups).toHaveLength(0);
    const owner = new Client(env);
    await owner.post("/api/auth/login", { login: email, password: PASS });
    const mine = await owner.get("/api/backups");
    const id = mine.json.backups[0].id;
    expect((await other.client.get(`/api/backups/${id}/chunks/0`)).status).toBe(404);
    // Keys cannot mint more keys.
    const b = new CloudBackup(join(dir, "Shop.ledgerfox"), desk, cloudFetch);
    const tokens = await owner.get("/api/backups/tokens");
    expect(tokens.json.tokens.length).toBeGreaterThan(0);
    for (const t of tokens.json.tokens) await owner.del(`/api/backups/tokens/${t.id}`);
    await expect(b.backupNow()).rejects.toThrow(/not valid any more/);
    expect(b.status().lastError).toMatch(/not valid/);
  });
});
