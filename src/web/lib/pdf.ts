/**
 * PDF files of printed documents (invoices, receipts, payslips) made in the browser, so they can be shared to
 * WhatsApp, email or Drive as a file. The print layout is drawn to a canvas (html-to-image, loaded only when needed)
 * and each page is embedded as a JPEG in a small hand-written PDF. Works the same for English, Hindi and Tamil,
 * because the text is drawn by the browser's own fonts.
 */

const MM_PX = 96 / 25.4; // CSS pixels per millimetre
const MM_PT = 72 / 25.4; // PDF points per millimetre

export interface PdfPage { jpeg: Uint8Array; widthPx: number; heightPx: number; widthMm: number; heightMm: number }

/** A PDF with one full-page JPEG per page. */
export function buildPdf(pages: PdfPage[], title = "Document"): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (b: Uint8Array | string) => { const u = typeof b === "string" ? enc.encode(b) : b; chunks.push(u); length += u.length; };
  const obj = (n: number, body: (string | Uint8Array)[]) => { offsets[n] = length; push(`${n} 0 obj\n`); body.forEach(push); push("\nendobj\n"); };
  const safeTitle = title.replace(/[^\x20-\x7e]/g, "").replace(/[()\\]/g, "").slice(0, 120);

  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  const pageIds = pages.map((_, i) => 4 + i * 3);
  obj(1, ["<< /Type /Catalog /Pages 2 0 R >>"]);
  obj(2, [`<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`]);
  obj(3, [`<< /Title (${safeTitle}) /Producer (LedgerFox) >>`]);
  pages.forEach((p, i) => {
    const id = pageIds[i];
    const w = (p.widthMm * MM_PT).toFixed(2), h = (p.heightMm * MM_PT).toFixed(2);
    const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    obj(id, [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`]);
    obj(id + 1, [`<< /Length ${content.length} >>\nstream\n${content}\nendstream`]);
    obj(id + 2, [`<< /Type /XObject /Subtype /Image /Width ${p.widthPx} /Height ${p.heightPx} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`, p.jpeg, "\nendstream"]);
  });
  const count = 4 + pages.length * 3;
  const xref = length;
  push(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let n = 1; n < count; n++) push(`${String(offsets[n]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** Where to cut a page: the lowest fully white row within the last fifth of the page, so lines of text are not split. */
export function findCut(isWhiteRow: (y: number) => boolean, from: number, ideal: number): number {
  const lowest = Math.max(from + 1, Math.floor(ideal - (ideal - from) * 0.2));
  for (let y = ideal; y >= lowest; y--) if (isWhiteRow(y)) return y;
  return ideal;
}

async function jpegOf(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
  if (!blob) throw new Error("Could not make the PDF image");
  return new Uint8Array(await blob.arrayBuffer());
}

/** Push any table row that would be split by a page edge down to the next page, with an empty spacer row. */
function keepRowsWhole(root: HTMLElement, pageH: number) {
  const top0 = () => root.getBoundingClientRect().top;
  for (const tr of Array.from(root.querySelectorAll("tbody tr"))) {
    const r = tr.getBoundingClientRect();
    const top = r.top - top0(), bottom = r.bottom - top0();
    const edge = Math.ceil(top / pageH) * pageH;
    if (r.height >= pageH || !(top < edge && bottom > edge)) continue;
    const spacer = document.createElement("tr");
    spacer.style.height = `${edge - top}px`;
    const td = document.createElement("td");
    td.colSpan = 99;
    td.style.cssText = "border:none;padding:0;background:#fff";
    spacer.appendChild(td);
    tr.parentNode!.insertBefore(spacer, tr);
  }
}

/**
 * Render an element as a PDF. `widthMm` is the paper width; `pageHeightMm` the paper height (null for a receipt roll:
 * one page as long as the content).
 */
export async function elementToPdf(el: HTMLElement, opts: { widthMm: number; pageHeightMm: number | null; title: string }): Promise<Blob> {
  const { toCanvas } = await import("html-to-image");
  const widthPx = Math.round(opts.widthMm * MM_PX);
  // Lay out a hidden copy at the real paper width, so a phone's narrow screen does not squeeze the document.
  const holder = document.createElement("div");
  holder.setAttribute("aria-hidden", "true");
  holder.style.cssText = `position:fixed;left:-30000px;top:0;width:${widthPx}px;pointer-events:none;`;
  const copy = el.cloneNode(true) as HTMLElement;
  Object.assign(copy.style, { width: `${widthPx}px`, maxWidth: "none", minHeight: "0", margin: "0", boxShadow: "none" });
  holder.appendChild(copy);
  document.body.appendChild(holder);
  let full: HTMLCanvasElement;
  try {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (opts.pageHeightMm) keepRowsWhole(copy, opts.pageHeightMm * MM_PX);
    full = await toCanvas(copy, { pixelRatio: 2, backgroundColor: "#ffffff", width: widthPx, cacheBust: false });
  } finally { holder.remove(); }
  const pxPerMm = full.width / opts.widthMm;
  const pageH = opts.pageHeightMm ? Math.round(opts.pageHeightMm * pxPerMm) : full.height;
  const ctx = full.getContext("2d", { willReadFrequently: true })!;
  const white = (y: number) => {
    const row = ctx.getImageData(0, y, full.width, 1).data;
    for (let i = 0; i < row.length; i += 16) if (row[i] < 245 || row[i + 1] < 245 || row[i + 2] < 245) return false;
    return true;
  };
  const pages: PdfPage[] = [];
  for (let top = 0; top < full.height;) {
    const remaining = full.height - top;
    // Nothing but white space left (e.g. the bottom margin): no extra blank page.
    if (top > 0 && Array.from({ length: Math.ceil(remaining / 4) }, (_, i) => top + i * 4).every((y) => y >= full.height || white(y))) break;
    const cut = remaining <= pageH ? full.height : findCut(white, top, top + pageH);
    const slice = document.createElement("canvas");
    slice.width = full.width;
    slice.height = opts.pageHeightMm ? pageH : cut - top;
    const s = slice.getContext("2d")!;
    s.fillStyle = "#ffffff";
    s.fillRect(0, 0, slice.width, slice.height);
    s.drawImage(full, 0, top, full.width, cut - top, 0, 0, full.width, cut - top);
    pages.push({ jpeg: await jpegOf(slice), widthPx: slice.width, heightPx: slice.height, widthMm: opts.widthMm, heightMm: opts.pageHeightMm ?? slice.height / pxPerMm });
    top = cut;
  }
  return new Blob([buildPdf(pages, opts.title) as BlobPart], { type: "application/pdf" });
}
