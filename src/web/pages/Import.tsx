import { useState } from "react";
import { Download, FileUp, CheckCircle2 } from "lucide-react";
import { useCompany } from "../lib/company";
import { api, errorMessage } from "../lib/api";
import { downloadCsv } from "../lib/csv";
import { readSheet, type SheetRow } from "../lib/sheet";
import { Alert, Button, Card, Field, Input, PageHeader, Select, TableWrap } from "../components/ui";
import { today } from "../lib/format";

type Kind = "contacts" | "items";
interface Result { created: number; skipped: { row: number; reason: string }[]; errors: { row: number; message: string }[]; new_units?: string[] }

const TEMPLATES: Record<Kind, { head: string[]; sample: string[][]; help: string }> = {
  contacts: {
    head: ["Name", "Type", "GSTIN", "State", "Phone", "Email", "Address", "Credit Days", "Credit Limit", "PAN"],
    sample: [["Sharma Traders", "Customer", "", "Karnataka", "9845000001", "", "MG Road, Bengaluru", "15", "50000", ""], ["Mehta Wholesale", "Supplier", "", "27", "", "accounts@mehta.example", "", "30", "", ""]],
    help: "Type is Customer, Supplier or Both (default: Customer). State can be the name or the 2-digit GST code; it is taken from the GSTIN when blank. Rows whose name or GSTIN already exists are skipped.",
  },
  items: {
    head: ["Name", "Type", "HSN", "GST %", "Unit", "Selling Price", "Purchase Price", "SKU", "Barcode", "Opening Stock", "Opening Rate", "Warehouse", "Reorder Level"],
    sample: [["Basmati Rice 5kg", "Goods", "1006", "5", "bag", "650", "520", "RICE5", "8901000000011", "10", "", "", "5"], ["Delivery charge", "Service", "996812", "18", "nos", "50", "", "", "", "", "", "", ""]],
    help: "GST % is a rate (5, 18, 18%) or Exempt / Nil. Opening Stock is posted on the date below, valued at Opening Rate (or Purchase Price). New units are added automatically. Existing names or SKUs are skipped.",
  },
};

const CHUNK = 200;

