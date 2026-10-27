import { describe, expect, it } from "vitest";
import QRCode from "qrcode";
import { code128, productQrPayload } from "../src/shared/barcode";
import { decodePixels } from "../src/web/lib/scanDecode";

/** Paint a module grid (true = black) into RGBA pixels, `scale` px per module, with a white quiet zone. */
function paint(rows: boolean[][], scale: number, quiet = 4) {
  const w = (rows[0].length + quiet * 2) * scale, h = (rows.length + quiet * 2) * scale;
  const px = new Uint8ClampedArray(w * h * 4).fill(255);
  rows.forEach((row, y) => row.forEach((black, x) => {
    if (!black) return;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const i = (((y + quiet) * scale + dy) * w + (x + quiet) * scale + dx) * 4;
      px[i] = px[i + 1] = px[i + 2] = 0;
    }
  }));
  return { px, w, h };
}

describe("camera scanning without BarcodeDetector", () => {
  it("reads the QR codes LedgerFox prints on product labels", async () => {
    const payload = productQrPayload("P000123");
    const qr = QRCode.create(payload, { errorCorrectionLevel: "M" });
    const n = qr.modules.size;
    const rows = Array.from({ length: n }, (_, y) => Array.from({ length: n }, (_, x) => Boolean(qr.modules.get(y, x))));
    const { px, w, h } = paint(rows, 6);
    expect(await decodePixels(px, w, h)).toBe(payload);
  });

  it("reads the Code 128 barcodes LedgerFox prints, and shop barcodes", async () => {
    for (const text of ["P000123", "8901234500017", "ABC-42"]) {
      const widths = code128(text);
      const bars: boolean[] = [];
      widths.forEach((wd, i) => { for (let k = 0; k < wd; k++) bars.push(i % 2 === 0); });
      const { px, w, h } = paint(Array.from({ length: 30 }, () => bars), 3, 10);
      expect(await decodePixels(px, w, h), text).toBe(text);
    }
  });

  it("returns null when there is no code", async () => {
    const px = new Uint8ClampedArray(200 * 200 * 4).fill(255);
    expect(await decodePixels(px, 200, 200)).toBeNull();
  });
});
