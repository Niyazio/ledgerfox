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
- **Payment.** Payment is a prepaid month or year through Razorpay Checkout (UPI, cards, net banking). Renewing the same plan adds the new period to the end of the current one.

## What you need to do (once)

1. **Open a Razorpay account** at razorpay.com and complete KYC. Opening the account is free; Razorpay charges about 2% per payment.
2. **Create API keys.** In the Razorpay dashboard, go to **Account & Settings → API Keys** and generate a key pair. Use test mode first, then live.
3. **Add the webhook.**
   - Go to **Account & Settings → Webhooks**.
   - URL: `https://ledgerfox.niyazio.com/api/billing/webhook`
   - Events: `payment.captured` and `order.paid`
   - Choose a secret.
4. **Store the keys as Worker secrets.** They are never put in code or in the browser:
   ```sh
   npx wrangler secret put RAZORPAY_KEY_ID
   npx wrangler secret put RAZORPAY_KEY_SECRET
   npx wrangler secret put RAZORPAY_WEBHOOK_SECRET
   ```
5. **Set the plain settings** in Cloudflare (Worker → Settings → Variables) or in `wrangler.jsonc` `vars`:
   - `BILLING_ENABLED` = `true`
   - `VENDOR_ADMIN_EMAILS` = your login email(s), comma-separated. These people can open `/vendor` to see subscribers and revenue, record bank-transfer payments, and extend trials.
   - For your invoices to customers: `VENDOR_LEGAL_NAME`, `VENDOR_GSTIN`, `VENDOR_ADDRESS`, `VENDOR_STATE_CODE`. Ask your CA about GST registration and the SAC code (998431 is used for online software services).
6. **Test the whole flow in test mode** with Razorpay's test UPI ID / test cards. Then switch the keys to live mode.

## Not included yet

- Automatic recurring charges (UPI AutoPay / card mandates). Customers pay each period, and a reminder banner appears 5 days before the end.
- Coupons, a per-branch add-on and refunds from inside LedgerFox. Make refunds in the Razorpay dashboard.
- Tested against Razorpay with a mocked API and real HMAC signatures only. A real test-mode payment has not been made.
