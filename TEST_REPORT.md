# Test report

## Feature-pack run (branch `feature/gst-import-share`, 21 Oct 2026)

| Command | Result |
|---|---|
| `npm run lint`, `npm run typecheck` | ✅ 0 problems / 0 errors |
| `npm test` (Miniflare D1) | ✅ **194 passed**, 1 skipped (opt-in performance benchmark), 25 files |
| `npm run test:desktop` (Node SQLite) | ✅ **194 passed**, 1 skipped |
| `test/gstr.test.ts` | GSTR-1 sections (B2B, B2CL over ₹1 lakh inter-state, B2CS, CDNR/CDNUR, nil/exempt, HSN, documents issued) and GSTR-3B figures checked against hand calculations, per GSTIN |
| `test/import.test.ts`, `test/sheet.test.ts` | customer/product import with loose headers, dry run, skipped duplicates, opening stock journal; a real `.xlsx` fixture read by the built-in reader |
| `test/share.test.ts` | WhatsApp/email/UPI links and messages |
| `test/sales-extras.test.ts` | proforma/challan series, credit-limit warning and block with audited override, recurring invoices (catch-up, claim-once), POS sale with change, discount and price locks |
| `test/billing.test.ts` | plans, trial, limits (402), features, checkout/webhook signatures, paid-twice idempotency, invoice numbering, vendor admin hidden from others |
| `test/totp.test.ts`, `test/twofactor.test.ts` | RFC 6238 test vectors; enable/disable, code and recovery-code sign-in, replay refused, owner-required 2FA, reset clears it |
| `test/batches.test.ts` | batch required on bills; FEFO skips expired stock; choosing an expired batch refused; "short by X; Y more is expired"; invoice line records the batches sold; void restores the same batches; write-off of an expired batch; transfers keep batch and expiry; valuation still reconciles; switching tracking with stock refused; import with batch/expiry and spreadsheet dates |
| `test/einvoice.test.ts` | address splitting; IRP JSON per line: UnitPrice × Qty = TotAmt, TotAmt − Discount = AssAmt, AssAmt + taxes = TotItemVal; totals + round-off = invoice total; IGST between states; credit note refers to its invoice; problems listed (B2C, missing address/PIN/HSN, draft); corrections apply to the file only; e-way bill outward and sales-return inward, vehicle-number check; IRN/QR/e-way bill number saved, validated, and refused for a viewer |
| Browser checks (Chromium, desktop server) | e-invoice dialog flags the missing PIN → fixed → JSON downloaded → a portal-style response pasted fills IRN/Ack/QR → saved → A4 print shows IRN, Ack, e-way bill no. and the QR; POS sale ₹300 with ₹200 change and print; share links on phone and desktop; 2FA end to end; batch item form → bill with batch/expiry → "Batches & expiry" tab → dashboard alert → invoice view and A4/thermal print show the batch. Found and fixed: an unknown `?format=` on the print page showed a blank page |

Not covered: a real Razorpay payment; uploading the GSTR, e-invoice or e-way bill JSON to the government portals (the IRN in the browser check was a made-up sample); camera scanning on a phone.

## Phase 2 run (branch `feature/multi-branch`, 21 Oct 2026)

