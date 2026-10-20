import { Hono } from "hono";
import { z } from "zod";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { all, batch, first, stmt, nowIso, todayIso } from "../lib/db";
import { AppError, badRequest, forbidden, notFound } from "../lib/errors";
import { body, reqText, shortText, currencyCode } from "../lib/validate";
import { hashPassword, newId, randomToken, sha256Hex } from "../lib/crypto";
import { iterations, passwordSchema, usernameSchema } from "./auth";
import { audit, requireAuth } from "../lib/auth";
import { can, canAssignRole, type Role } from "@shared/permissions";
import { companySetupStatements } from "../services/setup";
import { isCurrency } from "@shared/currencies";
import { isValidGstin, INDIA_STATES } from "@shared/tax";

const orgs = new Hono<AppEnv>();
orgs.use("*", requireAuth);

export const companySchema = z.object({
  name: reqText(160),
  legal_name: shortText(200).nullish(),
  country: z.string().regex(/^[A-Z]{2}$/, "Use a 2-letter ISO country code"),
  base_currency: currencyCode,
  fiscal_year_start_month: z.number().int().min(1).max(12),
  tax_id: shortText(30).nullish(),
  state_code: shortText(4).nullish(),
  address: shortText(500).nullish(),
  city: shortText(100).nullish(),
  postal_code: shortText(20).nullish(),
  phone: shortText(40).nullish(),
  email: z.string().trim().email().max(254).nullish().or(z.literal("")),
  business_type: z.string().max(40).nullish(),
  is_demo: z.boolean().optional(),
});

export function validateCompanyInput(input: z.infer<typeof companySchema>) {
  if (!isCurrency(input.base_currency)) throw badRequest(`Currency ${input.base_currency} is not supported`);
  if (input.country === "IN") {
    if (input.tax_id && !isValidGstin(input.tax_id)) throw badRequest("GSTIN is not valid (format or check digit)");
    if (input.state_code && !INDIA_STATES[input.state_code]) throw badRequest("Unknown Indian state code");
    if (input.tax_id && input.state_code && input.tax_id.slice(0, 2) !== input.state_code) {
      throw badRequest("GSTIN state code does not match the selected state");
    }
  }
}

async function membership(c: Context<AppEnv>, orgId: string): Promise<Role> {
  const m = await first<{ role: Role }>(c.env.DB, `SELECT role FROM memberships WHERE org_id = ? AND user_id = ?`, orgId, c.get("user").id);
  if (!m) throw notFound("Organisation");
  return m.role;
}

/** Create an organisation together with its first company (onboarding). */
orgs.post("/", async (c) => {
  const input = await body(c, z.object({ name: reqText(160), company: companySchema }));
  validateCompanyInput(input.company);
  const user = c.get("user");
  const count = await first<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM organisations WHERE owner_user_id = ?`, user.id);
  if ((count?.n ?? 0) >= 10) throw forbidden("Organisation limit reached for this account");
  const orgId = newId();
  const setup = companySetupStatements(c.env.DB, { ...input.company, email: input.company.email || null, org_id: orgId }, todayIso());
  await batch(c.env.DB, [
    stmt(c.env.DB, `INSERT INTO organisations (id, name, owner_user_id) VALUES (?,?,?)`, orgId, input.name, user.id),
    stmt(c.env.DB, `INSERT INTO memberships (org_id, user_id, role) VALUES (?,?,'owner')`, orgId, user.id),
    ...setup.stmts,
    audit(c, "org.create", "organisation", orgId, { name: input.name }, { orgId, companyId: null }),
    audit(c, "company.create", "company", setup.companyId, { name: input.company.name }, { orgId, companyId: setup.companyId }),
  ]);
  return c.json({ org_id: orgId, company_id: setup.companyId }, 201);
});

orgs.post("/:orgId/companies", async (c) => {
  const orgId = c.req.param("orgId");
  const role = await membership(c, orgId);
  if (!can(role, "company.manage")) throw forbidden();
  const input = await body(c, companySchema);
  validateCompanyInput(input);
  const n = await first<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM companies WHERE org_id = ?`, orgId);
  if ((n?.n ?? 0) >= 25) throw forbidden("Company limit reached for this organisation");
  const setup = companySetupStatements(c.env.DB, { ...input, email: input.email || null, org_id: orgId }, todayIso());
  await batch(c.env.DB, [...setup.stmts, audit(c, "company.create", "company", setup.companyId, { name: input.name }, { orgId, companyId: setup.companyId })]);
  return c.json({ company_id: setup.companyId }, 201);
});

