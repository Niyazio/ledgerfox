import { describe, expect, it } from "vitest";
import { buildPdf, findCut } from "../src/web/lib/pdf";

// The smallest valid JPEG-like payload is enough to check the PDF structure (viewers decode the image itself).
const fakeJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

describe("invoice PDF files", () => {
  it("writes a well-formed PDF: every object where the cross-reference table says it is", () => {
    const bytes = buildPdf([
      { jpeg: fakeJpeg, widthPx: 1588, heightPx: 2246, widthMm: 210, heightMm: 297 },
      { jpeg: fakeJpeg, widthPx: 1588, heightPx: 2246, widthMm: 210, heightMm: 297 },
    ], "Tax Invoice-INV/0001 (₹)");
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(text).toContain("/Count 2");
    expect(text).toContain("/MediaBox [0 0 595.28 841.89]"); // A4 in points
    expect(text).toContain("/Title (Tax Invoice-INV/0001 )"); // no brackets or non-ASCII in the title string
    const startxref = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(startxref, startxref + 4)).toBe("xref");
    const entries = text.slice(startxref).split("\n").slice(3).filter((l) => / 00000 n $/.test(l));
    expect(entries).toHaveLength(9); // catalog, pages, info + 3 objects per page
    entries.forEach((e, i) => expect(text.startsWith(`${i + 1} 0 obj\n`, Number(e.slice(0, 10)))).toBe(true));
    // Image stream length matches the bytes embedded.
    expect(text).toContain(`/Filter /DCTDecode /Length ${fakeJpeg.length}`);
  });

  it("cuts pages at a blank line rather than through text", () => {
    const blank = new Set([900, 950, 1300]);
    expect(findCut((y) => blank.has(y), 0, 1000)).toBe(950);   // nearest blank row above the page end
    expect(findCut(() => false, 0, 1000)).toBe(1000);           // no blank row: cut at the page end
    expect(findCut((y) => y === 700, 0, 1000)).toBe(1000);      // blank row too far up: keep the page full
  });
});