| Command | Result |
|---|---|
| `npm run lint` | ✅ 0 problems |
| `npm run typecheck` | ✅ 0 errors |
| `npm test` (Miniflare D1) | ✅ **158 passed**, 1 skipped (the opt-in performance benchmark), 14 files |
| `npm run test:desktop` (Node SQLite) | ✅ **158 passed**, 1 skipped |
| `test/phase2.test.ts` (15 tests) | one-time passwords unique and random; effective permissions in settings; billing staff limited to their branch with branch numbering (`BLR-INV-…`); lists/details/void of other branches → 404; billing cannot see bills, journals or purchase cost; scanner lookup by QR payload, barcode, code and SKU; duplicate barcode → 409; discount limit; purchase approval limit with self-approval refused; auditor read-only; inventory transfer records both branches and cannot start from another branch; owner customises and resets a role; daybook contents and scoping; record history with previous → new values; contact balances per branch |
| `test/daily.test.ts` | hand-computed daily report (opening ₹10,000 → closing ₹10,150 with income, expenses, received, paid per day), agreement with the bank and cash ledgers, date-filtered list totals |
| Pop-up form typing bug | reproduced in Chromium on the old code (the dialog closed while typing a name), fixed, re-checked |
| `test/barcode.test.ts` | Code 128 symbol widths, start/stop patterns, mod-103 checksum, invalid characters |
| One-time password generator | 2,000 generated: all 3×5 characters from the unambiguous alphabet, all distinct (this test caught a real bug: the alphabet had 54 characters, not 55, so a character could be dropped) |
| Browser e2e against the desktop server | ✅ passed (now reads the random one-time password from the sign-in page) |
| Phase 2 browser walkthrough (Chromium) | ✅ owner adds a billing user → one-time password shown once → user signs in, must change password → staff home and sidebar show only sales modules → branch selector locked to the assigned branch → scanning the same barcode twice adds one line with quantity 2 → daybook and history panel → labels render QR + Code 128 → owner header shows branch, FY and role |
| Upgrade of a v0.3.0 data file (created with the released code) | ✅ migrations 0006 + 0007 applied; identical row counts and ledger totals; owner signs in; existing items get codes `P000001…`; existing members keep all-branch access |
| Performance (5,000 invoices, 3,000 items, desktop engine) | see `docs/PHASE2_AUDIT.md` — measured before and after |

Not covered in phase 2: camera scanning on a real device (the browser API is feature-detected; only USB/keyboard entry
was exercised), printing labels on a physical label printer, and the migrations on the live Cloudflare D1 database
(not applied — awaiting approval).

## Earlier run

Run date: 20 Oct 2026 · Node 22.22 · all commands run in this repository.

| Command | Result |
|---|---|
| `npm run lint` (ESLint, typescript-eslint, react-hooks) | ✅ 0 problems |
| `npm run typecheck` (`tsc --noEmit`, strict) | ✅ 0 errors |
| `npm test` (Vitest + Miniflare D1) | ✅ **138 passed**, 0 failed, 0 skipped (11 files, ~35 s) |
| `npm run test:desktop` (same suite on Node SQLite, desktop engine) | ✅ **138 passed** |
| Browser e2e against the headless desktop server (`server-build/ledgerfox-server.mjs`) | ✅ passed, incl. offline round trip |
| Packaged Linux desktop app (`electron-builder --linux`, Electron 44) launched under Xvfb | ✅ data file + migrations + daily backup created; owner registration → company → dashboard driven through the real window; Wi-Fi access window shows QR and the LAN address answers |
| Windows/macOS installers | ⚠️ not built here (Windows needs Wine on Linux; macOS needs a Mac) — built by `.github/workflows/desktop.yml` on GitHub's runners, not yet run |
| Internet link (Cloudflare Quick Tunnel) | ⚠️ not reachable from this sandbox (DNS blocked); the server-side handling is covered by `test/desktop-server.test.ts` |
| Browser run of new screens on the desktop server (admin/admin → password change → restaurant demo → invoice A4/classic/thermal previews → payroll → payslip → demo delete) | ✅ screens rendered; found and fixed: invalid demo GSTIN, allocations blocking demo deletion |
| Phone offline copy (Chromium emulating the app on a separate origin: pair → save → sign in → dashboard/trial balance → write refused; 0 requests to the computer afterwards) | ✅ passed; found and fixed: browsers drop Set-Cookie on in-page responses |
| Logo/QR upload in Settings → invoice preview shows logo, Scan-to-pay image and verification QR | ✅ |
| Android APK | ⚠️ not built here (no Android SDK); built by the GitHub workflow |
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

