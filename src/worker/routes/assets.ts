import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { all, batch, first, stmt } from "../lib/db";
import { badRequest, conflict, notFound, unprocessable } from "../lib/errors";
import { body, isoDate, reqText, shortText, optId, minor, percentBp } from "../lib/validate";
import { newId } from "../lib/crypto";
import { audit, requireAnyPerm, requirePerm } from "../lib/auth";
import { currencyExponent } from "@shared/currencies";
import { buildJournal, systemAccounts, assertOpenPeriod, assertPostable, type LineInput } from "../services/ledger";
import { depreciationFor, schedule, type AssetLike } from "../services/depreciation";

const assets = new Hono<AppEnv>();
assets.use("*", async (c, next) => { if (c.req.method === "GET") requireAnyPerm(c, "assets.manage", "reports.read"); await next(); });

type AssetRow = AssetLike & { id: string; code: string; name: string; status: string; asset_account_id: string; accum_dep_account_id: string; dep_expense_account_id: string; acquisition_date: string };

async function accumulated(db: D1Database, assetId: string, beforeMonth?: string) {
  const r = await first<{ s: number }>(db,
    `SELECT COALESCE(SUM(amount),0) AS s FROM depreciation_entries WHERE asset_id = ? ${beforeMonth ? "AND period_month < ?" : ""}`, ...(beforeMonth ? [assetId, beforeMonth] : [assetId]));
  return r?.s ?? 0;
}

assets.get("/", async (c) => {
  const company = c.get("company");
  const rows = await all(c.env.DB,
    `SELECT f.*, (SELECT COALESCE(SUM(amount),0) FROM depreciation_entries d WHERE d.asset_id = f.id) AS accumulated_depreciation,
       (SELECT MAX(period_month) FROM depreciation_entries d WHERE d.asset_id = f.id) AS last_depreciated
     FROM fixed_assets f WHERE f.company_id = ? ORDER BY f.code`, company.id);
  return c.json({ assets: rows });
});

assets.get("/:id", async (c) => {
  const company = c.get("company");
  const a = await first<AssetRow>(c.env.DB, `SELECT * FROM fixed_assets WHERE id = ? AND company_id = ?`, c.req.param("id"), company.id);
  if (!a) throw notFound("Asset");
  const entries = await all(c.env.DB,
    `SELECT d.*, e.entry_number FROM depreciation_entries d JOIN journal_entries e ON e.id = d.journal_entry_id WHERE d.asset_id = ? ORDER BY d.period_month`, a.id);
  return c.json({ asset: a, entries, schedule: schedule(a), accumulated_depreciation: await accumulated(c.env.DB, a.id) });
});

const assetSchema = z.object({
  code: reqText(30),
  name: reqText(200),
  category: shortText(80).nullish(),
  acquisition_date: isoDate,
  depreciation_start_date: isoDate.nullish(),
  cost: z.union([z.string(), z.number()]),
  salvage_value: z.union([z.string(), z.number()]).default("0"),
  method: z.enum(["slm", "wdv"]),
  useful_life_months: z.number().int().min(1).max(1200).nullish(),
  wdv_rate_percent: z.union([z.string(), z.number()]).nullish(),
  asset_account_id: z.string(),
  accum_dep_account_id: optId,
  dep_expense_account_id: optId,
  /** Post the acquisition now (Dr asset / Cr this account). Leave empty if the purchase was already recorded via a bill. */
  paid_from_account_id: optId,
  contact_id: optId,
});

