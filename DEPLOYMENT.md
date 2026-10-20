# Deployment

Target: **Cloudflare Workers (Free plan) + D1**, deployed automatically from GitHub by **Workers Builds**,
served on your own subdomain through a Workers **Custom Domain** (DNS record + TLS certificate created by Cloudflare).

## What was found in the environment (20 Oct 2026)

- Cloudflare account (connected): 18 existing Workers, including one named `accounting` (its source could not be read
  through the connector). **It was not modified.** This app deploys as a new Worker named `arthika`.
- No D1 databases and no Hyperdrive configs exist yet.
- Vercel account (connected): no projects, no domains.
- GitHub: this session cannot create repositories; it can only push to repositories you attach.
- The build container cannot reach the Cloudflare API, so the first deploy must be done through the dashboard
  (Workers Builds) or from your own machine with `wrangler`.

## Prerequisites

- The parent domain of your subdomain must be an **active zone in this Cloudflare account** (nameservers pointed at
  Cloudflare; free plan is fine). If the domain's DNS is hosted elsewhere, a Worker Custom Domain is not possible on the
  free plan (CNAME/partial setup requires Business). In that case, either move the domain's nameservers to Cloudflare,
  or use the free `arthika.<your-account>.workers.dev` URL.
- The chosen hostname must not already have a CNAME record (Cloudflare refuses Custom Domains on existing CNAMEs).

## One-time setup

### 1. Create the D1 database

Dashboard → **Storage & Databases → D1 → Create** → name `arthika` (location hint: Asia-Pacific for India).
Or locally: `npx wrangler d1 create arthika`.

Copy the **Database ID** into `wrangler.jsonc` (`d1_databases[0].database_id`) and commit.

### 2. Connect the repository (Workers Builds)

Dashboard → **Workers & Pages → Create application → Import a repository (GitHub)** → choose the repo.

| Setting | Value |
|---|---|
| Project / Worker name | `arthika` (must equal `name` in `wrangler.jsonc`) |
| Production branch | `main` |
| Build command | `npm run build` |
| Deploy command | `npm run deploy` (applies pending D1 migrations, then `wrangler deploy`) |
| Root directory | `/` |

If the build token lacks D1 permission and the migration step fails, apply migrations once from your machine:

```bash
npx wrangler login
npx wrangler d1 migrations apply arthika --remote
```

…and temporarily set the deploy command to `npx wrangler deploy`.

### 3. Attach your subdomain

Worker `arthika` → **Settings → Domains & Routes → Add → Custom Domain** → enter e.g. `books.example.com` → **Add**.
Cloudflare creates the DNS record and issues the certificate itself; there is no record for you to create by hand.
Exact DNS targets are not invented here because Cloudflare generates them.

Alternatively add to `wrangler.jsonc` and redeploy:

```jsonc
"routes": [{ "pattern": "books.example.com", "custom_domain": true }]
```

### 4. Verify

```bash
curl https://books.example.com/api/health
# {"status":"ok","db":"ok","version":"0.1.0",...}
BASE_URL=https://books.example.com node scripts/e2e.mjs   # creates a throwaway test account + company
```

Then sign up, save the recovery codes, and consider setting `ALLOW_REGISTRATION` to `"false"` in `wrangler.jsonc`
once your team has accounts (invitations keep working).

## Every deploy

Push to `main`: Workers Builds runs `npm run build` and `npm run deploy`. CI (`.github/workflows/ci.yml`, free
GitHub Actions minutes) runs lint, typecheck, tests, build and a production dependency audit on every push/PR.

Manual deploy from a machine: `npm ci && npm run build && npm run deploy`.

## Environment variables

Non-secret `vars` live in `wrangler.jsonc`: `BRAND_NAME`, `APP_ENV`, `PBKDF2_ITERATIONS`, `ALLOW_REGISTRATION`.
**No secrets are needed.** Do not put credentials in `wrangler.jsonc`; use `wrangler secret put` if any are added later.

## Observability

`observability.enabled = true` turns on Workers Logs (included in Free; 7-day retention). Unhandled errors are logged
as structured JSON with a request ID, which is also returned to the user in the `X-Request-Id` header.

## Rollback

- **Code:** Dashboard → Worker → **Deployments** → choose a previous version → **Rollback**, or `npx wrangler rollback`.
- **Schema:** migrations are forward-only. Write a new corrective migration rather than editing an applied one.
- **Data:** restore from a backup file (below) into a new database, or use D1 Time Travel
  (`npx wrangler d1 time-travel restore arthika --timestamp=…`). Time Travel retention on the Free plan is
  **unverified** here (historically 7 days); check the D1 docs before relying on it.

## Backup and restore

| What | Status |
|---|---|
| Backup script `scripts/backup.sh` (`wrangler d1 export --remote`) | Written; **not yet run against production** (no production DB exists yet) |
| Restore verification `scripts/restore-test.sh` | **Tested** on 20 Oct 2026 against a local export: restored into a fresh database, 0 unbalanced entries, every company's ledger nets to 0 |
| Per-company JSON export (Settings → Data export) | Implemented and tested (owner/admin only) |

Recommended routine: run `npm run backup` after each monthly close and copy the `.sql` file to storage you control
(e.g. Google Drive). Exports contain financial data — store them encrypted. Restore into production only after
testing with `restore-test.sh`:

```bash
npx wrangler d1 create arthika-restore
npx wrangler d1 execute arthika-restore --remote --file backups/arthika-<stamp>.sql
# then point wrangler.jsonc database_id at the restored DB and redeploy
```
