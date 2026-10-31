import { Hono } from "hono";
import { taxIdProblem } from "@shared/countries";
import { z } from "zod";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { all, batch, first, stmt, nowIso, todayIso } from "../lib/db";
import { AppError, badRequest, forbidden, notFound } from "../lib/errors";
import { body, reqText, shortText, currencyCode } from "../lib/validate";
import { hashPassword, newId, randomToken, sha256Hex, temporaryPassword } from "../lib/crypto";
import { iterations, usernameSchema } from "./auth";
import { audit, orgPermissions, requireAuth } from "../lib/auth";
import { requireCapacity, requireDemoAllowed } from "../services/billing";
import { ALL_PERMISSIONS, ROLES, canAssignRole, defaultPermissions, effectivePermissions, type Permission, type Role } from "@shared/permissions";
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
  is_practice: z.boolean().optional(),
  upi_id: z.string().trim().regex(/^[a-zA-Z0-9._-]{2,256}@[a-zA-Z]{2,64}$/, "UPI ID looks like name@bank").nullish().or(z.literal("")),
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
  // VAT numbers that tax authorities check strictly (UAE TRN, Saudi VAT number).
  const problem = taxIdProblem(input.country, input.tax_id);
  if (problem) throw badRequest(problem);
}

interface Member { role: Role; perms: Permission[] }

async function membership(c: Context<AppEnv>, orgId: string): Promise<Member> {
  const m = await first<{ role: Role }>(c.env.DB, `SELECT role FROM memberships WHERE org_id = ? AND user_id = ?`, orgId, c.get("user").id);
  if (!m) throw notFound("Organisation");
  return { role: m.role, perms: await orgPermissions(c.env.DB, orgId, m.role) };
}

async function requireOrgPerm(c: Context<AppEnv>, orgId: string, perm: Permission): Promise<Member> {
  const m = await membership(c, orgId);
  if (!m.perms.includes(perm)) throw forbidden();
  return m;
}

const assignableRole = z.enum(["admin", "billing", "purchase", "accountant", "inventory", "auditor", "viewer"]);
const branchAccess = z.object({ company_id: z.string().min(1), all_branches: z.boolean(), branch_ids: z.array(z.string().min(1)).max(200).default([]) });

/** Branches the signed-in manager is limited to (null = owner or all branches). */
async function actorBranches(c: Context<AppEnv>, orgId: string): Promise<{ company_id: string; branch_id: string }[] | null> {
  const me = c.get("user").id;
  const m = await first<{ role: Role; all_branches: number }>(c.env.DB, `SELECT role, all_branches FROM memberships WHERE org_id = ? AND user_id = ?`, orgId, me);
  if (!m || m.role === "owner" || m.all_branches) return null;
  return all(c.env.DB, `SELECT company_id, branch_id FROM member_branches WHERE org_id = ? AND user_id = ?`, orgId, me);
}

/** A branch-limited manager may only manage members whose branches are all within the manager's own branches. */
async function assertManages(c: Context<AppEnv>, orgId: string, targetId: string) {
  const mine = await actorBranches(c, orgId);
  if (!mine) return;
  const t = await first<{ all_branches: number }>(c.env.DB, `SELECT all_branches FROM memberships WHERE org_id = ? AND user_id = ?`, orgId, targetId);
  const theirs = await all<{ branch_id: string }>(c.env.DB, `SELECT branch_id FROM member_branches WHERE org_id = ? AND user_id = ?`, orgId, targetId);
  if (!t || t.all_branches || !theirs.length || theirs.some((b) => !mine.some((x) => x.branch_id === b.branch_id))) {
    throw forbidden("This person works in other branches. Ask the owner.");
  }
}

