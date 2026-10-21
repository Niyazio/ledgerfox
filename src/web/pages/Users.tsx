import { useState } from "react";
import { Copy } from "lucide-react";
import { useCompany } from "../lib/company";
import { useSession } from "../lib/session";
import { useApi, useAction } from "../lib/hooks";
import { api, errorMessage } from "../lib/api";
import { Alert, Badge, Button, Card, ConfirmButton, Field, Input, Modal, Select, TableWrap, useToast } from "../components/ui";
import { PERMISSION_GROUPS, ROLES, ROLE_DESCRIPTIONS, ROLE_LABELS, canAssignRole, type Permission, type Role } from "@shared/permissions";
import { fmtDateTime } from "../lib/format";

type Member = { id: string; name: string; email: string; username: string | null; must_change_password: number; role: Role; all_branches: number; branches: { company_id: string; branch_id: string }[] };

/** Shows a one-time password once, with a copy button. */
function OneTimePassword({ who, password, onClose }: { who: string; password: string; onClose: () => void }) {
  const toast = useToast();
  return (
    <Modal open title="One-time password" onClose={onClose}>
      <p className="text-sm">Give this to <b>{who}</b> privately. It is shown only now; LedgerFox stores only a hash. They must choose their own password at first sign-in.</p>
      <p className="my-4 select-all rounded-lg bg-[var(--surface-2)] p-3 text-center font-mono text-lg tracking-wide">{password}</p>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={() => { navigator.clipboard?.writeText(password); toast("success", "Copied"); }}><Copy className="h-4 w-4" />Copy</Button>
        <Button onClick={onClose}>Done</Button>
      </div>
    </Modal>
  );
}

