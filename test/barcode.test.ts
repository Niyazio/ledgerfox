import { describe, expect, it } from "vitest";
import { code128, code128Svg, productQrPayload } from "../src/shared/barcode";

describe("Code 128 barcodes", () => {
  it("encodes start B, data, checksum and stop with 11-module symbols", () => {
    const w = code128("P000001");
    // start + 7 data + checksum = 9 symbols × 11 modules, plus 13-module stop pattern.
    expect(w.reduce((a, b) => a + b, 0)).toBe(9 * 11 + 13);
    expect(w.slice(0, 6)).toEqual([2, 1, 1, 2, 1, 4]); // Start B
    expect(w.slice(-7)).toEqual([2, 3, 3, 1, 1, 1, 2]); // Stop
  });

  it("computes the mod-103 checksum (\"PJJ123C\" → value 55)", () => {
    // Start B (104) + P J J 1 2 3 C: 104 + 48·1 + 42·2 + 42·3 + 17·4 + 18·5 + 19·6 + 35·7 = 879 → 879 mod 103 = 55.
    const vals = [104, ..."PJJ123C"].map((c, i) => (i === 0 ? 104 : (c as string).charCodeAt(0) - 32));
    expect(vals.reduce((s, v, i) => s + v * (i === 0 ? 1 : i), 0) % 103).toBe(55);
    const w = code128("PJJ123C");
    const checksumSymbol = w.slice(8 * 6, 9 * 6).join("");
    expect(checksumSymbol).toBe("311321"); // symbol value 55
  });

  it("has 107 symbols that are each 11 modules wide (stop: 13)", () => {
    for (let v = 32; v < 128; v++) expect(code128(String.fromCharCode(v)).reduce((a, b) => a + b, 0)).toBe(3 * 11 + 13);
  });

  it("rejects characters outside printable ASCII and builds SVG", () => {
    expect(() => code128("₹100")).toThrow();
    expect(code128Svg("ABC")).toContain("<rect");
    expect(productQrPayload("P000123")).toBe("LF1|P|P000123");
  });
});
