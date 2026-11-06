import { useEffect, useState } from "react";
import { useCompany } from "../lib/company";
import { useApi } from "../lib/hooks";
import { api } from "../lib/api";
import { Field, Input, Select } from "./ui";
import { fmtDate } from "../lib/format";

export type CustomEntity = "sales" | "purchase" | "contact" | "item";
interface Def { id: string; entity: CustomEntity; label: string; field_type: string; options: string | null; show_on_print: number; is_active: number }
export interface CustomValue { field_id: string; label: string; field_type: string; value: string; show_on_print: number }

/** The company's custom fields for one kind of record. */
export function useCustomFields(entity: CustomEntity) {
  const { path } = useCompany();
  const { data } = useApi<{ fields: Def[] }>(path("/custom-fields"));
  return (data?.fields ?? []).filter((f) => f.entity === entity && f.is_active);
}

/** Inputs for the custom fields in a form; the form saves them with saveCustomValues after the record is saved. */
export function CustomFieldInputs({ entity, entityId, values, onChange }: { entity: CustomEntity; entityId?: string | null; values: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const { path } = useCompany();
  const fields = useCustomFields(entity);
  const [loaded, setLoaded] = useState(!entityId);
  useEffect(() => {
    if (!entityId || loaded) return;
    api.get<{ values: CustomValue[] }>(path(`/custom-values/${entity}/${entityId}`))
      .then((r) => { onChange(Object.fromEntries(r.values.map((v) => [v.field_id, v.value]))); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, [entityId, entity, loaded, onChange, path]);
  if (!fields.length) return null;
  const set = (id: string, v: string) => onChange({ ...values, [id]: v });
  return (
    <>
      {fields.map((f) => (
        <Field key={f.id} label={f.label}>{(id) => {
          const v = values[f.id] ?? "";
          if (f.field_type === "select") return <Select id={id} value={v} onChange={(e) => set(f.id, e.target.value)}><option value="">—</option>{(JSON.parse(f.options ?? "[]") as string[]).map((o) => <option key={o}>{o}</option>)}</Select>;
          if (f.field_type === "checkbox") return <label className="flex h-10 items-center gap-2 text-sm"><input id={id} type="checkbox" checked={v === "1"} onChange={(e) => set(f.id, e.target.checked ? "1" : "")} /> Yes</label>;
          return <Input id={id} type={f.field_type === "date" ? "date" : "text"} inputMode={f.field_type === "number" ? "decimal" : undefined} value={v} onChange={(e) => set(f.id, e.target.value)} />;
        }}</Field>
      ))}
    </>
  );
}

/** Saves the custom values of a record (only the fields the form knows about). */
export async function saveCustomValues(path: (p: string) => string, entity: CustomEntity, entityId: string, values: Record<string, string>) {
  if (!Object.keys(values).length) return;
  await api.put(path(`/custom-values/${entity}/${entityId}`), { values });
}

export const showValue = (v: CustomValue, df?: string) => (v.field_type === "checkbox" ? "Yes" : v.field_type === "date" ? fmtDate(v.value, df) : v.value);

/** Read-only list of a record's custom values (pages and printouts). */
export function CustomValuesList({ entity, entityId, printOnly = false, className = "" }: { entity: CustomEntity; entityId: string; printOnly?: boolean; className?: string }) {
  const { path, settings } = useCompany();
  const { data } = useApi<{ values: CustomValue[] }>(path(`/custom-values/${entity}/${entityId}`));
  const list = (data?.values ?? []).filter((v) => !printOnly || v.show_on_print);
  if (!list.length) return null;
  return (
    <dl className={`grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 ${className}`}>
      {list.map((v) => <div key={v.field_id} className="flex gap-2"><dt className="muted">{v.label}:</dt><dd className="font-medium">{showValue(v, settings?.company.date_format)}</dd></div>)}
    </dl>
  );
}
