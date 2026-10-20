import { useMemo } from "react";
import { useCompany, type Account } from "../lib/company";
import { useApi } from "../lib/hooks";
import { Select } from "./ui";
import { pct } from "../lib/format";

const TYPE_ORDER = ["asset", "liability", "equity", "income", "expense"];
const TYPE_LABEL: Record<string, string> = { asset: "Assets", liability: "Liabilities", equity: "Equity", income: "Income", expense: "Expenses" };

export function AccountSelect({ value, onChange, filter, id, required, allowEmpty = true, placeholder = "Select account…", disabled }: {
  value: string | null | undefined; onChange: (id: string) => void; filter?: (a: Account) => boolean; id?: string; required?: boolean; allowEmpty?: boolean; placeholder?: string; disabled?: boolean;
}) {
  const { accounts } = useCompany();
  const groups = useMemo(() => {
    const list = accounts.filter((a) => !a.is_group && (a.is_active || a.id === value) && (!filter || filter(a)));
    return TYPE_ORDER.map((t) => ({ type: t, items: list.filter((a) => a.type === t) })).filter((g) => g.items.length);
  }, [accounts, filter, value]);
  return (
    <Select id={id} value={value ?? ""} onChange={(e) => onChange(e.target.value)} required={required} disabled={disabled}>
      {allowEmpty && <option value="">{placeholder}</option>}
      {groups.map((g) => (
        <optgroup key={g.type} label={TYPE_LABEL[g.type]}>
          {g.items.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
        </optgroup>
      ))}
    </Select>
  );
}

export const isCashOrBank = (a: Account) => a.subtype === "cash" || a.subtype === "bank";

export function ContactSelect({ kind, value, onChange, id, required }: { kind: "customer" | "supplier"; value: string; onChange: (id: string, contact?: any) => void; id?: string; required?: boolean }) {
  const { path } = useCompany();
  const { data } = useApi<{ contacts: any[] }>(path(`/contacts?kind=${kind}&active=1&limit=500`));
  return (
    <Select id={id} value={value} required={required} onChange={(e) => onChange(e.target.value, data?.contacts.find((c) => c.id === e.target.value))}>
      <option value="">Select {kind}…</option>
      {data?.contacts.map((c) => <option key={c.id} value={c.id}>{c.name}{c.currency ? ` (${c.currency})` : ""}</option>)}
    </Select>
  );
}

export function TaxSelect({ value, onChange, id }: { value: string | null | undefined; onChange: (id: string) => void; id?: string }) {
  const { settings } = useCompany();
  return (
    <Select id={id} value={value ?? ""} onChange={(e) => onChange(e.target.value)} aria-label="Tax code">
      <option value="">No tax</option>
      {settings?.tax_codes.filter((t) => t.is_active || t.id === value).map((t) => (
        <option key={t.id} value={t.id}>{t.name}{t.category === "standard" && !t.name.includes("%") ? ` (${pct(t.rate_bp)})` : ""}</option>
      ))}
    </Select>
  );
}

export function DimensionSelect({ kind, value, onChange, id }: { kind: "departments" | "projects" | "cost_centres" | "branches"; value: string | null | undefined; onChange: (id: string) => void; id?: string }) {
  const { settings } = useCompany();
  const list = (settings?.[kind] ?? []) as { id: string; name: string; code: string; is_active: number }[];
  if (!list.length) return null;
  const label = { departments: "Department", projects: "Project", cost_centres: "Cost centre", branches: "Branch" }[kind];
  return (
    <Select id={id} value={value ?? ""} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      <option value="">{label}: none</option>
      {list.filter((d) => d.is_active || d.id === value).map((d) => <option key={d.id} value={d.id}>{d.code} · {d.name}</option>)}
    </Select>
  );
}

export const CURRENCY_OPTIONS = ["INR", "USD", "EUR", "GBP", "AED", "SAR", "QAR", "OMR", "KWD", "BHD", "SGD", "AUD", "CAD", "NZD", "JPY", "CNY", "CHF", "ZAR", "NPR", "LKR", "BDT", "MYR", "KES"];
