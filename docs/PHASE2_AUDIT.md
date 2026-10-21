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
