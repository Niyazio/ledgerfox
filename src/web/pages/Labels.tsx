import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Printer, Trash2 } from "lucide-react";
import { useCompany } from "../lib/company";
import { useApi } from "../lib/hooks";
import { Alert, Button, Card, Field, Input, PageHeader, Select, TableWrap } from "../components/ui";
import { ScanInput } from "../components/Scanner";
import { code128Svg, productQrPayload } from "@shared/barcode";

interface Item { id: string; name: string; code: string | null; barcode: string | null; sku: string | null; sale_price: number; unit: string }

const SIZES = {
  "50x25": { w: "50mm", h: "25mm", label: "50 × 25 mm (roll)" },
  "38x25": { w: "38mm", h: "25mm", label: "38 × 25 mm (roll)" },
  "a4-65": { w: "38.1mm", h: "21.2mm", label: "A4 sheet, 65 per page" },
} as const;

function Label({ item, showPrice, size }: { item: Item; showPrice: boolean; size: keyof typeof SIZES }) {
  const { money } = useCompany();
  const [qr, setQr] = useState("");
  const code = item.code ?? item.sku ?? "";
  useEffect(() => { if (code) QRCode.toDataURL(productQrPayload(code), { margin: 0, width: 160, errorCorrectionLevel: "M" }).then(setQr); }, [code]);
  const s = SIZES[size];
  const bar = item.barcode || code;
  return (
    <div className="label-cell flex gap-1 overflow-hidden border border-dashed border-slate-300 bg-white p-1 text-black print:border-0" style={{ width: s.w, height: s.h }}>
      {qr && <img src={qr} alt="" className="h-full w-auto shrink-0" />}
      <div className="flex min-w-0 flex-1 flex-col justify-between">
        <p className="truncate text-[8px] font-semibold leading-tight">{item.name}</p>
        {showPrice && <p className="text-[9px] font-bold leading-tight">{money(item.sale_price)}{item.unit ? <span className="font-normal"> / {item.unit}</span> : null}</p>}
        {bar && <div className="h-[35%] w-full" dangerouslySetInnerHTML={{ __html: code128Svg(bar) }} />}
        <p className="truncate font-mono text-[7px] leading-none">{bar}</p>
      </div>
    </div>
  );
}

/** Product labels with a QR (product code only) and a Code 128 barcode, for roll printers or A4 label sheets. */
export default function Labels() {
  const { path } = useCompany();
  const [q, setQ] = useState("");
  const search = useApi<{ items: Item[] }>(q.length >= 2 ? path(`/items?active=1&limit=20&q=${encodeURIComponent(q)}`) : null);
  const [picked, setPicked] = useState<{ item: Item; copies: number }[]>([]);
  const [size, setSize] = useState<keyof typeof SIZES>("50x25");
  const [showPrice, setShowPrice] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const add = (item: Item) => setPicked((p) => (p.some((x) => x.item.id === item.id) ? p.map((x) => (x.item.id === item.id ? { ...x, copies: x.copies + 1 } : x)) : [...p, { item, copies: 1 }]));
  const labels = picked.flatMap(({ item, copies }) => Array.from({ length: copies }, (_, i) => ({ item, key: `${item.id}-${i}` })));
  return (
    <>
      <div className="no-print">
        <PageHeader title="Product labels" subtitle="QR codes hold only the product code (never prices or costs). Scan them at billing, purchase or stock count."
          actions={<Button disabled={!labels.length} onClick={() => window.print()}><Printer className="h-4 w-4" />Print {labels.length || ""} label{labels.length === 1 ? "" : "s"}</Button>} />
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Add products">
            {error && <Alert className="mb-3">{error}</Alert>}
            <ScanInput label="Scan or type a code" onItem={(it) => { setError(null); add(it as Item); }} onError={setError} />
            <Field label="Or search by name" className="mt-3">{(fid) => <Input id={fid} value={q} onChange={(e) => setQ(e.target.value)} placeholder="At least 2 letters" />}</Field>
            {search.data?.items.length ? (
              <ul className="mt-2 divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
                {search.data.items.map((it) => (
                  <li key={it.id}><button className="flex w-full justify-between px-3 py-2 text-left text-sm hover:bg-[var(--surface-2)]" onClick={() => add(it)}>
                    <span>{it.name}</span><span className="font-mono text-xs muted">{it.code}</span></button></li>
                ))}
              </ul>
            ) : null}
          </Card>
          <Card title="Labels to print">
            <div className="mb-3 flex flex-wrap items-end gap-3">
              <Field label="Label size">{(fid) => <Select id={fid} value={size} onChange={(e) => setSize(e.target.value as keyof typeof SIZES)}>{Object.entries(SIZES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</Select>}</Field>
              <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" checked={showPrice} onChange={(e) => setShowPrice(e.target.checked)} />Print selling price</label>
            </div>
            {picked.length ? (
              <TableWrap><table className="table text-sm"><thead><tr><th>Product</th><th>Code</th><th>Copies</th><th /></tr></thead>
                <tbody>{picked.map(({ item, copies }) => (
                  <tr key={item.id}><td>{item.name}</td><td className="font-mono text-xs">{item.barcode || item.code}</td>
                    <td><Input type="number" min={1} max={500} className="w-20" value={copies} aria-label="Copies" onChange={(e) => setPicked((p) => p.map((x) => (x.item.id === item.id ? { ...x, copies: Math.max(1, Math.min(500, Number(e.target.value) || 1)) } : x)))} /></td>
                    <td><button aria-label="Remove" className="rounded p-1 hover:bg-[var(--surface-2)]" onClick={() => setPicked((p) => p.filter((x) => x.item.id !== item.id))}><Trash2 className="h-4 w-4" /></button></td></tr>
                ))}</tbody></table></TableWrap>
            ) : <p className="text-sm muted">Nothing added yet.</p>}
          </Card>
        </div>
        <h2 className="mb-2 mt-6 text-sm font-semibold">Preview</h2>
      </div>
      <div className="label-sheet flex flex-wrap gap-1 print:gap-0">
        {labels.map(({ item, key }) => <Label key={key} item={item} showPrice={showPrice} size={size} />)}
      </div>
    </>
  );
}
