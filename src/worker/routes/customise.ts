import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { all, batch, first, run, stmt } from "../lib/db";
import { AppError, badRequest, notFound } from "../lib/errors";
import { body, reqText, shortText, minor } from "../lib/validate";
import { newId, randomToken } from "../lib/crypto";
import { audit, requireAnyPerm, requirePerm } from "../lib/auth";
import { currencyExponent } from "@shared/currencies";
import { docFamily, SALES_DOC_TYPES } from "@shared/permissions";
import { AUTOMATION_EVENTS, cleanValue, customFields, customValues, reportEmail, runAutomations, type AutomationEvent, type CustomEntity } from "../services/customise";
import { encryptSecret, secretsReady } from "../services/collect";
import { emailOn, sendMail } from "../services/email";

export const customise = new Hono<AppEnv>();
const ENTITIES = ["sales", "purchase", "contact", "item"] as const;

// ── Custom fields ──

customise.get("/custom-fields", async (c) => c.json({ fields: await customFields(c.env, c.get("company").id) }));

const fieldSchema = z.object({
  entity: z.enum(ENTITIES), label: reqText(60), field_type: z.enum(["text", "number", "date", "select", "checkbox"]),
  options: z.array(reqText(60)).max(30).optional(), show_on_print: z.boolean().optional(), sort: z.number().int().min(0).max(999).optional(),
});