assets.post("/", async (c) => {
  requirePerm(c, "assets.manage");
  const input = await body(c, assetSchema);
  const company = c.get("company");
  const user = c.get("user");
  const exp = currencyExponent(company.base_currency);
  const cost = minor(input.cost, exp, "cost");
  const salvage = minor(input.salvage_value, exp, "salvage value");
  if (cost <= 0) throw badRequest("Cost must be positive");
  if (salvage < 0 || salvage >= cost) throw badRequest("Salvage value must be between 0 and the cost");
  if (input.method === "slm" && !input.useful_life_months) throw badRequest("Useful life is required for straight-line depreciation");
  const wdvBp = input.method === "wdv" ? percentBp(input.wdv_rate_percent, "WDV rate") : null;
  if (input.method === "wdv" && (!wdvBp || wdvBp <= 0 || wdvBp > 10000)) throw badRequest("WDV rate must be between 0 and 100%");
  const assetAcc = await assertPostable(c.env.DB, company.id, input.asset_account_id, "Asset account");
  if (assetAcc.subtype !== "fixed_asset") throw badRequest("Asset account must be a fixed-asset account");
  const sys = await systemAccounts(c.env.DB, company.id, ["ACCUM_DEP", "DEP_EXPENSE"]);
  const accum = input.accum_dep_account_id ?? sys.ACCUM_DEP;
  const depExp = input.dep_expense_account_id ?? sys.DEP_EXPENSE;
  await assertPostable(c.env.DB, company.id, accum, "Accumulated depreciation account");
  await assertPostable(c.env.DB, company.id, depExp, "Depreciation expense account");
  const id = newId();
  const stmts: D1PreparedStatement[] = [];
  let journalId: string | null = null;
  if (input.paid_from_account_id) {
    await assertPostable(c.env.DB, company.id, input.paid_from_account_id, "Paid-from account");
    await assertOpenPeriod(c.env.DB, company.id, input.acquisition_date);
    const built = buildJournal(c.env.DB, {
      company_id: company.id, entry_date: input.acquisition_date, kind: "system", memo: `Acquisition of ${input.name} (${input.code})`,
      source_type: "asset_acquisition", source_id: id, created_by: user.id, post: true,
      lines: [{ account_id: input.asset_account_id, debit: cost }, { account_id: input.paid_from_account_id, credit: cost, contact_id: input.contact_id ?? null }],
    });
    journalId = built.id;
    stmts.push(...built.stmts);
  }
  stmts.unshift(stmt(c.env.DB,
    `INSERT INTO fixed_assets (id, company_id, code, name, category, acquisition_date, depreciation_start_date, cost, salvage_value, method, useful_life_months,
       wdv_rate_bp, asset_account_id, accum_dep_account_id, dep_expense_account_id, acquisition_journal_id, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?)`,
    id, company.id, input.code, input.name, input.category ?? null, input.acquisition_date, input.depreciation_start_date ?? input.acquisition_date,
    cost, salvage, input.method, input.method === "slm" ? input.useful_life_months! : null, wdvBp, input.asset_account_id, accum, depExp, user.id));
  if (journalId) stmts.push(stmt(c.env.DB, `UPDATE fixed_assets SET acquisition_journal_id = ? WHERE id = ?`, journalId, id));
  stmts.push(audit(c, "asset.create", "asset", id, { code: input.code, cost }));
  await batch(c.env.DB, stmts);
  return c.json({ id, journal_id: journalId }, 201);
});

/**
 * Run depreciation for every month up to `through` (YYYY-MM) that has not been run yet.
 * One journal per month; uniqueness of (asset, month) makes re-runs harmless.
 */
assets.post("/depreciation/run", async (c) => {
  requirePerm(c, "assets.manage");
  const input = await body(c, z.object({ through: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }));
  const company = c.get("company");
  const user = c.get("user");
  const list = await all<AssetRow>(c.env.DB, `SELECT * FROM fixed_assets WHERE company_id = ? AND status = 'active' AND substr(depreciation_start_date,1,7) <= ?`, company.id, input.through);
  const months = new Set<string>();
  const plan = new Map<string, { asset: AssetRow; amount: number }[]>();
  for (const a of list) {
    const done = new Set((await all<{ period_month: string }>(c.env.DB, `SELECT period_month FROM depreciation_entries WHERE asset_id = ?`, a.id)).map((r) => r.period_month));
    let acc = await accumulated(c.env.DB, a.id);
    let [y, m] = a.depreciation_start_date.slice(0, 7).split("-").map(Number);
    for (let guard = 0; guard < 1200; guard++) {
      const month = `${y}-${String(m).padStart(2, "0")}`;
      if (month > input.through) break;
      if (!done.has(month)) {
        const amt = depreciationFor(a, month, acc);
        if (amt > 0) {
          acc += amt;
          months.add(month);
          (plan.get(month) ?? plan.set(month, []).get(month)!).push({ asset: a, amount: amt });
        }
      }
      m++; if (m > 12) { m = 1; y++; }
    }
  }
  const sorted = [...months].sort();
  if (sorted.length > 36) throw unprocessable("TOO_MANY_MONTHS", "More than 36 months pending. Run depreciation in smaller steps (choose an earlier 'through' month).");
  let journals = 0;
  for (const month of sorted) {
    const [y, m] = month.split("-").map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    await assertOpenPeriod(c.env.DB, company.id, lastDay);
    const items = plan.get(month)!;
    const lines: LineInput[] = [];
    for (const it of items) {
      lines.push({ account_id: it.asset.dep_expense_account_id, debit: it.amount, description: `Depreciation ${it.asset.code} ${month}` });
      lines.push({ account_id: it.asset.accum_dep_account_id, credit: it.amount, description: `Depreciation ${it.asset.code} ${month}` });
    }
    const built = buildJournal(c.env.DB, {
      company_id: company.id, entry_date: lastDay, kind: "depreciation", memo: `Depreciation for ${month}`,
      source_type: "depreciation_run", source_id: newId(), created_by: user.id, post: true, lines,
    });
    const stmts = [...built.stmts];
    for (const it of items) {
      stmts.push(stmt(c.env.DB, `INSERT INTO depreciation_entries (id, company_id, asset_id, period_month, amount, journal_entry_id) VALUES (?,?,?,?,?,?)`,
        newId(), company.id, it.asset.id, month, it.amount, built.id));
    }
    stmts.push(audit(c, "asset.depreciate", "company", company.id, { month, assets: items.length }));
    await batch(c.env.DB, stmts);
    journals++;
  }
  return c.json({ months: sorted, journals });
});

