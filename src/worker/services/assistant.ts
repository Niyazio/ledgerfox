/**
 * Built-in assistant: answers everyday questions about this company's books in plain language.
 *
 * It does not use an AI model (nothing leaves the server, it costs nothing and works on the desktop and offline):
 * the question is matched to one of a set of known questions, the period is read from it ("last month", "in March",
 * "last 7 days"…), and the answer is computed from the ledger with the same permissions and branch limits as the
 * screens. Anything it does not recognise gets suggestions and links instead of a guess.
 */
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { all, first } from "../lib/db";
import { branchFilter, hasPerm } from "../lib/auth";
import { formatMoney } from "@shared/currencies";
import { profitAndLoss } from "./reports";
import type { Permission } from "@shared/permissions";

export interface Period { from: string; to: string; label: string }
export interface Reply {
  text: string;
  table?: { columns: string[]; rows: (string | number)[][] };
  links?: { label: string; to: string }[];
  suggestions?: string[];
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_RE = new RegExp(`\\b(${MONTHS.map((m) => `${m}|${m.slice(0, 3)}`).join("|")})\\b(?:\\s+(\\d{4}))?`);

/** The period a question talks about; defaults to this month. `fyStart` is the first month of the financial year (1–12). */
export function parsePeriod(q: string, today: string, fyStart = 4): Period {
  const t = q.toLowerCase();
  const [y, m, d] = today.split("-").map(Number);
  const now = utc(y, m - 1, d);
  const range = (a: Date, b: Date, label: string): Period => ({ from: iso(a), to: iso(b), label });
  const explicit = t.match(/(\d{4}-\d{2}-\d{2})\s*(?:to|-|until|till|and)\s*(\d{4}-\d{2}-\d{2})/);
  if (explicit) return { from: explicit[1], to: explicit[2], label: `${explicit[1]} to ${explicit[2]}` };
  if (/\btoday\b|\baaj\b/.test(t)) return range(now, now, "today");
  if (/\byesterday\b|\bkal\b/.test(t)) { const p = utc(y, m - 1, d - 1); return range(p, p, "yesterday"); }
  const lastN = t.match(/\b(?:last|past)\s+(\d{1,3})\s+days?\b/);
  if (lastN) return range(utc(y, m - 1, d - Number(lastN[1]) + 1), now, `the last ${lastN[1]} days`);
  if (/\bthis week\b/.test(t)) { const dow = (now.getUTCDay() + 6) % 7; return range(utc(y, m - 1, d - dow), now, "this week"); }
  if (/\blast week\b/.test(t)) { const dow = (now.getUTCDay() + 6) % 7; return range(utc(y, m - 1, d - dow - 7), utc(y, m - 1, d - dow - 1), "last week"); }
  if (/\blast month\b|\bprevious month\b/.test(t)) return range(utc(y, m - 2, 1), utc(y, m - 1, 0), "last month");
  const fyY = m >= fyStart ? y : y - 1;
  if (/\blast (?:financial |fiscal )?year\b|\bprevious year\b|\blast fy\b/.test(t)) return range(utc(fyY - 1, fyStart - 1, 1), utc(fyY, fyStart - 1, 0), `the financial year ${fyY - 1}-${String(fyY).slice(2)}`);
  if (/\bthis (?:financial |fiscal )?year\b|\bthis fy\b|\byear to date\b|\bytd\b/.test(t)) return range(utc(fyY, fyStart - 1, 1), now, `this financial year (${fyY}-${String(fyY + 1).slice(2)})`);
  const mm = t.match(MONTH_RE);
  if (mm) {
    const mi = MONTHS.findIndex((x) => x.startsWith(mm[1].slice(0, 3)));
    const yy = mm[2] ? Number(mm[2]) : mi <= m - 1 ? y : y - 1;
    return range(utc(yy, mi, 1), utc(yy, mi + 1, 0), `${MONTHS[mi][0].toUpperCase()}${MONTHS[mi].slice(1)} ${yy}`);
  }
  return range(utc(y, m - 1, 1), now, "this month");
}

export type Intent =
  | "help" | "sales" | "purchases" | "expenses" | "profit" | "receivables" | "payables" | "overdue" | "contact"
  | "top_customers" | "customer_list" | "supplier_list" | "cash" | "gst" | "low_stock" | "expiring" | "item_stock" | "howto" | "unknown";

/** Which question this is. Order matters: the most specific patterns come first. */
export function detectIntent(q: string): Intent {
  const t = ` ${q.toLowerCase().replace(/[?!.,]/g, " ")} `;
  if (/^\s*(hi|hello|hey|namaste|vanakkam|help|what can you do)\s*$/.test(t)) return "help";
  if (/\bhow (do|can|to)\b|\bwhere (do|can|is)\b|\bsteps\b|\bkaise\b/.test(t)) return "howto";
  if (/\bgst\b|\btax payable\b|\bitc\b/.test(t)) return "gst";
  if (/\boverdue\b|\bpast due\b|\blate payment/.test(t)) return "overdue";
  if (/\bwho owes\b|\breceivable|\bcustomers? (?:dues|outstanding|balance)|\bto (?:collect|receive)\b|\bpending from\b|\bdues from\b/.test(t)) return "receivables";
  if (/\bwhat do i owe\b|\bpayable|\bsupplier(?:s)? (?:dues|outstanding|balance)|\bto pay\b|\bi owe\b/.test(t)) return "payables";
  if (/\btop customers?\b|\bbest customers?\b|\bbiggest customers?\b/.test(t)) return "top_customers";
  if (/\b(list|all|show)\b.*\bcustomers\b|\bcustomer list\b/.test(t)) return "customer_list";
  if (/\b(list|all|show)\b.*\bsuppliers\b|\bsupplier list\b/.test(t)) return "supplier_list";
  if (/\bexpir/.test(t)) return "expiring";
  if (/\blow stock\b|\breorder\b|\bout of stock\b|\brunning out\b/.test(t)) return "low_stock";
  if (/\b(stock|quantity|qty|how many)\b.*\bof\b/.test(t)) return "item_stock";
  if (/\bcash\b|\bbank balance\b|\bbalance in (?:bank|cash)\b|\bmoney in\b/.test(t)) return "cash";
  if (/\bprofit\b|\bloss\b|\bmargin\b|\bearn(?:ed|ings)?\b/.test(t)) return "profit";
  if (/\bexpense|\bspent\b|\bspend\b|\bkharcha\b/.test(t)) return "expenses";
  if (/\bpurchase|\bbought\b|\bbills?\b/.test(t)) return "purchases";
  if (/\bsales?\b|\bsold\b|\bsell(?:ing)?\b|\brevenue\b|\bturnover\b|\binvoic|\bbikri\b/.test(t)) return "sales";
  if (/\b(details?|contact|phone|number|email|address|gstin|balance|about)\b/.test(t)) return "contact";
  return "unknown";
}

/** The name the user asked about: "details of Ravi Traders" → "ravi traders". */
export function nameIn(q: string): string {
  const t = q.toLowerCase().replace(/[?!.]/g, " ");
  const m = t.match(/\b(?:of|for|about|from|to|customer|supplier|party|contact)\s+(.+)$/);
  const raw = (m ? m[1] : t).replace(/\b(details?|balance|phone|number|email|address|gstin|outstanding|dues|please|show|me|the|what|is|whats|stock|qty|quantity)\b/g, " ");
  return raw.replace(/\s+/g, " ").trim();
}

const HOWTO: { re: RegExp; text: string; to: string; label: string }[] = [
  { re: /invoice|bill (a|the) customer|sale/, text: "Sales → Invoices → New invoice: choose the customer, add items (or scan), then Save & post. Print or share it from the invoice page. For quick counter sales use POS.", to: "sales/invoice/new", label: "New invoice" },
  { re: /customer|client|party/, text: "Customers → New customer: name, phone, GSTIN (state fills in automatically), credit limit and price list.", to: "customers", label: "Customers" },
  { re: /supplier|vendor/, text: "Suppliers → New supplier, then record their bills under Supplier bills.", to: "suppliers", label: "Suppliers" },
  { re: /receipt|payment|collect|received/, text: "Receipts → Record receipt: choose the customer, the amount and which invoices it settles. Enter TDS if the customer deducted it.", to: "payments/in/new", label: "Record receipt" },
  { re: /gst|gstr|return/, text: "Reports → GST returns: pick the month to see GSTR-1 and GSTR-3B and download the JSON for the GST offline tool.", to: "reports/gst-returns", label: "GST returns" },
  { re: /import|excel|upload/, text: "Administration → Import from Excel: download the template, fill it, upload, check the preview, then import.", to: "import", label: "Import from Excel" },
  { re: /user|staff|login|password|permission/, text: "Administration → Users & permissions: add a user with a role; LedgerFox shows a one-time password they change at first sign-in.", to: "settings?tab=members", label: "Users" },
  { re: /stock|inventory|product|item/, text: "Products & stock → New item; tick “Track stock”. Stock comes in through supplier bills or Adjust stock.", to: "inventory", label: "Products & stock" },
  { re: /backup|restore/, text: "Settings → Backup: download a backup file; the desktop app can also back up to LedgerFox Cloud, encrypted.", to: "settings", label: "Settings" },
  { re: /update|version/, text: "Use the arrow button in the top bar: it shows your version and installs or reloads to the latest one.", to: "dashboard", label: "Dashboard" },
  { re: /report|profit|balance sheet|daybook|trial/, text: "Reports has the profit & loss, balance sheet, daybook, daily report, ledgers and more, each with Excel and CSV download.", to: "reports", label: "Reports" },
];

const SUGGESTIONS = ["Sales this month", "Who owes me money?", "Overdue invoices", "Top customers this year", "Cash and bank balance", "Profit last month", "Low stock", "How do I record a receipt?"];

export async function answer(c: Context<AppEnv>, question: string): Promise<Reply> {
  const company = c.get("company");
  const db = c.env.DB;
  const cur = company.base_currency;
  const money = (n: number) => formatMoney(n, cur);
  const can = (p: Permission) => hasPerm(c, p);
  const allBranches = c.get("branches").all;
  const today = new Date().toISOString().slice(0, 10);
  const period = parsePeriod(question, today, company.fiscal_year_start_month ?? 4);
  const intent = detectIntent(question);
  const docBranch = branchFilter(c, "d.branch_id");
  const no = (what: string): Reply => ({ text: `Your role does not include ${what}. Ask the owner if you need it.`, suggestions: SUGGESTIONS.slice(0, 4) });
  const branchNote = allBranches ? "" : " (your branches)";

  switch (intent) {
    case "help":
      return { text: "Hello! Ask me about your sales, purchases, expenses, profit, who owes you, overdue invoices, a customer's details, stock, GST or how to do something in LedgerFox. Periods like “today”, “last month”, “in March” or “last 7 days” work too.", suggestions: SUGGESTIONS };

    case "howto": {
      const hit = HOWTO.find((h) => h.re.test(question.toLowerCase()));
      if (!hit) return { text: "I can explain invoices, customers, suppliers, receipts, GST returns, Excel import, users, stock, backups, updates and reports. What would you like to do?", suggestions: ["How do I create an invoice?", "How do I file GST?", "How do I import from Excel?"] };
      return { text: hit.text, links: [{ label: hit.label, to: hit.to }] };
    }

    case "sales": case "purchases": {
      const sales = intent === "sales";
      if (!can(sales ? "sales.view" : "purchase.view")) return no(sales ? "sales" : "purchases");
      const types = sales ? ["invoice", "credit_note"] : ["bill", "debit_note"];
      const r = await first<{ n: number; total: number; returns: number }>(db,
        `SELECT SUM(CASE WHEN d.doc_type = ? THEN 1 ELSE 0 END) AS n,
                COALESCE(SUM(CASE WHEN d.doc_type = ? THEN d.total_base END),0) AS total,
                COALESCE(SUM(CASE WHEN d.doc_type = ? THEN d.total_base END),0) AS returns
         FROM documents d WHERE d.company_id = ? AND d.status = 'posted' AND d.doc_type IN (?,?) AND d.issue_date BETWEEN ? AND ?${docBranch.sql}`,
        types[0], types[0], types[1], company.id, types[0], types[1], period.from, period.to, ...docBranch.params);
      const net = (r?.total ?? 0) - (r?.returns ?? 0);
      const top = await all<{ name: string; total: number }>(db,
        `SELECT ct.name, SUM(CASE WHEN d.doc_type = ? THEN d.total_base ELSE -d.total_base END) AS total FROM documents d JOIN contacts ct ON ct.id = d.contact_id
         WHERE d.company_id = ? AND d.status = 'posted' AND d.doc_type IN (?,?) AND d.issue_date BETWEEN ? AND ?${docBranch.sql}
         GROUP BY ct.id ORDER BY total DESC LIMIT 5`, types[0], company.id, types[0], types[1], period.from, period.to, ...docBranch.params);
      const what = sales ? "Sales" : "Purchases";
      return {
        text: `${what} for ${period.label}${branchNote}: ${money(net)} from ${r?.n ?? 0} ${sales ? "invoice" : "bill"}${r?.n === 1 ? "" : "s"}${r?.returns ? ` (after ${money(r.returns)} of ${sales ? "sales" : "purchase"} returns)` : ""}, including tax.`,
        table: top.length ? { columns: [sales ? "Customer" : "Supplier", "Amount"], rows: top.map((x) => [x.name, money(x.total)]) } : undefined,
        links: [{ label: sales ? "Invoices" : "Supplier bills", to: sales ? `sales/invoice?from=${period.from}&to=${period.to}` : `purchases/bill?from=${period.from}&to=${period.to}` }],
      };
    }

    case "expenses": {
      if (!can("reports.read")) return no("reports");
      if (!allBranches) return { text: "Expenses are shown for the whole company; your access is limited to some branches. The daily report shows your branch.", links: [{ label: "Daily report", to: "reports/daily" }] };
      const pl = await profitAndLoss(db, company, period.from, period.to);
      const lines = pl.sections.filter((s) => s.key !== "revenue" && s.key !== "other_income").flatMap((s) => s.lines).sort((a, b) => b.amount - a.amount).slice(0, 8);
      return { text: `Expenses for ${period.label}${branchNote}: ${money(pl.total_expense)} (including cost of goods sold).`, table: lines.length ? { columns: ["Expense", "Amount"], rows: lines.map((l) => [l.name, money(l.amount)]) } : undefined, links: [{ label: "Profit & loss", to: `reports/profit-loss?from=${period.from}&to=${period.to}` }] };
    }

    case "profit": {
      if (!can("reports.read")) return no("reports");
      if (!allBranches) return { text: "Profit is shown for the whole company; your access is limited to some branches. Ask the owner or check the daily report for your branch.", links: [{ label: "Daily report", to: "reports/daily" }] };
      const pl = await profitAndLoss(db, company, period.from, period.to);
      return {
        text: `${pl.net_profit >= 0 ? "Profit" : "Loss"} for ${period.label}: ${money(Math.abs(pl.net_profit))}. Income ${money(pl.total_income)}, expenses ${money(pl.total_expense)}, gross profit ${money(pl.gross_profit)}.`,
        links: [{ label: "Profit & loss", to: `reports/profit-loss?from=${period.from}&to=${period.to}` }],
      };
    }

    case "receivables": case "payables": case "overdue": {
      const sales = intent !== "payables";
      if (!can(sales ? "sales.view" : "purchase.view")) return no(sales ? "sales" : "purchases");
      const overdue = intent === "overdue";
      const rows = await all<{ name: string; phone: string | null; due: number; docs: number; oldest: string | null }>(db,
        `SELECT ct.name, ct.phone, SUM(d.total - d.amount_settled) AS due, COUNT(*) AS docs, MIN(d.due_date) AS oldest
         FROM documents d JOIN contacts ct ON ct.id = d.contact_id
         WHERE d.company_id = ? AND d.status = 'posted' AND d.doc_type = ? AND d.total > d.amount_settled AND d.currency = ?
           ${overdue ? "AND d.due_date < ?" : ""}${docBranch.sql}
         GROUP BY ct.id ORDER BY due DESC LIMIT 10`,
        ...[company.id, sales ? "invoice" : "bill", cur, ...(overdue ? [today] : []), ...docBranch.params]);
      const total = rows.reduce((t, r) => t + r.due, 0);
      const who = sales ? "customers owe you" : "you owe suppliers";
      if (!rows.length) return { text: overdue ? "No overdue invoices. 🎉" : `Nothing outstanding: no ${sales ? "unpaid invoices" : "unpaid bills"}${branchNote}.` };
      return {
        text: overdue ? `${rows.length} customer${rows.length === 1 ? " has" : "s have"} overdue invoices${branchNote}, ${money(total)} in all (top 10 shown).` : `In ${cur}, ${who} ${money(total)}${branchNote} (largest 10 shown).`,
        table: { columns: [sales ? "Customer" : "Supplier", "Outstanding", sales ? "Invoices" : "Bills", overdue ? "Oldest due" : "Phone"], rows: rows.map((r) => [r.name, money(r.due), r.docs, overdue ? r.oldest ?? "" : r.phone ?? ""]) },
        links: [{ label: sales ? "Receivables ageing" : "Payables ageing", to: sales ? "reports/aging-receivable" : "reports/aging-payable" }],
        suggestions: overdue ? ["Who owes me money?"] : [`Details of ${rows[0].name}`],
      };
    }

    case "top_customers": case "customer_list": case "supplier_list": {
      const customers = intent !== "supplier_list";
      if (!can(customers ? "sales.view" : "purchase.view")) return no(customers ? "customers" : "suppliers");
      if (intent === "top_customers") {
        const p = /\bthis (?:month|week)|\blast|\btoday|\byesterday|\bin [a-z]+/.test(question.toLowerCase()) ? period : parsePeriod("this financial year", today, company.fiscal_year_start_month ?? 4);
        const rows = await all<{ name: string; total: number; n: number }>(db,
          `SELECT ct.name, SUM(CASE WHEN d.doc_type = 'invoice' THEN d.total_base ELSE -d.total_base END) AS total, SUM(d.doc_type = 'invoice') AS n
           FROM documents d JOIN contacts ct ON ct.id = d.contact_id
           WHERE d.company_id = ? AND d.status = 'posted' AND d.doc_type IN ('invoice','credit_note') AND d.issue_date BETWEEN ? AND ?${docBranch.sql}
           GROUP BY ct.id ORDER BY total DESC LIMIT 10`, company.id, p.from, p.to, ...docBranch.params);
        if (!rows.length) return { text: `No sales for ${p.label} yet.` };
        return { text: `Top customers for ${p.label}${branchNote}:`, table: { columns: ["Customer", "Sales", "Invoices"], rows: rows.map((r) => [r.name, money(r.total), r.n]) } };
      }
      const rows = await all<{ name: string; phone: string | null; email: string | null; tax_id: string | null }>(db,
        `SELECT name, phone, email, tax_id FROM contacts WHERE company_id = ? AND is_active = 1 AND kind IN (?, 'both') ORDER BY name LIMIT 50`, company.id, customers ? "customer" : "supplier");
      const count = await first<{ n: number }>(db, `SELECT COUNT(*) AS n FROM contacts WHERE company_id = ? AND is_active = 1 AND kind IN (?, 'both')`, company.id, customers ? "customer" : "supplier");
      return {
        text: `You have ${count?.n ?? 0} active ${customers ? "customers" : "suppliers"}${(count?.n ?? 0) > 50 ? " (first 50 shown; download the full list as Excel from the list page)" : ""}.`,
        table: { columns: ["Name", "Phone", "Email", "GSTIN"], rows: rows.map((r) => [r.name, r.phone ?? "", r.email ?? "", r.tax_id ?? ""]) },
        links: [{ label: customers ? "Customers (Excel download)" : "Suppliers (Excel download)", to: customers ? "customers" : "suppliers" }],
      };
    }

    case "contact": {
      const name = nameIn(question);
      if (name.length < 2) return { text: "Which customer or supplier? For example: “details of Ravi Traders”.", suggestions: ["List customers"] };
      const matches = await all<{ id: string; name: string; kind: string; phone: string | null; email: string | null; tax_id: string | null; billing_address: string | null; credit_limit: number | null; payment_terms_days: number }>(db,
        `SELECT id, name, kind, phone, email, tax_id, billing_address, credit_limit, payment_terms_days FROM contacts
         WHERE company_id = ? AND (lower(name) LIKE ? OR lower(name) LIKE ?) ORDER BY (lower(name) = ?) DESC, length(name) LIMIT 5`,
        company.id, `${name}%`, `%${name}%`, name);
      const visible = matches.filter((m) => (m.kind === "supplier" ? can("purchase.view") : can("sales.view")) || (m.kind === "both" && (can("purchase.view") || can("sales.view"))));
      if (!visible.length) return { text: `I couldn't find a customer or supplier called “${name}”.`, suggestions: ["List customers", "List suppliers"] };
      if (visible.length > 1 && visible[0].name.toLowerCase() !== name) {
        return { text: `Several match “${name}”. Which one?`, suggestions: visible.map((m) => `Details of ${m.name}`) };
      }
      const ct = visible[0];
      const sales = ct.kind !== "supplier";
      const bal = await first<{ due: number; docs: number; overdue: number; last: string | null }>(db,
        `SELECT COALESCE(SUM(d.total - d.amount_settled),0) AS due, COUNT(*) AS docs, COALESCE(SUM(CASE WHEN d.due_date < ? THEN d.total - d.amount_settled END),0) AS overdue,
                (SELECT MAX(issue_date) FROM documents x WHERE x.contact_id = ? AND x.status = 'posted') AS last
         FROM documents d WHERE d.company_id = ? AND d.contact_id = ? AND d.status = 'posted' AND d.doc_type IN ('invoice','bill') AND d.total > d.amount_settled${docBranch.sql}`,
        today, ct.id, company.id, ct.id, ...docBranch.params);
      const rows: (string | number)[][] = [
        ["Type", ct.kind], ["Phone", ct.phone || "—"], ["Email", ct.email || "—"], ["GSTIN", ct.tax_id || "—"], ["Address", ct.billing_address || "—"],
        [sales ? "They owe you" : "You owe them", money(bal?.due ?? 0)], ["Of which overdue", money(bal?.overdue ?? 0)], ["Unpaid documents", bal?.docs ?? 0],
        ["Last document", bal?.last ?? "—"], ["Payment terms", `${ct.payment_terms_days} days`], ...(ct.credit_limit ? [["Credit limit", money(ct.credit_limit)]] : []),
      ];
      return { text: `${ct.name}:`, table: { columns: ["", ""], rows }, links: [{ label: "Open contact", to: `contacts/${ct.id}` }, { label: "Statement", to: `reports/statement/${ct.id}` }] };
    }

    case "cash": {
      if (!can("reports.read") || !allBranches) return no("company-wide cash and bank balances");
      const rows = await all<{ name: string; bal: number }>(db,
        `SELECT a.name, COALESCE(SUM(l.debit - l.credit),0) AS bal FROM accounts a
         LEFT JOIN journal_lines l ON l.account_id = a.id AND l.entry_id IN (SELECT id FROM journal_entries WHERE company_id = ? AND status = 'posted')
         WHERE a.company_id = ? AND a.subtype IN ('cash','bank') AND a.is_group = 0 AND a.is_active = 1 GROUP BY a.id ORDER BY a.code`, company.id, company.id);
      const total = rows.reduce((t, r) => t + r.bal, 0);
      return { text: `Cash and bank today: ${money(total)}.`, table: { columns: ["Account", "Balance"], rows: rows.map((r) => [r.name, money(r.bal)]) }, links: [{ label: "Cash / bank book", to: "reports/cash-book" }] };
    }

    case "gst": {
      if (!can("reports.read") || !allBranches) return no("GST reports");
      const r = await first<{ out: number; inp: number }>(db,
        `SELECT COALESCE(SUM(CASE WHEN a.system_key IN ('OUT_CGST','OUT_SGST','OUT_IGST') THEN l.credit - l.debit END),0) AS out,
                COALESCE(SUM(CASE WHEN a.system_key IN ('IN_CGST','IN_SGST','IN_IGST') THEN l.debit - l.credit END),0) AS inp
         FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
         WHERE l.company_id = ? AND e.status = 'posted' AND e.entry_date BETWEEN ? AND ?`, company.id, period.from, period.to);
      const net = (r?.out ?? 0) - (r?.inp ?? 0);
      return {
        text: `GST for ${period.label}: output tax ${money(r?.out ?? 0)}, input credit ${money(r?.inp ?? 0)}, so about ${money(Math.max(net, 0))} to pay${net < 0 ? ` (credit of ${money(-net)} carried forward)` : ""}. This is from your books before set-off; check GSTR-3B and GSTR-2B before filing.`,
        links: [{ label: "GST returns", to: "reports/gst-returns" }],
      };
    }

    case "low_stock": case "expiring": case "item_stock": {
      if (!can("inventory.view")) return no("stock");
      if (intent === "expiring") {
        const soon = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
        const rows = await all<{ name: string; batch_no: string; expiry: string; qty: number }>(db,
          `SELECT i.name, s.batch_no, MAX(s.expiry_date) AS expiry, SUM(s.qty_milli) AS qty FROM stock_moves s JOIN items i ON i.id = s.item_id
           WHERE s.company_id = ? AND s.batch_no IS NOT NULL GROUP BY s.item_id, s.batch_no HAVING SUM(s.qty_milli) > 0 AND MAX(s.expiry_date) <= ? ORDER BY expiry LIMIT 20`, company.id, soon);
        if (!rows.length) return { text: "No batches expire in the next 30 days." };
        return { text: `${rows.length} batch${rows.length === 1 ? "" : "es"} expired or expiring within 30 days:`, table: { columns: ["Item", "Batch", "Expiry", "Qty"], rows: rows.map((r) => [r.name, r.batch_no, r.expiry, r.qty / 1000]) }, links: [{ label: "Batches & expiry", to: "inventory?tab=batches" }] };
      }
      if (intent === "item_stock") {
        const name = nameIn(question);
        const rows = await all<{ name: string; unit: string; qty: number }>(db,
          `SELECT i.name, i.unit, COALESCE((SELECT SUM(qty_milli) FROM stock_moves s WHERE s.item_id = i.id),0) AS qty FROM items i
           WHERE i.company_id = ? AND i.track_inventory = 1 AND lower(i.name) LIKE ? ORDER BY length(i.name) LIMIT 5`, company.id, `%${name}%`);
        if (!rows.length) return { text: `I couldn't find a stock item called “${name}”.` };
        return { text: rows.length === 1 ? `${rows[0].name}: ${rows[0].qty / 1000} ${rows[0].unit} in stock.` : "Matching items:", table: rows.length > 1 ? { columns: ["Item", "In stock"], rows: rows.map((r) => [r.name, `${r.qty / 1000} ${r.unit}`]) } : undefined };
      }
      const rows = await all<{ name: string; unit: string; qty: number; reorder: number }>(db,
        `SELECT i.name, i.unit, COALESCE((SELECT SUM(qty_milli) FROM stock_moves s WHERE s.item_id = i.id),0) AS qty, i.reorder_level_milli AS reorder
         FROM items i WHERE i.company_id = ? AND i.track_inventory = 1 AND i.is_active = 1
           AND COALESCE((SELECT SUM(qty_milli) FROM stock_moves s WHERE s.item_id = i.id),0) <= MAX(i.reorder_level_milli, 0) ORDER BY qty LIMIT 20`, company.id);
      if (!rows.length) return { text: "Nothing is at or below its reorder level." };
      return { text: `${rows.length} item${rows.length === 1 ? " is" : "s are"} out of stock or at the reorder level:`, table: { columns: ["Item", "In stock", "Reorder at"], rows: rows.map((r) => [r.name, `${r.qty / 1000} ${r.unit}`, `${r.reorder / 1000}`]) }, links: [{ label: "Products & stock", to: "inventory" }] };
    }

    default:
      return { text: "Sorry, I didn't understand that. Try one of these, or ask “how do I …”.", suggestions: SUGGESTIONS };
  }
}
