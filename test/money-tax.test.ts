import { describe, expect, it } from "vitest";
import { parseDecimal, toDecimalString, divRound, convertToBase, applyBp, lineAmount, allocateProportionally, roundToWhole, parseRate, applyBpFraction } from "../src/shared/money";
import { computeLine, computeDocument, resolveTaxMode, isValidGstin } from "../src/shared/tax";
import { formatMoney } from "../src/shared/currencies";
import { parseCsv, parseBankDate, csvCell } from "../src/shared/csv";
import { depreciationFor, schedule } from "../src/worker/services/depreciation";
import { issueCost } from "../src/worker/services/inventory";
import { can, canAssignRole } from "../src/shared/permissions";

const GST18 = { id: "g18", scheme: "in_gst" as const, rate_bp: 1800, category: "standard" };
const GST5 = { id: "g5", scheme: "in_gst" as const, rate_bp: 500, category: "standard" };

describe("decimal parsing (no floating point)", () => {
  it("parses decimal strings exactly into minor units", () => {
    expect(parseDecimal("1,234.56", 2)).toBe(123456);
    expect(parseDecimal("0.1", 2)).toBe(10);
    expect(parseDecimal("-0.05", 2)).toBe(-5);
    expect(parseDecimal("100", 0)).toBe(100);
    expect(parseDecimal("1.234", 3)).toBe(1234);
    expect(parseDecimal("2.500", 2)).toBe(250); // trailing zeros allowed
  });
  it("rejects excess precision instead of silently rounding", () => {
    expect(() => parseDecimal("1.005", 2)).toThrow();
    expect(() => parseDecimal("abc", 2)).toThrow();
    expect(() => parseDecimal("", 2)).toThrow();
  });
  it("0.1 + 0.2 is exactly 0.3 in minor units", () => {
    expect(parseDecimal("0.1", 2) + parseDecimal("0.2", 2)).toBe(parseDecimal("0.3", 2));
  });
  it("formats back to decimal strings", () => {
    expect(toDecimalString(123456, 2)).toBe("1234.56");
    expect(toDecimalString(-5, 2)).toBe("-0.05");
    expect(toDecimalString(7, 3)).toBe("0.007");
  });
});

describe("rounding: half away from zero", () => {
  it("divRound", () => {
    expect(divRound(5n, 2n)).toBe(3n);    // 2.5 → 3
    expect(divRound(-5n, 2n)).toBe(-3n);  // -2.5 → -3
    expect(divRound(7n, 3n)).toBe(2n);    // 2.33 → 2
    expect(divRound(8n, 3n)).toBe(3n);    // 2.67 → 3
  });
  it("line amount qty × price", () => {
    expect(lineAmount(2500, 1999)).toBe(4998);   // 2.5 × 19.99 = 49.975 → 49.98
    expect(lineAmount(1000, 12345)).toBe(12345);
    expect(lineAmount(333, 100)).toBe(33);       // 0.333 × 1.00 = 0.333 → 0.33
  });
  it("percentages", () => {
    expect(applyBp(10000, 1800)).toBe(1800);     // 18% of 100.00
    expect(applyBp(9999, 1800)).toBe(1800);      // 17.9982 → 18.00
    expect(applyBp(1, 5000)).toBe(1);            // 0.005 → 0.01
    expect(applyBpFraction(10000, 25, 2)).toBe(13); // 0.125% of 100.00 = 0.125 → 0.13
  });
  it("round to whole rupee", () => {
    expect(roundToWhole(11850, 2)).toBe(11900);  // 118.50 → 119
    expect(roundToWhole(11849, 2)).toBe(11800);
  });
  it("proportional allocation always sums to the total", () => {
    const parts = allocateProportionally(100, [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100);
    expect(parts).toEqual([34, 33, 33]);
  });
});

describe("foreign currency conversion", () => {
  it("USD → INR at 83.25", () => {
    // 1,234.56 USD × 83.25 = 102,777.12 INR
    expect(convertToBase(123456, parseRate("83.25"), 2, 2)).toBe(10277712);
  });
  it("handles different exponents (JPY 0dp → INR 2dp, KWD 3dp → INR)", () => {
    // 1,000 JPY × 0.5612 = 561.20 INR
    expect(convertToBase(1000, parseRate("0.5612"), 0, 2)).toBe(56120);
    // 1.234 KWD × 271.5 = 335.031 → 335.03 INR
    expect(convertToBase(1234, parseRate("271.5"), 3, 2)).toBe(33503);
  });
  it("rejects non-positive rates", () => {
    expect(() => parseRate("0")).toThrow();
  });
});

describe("GST", () => {
  it("intra-state splits into CGST + SGST at half rate each", () => {
    // 3 × ₹333.33 = 999.99; CGST 9% = 89.9991 → 90.00; SGST same
    const t = computeLine({ qty_milli: 3000, unit_price: 33333, tax: GST18 }, "intra");
    expect(t.taxable).toBe(99999);
    expect(t.cgst).toBe(9000);
    expect(t.sgst).toBe(9000);
    expect(t.igst).toBe(0);
    expect(t.line_total).toBe(117999);
  });
  it("inter-state uses IGST", () => {
    const t = computeLine({ qty_milli: 3000, unit_price: 33333, tax: GST18 }, "inter");
    expect(t.igst).toBe(18000); // 179.9982 → 180.00
    expect(t.cgst + t.sgst).toBe(0);
  });
  it("applies discount before tax", () => {
    // 10 × 100.00 = 1000.00, 10% discount = 100.00, taxable 900.00, 5% IGST = 45.00
    const t = computeLine({ qty_milli: 10000, unit_price: 10000, discount_bp: 1000, tax: GST5 }, "inter");
    expect(t).toMatchObject({ gross: 100000, discount: 10000, taxable: 90000, igst: 4500, line_total: 94500 });
  });
  it("exempt / nil codes produce no tax", () => {
    const t = computeLine({ qty_milli: 1000, unit_price: 10000, tax: { id: "x", scheme: "in_gst", rate_bp: 0, category: "exempt" } }, "intra");
    expect(t.tax).toBe(0);
  });
  it("document totals", () => {
    const d = computeDocument([
      { qty_milli: 2000, unit_price: 50000, tax: GST18 },   // 1000.00 + 90 + 90
      { qty_milli: 1000, unit_price: 25050, tax: GST5 },    // 250.50 + 6.2625→6.26 + 6.26
    ], "intra");
    expect(d.taxable_total).toBe(125050);
    expect(d.cgst).toBe(9000 + 626);
    expect(d.sgst).toBe(9000 + 626);
    expect(d.tax_total).toBe(19252);
    expect(d.total_before_round).toBe(144302);
  });
  it("place of supply decides intra vs inter", () => {
    expect(resolveTaxMode("in_gst", "29", "29")).toBe("intra");
    expect(resolveTaxMode("in_gst", "29", "27")).toBe("inter");
    expect(resolveTaxMode("simple", "29", "27")).toBe("simple");
  });
  it("validates GSTIN check digit", () => {
    expect(isValidGstin("27AAPFU0939F1ZV")).toBe(true);
    expect(isValidGstin("27AAPFU0939F1ZW")).toBe(false);
    expect(isValidGstin("NOTAGSTIN")).toBe(false);
  });
});

describe("formatting and CSV", () => {
  it("formats Indian grouping", () => {
    expect(formatMoney(12345678, "INR", "en-IN")).toBe("₹1,23,456.78");
    expect(formatMoney(-500, "USD", "en-US")).toBe("-$5.00");
  });
  it("parses quoted CSV", () => {
    expect(parseCsv('a,"b,c","d ""e"""\r\n1,2,3\n')).toEqual([["a", "b,c", 'd "e"'], ["1", "2", "3"]]);
  });
  it("neutralises spreadsheet formulas in exports", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("-12.50")).toBe("-12.50");
  });
  it("parses bank dates", () => {
    expect(parseBankDate("05/04/2026", "DD/MM/YYYY")).toBe("2026-04-05");
    expect(parseBankDate("05-Apr-2026", "DD-MMM-YYYY")).toBe("2026-04-05");
    expect(parseBankDate("31/02/2026", "DD/MM/YYYY")).toBeNull();
  });
});

