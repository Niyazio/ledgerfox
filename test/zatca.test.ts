import { describe, expect, it } from "vitest";
import { zatcaQr, zatcaAmount } from "../src/shared/zatca";
import { countryPack, taxIdProblem } from "../src/shared/countries";

describe("Saudi e-invoice QR (ZATCA phase 1)", () => {
  it("matches the example in ZATCA's QR code guideline", () => {
    expect(zatcaQr({ seller: "Bobs Records", vatNumber: "310122393500003", timestamp: "2022-04-25T15:30:00Z", total: "1000.00", vat: "150.00" }))
      .toBe("AQxCb2JzIFJlY29yZHMCDzMxMDEyMjM5MzUwMDAwMwMUMjAyMi0wNC0yNVQxNTozMDowMFoEBzEwMDAuMDAFBjE1MC4wMA==");
  });
  it("encodes Arabic seller names as UTF-8 with byte lengths", () => {
    const raw = atob(zatcaQr({ seller: "شركة", vatNumber: "300000000000003", timestamp: "2026-10-31T10:00:00Z", total: "115.00", vat: "15.00" }));
    expect(raw.charCodeAt(0)).toBe(1);
    expect(raw.charCodeAt(1)).toBe(8); // 4 Arabic letters × 2 bytes
    expect(zatcaAmount(11500)).toBe("115.00");
  });
});

describe("country packs", () => {
  it("know Gulf VAT rates and check UAE TRN and Saudi VAT numbers", () => {
    expect(countryPack("AE").codes[0]).toMatchObject({ name: "VAT 5%", rate_bp: 500 });
    expect(countryPack("SA").codes[0]).toMatchObject({ name: "VAT 15%", rate_bp: 1500 });
    expect(countryPack("BH").codes[0].rate_bp).toBe(1000);
    expect(taxIdProblem("AE", "100123456700003")).toBeNull();
    expect(taxIdProblem("AE", "12345")).toMatch(/TRN/);
    expect(taxIdProblem("SA", "310122393500003")).toBeNull();
    expect(taxIdProblem("SA", "210122393500003")).toMatch(/VAT number/);
    expect(taxIdProblem("GB", "anything")).toBeNull(); // shown as a hint, not enforced
    expect(countryPack("ZZ").regLabel).toBe("Tax registration number");
  });
});
