import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { all, batch, first, run, stmt, nowIso } from "../lib/db";
import { AppError, badRequest, forbidden, unauthorized } from "../lib/errors";
import { body, reqText } from "../lib/validate";
import { hashPassword, newId, randomToken, recoveryCode, sha256Hex, temporaryPassword, verifyPassword } from "../lib/crypto";
import { newTotpSecret, otpauthUrl, verifyTotp } from "../lib/totp";
import { createSession, destroySession, loadSessionUser, rateLimit, clientIp, requireAuth, requireSession, isLocalRequest } from "../lib/auth";
import { deliverable, emailOn, sendMail, siteUrl } from "../services/email";

const auth = new Hono<AppEnv>();

const email = z.string().trim().toLowerCase().email().max(254);
export const usernameSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._-]{2,31}$/, "3–32 letters, digits, dot, dash or underscore");

export function passwordSchema(env: AppEnv["Bindings"]) {
  const n = Math.max(6, parseInt(env.PASSWORD_MIN_LENGTH ?? "10", 10) || 10);
  return z.string().min(n, `Use at least ${n} characters`).max(200);
}

/**
 * Desktop first run: the administrator account gets a random one-time password (never a shared default). It is kept
 * only in this process's memory, shown on the sign-in page to requests from this computer, and must be changed at
 * first sign-in. If the app restarts before that, a new one is generated.
 */
export const DEFAULT_ADMIN = { username: "admin", email: "admin@ledgerfox.local", name: "Administrator" };
let firstRunPassword: string | null = null;
export const getFirstRunPassword = () => firstRunPassword;

export async function ensureDefaultAdmin(env: AppEnv["Bindings"]): Promise<string | null> {
  const existing = await first<{ id: string }>(env.DB, `SELECT id FROM users WHERE email = ? AND must_change_password = 1`, DEFAULT_ADMIN.email);
  if (!existing && (await first(env.DB, `SELECT 1 FROM users LIMIT 1`))) return (firstRunPassword = null);
  const password = temporaryPassword();
  const h = await hashPassword(password, iterations(env));
  if (existing) {
    await run(env.DB, `UPDATE users SET password_hash = ?, password_salt = ?, password_iters = ? WHERE id = ?`, h.hash, h.salt, h.iterations, existing.id);
  } else {
    await run(env.DB, `INSERT INTO users (id, email, username, name, password_hash, password_salt, password_iters, must_change_password) VALUES (?,?,?,?,?,?,?,1)`,
      newId(), DEFAULT_ADMIN.email, DEFAULT_ADMIN.username, DEFAULT_ADMIN.name, h.hash, h.salt, h.iterations);
  }
  return (firstRunPassword = password);
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
  const verification_sent = await sendVerification(c.env, c.req.url, { id, email: input.email, name: input.name });
  return c.json({ user: { id, email: input.email, username: input.username ?? null, name: input.name }, recovery_codes: codes, verification_sent }, 201);
});

auth.post("/login", async (c) => {
  // `login` is a username or an email address (`email` is accepted for older clients).
  const input = await body(c, z.object({
    login: z.string().trim().toLowerCase().min(1).max(254).optional(), email: z.string().trim().toLowerCase().max(254).optional(), password: z.string().min(1).max(200),
    // Second step for accounts with two-factor sign-in: a 6-digit app code, or one of the recovery codes.
    totp: z.string().trim().max(10).optional(), recovery_code: z.string().trim().max(40).optional(),
  }));
  const login = input.login ?? input.email;
  if (!login) throw badRequest("Enter your username or email");
  const ipOk = await rateLimit(c.env.DB, `login-ip:${clientIp(c)}`, 30, 900);
  const userOk = await rateLimit(c.env.DB, `login-email:${login}`, 10, 900);
  if (!ipOk || !userOk) throw new AppError(429, "RATE_LIMITED", "Too many login attempts. Wait 15 minutes and try again.");
  const user = await first<{ id: string; email: string; username: string | null; name: string; password_hash: string; password_salt: string; password_iters: number; is_disabled: number; must_change_password: number; totp_enabled: number; totp_secret: string | null; totp_last_step: number | null }>(
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
    throw forbidden("This account still has its one-time password. Sign in on the main computer first and change it.");
  }
  if (user.totp_enabled && user.totp_secret) {
    if (!input.totp && !input.recovery_code) throw new AppError(401, "TOTP_REQUIRED", "Enter the 6-digit code from your authenticator app");
    if (input.totp) {
      const step = await verifyTotp(user.totp_secret, input.totp.replace(/\s/g, ""), user.totp_last_step);
      if (step === null) throw new AppError(401, "TOTP_INVALID", "That code is not right or has expired. Check the time on your phone and try the next code.");
      // Record the step so the same code cannot be replayed (guarded against a parallel sign-in with the same code).
      const ok = await run(c.env.DB, `UPDATE users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)`, step, user.id, step);
      if (!ok.meta.changes) throw new AppError(401, "TOTP_INVALID", "That code was already used. Wait for the next one.");
    } else {
      const hash = await sha256Hex(input.recovery_code!.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/(.{4})(?=.)/g, "$1-"));
      const used = await run(c.env.DB, `UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL`, nowIso(), user.id, hash);
      if (!used.meta.changes) throw new AppError(401, "TOTP_INVALID", "That recovery code is not valid or was already used");
    }
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
    const pending = edition === "desktop" && isLocalRequest(c) && firstRunPassword
      ? await first<{ username: string }>(c.env.DB, `SELECT username FROM users WHERE email = ? AND must_change_password = 1`, DEFAULT_ADMIN.email)
      : null;
    const firstRun = pending ? { username: pending.username, password: firstRunPassword } : null;
    return c.json({ user: null, organisations: [], companies: [], brand: c.env.BRAND_NAME ?? "LedgerFox", edition, registration: closed ? "closed" : "open", default_login: Boolean(firstRun), first_run: firstRun, email_enabled: emailOn(c.env) });
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
    user: { id: user.id, email: user.email, username: user.username, name: user.name, must_change_password: false, totp_enabled: Boolean(user.totp_enabled),
      email_verified: Boolean((await first<{ v: string | null }>(c.env.DB, `SELECT email_verified_at AS v FROM users WHERE id = ?`, user.id))?.v), email_deliverable: deliverable(user.email) },
    email_enabled: emailOn(c.env),
    organisations: orgs,
    companies,
    brand: c.env.BRAND_NAME ?? "LedgerFox",
    edition,
  });
});

