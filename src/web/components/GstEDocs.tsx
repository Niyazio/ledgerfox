import { useEffect, useState } from "react";
import { FileJson, Truck } from "lucide-react";
import { useCompany } from "../lib/company";
import { api, errorMessage } from "../lib/api";
import { Alert, Button, Field, Input, Modal, Select, Textarea, useToast } from "./ui";
import { saveFile } from "../lib/download";

export interface GstRefs {
  irn: string | null; ack_no: string | null; ack_date: string | null; signed_qr: string | null; irn_cancelled: number;
  ewb_no: string | null; ewb_date: string | null; ewb_valid_until: string | null;
}
interface Place { addr1: string; addr2: string; loc: string; pin: string }
interface Result { json: unknown; problems: string[]; places: { seller: Place; buyer: Place }; filename: string }

const EMPTY: GstRefs = { irn: null, ack_no: null, ack_date: null, signed_qr: null, irn_cancelled: 0, ewb_no: null, ewb_date: null, ewb_valid_until: null };

function download(name: string, data: unknown) {
  void saveFile(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }), name);
}

/** "2026-05-10 14:32:00" from the portals' "10/05/2026 02:32:00 PM" / ISO / "2026-05-10 14:32:00". */
function isoish(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const t = v.trim();
  const dmy = t.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?)?$/i);
  if (dmy) {
    let h = Number(dmy[4] ?? 0);
    if (dmy[7]?.toUpperCase() === "PM" && h < 12) h += 12;
    if (dmy[7]?.toUpperCase() === "AM" && h === 12) h = 0;
    return `${dmy[3]}-${dmy[2]}-${dmy[1]}${dmy[4] ? ` ${String(h).padStart(2, "0")}:${dmy[5]}:${dmy[6] ?? "00"}` : ""}`;
  }
  const iso = t.match(/^(\d{4}-\d{2}-\d{2})[ T]?(\d{2}:\d{2}(:\d{2})?)?/);
  return iso ? `${iso[1]}${iso[2] ? ` ${iso[2].length === 5 ? `${iso[2]}:00` : iso[2]}` : ""}` : null;
}

/** Reads the IRP / e-way bill response the user saved or copied (single object, array, or {data: …}). */
export function parsePortalResponse(text: string): Partial<GstRefs> {
  let o: any = JSON.parse(text);
  if (Array.isArray(o)) o = o[0];
  if (o?.data && typeof o.data === "object") o = o.data;
  if (typeof o?.Data === "string") { try { o = { ...o, ...JSON.parse(o.Data) }; } catch { /* not nested JSON */ } }
  const get = (...keys: string[]) => { for (const k of keys) { const hit = Object.keys(o ?? {}).find((x) => x.toLowerCase() === k.toLowerCase()); if (hit && o[hit] !== null && o[hit] !== "") return o[hit]; } return null; };
  const out: Partial<GstRefs> = {};
  const irn = get("Irn"); if (irn) out.irn = String(irn);
  const ack = get("AckNo", "Ack_No"); if (ack) out.ack_no = String(ack);
  const ackDt = isoish(get("AckDt", "AckDate")); if (ackDt) out.ack_date = ackDt;
  const qr = get("SignedQRCode", "SignedQrCode"); if (qr) out.signed_qr = String(qr);
  const ewb = get("EwbNo", "ewayBillNo", "ewbNo"); if (ewb) out.ewb_no = String(ewb);
  const ewbDt = isoish(get("EwbDt", "ewayBillDate", "ewbDt")); if (ewbDt) out.ewb_date = ewbDt;
  const valid = isoish(get("EwbValidTill", "validUpto", "ewbValidTill")); if (valid) out.ewb_valid_until = valid;
  return out;
}

function PlaceFields({ title, v, onChange }: { title: string; v: Place; onChange: (p: Place) => void }) {
  return (
    <fieldset className="grid gap-2 sm:grid-cols-4">
      <legend className="mb-1 text-sm font-medium">{title}</legend>
      <Field label="Address" className="sm:col-span-2">{(id) => <Input id={id} value={v.addr1} maxLength={100} onChange={(e) => onChange({ ...v, addr1: e.target.value })} />}</Field>
      <Field label="Place">{(id) => <Input id={id} value={v.loc} maxLength={50} onChange={(e) => onChange({ ...v, loc: e.target.value })} />}</Field>
      <Field label="PIN">{(id) => <Input id={id} inputMode="numeric" value={v.pin} maxLength={6} onChange={(e) => onChange({ ...v, pin: e.target.value })} />}</Field>
    </fieldset>
  );
}

