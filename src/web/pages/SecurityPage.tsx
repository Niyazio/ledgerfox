import type { ReactNode } from "react";
import { Link } from "react-router";
import { Wordmark } from "../components/Layout";

/** /security — plain-language answers for customers who ask how their books are protected. No ad code on this page. */
const Item = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="card p-5"><h2 className="text-base font-semibold">{title}</h2><div className="mt-1.5 space-y-1.5 text-[15px] leading-relaxed">{children}</div></section>
);

export default function SecurityPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <Link to="/" className="text-lg"><Wordmark iconClass="h-8 w-8" /></Link>
      <h1 className="mt-8 text-3xl font-semibold tracking-tight">Security at LedgerFox</h1>
      <p className="mt-2 max-w-2xl muted">Your accounts, invoices, payroll and customer details are your business's most private records. This page explains how LedgerFox protects them, in plain words. Last updated 29 October 2026.</p>

      <div className="mt-8 grid gap-4 md:grid-cols-2">
        <Item title="Your data is kept separate from every other business">
          <p>Every request is checked against your organisation membership on the server. Another customer cannot see or change your records, even if they guess an address or ID: the server answers "not found". Automated tests try exactly this on every change.</p>
        </Item>
        <Item title="Encrypted everywhere">
          <p>The website only works over HTTPS (TLS), and browsers are told never to use plain HTTP. Data is stored on Cloudflare's infrastructure, which encrypts it at rest. The desktop app's cloud backups are encrypted on your computer (AES-256) with your own passphrase before they leave it.</p>
        </Item>
        <Item title="Passwords and sign-in">
          <p>Passwords are never stored, only a salted, slow hash of them. Repeated wrong passwords are slowed down and blocked. You can turn on two-factor sign-in with an authenticator app, and owners can require it for their whole team. "Sign out everywhere" ends every session at once.</p>
        </Item>
        <Item title="Each person sees only what their job needs">
          <p>Roles for owner, admin, billing, purchase, accountant, inventory, auditor and viewer, with permissions checked on the server for every read and write; the owner can adjust what each role may do. Staff can be limited to their own branch. Large purchases can require approval by someone else.</p>
        </Item>
        <Item title="Nothing can be quietly changed afterwards">
          <p>Posted invoices and journal entries cannot be edited or deleted, only reversed. Closed periods are locked. An audit trail records who changed what and when, with the old and new values, and it cannot be edited.</p>
        </Item>
        <Item title="Payments are handled by Razorpay">
          <p>Card numbers and UPI PINs are entered only in Razorpay's own secure window (PCI-DSS compliant); LedgerFox never sees or stores them. Every payment is confirmed with Razorpay's cryptographic signature before a plan is activated.</p>
        </Item>
        <Item title="Protection against common web attacks">
          <p>A strict Content-Security-Policy allows only LedgerFox's own code to run inside the app. There are no ad, tracking or analytics scripts on any signed-in page. Requests from other websites are refused (CSRF protection). Every database query is parameterised (no SQL injection). Uploads are checked by file content, and Excel and CSV exports are protected against formula injection.</p>
        </Item>
        <Item title="Always yours: export and keep a copy">
          <p>You can download all your data at any time (Excel, CSV and a full backup). The free desktop app keeps your books on your own computer, with no internet needed. Your data is never deleted for non-payment.</p>
        </Item>
        <Item title="Kept up to date">
          <p>Every change runs hundreds of automated tests, including security tests, before it can go live. Releases are blocked if a known high-severity vulnerability is found in the software LedgerFox depends on. The source code is open, so anyone can inspect it.</p>
        </Item>
        <Item title="What you can do">
          <p>Use a long, unique password, and turn on two-factor sign-in (Settings → My account). Give staff their own logins with the smallest role they need. Remove people who leave. Download a backup now and then.</p>
        </Item>
      </div>

      <div className="mt-8 space-y-3 text-[15px] leading-relaxed">
        <h2 className="text-lg font-semibold">Being honest about limits</h2>
        <p>No online service can promise it can never be attacked. LedgerFox has not yet had an independent penetration test; we plan one as the service grows. The cloud database is encrypted by Cloudflare, but not separately by LedgerFox, so LedgerFox's operators could technically access it. We access customer data only to provide support you ask for, or when the law requires it.</p>
        <h2 className="pt-2 text-lg font-semibold">Report a security problem</h2>
        <p>If you find a weakness, please email <a className="underline" href="mailto:info@niyazio.com?subject=LedgerFox%20security">info@niyazio.com</a> with the subject "LedgerFox security". We reply within 2 working days and fix confirmed issues as a priority. Please do not access other people's data or disrupt the service while testing.</p>
        <p className="text-sm muted">See also the <Link className="underline" to="/privacy">privacy policy</Link>. LedgerFox is a product of <a className="underline" href="https://niyazio.com">Niyazio</a>.</p>
      </div>
    </div>
  );
}
