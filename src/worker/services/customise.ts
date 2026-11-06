/**
 * Customising LedgerFox for a business:
 * - custom fields on sales and purchase documents, customers & suppliers and products;
 * - reports emailed on a schedule (daily summary, profit & loss, receivables, payables, stock);
 * - automation rules: when an invoice is issued, a payment arrives, a quotation is accepted… send an email or call a
 *   webhook (signed with HMAC-SHA256 so the receiver can trust it).
 */
import type { Context } from "hono";
import type { AppEnv, CompanyRow, Env } from "../env";
import { all, first, run, todayIso } from "../lib/db";
import { badRequest } from "../lib/errors";
import { newId } from "../lib/crypto";
import { deliverable, sendMail, siteUrl } from "./email";
import { decryptSecret } from "./collect";
import { formatMoney } from "@shared/currencies";
import * as R from "./reports";

// ── Custom fields ──

export type CustomEntity = "sales" | "purchase" | "contact" | "item";
export interface CustomField { id: string; entity: CustomEntity; label: string; field_type: "text" | "number" | "date" | "select" | "checkbox"; options: string | null; show_on_print: number; sort: number; is_active: number }

export async function customFields(env: Env, companyId: string, entity?: CustomEntity) {
  return all<CustomField>(env.DB, `SELECT id, entity, label, field_type, options, show_on_print, sort, is_active FROM custom_fields WHERE company_id = ?${entity ? " AND entity = ?" : ""} ORDER BY entity, sort, created_at`,
    companyId, ...(entity ? [entity] : []));
}

/** Checks one value against its field; returns the text to store, or null to clear it. */
export function cleanValue(f: CustomField, raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const v = String(raw).trim();
  if (!v) return null;
  switch (f.field_type) {
    case "number": if (!/^-?\d+(\.\d+)?$/.test(v)) throw badRequest(`${f.label}: enter a number`); return v;
    case "date": if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw badRequest(`${f.label}: enter a date`); return v;
    case "checkbox": return raw === true || v === "1" || v === "true" ? "1" : null;
    case "select": {
      const opts = JSON.parse(f.options ?? "[]") as string[];
      if (!opts.includes(v)) throw badRequest(`${f.label}: choose one of the options`);
      return v;
    }
    default: if (v.length > 500) throw badRequest(`${f.label}: at most 500 characters`); return v;
  }
}

export async function customValues(env: Env, companyId: string, entityId: string) {
  return all<{ field_id: string; label: string; field_type: string; value: string; show_on_print: number }>(env.DB,
    `SELECT v.field_id, f.label, f.field_type, v.value, f.show_on_print FROM custom_values v JOIN custom_fields f ON f.id = v.field_id
      WHERE v.company_id = ? AND v.entity_id = ? AND f.is_active = 1 ORDER BY f.sort, f.created_at`, companyId, entityId);
}

// ── Scheduled reports ──

export interface ReportSchedule { id: string; company_id: string; report: string; frequency: "daily" | "weekly" | "monthly"; weekday: number; recipients: string; is_active: number; last_sent_on: string | null }