/** Delete a demo company and everything in it. Real companies cannot be deleted (accounting records are kept). */
orgs.delete("/:orgId/companies/:companyId", async (c) => {
  const orgId = c.req.param("orgId");
  const companyId = c.req.param("companyId");
  const role = await membership(c, orgId);
  if (!can(role, "company.manage")) throw forbidden();
  const co = await first<{ is_demo: number; name: string }>(c.env.DB, `SELECT is_demo, name FROM companies WHERE id = ? AND org_id = ?`, companyId, orgId);
  if (!co) throw notFound("Company");
  if (!co.is_demo) throw new AppError(409, "NOT_DEMO", "Only demo companies can be deleted. Real companies keep their accounting records.");
  await batch(c.env.DB, [
    stmt(c.env.DB, `INSERT INTO company_purge (company_id) VALUES (?)`, companyId),
    stmt(c.env.DB, `DELETE FROM companies WHERE id = ? AND is_demo = 1`, companyId),
    stmt(c.env.DB, `DELETE FROM company_purge WHERE company_id = ?`, companyId),
    audit(c, "company.delete_demo", "company", companyId, { name: co.name }, { orgId, companyId: null }),
  ]);
  return c.json({ ok: true });
});

orgs.get("/:orgId", async (c) => {
  const orgId = c.req.param("orgId");
  const role = await membership(c, orgId);
  const org = await first(c.env.DB, `SELECT id, name, owner_user_id, created_at FROM organisations WHERE id = ?`, orgId);
  const members = await all(
    c.env.DB,
    `SELECT u.id, u.name, u.email, u.username, u.must_change_password, m.role, m.created_at FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY m.created_at`,
    orgId,
  );
  const invitations = can(role, "org.manage")
    ? await all(c.env.DB, `SELECT id, email, role, expires_at, accepted_at, revoked_at, created_at FROM invitations WHERE org_id = ? ORDER BY created_at DESC LIMIT 100`, orgId)
    : [];
  const companies = await all(c.env.DB, `SELECT id, name, country, base_currency FROM companies WHERE org_id = ? ORDER BY name`, orgId);
  return c.json({ organisation: org, role, members, invitations, companies });
});

orgs.patch("/:orgId", async (c) => {
  const orgId = c.req.param("orgId");
  const role = await membership(c, orgId);
  if (!can(role, "org.manage")) throw forbidden();
  const input = await body(c, z.object({ name: reqText(160) }));
  await batch(c.env.DB, [
    stmt(c.env.DB, `UPDATE organisations SET name = ? WHERE id = ?`, input.name, orgId),
    audit(c, "org.update", "organisation", orgId, input, { orgId, companyId: null }),
  ]);
  return c.json({ ok: true });
});

