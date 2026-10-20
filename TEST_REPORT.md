# Test report

Run date: 20 Oct 2026 · Node 22.22 · all commands run in this repository.

| Command | Result |
|---|---|
| `npm run lint` (ESLint, typescript-eslint, react-hooks) | ✅ 0 problems |
| `npm run typecheck` (`tsc --noEmit`, strict) | ✅ 0 errors |
| `npm test` (Vitest + Miniflare D1) | ✅ **116 passed**, 0 failed, 0 skipped (8 files, ~25 s) |
| `npm run test:desktop` (same suite on Node SQLite, desktop engine) | ✅ **116 passed** |
| Browser e2e against the headless desktop server (`server-build/ledgerfox-server.mjs`) | ✅ passed, incl. offline round trip |
| Packaged Linux desktop app (`electron-builder --linux`, Electron 44) launched under Xvfb | ✅ data file + migrations + daily backup created; owner registration → company → dashboard driven through the real window; Wi-Fi access window shows QR and the LAN address answers |
| Windows/macOS installers | ⚠️ not built here (Windows needs Wine on Linux; macOS needs a Mac) — built by `.github/workflows/desktop.yml` on GitHub's runners, not yet run |
| Internet link (Cloudflare Quick Tunnel) | ⚠️ not reachable from this sandbox (DNS blocked); the server-side handling is covered by `test/desktop-server.test.ts` |
| `npm run build` (Vite) | ✅ initial JS 266 KB (83 KB gzip), pages lazy-loaded; precache manifest emitted |
| `npx wrangler d1 migrations apply ledgerfox --local` | ✅ all three migrations applied by wrangler |
| `npm run test:e2e` against `wrangler dev` (real Workers runtime, Chromium) | ✅ passed, 0 browser console errors; includes an offline round trip (app reloads offline, a customer created offline is queued on the device, then synced exactly once on reconnect) |
| Backup/restore drill (`wrangler d1 export --local` → `scripts/restore-test.sh`) | ✅ restored; 0 unbalanced entries; every company nets to 0 |
| `npm audit --omit=dev` | ✅ 0 vulnerabilities |
| `npm audit` (incl. dev tooling) | ⚠️ 3 high in `undici` via wrangler/miniflare (dev-only, not deployed) |

## How the integration tests work

Each test file creates a fresh Miniflare D1 (real SQLite), applies the **same migration files** used in production
(triggers included), and calls the real Hono app over HTTP with cookies, CSRF headers and distinct client IPs.
Financial expectations are calculated by hand in the test (see comments), not derived from the code under test.

A mutation check was performed: breaking the P&L sign convention made 2 report tests fail; disabling the application
balance check left unbalanced-posting tests passing *because the database trigger still rejected them* (intended
defence in depth).

## Coverage by requirement

| Requirement | Tests |
|---|---|
| Debit/credit balancing | unbalanced rejection (API and DB trigger), both-sides/negative lines, group accounts |
| Journal posting & numbering | sequential numbers, gap-free under concurrency, drafts editable then posted |
| Journal reversal | equal & opposite entry, once only, reversal of reversal blocked, net zero |
| Duplicate posting prevention | idempotency key, source-document uniqueness, double issue/approve blocked; `Idempotency-Key` replay (same response, nothing re-run), follow-up replay, key release on failure, cross-endpoint reuse rejected, in-flight 409 and stale retry, per-user scoping |
| Transaction rollback | failed posting leaves no rows and does not consume a number |
| Concurrent posting | 4 simultaneous posts of one draft → exactly 1 succeeds; 6 parallel posts → unique numbers |
| Closed periods | locked period rejected, unlock works, no-period dates rejected, lock-through |
| Tax calculations | CGST/SGST half-rate rounding, IGST, discount before tax, exempt, odd rates (0.125%), GSTIN check digit |
| Invoice totals & rounding | multi-rate document totals, half-up rounding cases, round-off to ₹1 with posting |
| Partial payments, AR/AP | partial receipts, over-allocation rejected (API and DB), advances, statement balance, void restores balance |
| Trial balance / P&L / balance sheet / cash flow | full scenario with hand-computed P&L 18,000, BS 138,800 = 20,800 + 118,000, cash flow reconciling to 74,000 |
| Inventory valuation | moving average 10@100 + 10@120, COGS 550, valuation = ledger, oversell blocked, transfers, adjustments |
| Foreign currency | USD invoice @83 settled @84 → ₹1,000 realised gain; JPY/KWD exponent conversion; missing-rate error |
| Authentication | login/logout, wrong password, rate limiting, no user enumeration, recovery codes single-use, password length, hash upgrade |
| Role permissions | viewer, auditor, accountant, admin, owner matrices; admin cannot create admins; self-approval blocked |
| Tenant isolation | 404 for foreign company, ID substitution through own company, cross-tenant accounts/invoices/contacts, DB composite keys |
| API validation | invalid dates, malformed JSON, invalid GSTIN, SQL-injection strings |
| Export permissions | export allowed for owner, refused for viewer/accountant/other tenant |
| Banking | CSV import & preview, duplicate re-import, match suggestions, amount mismatch, reconciliation blocked then completed, frozen reconciled lines |
| Fixed assets | SLM exact sum, WDV monthly amounts, salvage floor, idempotent depreciation runs, disposal loss |
| Expenses | approval workflow, segregation of duties, recurring templates with month-end clamping, rule-based suggestions |

## Not covered / skipped

- No tests skipped. Not automated: print-to-PDF output, multi-browser testing (only Chromium), accessibility audit
  tooling, load testing against real D1 limits, and anything against the production Cloudflare deployment
  (not yet deployed).
- The recurring-template test depends on today's date (it asserts at least two generated periods).