/** Statements replacing a member's branch assignments for one company (validated against that company's branches). */
async function branchStatements(c: Context<AppEnv>, orgId: string, userId: string, a: z.infer<typeof branchAccess>) {
  const co = await first(c.env.DB, `SELECT 1 FROM companies WHERE id = ? AND org_id = ?`, a.company_id, orgId);
  if (!co) throw notFound("Company");
  const ids = [...new Set(a.branch_ids)];
  const mine = await actorBranches(c, orgId);
  if (mine && (a.all_branches || ids.some((b) => !mine.some((x) => x.company_id === a.company_id && x.branch_id === b)))) {
    throw forbidden("You can only give access to your own branches");
  }
  if (!a.all_branches) {
    if (!ids.length) throw badRequest("Choose at least one branch, or allow all branches");
    const known = await all<{ id: string }>(c.env.DB, `SELECT id FROM branches WHERE company_id = ? AND id IN (${ids.map(() => "?").join(",")})`, a.company_id, ...ids);
    if (known.length !== ids.length) throw badRequest("Unknown branch");
  }
  return [
    stmt(c.env.DB, `UPDATE memberships SET all_branches = ? WHERE org_id = ? AND user_id = ?`, a.all_branches ? 1 : 0, orgId, userId),
    stmt(c.env.DB, `DELETE FROM member_branches WHERE org_id = ? AND user_id = ? AND company_id = ?`, orgId, userId, a.company_id),
    ...(a.all_branches ? [] : ids.map((b) => stmt(c.env.DB, `INSERT INTO member_branches (org_id, user_id, company_id, branch_id) VALUES (?,?,?,?)`, orgId, userId, a.company_id, b))),
  ];
}

/** Create an organisation together with its first company (onboarding). */
/** A practice company always says so in its name. */
const practiceName = <T extends { name: string; is_practice?: boolean }>(co: T): T =>
  co.is_practice && !/\(practice\)\s*$/i.test(co.name) ? { ...co, name: `${co.name} (Practice)` } : co;

orgs.post("/", async (c) => {
  const raw = await body(c, z.object({ name: reqText(160), company: companySchema }));
  const input = { ...raw, company: practiceName(raw.company) };
  validateCompanyInput(input.company);
  const user = c.get("user");
  // A demo company joins the organisation the person already owns, so trial and subscription stay in one place.
  if (input.company.is_demo) {
    const own = await first<{ id: string }>(c.env.DB, `SELECT id FROM organisations WHERE owner_user_id = ? ORDER BY created_at LIMIT 1`, user.id);
    await requireDemoAllowed(c, own?.id ?? null);
    if (own) {
      const setup = companySetupStatements(c.env.DB, { ...input.company, email: input.company.email || null, org_id: own.id }, todayIso());
      await batch(c.env.DB, [...setup.stmts, audit(c, "company.create", "company", setup.companyId, { name: input.company.name }, { orgId: own.id, companyId: setup.companyId })]);
      return c.json({ org_id: own.id, company_id: setup.companyId }, 201);
    }
  }
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
  await requireOrgPerm(c, orgId, "company.manage");
  const input = practiceName(await body(c, companySchema));
  validateCompanyInput(input);
  if (input.is_demo) await requireDemoAllowed(c, orgId);
  else if (!input.is_practice) await requireCapacity(c, orgId, "companies");
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
  await requireOrgPerm(c, orgId, "company.manage");
  const co = await first<{ is_demo: number; name: string }>(c.env.DB, `SELECT is_demo, name FROM companies WHERE id = ? AND org_id = ?`, companyId, orgId);
  if (!co) throw notFound("Company");
  if (!co.is_demo) throw new AppError(409, "NOT_DEMO", "Only demo companies can be deleted. Real companies keep their accounting records.");
  await batch(c.env.DB, [
    stmt(c.env.DB, `INSERT INTO company_purge (company_id) VALUES (?)`, companyId),
    // Allocations are not linked to the company by a cascading key, so remove them before their documents/payments.
    stmt(c.env.DB, `DELETE FROM allocations WHERE company_id = ?`, companyId),
    stmt(c.env.DB, `DELETE FROM companies WHERE id = ? AND is_demo = 1`, companyId),
    stmt(c.env.DB, `DELETE FROM company_purge WHERE company_id = ?`, companyId),
    audit(c, "company.delete_demo", "company", companyId, { name: co.name }, { orgId, companyId: null }),
  ]);
  return c.json({ ok: true });
});

