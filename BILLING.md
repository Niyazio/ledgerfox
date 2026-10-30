# Selling LedgerFox subscriptions

Subscriptions apply to the hosted website **and the desktop app** (one plan covers both). The desktop app connects to the customer's LedgerFox account in Settings → Plan & billing and receives a signed licence for that organisation's plan; without one, or after 15 days without an online check, new entries wait until it is connected or renewed (everything stays viewable and exportable; nothing is deleted). In online mode the desktop app simply shows the website. The phone's offline copy is view-only and never limited. Self-built copies can set `DESKTOP_LICENSING=off`.
**Billing is off until you switch it on.** While it is off, every organisation has every feature.

## Plans (edit `src/shared/plans.ts`)

| Plan | Monthly | Yearly | Users | Branches/company | Companies | Extra features |
|---|---|---|---|---|---|---|
| Free | ₹0 | ₹0 | 1 | 1 | 1 | — |
| Starter | ₹299 | ₹2,999 | 3 | 1 | 1 | GSTR-1/3B, recurring invoices |
| Business | ₹799 | ₹7,999 | 10 | 2 | 2 | + POS, payroll |
| Multi-branch | ₹1,999 | ₹19,999 | 25 | 5 | 3 | + POS, payroll |

Prices exclude GST (`BILLING_GST_PERCENT`, default 18).

How plans behave:

- **Trial.** A new organisation gets **30 days** of Business. With `BILLING_REQUIRE_AUTOPAY=true` (on for ledgerfox.niyazio.com), the owner first chooses the plan to continue with and approves auto-pay. Razorpay takes ₹5 to check the UPI or card and refunds it, and the first real charge is when the trial ends. Until then everything can be viewed, but new entries wait. The vendor's own staff are never held back.
- **Grace period.** When a paid period ends, there are 7 days of grace. After that, renewal is required.
- **No Free plan.** When the trial or the paid period plus grace has ended, the organisation's real companies can still be viewed, printed and exported, but adding or changing entries answers `402 RENEW_REQUIRED` and the app shows a "Renew your plan to continue" screen. Company settings stay editable. Data is never deleted. Practice (education mode) companies, demo-only organisations and the vendor's own organisation are never held back.
- **Payment.** Two ways, both through Razorpay's own window:
  - **Auto-renew** (ticked by default): the owner approves a UPI AutoPay, card or bank mandate once, and Razorpay charges each month or year until it is turned off in Plan & billing. If a trial or paid period is still running, the first charge waits until it ends, so nobody pays twice for the same days. Failed charges are retried by Razorpay; after that the plan runs into the 7-day grace period and then renewal is required.
  - **Pay once**: a prepaid month or year (UPI, cards, net banking). Renewing the same plan adds the new period to the end of the current one.

## What you need to do (once)

1. **Open a Razorpay account** at razorpay.com and complete KYC. Opening the account is free; Razorpay charges about 2% per payment.
2. **Create API keys.** In the Razorpay dashboard, go to **Account & Settings → API Keys** and generate a key pair. Use test mode first, then live.
3. **Add the webhook.**
   - Go to **Account & Settings → Webhooks**.
   - URL: `https://ledgerfox.niyazio.com/api/billing/webhook`
   - Events: `payment.captured`, `order.paid`, `subscription.authenticated`, `subscription.activated`, `subscription.charged`, `subscription.pending`, `subscription.halted`, `subscription.cancelled`, `subscription.completed`, `subscription.paused` and `subscription.resumed`
   - Choose a secret.
   - **Subscriptions** must be enabled on your Razorpay account (Dashboard → Subscriptions). If it asks you to request access, do that first. LedgerFox creates the Razorpay plans itself, one for each plan and interval, the first time someone chooses it.
   - UPI AutoPay allows up to ₹15,000 a charge without extra approval. The yearly Multi-branch plan (₹23,599 with GST) is above that, so those customers will pay with a card or bank mandate, or pay once.
4. **Store the keys as Worker secrets.** Either add them in Cloudflare → Workers & Pages → `ledgerfox` → Settings → **Variables and Secrets** (type *Secret*), or as GitHub repository secrets with the same names (Settings → Secrets and variables → Actions); every deploy copies the GitHub ones to the Worker. They are never put in code or in the browser. From the command line:
   ```sh
   npx wrangler secret put RAZORPAY_KEY_ID
   npx wrangler secret put RAZORPAY_KEY_SECRET
   npx wrangler secret put RAZORPAY_WEBHOOK_SECRET
   ```
5. **Check the set-up** on `/vendor` → Set-up check. It shows whether the live server sees each key, test or live mode, and whether Razorpay accepts the keys. Common mistakes:
   - adding the keys to GitHub secrets or to Workers *Build* variables instead of the Worker's runtime **Variables and Secrets**;
   - a typo in the name;
   - a test key id with a live secret.
6. **Set the plain settings.** `BILLING_ENABLED` is in `wrangler.jsonc` (switched on 27 Oct 2026). Put the others in the Cloudflare dashboard (Worker → Settings → Variables and Secrets), preferably as encrypted secrets so your email and GST details are not in the public repository. `keep_vars: true` stops the automatic deploy from removing them:
   - `BILLING_ENABLED` = `true`
   - `VENDOR_ADMIN_EMAILS` = your login email(s), comma-separated. These people can open `/vendor` to see subscribers and revenue, record bank-transfer payments, and extend trials.
   - For your invoices to customers: `VENDOR_LEGAL_NAME`, `VENDOR_GSTIN`, `VENDOR_ADDRESS`, `VENDOR_STATE_CODE`. Ask your CA about GST registration and the SAC code (998431 is used for online software services).
