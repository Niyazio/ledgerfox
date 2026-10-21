# Security

## Implemented

| Area | Measure |
|---|---|
| Passwords | PBKDF2-SHA256 with per-user 16-byte salt; minimum 10 characters; constant-time comparison; equal-time response for unknown emails. Work factor stored per user and **upgraded on next login** when `PBKDF2_ITERATIONS` increases. |
| Sessions | 256-bit random token in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie with the `__Host-` prefix on HTTPS; only its SHA-256 is stored. 14-day expiry. Password change/recovery revokes other sessions. "Sign out everywhere". |
| Account recovery | No email dependency: 8 one-time recovery codes (stored hashed) and owner/admin-issued one-time reset links (24 h, hashed; refused for users who belong to other organisations). |
| CSRF | Mutations require `X-Requested-With: ledgerfox` (forces a CORS preflight that is never approved cross-origin) and a same-host `Origin` when present; plus `SameSite=Lax`. |
| Tenant isolation | Every company route resolves the company **through the caller's membership**; non-members get 404. All queries filter by `company_id`; composite foreign keys reject cross-company references in the database. Tested by direct cross-tenant inserts. D1 has no row-level security, so isolation relies on server code + constraints. |
| Authorisation | Seven roles and 39 permissions (`src/shared/permissions.ts`), resolved per request with the organisation's customisations and checked server-side on reads and writes; members limited to branches cannot list, open, edit or report on other branches' records; admins cannot create admins; only the owner customises roles; segregation of duties for expense and purchase approval. |
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

- **Desktop first sign-in:** (v0.2 used admin / admin; replaced in phase 2) the `admin` account gets a random
  one-time password at start-up, kept only in memory and shown only to requests from the computer itself (sign-in
  page, and the console for the headless server). Existing installs that never changed it get a new random one.
  It is flagged `must_change_password`; every API except changing the password returns `PASSWORD_CHANGE_REQUIRED`;
  it is refused from any other address. The cloud edition has no default account.
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

## Features added in v0.3

- **Phone copy:** one-time 144-bit codes, single use, 10-minute expiry, served only by the desktop app; the copy
  excludes sessions, recovery codes, reset tokens, rate limits, invitations and backup keys. On the phone it is stored
  in the app's private storage (IndexedDB) and opened by the same API code running in the app, read-only. Password
  hashes remain in the copy (needed to sign in offline); protect phones with a screen lock.
- **Offline session header:** only when the API runs inside the phone app (`APP_ENV=offline`) is the session token
  carried in `x-ledgerfox-session` (browsers drop Set-Cookie on script-made responses). The header is ignored by the
  cloud and desktop servers.
- **Cloud backup:** client-side AES-256-GCM encryption with a scrypt-derived key; the passphrase never leaves the
  computer (only the derived key is stored in `<data file>.cloud.json`, owner-only permissions). The desktop uses a
  revocable, hashed, backup-scoped key (`lfb_…`) that cannot read accounting data or mint more keys; sessions are
  not stored. Backups are per user; another user gets 404. Local backup controls accept only an owner/admin signed in
  on the computer itself.
- **Branding images:** PNG/JPEG/WebP data URLs only, magic bytes checked against the declared type, ≤ 300 KB, stored
  in `company_branding` (not loaded on ordinary requests); shown via `img-src data:`.
- **Auto-update:** electron-updater downloads from the project's GitHub Releases over HTTPS and checks the published
  SHA-512; installers are unsigned, so publisher identity is not verified by the OS.

## Phase 2 (multi-branch, roles)

- **Staff passwords:** the server generates a different random one-time password for every new user and for each
  reset (15 characters from a 54-character alphabet without look-alikes, ≈ 86 bits, unbiased rejection sampling).
  It is returned once to the owner/admin, stored only as a PBKDF2 hash, must be changed at first sign-in, and a reset
  signs the user out everywhere. Owners/admins never choose or see a member's real password.
- **Permissions** are enforced on the server for reads as well as writes (e.g. billing staff get 403 on bills and
  journals; purchase cost and stock value fields are removed from responses for members without cost access).
- **Branch isolation:** branch IDs sent by the browser are validated against the member's assignments; other
  branches' records answer 404; contact balances and daybook include only visible branches.
- **Approvals:** purchases above the limit cannot be posted without an approval by someone else with
  `purchase.approve` (self-approval refused unless owner); discounts above the limit need `sales.discount_any`.
- **Audit trail:** updates to documents, journals, expenses and items record previous → new values; the record
  history shows IP addresses only to members with `audit.read`.
- **QR codes on product labels** contain only `LF1|P|<product code>` — no prices, costs or other business data.

## Reporting

Report vulnerabilities privately to the repository owner. Do not open public issues for security problems.
