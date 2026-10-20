import { useState, type FormEvent, type ReactNode } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import { api } from "../lib/api";
import { useAction } from "../lib/hooks";
import { useSession } from "../lib/session";
import { Alert, Button, Field, Input } from "../components/ui";
import { Wordmark } from "../components/Layout";

function AuthCard({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  const { me } = useSession();
  return (
    <div className="flex min-h-full items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <Link to="/" className="mb-6 flex justify-center text-lg"><Wordmark brand={me?.brand} iconClass="h-8 w-8" /></Link>
        <div className="card p-6 shadow-sm">
          <h1 className="text-xl font-semibold">{title}</h1>
          {subtitle && <p className="mt-1 text-sm muted">{subtitle}</p>}
          <div className="mt-5">{children}</div>
        </div>
      </div>
    </div>
  );
}

export function Login() {
  const { me, refresh } = useSession();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const { busy, error, run } = useAction();
  if (me?.user) return <Navigate to={params.get("next") ?? "/app"} replace />;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await run(() => api.post("/api/auth/login", { login, password }));
    if (ok) { await refresh(); nav(params.get("next") ?? "/app"); }
  };
  return (
    <AuthCard title="Sign in" subtitle={me?.registration === "closed" ? "Ask the owner for an invitation if you don't have an account." : <>New here? <Link className="text-brand-700 hover:underline dark:text-brand-300" to="/register">Create an account</Link></>}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        {me?.default_login && (
          <Alert kind="info">First time? Sign in with username <b>admin</b> and password <b>admin</b>. You will be asked to choose your own password straight away.</Alert>
        )}
        <Field label="Username or email">{(id) => <Input id={id} autoComplete="username" autoCapitalize="none" spellCheck={false} required value={login} onChange={(e) => setLogin(e.target.value)} />}</Field>
        <Field label="Password">{(id) => <Input id={id} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
        <Button type="submit" loading={busy} className="w-full">Sign in</Button>
        <p className="text-center text-sm"><Link to="/forgot" className="muted hover:underline">Forgot password?</Link></p>
      </form>
    </AuthCard>
  );
}

export function Register() {
  const { me, refresh } = useSession();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [form, setForm] = useState({ name: "", email: "", username: "", password: "", confirm: "" });
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const { busy, error, setError, run } = useAction();
  if (me?.user && !codes) return <Navigate to="/app" replace />;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (form.password !== form.confirm) return setError("Passwords do not match");
    const r = await run(() => api.post<{ recovery_codes: string[] }>("/api/auth/register", { name: form.name, email: form.email, username: form.username || null, password: form.password }));
    if (r) setCodes(r.recovery_codes);
  };
  if (codes) {
    return (
      <AuthCard title="Save your recovery codes" subtitle="There is no email-based password reset. These one-time codes are the way to recover your account if you forget your password.">
        <div className="grid grid-cols-2 gap-2 rounded-lg bg-[var(--surface-2)] p-4 font-mono text-sm">
          {codes.map((c) => <span key={c}>{c}</span>)}
        </div>
        <div className="mt-3 flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => navigator.clipboard?.writeText(codes.join("\n"))}>Copy</Button>
          <Button variant="secondary" size="sm" onClick={() => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([codes.join("\n")], { type: "text/plain" })); a.download = "ledgerfox-recovery-codes.txt"; a.click(); }}>Download</Button>
        </div>
        <label className="mt-4 flex items-center gap-2 text-sm"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I have stored these codes somewhere safe</label>
        <Button className="mt-4 w-full" disabled={!saved} onClick={async () => { await refresh(); nav(params.get("next") ?? "/app"); }}>Continue</Button>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Create your account" subtitle={<>Already registered? <Link className="text-brand-700 hover:underline dark:text-brand-300" to="/login">Sign in</Link></>}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field label="Your name">{(id) => <Input id={id} required autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
        <Field label="Email">{(id) => <Input id={id} type="email" required autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />}</Field>
        <Field label="Username (optional)" hint="Sign in with this instead of your email.">{(id) => <Input id={id} autoComplete="username" autoCapitalize="none" spellCheck={false} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />}</Field>
        <Field label="Password" hint="At least 10 characters. A short sentence works well.">{(id) => <Input id={id} type="password" required minLength={10} autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />}</Field>
        <Field label="Confirm password">{(id) => <Input id={id} type="password" required minLength={10} autoComplete="new-password" value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} />}</Field>
        <Button type="submit" loading={busy} className="w-full">Create account</Button>
      </form>
    </AuthCard>
  );
}