/** Whether a schedule is due on `today` (daily; weekly on its weekday; monthly on the 1st). */
export function scheduleDue(s: Pick<ReportSchedule, "frequency" | "weekday" | "last_sent_on">, today: string) {
  if (s.last_sent_on === today) return false;
  const d = new Date(`${today}T00:00:00Z`);
  if (s.frequency === "daily") return true;
  if (s.frequency === "weekly") return d.getUTCDay() === s.weekday;
  return d.getUTCDate() === 1;
}

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** The report as a short plain-text email: the key figures and a link to the full report. */
export async function reportEmail(env: Env, company: CompanyRow, s: Pick<ReportSchedule, "report" | "frequency">, today: string) {
  const m = (n: number) => formatMoney(n, company.base_currency, company.number_locale ?? "en-IN");
  const site = siteUrl(env);
  const to = addDays(today, -1);
  const from = s.frequency === "daily" ? to : s.frequency === "weekly" ? addDays(today, -7) : `${addDays(today, -1).slice(0, 7)}-01`;
  const name = company.legal_name || company.name;
  const period = from === to ? to : `${from} to ${to}`;
  switch (s.report) {
    case "daily-summary": {
      const d = await R.dailyReport(env.DB, company, from, to, null);
      const t = d.totals;
      return { subject: `${name}: summary for ${period}`, text: `Summary for ${period}\n\nSales invoiced: ${m(t.sales_invoiced)}\nMoney received: ${m(t.received)}\nPurchases billed: ${m(t.purchases_billed)}\nMoney paid: ${m(t.paid)}\nIncome: ${m(t.income)}\nExpenses: ${m(t.expenses)}\nProfit: ${m(t.profit)}\nCash & bank at the end: ${m(t.closing)}\n\nOpen the report: ${site}/app/${company.id}/reports/daily?from=${from}&to=${to}` };
    }
    case "profit-loss": {
      const p = await R.profitAndLoss(env.DB, company, from, to);
      return { subject: `${name}: profit & loss for ${period}`, text: `Profit & loss for ${period}\n\nIncome: ${m(p.total_income)}\nExpenses: ${m(p.total_expense)}\nGross profit: ${m(p.gross_profit)}\nNet ${p.net_profit >= 0 ? "profit" : "loss"}: ${m(p.net_profit)}\n\nOpen the report: ${site}/app/${company.id}/reports/profit-loss?from=${from}&to=${to}` };
    }
    case "receivables": case "payables": {
      const kind = s.report === "receivables" ? "receivable" : "payable";
      const a = await R.aging(env.DB, company, kind, today);
      const top = a.summary.slice().sort((x, y) => y.total - x.total).slice(0, 5).map((r) => `  ${r.contact_name}: ${m(r.total)}`).join("\n");
      return { subject: `${name}: ${kind === "receivable" ? "money to collect" : "bills to pay"} on ${today}`, text: `${kind === "receivable" ? "Customers owe you" : "You owe suppliers"} ${m(a.totals.total)} on ${today}\n\nNot yet due: ${m(a.totals.current)}\n1–30 days late: ${m(a.totals["1_30"])}\n31–60 days late: ${m(a.totals["31_60"])}\n61–90 days late: ${m(a.totals["61_90"])}\nOver 90 days: ${m(a.totals.over_90)}\n\nLargest:\n${top || "  —"}\n\nOpen the report: ${site}/app/${company.id}/reports/aging-${kind}` };
    }
    default: {
      const v = await R.inventoryValuation(env.DB, company, today);
      const low = v.items.filter((i) => i.below_reorder).slice(0, 15).map((i) => `  ${i.name}: ${i.qty_milli / 1000} left`).join("\n");
      return { subject: `${name}: stock on ${today}`, text: `Stock value on ${today}: ${m(v.stock_value)}\n\nTo reorder:\n${low || "  Nothing below its reorder level."}\n\nOpen the report: ${site}/app/${company.id}/reports/inventory-valuation` };
    }
  }
}

export async function sendScheduledReports(env: Env, today = todayIso()) {
  let sent = 0;
  for (const s of await all<ReportSchedule>(env.DB, `SELECT * FROM report_schedules WHERE is_active = 1`)) {
    if (!scheduleDue(s, today)) continue;
    const claimed = await run(env.DB, `UPDATE report_schedules SET last_sent_on = ? WHERE id = ? AND (last_sent_on IS NULL OR last_sent_on <> ?)`, today, s.id, today);
    if (!claimed.meta.changes) continue;
    const company = await first<CompanyRow>(env.DB, `SELECT * FROM companies WHERE id = ?`, s.company_id);
    if (!company) continue;
    try {
      const mail = await reportEmail(env, company, s, today);
      for (const to of s.recipients.split(",").map((x) => x.trim()).filter(deliverable)) if (await sendMail(env, { to, ...mail, replyTo: company.email ?? undefined })) sent++;
    } catch (e) { console.error(JSON.stringify({ level: "error", job: "scheduled-reports", schedule: s.id, message: (e as Error).message })); }
  }
  return sent;
}

// ── Automation rules ──

export const AUTOMATION_EVENTS = {
  "invoice.issued": "An invoice is issued",
  "bill.issued": "A supplier bill is entered",
  "payment.received": "A customer payment is received",
  "payment.made": "A supplier is paid",
  "quote.accepted": "A customer accepts a quotation",
  "quote.declined": "A customer declines a quotation",
  "invoice.paid_online": "An invoice is paid online",
} as const;
export type AutomationEvent = keyof typeof AUTOMATION_EVENTS;

