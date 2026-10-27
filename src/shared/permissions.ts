/**
 * Roles and fine-grained permissions. Every check happens on the server; the UI only hides what the server refuses.
 * Owners can customise every role except Owner for their organisation (stored as overrides in `role_permissions`).
 */

export type Role = "owner" | "admin" | "billing" | "purchase" | "accountant" | "inventory" | "auditor" | "viewer";

/** The seven default roles offered in the UI, in display order. `viewer` remains for existing members. */
export const ROLES: Role[] = ["owner", "admin", "billing", "purchase", "accountant", "inventory", "auditor"];
export const ALL_ROLES: Role[] = [...ROLES, "viewer"];

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner / Super admin",
  admin: "Admin / Branch manager",
  billing: "Billing staff",
  purchase: "Purchase staff",
  accountant: "Accountant",
  inventory: "Inventory / Storekeeper",
  auditor: "Viewer / Auditor",
  viewer: "Read-only (legacy)",
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  owner: "Everything, including users, roles, branches and company settings. Cannot be locked out.",
  admin: "Runs assigned branches: customers, suppliers, products, staff below admin, approvals and branch reports.",
  billing: "Quotations, invoices, receipts, returns; prints and shares; sees customer balances.",
  purchase: "Purchase orders, supplier bills, returns and supplier payments; prints labels.",
  accountant: "Ledgers, journals, banking, reconciliation, expenses, financial and tax reports.",
  inventory: "Stock movements, transfers between branches, counts and adjustments, labels.",
  auditor: "Read-only access to transactions, reports, daybook and audit history.",
  viewer: "Read-only access to documents and reports (older role).",
};

/** Permission catalogue grouped for the role editor. */
export const PERMISSION_GROUPS = {
  "Administration": {
    "org.manage": "Manage users and invitations",
    "roles.manage": "Customise role permissions",
    "branches.manage": "Create, edit and deactivate branches",
    "company.manage": "Company settings, tax codes, numbering",
    "period.manage": "Lock and unlock accounting periods",
    "data.export": "Full data export and backups",
  },
  "Sales & billing": {
    "sales.view": "View quotations, orders, invoices, credit notes and receipts",
    "sales.create": "Create and edit draft sales documents",
    "sales.post": "Issue invoices and record receipts",
    "sales.void": "Cancel or reverse sales documents and receipts",
    "sales.discount_any": "Give discounts above the billing discount limit",
    "sales.credit_override": "Issue invoices above a customer's credit limit",
    "customers.write": "Add and edit customers",
  },
  "Purchases": {
    "purchase.view": "View purchase orders, bills, debit notes and payments",
    "purchase.create": "Create and edit draft purchase documents",
    "purchase.post": "Post bills and record supplier payments",
    "purchase.approve": "Approve purchases above the approval limit",
    "purchase.void": "Cancel or reverse purchase documents and payments",
    "suppliers.write": "Add and edit suppliers",
  },
  "Inventory": {
    "inventory.view": "View products and stock",
    "items.write": "Add and edit products and services",
    "items.cost": "Change purchase costs and valuation settings",
    "inventory.adjust": "Stock counts and adjustments",
    "inventory.transfer": "Transfer stock between warehouses and branches",
    "labels.print": "Print product labels",
  },
  "Accounting": {
    "accounts.write": "Edit the chart of accounts and budgets",
    "journal.view": "View journals and ledgers",
    "journal.create": "Create draft journals",
    "journal.post": "Post journals and opening balances",
    "journal.reverse": "Reverse posted journals",
    "bank.reconcile": "Bank import, matching and reconciliation",
    "expense.create": "Record expenses",
    "expense.approve": "Approve and post expenses",
    "assets.manage": "Fixed assets and depreciation",
  },
  "Reports & audit": {
    "reports.read": "Financial reports and the dashboard",
    "reports.export": "Export reports (CSV / print)",
    "daybook.read": "Daybook",
    "audit.read": "Audit log and record history",
  },
  "Payroll": {
    "payroll.read": "View salaries, payslips and salary reports",
    "payroll.manage": "Employees, timesheets and payroll runs",
  },
} as const;

