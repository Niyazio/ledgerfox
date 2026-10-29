# Security playbook (for the LedgerFox team)

The public page for customers is https://ledgerfox.niyazio.com/security. `SECURITY.md` lists every technical control.
This page covers what *you* do: protecting the accounts that run LedgerFox, watching for trouble, and handling an attack.

## 1. The real risk: your own accounts

Most breaches of small SaaS products happen through the owner's accounts, not through the code. Anyone who gets into
the accounts below can read or change all customer data. Protect them first.

| Account | Do this now |
|---|---|
| Gmail `niyazio.com@gmail.com` and `info@niyazio.com` | Turn on 2-Step Verification with an authenticator app or passkey (not SMS). Check the recovery phone and email. Remove unknown devices. |
| Cloudflare (runs the website and database) | Turn on 2FA. Use only *scoped* API tokens; the GitHub deploy token should only have "Edit Workers" and "D1 Edit". Delete unused tokens. Don't share the login. |
| GitHub (the code and the deploy pipeline) | Turn on 2FA. Under Settings → Code security, turn on **Dependabot alerts**, **secret scanning** and **push protection**. Add a **branch protection rule** on `main`: require a pull request and the CI check to pass. |
| Razorpay (money) | Turn on 2FA. Give team members the lowest role that works. Never paste key secrets into chats, emails or code. |
| WordPress (niyazio.com) | Turn on 2FA and keep plugins updated. It holds the same live Razorpay key. |

**Secrets that were shared in chat:** the test webhook secret was pasted into a chat on 28 October. If the same value is
used for the **live** webhook, change it now: Razorpay → Webhooks → Edit → new long random secret, then update
`RAZORPAY_WEBHOOK_SECRET` in Cloudflare.

## 2. Free Cloudflare protections to switch on

In the Cloudflare dashboard, for the `niyazio.com` zone:
- **Security → Bots:** turn on **Bot Fight Mode**.
- **Security → WAF → Managed rules:** turn on the **Cloudflare Free Managed Ruleset**.
- **Security → WAF → Rate limiting rules:** the free plan allows one rule. Use it for `/api/auth/*`, e.g. 20 requests per 10 seconds per IP → Block. LedgerFox also limits sign-in attempts itself.
- **SSL/TLS:** mode **Full (strict)**. Turn on **Always Use HTTPS**.
- **Notifications:** add alerts for Workers errors and for DDoS attacks, sent to `info@niyazio.com`.

## 3. Watching for trouble (10 minutes a week)

- **`/vendor` admin panel:** look for unusual sign-ups (many in a short time, odd names) and sign-in counts.
- **Cloudflare → Workers → ledgerfox → Observability:** look for spikes in errors, or in `401`/`429` responses (password guessing).
- **Razorpay → Payments and Webhooks:** look for failed webhook deliveries and payments that didn't activate a plan.
- **GitHub → Security:** look for Dependabot alerts. CI blocks deploys with high-severity advisories, but patch the others too.

## 4. If you think you're under attack

Work through these in order and write down what you did and when.

1. **Contain**
   - Password guessing or a flood of traffic: Cloudflare → Overview → **Under Attack Mode** (on, temporarily).
   - A customer account taken over: in `/vendor`, find the organisation. Then ask the owner to use **Sign out everywhere** and change their password, or reset it yourself through Users.
   - Fake sign-ups: set `ALLOW_REGISTRATION` to `false` in `wrangler.jsonc` and deploy. Existing users can still sign in.
   - A leaked secret: replace it in Razorpay or Resend first, then update the Cloudflare secret.
   - Suspicious code or a bad deploy: Cloudflare → Workers → ledgerfox → **Deployments** → roll back to the previous version.
2. **Investigate**
   - The audit log (Settings → Audit log in each company, or the `audit_logs` table) records who changed what, with IP addresses.
   - Workers Observability shows requests and errors. Razorpay's dashboard shows payment events.
3. **Recover data**
   - D1 keeps point-in-time history (Time Travel: 7 days on the free plan, 30 on paid). Restore with `npx wrangler d1 time-travel restore ledgerfox --timestamp=<before the incident>`.
   - Restoring rolls back **everything** after that moment. Export what you need first, and only restore when necessary.
4. **Tell people**
   - Affected customers should hear from you quickly and plainly: what happened, what data, what you did, what they should do.
   - In India, CERT-In expects cyber-security incidents to be reported within **6 hours** (cert-in.org.in). The **DPDP Act 2023** requires informing the Data Protection Board and affected people of a personal-data breach.
   - Check the exact current duties with a lawyer or CA. This page is not legal advice.
5. **Fix and learn**
   - Fix the cause through a pull request with a test that proves it is fixed.
   - Note what would have caught it sooner.

## 5. Answering customers

Short answers you can give. Details are on https://ledgerfox.niyazio.com/security.

- **"Is my data safe? Can other businesses see it?"** Each business's data is separated by the server on every request. Other customers get "not found" even if they guess an address, and automated tests check this on every change. Everything travels over HTTPS and is stored encrypted on Cloudflare.
- **"Do you see my card or UPI PIN?"** No. Payments happen inside Razorpay's own secure window (PCI-DSS). We only receive a confirmation, which is checked with Razorpay's signature.
- **"What if my staff leaves?"** Remove them in Settings → Users, and their access ends at once. Roles limit what each person can do, and the audit log shows who did what.
- **"What if someone steals my password?"** Turn on two-factor sign-in in Settings → My account; owners can require it for everyone. "Sign out everywhere" ends all sessions.
- **"Can entries be altered later?"** Posted invoices and entries can't be edited or deleted, only reversed. Every change is recorded in the audit trail.
- **"Can I get my data out?"** Yes, any time, as Excel/CSV or a full backup. Data is never deleted for non-payment. The desktop app keeps books on your own computer.
- **"Have you been audited / is it 100% secure?"** Be honest: no service is 100% secure. LedgerFox follows standard practice (listed on the Security page) and has automated security tests, but has **not yet had an independent penetration test**. We plan one as we grow. Don't claim certifications such as ISO 27001 or SOC 2 that we don't hold.

## 6. Next steps worth paying for later

- An independent **penetration test** of the website and API before taking larger customers. CERT-In empanelled auditors can do this.
- The **Workers Paid plan** (about $5/month), which raises `PBKDF2_ITERATIONS` to 100,000 and D1 Time Travel to 30 days.
- A written **privacy policy and terms** reviewed by a lawyer, covering the DPDP Act.
