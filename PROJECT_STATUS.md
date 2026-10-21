# Project status

_Last updated: 21 Oct 2026 (phase 2 on branch `feature/multi-branch`, not yet merged or deployed)_

**Overall: suitable for a demo and a supervised pilot (one small business, accountant reviewing reports, monthly
backups). Not yet production-ready** for unsupervised use or as a statutory system of record. See "Before production".

## Functional modules

| Module | Status | Notes |
|---|---|---|
| Registration, login, sessions, password change | ✅ Done | PBKDF2, hashed session tokens, rate limiting |
| Password recovery | ✅ Done | One-time recovery codes; admin reset links. No email. |
| Organisations, multiple companies, company switching | ✅ Done | |
| Seven roles (Owner, Admin/Branch manager, Billing, Purchase, Accountant, Inventory, Viewer/Auditor) with 39 fine-grained permissions; owner can customise every role except Owner | ✅ Done (phase 2) | Checked on the server for every request; the UI only hides what the server refuses |
| Branches, departments, projects, cost centres | ✅ Done | Tag lines; P&L filters by dimension |
| Multi-branch access: users limited to assigned branches, header branch selector, branch-wise reports, branch invoice prefixes, inter-branch stock transfers | ✅ Done (phase 2) | Lists, details, edits, reports and contact balances are scoped on the server. Some reports (cash flow, GL, ageing, GST, inventory valuation, insights, budgets) are whole-company only and refused for branch-limited users |
| Daybook (created / modified / approved / posted / cancelled by and when) and per-record history with previous → new values | ✅ Done (phase 2) | From the append-only audit log |
| Approval limits: purchase bills above a limit need approval by another user; billing discount limit | ✅ Done (phase 2) | |
| Product codes (auto P000001…), barcodes, QR + Code 128 labels, scanning by USB scanner, camera (where the browser supports BarcodeDetector) or typing | ✅ Done (phase 2) | QR holds only the product code |
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
| Daily report (opening/closing cash + bank, income, expenses, received from customers, paid to suppliers, sales and purchases invoiced) for any date range, per branch; CSV and print/PDF | ✅ Done | |
| From–to date filters with period presets and totals on invoices, bills, returns, receipts, payments and expenses; full filtered download (CSV) | ✅ Done | |
| Rule-based insights | ✅ Done | Category suggestions, duplicate bills, anomalies, bank match, cash projection, P&L explanation |
| Data export | ✅ Done | Per-company JSON (owner/admin); DB-level backup script |
| Light/dark theme, responsive layout | ✅ Done | |
| Desktop edition (Windows/macOS/Linux) | ✅ Done (Linux build verified here) | Data file in a chosen folder, daily backups, Wi-Fi phone access with QR, temporary free internet link. Windows/macOS installers are built by GitHub Actions (cannot be built in this Linux environment); unsigned. |
| Move desktop data to the cloud | ❌ Not yet | Same schema; needs an import tool |
| Permanent per-client internet address | ❌ Not yet | Options: relay on Cloudflare Workers (free tier, counts against 100k requests/day) or named tunnels on each client's Cloudflare account |
| Username login, Tally-style user creation, forced password change | ✅ Done | Phase 2: every new user and the desktop's first sign-in get a random one-time password (no shared default such as admin/admin) |
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
| Phase 2 rollout | ⏳ Awaiting your approval | Branch `feature/multi-branch`. Migrations 0006 and 0007 are not applied to the live database; nothing is deployed |
| Installable app + offline mode | ✅ Done | App opens without internet; pages already opened are shown from the device; new customers/suppliers, invoices/bills/other documents, receipts/payments, expenses and journals made offline are queued on the device and sent once on reconnect |

| GSTR-1 (B2B, B2CL, B2CS, credit notes, nil/exempt, HSN, documents issued) and GSTR-3B preparation; JSON for the GST offline tool and CSV sheets, per GSTIN | ✅ Done | Not filed from LedgerFox; exports (EXP), amendments, reverse charge and GSTR-2B matching not included |
| Import customers, suppliers and products (with opening stock) from Excel .xlsx or CSV | ✅ Done | Built-in reader; old .xls must be saved as .xlsx |
| Share invoices, quotes and receipts via WhatsApp / email / copy; payment reminders; customer link with full invoice and UPI pay button + QR | ✅ Done | Free: opens your own WhatsApp/email. Desktop edition sends text without a link |

| POS counter billing: scan/tap products, cash/UPI/card/split, change, hold bills, auto thermal print, walk-in customer, F2/F9 shortcuts | ✅ Done | Prices locked for staff without discount rights |
| Proforma invoices and delivery challans (own number series, convert to invoice) | ✅ Done | Delivery challans do not move stock |
| Recurring invoices (weekly/monthly/quarterly/yearly; draft or auto-issue; catches up missed periods) | ✅ Done | Run when someone opens the app (daily) or with “Create due invoices now”; no background job |
| Customer credit limit: warning on draft, blocked on issue unless a manager confirms (recorded in history) | ✅ Done | |
| Cash book / bank book with running balance; share customer/supplier statements | ✅ Done | |

## Incomplete, partial or not implemented (honest list)

- **GST compliance:** GSTR-1/3B are prepared for upload but not filed; no e-invoicing (IRN/QR), e-way bills, TDS/TCS, reverse-charge postings, cess, exports table or GSTR-2B matching.
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
- No CRM, manufacturing or other ERP modules.
- Camera scanning needs a browser with the BarcodeDetector API (Chrome/Edge on Android/Windows/macOS, the Android app); Safari/Firefox users can use a USB scanner or type the code.
- Branch-wise cash flow, general ledger, ageing, GST summary and inventory valuation are not available yet (whole company only).
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
