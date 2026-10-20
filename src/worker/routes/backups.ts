/**
 * Encrypted cloud backups for desktop data files. The desktop app encrypts the file before upload (AES-256-GCM with a
 * key derived from a passphrase only the owner knows), so these routes store and return opaque bytes per user.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { all, batch, first, run, stmt } from "../lib/db";
import { AppError, badRequest, conflict, notFound } from "../lib/errors";
import { body } from "../lib/validate";
import { newId, randomToken, sha256Hex } from "../lib/crypto";
import { rateLimit, requireAuth, loadSessionUser } from "../lib/auth";
import type { MiddlewareHandler } from "hono";

export const CHUNK_BYTES = 512 * 1024;
const MAX_BACKUP_BYTES = 100 * 1024 * 1024;
const KEEP = 5;

const backups = new Hono<AppEnv>();

/** A signed-in session, or a desktop's backup key (Authorization: Bearer lfb_...) limited to these routes. */
const backupAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = c.req.header("authorization");
  if (auth?.startsWith("Bearer lfb_")) {
    const hash = await sha256Hex(auth.slice(7));
    const row = await first<{ id: string; user_id: string; email: string; name: string; username: string | null }>(c.env.DB,
      `SELECT t.id, t.user_id, u.email, u.name, u.username FROM api_tokens t JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = ? AND t.scope = 'backup' AND t.revoked_at IS NULL AND u.is_disabled = 0`, hash);
    if (!row) throw new AppError(401, "UNAUTHENTICATED", "This backup key is not valid any more. Connect the desktop again.");
    await run(c.env.DB, `UPDATE api_tokens SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`, row.id);
    c.set("user", { id: row.user_id, email: row.email, name: row.name, username: row.username, must_change_password: false, session_id: `token:${row.id}` });
    return next();
  }
  return requireAuth(c, next);
};
backups.use("*", backupAuth);

/** Issue a backup key for a desktop (requires a normal signed-in session, not another key). */
backups.post("/token", async (c) => {
  const session = await loadSessionUser(c);
  if (!session) throw new AppError(401, "UNAUTHENTICATED", "Sign in to create a backup key");
  const input = await body(c, z.object({ label: z.string().trim().min(1).max(120) }));
  const token = `lfb_${randomToken(32)}`;
  await run(c.env.DB, `INSERT INTO api_tokens (id, user_id, token_hash, scope, label) VALUES (?,?,?,'backup',?)`, newId(), session.id, await sha256Hex(token), input.label);
  return c.json({ token }, 201);
});

backups.get("/tokens", async (c) => {
  const rows = await all(c.env.DB, `SELECT id, label, created_at, last_used_at FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`, c.get("user").id);
  return c.json({ tokens: rows });
});

backups.delete("/tokens/:id", async (c) => {
  await run(c.env.DB, `UPDATE api_tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND user_id = ?`, c.req.param("id"), c.get("user").id);
  return c.json({ ok: true });
});

backups.get("/", async (c) => {
  const rows = await all(c.env.DB, `SELECT id, label, size_bytes, chunk_count, sha256, status, created_at FROM cloud_backups WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`, c.get("user").id);
  return c.json({ backups: rows, chunk_bytes: CHUNK_BYTES });
});

backups.post("/", async (c) => {
  const user = c.get("user");
  if (!(await rateLimit(c.env.DB, `backup:${user.id}`, 24, 86400))) throw new AppError(429, "RATE_LIMITED", "Too many backups today. Try again tomorrow.");
  const input = await body(c, z.object({
    label: z.string().trim().min(1).max(200),
    size_bytes: z.number().int().min(1).max(MAX_BACKUP_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }));
  const id = newId();
  const chunks = Math.ceil(input.size_bytes / CHUNK_BYTES);
  // Abandoned uploads older than a day are cleared before starting a new one.
  await batch(c.env.DB, [
    stmt(c.env.DB, `DELETE FROM cloud_backups WHERE user_id = ? AND status = 'uploading' AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')`, user.id),
    stmt(c.env.DB, `INSERT INTO cloud_backups (id, user_id, label, size_bytes, chunk_count, sha256) VALUES (?,?,?,?,?,?)`, id, user.id, input.label, input.size_bytes, chunks, input.sha256),
  ]);
  return c.json({ id, chunk_count: chunks, chunk_bytes: CHUNK_BYTES }, 201);
});

async function own(c: { env: AppEnv["Bindings"] }, userId: string, id: string) {
  const b = await first<{ id: string; status: string; chunk_count: number; size_bytes: number }>(c.env.DB, `SELECT id, status, chunk_count, size_bytes FROM cloud_backups WHERE id = ? AND user_id = ?`, id, userId);
  if (!b) throw notFound("Backup");
  return b;
}

backups.put("/:id/chunks/:idx", async (c) => {
  const b = await own(c, c.get("user").id, c.req.param("id"));
  if (b.status !== "uploading") throw conflict("COMPLETE", "This backup is already complete");
  const idx = Number(c.req.param("idx"));
  if (!Number.isInteger(idx) || idx < 0 || idx >= b.chunk_count) throw badRequest("Chunk index out of range");
  const data = new Uint8Array(await c.req.arrayBuffer());
  const expected = idx === b.chunk_count - 1 ? b.size_bytes - idx * CHUNK_BYTES : CHUNK_BYTES;
  if (data.byteLength !== expected) throw badRequest(`Chunk ${idx} must be ${expected} bytes`);
  await run(c.env.DB, `INSERT INTO cloud_backup_chunks (backup_id, idx, data) VALUES (?, ?, ?) ON CONFLICT (backup_id, idx) DO UPDATE SET data = excluded.data`, b.id, idx, data);
  return c.json({ ok: true });
});

backups.post("/:id/complete", async (c) => {
  const user = c.get("user");
  const b = await own(c, user.id, c.req.param("id"));
  const n = await first<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM cloud_backup_chunks WHERE backup_id = ?`, b.id);
  if ((n?.n ?? 0) !== b.chunk_count) throw conflict("INCOMPLETE", `Uploaded ${n?.n ?? 0} of ${b.chunk_count} parts`);
  await batch(c.env.DB, [
    stmt(c.env.DB, `UPDATE cloud_backups SET status = 'complete' WHERE id = ?`, b.id),
    // Keep the newest few complete backups per user (free-tier storage).
    stmt(c.env.DB, `DELETE FROM cloud_backups WHERE user_id = ? AND status = 'complete' AND id NOT IN (
      SELECT id FROM cloud_backups WHERE user_id = ? AND status = 'complete' ORDER BY created_at DESC LIMIT ${KEEP})`, user.id, user.id),
  ]);
  return c.json({ ok: true });
});

backups.get("/:id/chunks/:idx", async (c) => {
  const b = await own(c, c.get("user").id, c.req.param("id"));
  const row = await first<{ data: ArrayBuffer | number[] }>(c.env.DB, `SELECT data FROM cloud_backup_chunks WHERE backup_id = ? AND idx = ?`, b.id, Number(c.req.param("idx")));
  if (!row) throw notFound("Backup part");
  const bytes = row.data instanceof ArrayBuffer ? new Uint8Array(row.data) : new Uint8Array(row.data);
  return new Response(bytes, { headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" } });
});

backups.delete("/:id", async (c) => {
  const b = await own(c, c.get("user").id, c.req.param("id"));
  await run(c.env.DB, `DELETE FROM cloud_backups WHERE id = ?`, b.id);
  return c.json({ ok: true });
});

export default backups;