/** Invitations: no email service is required — the inviter copies the one-time link. */
orgs.post("/:orgId/invitations", async (c) => {
  const orgId = c.req.param("orgId");
  const role = await membership(c, orgId);
  if (!can(role, "org.manage")) throw forbidden();
  const input = await body(c, z.object({ email: z.string().trim().toLowerCase().email(), role: z.enum(["admin", "accountant", "auditor", "viewer"]) }));
  if (!canAssignRole(role, input.role)) throw forbidden("You cannot grant this role");
  const already = await first(c.env.DB,
    `SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND u.email = ?`, orgId, input.email);
  if (already) throw new AppError(409, "ALREADY_MEMBER", "This person is already a member");
  const token = randomToken(24);
  const id = newId();
  const expires = new Date(Date.now() + 7 * 86400_000).toISOString();
  await batch(c.env.DB, [
    stmt(c.env.DB, `INSERT INTO invitations (id, org_id, email, role, token_hash, invited_by, expires_at) VALUES (?,?,?,?,?,?,?)`,
      id, orgId, input.email, input.role, await sha256Hex(token), c.get("user").id, expires),
    audit(c, "member.invite", "invitation", id, { email: input.email, role: input.role }, { orgId, companyId: null }),
  ]);
  return c.json({ id, token, expires_at: expires }, 201);
});

/**
 * Tally-style user creation: an owner/admin sets a username and a temporary password; the person must choose their
 * own password at first sign-in. No email needed.
 */
orgs.post("/:orgId/users", async (c) => {
  const orgId = c.req.param("orgId");
  const role = await membership(c, orgId);
  if (!can(role, "org.manage")) throw forbidden();
  const input = await body(c, z.object({
    name: reqText(120),
    username: usernameSchema,
    password: passwordSchema(c.env),
    role: z.enum(["admin", "accountant", "auditor", "viewer"]),
  }));
  if (!canAssignRole(role, input.role)) throw forbidden("You cannot grant this role");
  if (await first(c.env.DB, `SELECT 1 FROM users WHERE username = ?`, input.username)) throw new AppError(409, "USERNAME_TAKEN", "That username is already taken");
  const id = newId();
  const h = await hashPassword(input.password, iterations(c.env));
  await batch(c.env.DB, [
    stmt(c.env.DB, `INSERT INTO users (id, email, username, name, password_hash, password_salt, password_iters, must_change_password) VALUES (?,?,?,?,?,?,?,1)`,
      id, `${input.username}.${id.slice(0, 8)}@users.ledgerfox.local`, input.username, input.name, h.hash, h.salt, h.iterations),
    stmt(c.env.DB, `INSERT INTO memberships (org_id, user_id, role) VALUES (?,?,?)`, orgId, id, input.role),
    audit(c, "member.create", "user", id, { username: input.username, role: input.role }, { orgId, companyId: null }),
  ]);
  return c.json({ id, username: input.username }, 201);
});

orgs.delete("/:orgId/invitations/:id", async (c) => {
  const orgId = c.req.param("orgId");
  const role = await membership(c, orgId);
  if (!can(role, "org.manage")) throw forbidden();
  await batch(c.env.DB, [
    stmt(c.env.DB, `UPDATE invitations SET revoked_at = ? WHERE id = ? AND org_id = ? AND accepted_at IS NULL`, nowIso(), c.req.param("id"), orgId),
    audit(c, "member.invite_revoke", "invitation", c.req.param("id"), undefined, { orgId, companyId: null }),
  ]);
  return c.json({ ok: true });
});

orgs.patch("/:orgId/members/:userId", async (c) => {
  const orgId = c.req.param("orgId");
  const targetId = c.req.param("userId");
  const role = await membership(c, orgId);
  if (!can(role, "org.manage")) throw forbidden();
  const input = await body(c, z.object({ role: z.enum(["admin", "accountant", "auditor", "viewer"]) }));
  const current = await first<{ role: Role }>(c.env.DB, `SELECT role FROM memberships WHERE org_id = ? AND user_id = ?`, orgId, targetId);
  if (!current) throw notFound("Member");
  if (current.role === "owner") throw forbidden("The owner's role cannot be changed");
  if (!canAssignRole(role, current.role) || !canAssignRole(role, input.role)) throw forbidden("You cannot change this member's role");
  await batch(c.env.DB, [
    stmt(c.env.DB, `UPDATE memberships SET role = ? WHERE org_id = ? AND user_id = ?`, input.role, orgId, targetId),
    audit(c, "member.role_change", "user", targetId, { from: current.role, to: input.role }, { orgId, companyId: null }),
  ]);
  return c.json({ ok: true });
});