orgs.get("/:orgId", async (c) => {
  const orgId = c.req.param("orgId");
  const { role, perms } = await membership(c, orgId);
  const org = await first(c.env.DB, `SELECT id, name, owner_user_id, created_at, require_2fa FROM organisations WHERE id = ?`, orgId);
  const members = await all(
    c.env.DB,
    `SELECT u.id, u.name, u.email, u.username, u.must_change_password, u.totp_enabled, m.role, m.all_branches, m.created_at FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY m.created_at`,
    orgId,
  );
  const assignments = perms.includes("org.manage")
    ? await all<{ user_id: string; company_id: string; branch_id: string }>(c.env.DB, `SELECT user_id, company_id, branch_id FROM member_branches WHERE org_id = ?`, orgId)
    : [];
  for (const m of members as { id: string; branches?: { company_id: string; branch_id: string }[] }[]) {
    m.branches = assignments.filter((a) => a.user_id === m.id).map(({ company_id, branch_id }) => ({ company_id, branch_id }));
  }
  const invitations = perms.includes("org.manage")
    ? await all(c.env.DB, `SELECT id, email, role, expires_at, accepted_at, revoked_at, created_at FROM invitations WHERE org_id = ? ORDER BY created_at DESC LIMIT 100`, orgId)
    : [];
  const companies = await all(c.env.DB, `SELECT id, name, country, base_currency FROM companies WHERE org_id = ? ORDER BY name`, orgId);
  return c.json({ organisation: org, role, permissions: perms, members, invitations, companies });
});

orgs.patch("/:orgId", async (c) => {
  const orgId = c.req.param("orgId");
  await requireOrgPerm(c, orgId, "org.manage");
  const input = await body(c, z.object({ name: reqText(160), require_2fa: z.boolean().optional() }));
  if (input.require_2fa !== undefined) {
    const me = await first<{ role: Role; totp_enabled: number }>(c.env.DB, `SELECT m.role, u.totp_enabled FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND m.user_id = ?`, orgId, c.get("user").id);
    if (me?.role !== "owner") throw forbidden("Only the owner can change this");
    if (input.require_2fa && !me.totp_enabled) throw badRequest("Turn on two-factor sign-in for your own account first");
  }
  await batch(c.env.DB, [
    stmt(c.env.DB, `UPDATE organisations SET name = ?, require_2fa = COALESCE(?, require_2fa) WHERE id = ?`, input.name, input.require_2fa === undefined ? null : input.require_2fa ? 1 : 0, orgId),
    audit(c, "org.update", "organisation", orgId, input, { orgId, companyId: null }),
  ]);
  return c.json({ ok: true });
});

