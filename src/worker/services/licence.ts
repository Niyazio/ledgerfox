import type { Env } from "../env";
import { first, run } from "../lib/db";
import { newId } from "../lib/crypto";
import { TRIAL_PLAN, type PlanId } from "@shared/plans";

/**
 * Desktop licences. The desktop app signs in to the customer's LedgerFox online account; the website then issues a
 * licence for that organisation's plan, signed with an Ed25519 key. The desktop app checks the signature offline,
 * and refreshes the licence whenever it has internet. Without a valid licence (never connected, plan ended, or more
 * than OFFLINE_DAYS without a check) there is no Free plan: everything stays viewable and exportable, but new entries
 * wait until the plan is renewed or checked again (see renewRequired). Nothing is ever deleted.
 */
export const OFFLINE_DAYS = 15;
export const DEFAULT_LICENCE_SERVER = "https://ledgerfox.niyazio.com";
const DAY = 86_400_000;
const ALG = { name: "Ed25519" } as const;

export interface LicencePayload {
  v: 1;
  org_id: string;
  org_name: string;
  email: string;
  plan: PlanId;                    // plan to apply on the desktop (already "free" when nothing is paid)
  status: string;                  // trial, active, grace, free
  plan_until: string | null;       // end of the trial, or of the paid period plus grace
  issued_at: string;
  check_by: string;                // issued_at + OFFLINE_DAYS: re-check online before this
  device_id: string;
  autopay_required?: boolean;      // trial not started yet: auto-pay must be set up on the website first
}

const enc = new TextEncoder();
const b64u = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (ch) => ch.charCodeAt(0));

// ── Website side ──

/** The signing key pair, created the first time a licence is issued. */
async function signingKey(env: Env): Promise<{ privateKey: CryptoKey; publicJwk: JsonWebKey }> {
  let row = await first<{ public_jwk: string; private_jwk: string }>(env.DB, `SELECT public_jwk, private_jwk FROM licence_keys ORDER BY created_at LIMIT 1`);
  if (!row) {
    const pair = (await crypto.subtle.generateKey(ALG, true, ["sign", "verify"])) as CryptoKeyPair;
    const pub = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const priv = await crypto.subtle.exportKey("jwk", pair.privateKey);
    await run(env.DB, `INSERT INTO licence_keys (id, public_jwk, private_jwk) VALUES (?, ?, ?)`, newId(), JSON.stringify(pub), JSON.stringify(priv));
    row = await first(env.DB, `SELECT public_jwk, private_jwk FROM licence_keys ORDER BY created_at LIMIT 1`);
  }
  const privateKey = await crypto.subtle.importKey("jwk", JSON.parse(row!.private_jwk), ALG, false, ["sign"]);
  return { privateKey, publicJwk: JSON.parse(row!.public_jwk) };
}

export async function licencePublicKey(env: Env) {
  return (await signingKey(env)).publicJwk;
}

export async function signLicence(env: Env, payload: LicencePayload) {
  const { privateKey } = await signingKey(env);
  const body = b64u(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign(ALG, privateKey, enc.encode(body)));
  return `${body}.${b64u(sig)}`;
}

// ── Desktop side ──

/** The payload of a licence, or null when the signature does not match the website's key. */
export async function verifyLicence(token: string, publicJwk: JsonWebKey): Promise<LicencePayload | null> {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  try {
    const key = await crypto.subtle.importKey("jwk", publicJwk, ALG, false, ["verify"]);
    if (!(await crypto.subtle.verify(ALG, key, unb64u(sig), enc.encode(body)))) return null;
    const p = JSON.parse(new TextDecoder().decode(unb64u(body))) as LicencePayload;
    return p.v === 1 ? p : null;
  } catch { return null; }
}

export const licensingOn = (env: Env) => env.APP_ENV === "desktop" && env.DESKTOP_LICENSING !== "off";
export const licenceServer = (env: Env) => (env.LICENCE_SERVER && /^https?:\/\/[^/]+$/.test(env.LICENCE_SERVER) ? env.LICENCE_SERVER : DEFAULT_LICENCE_SERVER);

