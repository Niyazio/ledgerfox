import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { all, first, run } from "../lib/db";
import { AppError, badRequest, forbidden, notFound } from "../lib/errors";
import { body, shortText } from "../lib/validate";
import { orgPermissions, requireAuth } from "../lib/auth";
import { billingEvent, isVendor, orgBillingCurrency } from "../services/billing";
import { educationAccess, educationEnforced, listEducationAccess, unapprovedPracticeOwners } from "../services/education";
import { EDUCATION_FREE_DEVICES, EDUCATION_PACK_IDS, EDUCATION_PACK_MONTHS, EDUCATION_PACKS, type EducationPackId } from "@shared/plans";

/** Education mode: the owner's view (devices, packs) and LedgerFox's approvals in the admin panel. */
export const education = new Hono<AppEnv>();
education.use("*", requireAuth);

const packs = () => EDUCATION_PACK_IDS.map((id) => EDUCATION_PACKS[id]);

/** Is the signed-in person approved for education mode? */
education.get("/me", async (c) => {
  const email = c.get("user").email;
  const vendor = isVendor(c.env, email);
  const access = await educationAccess(c.env, email);
  return c.json({ enforced: educationEnforced(c.env), approved: !educationEnforced(c.env) || vendor || Boolean(access), access, free_devices: EDUCATION_FREE_DEVICES, pack_months: EDUCATION_PACK_MONTHS, packs: packs() });
});

/** The organisation's owner (or anyone who manages it) sees the devices and can free one. */
async function manager(c: Context<AppEnv>, orgId: string) {
  const m = await first<{ role: string }>(c.env.DB, `SELECT role FROM memberships WHERE org_id = ? AND user_id = ?`, orgId, c.get("user").id);
  if (!m) throw notFound("Organisation");
  if (m.role !== "owner" && !(await orgPermissions(c.env.DB, orgId, m.role as never)).includes("org.manage")) throw forbidden();
}

education.get("/orgs/:orgId", async (c) => {
  const orgId = c.req.param("orgId");
  await manager(c, orgId);
  const owner = await first<{ email: string }>(c.env.DB, `SELECT u.email FROM organisations o JOIN users u ON u.id = o.owner_user_id WHERE o.id = ?`, orgId);
  const practice = await first<{ id: string; name: string }>(c.env.DB, `SELECT id, name FROM companies WHERE org_id = ? AND is_practice = 1 LIMIT 1`, orgId);
  const devices = await all(c.env.DB,
    `SELECT d.device_id, d.label, d.first_seen_at, d.last_seen_at, u.name AS user_name, u.email AS user_email
       FROM education_devices d LEFT JOIN users u ON u.id = d.user_id WHERE d.org_id = ? ORDER BY d.last_seen_at DESC`, orgId);
  const access = await educationAccess(c.env, owner?.email);
  const requested = await first<{ created_at: string; details: string }>(c.env.DB,
    `SELECT created_at, details FROM billing_events WHERE org_id = ? AND kind = 'education_pack_requested' ORDER BY created_at DESC LIMIT 1`, orgId);
  return c.json({
    enforced: educationEnforced(c.env), practice_company: practice, approved: !educationEnforced(c.env) || isVendor(c.env, owner?.email) || Boolean(access),
    access, allowed: access?.devices ?? EDUCATION_FREE_DEVICES, devices, packs: packs(), pack_months: EDUCATION_PACK_MONTHS,
    currency: await orgBillingCurrency(c.env, orgId), last_request: requested ? { at: requested.created_at, ...JSON.parse(requested.details ?? "{}") } : null,
  });
});

education.delete("/orgs/:orgId/devices/:deviceId", async (c) => {
  const orgId = c.req.param("orgId");
  await manager(c, orgId);
  const r = await run(c.env.DB, `DELETE FROM education_devices WHERE org_id = ? AND device_id = ?`, orgId, c.req.param("deviceId"));
  if (!r.meta.changes) throw notFound("Device");
  await billingEvent(c.env, orgId, "education_device_removed", { device: c.req.param("deviceId") }, c.get("user").email, c.get("user").id);
  return c.json({ ok: true });
});