auth.post("/change-password", requireSession, async (c) => {
  const input = await body(c, z.object({ current_password: z.string().min(1), new_password: passwordSchema(c.env), username: usernameSchema.optional() }));
  if (input.new_password === input.current_password) throw badRequest("Choose a password different from the current one");
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
  if (u.email === DEFAULT_ADMIN.email) firstRunPassword = null;
  return c.json({ ok: true });
});

// ── Two-factor sign-in (authenticator app) ──
auth.post("/2fa/setup", requireAuth, async (c) => {
  const input = await body(c, z.object({ current_password: z.string().min(1) }));
  const u = c.get("user");
  const row = await first<{ password_hash: string; password_salt: string; password_iters: number; totp_enabled: number }>(c.env.DB, `SELECT * FROM users WHERE id = ?`, u.id);
  if (!row || !(await verifyPassword(input.current_password, row))) throw badRequest("Current password is incorrect");
  if (row.totp_enabled) throw badRequest("Two-factor sign-in is already on. Turn it off first to move it to a new phone.");
  const secret = newTotpSecret();
  await run(c.env.DB, `UPDATE users SET totp_secret = ?, totp_last_step = NULL WHERE id = ?`, secret, u.id);
  return c.json({ secret, otpauth_url: otpauthUrl(secret, u.username ?? u.email, c.env.BRAND_NAME ?? "LedgerFox") });
});

auth.post("/2fa/enable", requireAuth, async (c) => {
  const input = await body(c, z.object({ code: z.string().trim().max(10) }));
  const u = c.get("user");
  const row = await first<{ totp_secret: string | null; totp_enabled: number }>(c.env.DB, `SELECT totp_secret, totp_enabled FROM users WHERE id = ?`, u.id);
  if (!row?.totp_secret) throw badRequest("Start the set-up again");
  const step = await verifyTotp(row.totp_secret, input.code.replace(/\s/g, ""), null);
  if (step === null) throw badRequest("That code is not right. Check that the time on your phone is set automatically.");
  const { codes, stmts } = await makeRecoveryCodes(c.env.DB, u.id);
  await batch(c.env.DB, [
    stmt(c.env.DB, `UPDATE users SET totp_enabled = 1, totp_last_step = ? WHERE id = ?`, step, u.id),
    ...stmts,
    stmt(c.env.DB, `DELETE FROM sessions WHERE user_id = ? AND id <> ?`, u.id, u.session_id),
  ]);
  return c.json({ ok: true, recovery_codes: codes });
});

auth.post("/2fa/disable", requireAuth, async (c) => {
  const input = await body(c, z.object({ current_password: z.string().min(1), code: z.string().trim().max(10) }));
  const u = c.get("user");
  const row = await first<{ password_hash: string; password_salt: string; password_iters: number; totp_secret: string | null; totp_enabled: number; totp_last_step: number | null }>(c.env.DB, `SELECT * FROM users WHERE id = ?`, u.id);
  if (!row || !(await verifyPassword(input.current_password, row))) throw badRequest("Current password is incorrect");
  if (!row.totp_enabled || !row.totp_secret) return c.json({ ok: true });
  if ((await verifyTotp(row.totp_secret, input.code, row.totp_last_step)) === null) throw badRequest("That code is not right");
  const required = await first(c.env.DB, `SELECT 1 FROM memberships m JOIN organisations o ON o.id = m.org_id WHERE m.user_id = ? AND o.require_2fa = 1 LIMIT 1`, u.id);
  if (required) throw forbidden("Your organisation requires two-factor sign-in");
  await run(c.env.DB, `UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_step = NULL WHERE id = ?`, u.id);
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
    stmt(c.env.DB, `UPDATE password_resets SET used_at = ? WHERE id = ? AND used_at IS NULL`, nowIso(), id),
    stmt(c.env.DB, `UPDATE users SET password_hash = ?, password_salt = ?, password_iters = ?, must_change_password = 0, updated_at = ? WHERE id = ?`, h.hash, h.salt, h.iterations, nowIso(), r.user_id),
    stmt(c.env.DB, `DELETE FROM sessions WHERE user_id = ?`, r.user_id),
  ]);
  return c.json({ ok: true });
});

