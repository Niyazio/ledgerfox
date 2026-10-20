# Costs and free-tier limits

**Mandatory recurring cost: ₹0.** Nothing in the core app requires a paid plan, credit card, paid API, paid email,
paid auth, paid AI or payment gateway. Verified against Cloudflare's documentation on 20 Oct 2026.

## Services used

| Service | Plan | Verified free allowance | What happens at the limit |
|---|---|---|---|
| Cloudflare Workers | Free | 100,000 requests/day; **10 ms CPU per request**; 128 MB memory; static asset requests free & unlimited; Workers Logs included (7 days) | Error 1027 for the rest of the UTC day (no charge) |
| Cloudflare D1 | Free | 5 GB total storage; 5M rows read/day; 100k rows written/day | Since 1 Sep 2026 queries fail until midnight UTC (no charge); email alert sent |
| Workers Builds | Free | Git-connected builds on the Free plan (build-minute quota not re-verified here — check the Builds limits page) | Builds queue/fail; manual `wrangler deploy` still works |
| GitHub Actions (CI) | Free for public repos; 2,000 min/month for private repos on GitHub Free | CI blocked until next month; deploys are unaffected |
| Custom domain | Your existing subdomain on a Cloudflare zone | DNS + certificate free | — |

Unverified (could not fetch the exact limits page from this environment): per-database maximum size on Free
(historically 500 MB), D1 Time Travel retention on Free (historically 7 days), bound-parameter limit (historically 100).
The app's largest query binds ~20 parameters.

## What the free limits mean in practice

- A typical page view makes 1–4 API calls; a small team (5 people, ~400 page views/day each) uses ~8,000 requests/day.
- Posting an invoice writes roughly 15–30 rows (header, lines, journal, lines, sequence, audit). 100k writes/day
  ≈ 3,000+ invoices/day.
- Storage: ~1–2 KB per journal line; 5 GB holds millions of lines, but receipts (≤ 1 MB each) consume it fastest.
- CPU: report aggregation runs inside D1 (not counted as Worker CPU). Password hashing is the heaviest step (~9 ms).

## Desktop edition

Free: MIT-licensed app, data on the user's computer, Electron and SQLite (open source), installers built on GitHub
Actions (free for public repositories; macOS minutes count 10× on private repositories), optional Cloudflare Quick
Tunnel (no account or card; temporary, no uptime guarantee). Optional costs only if you choose them: Windows
code-signing certificate, Apple Developer Program (US$99/year) for signed/notarised macOS builds.

## Possible charges — only if you choose them

| Action | Charge |
|---|---|
| Upgrading to Workers Paid (higher CPU, more requests, higher PBKDF2 work factor) | Billed by Cloudflare (currently $5/month minimum) — **not required** |
| Moving receipts to R2 | R2 requires a payment method on file even within its free tier — **not used** |
| Private repo CI beyond 2,000 min/month | GitHub billing — make the repo public or reduce CI runs |
| Email notifications / e-invoicing / GST filing APIs | Not implemented; would need third-party services |

Free tiers are not guarantees: they have no SLA, can change, and Cloudflare may alter limits. Keep regular backups.

## Jurisdictions

| Jurisdiction | Status | Notes |
|---|---|---|
| India | **Partial** | GST codes (5/18/40% and special 3%/0.25%, legacy 12%/28% inactive), CGST+SGST vs IGST by place of supply, GSTIN check digit, HSN/SAC, Tax Invoice / Bill of Supply titles, GST summary, input tax credit accounts. **Not implemented:** GSTR-1/3B JSON, e-invoicing (IRN/QR), e-way bills, TDS/TCS computation, reverse charge postings, compensation cess. |
| Others | **Partial** | Single-rate sales tax/VAT codes with input/output tax accounts, any of 23 currencies, configurable fiscal year and number formats. No country-specific returns or invoice rules. |
