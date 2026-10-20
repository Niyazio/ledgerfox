# Security

## Implemented

| Area | Measure |
|---|---|
| Passwords | PBKDF2-SHA256 with per-user 16-byte salt; minimum 10 characters; constant-time comparison; equal-time response for unknown emails. Work factor stored per user and **upgraded on next login** when `PBKDF2_ITERATIONS` increases. |
| Sessions | 256-bit random token in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie with the `__Host-` prefix on HTTPS; only its SHA-256 is stored. 14-day expiry. Password change/recovery revokes other sessions. "Sign out everywhere". |
| Account recovery | No email dependency: 8 one-time recovery codes (stored hashed) and owner/admin-issued one-time reset links (24 h, hashed; refused for users who belong to other organisations). |
| CSRF | Mutations require `X-Requested-With: arthika` (forces a CORS preflight that is never approved cross-origin) and a same-host `Origin` when present; plus `SameSite=Lax`. |
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

## Reporting

Report vulnerabilities privately to the repository owner. Do not open public issues for security problems.
