import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { all, batch, first, run, stmt, todayIso } from "../lib/db";
import { badRequest, conflict, notFound } from "../lib/errors";
import { body, isoDate, minor, reqText } from "../lib/validate";
import { newId } from "../lib/crypto";
import { audit, requireAnyPerm, requirePerm } from "../lib/auth";
import { currencyExponent } from "@shared/currencies";
import { prepareDraft } from "../services/documents";
import { systemAccounts } from "../services/ledger";

/**
 * Project time billing: each project has a customer and an hourly rate; people log the hours they worked, and the
 * unbilled hours become a draft invoice (one line per entry, tagged with the project) in one click.
 */
export const projects = new Hono<AppEnv>();

// An entry is unbilled while its invoice does not exist any more (draft deleted) or was cancelled.
const UNBILLED = `(t.invoice_id IS NULL OR NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = t.invoice_id AND d.status <> 'void'))`;

projects.get("/", async (c) => {
  requireAnyPerm(c, "sales.view", "sales.create");
  const companyId = c.get("company").id;
  const rows = await all(c.env.DB,
    `SELECT p.id, p.code, p.name, p.is_active, p.contact_id, p.hourly_rate, ct.name AS customer,
            COALESCE((SELECT SUM(t.minutes) FROM time_entries t WHERE t.project_id = p.id AND t.billable = 1 AND ${UNBILLED}), 0) AS unbilled_minutes,
            COALESCE((SELECT SUM(t.minutes * COALESCE(t.rate, p.hourly_rate, 0)) FROM time_entries t WHERE t.project_id = p.id AND t.billable = 1 AND ${UNBILLED}), 0) / 60 AS unbilled_amount,
            COALESCE((SELECT SUM(t.minutes) FROM time_entries t WHERE t.project_id = p.id), 0) AS total_minutes
       FROM projects p LEFT JOIN contacts ct ON ct.id = p.contact_id WHERE p.company_id = ? ORDER BY p.is_active DESC, p.name`, companyId);
  return c.json({ projects: rows });
});

projects.patch("/:id/billing", async (c) => {
  requirePerm(c, "sales.create");
  const company = c.get("company");
  const input = await body(c, z.object({ contact_id: z.string().max(64).nullish(), hourly_rate: z.union([z.string(), z.number()]).nullish() }));
  if (input.contact_id && !(await first(c.env.DB, `SELECT 1 FROM contacts WHERE id = ? AND company_id = ? AND kind <> 'supplier'`, input.contact_id, company.id))) throw badRequest("Choose a customer");
  const rate = input.hourly_rate === null || input.hourly_rate === undefined || input.hourly_rate === "" ? null : minor(input.hourly_rate, currencyExponent(company.base_currency), "hourly rate");
  const r = await run(c.env.DB, `UPDATE projects SET contact_id = ?, hourly_rate = ? WHERE id = ? AND company_id = ?`, input.contact_id || null, rate, c.req.param("id"), company.id);
  if (!r.meta.changes) throw notFound("Project");
  return c.json({ ok: true });
});

projects.get("/:id/time", async (c) => {
  requireAnyPerm(c, "sales.view", "sales.create");
  const rows = await all(c.env.DB,
    `SELECT t.id, t.work_date, t.minutes, t.description, t.billable, t.rate, t.invoice_id, u.name AS user_name,
            CASE WHEN ${UNBILLED} THEN 0 ELSE 1 END AS billed, d.number AS invoice_number
       FROM time_entries t LEFT JOIN users u ON u.id = t.user_id LEFT JOIN documents d ON d.id = t.invoice_id
      WHERE t.company_id = ? AND t.project_id = ? ORDER BY t.work_date DESC, t.created_at DESC LIMIT 500`, c.get("company").id, c.req.param("id"));
  return c.json({ entries: rows });
});

