# Architecture

## Decision summary

| Concern | Choice | Why |
|---|---|---|
| Hosting | **Cloudflare Workers (Free)** with static assets | The owner already runs 18 Workers on this Cloudflare account. Static asset requests are free and unlimited; API requests share 100k/day. |
| Database | **Cloudflare D1** (SQLite) | Free tier (5 GB account storage, 5M rows read/day, 100k rows written/day); hard-stops instead of billing on the Free plan; no connection pooling problems; triggers and composite foreign keys enforce accounting invariants. |
| API | **Hono** on Workers, TypeScript | Tiny, fast cold start, fits the 10 ms CPU budget. |
| UI | **React 19 + React Router 7 + Tailwind CSS 4**, built by Vite as a static SPA | Served from Workers static assets at no request cost. Pages are lazy-loaded (initial JS ≈ 80 KB gzipped). |
| Auth | Own implementation: PBKDF2-SHA256 + HttpOnly session cookie stored hashed in D1 | No paid auth provider; no email dependency. |
| Tests | Vitest + **Miniflare D1** (real SQLite with the real migrations/triggers) + Playwright smoke test | Integration tests exercise the same SQL the production database runs. |

### Alternatives considered (and why not)

- **Next.js on Vercel + Supabase**: no Vercel projects or domains exist on the connected account; Supabase was not reachable
  from this environment and free Supabase projects pause after inactivity. Next.js on Workers Free would push the 10 ms
  CPU limit on server rendering. A static SPA + small API is cheaper and simpler here.
- **PostgreSQL elsewhere (Neon, etc.)** via Hyperdrive: adds a second provider and a network hop; D1 meets the
  requirements and is on the account the owner already uses.
- **Microservices**: unnecessary; this is a modular monolith in one Worker.

## Shape

```
Browser (React SPA, static assets)
   │  fetch /api/* (same origin, cookie session, X-Requested-With header)
   ▼
Cloudflare Worker (Hono)
   ├─ middleware: security headers, CSRF check, session auth, tenant scope (company + role)
   ├─ routes/      auth · orgs · settings · accounts · journals · contacts · items · documents
   │               payments · expenses · banking · assets · reports · attachments · export
   ├─ services/    ledger (posting engine) · documents · payments · inventory · depreciation
   │               reports · insights · setup (company provisioning)
   └─ D1 binding ──► SQLite with triggers (immutability, balance, period lock, allocations, stock)
src/shared/        money (BigInt) · tax (GST) · currencies · chart of accounts · permissions · csv
```

## The posting engine (`src/worker/services/ledger.ts`)

Every financial event (manual journal, invoice, bill, payment, expense, stock adjustment, depreciation, disposal)
becomes **one D1 batch** — D1 runs a batch as a single SQL transaction:

1. insert the journal header as `draft`;
2. insert its lines;
3. bump the company's number sequence;
4. `UPDATE … SET status = 'posted', entry_number = <next number>` — this fires `trg_je_post_validate`, which
   re-checks in the database that debits = credits, there are ≥ 2 lines, the date is in an **open** fiscal period,
   and all accounts are active ledger (non-group) accounts of the same company;
5. the caller's own statements (document status, allocations, stock moves, audit log) in the same batch.

If anything fails, nothing is written and the sequence number is not consumed (verified by tests).
Posted headers/lines are immutable by trigger; the only permitted change is linking a reversal once.

## Money, quantity and rate representation

- Money: `INTEGER` minor units (paise, cents, fils). Parsing rejects excess decimals rather than rounding.
- Quantity: `INTEGER` milli-units (3 decimals).
- Exchange rate: `INTEGER` × 1e9 (base units per 1 foreign unit).
- Rounding: half away from zero, applied once per computed amount (line amount, each tax component, each base
  conversion). GST CGST and SGST are each rounded at half the rate.
- Foreign-currency documents: each component converts to base separately; the AR/AP line takes the sum, so entries
  always balance in base currency. Settlement at a different rate posts a realised exchange gain/loss.

## Tenancy and access control

- `organisations` own `companies`; `memberships(org, user, role)` grant access to every company in the org.
- Each company-scoped request goes through `requireCompany`, which loads the company **joined to the caller's
  membership**; non-members get 404 so IDs cannot be probed.
- Every query filters by `company_id`; composite foreign keys `(company_id, id)` make cross-company references
  impossible at the database level (tests insert cross-tenant rows directly and confirm rejection).
- D1/SQLite has no row-level security; isolation is enforced in trusted server code plus these constraints.
- **Permissions (phase 2):** `src/shared/permissions.ts` defines 39 permissions and the defaults of seven roles.
  `requireCompany` resolves the caller's *effective* permissions (role defaults plus the organisation's overrides in
  `role_permissions`; Owner is never reduced) and branch scope, and stores them on the request. Routes call
  `requirePerm` / `requireAnyPerm`; nothing trusts the UI.
