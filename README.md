# Arthika — open-source double-entry accounting

Arthika is a cloud accounting application for small and growing businesses: invoicing, purchases, expenses,
banking, inventory, fixed assets and financial statements on a real double-entry ledger. It runs on the
Cloudflare Workers **Free** plan with a D1 (SQLite) database, with no paid services required.

> Status: **pilot-ready core, not a certified production ERP.** See [PROJECT_STATUS.md](PROJECT_STATUS.md).

## Highlights

- **Ledger integrity enforced in the database** — triggers reject unbalanced, back-dated (locked period) or
  edited posted entries even if application code is bypassed. Corrections use linked reversals.
- **Exact money** — integer minor units and BigInt arithmetic; no floating point in any financial calculation.
- **Multi-tenant** — organisations → companies, five roles, tenant-scoped composite foreign keys.
- **India GST** — CGST/SGST vs IGST by place of supply, GSTIN check-digit validation, HSN/SAC, GST summary.
  Other countries use single-rate tax codes. See the capability matrix in [COSTS.md](COSTS.md#jurisdictions).
- **Reports that reconcile** — trial balance, P&L, balance sheet, indirect cash flow, GL, ageing, statements,
  inventory valuation and budget vs actual all come from posted ledger lines and show reconciliation checks.
- **No paid AI** — rule-based category suggestions, duplicate-bill warnings, anomaly flags, bank-match
  suggestions, a cash projection and plain-language P&L summaries. Nothing posts without a person.

## Quick start (local)

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local      # applies migrations/ to a local D1 (SQLite) file
npm run dev                   # builds the UI and starts wrangler dev on http://127.0.0.1:8787
```

Open http://127.0.0.1:8787, create an account, save the recovery codes, and set up a company.

## Checks

```bash
npm run lint && npm run typecheck && npm test && npm run build
npm run test:e2e              # browser smoke test against a running `npm run dev`
```

## Deploy

See [DEPLOYMENT.md](DEPLOYMENT.md) (Cloudflare Workers Builds from GitHub, D1, custom subdomain).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `BRAND_NAME` | `Arthika` | Product name shown in the UI and API |
| `APP_ENV` | `production` | Informational |
| `PBKDF2_ITERATIONS` | `50000` | Password hashing work factor (max 100000 on Workers) — see SECURITY.md |
| `ALLOW_REGISTRATION` | `true` | Set `false` to stop new sign-ups (invitations still work) |

No secrets are required for the core application.

## Documentation

[ARCHITECTURE](ARCHITECTURE.md) · [DATABASE_SCHEMA](DATABASE_SCHEMA.md) · [DEPLOYMENT](DEPLOYMENT.md) ·
[SECURITY](SECURITY.md) · [COSTS](COSTS.md) · [TEST_REPORT](TEST_REPORT.md) · [PROJECT_STATUS](PROJECT_STATUS.md)

## Licence

MIT. Not affiliated with Tally, Zoho, Intuit or Sage. Not certified by any tax authority.
