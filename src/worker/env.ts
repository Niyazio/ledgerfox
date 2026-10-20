import type { Role } from "@shared/permissions";

export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  BRAND_NAME?: string;
  APP_ENV?: string;
  PBKDF2_ITERATIONS?: string;
  ALLOW_REGISTRATION?: string;
  /** "owner/repo" whose GitHub Releases host the desktop installers (download page). */
  GITHUB_REPO?: string;
  /** Minimum password length (default 10; the desktop edition uses 6, like local accounting software). */
  PASSWORD_MIN_LENGTH?: string;
  /** Optional OpenAI-compatible endpoint for a self-hosted open-source model (e.g. Ollama). Disabled when unset. */
  LOCAL_LLM_URL?: string;
  LOCAL_LLM_MODEL?: string;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  username: string | null;
  must_change_password: boolean;
  session_id: string;
}

export interface CompanyRow {
  id: string;
  org_id: string;
  name: string;
  legal_name: string | null;
  country: string;
  base_currency: string;
  fiscal_year_start_month: number;
  tax_id: string | null;
  state_code: string | null;
  address: string | null;
  city: string | null;
  postal_code: string | null;
  phone: string | null;
  email: string | null;
  date_format: string;
  number_locale: string;
  round_off_invoices: number;
  invoice_terms: string | null;
  business_type: string;
  is_demo: number;
  upi_id: string | null;
  print_template: string;
  created_at: string;
}

export type AppVariables = {
  user: SessionUser;
  company: CompanyRow;
  role: Role;
  requestId: string;
};

export type AppEnv = { Bindings: Env; Variables: AppVariables };