/** Import customers, suppliers and products from Excel (.xlsx) or CSV — checked first, then saved in chunks. */
export default function Import() {
  const { path, can, id } = useCompany();
  const [kind, setKind] = useState<Kind>(can("items.write") ? "items" : "contacts");
  const [rows, setRows] = useState<SheetRow[] | null>(null);
  const [file, setFile] = useState("");
  const [asOf, setAsOf] = useState(today());
  const [check, setCheck] = useState<Result | null>(null);
  const [done, setDone] = useState<Result | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const t = TEMPLATES[kind];

  const send = async (dryRun: boolean): Promise<Result> => {
    const total: Result = { created: 0, skipped: [], errors: [], new_units: [] };
    for (let i = 0; i < rows!.length; i += CHUNK) {
      setBusy(`${dryRun ? "Checking" : "Importing"} rows ${i + 1}–${Math.min(i + CHUNK, rows!.length)} of ${rows!.length}…`);
      const r = await api.post<Result>(path(`/import/${kind}`), { rows: rows!.slice(i, i + CHUNK), dry_run: dryRun, as_of: kind === "items" ? asOf : undefined });
      const shift = <T extends { row: number }>(x: T) => ({ ...x, row: x.row + i + 1 }); // +1 for the header row
      total.created += r.created;
      total.skipped.push(...r.skipped.map(shift));
      total.errors.push(...r.errors.map(shift));
      total.new_units!.push(...(r.new_units ?? []));
      if (!dryRun && r.errors.length) break; // stop at the first rejected chunk; earlier chunks are saved
    }
    return total;
  };

  const run = async (dryRun: boolean) => {
    setError(null);
    try {
      const r = await send(dryRun);
      if (dryRun) setCheck(r); else { setDone(r); setCheck(null); }
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(null); }
  };

  const pick = async (f: File | undefined) => {
    setRows(null); setCheck(null); setDone(null); setError(null);
    if (!f) return;
    try {
      const r = await readSheet(f);
      if (r.length > 5000) throw new Error("Up to 5,000 rows at a time — split the file");
      setRows(r); setFile(f.name);
    } catch (e) { setError((e as Error).message); }
  };

  const columns = rows?.length ? Object.keys(rows[0]) : [];
  return (
    <>
      <PageHeader title="Import data" subtitle="Bring customers, suppliers and products from Excel, Tally, Vyapar or any spreadsheet." />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="1. What are you importing?">
          <Field label="Import">{(fid) => (
            <Select id={fid} value={kind} onChange={(e) => { setKind(e.target.value as Kind); setRows(null); setCheck(null); setDone(null); }}>
              {(can("customers.write") || can("suppliers.write")) && <option value="contacts">Customers & suppliers</option>}
              {can("items.write") && <option value="items">Products, services & opening stock</option>}
            </Select>)}</Field>
          <p className="mt-3 text-xs muted">{t.help}</p>
          <Button variant="secondary" className="mt-3" onClick={() => downloadCsv(`ledgerfox-${kind}-template.csv`, t.head, t.sample)}><Download className="h-4 w-4" />Download template</Button>
        </Card>
        <Card title="2. Choose your file">
          <label className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed border-[var(--border)] p-6 text-center text-sm hover:border-brand-500">
            <FileUp className="h-6 w-6 muted" />
            <span>{file || "Excel (.xlsx) or CSV file"}</span>
            <input type="file" accept=".xlsx,.csv,.txt,.xls" className="sr-only" onChange={(e) => void pick(e.target.files?.[0])} />
          </label>
          <p className="mt-2 text-xs muted">The first row must be the column names. Columns are matched by name (e.g. “Party Name”, “GST No”, “HSN Code”); extra columns are ignored. The file is read in your browser.</p>
          {kind === "items" && <Field label="Opening stock date" className="mt-3">{(fid) => <Input id={fid} type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />}</Field>}
        </Card>
        <Card title="3. Check and import">
          {!rows ? <p className="text-sm muted">Choose a file first.</p> : <>
            <p className="text-sm"><b>{rows.length}</b> rows found in {file}.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="secondary" loading={busy?.startsWith("Checking")} disabled={!!busy} onClick={() => void run(true)}>Check file</Button>
              <Button disabled={!!busy || !check || check.errors.length > 0} onClick={() => void run(false)}>Import {check ? check.created : ""} rows</Button>
            </div>
            {busy && <p className="mt-2 text-xs muted">{busy}</p>}
            {check && !check.errors.length && <p className="mt-3 text-sm text-emerald-700 dark:text-emerald-400">Ready: {check.created} new, {check.skipped.length} already exist and will be skipped.{check.new_units?.length ? ` New units: ${check.new_units.join(", ")}.` : ""}</p>}
          </>}
        </Card>
      </div>
      {error && <Alert className="mt-4">{error}</Alert>}
      {done && (
        <Alert kind={done.errors.length ? "error" : "success"} className="mt-4">
          <p className="flex items-center gap-2 font-medium"><CheckCircle2 className="h-4 w-4" />Imported {done.created} {kind === "items" ? "products" : "contacts"}; skipped {done.skipped.length} existing.</p>
          {done.errors.length > 0 && <p className="mt-1 text-sm">Stopped at a chunk with errors (listed below); rows before it were saved. Fix the file and import again — saved rows will be skipped.</p>}
          <p className="mt-1 text-sm"><a className="underline" href={`/app/${id}/${kind === "items" ? "inventory" : "customers"}`}>Open the list</a></p>
        </Alert>
      )}
      {(check?.errors.length || done?.errors.length) ? (
        <Card title={`Fix these rows (${(check ?? done)!.errors.length})`} className="mt-4" padded={false}>
          <TableWrap><table className="table text-sm"><thead><tr><th>Row in file</th><th>Problem</th></tr></thead>
            <tbody>{(check ?? done)!.errors.slice(0, 300).map((e) => <tr key={e.row + e.message}><td>{e.row}</td><td>{e.message}</td></tr>)}</tbody></table></TableWrap>
        </Card>
      ) : null}
      {rows && (
        <Card title={`Preview (first ${Math.min(10, rows.length)} rows)`} className="mt-4" padded={false}>
          <TableWrap><table className="table text-sm">
            <thead><tr><th>Row</th>{columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>{rows.slice(0, 10).map((r, i) => <tr key={i}><td className="muted">{i + 2}</td>{columns.map((c) => <td key={c}>{r[c]}</td>)}</tr>)}</tbody>
          </table></TableWrap>
        </Card>
      )}
    </>
  );
}
