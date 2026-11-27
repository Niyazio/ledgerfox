# Foxlator on the Microsoft Store — everything to paste

Copy each block into Partner Center as it is. Screenshots are in `docs/store/screenshots/` (1920 × 1080, in order).

---

## 1. Store listing (Partner Center → your app → Store listings → English)

**Product name**
Foxlator

**Short title** (optional)
Foxlator Accounting

**Short description** (shown at the top of the listing)
GST billing, accounting, stock, CRM and service desk for small and growing businesses. 30-day free trial.

**Description**
Foxlator is accounting and billing software for small and growing businesses. Make GST invoices, track what customers owe and what you owe suppliers, manage stock, and see your profit, balance sheet and GST returns — on Windows, in the browser and on Android, with the same books everywhere.

What you can do
• Quotations, sales orders, GST invoices, credit notes, POS / counter billing and recurring invoices
• Receipts and payments, cheques and post-dated cheques, cheque printing, UPI payment QR on invoices
• Supplier bills, purchase orders, requests for quotation, goods receipts and 3-way matching
• Products and stock with batches, serial numbers, warehouses, labels and barcode scanning
• Banking: statement import, matching and reconciliation
• Reports: profit & loss, balance sheet, cash flow, ageing, GST returns (GSTR-1, GSTR-3B), tax check and audit checks
• Leads & CRM, service desk with tickets and AMC contracts
• Users with roles, branches, approvals, audit log and two-factor sign-in
• Customer and supplier portals: your customers see their invoices; suppliers see your orders and quote on your requests

Desktop app features
• Its own window with a menu bar and keyboard shortcuts (F8 invoice, F9 bill, F6 receipt, Alt+R reports)
• Prints invoices, thermal receipts and cheques directly to your printers
• Saves PDFs and Excel exports to your computer; links open in your usual browser
• Shows a clear message when the computer is offline

Pricing
Foxlator is free to download and free for 30 days. After the trial a subscription is needed to keep adding entries: Starter ₹299 a month, Business ₹799 a month, Multi-branch ₹1,999 a month (GST extra; yearly plans get two months free). Your data can always be viewed and exported, even without a subscription.

Foxlator is a product of Niyazio. Support: info@niyazio.com

**What's new in this version**
LedgerFox is now Foxlator: same app, same account, same data. New: UPI payments straight to your bank, requests for quotation and goods receipts, CRM, service desk and AMC contracts, cheque register and printing, approvals, and a user manual with screenshots.

**Product features** (one per line, up to 20)
GST invoices, quotations and POS billing
Receipts, payments, cheques and UPI QR
Purchase orders, RFQ and goods receipts
Stock with batches, serials and warehouses
Bank statement import and reconciliation
Profit & loss, balance sheet, GST returns
Leads & CRM with follow-ups
Service desk and AMC contracts
Customer and supplier portals
Roles, branches, approvals and audit log
Works on Windows, browser and Android

**Keywords** (up to 7)
accounting, GST billing, invoice, inventory, bookkeeping, CRM, small business

**Screenshots**: upload the 10 files in `docs/store/screenshots/` in their numbered order. Captions (optional):
1 Dashboard · 2 Making a GST invoice · 3 GST returns · 4 Leads & CRM · 5 Service desk · 6 Comparing supplier quotes · 7 Products & stock · 8 Reports · 9 Cheques & post-dated cheques · 10 3-way match

**Store logos**: the 1:1 box art can be `build/appx/LargeTile.scale-200.png` (620 × 620).

**Privacy policy URL**: https://foxlator.niyazio.com/privacy
**Website**: https://foxlator.niyazio.com
**Support contact**: info@niyazio.com

---

## 2. Properties

- **Category**: Business — subcategory Accounting & finance
- **Privacy policy**: Yes (URL above)
- **Product declarations**: tick *“This app requires an internet connection”* if offered. Do **not** tick “accessibility” claims you have not tested.
- **System requirements**: Windows 10 version 1809 or later, x64, internet connection.

## 3. Age ratings (questionnaire)

Category: *Productivity / business app*. Answer **No** to violence, sexual content, gambling, drugs, crude humour and user-to-user chat. It shares no location and has no public user-generated content. Expected rating: 3+ / Everyone.

## 4. Pricing and availability

- **Price**: Free (the subscription is bought inside Foxlator, not through the Store).
- **Free trial**: No Store trial (the 30-day trial is in the app).
- **Markets**: India first (or all markets if you sell abroad).
- **In-app purchases**: answer that the app offers subscriptions paid through its own payment provider (Razorpay), as allowed for non-game apps.

## 5. Notes for certification (Submission options → Notes for certification)

Paste, filling in the reviewer account you created:

> Foxlator is a business accounting app (the desktop edition of https://foxlator.niyazio.com, which we own and operate). It needs an internet connection and a sign-in.
>
> Test account (full access, no payment needed):
> Email: ______________________
> Password: ______________________
>
> After signing in, open the company "Foxlator Review" (or the demo company). Try: Invoices → New (F8) to make an invoice; Reports → Profit & loss; Leads & CRM; Service desk & AMC.
>
> Subscriptions are sold inside the app through our own payment provider (Razorpay); the test account already has full access, so no purchase is needed. The app updates through the Microsoft Store only (its own updater is switched off in Store installs). It shows no ads.

---

## 6. Before you submit: the reviewer account (5 minutes)

1. Open https://foxlator.niyazio.com/register and create an account, e.g. `store-review@niyazio.com` with a strong password (a real mailbox you own). Create its company, e.g. **Foxlator Review**.
2. In **your** admin panel (shield icon at the top) → find that organisation → **Give free access** → plan **Business**, 12 months, note “Microsoft Store review”.
3. Sign in as the reviewer: make a customer and one invoice, or create a demo company with sample data (**My companies → New company → Explore with a demo company**). If you use the demo company, write its name in the notes (section 5).
4. Check you can make an invoice without being asked to pay.

## 7. Upload step by step

1. **Partner Center** (https://partner.microsoft.com/dashboard) → sign up as an **individual developer** (free). If it asks for a payment, stop and check you chose *individual*.
2. **Apps and games → New product → MSIX or PWA app** → reserve the name **Foxlator**.
3. In the app → **Product management → Product identity**: copy **Package/Identity/Name**, **Package/Identity/Publisher** (starts with `CN=`) and **Package/Identity/PublisherDisplayName**.
4. GitHub → Niyazio/ledgerfox → **Settings → Secrets and variables → Actions → Variables → New repository variable**, three times:
   `MS_STORE_IDENTITY_NAME`, `MS_STORE_PUBLISHER`, `MS_STORE_PUBLISHER_DISPLAY_NAME` (values from step 3).
5. Ask for a release (e.g. “release v0.10.2”). The build then also makes **Foxlator Store package** — download it from the release run's artifacts (`microsoft-store-package`, file `LedgerFox-Store-x64.appx`).
6. Partner Center → **Start your submission**:
   - **Pricing and availability** → section 4 above
   - **Properties** → section 2
   - **Age ratings** → section 3
   - **Packages** → drag in the `.appx` file
   - **Store listings → English** → section 1, upload the screenshots
   - **Submission options → Notes for certification** → section 5
7. **Submit to the Store.** Certification usually takes 1–3 working days. If it fails, the report says exactly why: fix it and submit again (free).

Store installs update from the Store; the website download stays available.
