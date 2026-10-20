import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { all, batch, first, run, stmt, nowIso } from "../lib/db";
import { AppError, badRequest, forbidden, unauthorized } from "../lib/errors";
import { body, reqText } from "../lib/validate";
import { hashPassword, newId, recoveryCode, sha256Hex, verifyPassword } from "../lib/crypto";
import { createSession, destroySession, loadSessionUser, rateLimit, clientIp, requireAuth, requireSession, isLocalRequest } from "../lib/auth";

const auth = new Hono<AppEnv>();

const email = z.string().trim().toLowerCase().email().max(254);
export const usernameSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._-]{2,31}$/, "3–32 letters, digits, dot, dash or underscore");

export function passwordSchema(env: AppEnv["Bindings"]) {
  const n = Math.max(6, parseInt(env.PASSWORD_MIN_LENGTH ?? "10", 10) || 10);
  return z.string().min(n, `Use at least ${n} characters`).max(200);
}

/** Default desktop sign-in. It must be changed at first sign-in, and only from the computer itself. */
export const DEFAULT_ADMIN = { username: "admin", password: "admin", email: "admin@ledgerfox.local", name: "Administrator" };

export async function ensureDefaultAdmin(env: AppEnv["Bindings"]) {
  if (await first(env.DB, `SELECT 1 FROM users LIMIT 1`)) return false;
  const h = await hashPassword(DEFAULT_ADMIN.password, iterations(env));
  await run(env.DB, `INSERT INTO users (id, email, username, name, password_hash, password_salt, password_iters, must_change_password) VALUES (?,?,?,?,?,?,?,1)`,
    newId(), DEFAULT_ADMIN.email, DEFAULT_ADMIN.username, DEFAULT_ADMIN.name, h.hash, h.salt, h.iterations);
  return true;
}

export function iterations(env: AppEnv["Bindings"]) {
  // Default sized for the Workers Free plan's 10 ms CPU budget; see SECURITY.md.
  const n = parseInt(env.PBKDF2_ITERATIONS ?? "50000", 10);
  return Number.isFinite(n) && n >= 1000 ? Math.min(n, 100000) : 50000;
}

async function makeRecoveryCodes(db: D1Database, userId: string) {
  const codes = Array.from({ length: 8 }, recoveryCode);
  const stmts = [stmt(db, `DELETE FROM recovery_codes WHERE user_id = ?`, userId)];
  for (const code of codes) {
    stmts.push(stmt(db, `INSERT INTO recovery_codes (id, user_id, code_hash) VALUES (?,?,?)`, newId(), userId, await sha256Hex(code)));
  }
  return { codes, stmts };
}

auth.post("/register", async (c) => {
  if (c.env.ALLOW_REGISTRATION === "false") throw forbidden("Registration is disabled on this instance");
  if (c.env.ALLOW_REGISTRATION === "first" && (await first(c.env.DB, `SELECT 1 FROM users LIMIT 1`))) {
    throw forbidden("This LedgerFox already has an owner. Ask them to invite you from Settings → Users.");
  }
  if (!(await rateLimit(c.env.DB, `register:${clientIp(c)}`, 10, 3600))) {
    throw new AppError(429, "RATE_LIMITED", "Too many registrations from this address. Try again later.");
  }
  const input = await body(c, z.object({ name: reqText(120), email, username: usernameSchema.optional().nullable(), password: passwordSchema(c.env) }));
  const exists = await first(c.env.DB, `SELECT 1 FROM users WHERE email = ?`, input.email);
  if (exists) throw new AppError(409, "EMAIL_TAKEN", "An account with this email already exists");
  if (input.username && (await first(c.env.DB, `SELECT 1 FROM users WHERE username = ?`, input.username))) {
    throw new AppError(409, "USERNAME_TAKEN", "That username is already taken");
  }
  const id = newId();
  const h = await hashPassword(input.password, iterations(c.env));
  const { codes, stmts } = await makeRecoveryCodes(c.env.DB, id);
  await batch(c.env.DB, [
    stmt(c.env.DB, `INSERT INTO users (id, email, username, name, password_hash, password_salt, password_iters) VALUES (?,?,?,?,?,?,?)`,
      id, input.email, input.username ?? null, input.name, h.hash, h.salt, h.iterations),
    ...stmts.slice(1),
  ]);
  await createSession(c, id);
  return c.json({ user: { id, email: input.email, username: input.username ?? null, name: input.name }, recovery_codes: codes }, 201);
});

