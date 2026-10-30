import { Hono } from "hono";
import { z } from "zod";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { all, first, run } from "../lib/db";
import { AppError, forbidden, notFound } from "../lib/errors";
import { body } from "../lib/validate";
import { newId, randomToken, sha256Hex } from "../lib/crypto";
import { clientIp, rateLimit, requireAuth } from "../lib/auth";
import { checkCredentials } from "./auth";
import { autopayRequired, subscription } from "../services/billing";
import { GRACE_DAYS } from "@shared/plans";
import {
  OFFLINE_DAYS, desktopLicenceState, licenceServer, licencePublicKey, licensingOn, refreshDesktopLicence, signLicence, verifyLicence, type LicencePayload,
} from "../services/licence";

const DAY = 86_400_000;

// ── Website: issues licences to desktop apps ──
export const licenceCloud = new Hono<AppEnv>();
licenceCloud.use("*", async (c, next) => {
  if (c.env.APP_ENV === "desktop" || c.env.APP_ENV === "offline") throw notFound("Page");
  await next();
});

licenceCloud.get("/public-key", async (c) => c.json({ public_key: await licencePublicKey(c.env) }));

/** Organisations a person may license a computer for: owner or admin, with at least one real (non-demo) company. */
const licensableOrgs = (c: Context<AppEnv>, userId: string) => all<{ id: string; name: string }>(c.env.DB,
  `SELECT o.id, o.name FROM memberships m JOIN organisations o ON o.id = m.org_id
   WHERE m.user_id = ? AND m.role IN ('owner','admin') AND EXISTS (SELECT 1 FROM companies co WHERE co.org_id = o.id AND co.is_demo = 0)
   ORDER BY o.created_at`, userId);

async function issue(c: Context<AppEnv>, orgId: string, user: { id: string; email: string }, deviceId: string) {
  const org = await first<{ name: string }>(c.env.DB, `SELECT name FROM organisations WHERE id = ?`, orgId);
  const sub = await subscription(c.env, orgId);
  const needsAutopay = await autopayRequired(c.env, orgId, user.email);
  const now = new Date();
  const until = sub.status === "trial" ? sub.trial_ends_at
    : (sub.status === "active" || sub.status === "grace") && sub.paid_until ? new Date(Date.parse(sub.paid_until) + GRACE_DAYS * DAY).toISOString()
    : null;
  const payload: LicencePayload = {
    v: 1, org_id: orgId, org_name: org?.name ?? "", email: user.email,
    plan: needsAutopay || sub.status === "free" ? "free" : sub.plan,
    status: needsAutopay ? "free" : sub.status === "unlimited" ? "active" : sub.status,
    plan_until: until, issued_at: now.toISOString(), check_by: new Date(now.getTime() + OFFLINE_DAYS * DAY).toISOString(), device_id: deviceId,
  };
  return { token: await signLicence(c.env, payload), autopay_required: needsAutopay };
}

/** Desktop app: "Connect your LedgerFox account". Same password, two-factor and rate-limit rules as the web sign-in. */
licenceCloud.post("/issue", async (c) => {
  const input = await body(c, z.object({
    login: z.string().trim().toLowerCase().min(1).max(254), password: z.string().min(1).max(200),
    totp: z.string().trim().max(10).optional(), recovery_code: z.string().trim().max(40).optional(),
    org_id: z.string().max(64).optional(), device_name: z.string().trim().max(80).optional(),
  }));
  const user = await checkCredentials(c, input);
  const orgs = await licensableOrgs(c, user.id);
  if (!orgs.length) throw new AppError(404, "NO_ORGANISATION", "This account has no company you own or administer yet. Create your company on ledgerfox.niyazio.com first, then connect again.");
  if (!input.org_id && orgs.length > 1) throw new AppError(409, "CHOOSE_ORG", "Choose which organisation this computer belongs to", { organisations: orgs });
  const org = input.org_id ? orgs.find((o) => o.id === input.org_id) : orgs[0];
  if (!org) throw forbidden("You are not an owner or administrator of that organisation");
  const deviceToken = randomToken(32);
  const deviceId = newId();
  await run(c.env.DB, `INSERT INTO desktop_devices (id, user_id, org_id, token_hash, device_name, last_seen_at) VALUES (?,?,?,?,?,?)`,
    deviceId, user.id, org.id, await sha256Hex(deviceToken), input.device_name ?? null, new Date().toISOString());
  await run(c.env.DB, `INSERT INTO audit_logs (id, org_id, user_id, action, entity_type, entity_id, details, ip) VALUES (?,?,?,?,?,?,?,?)`,
    newId(), org.id, user.id, "licence.device_connect", "desktop_device", deviceId, JSON.stringify({ device_name: input.device_name ?? null }), clientIp(c));
  const lic = await issue(c, org.id, user, deviceId);
  return c.json({ ...lic, device_token: deviceToken, public_key: await licencePublicKey(c.env), organisation: org, email: user.email });
});