function BranchAccess({ member, orgId, onClose }: { member: Member; orgId: string; onClose: () => void }) {
  const { settings, branches } = useCompany();
  const companyId = settings!.company.id;
  const limited = settings!.branch_scope?.all === false; // a branch manager can only give their own branches
  const [all, setAll] = useState(Boolean(member.all_branches) && !limited);
  const [ids, setIds] = useState<string[]>(member.branches.filter((b) => b.company_id === companyId).map((b) => b.branch_id));
  const { busy, error, run } = useAction();
  return (
    <Modal open title={`Branches for ${member.name}`} onClose={onClose}>
      {error && <Alert className="mb-3">{error}</Alert>}
      {!limited && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />All branches (including ones added later)</label>}
      {!all && (
        <div className="mt-3 space-y-1">
          {branches.length === 0 && <p className="text-sm muted">This company has no branches yet. Add them under Settings → Dimensions.</p>}
          {branches.map((b) => (
            <label key={b.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={ids.includes(b.id)} onChange={(e) => setIds(e.target.checked ? [...ids, b.id] : ids.filter((x) => x !== b.id))} />
              {b.name} <span className="muted">({b.code}){!b.is_active && " · inactive"}</span>
            </label>
          ))}
        </div>
      )}
      <p className="mt-3 text-xs muted">The server enforces this: the member cannot open, list or report on other branches' records even by editing links.</p>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button loading={busy} onClick={async () => { if (await run(() => api.put(`/api/orgs/${orgId}/members/${member.id}/branches`, { company_id: companyId, all_branches: all, branch_ids: ids }))) onClose(); }}>Save</Button>
      </div>
    </Modal>
  );
}

function RoleEditor({ orgId }: { orgId: string }) {
  const toast = useToast();
  const roles = useApi<{ roles: { role: Role; customised: boolean; defaults: Permission[]; permissions: Permission[] }[] }>(`/api/orgs/${orgId}/roles`);
  const [role, setRole] = useState<Role>("admin");
  const [draft, setDraft] = useState<Permission[] | null>(null);
  const current = roles.data?.roles.find((r) => r.role === role);
  const perms = draft ?? current?.permissions ?? [];
  const { busy, run } = useAction();
  const pick = (r: Role) => { setRole(r); setDraft(null); };
  return (
    <Card title="Role permissions">
      <p className="mb-3 text-sm muted">Customise what each role may do in this organisation. The Owner role always has every permission and cannot be changed.</p>
      <div className="mb-4 flex flex-wrap gap-2">
        {ROLES.filter((r) => r !== "owner").map((r) => (
          <Button key={r} size="sm" variant={r === role ? "primary" : "secondary"} onClick={() => pick(r)}>
            {ROLE_LABELS[r]}{roles.data?.roles.find((x) => x.role === r)?.customised ? " *" : ""}
          </Button>
        ))}
      </div>
      <p className="mb-3 text-sm">{ROLE_DESCRIPTIONS[role]}</p>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {Object.entries(PERMISSION_GROUPS).map(([group, items]) => (
          <fieldset key={group} className="rounded-lg border border-[var(--border)] p-3">
            <legend className="px-1 text-sm font-semibold">{group}</legend>
            {Object.entries(items).map(([p, label]) => (
              <label key={p} className={`flex items-start gap-2 py-0.5 text-sm ${p === "roles.manage" ? "opacity-50" : ""}`}>
                <input type="checkbox" className="mt-1" disabled={p === "roles.manage"} checked={perms.includes(p as Permission)}
                  onChange={(e) => setDraft(e.target.checked ? [...perms, p as Permission] : perms.filter((x) => x !== p))} />
                <span>{label}{current && current.defaults.includes(p as Permission) !== perms.includes(p as Permission) && <span className="ml-1 text-xs text-amber-600">(changed)</span>}</span>
              </label>
            ))}
          </fieldset>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button loading={busy} disabled={!draft} onClick={async () => { if (await run(() => api.put(`/api/orgs/${orgId}/roles/${role}`, { permissions: perms }))) { toast("success", `${ROLE_LABELS[role]} updated`); setDraft(null); roles.reload(); } }}>Save {ROLE_LABELS[role]}</Button>
        {draft && <Button variant="secondary" onClick={() => setDraft(null)}>Discard changes</Button>}
        {current?.customised && <ConfirmButton label="Reset to defaults" title={`Reset ${ROLE_LABELS[role]}?`} body="The role goes back to LedgerFox's default permissions." confirmLabel="Reset" onConfirm={async () => { await api.del(`/api/orgs/${orgId}/roles/${role}`); setDraft(null); roles.reload(); }} />}
      </div>
    </Card>
  );
}

export function MembersTab() {
  const { settings } = useCompany();
  const orgId = settings!.company.org_id;
  const { me } = useSession();
  const toast = useToast();
  const org = useApi<any>(`/api/orgs/${orgId}`);
  const [inv, setInv] = useState({ email: "", role: "billing" });
  const [nu, setNu] = useState({ name: "", username: "", role: "billing" });
  const [link, setLink] = useState<string | null>(null);
  const [shown, setShown] = useState<{ who: string; password: string } | null>(null);
  const [branchesFor, setBranchesFor] = useState<Member | null>(null);
  const { busy, error, run } = useAction();
  const myRole = org.data?.role as Role | undefined;
  const myPerms: string[] = org.data?.permissions ?? [];
  const manage = myPerms.includes("org.manage");
  const assignable = ROLES.filter((r) => myRole && canAssignRole(myRole, r));
  const branchName = (id: string) => settings!.branches.find((b: any) => b.id === id)?.name ?? "?";
  const copy = (t: string) => { navigator.clipboard?.writeText(t); toast("success", "Copied"); };
  const companyId = settings!.company.id;
  const scope = settings!.branch_scope;
  return (
    <div className="space-y-4">
      <Card title="Users" padded={false}>
        <TableWrap><table className="table">
          <thead><tr><th>Name</th><th>Username / email</th><th>Role</th><th>Branches</th><th /></tr></thead>
          <tbody>{(org.data?.members as Member[] | undefined)?.map((m) => {
            const editable = manage && m.role !== "owner" && m.id !== me?.user?.id && myRole && canAssignRole(myRole, m.role);
            const mine = m.branches.filter((b) => b.company_id === companyId);
            return (
              <tr key={m.id}><td>{m.name}{m.id === me?.user?.id && <span className="ml-2"><Badge>you</Badge></span>}</td>
                <td>{m.username ? <><b>{m.username}</b>{m.must_change_password ? <span className="ml-2"><Badge>temporary password</Badge></span> : null}</> : m.email}</td>
                <td>{editable ? (
                  <Select value={m.role} className="max-w-[13rem]" aria-label="Role" onChange={async (e) => { try { await api.patch(`/api/orgs/${orgId}/members/${m.id}`, { role: e.target.value }); org.reload(); toast("success", "Role updated"); } catch (err) { toast("error", errorMessage(err)); } }}>
                    {[...assignable, ...(assignable.includes(m.role) ? [] : [m.role])].map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                  </Select>) : ROLE_LABELS[m.role]}</td>
                <td className="text-sm">{m.role === "owner" || m.all_branches ? "All" : mine.length ? mine.map((b) => branchName(b.branch_id)).join(", ") : <span className="text-red-600">None in this company</span>}
                  {editable && <Button size="sm" variant="ghost" onClick={() => setBranchesFor(m)}>Change</Button>}</td>
                <td className="whitespace-nowrap text-right">{editable && <>
                  {m.username && <Button size="sm" variant="ghost" onClick={async () => { try { const r = await api.post(`/api/orgs/${orgId}/members/${m.id}/temporary-password`); setShown({ who: m.name, password: r.temporary_password }); org.reload(); } catch (err) { toast("error", errorMessage(err)); } }}>New one-time password</Button>}
                  {!m.username && <Button size="sm" variant="ghost" onClick={async () => { try { const r = await api.post(`/api/orgs/${orgId}/members/${m.id}/reset-link`); setLink(`${location.origin}/reset?token=${r.token}`); } catch (err) { toast("error", errorMessage(err)); } }}>Reset link</Button>}
                  <ConfirmButton size="sm" label="Remove" title={`Remove ${m.name}?`} body="They will lose access to all companies in this organisation. Their past entries keep their name in the audit trail." confirmLabel="Remove" onConfirm={async () => { await api.del(`/api/orgs/${orgId}/members/${m.id}`); org.reload(); }} />
                </>}</td></tr>
            );
          })}</tbody>
        </table></TableWrap>
      </Card>
      {shown && <OneTimePassword who={shown.who} password={shown.password} onClose={() => setShown(null)} />}
      {branchesFor && <BranchAccess member={branchesFor} orgId={orgId} onClose={() => { setBranchesFor(null); org.reload(); }} />}
      {link && <Alert kind="success"><p>One-time link. Send it to the person privately:</p><p className="mt-1 break-all font-mono text-xs">{link}</p><Button size="sm" variant="secondary" className="mt-2" onClick={() => copy(link)}><Copy className="h-3.5 w-3.5" />Copy</Button></Alert>}
      {manage && (
        <Card title="Add a user">
          {error && <Alert className="mb-3">{error}</Alert>}
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Name">{(id) => <Input id={id} value={nu.name} onChange={(e) => setNu({ ...nu, name: e.target.value })} />}</Field>
            <Field label="Username">{(id) => <Input id={id} autoCapitalize="none" spellCheck={false} value={nu.username} onChange={(e) => setNu({ ...nu, username: e.target.value })} />}</Field>
            <Field label="Role">{(id) => <Select id={id} value={nu.role} onChange={(e) => setNu({ ...nu, role: e.target.value })}>{assignable.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</Select>}</Field>
            <Button loading={busy} onClick={async () => { const r = await run(() => api.post(`/api/orgs/${orgId}/users`, { ...nu, ...(scope?.all === false ? { branches: { company_id: companyId, all_branches: false, branch_ids: scope.ids } } : {}) })); if (r) { setShown({ who: nu.name || r.username, password: r.temporary_password }); setNu({ name: "", username: "", role: nu.role }); org.reload(); } }}>Add user</Button>
          </div>
          <p className="mt-2 text-xs muted">LedgerFox creates a random one-time password for each person (never a shared default). {scope?.all === false ? "New users work in your branches; adjust with “Change” in the Branches column." : "New users can see all branches until you limit them with “Change” in the Branches column."}</p>
          <p className="mt-2 text-xs muted">{ROLE_LABELS[nu.role as Role]}: {ROLE_DESCRIPTIONS[nu.role as Role]}</p>
        </Card>
      )}
      {manage && scope?.all !== false && (
        <Card title="Invite someone by email">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Email">{(id) => <Input id={id} type="email" value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} />}</Field>
            <Field label="Role">{(id) => <Select id={id} value={inv.role} onChange={(e) => setInv({ ...inv, role: e.target.value })}>{assignable.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</Select>}</Field>
            <Button loading={busy} onClick={async () => { const r = await run(() => api.post(`/api/orgs/${orgId}/invitations`, inv)); if (r) { setLink(`${location.origin}/invite?token=${r.token}`); setInv({ ...inv, email: "" }); org.reload(); } }}>Create invitation link</Button>
          </div>
          <p className="mt-2 text-xs muted">No email is sent (no paid email service). Copy the link and share it; it expires in 7 days and only works for that email address.</p>
          {org.data?.invitations.filter((i: any) => !i.accepted_at && !i.revoked_at).length > 0 && (
            <TableWrap><table className="table mt-4 text-sm"><thead><tr><th>Pending invitation</th><th>Role</th><th>Expires</th><th /></tr></thead>
              <tbody>{org.data.invitations.filter((i: any) => !i.accepted_at && !i.revoked_at).map((i: any) => <tr key={i.id}><td>{i.email}</td><td>{ROLE_LABELS[i.role as Role]}</td><td>{fmtDateTime(i.expires_at)}</td><td className="text-right"><Button size="sm" variant="ghost" onClick={async () => { await api.del(`/api/orgs/${orgId}/invitations/${i.id}`); org.reload(); }}>Revoke</Button></td></tr>)}</tbody></table></TableWrap>
          )}
        </Card>
      )}
      {myPerms.includes("roles.manage") && <RoleEditor orgId={orgId} />}
    </div>
  );
}
