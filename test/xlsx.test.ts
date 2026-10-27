import { describe, expect, it } from "vitest";
import { buildXlsx, cellValue } from "../src/shared/xlsx";
import { parseXlsx } from "../src/web/lib/sheet";

describe("Excel (.xlsx) downloads", () => {
  it("writes a workbook that reads back with the same cells", async () => {
    const header = ["Name", "Phone", "GSTIN", "Amount", "Qty", "Note"];
    const rows = [
      ["Asha & Co <Bengaluru>", "9876543210", "29AAACL1234F1ZV", "1234.50", 3, "line1\nline2"],
      ["Ravi \"Kumar\"", "080-41234567", "", "-75.00", "0.5", "தமிழ் / हिन्दी"],
    ];
    const bytes = buildXlsx(header, rows, "Customers");
    expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b]); // ZIP
    const back = await parseXlsx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    expect(back[0]).toEqual(header);
    expect(back[1]).toEqual(["Asha & Co <Bengaluru>", "9876543210", "29AAACL1234F1ZV", "1234.5", "3", "line1\nline2"]);
    expect(back[2]).toEqual(["Ravi \"Kumar\"", "080-41234567", "", "-75", "0.5", "தமிழ் / हिन्दी"]);
  });

  it("keeps codes and phone numbers as text and amounts as numbers", () => {
    expect(cellValue("1234.50")).toEqual({ num: 1234.5 });
    expect(cellValue("12345678901.25")).toEqual({ num: 12345678901.25 });
    expect(cellValue(42)).toEqual({ num: 42 });
    expect(cellValue("9876543210")).toEqual({ text: "9876543210" });
    expect(cellValue("007")).toEqual({ text: "007" });
    expect(cellValue("2026-10-27")).toEqual({ text: "2026-10-27" });
    expect(cellValue(null)).toEqual({ text: "" });
  });
});