/** Ask LedgerFox for a student pack; LedgerFox sends the payment link and switches it on in the admin panel. */
education.post("/orgs/:orgId/request", async (c) => {
  const orgId = c.req.param("orgId");
  await manager(c, orgId);
  const input = await body(c, z.object({ pack: z.enum(EDUCATION_PACK_IDS as [EducationPackId, ...EducationPackId[]]), note: shortText(500).nullish() }));
  const recent = await first<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM billing_events WHERE org_id = ? AND kind = 'education_pack_requested' AND created_at > ?`,
    orgId, new Date(Date.now() - 86_400_000).toISOString());
  if ((recent?.n ?? 0) >= 3) throw new AppError(429, "TOO_MANY_REQUESTS", "Your request has already been sent. LedgerFox will contact you soon.");
  await billingEvent(c.env, orgId, "education_pack_requested", { pack: input.pack, students: EDUCATION_PACKS[input.pack].students, note: input.note ?? null, email: c.get("user").email }, c.get("user").email, c.get("user").id);
  return c.json({ ok: true });
});

// ── LedgerFox staff (admin panel) ──

const vendorOnly = (c: Context<AppEnv>) => { if (!isVendor(c.env, c.get("user").email)) throw notFound("Page"); };

education.get("/admin", async (c) => {
  vendorOnly(c);
  const requests = await all(c.env.DB,
    `SELECT e.created_at, e.details, e.org_id, o.name AS org_name, u.email AS owner_email FROM billing_events e
       LEFT JOIN organisations o ON o.id = e.org_id LEFT JOIN users u ON u.id = o.owner_user_id
      WHERE e.kind = 'education_pack_requested' ORDER BY e.created_at DESC LIMIT 50`);
  return c.json({ access: await listEducationAccess(c.env), unapproved: await unapprovedPracticeOwners(c.env), requests: requests.map((r: any) => ({ ...r, details: JSON.parse(r.details ?? "{}") })),
    packs: packs(), free_devices: EDUCATION_FREE_DEVICES, pack_months: EDUCATION_PACK_MONTHS });
});

const emailParam = (c: Context<AppEnv>) => {
  const email = decodeURIComponent(c.req.param("email") ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw badRequest("Enter a valid email");
  return email;
};

/** Approve an email (or change it): its devices, and optionally a student pack for N months (default 6). */
education.put("/admin/:email", async (c) => {
  vendorOnly(c);
  const email = emailParam(c);
  const input = await body(c, z.object({
    devices: z.number().int().min(1).max(1000).optional(),
    pack: z.enum(EDUCATION_PACK_IDS as [EducationPackId, ...EducationPackId[]]).nullable().optional(),
    months: z.number().int().min(1).max(36).optional(),
    note: shortText(500).nullish(),
  }));
  const cur = await first<{ pack: string | null; pack_until: string | null }>(c.env.DB, `SELECT pack, pack_until FROM education_access WHERE email = ?`, email);
  let pack = cur?.pack ?? null, until = cur?.pack_until ?? null;
  if (input.pack === null) { pack = null; until = null; }
  else if (input.pack) {
    // The same pack again extends it from its end; a different pack starts now.
    const start = cur?.pack === input.pack && until && Date.parse(until) > Date.now() ? new Date(until) : new Date();
    start.setUTCMonth(start.getUTCMonth() + (input.months ?? EDUCATION_PACK_MONTHS));
    pack = input.pack; until = start.toISOString();
  }
  const now = new Date().toISOString();
  await run(c.env.DB,
    `INSERT INTO education_access (email, devices, pack, pack_until, note, granted_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT (email) DO UPDATE SET devices = COALESCE(?, devices), pack = excluded.pack, pack_until = excluded.pack_until,
       note = COALESCE(excluded.note, note), granted_by = excluded.granted_by, updated_at = excluded.updated_at, revoked_at = NULL`,
    email, input.devices ?? EDUCATION_FREE_DEVICES, pack, until, input.note ?? null, c.get("user").email, now, now, input.devices ?? null);
  await billingEvent(c.env, null, "education_access_granted", { email, devices: input.devices ?? null, pack, pack_until: until }, c.get("user").email);
  return c.json({ access: await educationAccess(c.env, email) });
});

/** Take education mode away: the email's practice companies stop opening (their data is kept). */
education.delete("/admin/:email", async (c) => {
  vendorOnly(c);
  const email = emailParam(c);
  const r = await run(c.env.DB, `UPDATE education_access SET revoked_at = ?, updated_at = ? WHERE email = ? AND revoked_at IS NULL`, new Date().toISOString(), new Date().toISOString(), email);
  if (!r.meta.changes) throw notFound("Education access");
  await billingEvent(c.env, null, "education_access_revoked", { email }, c.get("user").email);
  return c.json({ ok: true });
});
