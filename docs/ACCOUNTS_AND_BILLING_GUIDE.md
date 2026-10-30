# Accounts and subscriptions: how it works for your customers

This is for the hosted website (ledgerfox.niyazio.com). The desktop app has no subscriptions and does not send email.

## Creating an account
1. The customer opens the website and chooses **Create account**. They enter their name, email and a password of at least 10 characters.
2. They save the 8 **recovery codes** shown once. These work even if they lose access to their email.
3. With email switched on, they also get a "Confirm your email" message. Until they click it, a thin blue bar in the app offers to send the link again.
4. They create their company. The organisation starts a **30-day free trial** with every Business-plan feature.
5. A "Start your 30-day free trial" screen asks the owner to choose the plan for after the trial and set up **auto-pay** (UPI AutoPay, card or bank mandate). Razorpay takes **₹5 to check it and refunds it**; the first charge is on the day the trial ends. Until auto-pay is set up, they can look around but not add entries. Staff see a note asking the owner to do it.

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

## Education mode (practice companies)
For students, trainees and beginners: tick **Practice company (education mode)** when creating a company, on the website or in the desktop app.
- **Free forever, every feature:** POS, payroll, GST reports, manufacturing and the rest, on any plan, with no auto-pay. A learning-only organisation (only practice companies) can hold a class of up to 50 users, 10 companies and 5 branches.
- **Not for business, like Tally's educational mode:**
  - entries can be dated only the **1st, 2nd and last day of a month**, enforced by the database;
  - printouts and PDFs carry a "Practice — not a valid tax document" mark and watermark;
  - Excel/CSV downloads start with a "practice company" line;
  - government e-invoice and e-way bill files, public verification QR codes and WhatsApp/email sharing are off;
  - the name always ends with "(Practice)" and an orange bar shows on every screen.
- **Permanent:** a practice company can't be turned into a real one. Start a real company for real work.

## One free trial per customer
- **Once per owner:** the 30-day trial is given once, to the owner's first real organisation. Another organisation by the same owner has no trial and needs a plan from the start; demo and practice companies don't count.
- **Stopping and restarting auto-pay never restarts the trial.** During the trial, the first charge stays on the original trial end date. After the trial, it is charged at once.
- **Not covered:** someone who signs up again with a different email gets a new trial. Watch for repeat sign-ups (same company name, phone or GSTIN) in the admin panel.

## Turning auto-renew off, and the end of a plan
- **Turning off auto-renew:** Plan & billing → **Turn off auto-renew**. No more charges are taken, and the days already paid are kept.
- **Grace period:** when a paid period ends without renewal, everything works for 7 more days.
- **No Free plan:** after the grace period, the customer sees "Renew your plan to continue". They can still view, print and export everything, but cannot add or change entries until they renew. **Data is never deleted.** Practice companies (education mode) stay free.
- **Changing the plan of a running auto-renew:** turn it off, then choose the new plan. The new auto-renew starts when the current period ends.

## What you (the seller) do
- `/vendor` lists every organisation, its plan, its status and your revenue.
- The **Set-up check** on `/vendor` shows whether the live server sees your Razorpay keys, which mode (test or live) they are in, and whether Razorpay accepts them.
- **Bank transfer:** use **Record payment** with the UTR. This activates the plan and issues the invoice, exactly like an online payment.
- **Extend trial** gives a customer more trial days.
- Refunds are made in the Razorpay dashboard.