interface StoredLicence { server: string; token: string; public_jwk: string; device_token: string; account_email: string | null; last_checked_at: string | null; last_error: string | null }

export async function storedLicence(env: Env) {
  return first<StoredLicence>(env.DB, `SELECT server, token, public_jwk, device_token, account_email, last_checked_at, last_error FROM desktop_licence WHERE id = 1`);
}

export interface DesktopLicenceState {
  connected: boolean;
  plan: PlanId;
  status: "trial" | "active" | "grace" | "free";
  reason: "not_connected" | "ok" | "plan_ended" | "check_overdue" | "invalid" | "autopay_required";
  org_name: string | null;
  email: string | null;
  plan_until: string | null;
  check_by: string | null;
  last_checked_at: string | null;
  last_error: string | null;
}

/** What this computer may use now. Plans are applied only with a valid, current licence; otherwise renewal is required. */
export async function desktopLicenceState(env: Env, now = Date.now()): Promise<DesktopLicenceState> {
  const row = await storedLicence(env);
  const base = { org_name: null, email: null, plan_until: null, check_by: null, last_checked_at: row?.last_checked_at ?? null, last_error: row?.last_error ?? null };
  if (!row) return { ...base, connected: false, plan: "free", status: "free", reason: "not_connected" };
  const p = await verifyLicence(row.token, JSON.parse(row.public_jwk));
  if (!p) return { ...base, connected: true, plan: "free", status: "free", reason: "invalid" };
  const info = { ...base, connected: true, org_name: p.org_name, email: p.email, plan_until: p.plan_until, check_by: p.check_by };
  if (Date.parse(p.check_by) < now) return { ...info, plan: "free", status: "free", reason: "check_overdue" };
  if (p.autopay_required) return { ...info, plan: "free", status: "free", reason: "autopay_required" };
  if (p.plan === "free" || (p.plan_until && Date.parse(p.plan_until) < now)) return { ...info, plan: "free", status: "free", reason: "plan_ended" };
  const status = p.status === "trial" || p.status === "grace" ? p.status : "active";
  return { ...info, plan: status === "trial" ? TRIAL_PLAN : p.plan, status, reason: "ok" };
}

/** Ask the website for a fresh licence (needs internet). Records the error, and keeps the old licence, when it fails. */
export async function refreshDesktopLicence(env: Env): Promise<boolean> {
  const row = await storedLicence(env);
  if (!row) return false;
  try {
    const res = await fetch(`${row.server}/api/licence/refresh`, {
      method: "POST", headers: { "content-type": "application/json", "x-requested-with": "ledgerfox" }, body: JSON.stringify({ device_token: row.device_token }),
    });
    const data = (await res.json().catch(() => ({}))) as { token?: string; error?: { message?: string } };
    if (!res.ok || !data.token) throw new Error(data.error?.message ?? `The LedgerFox website answered ${res.status}`);
    if (!(await verifyLicence(data.token, JSON.parse(row.public_jwk)))) throw new Error("The licence from the website could not be verified");
    await run(env.DB, `UPDATE desktop_licence SET token = ?, last_checked_at = ?, last_error = NULL, updated_at = ? WHERE id = 1`, data.token, new Date().toISOString(), new Date().toISOString());
    return true;
  } catch (e) {
    await run(env.DB, `UPDATE desktop_licence SET last_error = ?, updated_at = ? WHERE id = 1`, String((e as Error).message ?? e).slice(0, 300), new Date().toISOString());
    return false;
  }
}

let refreshing: Promise<boolean> | null = null;
/** At most one background check every 6 hours while the app is used. Never blocks a request. */
export function refreshInBackground(env: Env, lastChecked: string | null) {
  if (refreshing || (lastChecked && Date.now() - Date.parse(lastChecked) < DAY / 4)) return;
  refreshing = refreshDesktopLicence(env).finally(() => { refreshing = null; });
}
export const licenceDays = (iso: string | null, now = Date.now()) => (iso ? Math.max(0, Math.ceil((Date.parse(iso) - now) / DAY)) : null);
