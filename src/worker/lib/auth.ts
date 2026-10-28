import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { AppEnv, BranchScope, CompanyRow, SessionUser } from "../env";
import { all, first, run, stmt } from "./db";
import { AppError, forbidden, notFound, unauthorized } from "./errors";
import { randomToken, sha256Hex, newId } from "./crypto";
import { effectivePermissions, type Permission, type Role } from "@shared/permissions";

export const SESSION_DAYS = 14;

export function cookieName(c: Context<AppEnv>): string {
  // __Host- prefix requires Secure; plain name in local http development/tests.
  return isSecure(c) ? "__Host-ledgerfox_sid" : "ledgerfox_sid";
}

function isSecure(c: Context<AppEnv>): boolean {
  return new URL(c.req.url).protocol === "https:";
}

/**
 * The phone's offline copy runs this API inside the page, where browsers drop Set-Cookie on script-made responses;
 * there (and only there) the session token travels in a private header instead of a cookie.
 */
const offline = (c: Context<AppEnv>) => c.env.APP_ENV === "offline";
const SESSION_HEADER = "x-ledgerfox-session";
function sessionToken(c: Context<AppEnv>): string | undefined {
  return offline(c) ? c.req.header(SESSION_HEADER) : getCookie(c, cookieName(c));
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
  await run(c.env.DB, `UPDATE users SET last_login_at = ?, login_count = login_count + 1 WHERE id = ?`, new Date().toISOString(), userId);
  if (offline(c)) { c.header(SESSION_HEADER, token); return token; }
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
  const token = sessionToken(c);
  if (token) await run(c.env.DB, `DELETE FROM sessions WHERE id = ?`, await sha256Hex(token));
  if (offline(c)) { c.header(SESSION_HEADER, ""); return; }
  deleteCookie(c, cookieName(c), { path: "/", secure: isSecure(c) });
}

export async function loadSessionUser(c: Context<AppEnv>): Promise<SessionUser | null> {
  const token = sessionToken(c);
  if (!token || token.length > 200) return null;
  const sid = await sha256Hex(token);
  const row = await first<{ id: string; email: string; name: string; username: string | null; must_change_password: number; expires_at: string; is_disabled: number; totp_enabled: number }>(
    c.env.DB,
    `SELECT u.id, u.email, u.name, u.username, u.must_change_password, s.expires_at, u.is_disabled, u.totp_enabled FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    sid,
  );
  if (!row || row.is_disabled || row.expires_at < new Date().toISOString()) return null;
  return { id: row.id, email: row.email, name: row.name, username: row.username, must_change_password: Boolean(row.must_change_password), totp_enabled: Boolean(row.totp_enabled), session_id: sid };
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
  const row = await first<CompanyRow & { role: Role; all_branches: number; require_2fa: number }>(
    c.env.DB,
    `SELECT co.*, m.role, m.all_branches, o.require_2fa FROM companies co JOIN memberships m ON m.org_id = co.org_id AND m.user_id = ? JOIN organisations o ON o.id = co.org_id WHERE co.id = ?`,
    user.id, companyId,
  );
  if (!row) throw notFound("Company");
  const { role, all_branches, require_2fa, ...company } = row;
  // The owner can require two-factor sign-in for everyone; members without it are sent to set it up.
  if (require_2fa && !user.totp_enabled) throw new AppError(403, "TWO_FACTOR_REQUIRED", "Your organisation requires two-factor sign-in. Set it up under Settings → My account.");
  c.set("company", company as CompanyRow);
  c.set("role", role);
  c.set("perms", await orgPermissions(c.env.DB, company.org_id, role));
  c.set("branches", await branchScope(c.env.DB, company.org_id, company.id, user.id, role, Boolean(all_branches)));
  await next();
};

/** Role defaults with the organisation's customisations applied (Owner is never reduced). */
export async function orgPermissions(db: D1Database, orgId: string, role: Role): Promise<Permission[]> {
  if (role === "owner") return effectivePermissions(role);
  const overrides = await all<{ permission: string; allowed: number }>(db, `SELECT permission, allowed FROM role_permissions WHERE org_id = ? AND role = ?`, orgId, role);
  return effectivePermissions(role, overrides);
}

/** Owners always see every branch; others see every branch or only their assigned ones. */
export async function branchScope(db: D1Database, orgId: string, companyId: string, userId: string, role: Role, allBranches: boolean): Promise<BranchScope> {
  if (role === "owner" || allBranches) return { all: true, ids: [] };
  const rows = await all<{ branch_id: string }>(db, `SELECT branch_id FROM member_branches WHERE org_id = ? AND user_id = ? AND company_id = ?`, orgId, userId, companyId);
  return { all: false, ids: rows.map((r) => r.branch_id) };
}

export function hasPerm(c: Context<AppEnv>, perm: Permission): boolean {
  return (c.get("perms") ?? []).includes(perm);
}

export function requirePerm(c: Context<AppEnv>, perm: Permission) {
  if (!hasPerm(c, perm)) throw forbidden();
}

export function requireAnyPerm(c: Context<AppEnv>, ...perms: Permission[]) {
  if (!perms.some((p) => hasPerm(c, p))) throw forbidden();
}

/**
 * Validate a branch chosen by the client against the member's access. Restricted members must use one of their
 * branches (their first branch is the default); others may leave it empty.
 */
export function resolveBranch(c: Context<AppEnv>, requested: string | null | undefined): string | null {
  const scope = c.get("branches");
  if (scope.all) return requested || null;
  if (!scope.ids.length) throw forbidden("You are not assigned to any branch of this company. Ask the owner to assign one.");
  if (!requested) return scope.ids[0];
  if (!scope.ids.includes(requested)) throw forbidden("You do not have access to that branch");
  return requested;
}

/** Throw 404 when a record belongs to a branch the member cannot see (records without a branch are company-wide). */
export function assertBranchVisible(c: Context<AppEnv>, branchId: string | null | undefined) {
  const scope = c.get("branches");
  if (scope.all) return;
  if (!branchId || !scope.ids.includes(branchId)) throw notFound("Record");
}

/** SQL fragment + params restricting a query to the member's branches, e.g. `AND d.branch_id IN (?,?)`. */
export function branchFilter(c: Context<AppEnv>, column: string): { sql: string; params: string[] } {
  const scope = c.get("branches");
  if (scope.all) return { sql: "", params: [] };
  if (!scope.ids.length) return { sql: " AND 1 = 0", params: [] };
  return { sql: ` AND ${column} IN (${scope.ids.map(() => "?").join(",")})`, params: scope.ids };
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

/** Previous → new values of the fields that changed, for the audit trail. */
export function changes(before: Record<string, unknown>, after: Record<string, unknown>) {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const [k, v] of Object.entries(after)) if ((before[k] ?? null) !== (v ?? null)) out[k] = { from: before[k] ?? null, to: v ?? null };
  return out;
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
