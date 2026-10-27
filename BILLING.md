# Selling LedgerFox subscriptions

Subscriptions apply only to the hosted website. The desktop app and the phone copy are never limited.
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

- **Trial.** A new organisation gets 14 days of Business. An existing organisation gets 14 days from the first time it is seen after billing is switched on.
- **Grace period.** When a paid period ends, there are 7 days of grace. After that the organisation drops to the Free plan.
- **Free plan.** Billing, accounts, reports and data export keep working. Data is never deleted or locked. Creating more users, branches or companies than the plan allows, and the paid features, answer with a clear "upgrade" message.
- **Payment.** Two ways, both through Razorpay's own window:
  - **Auto-renew** (ticked by default): the owner approves a UPI AutoPay, card or bank mandate once, and Razorpay charges each month or year until it is turned off in Plan & billing. If a trial or paid period is still running, the first charge waits until it ends, so nobody pays twice for the same days. Failed charges are retried by Razorpay; after that the plan runs into the 7-day grace period and then the Free plan.
  - **Pay once**: a prepaid month or year (UPI, cards, net banking). Renewing the same plan adds the new period to the end of the current one.

## What you need to do (once)

1. **Open a Razorpay account** at razorpay.com and complete KYC. Opening the account is free; Razorpay charges about 2% per payment.
2. **Create API keys.** In the Razorpay dashboard, go to **Account & Settings → API Keys** and generate a key pair. Use test mode first, then live.
3. **Add the webhook.**
   - Go to **Account & Settings → Webhooks**.
   - URL: `https://ledgerfox.niyazio.com/api/billing/webhook`
   - Events: `payment.captured`, `order.paid`, `subscription.activated`, `subscription.charged`, `subscription.pending`, `subscription.halted`, `subscription.cancelled`, `subscription.completed`, `subscription.paused` and `subscription.resumed`
   - Choose a secret.
   - **Subscriptions** must be enabled on your Razorpay account (Dashboard → Subscriptions). If it asks you to request access, do that first. LedgerFox creates the Razorpay plans itself, one for each plan and interval, the first time someone chooses it.
   - UPI AutoPay allows up to ₹15,000 a charge without extra approval. The yearly Multi-branch plan (₹23,599 with GST) is above that, so those customers will pay with a card or bank mandate, or pay once.
4. **Store the keys as Worker secrets.** They are never put in code or in the browser:
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

## Promotions on the Free plan

Organisations on the Free plan of the hosted website see one small, dismissible card at the bottom of the dashboard. Trial, paying, desktop and self-hosted users never see it.

- **Your own messages** are built in: "Remove these messages" (links to the plans) and "Work without internet" (the desktop app).
- **Sponsors:** add text promotions on `/vendor` → Promotions on the Free plan. Each has a title, text, an https link, an optional sponsor name (shown as "Sponsored · Name"), dates and a share from 1 to 10. Views and clicks are counted.
- **Why not AdSense inside the app?** An ad network's script inside the app could read the invoices, customers and amounts on screen. Google's rules also do not allow AdSense inside installed apps. AdSense stays on the public pages (home, download, privacy). For ads in the Android app, Google's AdMob is the allowed route. It needs an AdMob account and a native plugin; ask if you want it.