function useExport(kind: "einvoice" | "eway", docId: string) {
  const { path } = useCompany();
  const [res, setRes] = useState<Result | null>(null);
  const [seller, setSeller] = useState<Place | null>(null);
  const [buyer, setBuyer] = useState<Place | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (extra: Record<string, unknown> = {}, first = false) => {
    setBusy(true); setErr(null);
    try {
      const r = await api.post<Result>(path(`/documents/${docId}/gst/${kind}`), first ? {} : { seller: seller ?? undefined, buyer: buyer ?? undefined, ...extra });
      setRes(r);
      if (first) { setSeller(r.places.seller); setBuyer(r.places.buyer); }
      return r;
    } catch (e) { setErr(errorMessage(e)); return null; } finally { setBusy(false); }
  };
  return { res, seller, buyer, setSeller, setBuyer, err, busy, run };
}

function RecordForm({ docId, refs, fields, onSaved }: { docId: string; refs: GstRefs; fields: "irn" | "ewb"; onSaved: () => void }) {
  const { path, can } = useCompany();
  const toast = useToast();
  const [v, setV] = useState<GstRefs>(refs);
  const [paste, setPaste] = useState("");
  const [err, setErr] = useState<string | null>(null);
  if (!can("sales.post")) return null;
  const fill = () => { try { setV({ ...v, ...parsePortalResponse(paste) }); setErr(null); } catch { setErr("That is not JSON. Paste the response file's contents, or type the numbers below."); } };
  const save = async () => {
    try { await api.put(path(`/documents/${docId}/gst/refs`), { ...v, irn_cancelled: Boolean(v.irn_cancelled) }); toast("success", "Saved"); onSaved(); }
    catch (e) { setErr(errorMessage(e)); }
  };
  const set = (k: keyof GstRefs, val: string) => setV({ ...v, [k]: val });
  return (
    <div className="mt-5 border-t border-[var(--border)] pt-4">
      <p className="mb-2 text-sm font-medium">{fields === "irn" ? "After generating on the IRP: record the IRN and signed QR" : "After generating: record the e-way bill number"}</p>
      {err && <Alert className="mb-2">{err}</Alert>}
      <div className="flex flex-wrap items-end gap-2">
        <Textarea rows={2} className="min-w-0 flex-1 font-mono text-xs" placeholder="Optional: paste the portal's response JSON here" value={paste} onChange={(e) => setPaste(e.target.value)} aria-label="Portal response" />
        <Button variant="secondary" size="sm" disabled={!paste.trim()} onClick={fill}>Fill from response</Button>
      </div>
      {fields === "irn" ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="IRN (64 characters)" className="sm:col-span-2">{(id) => <Input id={id} className="font-mono text-xs" value={v.irn ?? ""} onChange={(e) => set("irn", e.target.value.trim())} />}</Field>
          <Field label="Ack No">{(id) => <Input id={id} className="font-mono" value={v.ack_no ?? ""} onChange={(e) => set("ack_no", e.target.value.trim())} />}</Field>
          <Field label="Ack date" hint="YYYY-MM-DD HH:MM:SS">{(id) => <Input id={id} value={v.ack_date ?? ""} onChange={(e) => set("ack_date", e.target.value)} />}</Field>
          <Field label="Signed QR code (text)" className="sm:col-span-2">{(id) => <Textarea id={id} rows={3} className="font-mono text-xs" value={v.signed_qr ?? ""} onChange={(e) => set("signed_qr", e.target.value.trim())} />}</Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(v.irn_cancelled)} onChange={(e) => setV({ ...v, irn_cancelled: e.target.checked ? 1 : 0 })} /> IRN was cancelled on the portal</label>
        </div>
      ) : (
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Field label="E-way bill no. (12 digits)">{(id) => <Input id={id} inputMode="numeric" className="font-mono" value={v.ewb_no ?? ""} onChange={(e) => set("ewb_no", e.target.value.trim())} />}</Field>
          <Field label="Generated on">{(id) => <Input id={id} placeholder="YYYY-MM-DD" value={v.ewb_date ?? ""} onChange={(e) => set("ewb_date", e.target.value)} />}</Field>
          <Field label="Valid until">{(id) => <Input id={id} placeholder="YYYY-MM-DD" value={v.ewb_valid_until ?? ""} onChange={(e) => set("ewb_valid_until", e.target.value)} />}</Field>
        </div>
      )}
      <div className="mt-3 flex justify-end"><Button onClick={save}>Save</Button></div>
    </div>
  );
}

