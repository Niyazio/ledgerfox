import type { ReactNode } from "react";
import { Link } from "react-router";
import { Wordmark } from "../components/Layout";
import { AdSense } from "../components/Ads";

const S = ({ title, children }: { title: string; children: ReactNode }) => (
  <section><h2 className="text-lg font-semibold">{title}</h2><div className="mt-1 space-y-2">{children}</div></section>
);

/** /terms — the terms customers accept when they create an account. */
export default function Terms() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <AdSense />
      <Link to="/" className="text-lg"><Wordmark iconClass="h-8 w-8" /></Link>
      <h1 className="mt-8 text-3xl font-semibold tracking-tight">Terms of service</h1>
      <p className="mt-2 text-sm muted">Last updated 30 October 2026</p>
      <div className="mt-6 space-y-5 text-[15px] leading-relaxed">
        <S title="1. Who we are">
          <p>LedgerFox is provided by NIYAZIO.COM (Niyazio Group of Companies), Karnataka, India (Udyam UDYAM-KR-11-0094729), "we" or "us". By creating an account or using LedgerFox (website, desktop app or phone app) you agree to these terms and to the <Link className="underline" to="/privacy">Privacy policy</Link>.</p>
        </S>
        <S title="2. Your account">
          <p>Give true details, keep your password and recovery codes safe, and do not share your sign-in. You are responsible for what happens under your account and for the people you add to your organisation. Tell us at once at info@niyazio.com if you think someone else has used it.</p>
        </S>
        <S title="3. Free trial, plans and payment">
          <p>A new business gets one free trial of 30 days (once per owner). After the trial, a paid plan is needed to keep adding entries; there is no free plan. Prices are shown in Settings → Plan & billing and on the checkout page. Payments are handled by Razorpay.</p>
          <p>With auto-renew, you authorise Razorpay to charge your UPI, card or bank mandate each month or year until you turn it off. Turning it off stops future charges; days already paid for are kept. If a renewal fails there are 7 days of grace, after which entries pause until you renew.</p>
          <p>Fees already paid are not refunded, except where the law requires it or where we decide otherwise. The ₹5 auto-pay check is refunded by Razorpay.</p>
        </S>
        <S title="4. Your data">
          <p>Your business records belong to you. You can view and export them at any time, also after a plan ends. We store and process them only to provide LedgerFox, as described in the Privacy policy. We do not sell them.</p>
          <p>The desktop app works online with the same account; entries made without internet are kept on that computer until they are sent. Keep the computer secure, and take backups (File → Save a backup) if you need copies of your own.</p>
        </S>
        <S title="5. Fair use">
          <p>Do not use LedgerFox for anything unlawful, including fake invoices, tax evasion or fraud; do not try to break its security, get around plan limits or licences, copy other customers' data, or overload the service. Practice companies (education mode) and demo companies are for learning and testing only: their documents are not valid for any business or tax purpose.</p>
          <p>We may pause or close an account that breaks these terms, does not pay, or puts other customers at risk. Where we can, we tell you first and let you export your data.</p>
        </S>
        <S title="6. Your responsibility for tax and accounts">
          <p>LedgerFox helps you keep accounts and prepare GST and other files, but you (and your accountant) are responsible for the correctness of what you record and file. Check figures before filing or sharing them.</p>
        </S>
        <S title="7. Service and liability">
          <p>We work to keep LedgerFox available, secure and correct, but it is provided "as is", without a guarantee that it will never be interrupted or free of errors. To the extent the law allows, our total liability for any claim is limited to the fees you paid us in the 12 months before the claim, and we are not liable for indirect losses such as lost profit.</p>
        </S>
        <S title="8. Changes">
          <p>We may change these terms or the plans. We will show the new terms here and, for important changes, tell you by email or in the app before they apply. Continuing to use LedgerFox after that means you accept them.</p>
        </S>
        <S title="9. Law and contact">
          <p>These terms are governed by the laws of India; courts in Karnataka, India have jurisdiction. Questions or complaints: <a className="underline" href="mailto:info@niyazio.com">info@niyazio.com</a>.</p>
        </S>
      </div>
    </div>
  );
}
