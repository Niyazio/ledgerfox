import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { AppEnv, CompanyRow, SessionUser } from "../env";
import { first, run, stmt } from "./db";
import { AppError, forbidden, notFound, unauthorized } from "./errors";
import { randomToken, sha256Hex, newId } from "./crypto";
import { can, type Permission, type Role } from "@shared/permissions";

export const SESSION_DAYS = 14;

export function cookieName(c: Context<AppEnv>): string {
  // __Host- prefix requires Secure; plain name in local http development/tests.
  return isSecure(c) ? "__Host-ledgerfox_sid" : "ledgerfox_sid";
}

function isSecure(c: Context<AppEnv>): boolean {
  return new URL(c.req.url).protocol === "https:";
}

export async function createSession(c: Context<AppEnv>, userId: string): Promise<string> {
  const token = randomToken(32);
  const id = await sha256Hex(token);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  await run(
    c.env.DB,
    `INSERT INTO sessions (id, user_id, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?)`,
    id, userId, expires, clientIp(c), (c.req.header("user-agent") ?? "").slice(0, 200),
  );
  setCookie(c, cookieName(c), token, {
    httpOnly: true,
    secure: isSecure(c),
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_DAYS * 86400,
  });
  return token;
}

export async function destroySession(c: Context<AppEnv>) {
  const token = getCookie(c, cookieName(c));
  if (token) await run(c.env.DB, `DELETE FROM sessions WHERE id = ?`, await sha256Hex(token));
  deleteCookie(c, cookieName(c), { path: "/", secure: isSecure(c) });
}

export async function loadSessionUser(c: Context<AppEnv>): Promise<SessionUser | null> {
  const token = getCookie(c, cookieName(c));
  if (!token || token.length > 200) return null;
  const sid = await sha256Hex(token);
  const row = await first<{ id: string; email: string; name: string; username: string | null; must_change_password: number; expires_at: string; is_disabled: number }>(
    c.env.DB,
    `SELECT u.id, u.email, u.name, u.username, u.must_change_password, s.expires_at, u.is_disabled FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    sid,
  );
  if (!row || row.is_disabled || row.expires_at < new Date().toISOString()) return null;
  return { id: row.id, email: row.email, name: row.name, username: row.username, must_change_password: Boolean(row.must_change_password), session_id: sid };
}

/** Signed-in user required; accounts still on a temporary/default password may only change it. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await loadSessionUser(c);
  if (!user) throw unauthorized();
  if (user.must_change_password) throw new AppError(403, "PASSWORD_CHANGE_REQUIRED", "Set a new password before continuing");
  c.set("user", user);
  await next();
};

/** Like requireAuth but lets a user with a temporary password through (for changing it). */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await loadSessionUser(c);
  if (!user) throw unauthorized();
  c.set("user", user);
  await next();
};

export function isLocalRequest(c: Context<AppEnv>): boolean {
  const ip = clientIp(c);
  return ip === "127.0.0.1" || ip === "::1";
}

/**
 * Tenant scoping: resolves :companyId and the caller's role via organisation membership.
 * Non-members get 404 (not 403) so company IDs cannot be probed.
 */
export const requireCompany: MiddlewareHandler<AppEnv> = async (c, next) => {
  const companyId = c.req.param("companyId");
  const user = c.get("user");
  if (!companyId) throw notFound("Company");
  const row = await first<CompanyRow & { role: Role }>(
    c.env.DB,
    `SELECT co.*, m.role FROM companies co JOIN memberships m ON m.org_id = co.org_id AND m.user_id = ? WHERE co.id = ?`,
    user.id, companyId,
  );
  if (!row) throw notFound("Company");
  const { role, ...company } = row;
  c.set("company", company as CompanyRow);
  c.set("role", role);
  await next();
};

export function requirePerm(c: Context<AppEnv>, perm: Permission) {
  if (!can(c.get("role"), perm)) throw forbidden();
}

export function clientIp(c: Context<AppEnv>): string {
  return c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

/** Fixed-window rate limiter backed by D1. Returns false when the limit is exceeded. */
export async function rateLimit(db: D1Database, key: string, limit: number, windowSec: number): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % windowSec);
  const row = await first<{ count: number }>(
    db,
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN window_start = excluded.window_start THEN count + 1 ELSE 1 END,
       window_start = excluded.window_start
     RETURNING count`,
    key, windowStart,
  );
  return (row?.count ?? 1) <= limit;
}

export function audit(
  c: Context<AppEnv>,
  action: string,
  entityType: string | null,
  entityId: string | null,
  details?: unknown,
  scope?: { orgId: string; companyId: string | null },
): D1PreparedStatement {
  const company = c.get("company") as CompanyRow | undefined;
  const orgId = scope?.orgId ?? company?.org_id;
  if (!orgId) throw new AppError(500, "AUDIT_SCOPE", "Audit scope missing");
  const user = c.get("user") as SessionUser | undefined;
  return stmt(
    c.env.DB,
    `INSERT INTO audit_logs (id, org_id, company_id, user_id, action, entity_type, entity_id, details, ip) VALUES (?,?,?,?,?,?,?,?,?)`,
    newId(), orgId, scope ? scope.companyId : company?.id ?? null, user?.id ?? null, action, entityType, entityId,
    details === undefined ? null : JSON.stringify(details).slice(0, 4000), clientIp(c),
  );
}
