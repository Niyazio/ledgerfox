import { Link, Navigate, useSearchParams } from "react-router";
import { useSession } from "../lib/session";
import { Wordmark } from "../components/Layout";
import { Spinner } from "../components/ui";
import { lastCompany, rememberCompany } from "../lib/lastCompany";

/**
 * /scan?p=<code>: what a product label's QR opens in any phone camera. Signed in, it goes straight to billing (POS)
 * in the company last used on this phone, with the product added; otherwise it asks to sign in first.
 */
export default function ScanOpen() {
  const [params] = useSearchParams();
  const { me, loading } = useSession();
  const code = (params.get("p") ?? "").trim();
  if (loading) return <Spinner />;
  if (!me?.user) return <Navigate to={`/login?next=${encodeURIComponent(`/scan?p=${code}`)}`} replace />;
  const companies = me.companies;
  const last = lastCompany();
  const pick = companies.find((c) => c.id === last) ?? (companies.length === 1 ? companies[0] : null);
  const to = (id: string) => `/app/${id}/pos${code ? `?add=${encodeURIComponent(code)}` : ""}`;
  if (pick) return <Navigate to={to(pick.id)} replace />;
  return (
    <div className="mx-auto max-w-md px-4 py-10">
      <div className="mb-6 text-lg"><Wordmark brand={me.brand} /></div>
      <h1 className="mb-1 text-xl font-semibold">Bill product {code}</h1>
      <p className="mb-4 text-sm muted">Choose the company to bill in.</p>
      <div className="grid gap-3">
        {companies.map((c) => <Link key={c.id} to={to(c.id)} onClick={() => rememberCompany(c.id)} className="card p-4 hover:border-brand-500">{c.name}</Link>)}
      </div>
    </div>
  );
}