// ── Email: verification and password reset links ──

const HOUR = 3_600_000;

/** Mail a link that confirms the account's email address (24 hours). Returns whether it was sent. */
async function sendVerification(env: AppEnv["Bindings"], requestUrl: string, user: { id: string; email: string; name: string }) {
  if (!emailOn(env) || !deliverable(user.email)) return false;
  const token = randomToken(32);
  await run(env.DB, `INSERT INTO email_tokens (id, user_id, purpose, email, expires_at) VALUES (?, ?, 'verify', ?, ?)`, await sha256Hex(token), user.id, user.email, new Date(Date.now() + 24 * HOUR).toISOString());
  const link = `${siteUrl(env, requestUrl)}/verify-email?token=${token}`;
  return sendMail(env, { to: user.email, subject: "Confirm your email for LedgerFox",
    text: `Hello ${user.name},\n\nPlease confirm that this is your email address, so we can send you password reset links, receipts and reminders:\n\n${link}\n\nThe link works for 24 hours. If you did not create a LedgerFox account, ignore this email.\n\nLedgerFox` });
}

auth.post("/verify-email/send", requireSession, async (c) => {
  const u = c.get("user");
  if (!emailOn(c.env)) throw new AppError(503, "EMAIL_OFF", "Email is not set up on this LedgerFox");
  if (!deliverable(u.email)) throw badRequest("This account has no email address that can receive mail");
  if (!(await rateLimit(c.env.DB, `verify-mail:${u.id}`, 5, 3600))) throw new AppError(429, "RATE_LIMITED", "Too many emails. Try again in an hour.");
  if (!(await sendVerification(c.env, c.req.url, u))) throw new AppError(502, "EMAIL_FAILED", "The email could not be sent. Try again later.");
  return c.json({ ok: true });
});

auth.post("/verify-email", async (c) => {
  const input = await body(c, z.object({ token: z.string().min(20).max(200) }));
  if (!(await rateLimit(c.env.DB, `verify:${clientIp(c)}`, 30, 900))) throw new AppError(429, "RATE_LIMITED", "Too many attempts. Try again later.");
  const id = await sha256Hex(input.token);
  const t = await first<{ user_id: string; email: string; expires_at: string; used_at: string | null }>(c.env.DB, `SELECT user_id, email, expires_at, used_at FROM email_tokens WHERE id = ? AND purpose = 'verify'`, id);
  if (!t || t.used_at || t.expires_at < nowIso()) throw badRequest("This link is invalid or has expired. Sign in and send a new one.");
  await batch(c.env.DB, [
    stmt(c.env.DB, `UPDATE email_tokens SET used_at = ? WHERE id = ?`, nowIso(), id),
    // Only the address the link was sent to is confirmed.
    stmt(c.env.DB, `UPDATE users SET email_verified_at = ? WHERE id = ? AND email = ? AND email_verified_at IS NULL`, nowIso(), t.user_id, t.email),
  ]);
  return c.json({ ok: true });
});

/**
 * Forgot password: mail a one-hour reset link. The answer is the same whether or not the address has an account, so
 * nobody can use this page to find out who uses LedgerFox.
 */
auth.post("/forgot", async (c) => {
  if (!emailOn(c.env)) throw new AppError(503, "EMAIL_OFF", "Reset by email is not available here. Use a recovery code, or ask your administrator for a reset link.");
  const input = await body(c, z.object({ email }));
  const ipOk = await rateLimit(c.env.DB, `forgot-ip:${clientIp(c)}`, 10, 900);
  const mailOk = await rateLimit(c.env.DB, `forgot-mail:${input.email}`, 3, 3600);
  if (!ipOk) throw new AppError(429, "RATE_LIMITED", "Too many attempts. Try again later.");
  const user = mailOk ? await first<{ id: string; name: string; email: string; is_disabled: number }>(c.env.DB, `SELECT id, name, email, is_disabled FROM users WHERE email = ?`, input.email) : null;
  if (user && !user.is_disabled && deliverable(user.email)) {
    const token = randomToken(32);
    await run(c.env.DB, `INSERT INTO password_resets (id, user_id, created_by, expires_at) VALUES (?,?,?,?)`, await sha256Hex(token), user.id, user.id, new Date(Date.now() + HOUR).toISOString());
    const link = `${siteUrl(c.env, c.req.url)}/reset?token=${token}`;
    await sendMail(c.env, { to: user.email, subject: "Reset your LedgerFox password",
      text: `Hello ${user.name},\n\nSomeone (hopefully you) asked to reset the password of your LedgerFox account. Choose a new password here:\n\n${link}\n\nThe link works once, for one hour. If you did not ask for this, ignore this email; your password stays the same.\n\nLedgerFox` });
  }
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
