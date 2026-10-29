import { Link } from "react-router";
import { Wordmark } from "../components/Layout";
import { AdSense } from "../components/Ads";

export default function Privacy() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <AdSense />
      <Link to="/" className="text-lg"><Wordmark iconClass="h-8 w-8" /></Link>
      <h1 className="mt-8 text-3xl font-semibold tracking-tight">Privacy policy</h1>
      <p className="mt-2 text-sm muted">Last updated 21 October 2026</p>
      <div className="mt-6 space-y-5 text-[15px] leading-relaxed">
        <section><h2 className="text-lg font-semibold">Your accounting data</h2>
          <p className="mt-1">Accounts, invoices, payroll and other records you enter in LedgerFox are stored to provide the service and are not sold or shared. On the cloud edition they are stored in Cloudflare's D1 database; on the desktop edition they stay in the file you chose on your computer. You can export your data at any time. No advertising or analytics code runs on pages where you are signed in or where your data is shown.</p></section>
        <section><h2 className="text-lg font-semibold">Cookies</h2>
          <p className="mt-1">LedgerFox uses one essential sign-in cookie. The public pages of this website (home, download and this page) show advertising from Google AdSense.</p></section>
        <section><h2 className="text-lg font-semibold">Advertising (Google AdSense)</h2>
          <p className="mt-1">Third-party vendors, including Google, use cookies to serve ads based on a user's prior visits to this website or other websites. Google's use of advertising cookies enables it and its partners to serve ads to users based on their visit to this site and/or other sites on the internet. You may opt out of personalised advertising by visiting <a className="underline" href="https://www.google.com/settings/ads" rel="noreferrer" target="_blank">Google Ads Settings</a>, or opt out of some third-party vendors' use of cookies at <a className="underline" href="https://www.aboutads.info/choices/" rel="noreferrer" target="_blank">aboutads.info</a>. See <a className="underline" href="https://policies.google.com/technologies/partner-sites" rel="noreferrer" target="_blank">how Google uses information from sites that use its services</a>.</p></section>
        <section><h2 className="text-lg font-semibold">QR verification</h2>
          <p className="mt-1">Scanning the QR code on a document shows its number, date, amount, status, the issuer and the party name, so the recipient can confirm it is genuine. Each code is random and works only for that document.</p></section>
        <section><h2 className="text-lg font-semibold">Contact</h2>
          <p className="mt-1">LedgerFox is a product of <a className="underline" href="https://niyazio.com">Niyazio</a>. For privacy or support questions, email <a className="underline" href="mailto:info@niyazio.com">info@niyazio.com</a>. How your data is protected: <Link className="underline" to="/security">Security</Link>.</p></section>
      </div>
    </div>
  );
}
