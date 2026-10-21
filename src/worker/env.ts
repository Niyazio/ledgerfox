import type { Permission, Role } from "@shared/permissions";

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
  /** Subscriptions (hosted edition only). Off unless "true". Keys come from the owner's Razorpay account (secrets). */
  BILLING_ENABLED?: string;
  BILLING_GST_PERCENT?: string;
  RAZORPAY_KEY_ID?: string;
  RAZORPAY_KEY_SECRET?: string;
  RAZORPAY_WEBHOOK_SECRET?: string;
  /** Comma-separated emails of the vendor's own staff who may open the subscriber admin page. */
  VENDOR_ADMIN_EMAILS?: string;
  /** Seller details printed on subscription tax invoices. */
  VENDOR_LEGAL_NAME?: string;
  VENDOR_GSTIN?: string;
  VENDOR_ADDRESS?: string;
  VENDOR_STATE_CODE?: string;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  username: string | null;
  must_change_password: boolean;
  totp_enabled?: boolean;
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
  purchase_approval_limit: number | null;
  billing_discount_limit_bp: number | null;
  created_at: string;
}

export type AppVariables = {
  user: SessionUser;
  company: CompanyRow;
  role: Role;
  /** Effective permissions for this company's organisation (role defaults + owner customisations). */
  perms: Permission[];
  /** Branches this member may use: every branch, or only the listed ones. */
  branches: BranchScope;
  requestId: string;
};

export interface BranchScope { all: boolean; ids: string[] }

export type AppEnv = { Bindings: Env; Variables: AppVariables };