/** Invitations: no email service is required — the inviter copies the one-time link. */
orgs.post("/:orgId/invitations", async (c) => {
  const orgId = c.req.param("orgId");
  const { role } = await requireOrgPerm(c, orgId, "org.manage");
  const input = await body(c, z.object({ email: z.string().trim().toLowerCase().email(), role: assignableRole }));
  if (!canAssignRole(role, input.role)) throw forbidden("You cannot grant this role");
  // Invited people join with every branch, so only managers of all branches may invite.
  if (await actorBranches(c, orgId)) throw forbidden("Branch managers add staff with “Add a user” so they can be limited to your branches");
  const already = await first(c.env.DB,
    `SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND u.email = ?`, orgId, input.email);
  if (already) throw new AppError(409, "ALREADY_MEMBER", "This person is already a member");
  await requireCapacity(c, orgId, "users");
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
 * Familiar user creation (as in common desktop accounting software): the server generates a random one-time password, shown once to the owner/admin; the
 * person must choose their own password at first sign-in. No email needed and no shared default password.
 */
orgs.post("/:orgId/users", async (c) => {
  const orgId = c.req.param("orgId");
  const { role } = await requireOrgPerm(c, orgId, "org.manage");
  const input = await body(c, z.object({
    name: reqText(120),
    username: usernameSchema,
    role: assignableRole,
    branches: branchAccess.optional(),
  }));
  if (!canAssignRole(role, input.role)) throw forbidden("You cannot grant this role");
  if (await first(c.env.DB, `SELECT 1 FROM users WHERE username = ?`, input.username)) throw new AppError(409, "USERNAME_TAKEN", "That username is already taken");
  await requireCapacity(c, orgId, "users");
  const id = newId();
  const password = temporaryPassword();
  const h = await hashPassword(password, iterations(c.env));
  if (!input.branches && (await actorBranches(c, orgId))) throw badRequest("Choose which of your branches this person works in");
  const access = input.branches ? await branchStatements(c, orgId, id, input.branches) : [];
  await batch(c.env.DB, [
    stmt(c.env.DB, `INSERT INTO users (id, email, username, name, password_hash, password_salt, password_iters, must_change_password) VALUES (?,?,?,?,?,?,?,1)`,
      id, `${input.username}.${id.slice(0, 8)}@users.ledgerfox.local`, input.username, input.name, h.hash, h.salt, h.iterations),
    stmt(c.env.DB, `INSERT INTO memberships (org_id, user_id, role) VALUES (?,?,?)`, orgId, id, input.role),
    ...access,
    audit(c, "member.create", "user", id, { username: input.username, role: input.role, branches: input.branches ?? null }, { orgId, companyId: null }),
  ]);
  return c.json({ id, username: input.username, temporary_password: password }, 201);
});

/** Replace a member's temporary password with a new random one (shown once) and sign them out everywhere. */
orgs.post("/:orgId/members/:userId/temporary-password", async (c) => {
  const orgId = c.req.param("orgId");
  const targetId = c.req.param("userId");
  await assertManages(c, orgId, targetId);
  const { role } = await requireOrgPerm(c, orgId, "org.manage");
  const current = await first<{ role: Role }>(c.env.DB, `SELECT role FROM memberships WHERE org_id = ? AND user_id = ?`, orgId, targetId);
  if (!current) throw notFound("Member");
  if (current.role === "owner" || !canAssignRole(role, current.role)) throw forbidden("You cannot reset this member's password");
  const orgCount = await first<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM memberships WHERE user_id = ?`, targetId);
  if ((orgCount?.n ?? 0) > 1) throw forbidden("This user belongs to other organisations and must use their own recovery codes");
  const password = temporaryPassword();
  const h = await hashPassword(password, iterations(c.env));
  await batch(c.env.DB, [
    // A lost phone is the usual reason for a reset, so two-factor sign-in is switched off too (they set it up again).
    stmt(c.env.DB, `UPDATE users SET password_hash = ?, password_salt = ?, password_iters = ?, must_change_password = 1, totp_enabled = 0, totp_secret = NULL, totp_last_step = NULL WHERE id = ?`, h.hash, h.salt, h.iterations, targetId),
    stmt(c.env.DB, `DELETE FROM sessions WHERE user_id = ?`, targetId),
    audit(c, "member.temporary_password", "user", targetId, undefined, { orgId, companyId: null }),
  ]);
  return c.json({ temporary_password: password });
});

/** Which branches of a company a member may use. */
orgs.put("/:orgId/members/:userId/branches", async (c) => {
  const orgId = c.req.param("orgId");
  const targetId = c.req.param("userId");
  await assertManages(c, orgId, targetId);
  const { role } = await requireOrgPerm(c, orgId, "org.manage");
  const input = await body(c, branchAccess);
  const current = await first<{ role: Role }>(c.env.DB, `SELECT role FROM memberships WHERE org_id = ? AND user_id = ?`, orgId, targetId);
  if (!current) throw notFound("Member");
  if (current.role === "owner") throw forbidden("Owners always have every branch");
  if (!canAssignRole(role, current.role)) throw forbidden("You cannot change this member's branches");
  await batch(c.env.DB, [...(await branchStatements(c, orgId, targetId, input)), audit(c, "member.branches", "user", targetId, input, { orgId, companyId: input.company_id })]);
  return c.json({ ok: true });
});

/** Role permission matrix: defaults plus this organisation's customisations. */
orgs.get("/:orgId/roles", async (c) => {
  const orgId = c.req.param("orgId");
  await requireOrgPerm(c, orgId, "org.manage");
  const rows = await all<{ role: Role; permission: string; allowed: number }>(c.env.DB, `SELECT role, permission, allowed FROM role_permissions WHERE org_id = ?`, orgId);
  return c.json({
    roles: ROLES.map((r) => ({
      role: r,
      customised: rows.some((o) => o.role === r),
      defaults: defaultPermissions(r),
      permissions: effectivePermissions(r, rows.filter((o) => o.role === r)),
    })),
  });
});

/** Owner customises a role. Stored as differences from the defaults so later default improvements still apply. */
orgs.put("/:orgId/roles/:role", async (c) => {
  const orgId = c.req.param("orgId");
  await requireOrgPerm(c, orgId, "roles.manage");
  const parsed = assignableRole.safeParse(c.req.param("role"));
  if (!parsed.success) throw badRequest("The Owner role always has every permission and cannot be customised");
  const target = parsed.data;
  const input = await body(c, z.object({ permissions: z.array(z.string()).max(200) }));
  const wanted = new Set(input.permissions.filter((p) => ALL_PERMISSIONS.includes(p as Permission) && p !== "roles.manage"));
  const defaults = new Set<string>(defaultPermissions(target));
  const diffs = ALL_PERMISSIONS.filter((p) => p !== "roles.manage" && wanted.has(p) !== defaults.has(p));
  await batch(c.env.DB, [
    stmt(c.env.DB, `DELETE FROM role_permissions WHERE org_id = ? AND role = ?`, orgId, target),
    ...diffs.map((p) => stmt(c.env.DB, `INSERT INTO role_permissions (org_id, role, permission, allowed) VALUES (?,?,?,?)`, orgId, target, p, wanted.has(p) ? 1 : 0)),
    audit(c, "role.customise", "role", target, { permissions: [...wanted].sort() }, { orgId, companyId: null }),
  ]);
  return c.json({ ok: true, permissions: effectivePermissions(target, diffs.map((p) => ({ permission: p, allowed: wanted.has(p) ? 1 : 0 }))) });
});

/** Back to the default permissions for a role. */
orgs.delete("/:orgId/roles/:role", async (c) => {
  const orgId = c.req.param("orgId");
  await requireOrgPerm(c, orgId, "roles.manage");
  const parsed = assignableRole.safeParse(c.req.param("role"));
  if (!parsed.success) throw badRequest("The Owner role always has every permission and cannot be customised");
  const target = parsed.data;
  await batch(c.env.DB, [
    stmt(c.env.DB, `DELETE FROM role_permissions WHERE org_id = ? AND role = ?`, orgId, target),
    audit(c, "role.reset", "role", target, undefined, { orgId, companyId: null }),
  ]);
  return c.json({ ok: true });
});

orgs.delete("/:orgId/invitations/:id", async (c) => {
  const orgId = c.req.param("orgId");
  await requireOrgPerm(c, orgId, "org.manage");
  await batch(c.env.DB, [
    stmt(c.env.DB, `UPDATE invitations SET revoked_at = ? WHERE id = ? AND org_id = ? AND accepted_at IS NULL`, nowIso(), c.req.param("id"), orgId),
    audit(c, "member.invite_revoke", "invitation", c.req.param("id"), undefined, { orgId, companyId: null }),
  ]);
  return c.json({ ok: true });
});

orgs.patch("/:orgId/members/:userId", async (c) => {
  const orgId = c.req.param("orgId");
  const targetId = c.req.param("userId");
  await assertManages(c, orgId, targetId);
  const { role } = await requireOrgPerm(c, orgId, "org.manage");
  const input = await body(c, z.object({ role: assignableRole }));
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
  if (targetId !== c.get("user").id) await assertManages(c, orgId, targetId);
  const { role, perms } = await membership(c, orgId);
  const self = targetId === c.get("user").id;
  const current = await first<{ role: Role }>(c.env.DB, `SELECT role FROM memberships WHERE org_id = ? AND user_id = ?`, orgId, targetId);
  if (!current) throw notFound("Member");
  if (current.role === "owner") throw forbidden("The owner cannot be removed");
  if (!self && (!perms.includes("org.manage") || !canAssignRole(role, current.role))) throw forbidden();
  await batch(c.env.DB, [
    stmt(c.env.DB, `DELETE FROM memberships WHERE org_id = ? AND user_id = ?`, orgId, targetId),
    stmt(c.env.DB, `DELETE FROM member_branches WHERE org_id = ? AND user_id = ?`, orgId, targetId),
    audit(c, "member.remove", "user", targetId, { role: current.role }, { orgId, companyId: null }),
  ]);
  return c.json({ ok: true });
});

/** Owner/admin issues a one-time password reset link for a member (email-free recovery). */
orgs.post("/:orgId/members/:userId/reset-link", async (c) => {
  const orgId = c.req.param("orgId");
  const targetId = c.req.param("userId");
  await assertManages(c, orgId, targetId);
  const { role } = await requireOrgPerm(c, orgId, "org.manage");
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