auth.post("/login", async (c) => {
  // `login` is a username or an email address (`email` is accepted for older clients).
  const input = await body(c, z.object({ login: z.string().trim().toLowerCase().min(1).max(254).optional(), email: z.string().trim().toLowerCase().max(254).optional(), password: z.string().min(1).max(200) }));
  const login = input.login ?? input.email;
  if (!login) throw badRequest("Enter your username or email");
  const ipOk = await rateLimit(c.env.DB, `login-ip:${clientIp(c)}`, 30, 900);
  const userOk = await rateLimit(c.env.DB, `login-email:${login}`, 10, 900);
  if (!ipOk || !userOk) throw new AppError(429, "RATE_LIMITED", "Too many login attempts. Wait 15 minutes and try again.");
  const user = await first<{ id: string; email: string; username: string | null; name: string; password_hash: string; password_salt: string; password_iters: number; is_disabled: number; must_change_password: number }>(
    c.env.DB, `SELECT * FROM users WHERE email = ? OR username = ? LIMIT 1`, login, login,
  );
  if (!user) {
    // Equalise timing with a dummy hash so account existence is not revealed.
    await hashPassword(input.password, iterations(c.env));
    throw unauthorized("Invalid username or password");
  }
  if (user.is_disabled || !(await verifyPassword(input.password, user))) throw unauthorized("Invalid username or password");
  // A default or temporary password may only be used on the computer running LedgerFox, never over the network.
  if (user.must_change_password && c.env.APP_ENV === "desktop" && !isLocalRequest(c)) {
    throw forbidden("This account still has its default password. Sign in on the main computer first and change it.");
  }
  // Transparently upgrade hashes when the configured work factor increases.
  if (user.password_iters < iterations(c.env)) {
    const h = await hashPassword(input.password, iterations(c.env));
    await run(c.env.DB, `UPDATE users SET password_hash = ?, password_salt = ?, password_iters = ?, updated_at = ? WHERE id = ?`, h.hash, h.salt, h.iterations, nowIso(), user.id);
  }
  await createSession(c, user.id);
  return c.json({ user: { id: user.id, email: user.email, username: user.username, name: user.name }, must_change_password: Boolean(user.must_change_password) });
});

auth.post("/logout", async (c) => {
  await destroySession(c);
  return c.json({ ok: true });
});

auth.get("/me", async (c) => {
  const user = await loadSessionUser(c);
  const edition = c.env.APP_ENV === "desktop" ? "desktop" : c.env.APP_ENV === "offline" ? "offline" : "cloud";
  if (!user) {
    const closed = c.env.ALLOW_REGISTRATION === "false" || (c.env.ALLOW_REGISTRATION === "first" && Boolean(await first(c.env.DB, `SELECT 1 FROM users LIMIT 1`)));
    const defaultLogin = edition === "desktop" && isLocalRequest(c) && Boolean(await first(c.env.DB, `SELECT 1 FROM users WHERE username = ? AND must_change_password = 1`, DEFAULT_ADMIN.username));
    return c.json({ user: null, organisations: [], companies: [], brand: c.env.BRAND_NAME ?? "LedgerFox", edition, registration: closed ? "closed" : "open", default_login: defaultLogin });
  }
  if (user.must_change_password) {
    return c.json({ user: { id: user.id, email: user.email, username: user.username, name: user.name, must_change_password: true }, organisations: [], companies: [], brand: c.env.BRAND_NAME ?? "LedgerFox", edition });
  }
  const orgs = await all<{ org_id: string; org_name: string; role: string }>(
    c.env.DB,
    `SELECT o.id AS org_id, o.name AS org_name, m.role FROM memberships m JOIN organisations o ON o.id = m.org_id WHERE m.user_id = ? ORDER BY o.created_at`,
    user.id,
  );
  const companies = await all<{ id: string; name: string; org_id: string; base_currency: string; country: string }>(
    c.env.DB,
    `SELECT co.id, co.name, co.org_id, co.base_currency, co.country, co.business_type, co.is_demo FROM companies co
     JOIN memberships m ON m.org_id = co.org_id AND m.user_id = ? ORDER BY co.name`,
    user.id,
  );
  return c.json({
    user: { id: user.id, email: user.email, username: user.username, name: user.name, must_change_password: false },
    organisations: orgs,
    companies,
    brand: c.env.BRAND_NAME ?? "LedgerFox",
    edition,
  });
});

