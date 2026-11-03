import { useState } from "react";
import { GraduationCap, Trash2 } from "lucide-react";
import { useApi } from "../lib/hooks";
import { api, errorMessage } from "../lib/api";
import { Alert, Badge, Button, Card, Field, Input, Select, Spinner, TableWrap, useToast } from "./ui";
import { fmtDate, money } from "../lib/format";

interface Pack { id: string; students: number; price: Record<string, number> }
interface Access { email: string; devices: number; base_devices: number; pack: string | null; pack_until: string | null; pack_active: boolean; note: string | null; created_at: string }

const day = (iso: string | null | undefined) => (iso ? fmtDate(iso.slice(0, 10)) : "—");

/** Settings → Plan & billing in a practice company: devices in use, freeing a device, and student packs. */
export function EducationCard({ orgId }: { orgId: string }) {
  const { data, error, reload } = useApi<{
    enforced: boolean; approved: boolean; access: Access | null; allowed: number; pack_months: number; currency: string; packs: Pack[];
    devices: { device_id: string; label: string | null; first_seen_at: string; last_seen_at: string; user_name: string | null; user_email: string | null }[];
    last_request: { at: string; pack: string; students: number } | null;
  }>(`/api/education/orgs/${orgId}`);
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Spinner />;
  if (!data.enforced) return null;
  const a = data.access;
  const request = async (pack: string) => {
    setBusy(pack);
    try { await api.post(`/api/education/orgs/${orgId}/request`, { pack }); toast("success", "Request sent. LedgerFox will send you the payment link and switch the pack on."); reload(); }
    catch (e) { toast("error", errorMessage(e)); } finally { setBusy(null); }
  };
  return (
    <Card title={<span className="flex items-center gap-2"><GraduationCap className="h-5 w-5" /> Education mode</span>}>
      {!data.approved ? (
        <Alert>Education mode is not switched on for this organisation's owner. LedgerFox gives it to approved teachers, institutes and trainers: write to info@niyazio.com with the email you sign in with.</Alert>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="text-lg font-semibold">{data.devices.length} of {data.allowed} devices used</span>
            {a?.pack_active ? <Badge color="green">{a.devices}-student pack until {day(a.pack_until)}</Badge> : <Badge color="blue">Free: {data.allowed} devices</Badge>}
            {a?.pack && !a.pack_active && <Badge color="amber">Student pack ended {day(a.pack_until)}</Badge>}
          </div>
          <p className="text-sm muted">Each browser, phone or computer that opens this practice company counts as one device. Remove a device a student no longer uses to free its place.</p>
          {data.devices.length > 0 && (
            <TableWrap><table className="table">
              <thead><tr><th>Device</th><th>Last used by</th><th>First used</th><th>Last used</th><th /></tr></thead>
              <tbody>{data.devices.map((d) => (
                <tr key={d.device_id}>
                  <td>{d.label ?? "Device"}</td><td>{d.user_name ?? "—"}<span className="block text-xs muted">{d.user_email}</span></td>
                  <td>{day(d.first_seen_at)}</td><td>{day(d.last_seen_at)}</td>
                  <td className="text-right"><Button size="sm" variant="ghost" aria-label="Remove device" loading={busy === d.device_id} onClick={async () => {
                    if (!confirm("Remove this device? It can be added again later if there is a free place.")) return;
                    setBusy(d.device_id);
                    try { await api.del(`/api/education/orgs/${orgId}/devices/${encodeURIComponent(d.device_id)}`); reload(); } catch (e) { toast("error", errorMessage(e)); } finally { setBusy(null); }
                  }}><Trash2 className="h-4 w-4" /></Button></td>
                </tr>
              ))}</tbody>
            </table></TableWrap>
          )}
          <div>
            <p className="mb-2 text-sm font-medium">Bigger class? Student packs for {data.pack_months} months</p>
            <div className="grid gap-3 sm:grid-cols-3">
              {data.packs.map((p) => (
                <div key={p.id} className={`card p-4 ${a?.pack === p.id && a.pack_active ? "border-brand-600 ring-2 ring-brand-600/20" : ""}`}>
                  <p className="text-lg font-semibold">{p.students} students</p>
                  <p className="text-sm">{money(p.price[data.currency] ?? p.price.USD, data.currency in p.price ? data.currency : "USD")} <span className="muted">/ {data.pack_months} months + tax</span></p>
                  <p className="mt-1 text-xs muted">Up to {p.students} devices · every feature</p>
                  <Button size="sm" className="mt-3" variant="secondary" loading={busy === p.id} onClick={() => request(p.id)}>Request this pack</Button>
                </div>
              ))}
            </div>
            {data.last_request && <p className="mt-2 text-xs muted">Requested the {data.last_request.students}-student pack on {day(data.last_request.at)}. LedgerFox will contact you with the payment link.</p>}
          </div>
        </div>
      )}
    </Card>
  );
}