- **Branch scope:** members with `memberships.all_branches = 0` may use only the branches in `member_branches`.
  `resolveBranch` validates a branch chosen by the client (403 if not allowed; defaults to the member's first
  branch), `branchFilter` adds `branch_id IN (…)` to list queries, and `assertBranchVisible` returns 404 for records
  of other branches. Journal lines inherit their entry's branch so branch reports read the ledger directly.

## Tax rules

`src/shared/tax.ts` is independent of the ledger. It decides the tax mode (intra/inter/simple) and computes line
taxes; the ledger only receives amounts and the accounts to post to. New jurisdictions add a scheme there.

## Rule-based assistance (no paid AI)

`services/insights.ts`: keyword + history category suggestions, duplicate-bill warnings (same reference or same
amount within 30 days), 3σ anomaly flags per account, a due-date-based cash projection, and P&L explanations built
from the computed figures. An optional adapter for a self-hosted model (`LOCAL_LLM_URL`) is reserved in `Env` but
**not implemented** — no LLM is called anywhere.

## Desktop edition

```
Electron window ──http://127.0.0.1:4780──► Node server (src/server/http.ts, @hono/node-server)
phones (same Wi-Fi) ──http://<lan-ip>:4780──┘   ├─ same Hono app as the Worker (src/worker)
internet link (cloudflared quick tunnel) ──┘    └─ DB = SqliteD1 facade (src/server/sqlite-d1.ts) over node:sqlite
                                                      └─ one .ledgerfox SQLite file chosen by the user
```

- `src/server/sqlite-d1.ts` implements the subset of the D1 API the code uses (`prepare/bind/first/all/run/raw`,
  atomic `batch`) on Node's built-in SQLite, so no native module has to be compiled per platform. WAL journal,
  `synchronous=FULL`, foreign keys on. The same migrations and triggers apply; `src/server/migrate.ts` records them in
  `d1_migrations` like wrangler.
- The whole Vitest suite runs against both engines (`npm test` = Miniflare D1, `npm run test:desktop` = node:sqlite).
- Request trust: only loopback requests carrying Cloudflare headers are treated as coming through the internet link;
  for all other requests the client address comes from the socket, so it cannot be spoofed. The browser Origin of the
  internet link is accepted only for the hostname the app itself started, which also switches cookies to
  `__Host-…; Secure`.
- `ALLOW_REGISTRATION=first` (desktop default): only the first user can register; others need an invitation.
- `src/desktop/main.ts`: data-file chooser, daily backups (`VACUUM INTO`), menus, phone-access window with QR codes,
  single-instance lock, `.ledgerfox` file association. `src/desktop/tunnel.ts`: downloads and runs `cloudflared`.
- Packaging: esbuild bundles main + server (`scripts/build-desktop.mjs`); electron-builder (`electron-builder.yml`)
  makes NSIS (Windows), DMG (macOS, ad-hoc signed) and AppImage (Linux). CI: `.github/workflows/desktop.yml`.

## Offline mode

- `public/sw.js` (service worker) precaches the app shell from `precache-manifest.json` (emitted by a Vite plugin at
  build time) so the app opens without a connection. Updates install in the background and take over once all tabs close.
- API GETs are network-first; successful JSON responses are stored in Cache Storage and served when the network
  fails (marked `x-ledgerfox-offline`). Non-JSON responses (exports, attachments) are never stored. Writes are not handled
  by the service worker.
- `src/web/lib/offline.ts` keeps an **outbox** in IndexedDB. Creating a contact, document, payment, expense or journal
  while offline (or when the request fails at the network level) stores it with a random `Idempotency-Key`; it is sent
  on reconnect, every minute, and at start-up, in creation order. Follow-up steps (post/issue/approve) run after the
  create with their own key. Server rejections (e.g. a locked period) are shown in the header panel for retry or discard.
- `src/worker/lib/idempotency.ts` stores the first 2xx response per (company, user, key) in `idempotency_keys` and
  replays it for repeats, so an uncertain network failure followed by a retry never posts twice.
- Not offline: edits of existing records, reports not opened before, bank imports, attachments, settings. Records
  created offline do not appear in lists until synced (they are listed in the "on device" panel).

## Limits designed around

- 10 ms CPU per request (Free): aggregation is done in SQL; password hashing defaults to 50k PBKDF2 iterations.
- Queries per request: endpoints use single batches for writes; reads are a handful of indexed queries.
- No background jobs on the free plan by default: recurring expenses and depreciation are user-triggered and
  idempotent (Cron Triggers are available on Free — 5 per account — and could be added later).
- Attachments: stored in D1 as BLOBs, ≤ 1 MB each (R2 needs a payment method on file).
