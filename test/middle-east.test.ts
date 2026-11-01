import { describe, expect, it } from "vitest";
import { makeEnv, Client } from "./helpers";
import { gratuity, serviceYears } from "../src/shared/gratuity";
import { countryPack } from "../src/shared/countries";
import { CURRENCIES } from "../src/shared/currencies";
import { bilingual, isRtl, translate } from "../src/shared/i18n";

async function company(country: string, currency: string, tax_id?: string) {
  const { env } = await makeEnv();
  const owner = new Client(env);
  await owner.post("/api/auth/register", { name: "Owner", email: `me-${Math.random().toString(36).slice(2, 8)}@example.com`, password: "correct horse battery", accept_terms: true });
  const r = await owner.post("/api/orgs", { name: "Org", company: { name: "Trading LLC", country, base_currency: currency, fiscal_year_start_month: 1, ...(tax_id ? { tax_id } : {}) } });
  const c = (p: string) => `/api/c/${r.json.company_id}${p}`;
  return { owner, c };
}

describe("Middle East", () => {
  it("knows the wider region's VAT and currencies (3-decimal dinars)", () => {
    expect(countryPack("EG").codes[0]).toMatchObject({ rate_bp: 1400 });
    expect(countryPack("JO").codes[0]).toMatchObject({ name: "Sales tax 16%", rate_bp: 1600 });
    expect(countryPack("TR").codes[0].rate_bp).toBe(2000);
    expect(countryPack("LB").codes[0].rate_bp).toBe(1100);
    expect(countryPack("IQ").codes[0].name).toBe("No VAT");
    expect(CURRENCIES.JOD.exponent).toBe(3);
    expect(CURRENCIES.KWD.exponent).toBe(3);
    expect(CURRENCIES.EGP.exponent).toBe(2);
  });

  it("speaks Arabic in the app (right to left) and on bills", () => {
    expect(isRtl("ar")).toBe(true);
    expect(translate("Customers", "ar")).toBe("العملاء");
    expect(translate("Something new", "ar")).toBe("Something new");
    expect(bilingual("Tax Invoice", "ar")).toBe("Tax Invoice / فاتورة ضريبية");
  });

  it("prepares a UAE VAT return: standard, zero-rated, exempt, purchases and net payable", async () => {
    const { owner, c } = await company("AE", "AED", "100123456700003");
    const codes = (await owner.get(c("/settings"))).json.tax_codes as any[];
    const id = (n: string) => codes.find((t) => t.name === n).id;
    const cust = (await owner.post(c("/contacts"), { kind: "customer", name: "Buyer" })).json.id;
    const supp = (await owner.post(c("/contacts"), { kind: "supplier", name: "Seller" })).json.id;
    const date = new Date().toISOString().slice(0, 10);
    const doc = async (doc_type: string, contact_id: string, lines: any[]) => {
      const d = (await owner.post(c("/documents"), { doc_type, contact_id, issue_date: date, lines })).json;
      expect((await owner.post(c(`/documents/${d.id}/issue`))).status).toBe(200);
    };
    await doc("invoice", cust, [{ description: "Service", quantity: "1", unit_price: "1000", tax_code_id: id("VAT 5%") },
      { description: "Export", quantity: "1", unit_price: "400", tax_code_id: id("VAT 0% (zero-rated)") },
      { description: "Residential rent", quantity: "1", unit_price: "300", tax_code_id: id("VAT exempt") }]);
    await doc("bill", supp, [{ description: "Office supplies", quantity: "1", unit_price: "200", tax_code_id: id("VAT 5%") }]);
    const r = (await owner.get(c(`/reports/vat-return?from=${date}&to=${date}`))).json;
    expect(r.sales.standard).toEqual({ taxable: 100_000, vat: 5_000 });
    expect(r.sales.zero.taxable).toBe(40_000);
    expect(r.sales.exempt.taxable).toBe(30_000);
    expect(r.purchases.standard).toEqual({ taxable: 20_000, vat: 1_000 });
    expect([r.output_vat, r.input_vat, r.net_vat]).toEqual([5_000, 1_000, 4_000]);
  });

  it("calculates end-of-service gratuity under UAE and Saudi labour law", async () => {
    const wage = 300_000; // 3,000.00 a month → 100.00 a day
    // UAE: 7 years = 5 × 21 days + 2 × 30 days = 165 days.
    const ae = gratuity("AE", wage, "2019-01-01", "2026-01-01");
    expect(ae.years).toBeCloseTo(7.0, 1);
    expect(ae.amount).toBeGreaterThan(1_640_000);
    expect(ae.amount).toBeLessThan(1_660_000);
    expect(gratuity("AE", wage, "2026-01-01", "2026-06-01").amount).toBe(0);
    // Saudi: 6 years = 5 × ½ month + 1 × 1 month = 3.5 months; resignation at 6 years gets two thirds.
    const sa = gratuity("SA", wage, "2020-01-01", "2026-01-01");
    expect(sa.amount / wage).toBeCloseTo(3.5, 1);
    expect(gratuity("SA", wage, "2020-01-01", "2026-01-01", "resignation").amount / sa.amount).toBeCloseTo(2 / 3, 2);
    expect(gratuity("SA", wage, "2025-01-01", "2026-01-01", "resignation").amount).toBe(0);
    expect(serviceYears("2026-01-01", "2025-01-01")).toBe(0);

    const { owner, c } = await company("SA", "SAR", "310122393500003");
    await owner.post(c("/payroll/employees"), { code: "E1", name: "Ahmed", monthly_basic: "3000", date_of_joining: "2020-01-01" });
    const g = (await owner.get(c("/payroll/gratuity?as_of=2026-01-01"))).json;
    expect(g.employees[0]).toMatchObject({ name: "Ahmed" });
    expect(g.total / wage).toBeCloseTo(3.5, 1);
  });
});