/** Desktop app, daily when online: a fresh licence for the same computer. */
licenceCloud.post("/refresh", async (c) => {
  const input = await body(c, z.object({ device_token: z.string().min(20).max(200) }));
  if (!(await rateLimit(c.env.DB, `licence-refresh:${clientIp(c)}`, 120, 3600))) throw new AppError(429, "RATE_LIMITED", "Too many checks. Try again later.");
  const d = await first<{ id: string; user_id: string; org_id: string; revoked_at: string | null }>(c.env.DB,
    `SELECT id, user_id, org_id, revoked_at FROM desktop_devices WHERE token_hash = ?`, await sha256Hex(input.device_token));
  if (!d || d.revoked_at) throw new AppError(401, "DEVICE_REVOKED", "This computer is no longer connected. Connect your LedgerFox account again in Settings → Plan & billing.");
  const u = await first<{ id: string; email: string; is_disabled: number; role: string | null }>(c.env.DB,
    `SELECT u.id, u.email, u.is_disabled, m.role FROM users u LEFT JOIN memberships m ON m.user_id = u.id AND m.org_id = ? WHERE u.id = ?`, d.org_id, d.user_id);
  if (!u || u.is_disabled || !u.role || !["owner", "admin"].includes(u.role)) throw new AppError(401, "DEVICE_REVOKED", "The account that connected this computer no longer manages the organisation. Connect again.");
  await run(c.env.DB, `UPDATE desktop_devices SET last_seen_at = ? WHERE id = ?`, new Date().toISOString(), d.id);
  return c.json(await issue(c, d.org_id, u, d.id));
});

// ── Desktop app: holds the licence for this computer ──
export const licenceDesktop = new Hono<AppEnv>();
licenceDesktop.use("*", requireAuth, async (c, next) => {
  if (!licensingOn(c.env)) throw notFound("Page");
  await next();
});

/** Connecting and disconnecting is for an owner or administrator on this LedgerFox. */
async function requireManager(c: Context<AppEnv>) {
  const m = await first(c.env.DB, `SELECT 1 FROM memberships WHERE user_id = ? AND role IN ('owner','admin') LIMIT 1`, c.get("user").id);
  if (!m) throw forbidden("Only an owner or administrator can connect this computer to a LedgerFox account");
}

licenceDesktop.get("/", async (c) => c.json({ ...(await desktopLicenceState(c.env)), server: licenceServer(c.env), offline_days: OFFLINE_DAYS }));

licenceDesktop.post("/connect", async (c) => {
  await requireManager(c);
  const input = await body(c, z.object({
    login: z.string().trim().min(1).max(254), password: z.string().min(1).max(200),
    totp: z.string().trim().max(10).optional(), recovery_code: z.string().trim().max(40).optional(), org_id: z.string().max(64).optional(),
  }));
  const server = licenceServer(c.env);
  let res: Response;
  try {
    res = await fetch(`${server}/api/licence/issue`, {
      method: "POST", headers: { "content-type": "application/json", "x-requested-with": "ledgerfox" },
      body: JSON.stringify({ ...input, device_name: c.env.DEVICE_NAME ?? "LedgerFox desktop" }),
    });
  } catch {
    throw new AppError(503, "OFFLINE", "Could not reach ledgerfox.niyazio.com. Connect this computer to the internet and try again.");
  }
  const data = (await res.json().catch(() => ({}))) as { token?: string; public_key?: JsonWebKey; device_token?: string; email?: string; error?: { code: string; message: string; details?: unknown } };
  if (!res.ok || !data.token || !data.public_key || !data.device_token) {
    throw new AppError(res.status === 200 ? 502 : res.status, data.error?.code ?? "LICENCE_FAILED", data.error?.message ?? "The LedgerFox website did not issue a licence", data.error?.details);
  }
  if (!(await verifyLicence(data.token, data.public_key))) throw new AppError(502, "LICENCE_INVALID", "The licence could not be verified");
  const now = new Date().toISOString();
  await run(c.env.DB, `INSERT INTO desktop_licence (id, server, token, public_jwk, device_token, account_email, last_checked_at, updated_at) VALUES (1,?,?,?,?,?,?,?)
     ON CONFLICT (id) DO UPDATE SET server = excluded.server, token = excluded.token, public_jwk = excluded.public_jwk, device_token = excluded.device_token,
       account_email = excluded.account_email, last_checked_at = excluded.last_checked_at, last_error = NULL, updated_at = excluded.updated_at`,
    server, data.token, JSON.stringify(data.public_key), data.device_token, data.email ?? null, now, now);
  await run(c.env.DB, `INSERT INTO audit_logs (id, org_id, user_id, action, entity_type, details) SELECT ?, m.org_id, ?, 'licence.connect', 'desktop_licence', ? FROM memberships m WHERE m.user_id = ? LIMIT 1`,
    newId(), c.get("user").id, JSON.stringify({ account: data.email ?? null }), c.get("user").id);
  return c.json({ ...(await desktopLicenceState(c.env)), server, offline_days: OFFLINE_DAYS });
});

licenceDesktop.post("/refresh", async (c) => {
  await refreshDesktopLicence(c.env);
  return c.json({ ...(await desktopLicenceState(c.env)), server: licenceServer(c.env), offline_days: OFFLINE_DAYS });
});

licenceDesktop.post("/disconnect", async (c) => {
  await requireManager(c);
  await run(c.env.DB, `DELETE FROM desktop_licence WHERE id = 1`);
  return c.json({ ...(await desktopLicenceState(c.env)), server: licenceServer(c.env), offline_days: OFFLINE_DAYS });
});