function Problems({ list }: { list: string[] }) {
  if (!list.length) return <Alert kind="success" className="mb-3">No problems found. The portal still validates every field when you upload.</Alert>;
  return <Alert kind="warning" className="mb-3"><p className="font-medium">Check before uploading:</p><ul className="ml-4 list-disc">{list.map((p) => <li key={p}>{p}</li>)}</ul></Alert>;
}

function EinvoiceModal({ docId, refs, onClose }: { docId: string; refs: GstRefs; onClose: (changed: boolean) => void }) {
  const x = useExport("einvoice", docId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { x.run({}, true); }, [docId]);
  return (
    <Modal open wide onClose={() => onClose(false)} title="GST e-invoice (IRN)"
      footer={<><Button variant="secondary" onClick={() => onClose(false)}>Close</Button>
        <Button variant="secondary" loading={x.busy} onClick={() => x.run()}>Check again</Button>
        <Button loading={x.busy} onClick={async () => { const r = await x.run(); if (r) download(r.filename, r.json); }}><FileJson className="h-4 w-4" />Download JSON</Button></>}>
      <p className="mb-3 text-sm muted">Download the JSON (IRP schema 1.1) and upload it at <b>einvoice1.gst.gov.in</b> → e-Invoice → Bulk upload. LedgerFox does not connect to the IRP itself. Corrections below apply to this file only.</p>
      {x.err && <Alert className="mb-3">{x.err}</Alert>}
      {x.res && <Problems list={x.res.problems} />}
      {x.seller && x.buyer && <div className="space-y-3">
        <PlaceFields title="Your address" v={x.seller} onChange={x.setSeller} />
        <PlaceFields title="Customer address" v={x.buyer} onChange={x.setBuyer} />
      </div>}
      <RecordForm docId={docId} refs={refs} fields="irn" onSaved={() => onClose(true)} />
    </Modal>
  );
}

const SUB_TYPES: [number, string][] = [[1, "Supply"], [4, "Job work"], [5, "For own use"], [8, "Others"], [10, "Line sales"], [11, "Recipient not known"], [12, "Exhibition or fairs"]];