describe("depreciation", () => {
  const slm = { cost: 120000, salvage_value: 0, method: "slm" as const, useful_life_months: 36, wdv_rate_bp: null, depreciation_start_date: "2026-04-15" };
  it("SLM: 1,200.00 over 36 months = 33.33/33.34 pattern summing exactly", () => {
    const s = schedule(slm);
    expect(s.length).toBe(36);
    expect(s[0].amount).toBe(3333);
    expect(s[1].amount).toBe(3334);
    expect(s.reduce((t, r) => t + r.amount, 0)).toBe(120000);
    expect(s[35].book_value).toBe(0);
  });
  it("WDV 15% p.a.: first month = 100,000.00 × 15% / 12 = 1,250.00", () => {
    const wdv = { ...slm, cost: 10000000, method: "wdv" as const, useful_life_months: null, wdv_rate_bp: 1500 };
    expect(depreciationFor(wdv, "2026-04", 0)).toBe(125000);
    // second month on WDV 98,750.00 → 1,234.375 → 1,234.38
    expect(depreciationFor(wdv, "2026-05", 125000)).toBe(123438);
  });
  it("never depreciates below salvage", () => {
    const a = { ...slm, salvage_value: 20000 };
    expect(schedule(a).reduce((t, r) => t + r.amount, 0)).toBe(100000);
  });
});

describe("inventory costing", () => {
  it("moving average issue cost", () => {
    // 20 units worth 2,200.00 → issue 5 = 550.00
    expect(issueCost({ qty_milli: 20000, value: 220000 }, 5000)).toBe(55000);
    // issue remaining quantity takes the full remaining value
    expect(issueCost({ qty_milli: 3000, value: 10000 }, 3000)).toBe(10000);
    // 3 units worth 100.00 → 1 unit = 33.33
    expect(issueCost({ qty_milli: 3000, value: 10000 }, 1000)).toBe(3333);
  });
});

describe("permissions", () => {
  it("role matrix", () => {
    expect(can("viewer", "txn.post")).toBe(false);
    expect(can("auditor", "audit.read")).toBe(true);
    expect(can("auditor", "txn.write")).toBe(false);
    expect(can("accountant", "data.export")).toBe(false);
    expect(can("admin", "data.export")).toBe(true);
    expect(canAssignRole("admin", "admin")).toBe(false);
    expect(canAssignRole("owner", "admin")).toBe(true);
    expect(canAssignRole("accountant", "viewer")).toBe(false);
  });
});

import { amountInWords } from "../src/shared/words";
describe("amount in words", () => {
  it("uses lakh/crore for rupees and million for other currencies", () => {
    expect(amountInWords(118000, "INR")).toBe("Rupees One Thousand One Hundred Eighty Only");
    expect(amountInWords(1234567850, "INR")).toBe("Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight and Fifty Paise Only");
    expect(amountInWords(123456700, "USD")).toBe("Dollars One Million Two Hundred Thirty Four Thousand Five Hundred Sixty Seven Only");
    expect(amountInWords(0, "INR")).toBe("Rupees Zero Only");
  });
});
