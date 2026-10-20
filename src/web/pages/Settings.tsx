import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Copy, Download, Lock, Unlock } from "lucide-react";
import { useCompany } from "../lib/company";
import { useSession } from "../lib/session";
import { useApi, useAction } from "../lib/hooks";
import { api, errorMessage } from "../lib/api";
import { Alert, Badge, Button, Card, ConfirmButton, Field, Input, Modal, PageHeader, Select, StatusBadge, TableWrap, Tabs, Textarea, useToast } from "../components/ui";
import { CURRENCY_OPTIONS } from "../components/pickers";
import { BrandingFields, type BrandingValue } from "../components/Branding";
import { ROLE_LABELS, type Role } from "@shared/permissions";
import { INDIA_STATES } from "@shared/tax";
import { fmtDate, fmtDateTime, pct, today } from "../lib/format";

type Tab = "company" | "members" | "tax" | "dimensions" | "numbering" | "currency" | "periods" | "audit" | "data" | "account" | "backup";

function CompanyTab() {
  const { settings, path, reload, can } = useCompany();
  const toast = useToast();
  const c = settings!.company;
  const [v, setV] = useState({ name: c.name, legal_name: c.legal_name ?? "", tax_id: c.tax_id ?? "", state_code: c.state_code ?? "", address: c.address ?? "", city: c.city ?? "", postal_code: c.postal_code ?? "", phone: c.phone ?? "", email: c.email ?? "", round_off_invoices: Boolean(c.round_off_invoices), invoice_terms: c.invoice_terms ?? "", date_format: c.date_format, number_locale: c.number_locale, upi_id: c.upi_id ?? "", print_template: c.print_template ?? "modern" });
  const { busy, error, run } = useAction();
  const disabled = !can("company.manage");
  return (
    <Card>
      {error && <Alert className="mb-4">{error}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Company name">{(id) => <Input id={id} disabled={disabled} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />}</Field>
        <Field label="Legal name">{(id) => <Input id={id} disabled={disabled} value={v.legal_name} onChange={(e) => setV({ ...v, legal_name: e.target.value })} />}</Field>
        <Field label={c.country === "IN" ? "GSTIN" : "Tax ID"}>{(id) => <Input id={id} disabled={disabled} className="font-mono uppercase" value={v.tax_id} onChange={(e) => setV({ ...v, tax_id: e.target.value.toUpperCase() })} />}</Field>
        {c.country === "IN" && <Field label="State">{(id) => <Select id={id} disabled={disabled} value={v.state_code} onChange={(e) => setV({ ...v, state_code: e.target.value })}><option value="">—</option>{Object.entries(INDIA_STATES).map(([k, n]) => <option key={k} value={k}>{k} · {n}</option>)}</Select>}</Field>}
        <Field label="Address" className="sm:col-span-2">{(id) => <Textarea id={id} rows={2} disabled={disabled} value={v.address} onChange={(e) => setV({ ...v, address: e.target.value })} />}</Field>
        <Field label="City">{(id) => <Input id={id} disabled={disabled} value={v.city} onChange={(e) => setV({ ...v, city: e.target.value })} />}</Field>
        <Field label="Postal code">{(id) => <Input id={id} disabled={disabled} value={v.postal_code} onChange={(e) => setV({ ...v, postal_code: e.target.value })} />}</Field>
        <Field label="Phone">{(id) => <Input id={id} disabled={disabled} value={v.phone} onChange={(e) => setV({ ...v, phone: e.target.value })} />}</Field>
        <Field label="Email">{(id) => <Input id={id} disabled={disabled} type="email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} />}</Field>
        <Field label="Date format">{(id) => <Select id={id} disabled={disabled} value={v.date_format} onChange={(e) => setV({ ...v, date_format: e.target.value })}>{["DD-MM-YYYY", "DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD"].map((f) => <option key={f}>{f}</option>)}</Select>}</Field>
        <Field label="Number format">{(id) => <Select id={id} disabled={disabled} value={v.number_locale} onChange={(e) => setV({ ...v, number_locale: e.target.value })}><option value="en-IN">1,23,456.78 (India)</option><option value="en-US">123,456.78 (US)</option><option value="en-GB">123,456.78 (UK)</option><option value="de-DE">123.456,78 (Germany)</option><option value="fr-FR">123 456,78 (France)</option><option value="ar-AE">UAE</option></Select>}</Field>
        <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" disabled={disabled} checked={v.round_off_invoices} onChange={(e) => setV({ ...v, round_off_invoices: e.target.checked })} /> Round invoice totals to the nearest whole currency unit (difference posts to Rounding Off)</label>
        <Field label="UPI ID for payment QR" hint="Printed invoices show a 'Scan to pay' UPI QR for the balance due.">{(id) => <Input id={id} disabled={disabled} placeholder="business@okbank" value={v.upi_id} onChange={(e) => setV({ ...v, upi_id: e.target.value })} />}</Field>
        <Field label="Default print layout">{(id) => <Select id={id} disabled={disabled} value={v.print_template} onChange={(e) => setV({ ...v, print_template: e.target.value })}><option value="modern">A4 — modern</option><option value="classic">A4 — classic</option><option value="compact">Compact</option></Select>}</Field>
        <Field label="Default invoice terms" className="sm:col-span-2">{(id) => <Textarea id={id} disabled={disabled} value={v.invoice_terms} onChange={(e) => setV({ ...v, invoice_terms: e.target.value })} />}</Field>
        <div className="text-sm muted sm:col-span-2">Country {c.country} · base currency {c.base_currency} · financial year starts month {c.fiscal_year_start_month}. These cannot be changed after creation.</div>
        <div className="rounded-lg bg-[var(--surface-2)] p-3 text-sm sm:col-span-2"><p className="font-medium">Tax capability for {settings!.jurisdiction.name}: <Badge color={settings!.jurisdiction.status === "implemented" ? "green" : "amber"}>{settings!.jurisdiction.status}</Badge></p><p className="mt-1 muted">{settings!.jurisdiction.notes}</p></div>
      </div>
      <BrandingCard disabled={disabled} />
      {c.is_demo ? <DeleteDemo /> : null}
      {!disabled && <Button className="mt-5" loading={busy} onClick={async () => { if (await run(() => api.patch(path("/settings"), { ...v, legal_name: v.legal_name || null, tax_id: v.tax_id || null, state_code: v.state_code || null, email: v.email || null }))) { toast("success", "Saved"); reload(); } }}>Save</Button>}
    </Card>
  );
}

function BrandingCard({ disabled }: { disabled: boolean }) {
  const { path } = useCompany();
  const toast = useToast();
  const current = useApi<BrandingValue>(path("/settings/branding"));
  const [draft, setDraft] = useState<BrandingValue | null>(null);
  const value = draft ?? current.data ?? {};
  const { busy, error, run } = useAction();
  return (
    <div className="mt-6 border-t border-[var(--border)] pt-5">
      <p className="mb-3 font-medium">Logo &amp; payment QR</p>
      {error && <Alert className="mb-3">{error}</Alert>}
      <BrandingFields value={value} onChange={(v) => !disabled && setDraft(v)} />
      {draft && !disabled && <Button className="mt-3" size="sm" loading={busy} onClick={async () => { if (await run(() => api.put(path("/settings/branding"), { logo: draft.logo ?? null, payment_qr: draft.payment_qr ?? null }))) { toast("success", "Logo and QR saved"); setDraft(null); current.reload(); } }}>Save logo &amp; QR</Button>}
    </div>
  );
}

/** Desktop only: encrypted automatic backup of this data file to the owner's LedgerFox Cloud account. */
function CloudBackupTab() {
  const toast = useToast();
  const status = useApi<{ connected: boolean; user?: string; enabled?: boolean; lastBackupAt?: string; lastError?: string }>("/api/desktop/backup/status");
  const list = useApi<{ backups: { id: string; label: string; size_bytes: number; status: string; created_at: string }[] }>(status.data?.connected ? "/api/desktop/backup/list" : null);
  const [v, setV] = useState({ login: "", password: "", passphrase: "", confirm: "" });
  const [restore, setRestore] = useState<{ id: string; passphrase: string } | null>(null);
  const [restored, setRestored] = useState<string | null>(null);
  const { busy, error, setError, run } = useAction();
  const s = status.data;
  if (!s) return <Card><p className="text-sm muted">{status.error ?? "Loading…"}</p></Card>;
  if (!s.connected) {
    return (
      <Card title="Back up this data file to LedgerFox Cloud">
        <p className="mb-4 text-sm muted">Once a day while this computer is online, LedgerFox encrypts the data file with your backup passphrase and uploads it to your free LedgerFox Cloud account (ledgerfox.niyazio.com). The passphrase never leaves this computer — without it nobody, including the website operator, can read the backup. Keep it safe: a lost passphrase means the cloud copies cannot be restored. Local daily backups continue as well.</p>
        {error && <Alert className="mb-3">{error}</Alert>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="LedgerFox Cloud username or email">{(id) => <Input id={id} autoCapitalize="none" value={v.login} onChange={(e) => setV({ ...v, login: e.target.value })} />}</Field>
          <Field label="Cloud password">{(id) => <Input id={id} type="password" value={v.password} onChange={(e) => setV({ ...v, password: e.target.value })} />}</Field>
          <Field label="Backup passphrase (min. 8 characters)">{(id) => <Input id={id} type="password" autoComplete="new-password" value={v.passphrase} onChange={(e) => setV({ ...v, passphrase: e.target.value })} />}</Field>
          <Field label="Repeat passphrase">{(id) => <Input id={id} type="password" autoComplete="new-password" value={v.confirm} onChange={(e) => setV({ ...v, confirm: e.target.value })} />}</Field>
        </div>
        <p className="mt-2 text-xs muted">No cloud account yet? Create one free at <a className="underline" href="https://ledgerfox.niyazio.com/register" target="_blank" rel="noreferrer">ledgerfox.niyazio.com</a>.</p>
        <Button className="mt-4" loading={busy} onClick={async () => {
          if (v.passphrase !== v.confirm) return setError("The passphrases do not match");
          if (await run(() => api.post("/api/desktop/backup/connect", { login: v.login, password: v.password, passphrase: v.passphrase }))) {
            toast("success", "Connected. Running the first backup…");
            status.reload();
            try { await api.post("/api/desktop/backup/run"); toast("success", "First cloud backup complete"); } catch (e) { toast("error", errorMessage(e)); }
            status.reload();
          }
        }}>Connect and back up</Button>
      </Card>
    );
  }
  return (
    <div className="space-y-4">
      <Card title="Cloud backup">
        {error && <Alert className="mb-3">{error}</Alert>}
        {s.lastError && <Alert kind="warning" className="mb-3">Last attempt failed: {s.lastError}. It retries automatically every hour while online.</Alert>}
        <p className="text-sm">Connected to LedgerFox Cloud as <b>{s.user}</b>. Last backup: <b>{s.lastBackupAt ? fmtDateTime(s.lastBackupAt) : "never"}</b>.</p>
        <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(s.enabled)} onChange={async (e) => { await api.post("/api/desktop/backup/enable", { enabled: e.target.checked }); status.reload(); }} />Back up automatically every day</label>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button loading={busy} onClick={async () => { const r = await run(() => api.post<{ size: number }>("/api/desktop/backup/run")); if (r) { toast("success", `Backed up (${Math.round(r.size / 1024)} KB encrypted)`); status.reload(); list.reload(); } }}>Back up now</Button>
          <ConfirmButton label="Disconnect" title="Disconnect cloud backup?" body="Automatic backups stop. Existing cloud backups stay in your account until replaced." onConfirm={async () => { await api.post("/api/desktop/backup/disconnect"); status.reload(); }} />
        </div>
      </Card>
      <Card title="Backups in the cloud" padded={false}>
        {restored && <Alert kind="success" className="m-3">Restored to <span className="font-mono">{restored}</span>. Open it with File → Open data file. Your current file was not changed.</Alert>}
        <TableWrap><table className="table">
          <thead><tr><th>Backup</th><th>Created</th><th className="num">Size</th><th /></tr></thead>
          <tbody>{list.data?.backups.filter((b) => b.status === "complete").map((b) => (
            <tr key={b.id}><td>{b.label}</td><td>{fmtDateTime(b.created_at)}</td><td className="num">{Math.round(b.size_bytes / 1024)} KB</td>
              <td className="text-right"><Button size="sm" variant="ghost" onClick={() => setRestore({ id: b.id, passphrase: "" })}>Restore…</Button></td></tr>
          ))}</tbody>
        </table></TableWrap>
      </Card>
      {restore && (
        <Modal open onClose={() => setRestore(null)} title="Restore a cloud backup" footer={<><Button variant="secondary" onClick={() => setRestore(null)}>Cancel</Button><Button loading={busy} onClick={async () => { const r = await run(() => api.post<{ path: string }>("/api/desktop/backup/restore", restore)); if (r) { setRestored(r.path); setRestore(null); } }}>Restore</Button></>}>
          <p className="mb-3 text-sm muted">The backup is saved as a new data file next to the current one; nothing is overwritten.</p>
          <Field label="Backup passphrase">{(id) => <Input id={id} type="password" value={restore.passphrase} onChange={(e) => setRestore({ ...restore, passphrase: e.target.value })} />}</Field>
        </Modal>
      )}
    </div>
  );
}

function DeleteDemo() {
  const { settings, can } = useCompany();
  const { refresh } = useSession();
  const nav = useNavigate();
  if (!can("company.manage")) return null;
  return (
    <div className="mt-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-800 dark:bg-amber-950/30">
      <p className="font-medium">This is a demo company.</p>
      <p className="mt-1 muted">Delete it when you are done exploring. All of its sample data is removed; your other companies are not affected.</p>
      <div className="mt-3"><ConfirmButton label="Delete demo company" title="Delete this demo company?" body="All demo invoices, bills, payroll and reports in this company are deleted permanently." confirmLabel="Delete"
        onConfirm={async () => { await api.del(`/api/orgs/${settings!.company.org_id}/companies/${settings!.company.id}`); await refresh(); nav("/app"); }} /></div>
    </div>
  );
}

function MembersTab() {
  const { settings } = useCompany();
  const orgId = settings!.company.org_id;
  const { me } = useSession();
  const toast = useToast();
  const org = useApi<any>(`/api/orgs/${orgId}`);
  const [inv, setInv] = useState({ email: "", role: "accountant" });
  const [nu, setNu] = useState({ name: "", username: "", password: "", role: "accountant" });
  const [link, setLink] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const myRole = org.data?.role as Role | undefined;
  const manage = myRole === "owner" || myRole === "admin";
  const copy = (t: string) => { navigator.clipboard?.writeText(t); toast("success", "Copied"); };
  return (
    <div className="space-y-4">
      <Card title="Members" padded={false}>
        <TableWrap><table className="table">
          <thead><tr><th>Name</th><th>Username / email</th><th>Role</th><th /></tr></thead>
          <tbody>{org.data?.members.map((m: any) => (
            <tr key={m.id}><td>{m.name}{m.id === me?.user?.id && <span className="ml-2"><Badge>you</Badge></span>}</td><td>{m.username ? <><b>{m.username}</b>{m.must_change_password ? <span className="ml-2"><Badge>temporary password</Badge></span> : null}</> : m.email}</td>
              <td>{manage && m.role !== "owner" && m.id !== me?.user?.id ? (
                <Select value={m.role} className="max-w-[11rem]" aria-label="Role" onChange={async (e) => { try { await api.patch(`/api/orgs/${orgId}/members/${m.id}`, { role: e.target.value }); org.reload(); toast("success", "Role updated"); } catch (err) { toast("error", errorMessage(err)); } }}>
                  {(["admin", "accountant", "auditor", "viewer"] as Role[]).map((r) => <option key={r} value={r} disabled={myRole !== "owner" && r === "admin"}>{ROLE_LABELS[r]}</option>)}
                </Select>) : ROLE_LABELS[m.role as Role]}</td>
              <td className="whitespace-nowrap text-right">{manage && m.role !== "owner" && m.id !== me?.user?.id && <>
                <Button size="sm" variant="ghost" onClick={async () => { try { const r = await api.post(`/api/orgs/${orgId}/members/${m.id}/reset-link`); setLink(`${location.origin}/reset?token=${r.token}`); } catch (err) { toast("error", errorMessage(err)); } }}>Reset link</Button>
                <ConfirmButton size="sm" label="Remove" title={`Remove ${m.name}?`} body="They will lose access to all companies in this organisation." confirmLabel="Remove" onConfirm={async () => { await api.del(`/api/orgs/${orgId}/members/${m.id}`); org.reload(); }} />
              </>}</td></tr>
          ))}</tbody>
        </table></TableWrap>
      </Card>
      {link && <Alert kind="success"><p>One-time password reset link (valid 24 hours). Send it to the member privately:</p><p className="mt-1 break-all font-mono text-xs">{link}</p><Button size="sm" variant="secondary" className="mt-2" onClick={() => copy(link)}><Copy className="h-3.5 w-3.5" />Copy</Button></Alert>}
      {manage && (
        <Card title="Add a user">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Name">{(id) => <Input id={id} value={nu.name} onChange={(e) => setNu({ ...nu, name: e.target.value })} />}</Field>
            <Field label="Username">{(id) => <Input id={id} autoCapitalize="none" spellCheck={false} value={nu.username} onChange={(e) => setNu({ ...nu, username: e.target.value })} />}</Field>
            <Field label="Temporary password">{(id) => <Input id={id} type="password" autoComplete="new-password" value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} />}</Field>
            <Field label="Role">{(id) => <Select id={id} value={nu.role} onChange={(e) => setNu({ ...nu, role: e.target.value })}>{(["admin", "accountant", "auditor", "viewer"] as Role[]).filter((r) => myRole === "owner" || r !== "admin").map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</Select>}</Field>
            <Button loading={busy} onClick={async () => { const r = await run(() => api.post(`/api/orgs/${orgId}/users`, nu)); if (r) { toast("success", `User ${r.username} added. They choose their own password at first sign-in.`); setNu({ name: "", username: "", password: "", role: nu.role }); org.reload(); } }}>Add user</Button>
          </div>
          <p className="mt-2 text-xs muted">Like Tally: give the person their username and temporary password. They must set their own password the first time they sign in.</p>
        </Card>
      )}
      {manage && (
        <Card title="Invite someone">
          {error && <Alert className="mb-3">{error}</Alert>}
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Email">{(id) => <Input id={id} type="email" value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} />}</Field>
            <Field label="Role">{(id) => <Select id={id} value={inv.role} onChange={(e) => setInv({ ...inv, role: e.target.value })}>{(["admin", "accountant", "auditor", "viewer"] as Role[]).filter((r) => myRole === "owner" || r !== "admin").map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</Select>}</Field>
            <Button loading={busy} onClick={async () => { const r = await run(() => api.post(`/api/orgs/${orgId}/invitations`, inv)); if (r) { setLink(`${location.origin}/invite?token=${r.token}`); setInv({ ...inv, email: "" }); org.reload(); } }}>Create invitation link</Button>
          </div>
          <p className="mt-2 text-xs muted">No email is sent (no paid email service). Copy the link and share it with the person; it expires in 7 days and only works for that email address.</p>
          <ul className="mt-4 text-xs muted">
            <li><strong>Administrator</strong>: everything except changing the owner. <strong>Accountant</strong>: create and post transactions, reconcile, approve others' expenses. <strong>Auditor</strong>: read everything including the audit log. <strong>Read-only</strong>: view documents and reports.</li>
          </ul>
          {org.data?.invitations.filter((i: any) => !i.accepted_at && !i.revoked_at).length > 0 && (
            <TableWrap><table className="table mt-4 text-sm"><thead><tr><th>Pending invitation</th><th>Role</th><th>Expires</th><th /></tr></thead>
              <tbody>{org.data.invitations.filter((i: any) => !i.accepted_at && !i.revoked_at).map((i: any) => <tr key={i.id}><td>{i.email}</td><td>{ROLE_LABELS[i.role as Role]}</td><td>{fmtDateTime(i.expires_at)}</td><td className="text-right"><Button size="sm" variant="ghost" onClick={async () => { await api.del(`/api/orgs/${orgId}/invitations/${i.id}`); org.reload(); }}>Revoke</Button></td></tr>)}</tbody></table></TableWrap>
          )}
        </Card>
      )}
    </div>
  );
}

function TaxTab() {
  const { settings, path, reload, can } = useCompany();
  const toast = useToast();
  const [v, setV] = useState({ name: "", rate: "", category: "standard" });
  return (
    <Card title="Tax codes" padded={false}>
      <p className="px-4 pt-3 text-sm muted">{settings!.tax_scheme === "in_gst" ? "GST codes split into CGST + SGST for intra-state supplies and IGST for inter-state supplies automatically. Rates are data — verify them against current notifications." : "Single-rate sales tax / VAT codes."}</p>
      <TableWrap><table className="table mt-3">
        <thead><tr><th>Name</th><th>Category</th><th className="num">Rate</th><th>Status</th><th /></tr></thead>
        <tbody>{settings!.tax_codes.map((t) => (
          <tr key={t.id}><td>{t.name}</td><td>{t.category.replace("_", " ")}</td><td className="num">{pct(t.rate_bp)}</td><td>{t.is_active ? <Badge color="green">Active</Badge> : <Badge>Inactive</Badge>}</td>
            <td className="text-right">{can("company.manage") && <Button size="sm" variant="ghost" onClick={async () => { try { await api.patch(path(`/settings/tax-codes/${t.id}`), { is_active: !t.is_active }); reload(); } catch (e) { toast("error", errorMessage(e)); } }}>{t.is_active ? "Deactivate" : "Activate"}</Button>}</td></tr>
        ))}</tbody>
      </table></TableWrap>
      {can("company.manage") && <div className="flex flex-wrap items-end gap-3 p-4">
        <Field label="Name">{(id) => <Input id={id} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />}</Field>
        <Field label="Rate %">{(id) => <Input id={id} inputMode="decimal" className="w-24" value={v.rate} onChange={(e) => setV({ ...v, rate: e.target.value })} />}</Field>
        <Field label="Category">{(id) => <Select id={id} value={v.category} onChange={(e) => setV({ ...v, category: e.target.value })}><option value="standard">Standard</option><option value="zero">Zero-rated</option><option value="exempt">Exempt</option><option value="nil">Nil-rated</option><option value="non_gst">Non-GST</option></Select>}</Field>
        <Button onClick={async () => { try { await api.post(path("/settings/tax-codes"), v); setV({ name: "", rate: "", category: "standard" }); reload(); toast("success", "Tax code added"); } catch (e) { toast("error", errorMessage(e)); } }}>Add</Button>
      </div>}
    </Card>
  );
}

function DimensionsTab() {
  const { settings, path, reload, can } = useCompany();
  const toast = useToast();
  const kinds: [string, string, "branches" | "departments" | "projects" | "cost_centres"][] = [["branches", "Branches", "branches"], ["departments", "Departments", "departments"], ["projects", "Projects", "projects"], ["cost-centres", "Cost centres", "cost_centres"]];
  const [forms, setForms] = useState<Record<string, { code: string; name: string }>>({});
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {kinds.map(([route, label, key]) => (
        <Card key={key} title={label}>
          <ul className="mb-3 space-y-1 text-sm">{(settings![key] as any[]).map((d) => (
            <li key={d.id} className="flex items-center justify-between"><span className={d.is_active ? "" : "line-through muted"}>{d.code} · {d.name}</span>
              {can("masters.write") && <Button size="sm" variant="ghost" onClick={async () => { try { await api.patch(path(`/settings/${route}/${d.id}`), { name: d.name, code: d.code, is_active: !d.is_active, state_code: d.state_code ?? null }); reload(); } catch (e) { toast("error", errorMessage(e)); } }}>{d.is_active ? "Deactivate" : "Activate"}</Button>}</li>
          ))}{!(settings![key] as any[]).length && <li className="muted">None yet. Tag journal and document lines with {label.toLowerCase()} to filter the profit & loss report.</li>}</ul>
          {can("masters.write") && <div className="flex flex-wrap items-end gap-2">
            <Input placeholder="Code" className="w-24" value={forms[key]?.code ?? ""} onChange={(e) => setForms({ ...forms, [key]: { ...forms[key], code: e.target.value } })} aria-label={`${label} code`} />
            <Input placeholder="Name" className="flex-1" value={forms[key]?.name ?? ""} onChange={(e) => setForms({ ...forms, [key]: { ...forms[key], name: e.target.value } })} aria-label={`${label} name`} />
            <Button size="sm" onClick={async () => { try { await api.post(path(`/settings/${route}`), forms[key]); setForms({ ...forms, [key]: { code: "", name: "" } }); reload(); } catch (e) { toast("error", errorMessage(e)); } }}>Add</Button>
          </div>}
        </Card>
      ))}
    </div>
  );
}

function NumberingTab() {
  const { path, can } = useCompany();
  const toast = useToast();
  const { data, reload } = useApi<{ sequences: any[] }>(path("/settings/sequences"));
  const [edit, setEdit] = useState<Record<string, { prefix: string; padding: number }>>({});
  return (
    <Card title="Document numbering" padded={false}>
      <p className="px-4 pt-3 text-sm muted">Numbers are allocated inside the posting transaction, so they are unique and never reused. Changing a prefix affects future documents only.</p>
      <TableWrap><table className="table mt-3"><thead><tr><th>Sequence</th><th>Prefix</th><th>Digits</th><th className="num">Next number</th><th /></tr></thead>
        <tbody>{data?.sequences.map((s) => {
          const e = edit[s.key] ?? { prefix: s.prefix, padding: s.padding };
          return <tr key={s.key}><td>{s.key.replace("_", " ")}</td>
            <td><Input className="w-32" disabled={!can("company.manage")} value={e.prefix} onChange={(ev) => setEdit({ ...edit, [s.key]: { ...e, prefix: ev.target.value } })} aria-label="Prefix" /></td>
            <td><Input className="w-20" type="number" min={1} max={10} disabled={!can("company.manage")} value={e.padding} onChange={(ev) => setEdit({ ...edit, [s.key]: { ...e, padding: Number(ev.target.value) } })} aria-label="Digits" /></td>
            <td className="num font-mono">{e.prefix}{String(s.next_value).padStart(e.padding, "0")}</td>
            <td>{edit[s.key] && <Button size="sm" onClick={async () => { try { await api.patch(path(`/settings/sequences/${s.key}`), e); reload(); toast("success", "Saved"); } catch (err) { toast("error", errorMessage(err)); } }}>Save</Button>}</td></tr>;
        })}</tbody></table></TableWrap>
    </Card>
  );
}

function CurrencyTab() {
  const { path, settings, can } = useCompany();
  const toast = useToast();
  const { data, reload } = useApi<{ rates: any[] }>(path("/settings/exchange-rates"));
  const base = settings!.company.base_currency;
  const [v, setV] = useState({ currency: "USD", rate_date: today(), rate: "" });
  return (
    <Card title={`Exchange rates (to ${base})`}>
      <p className="mb-3 text-sm muted">Enter rates manually from your bank or the reserve bank's reference rate. No paid rate feed is used. Documents use the latest rate on or before their date unless overridden.</p>
      {can("masters.write") && <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="Currency">{(id) => <Select id={id} value={v.currency} onChange={(e) => setV({ ...v, currency: e.target.value })}>{CURRENCY_OPTIONS.filter((c) => c !== base).map((c) => <option key={c}>{c}</option>)}</Select>}</Field>
        <Field label="Date">{(id) => <Input id={id} type="date" value={v.rate_date} onChange={(e) => setV({ ...v, rate_date: e.target.value })} />}</Field>
        <Field label={`1 ${v.currency} = ? ${base}`}>{(id) => <Input id={id} inputMode="decimal" value={v.rate} onChange={(e) => setV({ ...v, rate: e.target.value })} />}</Field>
        <Button onClick={async () => { try { await api.post(path("/settings/exchange-rates"), v); setV({ ...v, rate: "" }); reload(); toast("success", "Rate saved"); } catch (e) { toast("error", errorMessage(e)); } }}>Save rate</Button>
      </div>}
      <TableWrap><table className="table text-sm"><thead><tr><th>Date</th><th>Currency</th><th className="num">Rate</th></tr></thead>
        <tbody>{data?.rates.map((r) => <tr key={r.id}><td>{fmtDate(r.rate_date, settings!.company.date_format)}</td><td>{r.currency}</td><td className="num font-mono">{r.rate}</td></tr>)}</tbody></table></TableWrap>
    </Card>
  );
}

function PeriodsTab() {
  const { path, settings, can } = useCompany();
  const toast = useToast();
  const { data, reload } = useApi<{ fiscal_years: any[]; periods: any[] }>(path("/settings/fiscal-years"));
  const [fy, setFy] = useState({ name: "", start_date: "", end_date: "" });
  const [through, setThrough] = useState("");
  const act = async (fn: () => Promise<unknown>, msg: string) => { try { await fn(); reload(); toast("success", msg); } catch (e) { toast("error", errorMessage(e)); } };
  return (
    <div className="space-y-4">
      {can("period.manage") && <Card title="Close the books">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Lock all periods ending on or before">{(id) => <Input id={id} type="date" value={through} onChange={(e) => setThrough(e.target.value)} />}</Field>
          <Button disabled={!through} onClick={() => act(() => api.post(path("/settings/periods/lock-through"), { date: through }), "Periods locked")}><Lock className="h-4 w-4" />Lock</Button>
        </div>
        <p className="mt-2 text-xs muted">Locked periods reject any new posting, including reversals dated inside them. Unlocking is recorded in the audit log.</p>
      </Card>}
      {data?.fiscal_years.map((y) => (
        <Card key={y.id} title={`${y.name} (${fmtDate(y.start_date)} – ${fmtDate(y.end_date)})`} padded={false}>
          <div className="grid gap-px bg-[var(--border)] sm:grid-cols-3 lg:grid-cols-4">
            {data.periods.filter((p) => p.fiscal_year_id === y.id).map((p) => (
              <div key={p.id} className="flex items-center justify-between bg-[var(--surface)] px-4 py-3 text-sm">
                <span>{p.name}</span>
                <span className="flex items-center gap-2"><StatusBadge status={p.status === "open" ? "open" : "locked"} />
                  {can("period.manage") && <button className="rounded p-1 hover:bg-[var(--surface-2)]" aria-label={p.status === "open" ? `Lock ${p.name}` : `Unlock ${p.name}`} onClick={() => act(() => api.post(path(`/settings/periods/${p.id}/${p.status === "open" ? "lock" : "unlock"}`)), p.status === "open" ? "Locked" : "Unlocked")}>{p.status === "open" ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}</button>}</span>
              </div>
            ))}
          </div>
        </Card>
      ))}
      {can("period.manage") && <Card title="Add fiscal year">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Name">{(id) => <Input id={id} value={fy.name} placeholder="FY 2027-28" onChange={(e) => setFy({ ...fy, name: e.target.value })} />}</Field>
          <Field label="Start (1st of month)">{(id) => <Input id={id} type="date" value={fy.start_date} onChange={(e) => setFy({ ...fy, start_date: e.target.value })} />}</Field>
          <Field label="End (last day of month)">{(id) => <Input id={id} type="date" value={fy.end_date} onChange={(e) => setFy({ ...fy, end_date: e.target.value })} />}</Field>
          <Button onClick={() => act(() => api.post(path("/settings/fiscal-years"), fy), "Fiscal year created")}>Create</Button>
        </div>
        <p className="mt-2 text-xs muted">Monthly periods are generated automatically. Transactions can only be posted into dates covered by an open period.</p>
      </Card>}
      {settings && <p className="text-xs muted">Year-end closing entries are not required: the balance sheet computes retained earnings from the ledger.</p>}
    </div>
  );
}

function AuditTab() {
  const { path, can } = useCompany();
  const [offset, setOffset] = useState(0);
  const { data, error } = useApi<{ entries: any[] }>(can("audit.read") ? path(`/settings/audit-log?limit=100&offset=${offset}`) : null);
  if (!can("audit.read")) return <Alert kind="info">Only owners, administrators and auditors can view the audit log.</Alert>;
  return (
    <Card title="Audit log (append-only)" padded={false}>
      {error && <Alert className="m-3">{error}</Alert>}
      <TableWrap><table className="table text-sm">
        <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr></thead>
        <tbody>{data?.entries.map((e) => <tr key={e.id}><td className="whitespace-nowrap">{fmtDateTime(e.created_at)}</td><td>{e.user_name ?? "system"}<span className="block text-xs muted">{e.ip}</span></td><td><code className="text-xs">{e.action}</code></td><td className="max-w-md truncate font-mono text-xs muted" title={e.details ?? ""}>{e.details}</td></tr>)}</tbody>
      </table></TableWrap>
      <div className="flex justify-between p-3"><Button size="sm" variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>Newer</Button><Button size="sm" variant="secondary" disabled={(data?.entries.length ?? 0) < 100} onClick={() => setOffset(offset + 100)}>Older</Button></div>
    </Card>
  );
}

function DataTab() {
  const { path, settings, can } = useCompany();
  return (
    <Card title="Export & backup">
      {can("data.export") ? <>
        <p className="text-sm">Download a complete JSON export of this company: chart of accounts, all journals, documents, payments, stock, banking, assets, budgets and the audit log. Amounts are exact integer minor units.</p>
        <a className="mt-4 inline-flex items-center gap-2 rounded-lg bg-brand-700 px-3.5 py-2 text-sm font-medium text-white hover:bg-brand-800" href={path("/export")} download><Download className="h-4 w-4" />Download {settings?.company.name} export (.json)</a>
        <div className="mt-6 space-y-2 text-sm muted">
          <p><strong>What this is:</strong> an export you can keep offline. It is not an automatic backup — keep a copy after each month's close.</p>
          <p><strong>Full database backups</strong> (all companies, restorable) are taken by the system administrator with <code>wrangler d1 export</code>; see DEPLOYMENT.md. Receipt files are not included in this JSON export.</p>
          <p>Every report also has a CSV export button.</p>
        </div>
      </> : <Alert kind="info">Only owners and administrators can export company data.</Alert>}
    </Card>
  );
}

function AccountTab() {
  const toast = useToast();
  const [pw, setPw] = useState({ current_password: "", new_password: "" });
  const [codes, setCodes] = useState<string[] | null>(null);
  const [cur, setCur] = useState("");
  const sessions = useApi<{ sessions: any[] }>("/api/auth/sessions");
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Change password">
        <div className="space-y-3">
          <Field label="Current password">{(id) => <Input id={id} type="password" autoComplete="current-password" value={pw.current_password} onChange={(e) => setPw({ ...pw, current_password: e.target.value })} />}</Field>
          <Field label="New password" hint="At least 10 characters. Other sessions will be signed out.">{(id) => <Input id={id} type="password" autoComplete="new-password" value={pw.new_password} onChange={(e) => setPw({ ...pw, new_password: e.target.value })} />}</Field>
          <Button onClick={async () => { try { await api.post("/api/auth/change-password", pw); setPw({ current_password: "", new_password: "" }); toast("success", "Password changed"); } catch (e) { toast("error", errorMessage(e)); } }}>Update password</Button>
        </div>
      </Card>
      <Card title="Recovery codes">
        <p className="mb-3 text-sm muted">Generating new codes invalidates the old ones.</p>
        {codes ? <div className="grid grid-cols-2 gap-2 rounded-lg bg-[var(--surface-2)] p-3 font-mono text-sm">{codes.map((c) => <span key={c}>{c}</span>)}</div> : (
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Current password">{(id) => <Input id={id} type="password" value={cur} onChange={(e) => setCur(e.target.value)} />}</Field>
            <Button onClick={async () => { try { const r = await api.post("/api/auth/recovery-codes", { current_password: cur }); setCodes(r.recovery_codes); } catch (e) { toast("error", errorMessage(e)); } }}>Generate new codes</Button>
          </div>
        )}
      </Card>
      <Card title="Active sessions" className="lg:col-span-2" actions={<Button size="sm" variant="secondary" onClick={async () => { await api.post("/api/auth/logout-all"); location.href = "/login"; }}>Sign out everywhere</Button>}>
        <ul className="divide-y divide-[var(--border)] text-sm">{sessions.data?.sessions.map((s) => <li key={s.id} className="py-2">{s.user_agent || "Unknown device"} · {s.ip} · since {fmtDateTime(s.created_at)} {s.current && <Badge color="green">this device</Badge>}</li>)}</ul>
      </Card>
    </div>
  );
}

export default function Settings() {
  const { settings } = useCompany();
  const { me } = useSession();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) ?? "company";
  if (!settings) return null;
  return (
    <>
      <PageHeader title="Settings" subtitle={`${settings.company.name} · your role: ${ROLE_LABELS[settings.role as Role]}`} />
      <Tabs value={tab} onChange={(t) => setParams({ tab: t })} tabs={[
        { value: "company", label: "Company" }, { value: "members", label: "Team" }, { value: "tax", label: "Tax codes" }, { value: "dimensions", label: "Branches & dimensions" },
        { value: "numbering", label: "Numbering" }, { value: "currency", label: "Currencies" }, { value: "periods", label: "Fiscal periods" }, { value: "audit", label: "Audit log" },
        { value: "data", label: "Data export" }, { value: "account", label: "My account" },
        ...(me?.edition === "desktop" ? [{ value: "backup" as Tab, label: "Cloud backup" }] : []),
      ]} />
      {tab === "company" && <CompanyTab />}
      {tab === "members" && <MembersTab />}
      {tab === "tax" && <TaxTab />}
      {tab === "dimensions" && <DimensionsTab />}
      {tab === "numbering" && <NumberingTab />}
      {tab === "currency" && <CurrencyTab />}
      {tab === "periods" && <PeriodsTab />}
      {tab === "audit" && <AuditTab />}
      {tab === "data" && <DataTab />}
      {tab === "account" && <AccountTab />}
      {tab === "backup" && <CloudBackupTab />}
    </>
  );
}