customise.post("/custom-fields", async (c) => {
  requirePerm(c, "company.manage");
  const company = c.get("company");
  const input = await body(c, fieldSchema);
  if (input.field_type === "select" && !input.options?.length) throw badRequest("Add the choices for a list field");
  const n = await first<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM custom_fields WHERE company_id = ? AND entity = ?`, company.id, input.entity);
  if ((n?.n ?? 0) >= 20) throw badRequest("At most 20 custom fields of each kind");
  const id = newId();
  await batch(c.env.DB, [
    stmt(c.env.DB, `INSERT INTO custom_fields (id, company_id, entity, label, field_type, options, show_on_print, sort) VALUES (?,?,?,?,?,?,?,?)`,
      id, company.id, input.entity, input.label, input.field_type, input.field_type === "select" ? JSON.stringify(input.options) : null, input.show_on_print === false ? 0 : 1, input.sort ?? (n?.n ?? 0)),
    audit(c, "custom_field.create", "custom_field", id, { entity: input.entity, label: input.label }),
  ]);
  return c.json({ id }, 201);
});

customise.patch("/custom-fields/:id", async (c) => {
  requirePerm(c, "company.manage");
  const company = c.get("company");
  const f = await first<{ field_type: string }>(c.env.DB, `SELECT field_type FROM custom_fields WHERE id = ? AND company_id = ?`, c.req.param("id"), company.id);
  if (!f) throw notFound("Custom field");
  const input = await body(c, z.object({ label: reqText(60).optional(), options: z.array(reqText(60)).max(30).optional(), show_on_print: z.boolean().optional(), sort: z.number().int().min(0).max(999).optional(), is_active: z.boolean().optional() }));
  await run(c.env.DB, `UPDATE custom_fields SET label = COALESCE(?, label), options = COALESCE(?, options), show_on_print = COALESCE(?, show_on_print), sort = COALESCE(?, sort), is_active = COALESCE(?, is_active) WHERE id = ?`,
    input.label ?? null, f.field_type === "select" && input.options ? JSON.stringify(input.options) : null, input.show_on_print === undefined ? null : input.show_on_print ? 1 : 0,
    input.sort ?? null, input.is_active === undefined ? null : input.is_active ? 1 : 0, c.req.param("id"));
  return c.json({ ok: true });
});

/** The record a value belongs to, checked against the member's permissions. */
async function checkEntity(c: Context<AppEnv>, entity: CustomEntity, id: string, write: boolean) {
  const db = c.env.DB, companyId = c.get("company").id;
  if (entity === "sales" || entity === "purchase") {
    const d = await first<{ doc_type: string }>(db, `SELECT doc_type FROM documents WHERE id = ? AND company_id = ?`, id, companyId);
    if (!d || (entity === "sales") !== SALES_DOC_TYPES.includes(d.doc_type)) throw notFound("Document");
    requirePerm(c, `${docFamily(d.doc_type)}.${write ? "create" : "view"}` as never);
  } else if (entity === "contact") {
    const ct = await first<{ kind: string }>(db, `SELECT kind FROM contacts WHERE id = ? AND company_id = ?`, id, companyId);
    if (!ct) throw notFound("Contact");
    if (write) requireAnyPerm(c, ...(ct.kind === "supplier" ? ["suppliers.write"] : ct.kind === "customer" ? ["customers.write"] : ["customers.write", "suppliers.write"]) as never[]);
  } else {
    if (!(await first(db, `SELECT 1 FROM items WHERE id = ? AND company_id = ?`, id, companyId))) throw notFound("Item");
    if (write) requirePerm(c, "items.write");
  }
}

customise.get("/custom-values/:entity/:id", async (c) => {
  const entity = z.enum(ENTITIES).parse(c.req.param("entity"));
  await checkEntity(c, entity, c.req.param("id"), false);
  return c.json({ values: await customValues(c.env, c.get("company").id, c.req.param("id")) });
});

customise.put("/custom-values/:entity/:id", async (c) => {
  const entity = z.enum(ENTITIES).parse(c.req.param("entity"));
  const entityId = c.req.param("id");
  await checkEntity(c, entity, entityId, true);
  const company = c.get("company");
  const input = await body(c, z.object({ values: z.record(z.string().max(64), z.union([z.string().max(500), z.number(), z.boolean(), z.null()])) }));
  const fields = (await customFields(c.env, company.id, entity)).filter((f) => f.is_active);
  const stmts = [];
  for (const [fieldId, raw] of Object.entries(input.values)) {
    const f = fields.find((x) => x.id === fieldId);
    if (!f) throw badRequest("Unknown custom field");
    const v = cleanValue(f, raw);
    stmts.push(v === null
      ? stmt(c.env.DB, `DELETE FROM custom_values WHERE field_id = ? AND entity_id = ?`, fieldId, entityId)
      : stmt(c.env.DB, `INSERT INTO custom_values (company_id, field_id, entity_id, value) VALUES (?,?,?,?) ON CONFLICT (field_id, entity_id) DO UPDATE SET value = excluded.value`, company.id, fieldId, entityId, v));
  }
  if (stmts.length) await batch(c.env.DB, stmts);
  return c.json({ values: await customValues(c.env, company.id, entityId) });
});

// ── Reports by email ──

const REPORTS = ["daily-summary", "profit-loss", "receivables", "payables", "stock"] as const;
const emails = z.string().trim().max(500).transform((s) => s.split(/[,;\s]+/).filter(Boolean)).refine((l) => l.length >= 1 && l.length <= 5 && l.every((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)), "Enter 1 to 5 email addresses");

customise.get("/report-schedules", async (c) => {
  requirePerm(c, "reports.read");
  return c.json({ schedules: await all(c.env.DB, `SELECT id, report, frequency, weekday, recipients, is_active, last_sent_on FROM report_schedules WHERE company_id = ? ORDER BY created_at`, c.get("company").id), email_ready: emailOn(c.env) });
});

customise.post("/report-schedules", async (c) => {
  requirePerm(c, "reports.read");
  requirePerm(c, "company.manage");
  if (!emailOn(c.env)) throw new AppError(409, "EMAIL_OFF", "Reports are sent by email, which is not set up on this LedgerFox yet. Please contact LedgerFox.");
  const company = c.get("company");
  const input = await body(c, z.object({ report: z.enum(REPORTS), frequency: z.enum(["daily", "weekly", "monthly"]), weekday: z.number().int().min(0).max(6).optional(), recipients: emails, send_now: z.boolean().optional() }));
  const id = newId();
  await batch(c.env.DB, [
    stmt(c.env.DB, `INSERT INTO report_schedules (id, company_id, report, frequency, weekday, recipients, created_by) VALUES (?,?,?,?,?,?,?)`,
      id, company.id, input.report, input.frequency, input.weekday ?? 1, input.recipients.join(", "), c.get("user").id),
    audit(c, "report_schedule.create", "report_schedule", id, { report: input.report, frequency: input.frequency, recipients: input.recipients }),
  ]);
  if (input.send_now) {
    const mail = await reportEmail(c.env, company, input, new Date().toISOString().slice(0, 10));
    for (const to of input.recipients) await sendMail(c.env, { to, ...mail });
  }
  return c.json({ id }, 201);
});

customise.delete("/report-schedules/:id", async (c) => {
  requirePerm(c, "company.manage");
  const r = await run(c.env.DB, `DELETE FROM report_schedules WHERE id = ? AND company_id = ?`, c.req.param("id"), c.get("company").id);
  if (!r.meta.changes) throw notFound("Schedule");
  return c.json({ ok: true });
});

// ── Automation rules ──

customise.get("/automations", async (c) => {
  requirePerm(c, "company.manage");
  const companyId = c.get("company").id;
  const rules = await all(c.env.DB, `SELECT id, name, event, min_amount, action, target, is_active, created_at, secret_enc IS NOT NULL AS signed FROM automation_rules WHERE company_id = ? ORDER BY created_at`, companyId);
  const runs = await all(c.env.DB, `SELECT r.rule_id, r.event, r.ok, r.detail, r.created_at FROM automation_runs r JOIN automation_rules a ON a.id = r.rule_id WHERE a.company_id = ? ORDER BY r.created_at DESC LIMIT 50`, companyId);
  return c.json({ rules, runs, events: AUTOMATION_EVENTS, email_ready: emailOn(c.env), webhooks_ready: secretsReady(c.env) });
});

customise.post("/automations", async (c) => {
  requirePerm(c, "company.manage");
  const company = c.get("company");
  const input = await body(c, z.object({
    name: reqText(80), event: z.enum(Object.keys(AUTOMATION_EVENTS) as [AutomationEvent, ...AutomationEvent[]]), min_amount: z.union([z.string(), z.number()]).nullish(),
    action: z.enum(["email", "webhook"]), target: shortText(500),
  }));
  let target = input.target.trim(), secret: string | null = null;
  if (input.action === "email") target = emails.parse(target).join(", ");
  else {
    let u: URL;
    try { u = new URL(target); } catch { throw badRequest("Enter the full https:// address of the webhook"); }
    if (u.protocol !== "https:" || /^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(u.hostname)) throw badRequest("The webhook must be a public https:// address");
    if (!secretsReady(c.env)) throw new AppError(503, "DATA_KEY_MISSING", "Webhooks are not available yet: the LedgerFox server needs its DATA_KEY secret. Please contact LedgerFox.");
    secret = `whsec_${randomToken(24)}`;
  }
  const n = await first<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM automation_rules WHERE company_id = ?`, company.id);
  if ((n?.n ?? 0) >= 30) throw badRequest("At most 30 automation rules");
  const id = newId();
  const min = input.min_amount === null || input.min_amount === undefined || input.min_amount === "" ? null : minor(input.min_amount, currencyExponent(company.base_currency), "minimum amount");
  await batch(c.env.DB, [
    stmt(c.env.DB, `INSERT INTO automation_rules (id, company_id, name, event, min_amount, action, target, secret_enc, created_by) VALUES (?,?,?,?,?,?,?,?,?)`,
      id, company.id, input.name, input.event, min, input.action, target, secret ? await encryptSecret(c.env, secret) : null, c.get("user").id),
    audit(c, "automation.create", "automation_rule", id, { name: input.name, event: input.event, action: input.action }),
  ]);
  // The signing secret is shown once, so the receiving system can check the X-LedgerFox-Signature header.
  return c.json({ id, signing_secret: secret }, 201);
});