orgs.delete("/:orgId/members/:userId", async (c) => {
  const orgId = c.req.param("orgId");
  const targetId = c.req.param("userId");
  const role = await membership(c, orgId);
  const self = targetId === c.get("user").id;
  const current = await first<{ role: Role }>(c.env.DB, `SELECT role FROM memberships WHERE org_id = ? AND user_id = ?`, orgId, targetId);
  if (!current) throw notFound("Member");
  if (current.role === "owner") throw forbidden("The owner cannot be removed");
  if (!self && (!can(role, "org.manage") || !canAssignRole(role, current.role))) throw forbidden();
  await batch(c.env.DB, [
    stmt(c.env.DB, `DELETE FROM memberships WHERE org_id = ? AND user_id = ?`, orgId, targetId),
    audit(c, "member.remove", "user", targetId, { role: current.role }, { orgId, companyId: null }),
  ]);
  return c.json({ ok: true });
});

/** Owner/admin issues a one-time password reset link for a member (email-free recovery). */
orgs.post("/:orgId/members/:userId/reset-link", async (c) => {
  const orgId = c.req.param("orgId");
  const targetId = c.req.param("userId");
  const role = await membership(c, orgId);
  if (!can(role, "org.manage")) throw forbidden();
  const current = await first<{ role: Role }>(c.env.DB, `SELECT role FROM memberships WHERE org_id = ? AND user_id = ?`, orgId, targetId);
  if (!current) throw notFound("Member");
  if (current.role === "owner" || !canAssignRole(role, current.role)) throw forbidden("You cannot reset this member's password");
  // A user who belongs to other organisations could be hijacked by a reset from one org's admin; restrict to single-org users.
  const orgCount = await first<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM memberships WHERE user_id = ?`, targetId);
  if ((orgCount?.n ?? 0) > 1) throw forbidden("This user belongs to other organisations and must use their own recovery codes");
  const token = randomToken(24);
  const expires = new Date(Date.now() + 24 * 3600_000).toISOString();
  await batch(c.env.DB, [
    stmt(c.env.DB, `INSERT INTO password_resets (id, user_id, created_by, expires_at) VALUES (?,?,?,?)`, await sha256Hex(token), targetId, c.get("user").id, expires),
    audit(c, "member.reset_link", "user", targetId, undefined, { orgId, companyId: null }),
  ]);
  return c.json({ token, expires_at: expires });
});

export const invitations = new Hono<AppEnv>();
invitations.use("*", requireAuth);

invitations.post("/accept", async (c) => {
  const input = await body(c, z.object({ token: z.string().min(10).max(200) }));
  const inv = await first<{ id: string; org_id: string; email: string; role: Role; expires_at: string; accepted_at: string | null; revoked_at: string | null }>(
    c.env.DB, `SELECT * FROM invitations WHERE token_hash = ?`, await sha256Hex(input.token),
  );
  if (!inv || inv.accepted_at || inv.revoked_at || inv.expires_at < nowIso()) throw badRequest("This invitation is invalid or has expired");
  const user = c.get("user");
  if (inv.email.toLowerCase() !== user.email.toLowerCase()) {
    throw forbidden(`This invitation was sent to ${inv.email}. Sign in with that email to accept it.`);
  }
  await batch(c.env.DB, [
    stmt(c.env.DB, `UPDATE invitations SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL`, nowIso(), inv.id),
    stmt(c.env.DB, `INSERT OR IGNORE INTO memberships (org_id, user_id, role) VALUES (?,?,?)`, inv.org_id, user.id, inv.role),
    audit(c, "member.join", "user", user.id, { role: inv.role }, { orgId: inv.org_id, companyId: null }),
  ]);
  return c.json({ org_id: inv.org_id });
});

export default orgs;
