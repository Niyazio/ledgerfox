import { useState } from "react";
import { useSearchParams } from "react-router";
import { Download, FileJson, Printer } from "lucide-react";
import { useCompany } from "../lib/company";
import { useApi } from "../lib/hooks";
import { downloadCsv } from "../lib/csv";
import { Alert, Button, Card, Field, Input, PageHeader, Select, Spinner, TableWrap, Tabs } from "../components/ui";
import { INDIA_STATES } from "@shared/tax";

const lastMonth = () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
const inr = (n: number | undefined) => (n ?? 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const state = (code: string) => `${code}-${INDIA_STATES[code] ?? ""}`;

function saveJson(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Table({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  if (!rows.length) return <p className="text-sm muted">Nothing to report.</p>;
  return (
    <TableWrap><table className="table text-sm">
      <thead><tr>{head.map((h) => <th key={h} className={/Value|Tax|Amount|Rate|Quantity|Number$/.test(h) ? "num" : ""}>{h}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={typeof c === "number" ? "num" : ""}>{typeof c === "number" ? inr(c) : c}</td>)}</tr>)}</tbody>
    </table></TableWrap>
  );
}

/** GSTR-1 and GSTR-3B preparation: review on screen, download JSON for the GST offline tool and CSV sheets. */
export default function GstReturns() {
  const { path, id, settings } = useCompany();
  const [params, setParams] = useSearchParams();
  const period = params.get("period") ?? lastMonth();
  const gstin = params.get("gstin") ?? "";
  const [tab, setTab] = useState<"gstr1" | "gstr3b">("gstr1");
  const set = (k: string, v: string) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); setParams(n, { replace: true }); };
  const q = `period=${period}${gstin ? `&gstin=${gstin}` : ""}`;
  const g1 = useApi<any>(path(`/reports/gstr1?${q}`));
  const sheets = useApi<any>(tab === "gstr1" ? path(`/reports/gstr1?${q}&format=sheets`) : null);
  const g3 = useApi<any>(tab === "gstr3b" ? path(`/reports/gstr3b?${q}`) : null);
  if (settings && settings.company.country !== "IN") return <Alert>GST returns apply to companies registered in India.</Alert>;
  const fp = period.replace(/^(\d{4})-(\d{2})$/, "$2$1");
  const err = g1.error ?? g3.error;
  const s = sheets.data?.sheets;
  const d3 = g3.data;
  return (
    <>
      <PageHeader title="GST returns" subtitle="Prepare GSTR-1 and GSTR-3B from posted invoices, credit notes, bills and expenses." back={{ to: `/app/${id}/reports`, label: "Reports" }}
        actions={<Button variant="secondary" onClick={() => window.print()}><Printer className="h-4 w-4" />Print / PDF</Button>} />
      <div className="mb-4 flex flex-wrap items-end gap-3 no-print">
        <Field label="Return period (month)">{(fid) => <Input id={fid} type="month" value={period} onChange={(e) => set("period", e.target.value)} />}</Field>
        {(g1.data?.gstins?.length ?? 0) > 1 && <Field label="GSTIN">{(fid) => (
          <Select id={fid} value={gstin || g1.data.gstin} onChange={(e) => set("gstin", e.target.value)}>{g1.data.gstins.map((g: string) => <option key={g}>{g}</option>)}</Select>)}</Field>}
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ value: "gstr1", label: "GSTR-1 (outward supplies)" }, { value: "gstr3b", label: "GSTR-3B (summary & tax)" }]} />
      {err && <Alert className="mb-3">{err}</Alert>}
      {(g1.data?.warnings ?? []).map((w: string) => <Alert key={w} kind="info" className="mb-2">{w}</Alert>)}
      {tab === "gstr1" && (g1.loading && !g1.data ? <Spinner /> : g1.data && (
        <div className="space-y-4">
          <Card title={`GSTR-1 · ${g1.data.gstin} · ${period}`} actions={<div className="flex flex-wrap gap-2 no-print">
            <Button onClick={() => saveJson(`GSTR1_${g1.data.gstin}_${fp}.json`, g1.data.json)}><FileJson className="h-4 w-4" />JSON for GST offline tool</Button>
            {s && <Button variant="secondary" onClick={() => { for (const [k, v] of Object.entries(s as Record<string, { head: string[]; rows: unknown[][] }>)) if (v.rows.length) downloadCsv(`GSTR1_${fp}_${k}.csv`, v.head, v.rows as string[][]); }}><Download className="h-4 w-4" />All sheets (CSV)</Button>}
          </div>}>
            <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-5">
              {[["B2B invoices", g1.data.summary.b2b.invoices, g1.data.summary.b2b.txval, g1.data.summary.b2b.tax], ["B2C large (B2CL)", g1.data.summary.b2cl.invoices, g1.data.summary.b2cl.txval, g1.data.summary.b2cl.tax], ["B2C small (B2CS) rows", g1.data.summary.b2cs.rows, g1.data.summary.b2cs.txval, g1.data.summary.b2cs.tax], ["Credit notes (registered)", g1.data.summary.cdnr.notes, g1.data.summary.cdnr.txval, g1.data.summary.cdnr.tax], ["Credit notes (unregistered)", g1.data.summary.cdnur.notes, undefined, undefined]].map(([l, n, t, x]) => (
                <div key={l as string} className="rounded-lg border border-[var(--border)] p-3"><p className="muted">{l}</p><p className="text-lg font-semibold">{n}</p>{t !== undefined && <p className="text-xs muted">Taxable ₹{inr(t as number)} · Tax ₹{inr(x as number)}</p>}</div>
              ))}
            </div>
            <p className="mt-3 text-xs muted">Upload the JSON in the GST offline tool (or the portal's “Prepare offline → Upload”), which validates it before you file. Nothing is sent to the GST portal from LedgerFox.</p>
          </Card>
          {s ? (["b2b", "b2cl", "b2cs", "cdnr", "hsn", "docs"] as const).map((k) => (
            <Card key={k} title={{ b2b: "4A — B2B invoices", b2cl: "5 — B2C large invoices", b2cs: "7 — B2C others", cdnr: "9B — Credit notes (registered)", hsn: "12 — HSN summary", docs: "13 — Documents issued" }[k]}>
              <Table head={s[k].head} rows={k === "b2cs" ? s[k].rows.map((r: any[]) => [r[0], state(r[1]), ...r.slice(2)]) : s[k].rows} />
            </Card>
          )) : <Spinner />}
        </div>
      ))}
      {tab === "gstr3b" && (g3.loading && !d3 ? <Spinner /> : d3 && (
        <div className="space-y-4">
          <Card title={`GSTR-3B · ${d3.gstin} · ${period}`} actions={<Button className="no-print" onClick={() => saveJson(`GSTR3B_${d3.gstin}_${fp}.json`, d3)}><FileJson className="h-4 w-4" />Download JSON</Button>}>
            <h3 className="mb-2 text-sm font-semibold">3.1 Outward supplies</h3>
            <Table head={["Nature of supplies", "Taxable Value", "Integrated Tax", "Central Tax", "State/UT Tax", "Cess Amount"]} rows={[
              ["(a) Taxable outward supplies", d3.sup_details.osup_det.txval, d3.sup_details.osup_det.iamt, d3.sup_details.osup_det.camt, d3.sup_details.osup_det.samt, 0],
              ["(b) Zero rated", 0, 0, 0, 0, 0],
              ["(c) Nil rated and exempted", d3.sup_details.osup_nil_exmp.txval, 0, 0, 0, 0],
              ["(d) Inward supplies (reverse charge)", d3.sup_details.isup_rev.txval, d3.sup_details.isup_rev.iamt, d3.sup_details.isup_rev.camt, d3.sup_details.isup_rev.samt, 0],
              ["(e) Non-GST outward supplies", d3.sup_details.osup_nongst.txval, 0, 0, 0, 0],
            ]} />
            <h3 className="mb-2 mt-5 text-sm font-semibold">3.2 Inter-state supplies to unregistered persons</h3>
            <Table head={["Place of supply", "Taxable Value", "Integrated Tax"]} rows={d3.inter_sup.unreg_details.map((x: any) => [state(x.pos), x.txval, x.iamt])} />
            <h3 className="mb-2 mt-5 text-sm font-semibold">4 Eligible input tax credit</h3>
            <Table head={["Details", "Integrated Tax", "Central Tax", "State/UT Tax", "Cess Amount"]} rows={[
              ["(A)(3) Inward supplies liable to reverse charge", d3.itc_elg.itc_avl[0].iamt, d3.itc_elg.itc_avl[0].camt, d3.itc_elg.itc_avl[0].samt, 0],
              ["(A)(5) All other ITC (bills and expenses)", d3.itc_elg.itc_avl[1].iamt, d3.itc_elg.itc_avl[1].camt, d3.itc_elg.itc_avl[1].samt, 0],
              ["(C) Net ITC available", d3.itc_elg.itc_net.iamt, d3.itc_elg.itc_net.camt, d3.itc_elg.itc_net.samt, 0],
            ]} />
            <h3 className="mb-2 mt-5 text-sm font-semibold">5 Exempt, nil and non-GST inward supplies</h3>
            <Table head={["Nature", "Inter-state", "Intra-state"]} rows={[["Exempt / nil rated purchases", d3.inward_sup.isup_details[0].inter, d3.inward_sup.isup_details[0].intra]]} />
            <h3 className="mb-2 mt-5 text-sm font-semibold">Net tax (output − input), before set-off</h3>
            <Table head={["", "Integrated Tax", "Central Tax", "State/UT Tax"]} rows={[["Payable (negative = credit carried forward)", d3.net_payable_before_set_off.iamt, d3.net_payable_before_set_off.camt, d3.net_payable_before_set_off.samt]]} />
            {(d3.reverse_charge_cash.iamt || d3.reverse_charge_cash.camt || d3.reverse_charge_cash.samt) ? <Table head={["", "Integrated Tax", "Central Tax", "State/UT Tax"]} rows={[["Reverse charge — pay in cash", d3.reverse_charge_cash.iamt, d3.reverse_charge_cash.camt, d3.reverse_charge_cash.samt]]} /> : null}
            {d3.warnings.slice(-3).map((w: string) => <p key={w} className="mt-2 text-xs muted">{w}</p>)}
          </Card>
        </div>
      ))}
      <p className="mt-4 text-xs muted no-print">Prepared from your books for review. Not validated by GSTN; check with your tax consultant before filing.</p>
    </>
  );
}