customise.patch("/automations/:id", async (c) => {
  requirePerm(c, "company.manage");
  const input = await body(c, z.object({ is_active: z.boolean() }));
  const r = await run(c.env.DB, `UPDATE automation_rules SET is_active = ? WHERE id = ? AND company_id = ?`, input.is_active ? 1 : 0, c.req.param("id"), c.get("company").id);
  if (!r.meta.changes) throw notFound("Rule");
  return c.json({ ok: true });
});

customise.delete("/automations/:id", async (c) => {
  requirePerm(c, "company.manage");
  const r = await run(c.env.DB, `DELETE FROM automation_rules WHERE id = ? AND company_id = ?`, c.req.param("id"), c.get("company").id);
  if (!r.meta.changes) throw notFound("Rule");
  return c.json({ ok: true });
});

/** Sends a sample event to one rule, to check the email address or the webhook. */
customise.post("/automations/:id/test", async (c) => {
  requirePerm(c, "company.manage");
  const company = c.get("company");
  const rule = await first<{ event: AutomationEvent }>(c.env.DB, `SELECT event FROM automation_rules WHERE id = ? AND company_id = ?`, c.req.param("id"), company.id);
  if (!rule) throw notFound("Rule");
  await runAutomations(c.env, company, rule.event,
    { id: "test", number: "TEST-0001", amount: 100_00, amount_base: 100_00, currency: company.base_currency, contact_name: "Test customer", date: new Date().toISOString().slice(0, 10) }, c.req.param("id"));
  return c.json({ result: await first(c.env.DB, `SELECT ok, detail, created_at FROM automation_runs WHERE rule_id = ? ORDER BY created_at DESC LIMIT 1`, c.req.param("id")) });
});