assets.post("/:id/dispose", async (c) => {
  requirePerm(c, "assets.manage");
  const input = await body(c, z.object({ date: isoDate, proceeds: z.union([z.string(), z.number()]).default("0"), deposit_account_id: optId }));
  const company = c.get("company");
  const user = c.get("user");
  const a = await first<AssetRow>(c.env.DB, `SELECT * FROM fixed_assets WHERE id = ? AND company_id = ?`, c.req.param("id"), company.id);
  if (!a) throw notFound("Asset");
  if (a.status !== "active") throw conflict("DISPOSED", "Asset is already disposed");
  const proceeds = minor(input.proceeds, currencyExponent(company.base_currency), "proceeds");
  if (proceeds < 0) throw badRequest("Proceeds cannot be negative");
  if (proceeds > 0 && !input.deposit_account_id) throw badRequest("Choose the account that received the proceeds");
  const lateEntry = await first(c.env.DB, `SELECT 1 FROM depreciation_entries WHERE asset_id = ? AND period_month > ?`, a.id, input.date.slice(0, 7));
  if (lateEntry) throw conflict("DEPRECIATED_AFTER", "Depreciation exists after the disposal date");
  await assertOpenPeriod(c.env.DB, company.id, input.date);
  const acc = await accumulated(c.env.DB, a.id);
  const sys = await systemAccounts(c.env.DB, company.id, ["ASSET_DISPOSAL"]);
  const bookValue = a.cost - acc;
  const gain = proceeds - bookValue;
  const lines: LineInput[] = [
    { account_id: a.accum_dep_account_id, debit: acc, description: "Remove accumulated depreciation" },
    { account_id: a.asset_account_id, credit: a.cost, description: "Remove asset cost" },
  ];
  if (proceeds > 0) lines.push({ account_id: input.deposit_account_id!, debit: proceeds, description: "Disposal proceeds" });
  if (gain > 0) lines.push({ account_id: sys.ASSET_DISPOSAL, credit: gain, description: "Gain on disposal" });
  if (gain < 0) lines.push({ account_id: sys.ASSET_DISPOSAL, debit: -gain, description: "Loss on disposal" });
  const built = buildJournal(c.env.DB, {
    company_id: company.id, entry_date: input.date, kind: "system", memo: `Disposal of ${a.name} (${a.code})`,
    source_type: "asset_disposal", source_id: a.id, created_by: user.id, post: true, lines,
  });
  await batch(c.env.DB, [
    ...built.stmts,
    stmt(c.env.DB, `UPDATE fixed_assets SET status = 'disposed', disposal_date = ?, disposal_proceeds = ?, disposal_journal_id = ? WHERE id = ? AND company_id = ? AND status = 'active'`,
      input.date, proceeds, built.id, a.id, company.id),
    audit(c, "asset.dispose", "asset", a.id, { proceeds, gain }),
  ]);
  return c.json({ journal_id: built.id, gain });
});

export default assets;