projects.post("/:id/time", async (c) => {
  requireAnyPerm(c, "sales.create", "sales.view");
  const company = c.get("company");
  const input = await body(c, z.object({ work_date: isoDate, hours: z.union([z.string(), z.number()]), description: reqText(300), billable: z.boolean().optional(), rate: z.union([z.string(), z.number()]).nullish() }));
  const hours = Number(input.hours);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) throw badRequest("Hours must be between 0 and 24");
  if (!(await first(c.env.DB, `SELECT 1 FROM projects WHERE id = ? AND company_id = ?`, c.req.param("id"), company.id))) throw notFound("Project");
  const id = newId();
  await run(c.env.DB, `INSERT INTO time_entries (id, company_id, project_id, user_id, work_date, minutes, description, billable, rate) VALUES (?,?,?,?,?,?,?,?,?)`,
    id, company.id, c.req.param("id"), c.get("user").id, input.work_date, Math.round(hours * 60), input.description, input.billable === false ? 0 : 1,
    input.rate ? minor(input.rate, currencyExponent(company.base_currency), "rate") : null);
  return c.json({ id }, 201);
});

projects.delete("/time/:entryId", async (c) => {
  requireAnyPerm(c, "sales.create", "sales.view");
  const t = await first<{ billed: number; user_id: string }>(c.env.DB, `SELECT CASE WHEN ${UNBILLED} THEN 0 ELSE 1 END AS billed, t.user_id FROM time_entries t WHERE t.id = ? AND t.company_id = ?`, c.req.param("entryId"), c.get("company").id);
  if (!t) throw notFound("Time entry");
  if (t.billed) throw conflict("BILLED", "This time is on an invoice already");
  if (t.user_id !== c.get("user").id) requirePerm(c, "sales.create");
  await run(c.env.DB, `DELETE FROM time_entries WHERE id = ?`, c.req.param("entryId"));
  return c.json({ ok: true });
});

/** A draft invoice for the project's unbilled hours (optionally up to a date). */
projects.post("/:id/invoice", async (c) => {
  requirePerm(c, "sales.create");
  const company = c.get("company");
  const input = await body(c, z.object({ up_to: isoDate.optional() }));
  const p = await first<{ id: string; name: string; contact_id: string | null; hourly_rate: number | null }>(c.env.DB, `SELECT id, name, contact_id, hourly_rate FROM projects WHERE id = ? AND company_id = ?`, c.req.param("id"), company.id);
  if (!p) throw notFound("Project");
  if (!p.contact_id) throw badRequest("Choose the project's customer first");
  const entries = await all<{ id: string; work_date: string; minutes: number; description: string; rate: number | null; user_name: string | null }>(c.env.DB,
    `SELECT t.id, t.work_date, t.minutes, t.description, t.rate, u.name AS user_name FROM time_entries t LEFT JOIN users u ON u.id = t.user_id
      WHERE t.company_id = ? AND t.project_id = ? AND t.billable = 1 AND ${UNBILLED} AND t.work_date <= ? ORDER BY t.work_date, t.created_at`, company.id, p.id, input.up_to ?? todayIso());
  if (!entries.length) throw badRequest("There is no unbilled time on this project");
  if (entries.some((e) => (e.rate ?? p.hourly_rate) == null)) throw badRequest("Set the project's hourly rate first");
  const acc = await systemAccounts(c.env.DB, company.id, ["SALES"]);
  const prepared = await prepareDraft(c, {
    doc_type: "invoice", contact_id: p.contact_id, issue_date: todayIso(), currency: company.base_currency, reference: p.name,
    lines: entries.map((e) => ({
      description: `${e.work_date} · ${e.description}${e.user_name ? ` (${e.user_name})` : ""}`, qty_milli: Math.round((e.minutes * 1000) / 60), unit_price: e.rate ?? p.hourly_rate!,
      discount_bp: 0, account_id: acc.SALES, project_id: p.id,
    })),
  });
  await batch(c.env.DB, [
    ...prepared.stmts,
    ...entries.map((e) => stmt(c.env.DB, `UPDATE time_entries SET invoice_id = ? WHERE id = ?`, prepared.id, e.id)),
    audit(c, "project.invoice", "document", prepared.id, { project: p.name, entries: entries.length }),
  ]);
  return c.json({ id: prepared.id, entries: entries.length }, 201);
});
