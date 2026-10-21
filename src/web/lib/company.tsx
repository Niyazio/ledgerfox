import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "./api";
import type { Permission } from "@shared/permissions";

export interface CompanySettings {
  company: {
    id: string; org_id: string; name: string; legal_name: string | null; country: string; base_currency: string;
    fiscal_year_start_month: number; tax_id: string | null; state_code: string | null; address: string | null; city: string | null;
    postal_code: string | null; phone: string | null; email: string | null; date_format: string; number_locale: string;
    round_off_invoices: number; invoice_terms: string | null;
    business_type?: string; is_demo?: number; upi_id?: string | null; print_template?: string;
    purchase_approval_limit?: number | null; billing_discount_limit_bp?: number | null;
  };
  role: string;
  permissions: Permission[];
  branch_scope: { all: boolean; ids: string[] };
  jurisdiction: { name: string; status: string; notes: string };
  tax_scheme: string;
  branches: any[]; departments: any[]; projects: any[]; cost_centres: any[];
  tax_codes: { id: string; name: string; rate_bp: number; category: string; is_active: number; scheme: string }[];
  warehouses: any[]; units: any[];
}

export interface Account { id: string; code: string; name: string; type: string; subtype: string; parent_id: string | null; is_group: number; is_active: number; system_key: string | null; debit_total: number; credit_total: number; description: string | null }

interface CompanyCtx {
  id: string;
  settings: CompanySettings | null;
  accounts: Account[];
  reload: () => Promise<void>;
  reloadAccounts: () => Promise<void>;
  can: (p: Permission) => boolean;
  path: (p: string) => string;
  money: (minor: number | null | undefined, currency?: string) => string;
  /** Branches this member may use, and the one chosen in the header ("" = all of them). */
  branches: { id: string; name: string; code: string; is_active: number; invoice_prefix?: string | null }[];
  branch: string;
  setBranch: (id: string) => void;
  /** `&branch_id=…` for list and report URLs when a branch is chosen. */
  branchQuery: string;
}

const Ctx = createContext<CompanyCtx | null>(null);

import { money as fmtMoney } from "./format";

export function CompanyProvider({ id, children }: { id: string; children: ReactNode }) {
  const [settings, setSettings] = useState<CompanySettings | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [error, setError] = useState<string | null>(null);
  const key = `ledgerfox-branch-${id}`;
  const [branch, setBranchState] = useState(() => { try { return localStorage.getItem(key) ?? ""; } catch { return ""; } });
  const setBranch = (b: string) => { setBranchState(b); try { localStorage.setItem(key, b); } catch { /* storage unavailable */ } };
  const reload = useCallback(async () => {
    try {
      setSettings(await api.get(`/api/c/${id}/settings`));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);
  const reloadAccounts = useCallback(async () => {
    const r = await api.get<{ accounts: Account[] }>(`/api/c/${id}/accounts`).catch(() => ({ accounts: [] }));
    setAccounts(r.accounts);
  }, [id]);
  useEffect(() => { setSettings(null); reload(); reloadAccounts(); }, [reload, reloadAccounts]);
  if (error) return <div className="p-8 text-center"><p className="text-lg font-semibold">Company unavailable</p><p className="muted mt-2">{error}</p></div>;
  const scope = settings?.branch_scope ?? { all: true, ids: [] };
  const branches = (settings?.branches ?? []).filter((b) => scope.all || scope.ids.includes(b.id));
  // A member limited to some branches always works in one of them; a stale choice falls back to the first allowed.
  const chosen = branches.some((b) => b.id === branch) ? branch : scope.all ? "" : branches[0]?.id ?? "";
  const value: CompanyCtx = {
    id, settings, accounts, reload, reloadAccounts,
    can: (p) => settings?.permissions.includes(p) ?? false,
    path: (p) => `/api/c/${id}${p}`,
    money: (m, cur) => fmtMoney(m, cur ?? settings?.company.base_currency ?? "INR", settings?.company.number_locale ?? "en-IN"),
    branches, branch: chosen, setBranch,
    branchQuery: chosen ? `&branch_id=${encodeURIComponent(chosen)}` : "",
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCompany() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useCompany outside provider");
  return c;
}
