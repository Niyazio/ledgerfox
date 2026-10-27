# Accounts and subscriptions: how it works for your customers

This is for the hosted website (ledgerfox.niyazio.com). The desktop app has no subscriptions and does not send email.

## Creating an account
1. The customer opens the website and chooses **Create account**. They enter their name, email and a password of at least 10 characters.
2. They save the 8 **recovery codes** shown once. These work even if they lose access to their email.
3. With email switched on, they also get a "Confirm your email" message. Until they click it, a thin blue bar in the app offers to send the link again.
4. They create their company. The organisation starts a **14-day free trial** with every Business-plan feature. No card is needed.

## Signing in
- **Login:** email (or username for staff accounts) plus password. Two-factor sign-in with an authenticator app is optional, and the owner can require it for everyone.
- **Lockout protection:** after 10 wrong attempts for one account in 15 minutes (or 30 from one network), sign-in pauses for 15 minutes.
- **Staff accounts:** the owner adds staff in Settings → Users. Each person gets their own one-time password and must change it at first sign-in.

## Forgot password
- **By email** (when email is on): on "Forgot password?", enter the email. A reset link arrives that works **once, for one hour**. The page gives the same answer for every address, so nobody can use it to find out who has an account. Resetting signs the account out everywhere.
- **With a recovery code:** "Use a recovery code instead".
- **Staff without an email:** the owner or an administrator creates a reset link in Settings → Users.

## Buying a plan
The **owner** opens Settings → **Plan & billing** and picks Starter, Business or Multi-branch, monthly or yearly (yearly gives 2 months free). Prices are plus 18% GST.

- **Renew automatically** (ticked by default):
  1. Razorpay's window asks the owner to approve a **UPI AutoPay, card or bank mandate** once.
  2. The first charge happens straight away. If the trial or a paid period is still running, it waits until that ends, so nobody pays twice for the same days.
  3. Razorpay then charges every month or year. It notifies the customer before each UPI debit.
- **Pay once** (untick the box): one prepaid month or year. Renewing the same plan adds the new period to the end of the current one.

LedgerFox never sees card numbers or UPI PINs. Payment happens inside Razorpay's window.

## After paying
- The plan shows **Active** with the end date. An emailed receipt includes:
  - the **invoice number** (LF-YYYY-00001…),
  - the **Payment ID** (`pay_…`),
  - the **Account ID** (the organisation id),
  - for auto-renew, the **Subscription ID** (`sub_…`).
- The same ids appear in Plan & billing → Invoices and on the printable tax invoice. Customers quote them when they contact support. You find them in Razorpay's dashboard and on `/vendor`.

## Renewals and reminders
A daily job runs at 08:47 India time and sends each reminder only once:

| Situation | What the customer gets |
|---|---|
| Trial ends within 3 days (no plan bought) | "Your free trial ends soon" |
| Paid plan ends within 5 days, auto-renew off | "Your plan ends on …" |
| Plan ended (7 days of grace) | "Your plan has ended — 7 days to renew" |
| Auto-renew charge failed (Razorpay retries) | "Your renewal payment did not go through" |
| Razorpay gave up after the retries | "Action needed: your plan could not be renewed" |

The app also shows a yellow bar near the end of the trial or plan.

## Turning auto-renew off, and the end of a plan
- **Turning off auto-renew:** Plan & billing → **Turn off auto-renew**. No more charges are taken, and the days already paid are kept.
- **Grace period:** when a paid period ends without renewal, everything works for 7 more days.
- **Free plan:** after the grace period, the Free plan limits apply (1 user, 1 company, no POS, payroll or GST return files). **Data is never deleted or locked.** Billing, accounts and reports keep working.
- **Changing the plan of a running auto-renew:** turn it off, then choose the new plan. The new auto-renew starts when the current period ends.

## What you (the seller) do
- `/vendor` lists every organisation, its plan, its status and your revenue.
- The **Set-up check** on `/vendor` shows whether the live server sees your Razorpay keys, which mode (test or live) they are in, and whether Razorpay accepts them.
- **Bank transfer:** use **Record payment** with the UTR. This activates the plan and issues the invoice, exactly like an online payment.
- **Extend trial** gives a customer more trial days.
- Refunds are made in the Razorpay dashboard.
