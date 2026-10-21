import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCsv, parseXlsx, toObjects } from "../src/web/lib/sheet";

describe("spreadsheet reader", () => {
  it("reads the first worksheet of an .xlsx written by Excel-compatible software", async () => {
    const buf = readFileSync(join(import.meta.dirname, "fixtures", "products.xlsx"));
    const rows = toObjects(await parseXlsx(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
    expect(rows).toEqual([
      { "Item Name": "Basmati Rice 5kg", HSN: "1006", "GST %": "5", "Selling Price": "650", "Opening Stock": "10", Notes: 'Says "best" & <fresh>' },
      { "Item Name": "Tea, 250g", HSN: "0902", "GST %": "5%", "Selling Price": "140.5", "Opening Stock": "", Notes: "" },
      { "Item Name": "Sugar 1kg", HSN: "1701", "GST %": "5", "Selling Price": "48", "Opening Stock": "TRUE", Notes: "Tamil: சர்க்கரை" },
    ]);
  });

  it("parses CSV with quotes, embedded commas/newlines, BOM and semicolons", () => {
    expect(parseCsv('﻿Name,Address\r\n"Rao, Sons","Line 1\nLine 2"\r\n"Say ""hi""",x\n\n')).toEqual([["Name", "Address"], ["Rao, Sons", "Line 1\nLine 2"], ['Say "hi"', "x"]]);
    expect(parseCsv("Name;GST\nA;18\n")).toEqual([["Name", "GST"], ["A", "18"]]);
  });

  it("rejects files that are not .xlsx", async () => {
    await expect(parseXlsx(new TextEncoder().encode("hello").buffer as ArrayBuffer)).rejects.toThrow(/not an .xlsx/);
  });
});