function EwayModal({ docId, refs, challan, onClose }: { docId: string; refs: GstRefs; challan: boolean; onClose: (changed: boolean) => void }) {
  const x = useExport("eway", docId);
  const [t, setT] = useState({ trans_mode: "1", distance_km: "0", vehicle_no: "", transporter_id: "", transporter_name: "", trans_doc_no: "", trans_doc_date: "", sub_supply_type: challan ? "8" : "", sub_supply_desc: challan ? "Delivery challan" : "" });
  const extra = () => ({
    trans_mode: t.trans_mode, distance_km: Number(t.distance_km) || 0, vehicle_no: t.vehicle_no || null, transporter_id: t.transporter_id || null,
    transporter_name: t.transporter_name || null, trans_doc_no: t.trans_doc_no || null, trans_doc_date: t.trans_doc_date || null,
    ...(challan ? { sub_supply_type: Number(t.sub_supply_type), sub_supply_desc: t.sub_supply_desc || null } : {}),
  });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { x.run({}, true); }, [docId]);
  return (
    <Modal open wide onClose={() => onClose(false)} title="E-way bill"
      footer={<><Button variant="secondary" onClick={() => onClose(false)}>Close</Button>
        <Button variant="secondary" loading={x.busy} onClick={() => x.run(extra())}>Check again</Button>
        <Button loading={x.busy} onClick={async () => { const r = await x.run(extra()); if (r) download(r.filename, r.json); }}><FileJson className="h-4 w-4" />Download JSON</Button></>}>
      <p className="mb-3 text-sm muted">Upload the JSON at <b>ewaybillgst.gov.in</b> → e-Waybill → Generate Bulk. Distance 0 lets the portal work it out from the PIN codes.</p>
      {x.err && <Alert className="mb-3">{x.err}</Alert>}
      {x.res && <Problems list={x.res.problems} />}
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Mode">{(id) => <Select id={id} value={t.trans_mode} onChange={(e) => setT({ ...t, trans_mode: e.target.value })}><option value="1">Road</option><option value="2">Rail</option><option value="3">Air</option><option value="4">Ship</option></Select>}</Field>
        <Field label="Distance (km)">{(id) => <Input id={id} inputMode="numeric" value={t.distance_km} onChange={(e) => setT({ ...t, distance_km: e.target.value })} />}</Field>
        <Field label="Vehicle no.">{(id) => <Input id={id} className="uppercase" placeholder="KA01AB1234" value={t.vehicle_no} onChange={(e) => setT({ ...t, vehicle_no: e.target.value })} />}</Field>
        <Field label="Transporter ID">{(id) => <Input id={id} className="uppercase" value={t.transporter_id} onChange={(e) => setT({ ...t, transporter_id: e.target.value })} />}</Field>
        <Field label="Transporter name" className="sm:col-span-2">{(id) => <Input id={id} value={t.transporter_name} onChange={(e) => setT({ ...t, transporter_name: e.target.value })} />}</Field>
        <Field label="LR / RR / AWB no.">{(id) => <Input id={id} value={t.trans_doc_no} onChange={(e) => setT({ ...t, trans_doc_no: e.target.value })} />}</Field>
        <Field label="Its date">{(id) => <Input id={id} type="date" value={t.trans_doc_date} onChange={(e) => setT({ ...t, trans_doc_date: e.target.value })} />}</Field>
        {challan && <>
          <Field label="Reason for movement" className="sm:col-span-2">{(id) => <Select id={id} value={t.sub_supply_type} onChange={(e) => setT({ ...t, sub_supply_type: e.target.value })}>{SUB_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>
          {t.sub_supply_type === "8" && <Field label="Describe" className="sm:col-span-2">{(id) => <Input id={id} maxLength={20} value={t.sub_supply_desc} onChange={(e) => setT({ ...t, sub_supply_desc: e.target.value })} />}</Field>}
        </>}
      </div>
      {x.seller && x.buyer && <div className="mt-4 space-y-3">
        <PlaceFields title="Your address" v={x.seller} onChange={x.setSeller} />
        <PlaceFields title="Customer address" v={x.buyer} onChange={x.setBuyer} />
      </div>}
      <RecordForm docId={docId} refs={refs} fields="ewb" onSaved={() => onClose(true)} />
    </Modal>
  );
}

/** Buttons on an Indian sales document: e-invoice JSON for invoices/credit notes, e-way bill JSON for goods movement. */
export function GstEDocButtons({ doc, refs, onChanged }: { doc: { id: string; doc_type: string; variant: string | null; status: string; number: string | null }; refs: GstRefs | null; onChanged: () => void }) {
  const [open, setOpen] = useState<"einvoice" | "eway" | null>(null);
  const challan = doc.variant === "delivery_challan";
  const einv = (doc.doc_type === "invoice" || doc.doc_type === "credit_note") && doc.status === "posted";
  const eway = (einv || (challan && doc.number && doc.status !== "void")) as boolean;
  if (!einv && !eway) return null;
  const close = (changed: boolean) => { setOpen(null); if (changed) onChanged(); };
  return (
    <>
      {einv && <Button variant="secondary" onClick={() => setOpen("einvoice")}><FileJson className="h-4 w-4" />e-Invoice</Button>}
      {eway && <Button variant="secondary" onClick={() => setOpen("eway")}><Truck className="h-4 w-4" />E-way bill</Button>}
      {open === "einvoice" && <EinvoiceModal docId={doc.id} refs={refs ?? EMPTY} onClose={close} />}
      {open === "eway" && <EwayModal docId={doc.id} refs={refs ?? EMPTY} challan={challan} onClose={close} />}
    </>
  );
}
