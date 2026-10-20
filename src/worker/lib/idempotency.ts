import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";
import { AppError } from "./errors";

const KEY_RE = /^[A-Za-z0-9_.:-]{8,100}$/;
/** An in-flight marker older than this is assumed abandoned (worker killed mid-request) and may be retried. */
const STALE_MS = 2 * 60_000;
const RETAIN_MS = 7 * 24 * 3600_000;

/**
 * Company-scoped POSTs with an `Idempotency-Key` header run at most once per user: a successful response is stored and
 * replayed verbatim for repeats. Failed requests (non-2xx) release the key so the client can correct and retry.
 * Must run after requireAuth/requireCompany.
 */
export const idempotency: MiddlewareHandler<AppEnv> = async (c, next) => {
  const key = c.req.header("idempotency-key");
  if (c.req.method !== "POST" || !key) return next();
  if (!KEY_RE.test(key)) throw new AppError(400, "BAD_IDEMPOTENCY_KEY", "Invalid Idempotency-Key header");
  const db = c.env.DB;
  const companyId = c.get("company").id;
  const userId = c.get("user").id;
  const path = new URL(c.req.url).pathname;
  const now = Date.now();

  const existing = await db
    .prepare("SELECT path, status, response, created_at FROM idempotency_keys WHERE company_id = ? AND user_id = ? AND key = ?")
    .bind(companyId, userId, key)
    .first<{ path: string; status: number | null; response: string | null; created_at: number }>();
  if (existing) {
    if (existing.path !== path) throw new AppError(422, "IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was already used for a different request");
    if (existing.status !== null) {
      return new Response(existing.response, { status: existing.status, headers: { "content-type": "application/json", "idempotent-replay": "true" } });
    }
    if (now - existing.created_at < STALE_MS) throw new AppError(409, "IN_PROGRESS", "This request is still being processed; try again shortly");
    await db.prepare("DELETE FROM idempotency_keys WHERE company_id = ? AND user_id = ? AND key = ? AND status IS NULL").bind(companyId, userId, key).run();
  }

  const claimed = await db
    .prepare("INSERT INTO idempotency_keys (company_id, user_id, key, method, path, created_at) VALUES (?, ?, ?, 'POST', ?, ?) ON CONFLICT DO NOTHING")
    .bind(companyId, userId, key, path, now)
    .run();
  if (!claimed.meta.changes) throw new AppError(409, "IN_PROGRESS", "This request is still being processed; try again shortly");

  try {
    await next();
  } catch (e) {
    await release(db, companyId, userId, key);
    throw e;
  }
  const res = c.res;
  if (res.status >= 200 && res.status < 300) {
    const body = await res.clone().text();
    await db.prepare("UPDATE idempotency_keys SET status = ?, response = ? WHERE company_id = ? AND user_id = ? AND key = ?")
      .bind(res.status, body, companyId, userId, key).run();
  } else {
    await release(db, companyId, userId, key);
  }
  // Opportunistic housekeeping (~1% of keyed requests) keeps the table small without a cron.
  if (Math.random() < 0.01) await db.prepare("DELETE FROM idempotency_keys WHERE created_at < ?").bind(now - RETAIN_MS).run();
};

function release(db: D1Database, companyId: string, userId: string, key: string) {
  return db.prepare("DELETE FROM idempotency_keys WHERE company_id = ? AND user_id = ? AND key = ? AND status IS NULL").bind(companyId, userId, key).run();
}
