/**
 * Education mode by invitation. LedgerFox approves the emails that may run practice companies; each organisation
 * with a practice company may use it on a limited number of devices (10 free, or a 25 / 50 / 100 student pack for
 * 6 months). An organisation holds at most one demo or practice company, so classes stay light on the servers.
 * Applies to the hosted edition with billing on; self-hosted copies and LedgerFox staff are not limited.
 */
import type { Context } from "hono";
import type { AppEnv, Env } from "../env";
import { all, first, run } from "../lib/db";
import { AppError } from "../lib/errors";
import { getCookie, setCookie } from "hono/cookie";
import { randomToken } from "../lib/crypto";
import { billingOn, isVendor } from "./billing";
import { EDUCATION_PACKS, type EducationPackId } from "@shared/plans";

export const educationEnforced = (env: Env) => billingOn(env);

export interface EducationAccess {
  email: string;
  devices: number;          // devices allowed now (pack or base)
  base_devices: number;
  pack: EducationPackId | null;
  pack_until: string | null;
  pack_active: boolean;
  note: string | null;
  created_at: string;
}

interface Row { email: string; devices: number; pack: EducationPackId | null; pack_until: string | null; note: string | null; created_at: string; revoked_at: string | null }

function shape(r: Row, now = Date.now()): EducationAccess {
  const active = Boolean(r.pack && r.pack_until && Date.parse(r.pack_until) > now);
  return {
    email: r.email, base_devices: r.devices, pack: r.pack, pack_until: r.pack_until, pack_active: active, note: r.note, created_at: r.created_at,
    devices: Math.max(r.devices, active ? EDUCATION_PACKS[r.pack!].students : 0),
  };
}

/** The approved education access for an email, or null (none, or revoked). */
export async function educationAccess(env: Env, email: string | null | undefined): Promise<EducationAccess | null> {
  if (!email) return null;
  const r = await first<Row>(env.DB, `SELECT email, devices, pack, pack_until, note, created_at, revoked_at FROM education_access WHERE email = ?`, email.toLowerCase());
  return r && !r.revoked_at ? shape(r) : null;
}

export async function listEducationAccess(env: Env) {
  const rows = await all<Row & { orgs: number; used: number }>(env.DB,
    `SELECT a.email, a.devices, a.pack, a.pack_until, a.note, a.created_at, a.revoked_at,
            (SELECT COUNT(*) FROM organisations o JOIN users u ON u.id = o.owner_user_id WHERE lower(u.email) = a.email
               AND EXISTS (SELECT 1 FROM companies c WHERE c.org_id = o.id AND c.is_practice = 1)) AS orgs,
            (SELECT COUNT(*) FROM education_devices d JOIN organisations o ON o.id = d.org_id JOIN users u ON u.id = o.owner_user_id WHERE lower(u.email) = a.email) AS used
       FROM education_access a ORDER BY a.revoked_at IS NOT NULL, a.updated_at DESC LIMIT 500`);
  return rows.map((r) => ({ ...shape(r), revoked_at: r.revoked_at, orgs: r.orgs, used: r.used }));
}

/** Owners of practice companies whose email is not approved (for the admin panel). */
export async function unapprovedPracticeOwners(env: Env) {
  return all<{ email: string; name: string; org_id: string; org_name: string; company: string }>(env.DB,
    `SELECT lower(u.email) AS email, u.name, o.id AS org_id, o.name AS org_name, c.name AS company
       FROM companies c JOIN organisations o ON o.id = c.org_id JOIN users u ON u.id = o.owner_user_id
      WHERE c.is_practice = 1 AND NOT EXISTS (SELECT 1 FROM education_access a WHERE a.email = lower(u.email) AND a.revoked_at IS NULL)
      ORDER BY c.created_at DESC LIMIT 200`);
}

const notApproved = () => new AppError(403, "EDUCATION_NOT_APPROVED",
  "Education mode is given by LedgerFox to approved teachers, institutes and trainers. Ask for access at info@niyazio.com with the email you sign in with.");

/** Before a practice company is created: the person must be approved, and the organisation may not already hold a demo or practice company. */
export async function requirePracticeAllowed(c: Context<AppEnv>, orgId: string | null) {
  const user = c.get("user");
  if (educationEnforced(c.env) && !isVendor(c.env, user.email) && !(await educationAccess(c.env, user.email))) throw notApproved();
  if (orgId) await requireNoLearningCompany(c.env, orgId);
  else {
    const own = await first<{ name: string }>(c.env.DB,
      `SELECT o.name FROM organisations o WHERE o.owner_user_id = ? AND EXISTS (SELECT 1 FROM companies c WHERE c.org_id = o.id AND c.is_practice = 1) LIMIT 1`, user.id);
    if (own) throw new AppError(409, "LEARNING_COMPANY_EXISTS", `You already have a practice company (in “${own.name}”). Use that one: each account runs one education-mode organisation.`);
  }
}