/** Admin panel: which emails may use education mode, their devices and packs, and the pack requests. */
export function EducationAdmin() {
  const { data, error, reload } = useApi<{
    access: (Access & { revoked_at: string | null; orgs: number; used: number })[];
    unapproved: { email: string; name: string; org_name: string; company: string }[];
    requests: { created_at: string; org_name: string | null; owner_email: string | null; details: { pack: string; students: number; email: string; note?: string } }[];
    packs: Pack[]; free_devices: number; pack_months: number;
  }>("/api/education/admin");
  const toast = useToast();
  const [form, setForm] = useState({ email: "", devices: "", pack: "", note: "" });
  const [busy, setBusy] = useState(false);
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Spinner />;
  const save = async (email: string, payload: Record<string, unknown>, done = "Saved") => {
    setBusy(true);
    try { await api.put(`/api/education/admin/${encodeURIComponent(email)}`, payload); toast("success", done); reload(); }
    catch (e) { toast("error", errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-4">
      <Card title="Give education mode to an email">
        <p className="mb-3 text-sm muted">Only these emails can create and open practice companies (education mode). Free: {data.free_devices} devices. A student pack raises it to 25, 50 or 100 devices for {data.pack_months} months. One demo or practice company per organisation.</p>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Email">{(id) => <Input id={id} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="teacher@school.edu" />}</Field>
          <Field label="Devices (free)" hint={`Default ${data.free_devices}`}>{(id) => <Input id={id} inputMode="numeric" value={form.devices} onChange={(e) => setForm({ ...form, devices: e.target.value })} />}</Field>
          <Field label="Student pack">{(id) => <Select id={id} value={form.pack} onChange={(e) => setForm({ ...form, pack: e.target.value })}><option value="">None</option>{data.packs.map((p) => <option key={p.id} value={p.id}>{p.students} students · {data.pack_months} months</option>)}</Select>}</Field>
          <Field label="Note">{(id) => <Input id={id} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="e.g. ABC College, paid UPI" />}</Field>
        </div>
        <Button className="mt-3" loading={busy} disabled={!form.email.includes("@")} onClick={() => void save(form.email, {
          ...(form.devices ? { devices: Number(form.devices) } : {}), ...(form.pack ? { pack: form.pack } : {}), ...(form.note ? { note: form.note } : {}),
        }, "Education mode switched on").then(() => setForm({ email: "", devices: "", pack: "", note: "" }))}>Save</Button>
      </Card>

      {data.requests.length > 0 && <Card title="Student pack requests" padded={false}><TableWrap><table className="table">
        <thead><tr><th>When</th><th>Organisation</th><th>Asked by</th><th>Pack</th><th /></tr></thead>
        <tbody>{data.requests.map((r, i) => (
          <tr key={i}><td>{day(r.created_at)}</td><td>{r.org_name ?? "—"}<span className="block text-xs muted">owner {r.owner_email}</span></td><td>{r.details.email}</td><td>{r.details.students} students{r.details.note ? <span className="block text-xs muted">{r.details.note}</span> : null}</td>
            <td className="text-right">{r.owner_email && <Button size="sm" variant="secondary" loading={busy} onClick={() => { if (confirm(`Payment received? Switch on the ${r.details.students}-student pack for ${r.owner_email} for ${data.pack_months} months.`)) void save(r.owner_email!, { pack: r.details.pack }, "Pack switched on"); }}>Switch on pack</Button>}</td></tr>
        ))}</tbody>
      </table></TableWrap></Card>}

      <Card title="Approved emails" padded={false}><TableWrap><table className="table">
        <thead><tr><th>Email</th><th>Devices</th><th>Pack</th><th>Practice orgs</th><th>Note</th><th /></tr></thead>
        <tbody>{data.access.map((a) => (
          <tr key={a.email} className={a.revoked_at ? "opacity-60" : ""}>
            <td>{a.email}{a.revoked_at && <span className="block text-xs text-red-600">removed {day(a.revoked_at)}</span>}</td>
            <td>{a.used} used / {a.devices}</td>
            <td>{a.pack ? `${a.pack.replace("edu", "")} students · ${a.pack_active ? "until" : "ended"} ${day(a.pack_until)}` : "—"}</td>
            <td>{a.orgs}</td><td className="text-xs">{a.note ?? ""}</td>
            <td className="whitespace-nowrap text-right">
              {a.revoked_at ? <Button size="sm" variant="secondary" loading={busy} onClick={() => void save(a.email, {}, "Education mode switched on again")}>Give back</Button> : <>
                {a.pack && <Button size="sm" variant="ghost" loading={busy} onClick={() => { if (confirm("End the student pack now? The free device limit applies again.")) void save(a.email, { pack: null }, "Pack ended"); }}>End pack</Button>}
                <Button size="sm" variant="ghost" loading={busy} onClick={async () => {
                  if (!confirm(`Remove education mode from ${a.email}? Their practice companies stop opening (the data is kept).`)) return;
                  try { await api.del(`/api/education/admin/${encodeURIComponent(a.email)}`); reload(); } catch (e) { toast("error", errorMessage(e)); }
                }}>Remove</Button></>}
            </td>
          </tr>
        ))}{!data.access.length && <tr><td colSpan={6} className="muted">No emails yet.</td></tr>}</tbody>
      </table></TableWrap></Card>

      {data.unapproved.length > 0 && <Card title="Practice companies without approval" padded={false}>
        <p className="px-4 pt-3 text-sm muted">Made before education mode needed approval. They do not open until you approve the owner.</p>
        <TableWrap><table className="table mt-2">
          <thead><tr><th>Owner</th><th>Organisation</th><th>Practice company</th><th /></tr></thead>
          <tbody>{data.unapproved.map((u, i) => (
            <tr key={i}><td>{u.name}<span className="block text-xs muted">{u.email}</span></td><td>{u.org_name}</td><td>{u.company}</td>
              <td className="text-right"><Button size="sm" variant="secondary" loading={busy} onClick={() => void save(u.email, {}, "Approved")}>Approve</Button></td></tr>
          ))}</tbody>
        </table></TableWrap>
      </Card>}
    </div>
  );
}
