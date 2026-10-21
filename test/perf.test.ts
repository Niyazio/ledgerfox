/**
 * Performance measurement (run with PERF=1): seeds a large company through the real API on the desktop engine,
 * then times the heaviest read endpoints. Not part of the normal suite.
 */
import { describe, it, expect } from "vitest";
import { world, contact } from "./helpers";

const N_INVOICES = Number(process.env.PERF_INVOICES ?? 2000);
const N_ITEMS = Number(process.env.PERF_ITEMS ?? 1500);

describe.skipIf(!process.env.PERF)("performance", () => {
  it(`large company: ${N_INVOICES} invoices, ${N_ITEMS} items`, async () => {
    const W = await world();
    const customers = await Promise.all(Array.from({ length: 50 }, () => contact(W, "customer", { state_code: "29" })));
    const t0 = Date.now();
    for (let i = 0; i < N_ITEMS; i++) {
      await W.owner.post(W.c("/items"), { kind: "goods", name: `Product ${i}`, sku: `SKU${i}`, unit: "nos", sale_price: "100", purchase_price: "60", tax_code_id: W.tax["GST 18%"] });
    }
    for (let i = 0; i < N_INVOICES; i++) {
      const d = await W.owner.post(W.c("/documents"), { doc_type: "invoice", contact_id: customers[i % 50], issue_date: `2026-${String(4 + (i % 6)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}`,
        lines: [{ description: "Item", quantity: "2", unit_price: "500", tax_code_id: W.tax["GST 18%"] }, { description: "Service", quantity: "1", unit_price: "250" }] });
      await W.owner.post(W.c(`/documents/${d.json.id}/issue`));
    }
    console.log(`seeded in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    // PERF_DUMP=<file> keeps a copy of the seeded database for query-plan analysis (desktop engine only).
    if (process.env.PERF_DUMP) await W.env.DB.prepare(`VACUUM INTO '${process.env.PERF_DUMP.replace(/'/g, "''")}'`).run();
    const endpoints = [
      "/reports/dashboard", "/documents?doc_type=invoice&limit=50", "/documents?doc_type=invoice&limit=50&q=INV-01", "/items?active=1&limit=500",
      "/contacts?kind=customer&active=1&limit=500", "/reports/trial-balance?from=2026-04-01&to=2026-12-31", "/reports/profit-loss?from=2026-04-01&to=2026-12-31",
      "/reports/balance-sheet?to=2026-12-31", "/reports/aging/receivable?as_of=2026-12-31", "/journals?limit=50", "/reports/gst-summary?from=2026-04-01&to=2026-12-31",
    ];
    const results: Record<string, number> = {};
    for (const e of endpoints) {
      const r0 = await W.owner.get(W.c(e));
      expect(r0.status, e).toBe(200);
      const times: number[] = [];
      for (let k = 0; k < 5; k++) { const s = performance.now(); await W.owner.get(W.c(e)); times.push(performance.now() - s); }
      times.sort((a, b) => a - b);
      results[e] = Math.round(times[2] * 10) / 10;
    }
    console.table(results);
  }, 600_000);
});
