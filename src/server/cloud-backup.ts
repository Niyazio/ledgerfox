/**
 * Automatic encrypted cloud backup for a desktop data file.
 * The file is compressed and encrypted here (AES-256-GCM, key = scrypt(passphrase, random salt)), then uploaded in
 * parts to the owner's LedgerFox Cloud account. The server never sees the passphrase or the data.
 * Settings live next to the data file in "<file>.cloud.json" (owner-only permissions).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import type { SqliteD1 } from "./sqlite-d1";

const MAGIC = Buffer.from("LFBK1");
export const DEFAULT_CLOUD = process.env.LEDGERFOX_CLOUD_URL ?? "https://ledgerfox.niyazio.com";

interface Settings { cloudUrl: string; token: string; user: string; salt: string; key: string; enabled: boolean; lastBackupAt?: string; lastError?: string }
export interface BackupStatus { connected: boolean; user?: string; cloudUrl?: string; enabled?: boolean; lastBackupAt?: string; lastError?: string }

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const deriveKey = (passphrase: string, salt: Buffer) => scryptSync(passphrase.normalize("NFKC"), salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

export function encrypt(plain: Buffer, key: Buffer, salt: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, body, c.getAuthTag()]);
}

export function decrypt(blob: Buffer, passphrase: string): Buffer {
  if (!blob.subarray(0, 5).equals(MAGIC)) throw new Error("Not a LedgerFox backup");
  const salt = blob.subarray(5, 21), iv = blob.subarray(21, 33), tag = blob.subarray(blob.length - 16), body = blob.subarray(33, blob.length - 16);
  const d = createDecipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  d.setAuthTag(tag);
  try { return Buffer.concat([d.update(body), d.final()]); } catch { throw new Error("Wrong passphrase, or the backup is damaged"); }
}

export class CloudBackup {
  private settings: Settings | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  constructor(private dataFile: string, private db: SqliteD1, private fetchImpl: Fetch = fetch) {
    try { this.settings = JSON.parse(readFileSync(this.path, "utf8")); } catch { this.settings = null; }
  }
  private get path() { return `${this.dataFile}.cloud.json`; }
  private save() {
    writeFileSync(this.path, JSON.stringify(this.settings, null, 2));
    try { chmodSync(this.path, 0o600); } catch { /* not supported on this filesystem */ }
  }

  status(): BackupStatus {
    const s = this.settings;
    return s ? { connected: true, user: s.user, cloudUrl: s.cloudUrl, enabled: s.enabled, lastBackupAt: s.lastBackupAt, lastError: s.lastError } : { connected: false };
  }

  private async call(path: string, init: RequestInit = {}, token = this.settings?.token): Promise<Response> {
    const base = this.settings?.cloudUrl ?? DEFAULT_CLOUD;
    const headers = new Headers(init.headers);
    headers.set("x-requested-with", "ledgerfox");
    if (token) headers.set("authorization", `Bearer ${token}`);
    const res = await this.fetchImpl(`${base}${path}`, { ...init, headers });
    if (!res.ok) {
      let msg = `LedgerFox Cloud answered ${res.status}`;
      try { msg = ((await res.json()) as { error?: { message?: string } }).error?.message ?? msg; } catch { /* not JSON */ }
      throw new Error(msg);
    }
    return res;
  }

  /** Sign in to LedgerFox Cloud once, obtain a backup-only key, and remember the encryption key derived from the passphrase. */
  async connect(login: string, password: string, passphrase: string, cloudUrl = DEFAULT_CLOUD) {
    if (passphrase.length < 8) throw new Error("Use a backup passphrase of at least 8 characters");
    this.settings = null;
    const res = await this.fetchImpl(`${cloudUrl}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json", "x-requested-with": "ledgerfox" }, body: JSON.stringify({ login, password }) });
    if (!res.ok) throw new Error(res.status === 401 ? "Wrong LedgerFox Cloud username or password" : `LedgerFox Cloud sign-in failed (${res.status})`);
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
    if (!cookie) throw new Error("LedgerFox Cloud did not return a session");
    const tok = await this.fetchImpl(`${cloudUrl}/api/backups/token`, { method: "POST", headers: { "content-type": "application/json", "x-requested-with": "ledgerfox", cookie }, body: JSON.stringify({ label: `Desktop backup · ${basename(this.dataFile)}` }) });
    if (!tok.ok) throw new Error(`Could not create a backup key (${tok.status})`);
    const { token } = (await tok.json()) as { token: string };
    await this.fetchImpl(`${cloudUrl}/api/auth/logout`, { method: "POST", headers: { "x-requested-with": "ledgerfox", cookie } }).catch(() => undefined);
    const salt = randomBytes(16);
    this.settings = { cloudUrl, token, user: login, salt: salt.toString("base64"), key: deriveKey(passphrase, salt).toString("base64"), enabled: true };
    this.save();
  }

  disconnect() {
    this.settings = null;
    if (existsSync(this.path)) writeFileSync(this.path, "null");
  }

  setEnabled(on: boolean) {
    if (!this.settings) return;
    this.settings.enabled = on;
    this.save();
  }

  /** Snapshot → gzip → encrypt → upload in parts → mark complete. */
  async backupNow(): Promise<{ id: string; size: number }> {
    const s = this.settings;
    if (!s) throw new Error("Cloud backup is not connected");
    if (this.running) throw new Error("A backup is already running");
    this.running = true;
    const tmp = join(tmpdir(), `ledgerfox-cloud-${randomBytes(6).toString("hex")}.db`);
    try {
      this.db.raw.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
      const copy = new DatabaseSync(tmp);
      for (const t of ["sessions", "rate_limits"]) { try { copy.exec(`DELETE FROM ${t}`); } catch { /* absent */ } }
      copy.exec("VACUUM");
      copy.close();
      const blob = encrypt(gzipSync(await readFile(tmp), { level: 9 }), Buffer.from(s.key, "base64"), Buffer.from(s.salt, "base64"));
      const sha256 = createHash("sha256").update(blob).digest("hex");
      const label = `${basename(this.dataFile)} · ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
      const created = (await (await this.call("/api/backups", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label, size_bytes: blob.length, sha256 }) })).json()) as { id: string; chunk_count: number; chunk_bytes: number };
      for (let i = 0; i < created.chunk_count; i++) {
        const part = blob.subarray(i * created.chunk_bytes, (i + 1) * created.chunk_bytes);
        let attempt = 0;
        for (;;) {
          try { await this.call(`/api/backups/${created.id}/chunks/${i}`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array(part) }); break; }
          catch (e) { if (++attempt >= 3) throw e; await new Promise((r) => setTimeout(r, 1000 * attempt)); }
        }
      }
      await this.call(`/api/backups/${created.id}/complete`, { method: "POST" });
      s.lastBackupAt = new Date().toISOString();
      s.lastError = undefined;
      this.save();
      return { id: created.id, size: blob.length };
    } catch (e) {
      s.lastError = (e as Error).message;
      this.save();
      throw e;
    } finally {
      this.running = false;
      await rm(tmp, { force: true });
    }
  }

  async list() {
    return ((await (await this.call("/api/backups")).json()) as { backups: { id: string; label: string; size_bytes: number; chunk_count: number; sha256: string; status: string; created_at: string }[] }).backups;
  }

  /** Download, verify, decrypt and write the backup as a new data file beside the current one. Returns its path. */
  async restore(id: string, passphrase: string): Promise<string> {
    const b = (await this.list()).find((x) => x.id === id && x.status === "complete");
    if (!b) throw new Error("Backup not found");
    const parts: Buffer[] = [];
    for (let i = 0; i < b.chunk_count; i++) parts.push(Buffer.from(await (await this.call(`/api/backups/${id}/chunks/${i}`)).arrayBuffer()));
    const blob = Buffer.concat(parts);
    if (createHash("sha256").update(blob).digest("hex") !== b.sha256) throw new Error("The downloaded backup is damaged (checksum mismatch)");
    const plain = gunzipSync(decrypt(blob, passphrase));
    if (plain.subarray(0, 15).toString() !== "SQLite format 3") throw new Error("The backup does not contain a LedgerFox data file");
    const stem = basename(this.dataFile).replace(/\.ledgerfox$/i, "");
    const target = join(dirname(this.dataFile), `${stem} (restored ${b.created_at.slice(0, 16).replace(/[T:]/g, "-")}).ledgerfox`);
    await writeFile(target, plain);
    return target;
  }

  /** Back up automatically once a day while connected and online; failures (e.g. offline) are retried hourly. */
  schedule() {
    if (this.timer) return;
    const tick = () => {
      const s = this.settings;
      if (!s?.enabled || this.running) return;
      if (s.lastBackupAt && Date.now() - Date.parse(s.lastBackupAt) < 24 * 3600_000) return;
      this.backupNow().catch(() => undefined);
    };
    this.timer = setInterval(tick, 3600_000);
    setTimeout(tick, 60_000);
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
