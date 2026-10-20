# Security

## Implemented

| Area | Measure |
|---|---|
| Passwords | PBKDF2-SHA256 with per-user 16-byte salt; minimum 10 characters; constant-time comparison; equal-time response for unknown emails. Work factor stored per user and **upgraded on next login** when `PBKDF2_ITERATIONS` increases. |
| Sessions | 256-bit random token in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie with the `__Host-` prefix on HTTPS; only its SHA-256 is stored. 14-day expiry. Password change/recovery revokes other sessions. "Sign out everywhere". |
| Account recovery | No email dependency: 8 one-time recovery codes (stored hashed) and owner/admin-issued one-time reset links (24 h, hashed; refused for users who belong to other organisations). |
| CSRF | Mutations require `X-Requested-With: ledgerfox` (forces a CORS preflight that is never approved cross-origin) and a same-host `Origin` when present; plus `SameSite=Lax`. |
| Tenant isolation | Every company route resolves the company **through the caller's membership**; non-members get 404. All queries filter by `company_id`; composite foreign keys reject cross-company references in the database. Tested by direct cross-tenant inserts. D1 has no row-level security, so isolation relies on server code + constraints. |
| Authorisation | Five roles with a permission matrix (`src/shared/permissions.ts`), checked server-side on every mutation; admins cannot create admins; segregation of duties for expense approval. |
| Ledger integrity | Database triggers enforce balance, period locks, immutability of posted data, append-only audit log, allocation limits, non-negative stock. |
| Input validation | Zod schemas on every body; decimal parsing without floats; GSTIN check digit; date validation; size limits. |
| SQL injection | All queries are parameterised (`prepare().bind()`); dynamic SQL uses fixed table/column whitelists only. Tested. |
| Rate limiting | D1-backed fixed windows: login 10/15 min per email and 30/15 min per IP; registration 10/h per IP; recovery 10/15 min per IP. |
| Uploads | PDF/PNG/JPEG/WebP only, magic-byte sniffing, ≤ 1 MB, ≤ 10 per record, served with `nosniff`, sandboxing CSP and company scoping. |
| Headers | Strict CSP (`script-src 'self'`), `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, Referrer-Policy, Permissions-Policy. |
| CSV exports | Formula injection neutralised (`=`, `+`, `-`, `@` prefixes). |
| Errors | Internal errors return a generic message + request ID; details only go to Workers Logs. |
| Secrets | None required. `.dev.vars`, `.env` and `backups/` are git-ignored. No privileged credentials reach the browser (the browser never talks to D1). |
| Dependencies | `npm audit --omit=dev`: **0 vulnerabilities** (after upgrading react-router to 7.18.4). CI fails on high-severity production advisories. |

## Known limitations (be aware before production use)

1. **Password work factor is reduced for the free plan.** 100,000 PBKDF2 iterations measured ~22 ms CPU, above the
   Workers Free 10 ms per-request CPU limit, so the default is 50,000 (~9 ms). This is below current OWASP guidance
   (600,000 for PBKDF2-SHA256). On a paid Workers plan set `PBKDF2_ITERATIONS=100000` (the Workers maximum); hashes
   upgrade automatically at next login.
2. **No multi-factor authentication** yet.
3. **No email verification** (no email provider). Invitation acceptance requires the logged-in email to match the
   invited email, but registration itself does not prove email ownership.
4. Rate limiting is per-isolate-consistent via D1 but is not a WAF; Cloudflare's free DDoS protection applies in front.
5. Attachments are stored in D1 (not encrypted at the application layer; D1 encrypts at rest per Cloudflare).
6. Audit log immutability is enforced by triggers; someone with Cloudflare account access could still alter the database.
7. Dev-tooling advisories: `undici` inside `wrangler`/`miniflare` (local development only, never deployed).
8. No independent penetration test has been performed.
9. **Data on the device (offline mode).** To work offline, the browser keeps copies of the JSON pages a user has
   opened (Cache Storage) and any records created offline that are not yet sent (IndexedDB). These copies are not
   encrypted by the app; anyone with access to the unlocked device and browser profile could read them. Signing out
   deletes them (and warns first if unsent records exist); a different user signing in on the same browser clears the
   cached pages. Exports, attachments and other downloads are never cached. Use device encryption and a screen lock,
   and do not use shared computers without signing out.
10. **Replay protection.** Offline records carry an `Idempotency-Key`; the server stores the first successful response
    per (company, user, key) for 7 days and replays it for repeats, so a record is never created twice. Keys are scoped
    to the signed-in user, so one member cannot read another member's stored response.

## Desktop edition

- Data stays in the user's file; nothing leaves the computer unless phone or internet access is turned on.
- The data file and its automatic backups are **not encrypted** by LedgerFox. Use OS login passwords and
  BitLocker/FileVault. Anyone who can copy the file can read it with SQLite tools.
- Only the first user can register; others are invited. Passwords use PBKDF2-SHA256 at 100,000 iterations (the
  maximum the cloud runtime accepts, kept so a file can later move to the cloud).
- Same-Wi-Fi access is plain http inside the local network: anyone on that network who can capture traffic could see
  session cookies. Enable it only on trusted networks; Windows firewall should allow private networks only.
- Internet link: https via Cloudflare; LedgerFox login always required; optional Cloudflare email one-time code in
  front. Client IPs are taken from Cloudflare's header only for requests that arrive through the local tunnel process.
  The random address is the only thing that changes; it is not a secret and must not be relied on for protection.
- Installers are unsigned (no paid certificates), so users see OS warnings and cannot verify the publisher; download
  only from the project's GitHub Releases.
- The window shows only LedgerFox (`127.0.0.1`); other links open in the system browser. Renderer is sandboxed,
  context-isolated, with no Node integration.

## Features added in v0.2

- **Default desktop sign-in (admin / admin):** seeded only in the desktop edition, flagged `must_change_password`;
  every API except changing the password returns `PASSWORD_CHANGE_REQUIRED` until it is changed; it is refused from
  any address other than the computer itself; "admin" cannot be reused as the new password. The cloud edition has no
  default account. Staff accounts created by an owner also start with a temporary password that must be changed.
- **Usernames:** case-insensitive and unique; login accepts username or email with the same rate limits.
- **QR verification:** 128-bit random tokens per document/payment/payslip, created only by members of that company;
  the public lookup is rate-limited and returns number, date, amount, status, issuer and party name only. Payslip
  tokens reveal the employee's name and net pay to whoever holds the printed payslip.
- **Payroll data** is readable only with `payroll.read` (owner, admin, accountant, auditor); posted payroll and its
  payslips are frozen by database triggers.
- **Demo companies:** deletable only when flagged `is_demo`; a trigger on `company_purge` refuses real companies, so
  the posted-record guards cannot be bypassed for real books.
- **AdSense:** loaded only on the public home, download and privacy pages of the cloud website, with a relaxed CSP on
  those three paths only. Links into the app do full page loads, so ad code is never present on sign-in, app,
  verification or desktop pages. The strict CSP still applies everywhere else.
- **Android app:** a launcher that only opens http(s) addresses after confirming `/api/health` is LedgerFox;
  cleartext is enabled for office-network addresses (same caveat as Wi-Fi access).

## Reporting

Report vulnerabilities privately to the repository owner. Do not open public issues for security problems.