export function Forgot() {
  const [form, setForm] = useState({ email: "", recovery_code: "", new_password: "" });
  const [done, setDone] = useState(false);
  const { busy, error, run } = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api.post("/api/auth/recover", form))) setDone(true);
  };
  return (
    <AuthCard title="Recover your account" subtitle="Use one of the recovery codes you saved when you registered. If you have none left, ask your organisation's owner or administrator for a reset link.">
      {done ? (
        <div className="space-y-4"><Alert kind="success">Password changed. All existing sessions were signed out.</Alert><Link to="/login" className="block text-center text-brand-700 hover:underline dark:text-brand-300">Sign in</Link></div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          {error && <Alert>{error}</Alert>}
          <Field label="Email">{(id) => <Input id={id} type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />}</Field>
          <Field label="Recovery code">{(id) => <Input id={id} required placeholder="XXXX-XXXX-XXXX" className="font-mono uppercase" value={form.recovery_code} onChange={(e) => setForm({ ...form, recovery_code: e.target.value })} />}</Field>
          <Field label="New password">{(id) => <Input id={id} type="password" required minLength={10} autoComplete="new-password" value={form.new_password} onChange={(e) => setForm({ ...form, new_password: e.target.value })} />}</Field>
          <Button type="submit" loading={busy} className="w-full">Reset password</Button>
        </form>
      )}
    </AuthCard>
  );
}

export function ResetWithToken() {
  const [params] = useSearchParams();
  const [pw, setPw] = useState("");
  const [done, setDone] = useState(false);
  const { busy, error, run } = useAction();
  const token = params.get("token") ?? "";
  return (
    <AuthCard title="Set a new password">
      {done ? (
        <div className="space-y-4"><Alert kind="success">Password updated.</Alert><Link to="/login" className="block text-center text-brand-700 hover:underline dark:text-brand-300">Sign in</Link></div>
      ) : (
        <form onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.post("/api/auth/reset", { token, new_password: pw }))) setDone(true); }} className="space-y-4">
          {!token && <Alert>This link is missing its token.</Alert>}
          {error && <Alert>{error}</Alert>}
          <Field label="New password" hint="At least 10 characters.">{(id) => <Input id={id} type="password" required minLength={10} value={pw} onChange={(e) => setPw(e.target.value)} />}</Field>
          <Button type="submit" loading={busy} disabled={!token} className="w-full">Save password</Button>
        </form>
      )}
    </AuthCard>
  );
}

export function AcceptInvite() {
  const { me, refresh } = useSession();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { busy, error, run } = useAction();
  const token = params.get("token") ?? "";
  if (!me?.user) {
    const next = encodeURIComponent(`/invite?token=${token}`);
    return (
      <AuthCard title="You've been invited" subtitle="Sign in or create an account with the email address the invitation was sent to.">
        <div className="flex gap-2">
          <Link to={`/login?next=${next}`} className="flex-1 rounded-lg border border-[var(--border)] px-4 py-2 text-center text-sm font-medium hover:bg-[var(--surface-2)]">Sign in</Link>
          <Link to={`/register?next=${next}`} className="flex-1 rounded-lg bg-brand-700 px-4 py-2 text-center text-sm font-medium text-white hover:bg-brand-800">Create account</Link>
        </div>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Join organisation" subtitle={`Signed in as ${me.user.email}`}>
      {error && <Alert className="mb-4">{error}</Alert>}
      <Button loading={busy} className="w-full" onClick={async () => { if (await run(() => api.post("/api/invitations/accept", { token }))) { await refresh(); nav("/app"); } }}>Accept invitation</Button>
    </AuthCard>
  );
}

/** Shown instead of the app while the account is on a default or temporary password. */
export function ChangePasswordFirst() {
  const { me, refresh, logout } = useSession();
  const [form, setForm] = useState({ current_password: "", new_password: "", confirm: "", username: me?.user?.username ?? "" });
  const { busy, error, setError, run } = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (form.new_password !== form.confirm) return setError("The new passwords do not match");
    const ok = await run(() => api.post("/api/auth/change-password", { current_password: form.current_password, new_password: form.new_password, username: form.username || undefined }));
    if (ok) await refresh();
  };
  return (
    <AuthCard title="Choose your own password" subtitle="For your security, replace the temporary password before using LedgerFox.">
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field label="Username" hint="You sign in with this.">{(id) => <Input id={id} autoCapitalize="none" spellCheck={false} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />}</Field>
        <Field label="Current (temporary) password" required>{(id) => <Input id={id} type="password" autoComplete="current-password" required value={form.current_password} onChange={(e) => setForm({ ...form, current_password: e.target.value })} />}</Field>
        <Field label="New password" required>{(id) => <Input id={id} type="password" autoComplete="new-password" required value={form.new_password} onChange={(e) => setForm({ ...form, new_password: e.target.value })} />}</Field>
        <Field label="Confirm new password" required>{(id) => <Input id={id} type="password" autoComplete="new-password" required value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} />}</Field>
        <Button type="submit" loading={busy} className="w-full">Save and continue</Button>
        <p className="text-center text-sm"><button type="button" className="muted hover:underline" onClick={() => void logout()}>Sign out</button></p>
      </form>
    </AuthCard>
  );
}
