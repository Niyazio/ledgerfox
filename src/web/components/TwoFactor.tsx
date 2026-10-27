import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { ShieldCheck } from "lucide-react";
import { useSession } from "../lib/session";
import { api, errorMessage } from "../lib/api";
import { Alert, Badge, Button, Card, Field, Input } from "./ui";

/** Turn two-factor sign-in on or off for the signed-in user (any authenticator app: Google/Microsoft Authenticator, Authy, 2FAS…). */
export function TwoFactorCard({ onDone }: { onDone?: () => void }) {
  const { me, refresh } = useSession();
  const on = Boolean((me?.user as { totp_enabled?: boolean } | null)?.totp_enabled);
  const [pw, setPw] = useState("");
  const [setup, setSetup] = useState<{ secret: string; otpauth_url: string } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (setup) QRCode.toDataURL(setup.otpauth_url, { margin: 1, width: 200 }).then(setQr); }, [setup]);
  const act = async (fn: () => Promise<void>) => { setBusy(true); setError(null); try { await fn(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); } };
  return (
    <Card title={<span className="flex items-center gap-2"><ShieldCheck className="h-4 w-4" />Two-factor sign-in {on ? <Badge color="green">on</Badge> : <Badge>off</Badge>}</span>}>
      {error && <Alert className="mb-3">{error}</Alert>}
      {codes ? <>
        <p className="mb-2 text-sm">Two-factor sign-in is on. Save these recovery codes somewhere safe — each one lets you in once if you lose your phone:</p>
        <div className="grid grid-cols-2 gap-2 rounded-lg bg-[var(--surface-2)] p-3 font-mono text-sm">{codes.map((c) => <span key={c}>{c}</span>)}</div>
        <Button className="mt-3" onClick={() => { setCodes(null); onDone?.(); }}>I have saved them</Button>
      </> : setup ? <>
        <ol className="mb-3 list-decimal space-y-1 pl-5 text-sm">
          <li>Open an authenticator app on your phone and add an account by scanning this code.</li>
          <li>Type the 6-digit code the app shows.</li>
        </ol>
        {qr && <img src={qr} alt="QR code for your authenticator app" className="h-44 w-44" />}
        <p className="mt-2 break-all text-xs muted">Can't scan? Enter this key: <span className="font-mono select-all">{setup.secret}</span></p>
        <div className="mt-3 flex items-end gap-2">
          <Field label="Code from the app">{(id) => <Input id={id} inputMode="numeric" maxLength={6} autoComplete="one-time-code" className="w-32 font-mono tracking-widest" value={code} onChange={(e) => setCode(e.target.value)} />}</Field>
          <Button loading={busy} onClick={() => void act(async () => { const r = await api.post<{ recovery_codes: string[] }>("/api/auth/2fa/enable", { code }); setCodes(r.recovery_codes); setSetup(null); await refresh(); })}>Turn on</Button>
        </div>
      </> : <>
        <p className="mb-3 text-sm muted">{on ? "Signing in asks for a code from your phone as well as your password." : "Protect your account: after your password, sign-in asks for a 6-digit code from an app on your phone."}</p>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Current password">{(id) => <Input id={id} type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />}</Field>
          {on && <Field label="Code from the app">{(id) => <Input id={id} inputMode="numeric" maxLength={6} className="w-28 font-mono" value={code} onChange={(e) => setCode(e.target.value)} />}</Field>}
          {on
            ? <Button variant="secondary" loading={busy} onClick={() => void act(async () => { await api.post("/api/auth/2fa/disable", { current_password: pw, code }); setPw(""); setCode(""); await refresh(); })}>Turn off</Button>
            : <Button loading={busy} onClick={() => void act(async () => { setSetup(await api.post("/api/auth/2fa/setup", { current_password: pw })); setPw(""); })}>Set up</Button>}
        </div>
      </>}
    </Card>
  );
}