export interface EventData { id: string; number?: string | null; amount?: number; amount_base?: number; currency?: string; contact_id?: string | null; contact_name?: string | null; date?: string | null }

async function hmacHex(secret: string, data: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Runs the company's rules for an event. Never throws: an automation must not break the entry that triggered it. */
export async function runAutomations(env: Env, company: Pick<CompanyRow, "id" | "name" | "legal_name" | "base_currency" | "number_locale">, event: AutomationEvent, data: EventData, onlyRuleId?: string) {
  try {
    // A test run targets one rule, whether or not it is switched on.
    const rules = await all<{ id: string; name: string; min_amount: number | null; action: string; target: string; secret_enc: string | null }>(env.DB,
      onlyRuleId
        ? `SELECT id, name, NULL AS min_amount, action, target, secret_enc FROM automation_rules WHERE company_id = ? AND event = ? AND id = ?`
        : `SELECT id, name, min_amount, action, target, secret_enc FROM automation_rules WHERE company_id = ? AND event = ? AND is_active = 1`,
      company.id, event, ...(onlyRuleId ? [onlyRuleId] : []));
    for (const r of rules) {
      if (r.min_amount != null && (data.amount_base ?? data.amount ?? 0) < r.min_amount) continue;
      let ok = false, detail = "";
      try {
        if (r.action === "email") {
          const amount = data.amount != null ? formatMoney(data.amount, data.currency ?? company.base_currency, company.number_locale ?? "en-IN") : "";
          const text = `${AUTOMATION_EVENTS[event]}: ${[data.number, data.contact_name, amount, data.date].filter(Boolean).join(" · ")}\n\n(Rule “${r.name}” in ${company.legal_name || company.name}.)`;
          const sent = await Promise.all(r.target.split(",").map((t) => t.trim()).filter(deliverable).map((to) => sendMail(env, { to, subject: `${company.name}: ${AUTOMATION_EVENTS[event].toLowerCase()}${data.number ? ` — ${data.number}` : ""}`, text })));
          ok = sent.some(Boolean); detail = ok ? "sent" : "email not sent (email is off or the address is invalid)";
        } else {
          const body = JSON.stringify({ event, company_id: company.id, sent_at: new Date().toISOString(), data });
          const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "LedgerFox-Webhooks/1", "x-ledgerfox-event": event };
          if (r.secret_enc) headers["x-ledgerfox-signature"] = `sha256=${await hmacHex(await decryptSecret(env, r.secret_enc), body)}`;
          const res = await fetch(r.target, { method: "POST", headers, body, signal: AbortSignal.timeout(8000), redirect: "manual" });
          ok = res.status >= 200 && res.status < 300; detail = `HTTP ${res.status}`;
        }
      } catch (e) { detail = (e as Error).message.slice(0, 200); }
      await run(env.DB, `INSERT INTO automation_runs (id, rule_id, event, entity_id, ok, detail) VALUES (?,?,?,?,?,?)`, newId(), r.id, event, data.id, ok ? 1 : 0, detail);
    }
  } catch (e) { console.error(JSON.stringify({ level: "error", code: "AUTOMATION_FAILED", event, message: (e as Error).message })); }
}

/** Fire-and-forget from a request: after the response when the platform allows, otherwise straight away. */
export function trigger(c: Context<AppEnv>, event: AutomationEvent, data: EventData) {
  const p = runAutomations(c.env, c.get("company"), event, data);
  try { c.executionCtx.waitUntil(p); } catch { return p; }
  return Promise.resolve();
}

/** "A customer payment is received" / "A supplier is paid" for a recorded payment. */
export async function paymentAutomation(c: Context<AppEnv>, paymentId: string, event?: AutomationEvent) {
  const p = await first<{ direction: string; number: string; payment_date: string; amount: number; amount_base: number; currency: string; contact_id: string; contact_name: string }>(c.env.DB,
    `SELECT p.direction, p.number, p.payment_date, p.amount, p.amount_base, p.currency, p.contact_id, ct.name AS contact_name FROM payments p JOIN contacts ct ON ct.id = p.contact_id WHERE p.id = ?`, paymentId);
  if (!p) return;
  await trigger(c, event ?? (p.direction === "in" ? "payment.received" : "payment.made"),
    { id: paymentId, number: p.number, amount: p.amount, amount_base: p.amount_base, currency: p.currency, contact_id: p.contact_id, contact_name: p.contact_name, date: p.payment_date });
}
