# Database schema

Engine: Cloudflare D1 (SQLite). Migrations: `migrations/0001_core.sql`, `migrations/0002_business.sql`
(applied with `wrangler d1 migrations apply arthika`). Both have been applied successfully with wrangler to a local D1
and are applied by the test harness to every test database.

**Migration status (remote):** not yet applied — the production D1 database has not been created (see DEPLOYMENT.md).

## Conventions

- Money `INTEGER` minor units · quantities `INTEGER` × 1000 · rates `INTEGER` × 1e9 · dates `TEXT YYYY-MM-DD`.
- IDs are UUID strings. Tenant tables carry `company_id` and `UNIQUE(company_id, id)` so children can use composite
  foreign keys `(company_id, x_id)` → no cross-company references.

## Tables

| Area | Tables |
|---|---|
| Identity | `users`, `sessions` (SHA-256 of token), `recovery_codes` (hashed), `password_resets` (hashed), `rate_limits` |
| Tenancy | `organisations`, `memberships` (owner/admin/accountant/auditor/viewer), `invitations` (hashed token), `companies` |
| Dimensions | `branches`, `departments`, `projects`, `cost_centres` |
| Setup | `number_sequences`, `exchange_rates`, `fiscal_years`, `fiscal_periods` (open/locked), `tax_codes`, `units` |
| Ledger | `accounts` (type/subtype/group tree/system_key), `journal_entries`, `journal_lines` |
| Parties & items | `contacts` (customer/supplier/both), `items`, `warehouses`, `stock_moves` |
| Documents | `documents` (quote, sales_order, invoice, credit_note, purchase_order, bill, debit_note), `document_lines` |
| Settlement | `payments` (in/out), `allocations` (payment or note → invoice/bill; reversible by negative mirror) |
| Expenses | `expenses` (draft → submitted → approved/rejected → posted), `recurring_templates`, `attachments` (BLOB ≤ 1 MB) |
| Banking | `bank_imports`, `bank_statement_lines` (dedupe hash, match), `bank_reconciliations` |
| Assets | `fixed_assets` (SLM/WDV), `depreciation_entries` (unique asset+month) |
| Planning | `budgets`, `budget_lines` |
| Audit | `audit_logs` (append-only) |

## Invariants enforced by triggers / constraints

| Rule | Mechanism |
|---|---|
| Debits = credits, ≥ 2 lines, header total = Σ debits | `trg_je_post_validate` on status → posted |
| Posting only into open fiscal periods | `trg_je_post_validate` (`PERIOD_CLOSED`) |
| Only active, non-group accounts of the same company | `trg_je_post_validate` + composite FK |
| Posted entries/lines immutable; reversal linked once | `trg_je_posted_immutable`, `trg_jl_*_guard`, unique `reversal_of_id` |
| A line is debit **or** credit, never negative | `CHECK ((debit = 0) <> (credit = 0))`, `CHECK (debit >= 0 …)` |
| No duplicate posting of a source document / idempotency key | partial unique index `(company_id, source_type, source_id)`, unique `(company_id, idempotency_key)` |
| Unique, gap-free numbers per company | sequence bumped inside the posting transaction; `UNIQUE(company_id, entry_number)` |
| Posted documents frozen; only settlement/void may change | `trg_doc_posted_immutable`, `trg_docline_guard_*` |
| No over-allocation; currency/contact/type must match | `CHECK(amount_settled <= total)`, `trg_alloc_validate` |
| Stock never negative per warehouse; stock ledger append-only | `trg_stock_no_negative`, `trg_stock_immutable_*` |
| Reconciled statement lines frozen | `trg_bsl_reconciled_guard` |
| Audit log append-only | `trg_audit_no_update`, `trg_audit_no_delete` |
| Period date ranges cannot be edited | `trg_period_range_guard` |

## Default chart of accounts

Seeded per company (`src/shared/coa.ts`), India adds CGST/SGST/IGST input/output and TDS accounts. System accounts
(`system_key`: AR, AP, SALES, COGS, INVENTORY, OUT_CGST, …) are used automatically by postings and cannot be deleted.

## Adding a migration

Create `migrations/0003_<name>.sql`, run `npm run db:migrate:local`, add tests, then deploy (the deploy command applies
pending migrations to the remote DB before publishing the Worker).
