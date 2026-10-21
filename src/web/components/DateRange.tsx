import type { ReactNode } from "react";
import { useSearchParams } from "react-router";
import { api } from "../lib/api";
import { useCompany } from "../lib/company";
import { fyStart, today } from "../lib/format";
import { Field, Input, Select } from "./ui";

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Common periods: today, yesterday, this week, this month, last month, this financial year. */
export function datePresets(fyStartMonth: number): { label: string; from: string; to: string }[] {
  const now = new Date();
  const t = today();
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  const week = new Date(now); week.setDate(now.getDate() - ((now.getDay() + 6) % 7)); // Monday
  const monthFrom = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastFrom = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastTo = new Date(now.getFullYear(), now.getMonth(), 0);
  return [
    { label: "Today", from: t, to: t },
    { label: "Yesterday", from: iso(yest), to: iso(yest) },
    { label: "This week", from: iso(week), to: t },
    { label: "This month", from: iso(monthFrom), to: t },
    { label: "Last month", from: iso(lastFrom), to: iso(lastTo) },
    { label: "This financial year", from: fyStart(fyStartMonth), to: t },
  ];
}

/** From / To date pickers with one-click periods. Empty dates mean "no limit". */
export function DateRangeFilter({ from, to, onChange, allowAll = true }: { from: string; to: string; onChange: (from: string, to: string) => void; allowAll?: boolean }) {
  const { settings } = useCompany();
  const presets = datePresets(settings?.company.fiscal_year_start_month ?? 4);
  const current = presets.find((p) => p.from === from && p.to === to)?.label ?? (!from && !to ? "All dates" : "custom");
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label="Period">{(id) => (
        <Select id={id} value={current} onChange={(e) => {
          if (e.target.value === "All dates") return onChange("", "");
          const p = presets.find((x) => x.label === e.target.value);
          if (p) onChange(p.from, p.to);
        }}>
          {allowAll && <option>All dates</option>}
          {presets.map((p) => <option key={p.label}>{p.label}</option>)}
          <option value="custom" disabled>Custom dates</option>
        </Select>
      )}</Field>
      <Field label="From">{(id) => <Input id={id} type="date" value={from} max={to || undefined} onChange={(e) => onChange(e.target.value, to)} className="w-40" />}</Field>
      <Field label="To">{(id) => <Input id={id} type="date" value={to} min={from || undefined} onChange={(e) => onChange(from, e.target.value)} className="w-40" />}</Field>
    </div>
  );
}

/** From/to kept in the page address (?from=…&to=…), so a filtered list can be bookmarked or shared. */
export function useDateParams() {
  const [params, setParams] = useSearchParams();
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const set = (f: string, t: string) => {
    const n = new URLSearchParams(params);
    if (f) n.set("from", f); else n.delete("from");
    if (t) n.set("to", t); else n.delete("to");
    setParams(n, { replace: true });
  };
  return { from, to, set, query: `${from ? `&from=${from}` : ""}${to ? `&to=${to}` : ""}`, params, setParams };
}

/** Every row of a filtered list (all pages), for downloads. */
export async function fetchAllRows<T>(url: string, key: string, max = 20000): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; offset < max; offset += 500) {
    const r = await api.get<Record<string, unknown>>(`${url}${url.includes("?") ? "&" : "?"}limit=500&offset=${offset}`);
    const rows = (r[key] ?? []) as T[];
    out.push(...rows);
    if (rows.length < 500) break;
  }
  return out;
}

/** One line of totals above a filtered list. */
export function SummaryBar({ items }: { items: [string, ReactNode][] }) {
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-1 border-b border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm">
      {items.map(([k, v]) => <span key={k}><span className="muted">{k}:</span> <b>{v}</b></span>)}
    </div>
  );
}
