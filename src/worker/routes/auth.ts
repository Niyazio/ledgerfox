import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { all, batch, first, run, stmt, nowIso } from "../lib/db";
import { AppError, badRequest, forbidden, unauthorized } from "../lib/errors";
import { body, reqText } from "../lib/validate";
import { hashPassword, newId, recoveryCode, sha256Hex, verifyPassword } from "../lib/crypto";
import { createSession, destroySession, loadSessionUser, rateLimit, clientIp, requireAuth } from "../lib/auth";

const auth = new Hono<AppEnv>();

const password = z.string().min(10, "Use at least 10 characters").max(200);
const email = z.string().trim().toLowerCase().email().max(254);

function iterations(env: AppEnv["Bindings"]) {
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
  if (!(await rateLimit(c.env.DB, `register:${clientIp(c)}`, 10, 3600))) {
    throw new AppError(429, "RATE_LIMITED", "Too many registrations from this address. Try again later.");
  }
  const input = await body(c, z.object({ name: reqText(120), email, password }));
  const exists = await first(c.env.DB, `SELECT 1 FROM users WHERE email = ?`, input.email);
  if (exists) throw new AppError(409, "EMAIL_TAKEN", "An account with this email already exists");
  const id = newId();
  const h = await hashPassword(input.password, iterations(c.env));
  const { codes, stmts } = await makeRecoveryCodes(c.env.DB, id);
  await batch(c.env.DB, [
    stmt(c.env.DB, `INSERT INTO users (id, email, name, password_hash, password_salt, password_iters) VALUES (?,?,?,?,?,?)`,
      id, input.email, input.name, h.hash, h.salt, h.iterations),
    ...stmts.slice(1),
  ]);
  await createSession(c, id);
  return c.json({ user: { id, email: input.email, name: input.name }, recovery_codes: codes }, 201);
});

auth.post("/login", async (c) => {
  const input = await body(c, z.object({ email, password: z.string().min(1).max(200) }));
  const ipOk = await rateLimit(c.env.DB, `login-ip:${clientIp(c)}`, 30, 900);
  const emailOk = await rateLimit(c.env.DB, `login-email:${input.email}`, 10, 900);
  if (!ipOk || !emailOk) throw new AppError(429, "RATE_LIMITED", "Too many login attempts. Wait 15 minutes and try again.");
  const user = await first<{ id: string; email: string; name: string; password_hash: string; password_salt: string; password_iters: number; is_disabled: number }>(
    c.env.DB, `SELECT * FROM users WHERE email = ?`, input.email,
  );
  if (!user) {
    // Equalise timing with a dummy hash so account existence is not revealed.
    await hashPassword(input.password, iterations(c.env));
    throw unauthorized("Invalid email or password");
  }
  if (user.is_disabled || !(await verifyPassword(input.password, user))) throw unauthorized("Invalid email or password");
  // Transparently upgrade hashes when the configured work factor increases.
  if (user.password_iters < iterations(c.env)) {
    const h = await hashPassword(input.password, iterations(c.env));
    await run(c.env.DB, `UPDATE users SET password_hash = ?, password_salt = ?, password_iters = ?, updated_at = ? WHERE id = ?`, h.hash, h.salt, h.iterations, nowIso(), user.id);
  }
  await createSession(c, user.id);
  return c.json({ user: { id: user.id, email: user.email, name: user.name } });
});

auth.post("/logout", async (c) => {
  await destroySession(c);
  return c.json({ ok: true });
});

auth.get("/me", async (c) => {
  const user = await loadSessionUser(c);
  if (!user) return c.json({ user: null });
  const orgs = await all<{ org_id: string; org_name: string; role: string }>(
    c.env.DB,
    `SELECT o.id AS org_id, o.name AS org_name, m.role FROM memberships m JOIN organisations o ON o.id = m.org_id WHERE m.user_id = ? ORDER BY o.created_at`,
    user.id,
  );
  const companies = await all<{ id: string; name: string; org_id: string; base_currency: string; country: string }>(
    c.env.DB,
    `SELECT co.id, co.name, co.org_id, co.base_currency, co.country FROM companies co
     JOIN memberships m ON m.org_id = co.org_id AND m.user_id = ? ORDER BY co.name`,
    user.id,
  );
  return c.json({
    user: { id: user.id, email: user.email, name: user.name },
    organisations: orgs,
    companies,
    brand: c.env.BRAND_NAME ?? "LedgerFox",
  });
});

auth.post("/change-password", requireAuth, async (c) => {
  const input = await body(c, z.object({ current_password: z.string().min(1), new_password: password }));
  const u = c.get("user");
  const row = await first<{ password_hash: string; password_salt: string; password_iters: number }>(c.env.DB, `SELECT * FROM users WHERE id = ?`, u.id);
  if (!row || !(await verifyPassword(input.current_password, row))) throw badRequest("Current password is incorrect");
  const h = await hashPassword(input.new_password, iterations(c.env));
  await batch(c.env.DB, [
    stmt(c.env.DB, `UPDATE users SET password_hash = ?, password_salt = ?, password_iters = ?, updated_at = ? WHERE id = ?`, h.hash, h.salt, h.iterations, nowIso(), u.id),
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
  const input = await body(c, z.object({ email, recovery_code: z.string().trim().min(6).max(40), new_password: password }));
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
    stmt(c.env.DB, `UPDATE users SET password_hash = ?, password_salt = ?, password_iters = ?, updated_at = ? WHERE id = ?`, h.hash, h.salt, h.iterations, nowIso(), user.id),
    stmt(c.env.DB, `DELETE FROM sessions WHERE user_id = ?`, user.id),
  ]);
  return c.json({ ok: true });
});

auth.post("/reset", async (c) => {
  const input = await body(c, z.object({ token: z.string().min(20).max(200), new_password: password }));
  const id = await sha256Hex(input.token);
  const r = await first<{ user_id: string; expires_at: string; used_at: string | null }>(c.env.DB, `SELECT * FROM password_resets WHERE id = ?`, id);
  if (!r || r.used_at || r.expires_at < nowIso()) throw badRequest("This reset link is invalid or has expired");
  const h = await hashPassword(input.new_password, iterations(c.env));
  await batch(c.env.DB, [
    stmt(c.env.DB, `UPDATE password_resets SET used_at = ? WHERE id = ?`, nowIso(), id),
    stmt(c.env.DB, `UPDATE users SET password_hash = ?, password_salt = ?, password_iters = ?, updated_at = ? WHERE id = ?`, h.hash, h.salt, h.iterations, nowIso(), r.user_id),
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