/** One demo or practice company per organisation. */
export async function requireNoLearningCompany(env: Env, orgId: string) {
  const co = await first<{ name: string; is_demo: number }>(env.DB, `SELECT name, is_demo FROM companies WHERE org_id = ? AND (is_demo = 1 OR is_practice = 1) LIMIT 1`, orgId);
  if (co) throw new AppError(409, "LEARNING_COMPANY_EXISTS",
    `This organisation already has a ${co.is_demo ? "demo" : "practice"} company (“${co.name}”). Only one demo or practice company is allowed per organisation${co.is_demo ? ": delete the demo in its Settings first" : ""}.`);
}

const DEVICE_COOKIE = "lf_device";

/**
 * A device's id: the id the app keeps for this browser or phone, also kept in a long-lived cookie, so every request
 * from it — pages, downloads, older app versions — counts as the same device. Clearing the browser's data makes a new device,
 * which the owner can remove in Settings → Plan & billing.
 */
export function deviceId(c: Context<AppEnv>) {
  const ok = (v: string | undefined): v is string => Boolean(v && /^[A-Za-z0-9_-]{16,64}$/.test(v));
  const have = getCookie(c, DEVICE_COOKIE);
  // The app names its device in a header (stable even for its first requests, sent together); the cookie carries the
  // same id to downloads and links opened from it.
  const sent = c.req.header("x-ledgerfox-device");
  if (ok(sent)) { if (have !== sent) keepDeviceCookie(c, sent); return sent; }
  if (ok(have)) return have;
  const id = randomToken(18).replace(/[^A-Za-z0-9_-]/g, "");
  keepDeviceCookie(c, id);
  return id;
}

/** Browsers keep a cookie at most 400 days, so it is renewed while the device is in use. */
const keepDeviceCookie = (c: Context<AppEnv>, id: string) =>
  setCookie(c, DEVICE_COOKIE, id, { httpOnly: true, secure: new URL(c.req.url).protocol === "https:", sameSite: "Lax", path: "/", maxAge: 400 * 86400 });

function deviceLabel(ua: string | undefined) {
  const s = ua ?? "";
  const os = /Android/i.test(s) ? "Android" : /iPhone|iPad/i.test(s) ? "iPhone / iPad" : /Windows/i.test(s) ? "Windows" : /Mac OS/i.test(s) ? "Mac" : /Linux/i.test(s) ? "Linux" : "Device";
  const app = /Electron|LedgerFox/i.test(s) ? "desktop app" : /wv\)|Capacitor/i.test(s) ? "phone app" : /Edg\//.test(s) ? "Edge" : /Chrome\//.test(s) ? "Chrome" : /Firefox\//.test(s) ? "Firefox" : /Safari\//.test(s) ? "Safari" : "browser";
  return `${os} · ${app}`;
}

/**
 * Opening a practice company: its organisation's owner must still be approved, and this device must fit in the
 * allowance. A known device only refreshes its last-seen time (at most once an hour).
 */
export async function checkPracticeAccess(c: Context<AppEnv>) {
  const company = c.get("company");
  if (!company.is_practice || !educationEnforced(c.env) || isVendor(c.env, c.get("user").email)) return;
  const owner = await first<{ email: string }>(c.env.DB, `SELECT u.email FROM organisations o JOIN users u ON u.id = o.owner_user_id WHERE o.id = ?`, company.org_id);
  if (isVendor(c.env, owner?.email)) return;
  const access = await educationAccess(c.env, owner?.email);
  if (!access) throw new AppError(403, "EDUCATION_NOT_APPROVED",
    "This practice company is not open: education mode is given by LedgerFox to approved teachers and institutes. The organisation's owner can ask for access at info@niyazio.com.");
  const id = deviceId(c);
  const now = new Date();
  const known = await first<{ last_seen_at: string }>(c.env.DB, `SELECT last_seen_at FROM education_devices WHERE org_id = ? AND device_id = ?`, company.org_id, id);
  if (known) {
    if (now.getTime() - Date.parse(known.last_seen_at) > 3_600_000) {
      await run(c.env.DB, `UPDATE education_devices SET last_seen_at = ?, user_id = ? WHERE org_id = ? AND device_id = ?`, now.toISOString(), c.get("user").id, company.org_id, id);
      keepDeviceCookie(c, id);
    }
    return;
  }
  const used = (await first<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM education_devices WHERE org_id = ?`, company.org_id))?.n ?? 0;
  if (used >= access.devices) {
    const more = access.devices < 100 ? " For a bigger class, the owner can take a 25, 50 or 100 student pack (6 months) in Settings → Plan & billing." : "";
    throw new AppError(403, "EDUCATION_DEVICE_LIMIT", `This practice company is already used on ${access.devices} devices, the most allowed. The owner can remove a device they no longer use in Settings → Plan & billing.${more}`);
  }
  // INSERT OR IGNORE: two first requests from the same device at once must not fail.
  await run(c.env.DB, `INSERT OR IGNORE INTO education_devices (org_id, device_id, user_id, label, first_seen_at, last_seen_at) VALUES (?,?,?,?,?,?)`,
    company.org_id, id, c.get("user").id, deviceLabel(c.req.header("user-agent")), now.toISOString(), now.toISOString());
}

