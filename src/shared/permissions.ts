export type Role = "owner" | "admin" | "accountant" | "auditor" | "viewer";

export const ROLES: Role[] = ["owner", "admin", "accountant", "auditor", "viewer"];

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  admin: "Administrator",
  accountant: "Accountant",
  auditor: "Auditor",
  viewer: "Read-only",
};

export type Permission =
  | "org.manage"          // members, invitations, organisation settings
  | "company.manage"      // create companies, company settings, tax codes, numbering
  | "masters.write"       // accounts, contacts, items, warehouses, dimensions
  | "txn.write"           // create/edit drafts
  | "txn.post"            // post journals and documents, record payments
  | "txn.reverse"         // reverse journals, void documents/payments
  | "expense.approve"
  | "period.manage"       // fiscal years, lock/unlock periods
  | "bank.reconcile"
  | "reports.read"
  | "audit.read"
  | "data.export";        // full company data export / backup

const MATRIX: Record<Role, Permission[]> = {
  owner: [
    "org.manage", "company.manage", "masters.write", "txn.write", "txn.post", "txn.reverse",
    "expense.approve", "period.manage", "bank.reconcile", "reports.read", "audit.read", "data.export",
  ],
  admin: [
    "org.manage", "company.manage", "masters.write", "txn.write", "txn.post", "txn.reverse",
    "expense.approve", "period.manage", "bank.reconcile", "reports.read", "audit.read", "data.export",
  ],
  accountant: [
    "masters.write", "txn.write", "txn.post", "txn.reverse", "expense.approve", "bank.reconcile", "reports.read",
  ],
  auditor: ["reports.read", "audit.read"],
  viewer: ["reports.read"],
};

export function can(role: Role | null | undefined, perm: Permission): boolean {
  if (!role) return false;
  return MATRIX[role]?.includes(perm) ?? false;
}

export function permissionsFor(role: Role): Permission[] {
  return [...MATRIX[role]];
}

/** Only owners can grant/revoke admin; admins manage everyone below admin. */
export function canAssignRole(actor: Role, target: Role): boolean {
  if (target === "owner") return false;
  if (actor === "owner") return true;
  if (actor === "admin") return target !== "admin";
  return false;
}