auth.post("/change-password", requireSession, async (c) => {
  const input = await body(c, z.object({ current_password: z.string().min(1), new_password: passwordSchema(c.env), username: usernameSchema.optional() }));
  if (input.new_password === input.current_password) throw badRequest("Choose a password different from the current one");
  if (input.new_password.toLowerCase() === DEFAULT_ADMIN.password) throw badRequest("Choose a password other than the default");
  const u = c.get("user");
  const row = await first<{ password_hash: string; password_salt: string; password_iters: number }>(c.env.DB, `SELECT * FROM users WHERE id = ?`, u.id);
  if (!row || !(await verifyPassword(input.current_password, row))) throw badRequest("Current password is incorrect");
  if (input.username && input.username !== u.username && (await first(c.env.DB, `SELECT 1 FROM users WHERE username = ? AND id <> ?`, input.username, u.id))) {
    throw new AppError(409, "USERNAME_TAKEN", "That username is already taken");
  }
  const h = await hashPassword(input.new_password, iterations(c.env));
  await batch(c.env.DB, [
    stmt(c.env.DB, `UPDATE users SET password_hash = ?, password_salt = ?, password_iters = ?, must_change_password = 0, username = COALESCE(?, username), updated_at = ? WHERE id = ?`,
      h.hash, h.salt, h.iterations, input.username ?? null, nowIso(), u.id),
    stmt(c.env.DB, `DELETE FROM sessions WHERE user_id = ? AND id <> ?`, u.id, u.session_id),
  ]);
  return c.json({ ok: true });
});

auth.post("/recovery-codes", requireAuth, async (c) => {
  const input = await body(c, z.object({ current_password: z.string().min(1) }));
  const u = c.get("user");
  const row = await first<{ password_hash: string; password_salt: string; password_iters: number }>(c.env.DB, `SELECT * FROM users WHERE id = ?`, u.id);
  if (!row || !(await verifyPassword(input.current_password, row))) throw badRequest("Current password is incorrect");
  const { codes, stmts } = await makeRecoveryCodes(c.env.DB, u.id);
  await batch(c.env.DB, stmts);
  return c.json({ recovery_codes: codes });
});

/**
 * Password recovery without email: a one-time recovery code (issued at registration) or a reset token
 * generated by an organisation owner/admin.
 */
auth.post("/recover", async (c) => {
  const input = await body(c, z.object({ email, recovery_code: z.string().trim().min(6).max(40), new_password: passwordSchema(c.env) }));
  if (!(await rateLimit(c.env.DB, `recover:${clientIp(c)}`, 10, 900))) throw new AppError(429, "RATE_LIMITED", "Too many attempts. Try again later.");
  const user = await first<{ id: string }>(c.env.DB, `SELECT id FROM users WHERE email = ?`, input.email);
  const fail = () => badRequest("Email or recovery code is incorrect");
  if (!user) throw fail();
  const codeHash = await sha256Hex(input.recovery_code.toUpperCase());
  const code = await first<{ id: string }>(c.env.DB, `SELECT id FROM recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL`, user.id, codeHash);
  if (!code) throw fail();
  const h = await hashPassword(input.new_password, iterations(c.env));
  await batch(c.env.DB, [
    stmt(c.env.DB, `UPDATE recovery_codes SET used_at = ? WHERE id = ? AND used_at IS NULL`, nowIso(), code.id),
    stmt(c.env.DB, `UPDATE users SET password_hash = ?, password_salt = ?, password_iters = ?, must_change_password = 0, updated_at = ? WHERE id = ?`, h.hash, h.salt, h.iterations, nowIso(), user.id),
    stmt(c.env.DB, `DELETE FROM sessions WHERE user_id = ?`, user.id),
  ]);
  return c.json({ ok: true });
});

auth.post("/reset", async (c) => {
  const input = await body(c, z.object({ token: z.string().min(20).max(200), new_password: passwordSchema(c.env) }));
  const id = await sha256Hex(input.token);
  const r = await first<{ user_id: string; expires_at: string; used_at: string | null }>(c.env.DB, `SELECT * FROM password_resets WHERE id = ?`, id);
  if (!r || r.used_at || r.expires_at < nowIso()) throw badRequest("This reset link is invalid or has expired");
  const h = await hashPassword(input.new_password, iterations(c.env));
  await batch(c.env.DB, [
    stmt(c.env.DB, `UPDATE password_resets SET used_at = ? WHERE id = ?`, nowIso(), id),
    stmt(c.env.DB, `UPDATE users SET password_hash = ?, password_salt = ?, password_iters = ?, must_change_password = 0, updated_at = ? WHERE id = ?`, h.hash, h.salt, h.iterations, nowIso(), r.user_id),
    stmt(c.env.DB, `DELETE FROM sessions WHERE user_id = ?`, r.user_id),
  ]);
  return c.json({ ok: true });
});

auth.get("/sessions", requireAuth, async (c) => {
  const u = c.get("user");
  const rows = await all<{ id: string; created_at: string; expires_at: string; ip: string; user_agent: string }>(
    c.env.DB, `SELECT id, created_at, expires_at, ip, user_agent FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`, u.id,
  );
  return c.json({ sessions: rows.map((s) => ({ ...s, id: s.id.slice(0, 8), current: s.id === u.session_id })) });
});

auth.post("/logout-all", requireAuth, async (c) => {
  await run(c.env.DB, `DELETE FROM sessions WHERE user_id = ?`, c.get("user").id);
  await destroySession(c);
  return c.json({ ok: true });
});

export default auth;