7. **Test the whole flow in test mode** with Razorpay's test UPI ID / test cards. Then switch the keys to live mode.

## Email (password reset links, receipts, reminders)

LedgerFox sends email through [Resend](https://resend.com). The free plan covers 3,000 emails a month and 100 a day, with no card needed. Until it is set up, password reset works only with recovery codes or admin-issued links, and no receipts or reminders are sent.

1. Create a Resend account. Add your domain (for example `niyazio.com`) and add the DNS records Resend shows. Your DNS is on Cloudflare, so this takes a few clicks.
2. Create an API key with "Sending access" only.
3. In Cloudflare → Worker `ledgerfox` → Settings → Variables and Secrets, add:
   - `RESEND_API_KEY` (**Secret**)
   - `EMAIL_FROM`, for example `LedgerFox <billing@niyazio.com>` (the domain must be the one verified in Resend)
   - optional `EMAIL_REPLY_TO`, for example `info@niyazio.com`
4. Open `/vendor`. The Set-up check should show "Email on".

What is sent: address confirmation at sign-up, password reset links (one hour, single use), a receipt for every payment, failed auto-renew warnings, and daily reminders (trial ending, plan ending, plan ended). A daily Cloudflare cron at 03:17 UTC sends the reminders, and each reminder goes out only once. See `docs/ACCOUNTS_AND_BILLING_GUIDE.md` for what customers see.

## Not included yet

- Coupons, a per-branch add-on and refunds from inside LedgerFox. Make refunds in the Razorpay dashboard.
- Changing the plan of a running auto-renewal: turn it off and start a new one. Proration is not supported.
- Tested against Razorpay with a mocked API and real HMAC signatures only. A real test-mode payment, mandate or webhook has not been made yet.

## Education mode

Practice companies (`companies.is_practice = 1`) are free with every feature and need no plan or auto-pay. The rules are in `migrations/0023_practice_companies.sql` (date triggers on `journal_entries`), `src/worker/index.ts` (no e-invoice, e-way bill or verify endpoints) and `services/billing.ts` (features and `EDUCATION_LIMITS` for learning-only organisations). See `docs/ACCOUNTS_AND_BILLING_GUIDE.md`.

## Desktop licences

- **Connect:** the owner or an admin on the computer opens Settings → Plan & billing and signs in with their LedgerFox website account (same password, two-factor and rate limits as the website). If they manage several organisations, they choose one.
- **The licence:** the website issues a licence signed with an Ed25519 key. The key is created on first use and stored in the `licence_keys` table; its public half is sent to the computer when it connects. The licence holds the plan, its end date (trial end, or paid-until plus 7 days of grace) and a check-by date 15 days ahead.
- **Checks:** the computer verifies the signature offline, and refreshes the licence in the background at most every 6 hours when it is online. An edited licence fails the signature check and the computer asks to connect again.
- **On the website:** each connected computer appears in the `desktop_devices` table and in the admin panel's organisation details. Set `revoked_at` to disconnect one; it keeps its last licence only until its check-by date.
- **Limits:** the source code is open, so someone who builds LedgerFox themselves can switch licensing off. The official installers enforce it.

## Admin panel (`/vendor`)

For the emails in `VENDOR_ADMIN_EMAILS`:
- **Overview:** organisations, accounts, companies, paying / trial / free counts, auto-pay count, revenue, sign-ups and active accounts over 7 and 30 days, and a sign-ups chart.
- **Organisations:** owner, email, phone, city, signed-up date, last sign-in, users, documents, status, trial/paid end, auto-pay and revenue. Search, filter, and Excel/CSV export. Click a row for people (role, last sign-in, number of sign-ins), companies (GSTIN, place, contact, counts, last activity), the subscription and auto-pay ids, payments with invoices, and emails sent. From there you can extend a trial or record a bank transfer.
- **Accounts:** every sign-in with its organisations, created date, last sign-in, sign-in count, email confirmation and two-factor. Excel/CSV export.
- **Payments:** every payment with invoice number and Razorpay ids. Excel/CSV export.
- **Set-up & promotions:** the set-up check and Free-plan promotions.

Customers' books (invoice lines, ledgers, amounts) are only counted, never shown. Passwords and two-factor secrets never leave the server.

## Promotions on the Free plan

Organisations on the Free plan of the hosted website see one small, dismissible card at the bottom of the dashboard. Trial, paying, desktop and self-hosted users never see it.

- **Your own messages** are built in: "Remove these messages" (links to the plans) and "Work without internet" (the desktop app).
- **Sponsors:** add text promotions on `/vendor` → Promotions on the Free plan. Each has a title, text, an https link, an optional sponsor name (shown as "Sponsored · Name"), dates and a share from 1 to 10. Views and clicks are counted.
- **Why not AdSense inside the app?** An ad network's script inside the app could read the invoices, customers and amounts on screen. Google's rules also do not allow AdSense inside installed apps. AdSense stays on the public pages (home, download, privacy). For ads in the Android app, Google's AdMob is the allowed route. It needs an AdMob account and a native plugin; ask if you want it.
