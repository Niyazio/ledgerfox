# Phase 2 audit — multi-branch, roles, daybook, barcodes, performance

_Audited 21 Oct 2026 on branch `feature/multi-branch` (base: v0.3.0, commit f3e1044)._

## Stack and structure (unchanged)

Hono API (`src/worker`) shared by three runtimes: Cloudflare Worker + D1 (cloud), Node + SQLite file (desktop,
`src/server`), and the phone's in-app engine (sql.js, view-only). React SPA (`src/web`). Migrations `0001`–`0005`;
28 triggers enforce balanced, immutable postings, period locks, stock and allocations. Tenancy is organisation →
companies; `memberships(org, user, role)` gives a role across every company of the organisation.

## What already exists and must be preserved

- Double-entry engine, document/payment/expense posting, idempotency, offline outbox, desktop/phone editions.
- `branches` table per company (name, code, state, active flag); `branch_id` on `journal_entries`, `journal_lines`,
  `documents`, `warehouses`; reports already filter by `branch_id` through journal lines.
- Five roles (owner, admin, accountant, auditor, viewer) with a static permission matrix checked server-side.
- Audit log (append-only by trigger) written server-side with user, action, entity and details.

## Gaps found

| Area | Finding |
|---|---|
| Branch security | No user ↔ branch assignment; any member sees every branch. `payments`, `expenses`, `stock_moves`, `payroll_runs` have no `branch_id`. Branch IDs from the client were accepted without access checks. |
| Roles | No billing, purchase or inventory roles. Permissions are coarse (`txn.write` covers sales, purchases and journals alike), so a billing user could not be limited to sales. No per-organisation customisation. |
| Approvals | No approval step or limits (purchases, discounts). |
| Staff passwords | Owner types the temporary password; desktop seeds a shared `admin/admin`. The brief requires random one-time passwords. |
| Daybook | No daybook; "modified by / approved by / posted by" not shown together; no per-record history panel. |
| Products | No unique product code or barcode, no labels, no scanning. |
| Transfers | Stock transfers are between warehouses with no branch recorded. |
| Performance (measured, below) | Aging, balance sheet, dashboard and contact list scan journal lines per request; contact list computes balances for every contact. |

## Baseline performance

Desktop engine, 5,000 posted invoices (≈15,000 journal lines) + 3,000 items, median of 5 requests (ms):

| Endpoint | ms |
|---|---|
| /reports/dashboard | 56.3 |
| /documents?doc_type=invoice&limit=50 | 4.5 |
| /documents …&q=INV-01 | 6.1 |
| /items?active=1&limit=500 | 15.6 |
| /contacts?kind=customer&active=1&limit=500 | 40.4 |
| /reports/trial-balance | 35.4 |
| /reports/profit-loss | 37.4 |
| /reports/balance-sheet | 60.1 |
| /reports/aging/receivable | 87.0 |
| /journals?limit=50 | 2.1 |
| /reports/gst-summary | 41.5 |

Reproduce: `PERF=1 PERF_INVOICES=5000 PERF_ITEMS=3000 LEDGERFOX_TEST_DB=sqlite npx vitest run test/perf.test.ts`.

## Plan (in the brief's priority order)

1. Permissions: fine-grained permission catalogue; seven default roles; per-organisation role customisation
   (owner-only, owner role locked); effective permissions resolved server-side per request.
2. Branch security: `member_branches` assignments (or all branches), `branch_id` on payments/expenses/payroll,
   server-side scoping of every list/detail/create/report, validated branch selector.
3. Audit/daybook: daybook report with created/modified/approved/posted/cancelled by and times; history panel.
4. Approvals: purchase approval limit and billing discount limit per organisation.
5. Products: unique product code + barcode, labels, scanner (camera / USB wedge / manual) in billing, purchases,
   inventory; branch stock transfers recording both branches.
6. Accounts: random one-time passwords for new staff and for the first desktop start.
7. Performance fixes, measured again with the same script.

## Results (implemented on `feature/multi-branch`)

| Brief item | Delivered |
|---|---|
| Multi-branch, owner/branch access, server-validated branch selector | `member_branches` + `all_branches`; `resolveBranch` / `branchFilter` / `assertBranchVisible` on documents, payments, expenses, journals, stock, contact balances, daybook and branch-aware reports; header selector (company, branch, FY, role) |
| Seven default roles, fine-grained customisable permissions | 39 permissions; owner-only role editor (stored as differences from defaults; Owner locked) |
| Secure temporary passwords | Random per user and per reset, shown once, hashed, forced change; desktop admin/admin replaced by a random one-time password |
| Daybook and audit trail | Daybook with created/modified/approved/posted/cancelled by and time; record history panel with previous → new values |
| Approvals | Purchase approval limit (request/approve, no self-approval), billing discount limit |
| QR / barcode | Auto product codes, barcodes, labels (QR + Code 128, roll or A4), scanner in invoices/bills, inventory and labels (USB scanner, camera where supported, manual) |
| Branch transfers | `stock_transfers` records both warehouses and branches |
| Sidebar by permission | Modules grouped and shown only when the member's permissions allow; staff home for roles without the financial dashboard |
| Migrations preserving data | 0006 (table rebuilds copy every row) and 0007 (indexes only); verified on a v0.3.0 data file |

### Performance after the fixes

Same script and data as the baseline (desktop engine, 5,000 posted invoices ≈ 25,000 journal lines, 3,000 items).
Median of 5 requests per endpoint; three separate runs shown as a range, median of the three in bold.
"Before" is the run on this branch just before the fixes (the original audit baseline is above).

| Endpoint | Before (ms) | After (ms) |
|---|---|---|
| /reports/dashboard | 60.7 | 30.7–34.3 (**31.8**) |
| /contacts (500 customers with balances) | 41.2 | 3.8–6.9 (**5.8**) |
| /reports/trial-balance | 45.7 | 12.5–14.7 (**13.6**) |
| /reports/profit-loss | 53.7 | 12.0–13.2 (**12.9**) |
| /reports/balance-sheet | 64.7 | 22.5–43.4 (**23.9**) |
| /reports/aging/receivable | 84.6 | 59.8–61.9 (**60.1**) |
| /reports/gst-summary | 77.6 | 31.6–34.9 (**33.2**) |
| /documents list / search | 6.0 / 7.3 | 6.0–7.2 / 7.2–7.6 (unchanged) |
| /items (500) | 9.9 | 10.0–15.4 (unchanged) |
| /journals | 5.8 | 2.1–2.4 |

What changed: covering indexes `idx_je_posted_cover` and `idx_jl_entry_cover` let ledger sums read only indexes;
report queries sum per account first and attach account details afterwards; subtype totals use
`account_id IN (…)`; contact balances are summed once and joined instead of a per-contact scan (the planner had
been scanning all documents per contact); ageing filters settled documents in SQL. Ageing is still the slowest
endpoint because it returns every open document (5,000 rows in this test).
These are desktop-engine timings on this machine; Cloudflare D1 latency will differ and was not measured.

### Not done / limits

- Branch-wise cash flow, general ledger, ageing, GST summary and inventory valuation (refused for branch-limited users).
- Payroll runs are company-wide (no branch on employees yet).
- Live D1: migrations 0006 and 0007 are **not applied**; nothing deployed or merged.
