# Project status

_Last updated: 20 Oct 2026_

**Overall: suitable for a demo and a supervised pilot (one small business, accountant reviewing reports, monthly
backups). Not yet production-ready** for unsupervised use or as a statutory system of record. See "Before production".

## Functional modules

| Module | Status | Notes |
|---|---|---|
| Registration, login, sessions, password change | ✅ Done | PBKDF2, hashed session tokens, rate limiting |
| Password recovery | ✅ Done | One-time recovery codes; admin reset links. No email. |
| Organisations, multiple companies, company switching | ✅ Done | |
| Roles (owner/admin/accountant/auditor/read-only), invitations | ✅ Done | Invitation links are copied manually (no email) |
| Branches, departments, projects, cost centres | ✅ Done | Tag lines; P&L filters by dimension |
| Chart of accounts (groups, types, detail types, system accounts) | ✅ Done | India / generic seeds |
| Journals: draft, post, reverse, adjustment, opening balances | ✅ Done | DB-enforced balance & immutability |
| Fiscal years, monthly periods, period locking | ✅ Done | |
| Audit log | ✅ Done | Append-only |
| Customers / suppliers | ✅ Done | GSTIN validation, terms, currency |
| Quotations, sales orders, purchase orders | ✅ Done | Non-posting; convert to invoice/bill |
| Invoices, credit notes, bills, debit notes | ✅ Done | GST, discounts, round-off, multi-currency, void via reversal |
| Receipts & payments, partial payments, advances, FX gain/loss | ✅ Done | Apply advances/notes later |
| Printable invoices / statements / reports, "PDF" | ✅ Done | Browser print-to-PDF (no PDF library or API) |
| Expenses: approval, receipts (≤ 1 MB), recurring templates | ✅ Done | Recurring generation is user-triggered |
| Banking: CSV import, duplicate detection, matching, reconciliation, history | ✅ Done | |
| Inventory: items, SKUs, units, warehouses, transfers, adjustments, reorder alerts | ✅ Done | Moving weighted average; reconciles to GL |
| Fixed assets: register, SLM/WDV, depreciation journals, disposal | ✅ Done | |
| Reports: TB, P&L, BS, cash flow, GL, AR/AP ageing, statements, sales/purchases by party, expenses, inventory valuation, GST summary, budget vs actual | ✅ Done | CSV + print on all |
| Dashboard | ✅ Done | All figures from the ledger |
| Rule-based insights | ✅ Done | Category suggestions, duplicate bills, anomalies, bank match, cash projection, P&L explanation |
| Data export | ✅ Done | Per-company JSON (owner/admin); DB-level backup script |
| Light/dark theme, responsive layout | ✅ Done | |
| Desktop edition (Windows/macOS/Linux) | ✅ Done (Linux build verified here) | Data file in a chosen folder, daily backups, Wi-Fi phone access with QR, temporary free internet link. Windows/macOS installers are built by GitHub Actions (cannot be built in this Linux environment); unsigned. |
| Move desktop data to the cloud | ❌ Not yet | Same schema; needs an import tool |
| Permanent per-client internet address | ❌ Not yet | Options: relay on Cloudflare Workers (free tier, counts against 100k requests/day) or named tunnels on each client's Cloudflare account |
| Username login, Tally-style user creation, desktop admin/admin with forced change | ✅ Done | |
| Business types (12) with tailored accounts, units, starter items | ✅ Done | |
| Demo company (load / delete) | ✅ Done | Loaded through the normal API |
| Payroll: employees, timesheets, monthly runs, PF/ESI/PT/TDS, posting, salary payment, salary register, payslips | ✅ Done | Statutory defaults for India; PT and TDS are per-employee fixed amounts (no slab/tax computation) |
| Print preview: A4 modern/classic, A5, thermal 80/58 mm; amount in words; UPI pay QR; QR verification page | ✅ Done | Browser printing (no direct ESC/POS driver) |
| AdSense on public pages + ads.txt + privacy policy | ✅ Done | Ads appear only after Google approves the site; EEA/UK visitors need Google's consent message enabled in AdSense |
| Android app (APK) | ✅ Built by CI | Not on Google Play; temporary signing key until secrets are added |
| Logo + payment QR + UPI ID at company creation, on all printed documents | ✅ Done | |
| Desktop auto-update | ✅ Windows/Linux automatic; macOS notifies (unsigned apps cannot self-update) | |
| Android app: full app inside, update check, view-only offline copy from the desktop by QR | ✅ Done | Copy is a snapshot; scan again to refresh |
| Encrypted automatic cloud backup of desktop data | ✅ Done | Keeps newest 5 per user |
| Website deploy workflow (GitHub Actions) | ✅ Added | Needs CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID secrets |
| Multi-branch access control, 7 roles, daybook, product barcodes (phase 2 brief) | ⏳ Next | On a separate branch, for review before merging |
| Installable app + offline mode | ✅ Done | App opens without internet; pages already opened are shown from the device; new customers/suppliers, invoices/bills/other documents, receipts/payments, expenses and journals made offline are queued on the device and sent once on reconnect |

## Incomplete, partial or not implemented (honest list)

- **GST compliance:** no GSTR-1/3B export, e-invoicing (IRN/QR), e-way bills, TDS/TCS, reverse-charge postings, cess.
- **Optional local LLM adapter:** reserved in config (`LOCAL_LLM_URL`) but **not implemented**; no AI model is called.
- **No email** (invitations, invoices, reminders, password resets are all copy-link/manual).
- **No MFA**; no email verification.
- Bank feeds (only CSV import); OFX/MT940 not supported.
- Foreign-currency revaluation of open balances at period end (unrealised FX) — not implemented; realised FX is.
- Budgets entered as an annual amount per account split evenly; no monthly budget editor or budget versions.
- Inventory: no batch/serial numbers, no FIFO option, no landed cost; purchase returns priced at average cost.
- Payment allocation requires the payment and invoice to share a currency.
- Ageing is document-based; manual journals to AR/AP show as an "unreconciled difference" (flagged on the report).
- No year-end closing entry (retained earnings are computed); no consolidation across companies.
- No payroll, CRM, manufacturing or other ERP modules.
- Not tested: real production Cloudflare deployment (not deployed yet), load against free-tier limits, accessibility audit.

## Before production

1. Deploy (DEPLOYMENT.md), run the e2e script against the live URL, and run `npm run backup` + restore drill.
2. Decide on the password work factor vs. plan (SECURITY.md §1); consider Workers Paid if you need higher.
3. Have an accountant review the chart of accounts, GST codes and report formats for your business.
4. Add MFA and an email provider if you need them (free tiers exist, e.g. Resend/Brevo — not integrated).
5. Set `ALLOW_REGISTRATION` to `"false"` after onboarding your team.

## Next highest-priority tasks

1. Production deploy + custom domain + first real backup (database is ready; needs your GitHub repo and the Cloudflare dashboard steps).
2. GSTR-1 / GSTR-3B summary exports in the portal's JSON/Excel layouts (data is already captured per line).
3. TOTP multi-factor authentication.
4. Unrealised FX revaluation and cross-currency payment allocation.
5. Scheduled jobs via a free Cron Trigger (recurring expenses, depreciation reminders).
6. Accessibility audit (axe) and keyboard-shortcut layer for power users.
