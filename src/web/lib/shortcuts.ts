import type { Permission } from "@shared/permissions";

/**
 * Keyboard shortcuts. Voucher keys follow the layout most Indian accountants already know (F8 sales, F9 purchase, F6 receipt, F5 payment, F7 journal,
 * Ctrl+F8 credit note, Ctrl+F9 debit note, Alt+F8 delivery note, Alt+G go to, Ctrl+A accept) so experienced accountants feel at
 * home; Ctrl+S saves as people expect from other programs.
 */
export interface Shortcut {
  keys: string;          // display form, e.g. "Ctrl+F8"
  label: string;
  group: "Vouchers (familiar keys)" | "Create" | "Go to" | "On a form or document";
  to?: string;           // company page to open
  action?: "save" | "post" | "print" | "goto" | "help";
  perm?: Permission;
}

export const SHORTCUTS: Shortcut[] = [
  { keys: "F8", label: "Sales invoice", group: "Vouchers (familiar keys)", to: "sales/invoice/new", perm: "sales.create" },
  { keys: "Ctrl+F8", label: "Credit note (sales return)", group: "Vouchers (familiar keys)", to: "sales/credit_note/new", perm: "sales.create" },
  { keys: "Alt+F8", label: "Delivery challan", group: "Vouchers (familiar keys)", to: "sales/delivery_challan/new", perm: "sales.create" },
  { keys: "F9", label: "Purchase (supplier bill)", group: "Vouchers (familiar keys)", to: "purchases/bill/new", perm: "purchase.create" },
  { keys: "Ctrl+F9", label: "Debit note (purchase return)", group: "Vouchers (familiar keys)", to: "purchases/debit_note/new", perm: "purchase.create" },
  { keys: "F6", label: "Receipt (money received)", group: "Vouchers (familiar keys)", to: "payments/in/new", perm: "sales.post" },
  { keys: "F5", label: "Payment (money paid)", group: "Vouchers (familiar keys)", to: "payments/out/new", perm: "purchase.post" },
  { keys: "F7", label: "Journal", group: "Vouchers (familiar keys)", to: "journals/new", perm: "journal.create" },
  { keys: "Alt+B", label: "POS counter billing", group: "Create", to: "pos", perm: "sales.create" },
  { keys: "Alt+Q", label: "Quotation", group: "Create", to: "sales/quote/new", perm: "sales.create" },
  { keys: "Alt+C", label: "New customer", group: "Create", to: "customers?new=1", perm: "customers.write" },
  { keys: "Alt+S", label: "New supplier", group: "Create", to: "suppliers?new=1", perm: "suppliers.write" },
  { keys: "Alt+I", label: "New product / item", group: "Create", to: "inventory?new=1", perm: "items.write" },
  { keys: "Alt+G", label: "Go to any screen (also Ctrl+K)", group: "Go to", action: "goto" },
  { keys: "Alt+H", label: "Dashboard", group: "Go to", to: "dashboard" },
  { keys: "Alt+Y", label: "Daybook", group: "Go to", to: "daybook", perm: "daybook.read" },
  { keys: "Alt+R", label: "Reports", group: "Go to", to: "reports", perm: "reports.read" },
  { keys: "F1", label: "This list of shortcuts (also Ctrl+/)", group: "Go to", action: "help" },
  { keys: "Ctrl+S", label: "Save (as draft where there is one)", group: "On a form or document", action: "save" },
  { keys: "Ctrl+A", label: "Accept: save & post (also Ctrl+Enter)", group: "On a form or document", action: "post" },
  { keys: "Ctrl+P", label: "Print preview of the open bill or receipt", group: "On a form or document", action: "print" },
  { keys: "Esc", label: "Close the pop-up", group: "On a form or document" },
];

/** Extra key combinations that do the same as a listed shortcut. */
const ALIASES: Record<string, string> = { "Ctrl+K": "Alt+G", "Ctrl+/": "F1", "Ctrl+Enter": "Ctrl+A" };

/** "Ctrl+F8" style name of a key event (Cmd counts as Ctrl on a Mac). */
export function keyName(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey && e.key.length > 1 && /^F\d+$/.test(e.key)) parts.push("Shift");
  const k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  parts.push(k === " " ? "Space" : k);
  return parts.join("+");
}

export function findShortcut(name: string): Shortcut | undefined {
  const n = ALIASES[name] ?? name;
  return SHORTCUTS.find((s) => s.keys === n && s.keys !== "Esc");
}

/** Shortcut hint for a sidebar link, e.g. "F8" next to Invoices. */
export const HINTS: Record<string, string> = {
  "sales/invoice": "F8", "sales/credit_note": "Ctrl+F8", "sales/delivery_challan": "Alt+F8", "purchases/bill": "F9",
  "purchases/debit_note": "Ctrl+F9", "payments/in": "F6", "payments/out": "F5", "journals": "F7", "pos": "Alt+B",
  "daybook": "Alt+Y", "dashboard": "Alt+H", "reports": "Alt+R",
};