type Groups = typeof PERMISSION_GROUPS;
export type Permission = { [G in keyof Groups]: keyof Groups[G] }[keyof Groups] & string;
export const ALL_PERMISSIONS = Object.values(PERMISSION_GROUPS).flatMap((g) => Object.keys(g)) as Permission[];

const VIEW: Permission[] = ["sales.view", "purchase.view", "inventory.view", "journal.view", "reports.read", "daybook.read"];

const DEFAULTS: Record<Role, Permission[]> = {
  owner: ALL_PERMISSIONS,
  admin: ALL_PERMISSIONS.filter((p) => p !== "roles.manage" && p !== "data.export"),
  billing: ["sales.view", "sales.create", "sales.post", "customers.write", "inventory.view", "labels.print"],
  purchase: ["purchase.view", "purchase.create", "purchase.post", "suppliers.write", "inventory.view", "items.write", "labels.print"],
  accountant: [
    ...VIEW, "reports.export", "audit.read", "accounts.write", "journal.create", "journal.post", "journal.reverse", "bank.reconcile",
    "expense.create", "expense.approve", "assets.manage", "sales.create", "sales.post", "sales.void", "purchase.create", "purchase.post", "purchase.void",
    "customers.write", "suppliers.write", "payroll.read", "payroll.manage", "sales.credit_override",
  ],
  inventory: ["inventory.view", "inventory.adjust", "inventory.transfer", "labels.print", "items.write"],
  auditor: [...VIEW, "audit.read", "reports.export", "payroll.read"],
  viewer: ["sales.view", "purchase.view", "inventory.view", "reports.read"],
};

export function defaultPermissions(role: Role): Permission[] {
  return [...(DEFAULTS[role] ?? [])];
}

/** Effective permissions: role defaults with the organisation's overrides applied. Owner is never reduced. */
export function effectivePermissions(role: Role, overrides: { permission: string; allowed: number }[] = []): Permission[] {
  if (role === "owner") return [...ALL_PERMISSIONS];
  const set = new Set<Permission>(DEFAULTS[role] ?? []);
  for (const o of overrides) {
    if (!ALL_PERMISSIONS.includes(o.permission as Permission) || o.permission === "roles.manage") continue;
    if (o.allowed) set.add(o.permission as Permission);
    else set.delete(o.permission as Permission);
  }
  return [...set];
}

/** Default-matrix check (used where no organisation context exists). */
export function can(role: Role | null | undefined, perm: Permission): boolean {
  if (!role) return false;
  return (DEFAULTS[role] ?? []).includes(perm);
}

export function permissionsFor(role: Role): Permission[] {
  return defaultPermissions(role);
}

/** Owners manage everyone; admins manage everyone below admin; nobody can grant Owner. */
export function canAssignRole(actor: Role, target: Role): boolean {
  if (target === "owner") return false;
  if (actor === "owner") return true;
  if (actor === "admin") return target !== "admin";
  return false;
}

export const SALES_DOC_TYPES = ["quote", "sales_order", "invoice", "credit_note", "proforma", "delivery_challan"];
/** Proforma invoices and delivery challans are stored as variants of quotations and sales orders. */
export const DOC_VARIANTS: Record<string, { doc_type: "quote" | "sales_order"; variant: "proforma" | "delivery_challan" }> = {
  proforma: { doc_type: "quote", variant: "proforma" },
  delivery_challan: { doc_type: "sales_order", variant: "delivery_challan" },
};
/** Which permission family governs a document type. */
export const docFamily = (docType: string): "sales" | "purchase" => (SALES_DOC_TYPES.includes(docType) ? "sales" : "purchase");
